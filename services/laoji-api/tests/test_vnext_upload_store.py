from __future__ import annotations

import hashlib
import sqlite3
import uuid

import pytest

from app.config import settings
from app.services import (
    device_identity,
    r2_storage_service,
    vnext_purge_store,
    vnext_task_store,
    vnext_upload_store,
)
from app.services.device_v2_identity import DeviceV2Context


class FakeR2:
    def __init__(self) -> None:
        self.objects: dict[str, bytes] = {}
        self.multipart: dict[str, tuple[str, dict[int, bytes]]] = {}
        self.last_key: str | None = None
        self.create_count = 0

    def presign_put_object(self, *, object_key: str, mime_type=None) -> str:
        self.last_key = object_key
        return f"https://r2.invalid/single/{object_key}"

    def find_multipart_uploads(self, *, object_key: str) -> list[str]:
        return sorted(upload_id for upload_id, (key, _) in self.multipart.items() if key == object_key)

    def create_multipart_upload(self, *, object_key: str, mime_type: str) -> str:
        self.create_count += 1
        upload_id = f"multipart-{self.create_count}"
        self.multipart[upload_id] = (object_key, {})
        self.last_key = object_key
        return upload_id

    def presign_upload_parts(self, *, object_key: str, upload_id: str, total_parts: int):
        self.last_key = object_key
        return [
            {"part_number": number, "url": f"https://r2.invalid/{upload_id}/{number}"}
            for number in range(1, total_parts + 1)
        ]

    def list_uploaded_parts(self, *, object_key: str, upload_id: str):
        _, parts = self.multipart.get(upload_id, (object_key, {}))
        return [r2_storage_service.R2Part(number, f'"etag-{number}"') for number in sorted(parts)]

    def complete_multipart_upload(self, *, object_key: str, upload_id: str, parts):
        key, uploaded = self.multipart.pop(upload_id)
        assert key == object_key
        self.objects[object_key] = b"".join(uploaded[item.part_number] for item in parts)

    def abort_multipart_upload(self, *, object_key: str, upload_id: str):
        self.multipart.pop(upload_id, None)

    def object_head(self, *, object_key: str):
        content = self.objects.get(object_key)
        return None if content is None else {"content_length": len(content), "etag": "fake"}

    def stream_object_sha256(self, *, object_key: str) -> str:
        return "sha256:" + hashlib.sha256(self.objects[object_key]).hexdigest()

    def delete_object(self, *, object_key: str):
        self.objects.pop(object_key, None)


BINDING_ID = "11111111-1111-4111-8111-111111111111"
BINDING_GENERATION = "1" * 32


@pytest.fixture
def upload_context(tmp_path, monkeypatch):
    database = tmp_path / "vnext-upload.db"
    monkeypatch.setattr(settings, "DATABASE_URL", f"sqlite+aiosqlite:///{database}")
    monkeypatch.setattr(settings, "SECRET_KEY", "vnext-upload-test-secret-at-least-32-bytes")
    monkeypatch.setattr(settings, "R2_ENABLED", True)
    monkeypatch.setattr(settings, "R2_UPLOAD_SESSION_TTL_HOURS", 24)
    monkeypatch.setattr(settings, "R2_PRESIGN_TTL_SECONDS", 60)
    monkeypatch.setattr(settings, "R2_PART_SIZE", 5 * 1024 * 1024)
    device_identity._SCHEMA_READY.clear()  # type: ignore[attr-defined]
    with sqlite3.connect(database) as connection:
        connection.execute(
            "CREATE TABLE meetings (id TEXT PRIMARY KEY, user_id INTEGER, updated_at TEXT, data_epoch_id TEXT)"
        )
    context = DeviceV2Context(str(uuid.uuid4()), str(uuid.uuid4()), 1, 1)
    vnext_task_store.ensure_vnext_task_schema()
    vnext_task_store.register_binding(
        context,
        binding_id=BINDING_ID,
        binding_generation=BINDING_GENERATION,
        binding_epoch_seq=1,
    )
    fake = FakeR2()
    monkeypatch.setattr(vnext_upload_store.r2_storage_service, "r2_enabled", lambda: True)
    for name in (
        "presign_put_object", "find_multipart_uploads", "create_multipart_upload",
        "presign_upload_parts", "list_uploaded_parts", "complete_multipart_upload",
        "abort_multipart_upload", "object_head", "stream_object_sha256", "delete_object",
    ):
        monkeypatch.setattr(vnext_upload_store.r2_storage_service, name, getattr(fake, name))
    return context, fake


def create_small(context, content: bytes, *, suffix: str = "1", now_epoch: int = 1000):
    digest = "sha256:" + hashlib.sha256(content).hexdigest()
    session, reused = vnext_upload_store.create_upload_session(
        context,
        session_id=f"upload-session-{suffix}",
        binding_id=BINDING_ID,
        binding_generation=BINDING_GENERATION,
        binding_revision=1,
        cancel_revision=0,
        client_operation_id=f"upload-operation-{suffix}",
        asset_id=f"asset-{suffix}",
        asset_generation=(suffix[-1] if suffix[-1] in "0123456789abcdef" else "a") * 32,
        expected_size=len(content),
        expected_sha256=digest,
        mime_type="audio/m4a",
        now_epoch=now_epoch,
    )
    return session, reused, digest


