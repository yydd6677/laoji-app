"""Maintenance for device-owned Cloudflare R2 multipart upload sessions."""

from __future__ import annotations

import asyncio
from datetime import datetime
import logging

from sqlalchemy import select

from app.database import async_session
from app.models.meeting_recording_r2_upload import MeetingRecordingR2UploadV1
from app.services import r2_storage_service


_logger = logging.getLogger(__name__)


async def cleanup_expired_r2_uploads(limit: int = 32) -> int:
    """Abort stale multipart sessions and remove any completed object left behind.

    The API removes a successful object immediately. This bounded pass is the
    second safety net for a process/network failure and complements the R2
    bucket's 24-hour incomplete-upload lifecycle rule.
    """
    if not r2_storage_service.r2_enabled():
        return 0
    now = datetime.utcnow()
    async with async_session() as db:
        result = await db.execute(
            select(MeetingRecordingR2UploadV1)
            .where(
                MeetingRecordingR2UploadV1.status.in_(("active", "completing", "failed")),
                MeetingRecordingR2UploadV1.expires_at <= now,
            )
            .order_by(MeetingRecordingR2UploadV1.expires_at, MeetingRecordingR2UploadV1.id)
            .limit(max(1, min(128, int(limit))))
        )
        rows = list(result.scalars().all())
        cleaned = 0
        for upload in rows:
            try:
                if str(upload.multipart_upload_id).startswith("single:"):
                    await asyncio.to_thread(
                        r2_storage_service.delete_object,
                        object_key=upload.object_key,
                    )
                else:
                    await asyncio.to_thread(
                        r2_storage_service.abort_multipart_upload,
                        object_key=upload.object_key,
                        upload_id=upload.multipart_upload_id,
                    )
                # If multipart completion happened just before the worker
                # crashed, abort may report NoSuchUpload while a final object
                # still exists. DeleteObject is idempotent in either case.
                await asyncio.to_thread(
                    r2_storage_service.delete_object,
                    object_key=upload.object_key,
                )
                upload.status = "expired"
                upload.updated_at = now
                cleaned += 1
            except Exception as error:
                _logger.warning(
                    "r2 upload cleanup failed upload=%s error=%s",
                    str(upload.id)[:12],
                    type(error).__name__,
                )
        if cleaned:
            await db.commit()
        else:
            await db.rollback()
    return cleaned
