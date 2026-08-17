from __future__ import annotations

import asyncio
from datetime import datetime, timedelta
import json
import logging
from pathlib import Path
import uuid

from sqlalchemy import text

from app.config import settings
from app.database import async_session
from app.services.meeting_note_root_service import MEETING_NOTE_SOFT_DELETE_DAYS


_BATCH_SIZE = 20
_INTERVAL_SECONDS = 6 * 60 * 60
_DEVICE_SOURCE_FAILURE_TTL = timedelta(hours=24)
_task: asyncio.Task | None = None
_logger = logging.getLogger(__name__)


def _paths(value: str) -> list[str]:
    try:
        parsed = json.loads(value)
    except (TypeError, json.JSONDecodeError) as error:
        raise ValueError("invalid_paths") from error
    if (
        not isinstance(parsed, list)
        or len(parsed) > 10_000
        or any(
            not isinstance(item, str)
            or not item.strip()
            or len(item) > 4096
            or any(ord(character) < 32 or ord(character) == 127 for character in item)
            for item in parsed
        )
    ):
        raise ValueError("invalid_paths")
    return sorted(set(item.strip() for item in parsed))


def _delete_paths(paths: list[str]) -> None:
    root = Path(settings.audio_storage_abs_path).resolve()
    for value in paths:
        source = Path(value)
        candidate = source if source.is_absolute() else root / source
        resolved = candidate.resolve(strict=False)
        if resolved == root or root not in resolved.parents:
            raise ValueError("path_outside_audio_storage")
        if resolved.exists():
            if not resolved.is_file():
                raise ValueError("path_not_regular_file")
            resolved.unlink()
        parent = resolved.parent
        while parent != root and root in parent.parents:
            try:
                parent.rmdir()
            except OSError:
                break
            parent = parent.parent


