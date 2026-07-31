#!/usr/bin/env python3
"""CPU-only SVC-09 meeting-state fault probes using the real candidate code."""

from __future__ import annotations

import asyncio
from datetime import datetime, timedelta, timezone
import hashlib
import importlib.metadata
import importlib.util
import json
import os
from pathlib import Path
import sys
import tempfile
from types import ModuleType, SimpleNamespace
import uuid

from sqlalchemy import DateTime, Integer, String, event, func, select
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column


SUMMARY_ROOT = Path("/home/yydd/\u684c\u9762/light_plan/server-work/summary")
SERVICE_PATH = SUMMARY_ROOT / "backend/app/services/meeting_recording_asset_service.py"
ASSET_MODEL_PATH = SUMMARY_ROOT / "backend/app/models/meeting_recording_asset.py"
NOTE_ROOT_MODEL_PATH = SUMMARY_ROOT / "backend/app/models/meeting_note_root.py"
DEFAULT_REPORT = Path(__file__).with_name("meeting-state-fault-injection-r8.json")
_LOADED_CANDIDATE = None


def _utc_naive() -> datetime:
    return datetime.now(timezone.utc).replace(tzinfo=None)


class Base(DeclarativeBase):
    pass


class Meeting(Base):
    __tablename__ = "meetings"

    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    user_id: Mapped[int] = mapped_column(Integer, nullable=False)
    app_owned: Mapped[int] = mapped_column(Integer, nullable=False, default=1)
    title: Mapped[str] = mapped_column(String(255), nullable=False, default="")
    status: Mapped[str] = mapped_column(String(32), nullable=False, default="processing")
    updated_at: Mapped[datetime] = mapped_column(
        DateTime,
        nullable=False,
        default=_utc_naive,
    )


def _now() -> str:
    return datetime.now(timezone.utc).astimezone().isoformat(timespec="milliseconds")


def _sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def _atomic_json(path: Path, value: object) -> None:
    temporary = path.with_name(f".{path.name}.{uuid.uuid4().hex}.tmp")
    with temporary.open("w", encoding="utf-8") as stream:
        json.dump(value, stream, ensure_ascii=False, indent=2)
        stream.write("\n")
        stream.flush()
        os.fsync(stream.fileno())
    os.replace(temporary, path)


def _load(path: Path, name: str):
    spec = importlib.util.spec_from_file_location(name, path)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"cannot load candidate module: {path}")
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


def _load_candidate_modules(database_url: str):
    app = ModuleType("app")
    app.__path__ = []
    app_models = ModuleType("app.models")
    app_models.__path__ = []
    app_models.Base = Base
    app_services = ModuleType("app.services")
    app_services.__path__ = []
    admission = ModuleType("app.services.transcription_admission")
    admission.transcription_admission_is_open = lambda: True
    app_config = ModuleType("app.config")
    app_config.settings = SimpleNamespace(
        DATABASE_URL=database_url,
        audio_storage_abs_path="/non-production-svc09-harness",
    )
    meeting_module = ModuleType("app.models.meeting")
    meeting_module.Meeting = Meeting
    app_database = ModuleType("app.database")
    sys.modules.update({
        "app": app,
        "app.models": app_models,
        "app.services": app_services,
        "app.services.transcription_admission": admission,
        "app.config": app_config,
        "app.models.meeting": meeting_module,
        "app.database": app_database,
    })
    note_module = _load(NOTE_ROOT_MODEL_PATH, "app.models.meeting_note_root")
    asset_module = _load(
        ASSET_MODEL_PATH,
        "app.models.meeting_recording_asset",
    )
    service = _load(
        SERVICE_PATH,
        f"svc09_meeting_state_candidate_{uuid.uuid4().hex}",
    )
    return service, note_module, asset_module, app_database


async def _database(path: Path):
    global _LOADED_CANDIDATE
    url = f"sqlite+aiosqlite:///{path}"
    if _LOADED_CANDIDATE is None:
        _LOADED_CANDIDATE = _load_candidate_modules(url)
    service, note_module, asset_module, app_database = _LOADED_CANDIDATE
    engine = create_async_engine(url, connect_args={"timeout": 5})

    @event.listens_for(engine.sync_engine, "connect")
    def sqlite_pragmas(connection, _record):
        cursor = connection.cursor()
        cursor.execute("PRAGMA foreign_keys=ON")
        cursor.execute("PRAGMA journal_mode=WAL")
        cursor.close()

    sessions = async_sessionmaker(engine, expire_on_commit=False)
    app_database.async_session = sessions
    async with engine.begin() as connection:
        await connection.run_sync(Base.metadata.create_all)
    return engine, sessions, service, note_module, asset_module