def test_single_upload_verification_and_task_commit_are_atomic(upload_context) -> None:
    context, fake = upload_context
    content = b"real-audio-content"
    session, reused, digest = create_small(context, content)
    assert reused is False
    assert session["mode"] == "single"
    assert session["put_url"].startswith("https://r2.invalid/")
    assert fake.last_key
    fake.objects[fake.last_key] = content

    completed = vnext_upload_store.complete_upload_session(
        context,
        session["session_id"],
        binding_generation=BINDING_GENERATION,
        binding_revision=1,
        cancel_revision=0,
        parts=[],
        transcription_task_id="transcription-task-1",
        transcription_generation_id="transcription-generation-1",
        transcription_input_sha256=digest,
    )
    assert completed["reused"] is False
    assert completed["verified_asset"]["source_sha256"] == digest
    assert completed["verified_asset"]["object_revision"] == 1
    assert completed["task"]["capability"] == "transcript"
    with device_identity.control_connection() as connection:
        session_row = connection.execute(
            "SELECT state, verified_asset_id, transcription_task_id FROM vnext_upload_sessions"
        ).fetchone()
        assert tuple(session_row) == ("verified", f"asset-revision:{session['session_id']}", "transcription-task-1")
        assert connection.execute("SELECT COUNT(*) FROM vnext_verified_assets").fetchone()[0] == 1
        assert connection.execute("SELECT COUNT(*) FROM vnext_tasks WHERE capability = 'transcript'").fetchone()[0] == 1

    replay = vnext_upload_store.complete_upload_session(
        context,
        session["session_id"],
        binding_generation=BINDING_GENERATION,
        binding_revision=1,
        cancel_revision=0,
        parts=[],
        transcription_task_id="transcription-task-1",
        transcription_generation_id="transcription-generation-1",
        transcription_input_sha256=digest,
    )
    assert replay["reused"] is True


def test_single_cancel_waits_out_last_presigned_put(upload_context) -> None:
    context, fake = upload_context
    session, _, _ = create_small(context, b"cancel-me", now_epoch=2000)
    assert fake.last_key
    result = vnext_upload_store.cancel_upload_session(
        context,
        session["session_id"],
        binding_generation=BINDING_GENERATION,
        binding_revision=1,
        cancel_revision=0,
        now_epoch=2001,
    )
    assert result["state"] == "cleanup_pending"
    fake.objects[fake.last_key] = b"late-put"
    assert vnext_upload_store.process_cleanup_obligations(now_epoch=2059) == 0
    assert fake.last_key in fake.objects
    assert vnext_upload_store.process_cleanup_obligations(now_epoch=2060) == 1
    assert fake.last_key not in fake.objects
    with device_identity.control_connection() as connection:
        assert connection.execute("SELECT state FROM vnext_upload_sessions").fetchone()[0] == "cancelled"
        assert connection.execute("SELECT state FROM vnext_capacity_reservations").fetchone()[0] == "released"


def test_upload_capacity_and_idempotent_replay(upload_context) -> None:
    context, _ = upload_context
    first, _, _ = create_small(context, b"a", suffix="1")
    replay, reused, _ = create_small(context, b"a", suffix="1")
    assert reused is True and replay["session_id"] == first["session_id"]
    create_small(context, b"b", suffix="2")
    with pytest.raises(vnext_upload_store.VNextUploadError) as caught:
        create_small(context, b"c", suffix="3")
    assert caught.value.code == "UPLOAD_CAPACITY_BUSY"


def test_hash_failure_never_creates_verified_asset_or_task(upload_context) -> None:
    context, fake = upload_context
    session, _, digest = create_small(context, b"expected", now_epoch=4000)
    assert fake.last_key
    fake.objects[fake.last_key] = b"tampered"
    with pytest.raises(vnext_upload_store.VNextUploadError) as caught:
        vnext_upload_store.complete_upload_session(
            context,
            session["session_id"],
            binding_generation=BINDING_GENERATION,
            binding_revision=1,
            cancel_revision=0,
            parts=[],
            transcription_task_id="transcription-task-bad",
            transcription_generation_id="transcription-generation-bad",
            transcription_input_sha256=digest,
        )
    assert caught.value.code in {"UPLOAD_SIZE_MISMATCH", "UPLOAD_HASH_MISMATCH"}
    with device_identity.control_connection() as connection:
        assert connection.execute("SELECT COUNT(*) FROM vnext_verified_assets").fetchone()[0] == 0
        assert connection.execute("SELECT COUNT(*) FROM vnext_tasks WHERE capability = 'transcript'").fetchone()[0] == 0
        assert connection.execute("SELECT state FROM vnext_upload_sessions").fetchone()[0] == "cleanup_pending"