async def cleanup_expired_device_sources() -> tuple[int, int]:
    """Remove device-owned sources after a terminal/orphan retention window.

    Successful and ``no_speech`` device jobs remove their source in the
    transcription worker.  A retryable failure intentionally keeps the source
    for recovery, but it must not become indefinite server-side storage.  An
    upload that never received a transcription job is also bounded. Only the
    newest job for an epoch-bound asset is considered, so a later retry or
    replacement upload can never be deleted by an older failure.
    """
    cutoff = datetime.utcnow() - _DEVICE_SOURCE_FAILURE_TTL
    async with async_session() as db:
        rows = (await db.execute(text(
            """
            SELECT asset.id AS asset_id,
                   asset.meeting_id AS meeting_id,
                   asset.storage_path AS storage_path,
                   job.id AS job_id
            FROM meeting_recording_assets_v2 asset
            INNER JOIN meetings meeting
              ON meeting.id = asset.meeting_id
            LEFT JOIN meeting_recording_transcription_jobs_v2 job
              ON job.asset_id = asset.id
             AND job.meeting_id = asset.meeting_id
             AND job.id = (
                SELECT newest.id
                FROM meeting_recording_transcription_jobs_v2 newest
                WHERE newest.asset_id = asset.id
                  AND newest.meeting_id = asset.meeting_id
                ORDER BY newest.created_at DESC, newest.id DESC
                LIMIT 1
              )
            WHERE asset.data_epoch_id IS NOT NULL
              AND meeting.data_epoch_id = asset.data_epoch_id
              AND asset.storage_path IS NOT NULL
              AND trim(asset.storage_path) <> ''
              AND (
                (job.id IS NULL AND asset.updated_at <= :cutoff)
                OR (
                  job.status IN ('failed', 'completed')
                  AND job.updated_at <= :cutoff
                )
              )
            ORDER BY job.updated_at, asset.id
            LIMIT :limit
            """
        ), {"cutoff": cutoff, "limit": _BATCH_SIZE})).mappings().all()

    cleaned = 0
    failed = 0
    for row in rows:
        asset_id = str(row["asset_id"])
        meeting_id = str(row["meeting_id"])
        storage_path = str(row["storage_path"] or "").strip()
        if not storage_path:
            continue
        try:
            async with async_session() as db:
                # The candidate query above is only a bounded hint. Recheck
                # it under a SQLite write lock immediately before deleting
                # the file. A new transcription retry cannot commit while
                # this lock is held, so an old terminal job can never delete
                # the source selected by that retry.
                await db.execute(text("BEGIN IMMEDIATE"))
                current = (await db.execute(text(
                    """
                    SELECT asset.storage_path AS storage_path,
                           job.id AS job_id
                    FROM meeting_recording_assets_v2 asset
                    INNER JOIN meetings meeting
                      ON meeting.id = asset.meeting_id
                    LEFT JOIN meeting_recording_transcription_jobs_v2 job
                      ON job.asset_id = asset.id
                     AND job.meeting_id = asset.meeting_id
                     AND job.id = (
                        SELECT newest.id
                        FROM meeting_recording_transcription_jobs_v2 newest
                        WHERE newest.asset_id = asset.id
                          AND newest.meeting_id = asset.meeting_id
                        ORDER BY newest.created_at DESC, newest.id DESC
                        LIMIT 1
                     )
                    WHERE asset.id = :asset_id
                      AND asset.meeting_id = :meeting_id
                      AND asset.data_epoch_id IS NOT NULL
                      AND meeting.data_epoch_id = asset.data_epoch_id
                      AND asset.storage_path = :storage_path
                      AND (
                        (job.id IS NULL AND asset.updated_at <= :cutoff)
                        OR (
                          job.status IN ('failed', 'completed')
                          AND job.updated_at <= :cutoff
                        )
                      )
                    """
                ), {
                    "asset_id": asset_id,
                    "meeting_id": meeting_id,
                    "storage_path": storage_path,
                    "cutoff": cutoff,
                })).mappings().first()
                if current is None:
                    await db.rollback()
                    continue
                current_job_id = current["job_id"]
                # Keep the database lock while unlinking. File unlink is a
                # metadata operation and this prevents a retry from racing
                # the final storage_path=NULL update.
                await asyncio.to_thread(_delete_paths, [storage_path])
                now = datetime.utcnow()
                asset_update = await db.execute(text(
                    """
                    UPDATE meeting_recording_assets_v2
                    SET storage_path = NULL,
                        upload_state = 'processed',
                        updated_at = :now
                    WHERE id = :asset_id
                      AND data_epoch_id IS NOT NULL
                      AND storage_path = :storage_path
                    """
                ), {
                    "asset_id": asset_id,
                    "storage_path": storage_path,
                    "now": now,
                })
                if asset_update.rowcount != 1:
                    raise RuntimeError("device source cleanup target changed")
                await db.execute(text(
                    """
                    UPDATE meetings
                    SET audio_path = NULL,
                        updated_at = :now
                    WHERE id = :meeting_id
                      AND data_epoch_id IS NOT NULL
                      AND audio_path = :storage_path
                    """
                ), {
                    "meeting_id": meeting_id,
                    "storage_path": storage_path,
                    "now": now,
                })
                if current_job_id is not None:
                    await db.execute(text(
                        """
                        UPDATE meeting_recording_transcription_jobs_v2
                        SET retryable = 0,
                            error_code = 'recording_source_expired',
                            updated_at = :now
                        WHERE id = :job_id
                          AND status = 'failed'
                        """
                    ), {"job_id": str(current_job_id), "now": now})
                await db.commit()
            cleaned += 1
        except asyncio.CancelledError:
            raise
        except Exception as error:
            failed += 1
            _logger.warning(
                "device source retention cleanup failed asset=%s: %s",
                asset_id,
                str(error)[:160] or type(error).__name__,
            )
    return cleaned, failed