def _meeting(meeting_id: str) -> Meeting:
    return Meeting(
        id=meeting_id,
        user_id=7,
        app_owned=1,
        title=f"SVC-09 {meeting_id}",
        status="processing",
        updated_at=_utc_naive(),
    )


def _root(note_module, meeting_id: str, *, lifecycle: str = "active"):
    return note_module.MeetingNoteRootV2(
        meeting_id=meeting_id,
        user_id=7,
        client_note_id=f"client-{meeting_id}",
        revision=1,
        origin="ad_hoc",
        entry_point="fault_probe",
        lifecycle=lifecycle,
        deleted_at=_utc_naive() if lifecycle == "deleted" else None,
        created_at=_utc_naive(),
        updated_at=_utc_naive(),
    )


def _asset(asset_module, meeting_id: str, asset_id: str):
    return asset_module.MeetingRecordingAssetV2(
        id=asset_id,
        meeting_id=meeting_id,
        user_id=7,
        client_asset_id=f"client-{asset_id}",
        role="primary" if asset_id.endswith("1") else "secondary",
        origin="captured",
        revision=1,
        upload_state="uploaded",
        mime_type="audio/wav",
        file_name=f"{asset_id}.wav",
        storage_path=None,
        created_at=_utc_naive(),
        updated_at=_utc_naive(),
    )


def _job(
    asset_module,
    meeting_id: str,
    asset_id: str,
    job_id: str,
    *,
    status: str = "running",
    lease_token: str | None = None,
    created_at: datetime | None = None,
):
    return asset_module.MeetingRecordingTranscriptionJobV2(
        id=job_id,
        meeting_id=meeting_id,
        asset_id=asset_id,
        user_id=7,
        client_request_id=f"request-{job_id}",
        idempotency_key=f"create-{job_id}",
        language="zh",
        status=status,
        attempt=1 if status == "running" else 0,
        progress=0.1 if status == "running" else 0.0,
        retryable=0,
        provider_submission_generation=0,
        lease_token=lease_token,
        lease_expires_at=(
            _utc_naive() + timedelta(minutes=5)
            if lease_token is not None
            else None
        ),
        heartbeat_at=_utc_naive() if lease_token is not None else None,
        created_at=created_at or _utc_naive(),
        updated_at=_utc_naive(),
    )


def _claim(service, meeting_id: str, asset_id: str, job_id: str, lease_token: str):
    return service.TranscriptionJobClaim(
        job_id=job_id,
        meeting_id=meeting_id,
        asset_id=asset_id,
        user_id=7,
        attempt=1,
        language="zh",
        lease_token=lease_token,
        lease_expires_at=_utc_naive() + timedelta(minutes=5),
    )


async def _provider_ack_case(directory: Path) -> dict:
    engine, sessions, service, note_module, asset_module = await _database(
        directory / "provider-ack.sqlite3"
    )
    try:
        async with sessions() as db:
            db.add(_meeting("meeting-ack"))
            db.add(_root(note_module, "meeting-ack"))
            db.add(_asset(asset_module, "meeting-ack", "asset-ack-1"))
            db.add(_job(
                asset_module,
                "meeting-ack",
                "asset-ack-1",
                "job-ack",
                lease_token="lease-current",
            ))
            await db.commit()

            current = _claim(
                service,
                "meeting-ack",
                "asset-ack-1",
                "job-ack",
                "lease-current",
            )
            stale = _claim(
                service,
                "meeting-ack",
                "asset-ack-1",
                "job-ack",
                "lease-stale",
            )
            first = await service.bind_transcription_provider_task(
                db,
                claim=current,
                provider_task_id="task_0123456789abcdef0123456789abcdef",
            )
            duplicate = await service.bind_transcription_provider_task(
                db,
                claim=current,
                provider_task_id="task_0123456789abcdef0123456789abcdef",
            )
            mismatched = await service.bind_transcription_provider_task(
                db,
                claim=current,
                provider_task_id="task_ffffffffffffffffffffffffffffffff",
            )
            stale_ack = await service.bind_transcription_provider_task(
                db,
                claim=stale,
                provider_task_id="task_eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
            )
            job = await db.get(asset_module.MeetingRecordingTranscriptionJobV2, "job-ack")
            if not (
                first
                and duplicate
                and not mismatched
                and not stale_ack
                and job.provider_task_id
                == "task_0123456789abcdef0123456789abcdef"
            ):
                raise RuntimeError("provider ACK fencing probe failed")
            return {
                "first_ack_bound": first,
                "duplicate_ack_idempotent": duplicate,
                "mismatched_ack_rejected": not mismatched,
                "stale_lease_ack_rejected": not stale_ack,
                "persisted_provider_task_id": job.provider_task_id,
            }
    finally:
        await engine.dispose()