def test_binding_cancel_revision_fences_late_completion(upload_context) -> None:
    context, fake = upload_context
    content = b"fenced-audio"
    session, _, digest = create_small(context, content)
    assert fake.last_key
    fake.objects[fake.last_key] = content
    with device_identity.control_connection() as connection:
        connection.execute(
            "UPDATE vnext_bindings SET cancel_revision = 1 WHERE binding_id = ?",
            (BINDING_ID,),
        )
        connection.commit()
    with pytest.raises(vnext_upload_store.VNextUploadError) as caught:
        vnext_upload_store.complete_upload_session(
            context,
            session["session_id"],
            binding_generation=BINDING_GENERATION,
            binding_revision=1,
            cancel_revision=0,
            parts=[],
            transcription_task_id="transcription-task-fenced",
            transcription_generation_id="transcription-generation-fenced",
            transcription_input_sha256=digest,
        )
    assert caught.value.code == "BINDING_REVISION_CHANGED"
    with device_identity.control_connection() as connection:
        assert connection.execute("SELECT COUNT(*) FROM vnext_verified_assets").fetchone()[0] == 0
        assert connection.execute("SELECT COUNT(*) FROM vnext_tasks WHERE capability = 'transcript'").fetchone()[0] == 0


def test_multipart_create_replay_does_not_open_second_remote_upload(upload_context) -> None:
    context, fake = upload_context
    size = vnext_upload_store.SINGLE_UPLOAD_THRESHOLD
    digest = "sha256:" + "a" * 64
    kwargs = dict(
        session_id="multipart-session-1",
        binding_id=BINDING_ID,
        binding_generation=BINDING_GENERATION,
        binding_revision=1,
        cancel_revision=0,
        client_operation_id="multipart-operation-1",
        asset_id="multipart-asset-1",
        asset_generation="a" * 32,
        expected_size=size,
        expected_sha256=digest,
        mime_type="audio/wav",
        now_epoch=3000,
    )
    first, reused = vnext_upload_store.create_upload_session(context, **kwargs)
    assert reused is False and first["mode"] == "multipart"
    second, reused = vnext_upload_store.create_upload_session(context, **kwargs)
    assert reused is True and second["session_id"] == first["session_id"]
    assert fake.create_count == 1

    upload_id = next(iter(fake.multipart))
    _, uploaded = fake.multipart[upload_id]
    uploaded[1] = b"first-part"
    recovered = vnext_upload_store.get_upload_session(context, first["session_id"])
    assert recovered is not None
    assert recovered["uploaded_parts"] == [
        {"part_number": 1, "etag": '"etag-1"'},
    ]


def test_binding_purge_confirms_only_after_verified_object_is_absent(upload_context) -> None:
    context, fake = upload_context
    content = b"private-recording"
    session, _, digest = create_small(context, content)
    assert fake.last_key
    object_key = fake.last_key
    fake.objects[object_key] = content
    vnext_upload_store.complete_upload_session(
        context,
        session["session_id"],
        binding_generation=BINDING_GENERATION,
        binding_revision=1,
        cancel_revision=0,
        parts=[],
        transcription_task_id="transcription-task-purge",
        transcription_generation_id="transcription-generation-purge",
        transcription_input_sha256=digest,
    )
    capability_id = "22222222-2222-4222-8222-222222222222"
    secret = "purge-secret-for-upload-test"
    with device_identity.control_connection() as connection:
        vnext_purge_store.register_capability(
            connection,
            scope_kind="binding",
            capability_id=capability_id,
            device_id=context.device_id,
            epoch_id=context.epoch_id,
            binding_id=BINDING_ID,
            binding_generation=BINDING_GENERATION,
            secret_sha256=hashlib.sha256(secret.encode("ascii")).hexdigest(),
            registration_request_id="upload-purge-registration",
        )
        connection.commit()

    result = vnext_purge_store.execute_purge(
        capability_id=capability_id,
        secret=secret,
        request_id="upload-purge-request",
    )
    assert result["state"] == "confirmed"
    assert object_key not in fake.objects
    with device_identity.control_connection() as connection:
        assert connection.execute("SELECT COUNT(*) FROM vnext_verified_assets").fetchone()[0] == 0
        assert connection.execute("SELECT COUNT(*) FROM vnext_upload_sessions").fetchone()[0] == 0
        assert connection.execute("SELECT COUNT(*) FROM vnext_tasks WHERE capability = 'transcript'").fetchone()[0] == 0
        assert connection.execute(
            "SELECT state FROM vnext_bindings WHERE binding_id = ?", (BINDING_ID,)
        ).fetchone()[0] == "purged"
        assert connection.execute(
            "SELECT state FROM vnext_object_cleanup_obligations"
        ).fetchone()[0] == "confirmed"