async def queue_expired_meeting_retention_cleanup() -> int:
    cutoff = datetime.utcnow() - timedelta(days=MEETING_NOTE_SOFT_DELETE_DAYS)
    async with async_session() as db:
        try:
            await db.execute(text("BEGIN IMMEDIATE"))
            rows = (await db.execute(text(
                """
                SELECT root.meeting_id, root.user_id
                FROM meeting_note_roots_v2 root
                INNER JOIN meetings meeting ON meeting.id = root.meeting_id
                WHERE root.lifecycle = 'deleted'
                  AND root.deleted_at IS NOT NULL
                  AND root.deleted_at <= :cutoff
                  AND meeting.user_id = root.user_id
                ORDER BY root.deleted_at, root.meeting_id
                LIMIT :limit
                """
            ), {"cutoff": cutoff, "limit": _BATCH_SIZE})).mappings().all()
            queued = 0
            for row in rows:
                meeting_id = str(row["meeting_id"])
                user_id = int(row["user_id"])
                path_rows = (await db.execute(text(
                    """
                    SELECT audio_path AS path FROM meetings
                    WHERE id = :meeting_id AND audio_path IS NOT NULL AND trim(audio_path) <> ''
                    UNION
                    SELECT audio_path AS path FROM meeting_segments
                    WHERE meeting_id = :meeting_id AND audio_path IS NOT NULL AND trim(audio_path) <> ''
                    UNION
                    SELECT storage_path AS path FROM meeting_recording_assets_v2
                    WHERE meeting_id = :meeting_id AND storage_path IS NOT NULL AND trim(storage_path) <> ''
                    UNION
                    SELECT storage_path AS path FROM meeting_attachments_v1
                    WHERE meeting_id = :meeting_id AND storage_path IS NOT NULL AND trim(storage_path) <> ''
                    UNION
                    SELECT output_path AS path FROM meeting_media_clip_jobs_v1
                    WHERE meeting_id = :meeting_id AND output_path IS NOT NULL AND trim(output_path) <> ''
                    ORDER BY path
                    """
                ), {"meeting_id": meeting_id})).all()
                paths = [str(item[0]).strip() for item in path_rows]
                if len(paths) > 10_000:
                    raise RuntimeError("meeting retention cleanup has too many files")
                now = datetime.utcnow()
                await db.execute(text(
                    """
                    INSERT OR IGNORE INTO meeting_retention_cleanup_jobs_v2 (
                        id, user_id, meeting_id, paths_json, attempt_count,
                        last_error_code, created_at, updated_at
                    ) VALUES (
                        :id, :user_id, :meeting_id, :paths_json, 0,
                        NULL, :created_at, :updated_at
                    )
                    """
                ), {
                    "id": str(uuid.uuid4()),
                    "user_id": user_id,
                    "meeting_id": meeting_id,
                    "paths_json": json.dumps(paths, ensure_ascii=True),
                    "created_at": now,
                    "updated_at": now,
                })
                for table_name in (
                    "meeting_speaker_assignments_v2",
                    "transcript_lines",
                    "meeting_recording_transcript_drafts_v1",
                    "meeting_segments",
                    "period_summaries",
                    "final_summaries",
                ):
                    await db.execute(
                        text(f"DELETE FROM {table_name} WHERE meeting_id = :meeting_id"),
                        {"meeting_id": meeting_id},
                    )
                deleted = await db.execute(text(
                    """
                    DELETE FROM meetings
                    WHERE id = :meeting_id AND user_id = :user_id
                      AND EXISTS (
                        SELECT 1 FROM meeting_note_roots_v2 root
                        WHERE root.meeting_id = meetings.id
                          AND root.user_id = :user_id
                          AND root.lifecycle = 'deleted'
                          AND root.deleted_at IS NOT NULL
                          AND root.deleted_at <= :cutoff
                      )
                    """
                ), {"meeting_id": meeting_id, "user_id": user_id, "cutoff": cutoff})
                if deleted.rowcount != 1:
                    raise RuntimeError("meeting retention cleanup target changed")
                queued += 1
            await db.commit()
            return queued
        except Exception:
            await db.rollback()
            raise


async def _record_cleanup_failure(job_id: str, code: str) -> None:
    async with async_session() as db:
        await db.execute(text(
            """
            UPDATE meeting_retention_cleanup_jobs_v2
            SET attempt_count = attempt_count + 1,
                last_error_code = :code,
                updated_at = :updated_at
            WHERE id = :job_id
            """
        ), {"job_id": job_id, "code": code[:96], "updated_at": datetime.utcnow()})
        await db.commit()