async def _multi_asset_partial_failure_case(directory: Path) -> dict:
    engine, sessions, service, note_module, asset_module = await _database(
        directory / "multi-asset.sqlite3"
    )
    try:
        async with sessions() as db:
            db.add(_meeting("meeting-multi"))
            db.add(_root(note_module, "meeting-multi"))
            for ordinal in (1, 2):
                asset_id = f"asset-multi-{ordinal}"
                db.add(_asset(asset_module, "meeting-multi", asset_id))
                db.add(_job(
                    asset_module,
                    "meeting-multi",
                    asset_id,
                    f"job-multi-{ordinal}",
                    lease_token=f"lease-multi-{ordinal}",
                ))
            await db.commit()
            first = await service.finish_transcription_claim(
                db,
                claim=_claim(
                    service,
                    "meeting-multi",
                    "asset-multi-1",
                    "job-multi-1",
                    "lease-multi-1",
                ),
                success=False,
                error_code="injected_asset_failure",
                retryable=True,
            )
            after_first = await db.get(Meeting, "meeting-multi")
            status_after_first = after_first.status
            second = await service.finish_transcription_claim(
                db,
                claim=_claim(
                    service,
                    "meeting-multi",
                    "asset-multi-2",
                    "job-multi-2",
                    "lease-multi-2",
                ),
                success=True,
                result_revision_id="recording-transcript:asset-two",
            )
            jobs = list((await db.execute(
                select(asset_module.MeetingRecordingTranscriptionJobV2).order_by(
                    asset_module.MeetingRecordingTranscriptionJobV2.id
                )
            )).scalars())
            meeting = await db.get(Meeting, "meeting-multi")
            states = {job.id: job.status for job in jobs}
            if not (
                first
                and second
                and status_after_first == "processing"
                and states == {
                    "job-multi-1": "failed",
                    "job-multi-2": "completed",
                }
                and meeting.status == "ended"
            ):
                raise RuntimeError("multi-asset partial failure convergence failed")
            return {
                "first_failure_committed": first,
                "meeting_after_first_failure": status_after_first,
                "second_success_committed": second,
                "job_states": states,
                "final_meeting_status": meeting.status,
            }
    finally:
        await engine.dispose()


async def _delete_restore_interleaving_case(directory: Path) -> dict:
    engine, sessions, service, note_module, asset_module = await _database(
        directory / "delete-restore.sqlite3"
    )
    try:
        async with sessions() as db:
            db.add(_meeting("meeting-delete"))
            db.add(_root(note_module, "meeting-delete", lifecycle="deleted"))
            db.add(_asset(asset_module, "meeting-delete", "asset-delete-1"))
            db.add(_job(
                asset_module,
                "meeting-delete",
                "asset-delete-1",
                "job-delete",
                lease_token="lease-delete",
            ))
            await db.commit()
            finished_while_deleted = await service.finish_transcription_claim(
                db,
                claim=_claim(
                    service,
                    "meeting-delete",
                    "asset-delete-1",
                    "job-delete",
                    "lease-delete",
                ),
                success=True,
                result_revision_id="recording-transcript:delete-race",
            )
            root = await db.get(note_module.MeetingNoteRootV2, "meeting-delete")
            root.lifecycle = "active"
            root.deleted_at = None
            root.revision += 1
            root.updated_at = _utc_naive()
            await db.commit()
            job = await db.get(
                asset_module.MeetingRecordingTranscriptionJobV2,
                "job-delete",
            )
            count = await db.scalar(select(func.count()).select_from(
                asset_module.MeetingRecordingTranscriptionJobV2
            ))
            if not (
                finished_while_deleted
                and root.lifecycle == "active"
                and job.status == "completed"
                and job.result_revision_id == "recording-transcript:delete-race"
                and count == 1
            ):
                raise RuntimeError("delete/restore interleaving lost or duplicated the job")
            return {
                "finish_while_in_recycle_bin": finished_while_deleted,
                "restored_lifecycle": root.lifecycle,
                "job_status_after_restore": job.status,
                "job_count_after_restore": count,
                "observed_policy": "recycle-bin deletion preserves in-flight work",
            }
    finally:
        await engine.dispose()


async def _recovery_fairness_case(directory: Path) -> dict:
    engine, sessions, service, note_module, asset_module = await _database(
        directory / "recovery-fairness.sqlite3"
    )
    submitted: list[str] = []
    service.submit_transcription_job = submitted.append
    base = _utc_naive() - timedelta(hours=1)
    try:
        async with sessions() as db:
            db.add(_meeting("meeting-fair"))
            db.add(_root(note_module, "meeting-fair"))
            rows = [
                ("asset-fair-1", "job-z", base),
                ("asset-fair-2", "job-a", base),
                ("asset-fair-3", "job-later", base + timedelta(seconds=1)),
            ]
            for asset_id, job_id, created_at in rows:
                db.add(_asset(asset_module, "meeting-fair", asset_id))
                db.add(_job(
                    asset_module,
                    "meeting-fair",
                    asset_id,
                    job_id,
                    status="queued",
                    created_at=created_at,
                ))
            await db.commit()
        recovered = await service.recover_interrupted_transcription_jobs()
        expected = ["job-a", "job-z", "job-later"]
        if recovered != 3 or submitted != expected:
            raise RuntimeError(
                f"recovery queue order mismatch: recovered={recovered}, {submitted}"
            )
        return {
            "recovered": recovered,
            "submission_order": submitted,
            "ordering_contract": "created_at_then_job_id",
        }
    finally:
        await engine.dispose()


async def _run(directory: Path) -> dict:
    return {
        "provider_ack_fencing": await _provider_ack_case(directory),
        "multi_asset_partial_failure": await _multi_asset_partial_failure_case(directory),
        "delete_restore_interleaving": await _delete_restore_interleaving_case(directory),
        "recovery_queue_fairness": await _recovery_fairness_case(directory),
    }


def main() -> int:
    report_path = DEFAULT_REPORT
    started_at = _now()
    temporary: Path | None = None
    os.environ["CUDA_VISIBLE_DEVICES"] = ""
    os.environ["NVIDIA_VISIBLE_DEVICES"] = "void"
    with tempfile.TemporaryDirectory(prefix="laoji-svc09-meeting-state-") as raw:
        directory = Path(raw)
        temporary = directory
        cases = asyncio.run(_run(directory))
        result = {
            "schema_version": 1,
            "generated_at": _now(),
            "started_at": started_at,
            "service": "SVC-09",
            "scope": "real_candidate_meeting_state_machine_sqlite_cpu_only_r8",
            "verdict": "passed_with_delete_restore_policy_observation",
            "candidate_artifacts": {
                "meeting_recording_asset_service.py": _sha256(SERVICE_PATH),
                "meeting_recording_asset.py": _sha256(ASSET_MODEL_PATH),
                "meeting_note_root.py": _sha256(NOTE_ROOT_MODEL_PATH),
            },
            "runtime": {
                "python": sys.version,
                "sqlalchemy": importlib.metadata.version("sqlalchemy"),
                "aiosqlite": importlib.metadata.version("aiosqlite"),
                "database": "temporary SQLite with foreign keys and WAL",
                "production_or_remote_contacted": False,
                "gpu_or_model_loaded": False,
            },
            "cases": cases,
            "proved": [
                "Duplicate provider ACK is idempotent while a different provider ID and a stale lease ACK are fenced out.",
                "One failed and one successful asset converge independently while the meeting stays processing until no active asset remains.",
                "A terminal transition interleaved with recycle-bin deletion survives restore without duplicating the transcription job.",
                "Recovery submits queued jobs in created_at then job_id order.",
            ],
            "not_proved": [
                "SQLite serializes writes; the existing PostgreSQL r6 focused suite remains the evidence for true concurrent row-lock behavior.",
                "No production database, complete FastAPI application, audio model, remote service or GPU was used.",
            ],
            "policy_observations": [
                "The candidate intentionally does not cancel an in-flight transcription merely because its meeting note root is in the recycle bin; restored meetings retain completed work. This trades compute for restore continuity and should remain an explicit product policy.",
            ],
        }
    result["cleanup"] = {
        "temporary_directory_removed": bool(temporary is not None and not temporary.exists()),
    }
    if not result["cleanup"]["temporary_directory_removed"]:
        raise RuntimeError("meeting-state temporary directory remains")
    _atomic_json(report_path, result)
    print(json.dumps({
        "verdict": result["verdict"],
        "report": str(report_path),
        "cleanup": result["cleanup"],
    }, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