async def drain_meeting_retention_cleanup() -> tuple[int, int]:
    async with async_session() as db:
        rows = (await db.execute(text(
            """
            SELECT id, paths_json
            FROM meeting_retention_cleanup_jobs_v2
            ORDER BY updated_at, id
            LIMIT :limit
            """
        ), {"limit": _BATCH_SIZE})).mappings().all()
    completed = 0
    failed = 0
    for row in rows:
        job_id = str(row["id"])
        try:
            await asyncio.to_thread(_delete_paths, _paths(str(row["paths_json"])))
            async with async_session() as db:
                deleted = await db.execute(
                    text("DELETE FROM meeting_retention_cleanup_jobs_v2 WHERE id = :job_id"),
                    {"job_id": job_id},
                )
                await db.commit()
            if deleted.rowcount == 1:
                completed += 1
        except asyncio.CancelledError:
            raise
        except Exception as error:
            failed += 1
            code = str(error).strip() if isinstance(error, ValueError) else "file_cleanup_failed"
            await _record_cleanup_failure(job_id, code or "file_cleanup_failed")
            _logger.warning("meeting retention file cleanup failed: %s", code or type(error).__name__)
    return completed, failed


async def run_meeting_retention_cleanup_once() -> tuple[int, int, int]:
    from app.services.device_identity import purge_expired_device_data
    from app.services.summary_task_store import purge_expired_results
    try:
        from app.services.r2_upload_service import cleanup_expired_r2_uploads

        await cleanup_expired_r2_uploads()
    except Exception as error:
        # R2 is optional and must never make local meeting retention fail.
        _logger.warning("r2 upload retention cleanup failed: %s", type(error).__name__)

    expired_device_rows = await asyncio.to_thread(purge_expired_device_data)
    expired_summary_rows = await asyncio.to_thread(purge_expired_results)
    try:
        from app.services.vnext_realtime_store import cleanup_realtime_payloads

        realtime_cleanup = await asyncio.to_thread(cleanup_realtime_payloads)
        if any(realtime_cleanup.values()):
            _logger.info(
                "vnext realtime retention: expired=%s checkpoints=%s orphans=%s bytes=%s",
                realtime_cleanup["expired_sessions"],
                realtime_cleanup["released_checkpoints"],
                realtime_cleanup["orphan_files"],
                realtime_cleanup["orphan_bytes"],
            )
    except Exception as error:
        _logger.warning("vnext realtime retention cleanup failed: %s", type(error).__name__)
    if expired_device_rows or expired_summary_rows:
        _logger.info(
            "device transient retention cleanup: quality_rows=%s summary_rows=%s",
            expired_device_rows,
            expired_summary_rows,
        )
    expired_sources_cleaned, expired_sources_failed = await cleanup_expired_device_sources()
    if expired_sources_cleaned or expired_sources_failed:
        _logger.info(
            "device source retention cleanup: cleaned=%s failed=%s",
            expired_sources_cleaned,
            expired_sources_failed,
        )
    queued = await queue_expired_meeting_retention_cleanup()
    completed, failed = await drain_meeting_retention_cleanup()
    if queued or completed or failed:
        _logger.info(
            "meeting retention cleanup: queued=%s completed=%s failed=%s",
            queued,
            completed,
            failed,
        )
    return queued, completed, failed + expired_sources_failed


async def _cleanup_loop() -> None:
    while True:
        try:
            await run_meeting_retention_cleanup_once()
        except asyncio.CancelledError:
            raise
        except Exception:
            _logger.exception("meeting retention cleanup run failed")
        await asyncio.sleep(_INTERVAL_SECONDS)


def start_meeting_retention_cleanup() -> None:
    global _task
    if _task is None or _task.done():
        _task = asyncio.create_task(_cleanup_loop(), name="meeting-retention-cleanup")


async def stop_meeting_retention_cleanup() -> None:
    global _task
    task = _task
    _task = None
    if task is None:
        return
    task.cancel()
    try:
        await task
    except asyncio.CancelledError:
        pass
