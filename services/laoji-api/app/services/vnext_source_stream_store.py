"""Bounded encrypted source streams and rolling Task checkpoints for Stage 3.

The store is an isolated candidate owner.  It never exposes source plaintext on
the device task status surface and it does not route existing Summary V3 or Q0
traffic.  A source stream and its generic Task are created in one transaction;
chapters are consumed in order and only two encrypted aggregate slots exist per
Task, independent of meeting length.
"""

from __future__ import annotations

import base64
import hashlib
import json
import os
import time
from typing import Any, Iterable, Literal, Protocol
import uuid

from cryptography.hazmat.primitives.ciphers.aead import AESGCM

from app.config import settings
from app.services import vnext_task_store
from app.services.device_identity import control_connection, utc_now


CONTRACT_REVISION = "source.stream.v2"
ZERO_SHA256 = "sha256:" + "0" * 64
SOURCE_TTL_SECONDS = 24 * 60 * 60
EMPTY_STREAM_TTL_SECONDS = 30 * 60
MAX_ACTIVE_STREAMS_DEVICE = 2
MAX_ACTIVE_STREAMS_GLOBAL = 8
MAX_MANIFEST_PAGES_DEVICE = 2
MAX_MANIFEST_PAGES_GLOBAL = 4
MAX_MANIFEST_PAGE_BYTES = 4 * 1024 * 1024
MAX_MANIFEST_BYTES_DEVICE = 8 * 1024 * 1024
MAX_MANIFEST_BYTES_GLOBAL = 16 * 1024 * 1024
MAX_GROUPS_DEVICE = 2
MAX_GROUPS_GLOBAL = 4
MAX_GROUP_BYTES = 128 * 1024 * 1024
MAX_BUNDLE_BYTES = 16 * 1024 * 1024
MAX_SOURCE_BYTES_DEVICE = 256 * 1024 * 1024
MAX_SOURCE_BYTES_GLOBAL = 512 * 1024 * 1024
CHECKPOINT_SLOT_BYTES = 4 * 1024 * 1024
CHECKPOINT_RESERVATION_BYTES = 2 * CHECKPOINT_SLOT_BYTES
MAX_CHECKPOINT_BYTES_DEVICE = 16 * 1024 * 1024
MAX_CHECKPOINT_BYTES_GLOBAL = 64 * 1024 * 1024


class SourceOwnerContext(Protocol):
    device_id: str
    epoch_id: str


class VNextSourceStreamError(RuntimeError):
    def __init__(self, code: str, message: str, status_code: int = 409):
        super().__init__(message)
        self.code = code
        self.message = message
        self.status_code = status_code


def _safe(value: str, field: str, maximum: int = 512) -> str:
    normalized = str(value or "").strip()
    if (
        not normalized
        or len(normalized) > maximum
        or any(ord(char) < 32 or ord(char) == 127 for char in normalized)
    ):
        raise VNextSourceStreamError("IDENTIFIER_INVALID", f"{field}无效", 422)
    return normalized


def _generation(value: str, field: str) -> str:
    normalized = _safe(value, field, 32).lower()
    if len(normalized) != 32:
        raise VNextSourceStreamError("GENERATION_INVALID", f"{field}无效", 422)
    try:
        int(normalized, 16)
    except ValueError as error:
        raise VNextSourceStreamError("GENERATION_INVALID", f"{field}无效", 422) from error
    return normalized


def _sha256(value: str, field: str = "sha256") -> str:
    normalized = _safe(value, field, 71).lower()
    if len(normalized) != 71 or not normalized.startswith("sha256:"):
        raise VNextSourceStreamError("HASH_INVALID", f"{field}无效", 422)
    try:
        int(normalized[7:], 16)
    except ValueError as error:
        raise VNextSourceStreamError("HASH_INVALID", f"{field}无效", 422) from error
    return normalized


def _positive(value: int, field: str, maximum: int = 9_007_199_254_740_991) -> int:
    if not isinstance(value, int) or isinstance(value, bool) or value < 1 or value > maximum:
        raise VNextSourceStreamError("VALUE_INVALID", f"{field}无效", 422)
    return value


def _nonnegative(value: int, field: str) -> int:
    if not isinstance(value, int) or isinstance(value, bool) or value < 0:
        raise VNextSourceStreamError("VALUE_INVALID", f"{field}无效", 422)
    return value


def _canonical(value: Any) -> bytes:
    return json.dumps(
        value,
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
    ).encode("utf-8")


def _digest(value: bytes) -> str:
    return "sha256:" + hashlib.sha256(value).hexdigest()


def manifest_page_sha256(descriptors: Iterable[dict[str, Any]]) -> str:
    return _digest(_canonical(list(descriptors)))


def bundle_sha256(items: Iterable[dict[str, Any]]) -> str:
    material = []
    for item in items:
        content = str(item.get("content") or "")
        material.append({
            "item_id": str(item.get("item_id") or ""),
            "source_type": str(item.get("source_type") or ""),
            "source_id": str(item.get("source_id") or ""),
            "source_revision_id": str(item.get("source_revision_id") or ""),
            "source_start_utf8": int(item.get("source_start_utf8") or 0),
            "source_end_utf8": int(item.get("source_end_utf8") or 0),
            "content_sha256": str(item.get("content_sha256") or ""),
            "content_bytes": len(content.encode("utf-8")),
            "start_ms": item.get("start_ms"),
            "end_ms": item.get("end_ms"),
            "speaker": item.get("speaker"),
        })
    return _digest(_canonical(material))


def chapter_sha256(bundle_hashes: Iterable[str]) -> str:
    return _digest(_canonical(list(bundle_hashes)))


def _advance_hash(previous: str, ordinal: int, value: str) -> str:
    return _digest(f"{previous}\0{ordinal}\0{value}".encode("ascii"))


def _source_key() -> bytes:
    raw = os.getenv("LAOJI_VNEXT_SOURCE_KEY", "").strip()
    if not raw:
        fallback = str(getattr(settings, "SECRET_KEY", "") or "").strip()
        if not fallback or (
            str(getattr(settings, "ENV", "")).strip().lower() == "production"
            and fallback == "change-me-in-production"
        ):
            raise VNextSourceStreamError(
                "SOURCE_KEY_MISSING",
                "来源加密密钥未配置",
                503,
            )
        return hashlib.sha256(f"laoji-vnext-source:{fallback}".encode("utf-8")).digest()
    try:
        if len(raw) == 64 and all(char in "0123456789abcdefABCDEF" for char in raw):
            key = bytes.fromhex(raw)
        else:
            key = base64.urlsafe_b64decode(raw + "=" * (-len(raw) % 4))
    except (TypeError, ValueError) as error:
        raise VNextSourceStreamError("SOURCE_KEY_INVALID", "来源加密密钥无效", 503) from error
    if len(key) != 32:
        raise VNextSourceStreamError("SOURCE_KEY_INVALID", "来源加密密钥无效", 503)
    return key


def _aad(kind: str, owner_id: str, content_sha256: str) -> bytes:
    return f"laoji-source-stream\0{kind}\0{owner_id}\0{content_sha256}".encode("utf-8")


def _encrypt(kind: str, owner_id: str, content_sha256: str, plaintext: bytes) -> tuple[bytes, bytes]:
    nonce = os.urandom(12)
    ciphertext = AESGCM(_source_key()).encrypt(
        nonce,
        plaintext,
        _aad(kind, owner_id, content_sha256),
    )
    return nonce, ciphertext


def _decrypt(kind: str, owner_id: str, content_sha256: str, nonce: bytes, ciphertext: bytes) -> bytes:
    try:
        return AESGCM(_source_key()).decrypt(
            nonce,
            ciphertext,
            _aad(kind, owner_id, content_sha256),
        )
    except Exception as error:
        raise VNextSourceStreamError("SOURCE_PAYLOAD_INVALID", "来源载荷校验失败", 500) from error


def ensure_vnext_source_stream_schema() -> None:
    vnext_task_store.ensure_vnext_task_schema()
    with control_connection() as connection:
        connection.executescript(
            """
            CREATE TABLE IF NOT EXISTS vnext_source_reservations (
                reservation_id TEXT PRIMARY KEY,
                device_id TEXT NOT NULL,
                epoch_id TEXT NOT NULL,
                resource_kind TEXT NOT NULL
                    CHECK(resource_kind IN ('source_manifest','source_payload','task_checkpoint')),
                owner_id TEXT NOT NULL,
                reserved_bytes INTEGER NOT NULL CHECK(reserved_bytes >= 1),
                state TEXT NOT NULL CHECK(state IN ('active','released')),
                created_at_epoch INTEGER NOT NULL,
                released_at_epoch INTEGER,
                UNIQUE(resource_kind, owner_id)
            );
            CREATE INDEX IF NOT EXISTS idx_vnext_source_reservation_active
                ON vnext_source_reservations(resource_kind, state, device_id, epoch_id);

            CREATE TABLE IF NOT EXISTS vnext_source_streams (
                stream_id TEXT PRIMARY KEY,
                task_id TEXT NOT NULL UNIQUE REFERENCES vnext_tasks(task_id) ON DELETE CASCADE,
                device_id TEXT NOT NULL,
                epoch_id TEXT NOT NULL,
                binding_id TEXT NOT NULL,
                binding_generation TEXT NOT NULL,
                binding_revision INTEGER NOT NULL CHECK(binding_revision >= 1),
                cancel_revision INTEGER NOT NULL CHECK(cancel_revision >= 0),
                client_operation_id TEXT NOT NULL,
                generation_id TEXT NOT NULL,
                request_sha256 TEXT NOT NULL,
                contract_revision TEXT NOT NULL,
                manifest_accumulator_sha256 TEXT NOT NULL,
                next_manifest_page INTEGER NOT NULL DEFAULT 0 CHECK(next_manifest_page >= 0),
                next_manifest_chapter INTEGER NOT NULL DEFAULT 0 CHECK(next_manifest_chapter >= 0),
                last_manifest_page_seq INTEGER,
                last_manifest_page_sha256 TEXT,
                next_consumable_chapter INTEGER NOT NULL DEFAULT 0 CHECK(next_consumable_chapter >= 0),
                final_chapter_count INTEGER,
                source_manifest_sha256 TEXT,
                state TEXT NOT NULL CHECK(state IN ('open','consuming','complete','cancelled','expired')),
                checkpoint_reservation_id TEXT NOT NULL,
                expires_at_epoch INTEGER NOT NULL,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                UNIQUE(device_id, epoch_id, client_operation_id),
                UNIQUE(device_id, epoch_id, generation_id)
            );
            CREATE INDEX IF NOT EXISTS idx_vnext_source_stream_active
                ON vnext_source_streams(state, device_id, epoch_id, updated_at);

            CREATE TABLE IF NOT EXISTS vnext_source_manifest_pages (
                stream_id TEXT NOT NULL REFERENCES vnext_source_streams(stream_id) ON DELETE CASCADE,
                page_seq INTEGER NOT NULL CHECK(page_seq >= 0),
                first_chapter_ordinal INTEGER NOT NULL CHECK(first_chapter_ordinal >= 0),
                last_chapter_ordinal INTEGER NOT NULL CHECK(last_chapter_ordinal >= first_chapter_ordinal),
                descriptor_count INTEGER NOT NULL CHECK(descriptor_count >= 1),
                consumed_count INTEGER NOT NULL DEFAULT 0 CHECK(consumed_count >= 0),
                page_bytes INTEGER NOT NULL CHECK(page_bytes >= 1),
                page_sha256 TEXT NOT NULL,
                final_page INTEGER NOT NULL CHECK(final_page IN (0,1)),
                descriptor_json TEXT NOT NULL,
                reservation_id TEXT NOT NULL UNIQUE,
                state TEXT NOT NULL CHECK(state IN ('received','compacted')),
                PRIMARY KEY(stream_id, page_seq)
            );

            CREATE TABLE IF NOT EXISTS vnext_source_bundle_groups (
                group_id TEXT PRIMARY KEY,
                stream_id TEXT NOT NULL REFERENCES vnext_source_streams(stream_id) ON DELETE CASCADE,
                chapter_ordinal INTEGER NOT NULL CHECK(chapter_ordinal >= 0),
                declared_bundle_count INTEGER NOT NULL CHECK(declared_bundle_count BETWEEN 1 AND 8),
                declared_item_count INTEGER NOT NULL CHECK(declared_item_count BETWEEN 1 AND 50000),
                declared_uncompressed_bytes INTEGER NOT NULL CHECK(declared_uncompressed_bytes BETWEEN 1 AND 134217728),
                chapter_sha256 TEXT NOT NULL,
                request_sha256 TEXT NOT NULL,
                reservation_id TEXT NOT NULL UNIQUE,
                state TEXT NOT NULL CHECK(state IN ('open','complete')),
                expires_at_epoch INTEGER NOT NULL,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                UNIQUE(stream_id, chapter_ordinal)
            );

            CREATE TABLE IF NOT EXISTS vnext_source_bundles (
                bundle_id TEXT PRIMARY KEY,
                group_id TEXT NOT NULL REFERENCES vnext_source_bundle_groups(group_id) ON DELETE CASCADE,
                ordinal INTEGER NOT NULL CHECK(ordinal >= 0),
                bundle_sha256 TEXT NOT NULL,
                item_count INTEGER NOT NULL CHECK(item_count >= 1),
                uncompressed_bytes INTEGER NOT NULL CHECK(uncompressed_bytes >= 1),
                created_at TEXT NOT NULL,
                UNIQUE(group_id, ordinal)
            );

            CREATE TABLE IF NOT EXISTS vnext_source_bundle_items (
                item_id TEXT PRIMARY KEY,
                bundle_id TEXT NOT NULL REFERENCES vnext_source_bundles(bundle_id) ON DELETE CASCADE,
                ordinal INTEGER NOT NULL CHECK(ordinal >= 0),
                source_type TEXT NOT NULL CHECK(source_type IN ('transcript','manual_note','attachment')),
                source_id TEXT NOT NULL,
                source_revision_id TEXT NOT NULL,
                source_start_utf8 INTEGER NOT NULL CHECK(source_start_utf8 >= 0),
                source_end_utf8 INTEGER NOT NULL CHECK(source_end_utf8 >= source_start_utf8),
                content_sha256 TEXT NOT NULL,
                content_bytes INTEGER NOT NULL CHECK(content_bytes >= 1),
                start_ms INTEGER,
                end_ms INTEGER,
                speaker TEXT,
                UNIQUE(bundle_id, ordinal)
            );

            CREATE TABLE IF NOT EXISTS vnext_encrypted_source_payloads (
                item_id TEXT PRIMARY KEY REFERENCES vnext_source_bundle_items(item_id) ON DELETE CASCADE,
                nonce BLOB NOT NULL,
                ciphertext BLOB NOT NULL,
                aad_sha256 TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS vnext_task_checkpoints (
                task_id TEXT NOT NULL REFERENCES vnext_tasks(task_id) ON DELETE CASCADE,
                slot_no INTEGER NOT NULL CHECK(slot_no IN (0,1)),
                through_chapter_ordinal INTEGER NOT NULL CHECK(through_chapter_ordinal >= 0),
                source_prefix_sha256 TEXT NOT NULL,
                input_sha256 TEXT NOT NULL,
                handler_revision TEXT NOT NULL,
                provider_revision TEXT NOT NULL,
                produced_by_attempt_id TEXT NOT NULL,
                nonce BLOB NOT NULL,
                encrypted_aggregate BLOB NOT NULL,
                aggregate_sha256 TEXT NOT NULL,
                aggregate_bytes INTEGER NOT NULL CHECK(aggregate_bytes BETWEEN 1 AND 4194304),
                sealed_at TEXT NOT NULL,
                PRIMARY KEY(task_id, slot_no)
            );

            CREATE TABLE IF NOT EXISTS vnext_generated_artifacts (
                artifact_id TEXT PRIMARY KEY,
                task_id TEXT NOT NULL UNIQUE REFERENCES vnext_tasks(task_id) ON DELETE CASCADE,
                source_manifest_sha256 TEXT NOT NULL,
                contract_revision TEXT NOT NULL,
                provider_revision TEXT NOT NULL,
                output_sha256 TEXT NOT NULL,
                nonce BLOB NOT NULL,
                encrypted_output BLOB NOT NULL,
                output_bytes INTEGER NOT NULL CHECK(output_bytes BETWEEN 1 AND 4194304),
                created_at TEXT NOT NULL
            );

            CREATE TRIGGER IF NOT EXISTS trg_vnext_manifest_reservation_release
            AFTER DELETE ON vnext_source_manifest_pages
            BEGIN
                UPDATE vnext_source_reservations
                   SET state = 'released', released_at_epoch = CAST(strftime('%s','now') AS INTEGER)
                 WHERE reservation_id = OLD.reservation_id AND state = 'active';
            END;
            CREATE TRIGGER IF NOT EXISTS trg_vnext_group_reservation_release
            AFTER DELETE ON vnext_source_bundle_groups
            BEGIN
                UPDATE vnext_source_reservations
                   SET state = 'released', released_at_epoch = CAST(strftime('%s','now') AS INTEGER)
                 WHERE reservation_id = OLD.reservation_id AND state = 'active';
            END;
            CREATE TRIGGER IF NOT EXISTS trg_vnext_stream_checkpoint_reservation_release
            AFTER DELETE ON vnext_source_streams
            BEGIN
                UPDATE vnext_source_reservations
                   SET state = 'released', released_at_epoch = CAST(strftime('%s','now') AS INTEGER)
                 WHERE reservation_id = OLD.checkpoint_reservation_id AND state = 'active';
            END;
            """
        )
        connection.commit()
        item_columns = {
            str(row[1])
            for row in connection.execute("PRAGMA table_info(vnext_source_bundle_items)").fetchall()
        }
        for column, declaration in {
            "start_ms": "INTEGER",
            "end_ms": "INTEGER",
            "speaker": "TEXT",
        }.items():
            if column not in item_columns:
                connection.execute(
                    f"ALTER TABLE vnext_source_bundle_items ADD COLUMN {column} {declaration}"
                )
        connection.commit()


def _assert_binding(
    connection: Any,
    context: SourceOwnerContext,
    *,
    binding_id: str,
    binding_generation: str,
    binding_revision: int,
    cancel_revision: int,
) -> Any:
    row = connection.execute(
        """SELECT * FROM vnext_bindings
           WHERE device_id = ? AND epoch_id = ? AND binding_id = ?""",
        (context.device_id, context.epoch_id, binding_id),
    ).fetchone()
    if row is None or str(row["binding_generation"]) != binding_generation:
        raise VNextSourceStreamError("BINDING_REQUIRED", "会议服务连接未登记", 428)
    if row["state"] != "active":
        raise VNextSourceStreamError("BINDING_PURGING", "会议服务连接正在清理", 409)
    if int(row["binding_revision"]) != binding_revision or int(row["cancel_revision"]) != cancel_revision:
        raise VNextSourceStreamError("BINDING_STALE", "会议服务连接版本已变化", 409)
    return row


def _stream_row(connection: Any, context: SourceOwnerContext, stream_id: str) -> Any:
    return connection.execute(
        """SELECT * FROM vnext_source_streams
           WHERE stream_id = ? AND device_id = ? AND epoch_id = ?""",
        (stream_id, context.device_id, context.epoch_id),
    ).fetchone()


def _task_checkpoint_ordinal(connection: Any, task_id: str) -> int | None:
    row = connection.execute(
        "SELECT checkpoint_through_chapter FROM vnext_tasks WHERE task_id = ?",
        (task_id,),
    ).fetchone()
    if row is None or row[0] is None:
        return None
    return int(row[0])


def _snapshot(connection: Any, row: Any) -> dict[str, Any]:
    task_capability = connection.execute(
        "SELECT capability FROM vnext_tasks WHERE task_id = ?",
        (str(row["task_id"]),),
    ).fetchone()
    return {
        "schema_version": 2,
        "contract_revision": CONTRACT_REVISION,
        "stream_id": row["stream_id"],
        "task_id": row["task_id"],
        "capability": str(task_capability[0]) if task_capability is not None else None,
        "binding_id": row["binding_id"],
        "binding_generation": row["binding_generation"],
        "binding_revision": int(row["binding_revision"]),
        "cancel_revision": int(row["cancel_revision"]),
        "client_operation_id": row["client_operation_id"],
        "generation_id": row["generation_id"],
        "state": row["state"],
        "next_manifest_page": int(row["next_manifest_page"]),
        "next_manifest_chapter": int(row["next_manifest_chapter"]),
        "next_consumable_chapter": int(row["next_consumable_chapter"]),
        "final_chapter_count": (
            int(row["final_chapter_count"])
            if row["final_chapter_count"] is not None
            else None
        ),
        "source_manifest_sha256": row["source_manifest_sha256"],
        "checkpoint_through_chapter": _task_checkpoint_ordinal(connection, str(row["task_id"])),
        "expires_at": int(row["expires_at_epoch"]),
    }


def _active_reserved(connection: Any, kind: str, context: SourceOwnerContext | None = None) -> int:
    if context is None:
        return int(connection.execute(
            "SELECT COALESCE(SUM(reserved_bytes),0) FROM vnext_source_reservations WHERE resource_kind = ? AND state = 'active'",
            (kind,),
        ).fetchone()[0])
    return int(connection.execute(
        """SELECT COALESCE(SUM(reserved_bytes),0) FROM vnext_source_reservations
           WHERE resource_kind = ? AND state = 'active' AND device_id = ? AND epoch_id = ?""",
        (kind, context.device_id, context.epoch_id),
    ).fetchone()[0])


def _reserve(
    connection: Any,
    context: SourceOwnerContext,
    *,
    reservation_id: str,
    resource_kind: Literal["source_manifest", "source_payload", "task_checkpoint"],
    owner_id: str,
    reserved_bytes: int,
    now_epoch: int,
) -> None:
    connection.execute(
        """INSERT INTO vnext_source_reservations(
             reservation_id, device_id, epoch_id, resource_kind, owner_id,
             reserved_bytes, state, created_at_epoch
           ) VALUES (?, ?, ?, ?, ?, ?, 'active', ?)""",
        (
            reservation_id,
            context.device_id,
            context.epoch_id,
            resource_kind,
            owner_id,
            reserved_bytes,
            now_epoch,
        ),
    )


def _release(connection: Any, reservation_id: str, now_epoch: int) -> None:
    connection.execute(
        """UPDATE vnext_source_reservations
              SET state = 'released', released_at_epoch = ?
            WHERE reservation_id = ? AND state = 'active'""",
        (now_epoch, reservation_id),
    )


def create_source_stream(
    context: SourceOwnerContext,
    *,
    stream_id: str,
    task_id: str,
    binding_id: str,
    binding_generation: str,
    binding_revision: int,
    cancel_revision: int,
    client_operation_id: str,
    generation_id: str,
    request_sha256: str,
    capability: Literal["summary", "question"],
    entity_id: str,
    entity_revision: int,
    task_input_sha256: str,
    now_epoch: int | None = None,
) -> tuple[dict[str, Any], bool]:
    ensure_vnext_source_stream_schema()
    stream_id = _safe(stream_id, "stream_id", 180)
    task_id = _safe(task_id, "task_id")
    binding_id = _safe(binding_id, "binding_id", 180)
    binding_generation = _generation(binding_generation, "binding_generation")
    binding_revision = _positive(binding_revision, "binding_revision")
    cancel_revision = _nonnegative(cancel_revision, "cancel_revision")
    client_operation_id = _safe(client_operation_id, "client_operation_id", 180)
    generation_id = _safe(generation_id, "generation_id")
    request_sha256 = _sha256(request_sha256, "request_sha256")
    if capability not in {"summary", "question"}:
        raise VNextSourceStreamError("CAPABILITY_INVALID", "来源流能力无效", 422)
    entity_id = _safe(entity_id, "entity_id")
    entity_revision = _positive(entity_revision, "entity_revision")
    task_input_sha256 = _sha256(task_input_sha256, "task_input_sha256")
    now_epoch = int(time.time()) if now_epoch is None else _nonnegative(now_epoch, "now_epoch")
    now = utc_now()
    checkpoint_reservation_id = f"checkpoint:{task_id}"

    with control_connection() as connection:
        connection.execute("BEGIN IMMEDIATE")
        _assert_binding(
            connection,
            context,
            binding_id=binding_id,
            binding_generation=binding_generation,
            binding_revision=binding_revision,
            cancel_revision=cancel_revision,
        )
        existing = _stream_row(connection, context, stream_id)
        if existing is None:
            existing = connection.execute(
                """SELECT * FROM vnext_source_streams
                   WHERE device_id = ? AND epoch_id = ?
                     AND (client_operation_id = ? OR generation_id = ?)""",
                (context.device_id, context.epoch_id, client_operation_id, generation_id),
            ).fetchone()
        if existing is not None:
            same = (
                str(existing["stream_id"]) == stream_id
                and str(existing["task_id"]) == task_id
                and str(existing["request_sha256"]) == request_sha256
                and str(existing["binding_id"]) == binding_id
                and str(existing["binding_generation"]) == binding_generation
            )
            if not same:
                connection.rollback()
                raise VNextSourceStreamError("SOURCE_STREAM_CONFLICT", "来源流标识已用于其他请求", 409)
            snapshot = _snapshot(connection, existing)
            connection.commit()
            return snapshot, True

        active_device = int(connection.execute(
            """SELECT COUNT(*) FROM vnext_source_streams
               WHERE device_id = ? AND epoch_id = ? AND state IN ('open','consuming')""",
            (context.device_id, context.epoch_id),
        ).fetchone()[0])
        active_global = int(connection.execute(
            "SELECT COUNT(*) FROM vnext_source_streams WHERE state IN ('open','consuming')"
        ).fetchone()[0])
        if active_device >= MAX_ACTIVE_STREAMS_DEVICE or active_global >= MAX_ACTIVE_STREAMS_GLOBAL:
            connection.rollback()
            raise VNextSourceStreamError("SOURCE_STREAM_CAPACITY", "来源处理任务较多，请稍后重试", 429)
        if (
            _active_reserved(connection, "task_checkpoint", context) + CHECKPOINT_RESERVATION_BYTES
            > MAX_CHECKPOINT_BYTES_DEVICE
            or _active_reserved(connection, "task_checkpoint") + CHECKPOINT_RESERVATION_BYTES
            > MAX_CHECKPOINT_BYTES_GLOBAL
        ):
            connection.rollback()
            raise VNextSourceStreamError("CHECKPOINT_CAPACITY", "整理恢复空间不足，请稍后重试", 429)

        try:
            task_row, reused = vnext_task_store.create_task_in_transaction(
                connection,
                context,
                task_id=task_id,
                binding_id=binding_id,
                binding_generation=binding_generation,
                capability=capability,
                entity_id=entity_id,
                entity_revision=entity_revision,
                input_sha256=task_input_sha256,
                generation_id=generation_id,
            )
            if reused and task_row["state"] != "active":
                raise VNextSourceStreamError("TASK_NOT_ACTIVE", "任务已结束，不能重新绑定来源流", 409)
            if reused and task_row["source_stream_id"] not in (None, stream_id):
                raise VNextSourceStreamError("TASK_SOURCE_CONFLICT", "任务已绑定其他来源流", 409)
            _reserve(
                connection,
                context,
                reservation_id=checkpoint_reservation_id,
                resource_kind="task_checkpoint",
                owner_id=task_id,
                reserved_bytes=CHECKPOINT_RESERVATION_BYTES,
                now_epoch=now_epoch,
            )
            connection.execute(
                """INSERT INTO vnext_source_streams(
                     stream_id, task_id, device_id, epoch_id, binding_id,
                     binding_generation, binding_revision, cancel_revision,
                     client_operation_id, generation_id, request_sha256,
                     contract_revision, manifest_accumulator_sha256,
                     state, checkpoint_reservation_id, expires_at_epoch,
                     created_at, updated_at
                   ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, ?, ?, ?)""",
                (
                    stream_id,
                    task_id,
                    context.device_id,
                    context.epoch_id,
                    binding_id,
                    binding_generation,
                    binding_revision,
                    cancel_revision,
                    client_operation_id,
                    generation_id,
                    request_sha256,
                    CONTRACT_REVISION,
                    ZERO_SHA256,
                    checkpoint_reservation_id,
                    now_epoch + EMPTY_STREAM_TTL_SECONDS,
                    now,
                    now,
                ),
            )
            connection.execute(
                """UPDATE vnext_tasks
                      SET source_stream_id = ?, checkpoint_reservation_id = ?, updated_at = ?
                    WHERE task_id = ? AND state = 'active'""",
                (stream_id, checkpoint_reservation_id, now, task_id),
            )
        except Exception as error:
            connection.rollback()
            if isinstance(error, (VNextSourceStreamError, vnext_task_store.VNextTaskError)):
                if isinstance(error, vnext_task_store.VNextTaskError):
                    raise VNextSourceStreamError(error.code, error.message, error.status_code) from error
                raise
            raise
        row = _stream_row(connection, context, stream_id)
        assert row is not None
        snapshot = _snapshot(connection, row)
        connection.commit()
        return snapshot, False


def get_source_stream(context: SourceOwnerContext, stream_id: str) -> dict[str, Any] | None:
    ensure_vnext_source_stream_schema()
    stream_id = _safe(stream_id, "stream_id", 180)
    with control_connection() as connection:
        row = _stream_row(connection, context, stream_id)
        return _snapshot(connection, row) if row is not None else None


def append_manifest_page(
    context: SourceOwnerContext,
    stream_id: str,
    *,
    page_seq: int,
    first_chapter_ordinal: int,
    descriptors: list[dict[str, Any]],
    page_sha256: str,
    final_page: bool,
    now_epoch: int | None = None,
) -> dict[str, Any]:
    ensure_vnext_source_stream_schema()
    stream_id = _safe(stream_id, "stream_id", 180)
    page_seq = _nonnegative(page_seq, "page_seq")
    first_chapter_ordinal = _nonnegative(first_chapter_ordinal, "first_chapter_ordinal")
    if not descriptors or len(descriptors) > 10_000:
        raise VNextSourceStreamError("MANIFEST_PAGE_INVALID", "来源清单页为空或过大", 422)
    normalized: list[dict[str, Any]] = []
    for offset, item in enumerate(descriptors):
        ordinal = _nonnegative(int(item.get("chapter_ordinal", -1)), "chapter_ordinal")
        if ordinal != first_chapter_ordinal + offset:
            raise VNextSourceStreamError("MANIFEST_CHAPTER_GAP", "来源章节必须连续", 409)
        normalized.append({
            "chapter_ordinal": ordinal,
            "declared_bundle_count": _positive(int(item.get("declared_bundle_count", 0)), "declared_bundle_count", 8),
            "declared_item_count": _positive(int(item.get("declared_item_count", 0)), "declared_item_count", 50_000),
            "declared_uncompressed_bytes": _positive(int(item.get("declared_uncompressed_bytes", 0)), "declared_uncompressed_bytes", MAX_GROUP_BYTES),
            "chapter_sha256": _sha256(str(item.get("chapter_sha256") or ""), "chapter_sha256"),
        })
    encoded = _canonical(normalized)
    if len(encoded) > MAX_MANIFEST_PAGE_BYTES:
        raise VNextSourceStreamError("MANIFEST_PAGE_TOO_LARGE", "来源清单页不能超过 4 MiB", 413)
    supplied_hash = _sha256(page_sha256, "page_sha256")
    if manifest_page_sha256(normalized) != supplied_hash:
        raise VNextSourceStreamError("MANIFEST_PAGE_HASH_MISMATCH", "来源清单页校验失败", 409)
    now_epoch = int(time.time()) if now_epoch is None else _nonnegative(now_epoch, "now_epoch")
    now = utc_now()
    reservation_id = f"manifest:{stream_id}:{page_seq}"

    with control_connection() as connection:
        connection.execute("BEGIN IMMEDIATE")
        stream = _stream_row(connection, context, stream_id)
        if stream is None:
            connection.rollback()
            raise VNextSourceStreamError("SOURCE_STREAM_NOT_FOUND", "来源流不存在", 404)
        existing = connection.execute(
            "SELECT * FROM vnext_source_manifest_pages WHERE stream_id = ? AND page_seq = ?",
            (stream_id, page_seq),
        ).fetchone()
        if existing is not None:
            if str(existing["page_sha256"]) != supplied_hash:
                connection.rollback()
                raise VNextSourceStreamError("MANIFEST_PAGE_CONFLICT", "清单页标识已用于其他内容", 409)
            snapshot = _snapshot(connection, stream)
            connection.commit()
            return snapshot
        if page_seq < int(stream["next_manifest_page"]):
            if (
                stream["last_manifest_page_seq"] == page_seq
                and stream["last_manifest_page_sha256"] == supplied_hash
            ):
                snapshot = _snapshot(connection, stream)
                connection.commit()
                return snapshot
            connection.rollback()
            raise VNextSourceStreamError("MANIFEST_PAGE_COMPACTED", "清单页已确认并压缩", 409)
        if stream["state"] not in {"open", "consuming"} or stream["final_chapter_count"] is not None:
            connection.rollback()
            raise VNextSourceStreamError("SOURCE_STREAM_CLOSED", "来源清单已经结束", 409)
        _assert_binding(
            connection,
            context,
            binding_id=str(stream["binding_id"]),
            binding_generation=str(stream["binding_generation"]),
            binding_revision=int(stream["binding_revision"]),
            cancel_revision=int(stream["cancel_revision"]),
        )
        if page_seq != int(stream["next_manifest_page"]):
            connection.rollback()
            raise VNextSourceStreamError("MANIFEST_PAGE_GAP", "来源清单页必须连续", 409)
        if first_chapter_ordinal != int(stream["next_manifest_chapter"]):
            connection.rollback()
            raise VNextSourceStreamError("MANIFEST_CHAPTER_GAP", "来源章节必须连续", 409)
        device_pages = int(connection.execute(
            """SELECT COUNT(*) FROM vnext_source_manifest_pages page
               JOIN vnext_source_streams stream ON stream.stream_id = page.stream_id
               WHERE stream.device_id = ? AND stream.epoch_id = ? AND page.state = 'received'""",
            (context.device_id, context.epoch_id),
        ).fetchone()[0])
        global_pages = int(connection.execute(
            "SELECT COUNT(*) FROM vnext_source_manifest_pages WHERE state = 'received'"
        ).fetchone()[0])
        if device_pages >= MAX_MANIFEST_PAGES_DEVICE or global_pages >= MAX_MANIFEST_PAGES_GLOBAL:
            connection.rollback()
            raise VNextSourceStreamError("MANIFEST_CAPACITY", "来源清单处理繁忙，请稍后重试", 429)
        if (
            _active_reserved(connection, "source_manifest", context) + len(encoded) > MAX_MANIFEST_BYTES_DEVICE
            or _active_reserved(connection, "source_manifest") + len(encoded) > MAX_MANIFEST_BYTES_GLOBAL
        ):
            connection.rollback()
            raise VNextSourceStreamError("MANIFEST_BYTES_CAPACITY", "来源清单暂存空间不足", 429)
        _reserve(
            connection,
            context,
            reservation_id=reservation_id,
            resource_kind="source_manifest",
            owner_id=f"{stream_id}:{page_seq}",
            reserved_bytes=len(encoded),
            now_epoch=now_epoch,
        )
        last_ordinal = normalized[-1]["chapter_ordinal"]
        connection.execute(
            """INSERT INTO vnext_source_manifest_pages(
                 stream_id, page_seq, first_chapter_ordinal, last_chapter_ordinal,
                 descriptor_count, page_bytes, page_sha256, final_page,
                 descriptor_json, reservation_id, state
               ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'received')""",
            (
                stream_id,
                page_seq,
                first_chapter_ordinal,
                last_ordinal,
                len(normalized),
                len(encoded),
                supplied_hash,
                1 if final_page else 0,
                encoded.decode("utf-8"),
                reservation_id,
            ),
        )
        accumulator = _advance_hash(str(stream["manifest_accumulator_sha256"]), page_seq, supplied_hash)
        final_count = last_ordinal + 1 if final_page else None
        manifest_root = accumulator if final_page else None
        connection.execute(
            """UPDATE vnext_source_streams
                  SET manifest_accumulator_sha256 = ?, next_manifest_page = ?,
                      next_manifest_chapter = ?, last_manifest_page_seq = ?,
                      last_manifest_page_sha256 = ?, final_chapter_count = ?,
                      source_manifest_sha256 = ?, expires_at_epoch = ?, updated_at = ?
                WHERE stream_id = ?""",
            (
                accumulator,
                page_seq + 1,
                last_ordinal + 1,
                page_seq,
                supplied_hash,
                final_count,
                manifest_root,
                now_epoch + SOURCE_TTL_SECONDS,
                now,
                stream_id,
            ),
        )
        if manifest_root is not None:
            connection.execute(
                "UPDATE vnext_tasks SET source_manifest_sha256 = ?, updated_at = ? WHERE task_id = ? AND state = 'active'",
                (manifest_root, now, stream["task_id"]),
            )
        row = _stream_row(connection, context, stream_id)
        assert row is not None
        snapshot = _snapshot(connection, row)
        connection.commit()
        return snapshot


def _descriptor_for_chapter(connection: Any, stream_id: str, chapter_ordinal: int) -> tuple[Any, dict[str, Any]]:
    rows = connection.execute(
        """SELECT * FROM vnext_source_manifest_pages
           WHERE stream_id = ? AND first_chapter_ordinal <= ? AND last_chapter_ordinal >= ?
           ORDER BY page_seq LIMIT 1""",
        (stream_id, chapter_ordinal, chapter_ordinal),
    ).fetchall()
    if not rows:
        raise VNextSourceStreamError("CHAPTER_NOT_DECLARED", "来源章节尚未登记", 409)
    page = rows[0]
    try:
        descriptors = json.loads(str(page["descriptor_json"]))
        descriptor = descriptors[chapter_ordinal - int(page["first_chapter_ordinal"])]
    except (IndexError, TypeError, json.JSONDecodeError) as error:
        raise VNextSourceStreamError("MANIFEST_PAGE_INVALID", "来源清单页损坏", 500) from error
    if int(descriptor.get("chapter_ordinal", -1)) != chapter_ordinal:
        raise VNextSourceStreamError("MANIFEST_PAGE_INVALID", "来源章节索引损坏", 500)
    return page, descriptor


def create_bundle_group(
    context: SourceOwnerContext,
    stream_id: str,
    *,
    group_id: str,
    chapter_ordinal: int,
    declared_bundle_count: int,
    declared_item_count: int,
    declared_uncompressed_bytes: int,
    chapter_hash: str,
    request_sha256: str,
    now_epoch: int | None = None,
) -> tuple[dict[str, Any], bool]:
    ensure_vnext_source_stream_schema()
    stream_id = _safe(stream_id, "stream_id", 180)
    group_id = _safe(group_id, "group_id", 180)
    chapter_ordinal = _nonnegative(chapter_ordinal, "chapter_ordinal")
    declared_bundle_count = _positive(declared_bundle_count, "declared_bundle_count", 8)
    declared_item_count = _positive(declared_item_count, "declared_item_count", 50_000)
    declared_uncompressed_bytes = _positive(declared_uncompressed_bytes, "declared_uncompressed_bytes", MAX_GROUP_BYTES)
    chapter_hash = _sha256(chapter_hash, "chapter_sha256")
    request_sha256 = _sha256(request_sha256, "request_sha256")
    now_epoch = int(time.time()) if now_epoch is None else _nonnegative(now_epoch, "now_epoch")
    now = utc_now()
    reservation_id = f"source:{group_id}"

    with control_connection() as connection:
        connection.execute("BEGIN IMMEDIATE")
        stream = _stream_row(connection, context, stream_id)
        if stream is None:
            connection.rollback()
            raise VNextSourceStreamError("SOURCE_STREAM_NOT_FOUND", "来源流不存在", 404)
        if stream["state"] not in {"open", "consuming"}:
            connection.rollback()
            raise VNextSourceStreamError("SOURCE_STREAM_CLOSED", "来源流已经结束", 409)
        _assert_binding(
            connection,
            context,
            binding_id=str(stream["binding_id"]),
            binding_generation=str(stream["binding_generation"]),
            binding_revision=int(stream["binding_revision"]),
            cancel_revision=int(stream["cancel_revision"]),
        )
        existing = connection.execute(
            "SELECT * FROM vnext_source_bundle_groups WHERE group_id = ? OR (stream_id = ? AND chapter_ordinal = ?)",
            (group_id, stream_id, chapter_ordinal),
        ).fetchone()
        if existing is not None:
            if (
                str(existing["group_id"]) != group_id
                or str(existing["request_sha256"]) != request_sha256
                or str(existing["chapter_sha256"]) != chapter_hash
            ):
                connection.rollback()
                raise VNextSourceStreamError("SOURCE_GROUP_CONFLICT", "章节组标识已用于其他内容", 409)
            result = _group_snapshot(connection, existing)
            connection.commit()
            return result, True
        next_chapter = int(stream["next_consumable_chapter"])
        if chapter_ordinal < next_chapter or chapter_ordinal > next_chapter + 1:
            connection.rollback()
            raise VNextSourceStreamError("SOURCE_GROUP_ORDER", "一次最多预取下一章来源", 409)
        _, descriptor = _descriptor_for_chapter(connection, stream_id, chapter_ordinal)
        expected = (
            int(descriptor["declared_bundle_count"]),
            int(descriptor["declared_item_count"]),
            int(descriptor["declared_uncompressed_bytes"]),
            str(descriptor["chapter_sha256"]),
        )
        actual = (
            declared_bundle_count,
            declared_item_count,
            declared_uncompressed_bytes,
            chapter_hash,
        )
        if expected != actual:
            connection.rollback()
            raise VNextSourceStreamError("SOURCE_GROUP_MANIFEST_MISMATCH", "章节组与来源清单不一致", 409)
        groups_device = int(connection.execute(
            """SELECT COUNT(*) FROM vnext_source_bundle_groups group_row
               JOIN vnext_source_streams stream ON stream.stream_id = group_row.stream_id
               WHERE stream.device_id = ? AND stream.epoch_id = ? AND group_row.state IN ('open','complete')""",
            (context.device_id, context.epoch_id),
        ).fetchone()[0])
        groups_global = int(connection.execute(
            "SELECT COUNT(*) FROM vnext_source_bundle_groups WHERE state IN ('open','complete')"
        ).fetchone()[0])
        if groups_device >= MAX_GROUPS_DEVICE or groups_global >= MAX_GROUPS_GLOBAL:
            connection.rollback()
            raise VNextSourceStreamError("SOURCE_GROUP_CAPACITY", "来源章节处理繁忙，请稍后重试", 429)
        if (
            _active_reserved(connection, "source_payload", context) + declared_uncompressed_bytes
            > MAX_SOURCE_BYTES_DEVICE
            or _active_reserved(connection, "source_payload") + declared_uncompressed_bytes
            > MAX_SOURCE_BYTES_GLOBAL
        ):
            connection.rollback()
            raise VNextSourceStreamError("SOURCE_BYTES_CAPACITY", "来源暂存空间不足，请稍后重试", 429)
        _reserve(
            connection,
            context,
            reservation_id=reservation_id,
            resource_kind="source_payload",
            owner_id=group_id,
            reserved_bytes=declared_uncompressed_bytes,
            now_epoch=now_epoch,
        )
        connection.execute(
            """INSERT INTO vnext_source_bundle_groups(
                 group_id, stream_id, chapter_ordinal, declared_bundle_count,
                 declared_item_count, declared_uncompressed_bytes, chapter_sha256,
                 request_sha256, reservation_id, state, expires_at_epoch,
                 created_at, updated_at
               ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, ?, ?)""",
            (
                group_id,
                stream_id,
                chapter_ordinal,
                declared_bundle_count,
                declared_item_count,
                declared_uncompressed_bytes,
                chapter_hash,
                request_sha256,
                reservation_id,
                now_epoch + SOURCE_TTL_SECONDS,
                now,
                now,
            ),
        )
        row = connection.execute(
            "SELECT * FROM vnext_source_bundle_groups WHERE group_id = ?",
            (group_id,),
        ).fetchone()
        assert row is not None
        result = _group_snapshot(connection, row)
        connection.commit()
        return result, False


def _group_snapshot(connection: Any, row: Any) -> dict[str, Any]:
    totals = connection.execute(
        """SELECT COUNT(*) AS bundle_count, COALESCE(SUM(item_count),0) AS item_count,
                  COALESCE(SUM(uncompressed_bytes),0) AS uncompressed_bytes
             FROM vnext_source_bundles WHERE group_id = ?""",
        (row["group_id"],),
    ).fetchone()
    return {
        "schema_version": 2,
        "contract_revision": CONTRACT_REVISION,
        "group_id": row["group_id"],
        "stream_id": row["stream_id"],
        "chapter_ordinal": int(row["chapter_ordinal"]),
        "state": row["state"],
        "declared_bundle_count": int(row["declared_bundle_count"]),
        "declared_item_count": int(row["declared_item_count"]),
        "declared_uncompressed_bytes": int(row["declared_uncompressed_bytes"]),
        "received_bundle_count": int(totals["bundle_count"]),
        "received_item_count": int(totals["item_count"]),
        "received_uncompressed_bytes": int(totals["uncompressed_bytes"]),
        "chapter_sha256": row["chapter_sha256"],
        "expires_at": int(row["expires_at_epoch"]),
    }


def append_bundle(
    context: SourceOwnerContext,
    group_id: str,
    *,
    bundle_id: str,
    ordinal: int,
    items: list[dict[str, Any]],
    supplied_bundle_sha256: str,
) -> dict[str, Any]:
    ensure_vnext_source_stream_schema()
    group_id = _safe(group_id, "group_id", 180)
    bundle_id = _safe(bundle_id, "bundle_id", 180)
    ordinal = _nonnegative(ordinal, "ordinal")
    if not items or len(items) > 50_000:
        raise VNextSourceStreamError("SOURCE_BUNDLE_INVALID", "来源 bundle 为空或过大", 422)
    supplied_bundle_sha256 = _sha256(supplied_bundle_sha256, "bundle_sha256")
    normalized: list[dict[str, Any]] = []
    total_bytes = 0
    seen_item_ids: set[str] = set()
    for raw in items:
        item_id = _safe(str(raw.get("item_id") or ""), "item_id", 180)
        if item_id in seen_item_ids:
            raise VNextSourceStreamError("SOURCE_ITEM_DUPLICATE", "来源项目 ID 重复", 409)
        seen_item_ids.add(item_id)
        source_type = str(raw.get("source_type") or "")
        if source_type not in {"transcript", "manual_note", "attachment"}:
            raise VNextSourceStreamError("SOURCE_TYPE_INVALID", "来源类型无效", 422)
        content = str(raw.get("content") or "")
        encoded = content.encode("utf-8")
        if not encoded:
            raise VNextSourceStreamError("SOURCE_CONTENT_EMPTY", "来源正文为空", 422)
        content_hash = _sha256(str(raw.get("content_sha256") or ""), "content_sha256")
        if _digest(encoded) != content_hash:
            raise VNextSourceStreamError("SOURCE_CONTENT_HASH_MISMATCH", "来源正文校验失败", 409)
        start = _nonnegative(int(raw.get("source_start_utf8", 0)), "source_start_utf8")
        end = _nonnegative(int(raw.get("source_end_utf8", 0)), "source_end_utf8")
        if end < start:
            raise VNextSourceStreamError("SOURCE_RANGE_INVALID", "来源范围无效", 422)
        start_ms_raw = raw.get("start_ms")
        end_ms_raw = raw.get("end_ms")
        start_ms = _nonnegative(int(start_ms_raw), "start_ms") if start_ms_raw is not None else None
        end_ms = _nonnegative(int(end_ms_raw), "end_ms") if end_ms_raw is not None else None
        if start_ms is not None and end_ms is not None and end_ms < start_ms:
            raise VNextSourceStreamError("SOURCE_TIME_RANGE_INVALID", "来源时间范围无效", 422)
        speaker_raw = str(raw.get("speaker") or "").strip()
        speaker = _safe(speaker_raw, "speaker", 100) if speaker_raw else None
        total_bytes += len(encoded)
        normalized.append({
            "item_id": item_id,
            "source_type": source_type,
            "source_id": _safe(str(raw.get("source_id") or ""), "source_id", 180),
            "source_revision_id": _safe(str(raw.get("source_revision_id") or ""), "source_revision_id", 180),
            "source_start_utf8": start,
            "source_end_utf8": end,
            "content_sha256": content_hash,
            "content": content,
            "start_ms": start_ms,
            "end_ms": end_ms,
            "speaker": speaker,
        })
    if total_bytes > MAX_BUNDLE_BYTES:
        raise VNextSourceStreamError("SOURCE_BUNDLE_TOO_LARGE", "单个来源 bundle 不能超过 16 MiB", 413)
    computed_hash = bundle_sha256(normalized)
    if computed_hash != supplied_bundle_sha256:
        raise VNextSourceStreamError("SOURCE_BUNDLE_HASH_MISMATCH", "来源 bundle 校验失败", 409)
    now = utc_now()

    with control_connection() as connection:
        connection.execute("BEGIN IMMEDIATE")
        group = connection.execute(
            """SELECT group_row.*, stream.device_id, stream.epoch_id, stream.binding_id,
                      stream.binding_generation, stream.binding_revision, stream.cancel_revision,
                      stream.state AS stream_state
                 FROM vnext_source_bundle_groups group_row
                 JOIN vnext_source_streams stream ON stream.stream_id = group_row.stream_id
                WHERE group_row.group_id = ? AND stream.device_id = ? AND stream.epoch_id = ?""",
            (group_id, context.device_id, context.epoch_id),
        ).fetchone()
        if group is None:
            connection.rollback()
            raise VNextSourceStreamError("SOURCE_GROUP_NOT_FOUND", "来源章节组不存在", 404)
        if group["state"] != "open" or group["stream_state"] not in {"open", "consuming"}:
            connection.rollback()
            raise VNextSourceStreamError("SOURCE_GROUP_CLOSED", "来源章节组已经结束", 409)
        _assert_binding(
            connection,
            context,
            binding_id=str(group["binding_id"]),
            binding_generation=str(group["binding_generation"]),
            binding_revision=int(group["binding_revision"]),
            cancel_revision=int(group["cancel_revision"]),
        )
        existing = connection.execute(
            "SELECT * FROM vnext_source_bundles WHERE bundle_id = ? OR (group_id = ? AND ordinal = ?)",
            (bundle_id, group_id, ordinal),
        ).fetchone()
        if existing is not None:
            if (
                str(existing["bundle_id"]) != bundle_id
                or str(existing["bundle_sha256"]) != supplied_bundle_sha256
            ):
                connection.rollback()
                raise VNextSourceStreamError("SOURCE_BUNDLE_CONFLICT", "bundle 标识已用于其他内容", 409)
            result = _group_snapshot(connection, group)
            connection.commit()
            return result
        received = connection.execute(
            """SELECT COUNT(*) AS bundle_count, COALESCE(SUM(item_count),0) AS item_count,
                      COALESCE(SUM(uncompressed_bytes),0) AS uncompressed_bytes
                 FROM vnext_source_bundles WHERE group_id = ?""",
            (group_id,),
        ).fetchone()
        if ordinal != int(received["bundle_count"]):
            connection.rollback()
            raise VNextSourceStreamError("SOURCE_BUNDLE_ORDER", "来源 bundle 必须连续上传", 409)
        if ordinal >= int(group["declared_bundle_count"]):
            connection.rollback()
            raise VNextSourceStreamError("SOURCE_BUNDLE_COUNT", "来源 bundle 数量超过声明", 409)
        if (
            int(received["item_count"]) + len(normalized) > int(group["declared_item_count"])
            or int(received["uncompressed_bytes"]) + total_bytes > int(group["declared_uncompressed_bytes"])
        ):
            connection.rollback()
            raise VNextSourceStreamError("SOURCE_GROUP_DECLARATION_EXCEEDED", "章节内容超过声明", 409)
        try:
            connection.execute(
                """INSERT INTO vnext_source_bundles(
                     bundle_id, group_id, ordinal, bundle_sha256, item_count,
                     uncompressed_bytes, created_at
                   ) VALUES (?, ?, ?, ?, ?, ?, ?)""",
                (bundle_id, group_id, ordinal, supplied_bundle_sha256, len(normalized), total_bytes, now),
            )
            for item_ordinal, item in enumerate(normalized):
                encoded = item["content"].encode("utf-8")
                nonce, ciphertext = _encrypt("item", item["item_id"], item["content_sha256"], encoded)
                connection.execute(
                    """INSERT INTO vnext_source_bundle_items(
                         item_id, bundle_id, ordinal, source_type, source_id,
                         source_revision_id, source_start_utf8, source_end_utf8,
                         content_sha256, content_bytes, start_ms, end_ms, speaker
                       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                    (
                        item["item_id"],
                        bundle_id,
                        item_ordinal,
                        item["source_type"],
                        item["source_id"],
                        item["source_revision_id"],
                        item["source_start_utf8"],
                        item["source_end_utf8"],
                        item["content_sha256"],
                        len(encoded),
                        item["start_ms"],
                        item["end_ms"],
                        item["speaker"],
                    ),
                )
                connection.execute(
                    """INSERT INTO vnext_encrypted_source_payloads(
                         item_id, nonce, ciphertext, aad_sha256
                       ) VALUES (?, ?, ?, ?)""",
                    (
                        item["item_id"],
                        nonce,
                        ciphertext,
                        _digest(_aad("item", item["item_id"], item["content_sha256"])),
                    ),
                )
        except Exception:
            connection.rollback()
            raise
        result = _group_snapshot(connection, group)
        connection.commit()
        return result


def commit_bundle_group(context: SourceOwnerContext, group_id: str) -> dict[str, Any]:
    ensure_vnext_source_stream_schema()
    group_id = _safe(group_id, "group_id", 180)
    now = utc_now()
    now_epoch = int(time.time())
    with control_connection() as connection:
        connection.execute("BEGIN IMMEDIATE")
        group = connection.execute(
            """SELECT group_row.*, stream.device_id, stream.epoch_id, stream.task_id,
                      stream.final_chapter_count, stream.state AS stream_state,
                      stream.binding_id, stream.binding_generation,
                      stream.binding_revision, stream.cancel_revision
                 FROM vnext_source_bundle_groups group_row
                 JOIN vnext_source_streams stream ON stream.stream_id = group_row.stream_id
                WHERE group_row.group_id = ? AND stream.device_id = ? AND stream.epoch_id = ?""",
            (group_id, context.device_id, context.epoch_id),
        ).fetchone()
        if group is None:
            connection.rollback()
            raise VNextSourceStreamError("SOURCE_GROUP_NOT_FOUND", "来源章节组不存在", 404)
        _assert_binding(
            connection,
            context,
            binding_id=str(group["binding_id"]),
            binding_generation=str(group["binding_generation"]),
            binding_revision=int(group["binding_revision"]),
            cancel_revision=int(group["cancel_revision"]),
        )
        if group["state"] == "complete":
            result = _group_snapshot(connection, group)
            connection.commit()
            return result
        if group["stream_state"] not in {"open", "consuming"}:
            connection.rollback()
            raise VNextSourceStreamError("SOURCE_STREAM_CLOSED", "来源流已经结束", 409)
        bundles = connection.execute(
            "SELECT * FROM vnext_source_bundles WHERE group_id = ? ORDER BY ordinal",
            (group_id,),
        ).fetchall()
        if [int(row["ordinal"]) for row in bundles] != list(range(int(group["declared_bundle_count"]))):
            connection.rollback()
            raise VNextSourceStreamError("SOURCE_GROUP_INCOMPLETE", "来源 bundle 尚未上传完整", 409)
        if (
            sum(int(row["item_count"]) for row in bundles) != int(group["declared_item_count"])
            or sum(int(row["uncompressed_bytes"]) for row in bundles)
            != int(group["declared_uncompressed_bytes"])
        ):
            connection.rollback()
            raise VNextSourceStreamError("SOURCE_GROUP_SIZE_MISMATCH", "章节来源数量与声明不一致", 409)
        computed = chapter_sha256(str(row["bundle_sha256"]) for row in bundles)
        if computed != str(group["chapter_sha256"]):
            connection.rollback()
            raise VNextSourceStreamError("SOURCE_CHAPTER_HASH_MISMATCH", "章节来源校验失败", 409)
        task_capability = connection.execute(
            "SELECT capability FROM vnext_tasks WHERE task_id = ?",
            (str(group["task_id"]),),
        ).fetchone()
        is_question_stream = task_capability is not None and str(task_capability[0]) == "question"
        connection.execute(
            "UPDATE vnext_source_bundle_groups SET state = 'complete', updated_at = ?, expires_at_epoch = ? WHERE group_id = ?",
            (now, now_epoch + SOURCE_TTL_SECONDS, group_id),
        )
        final_count = int(group["final_chapter_count"]) if group["final_chapter_count"] is not None else None
        next_state = (
            "complete"
            if is_question_stream and final_count is not None and int(group["chapter_ordinal"]) + 1 == final_count
            else "consuming"
        )
        connection.execute(
            """UPDATE vnext_source_streams
                  SET state = ?, next_consumable_chapter = CASE WHEN ? THEN ? ELSE next_consumable_chapter END,
                      expires_at_epoch = ?, updated_at = ?
                WHERE stream_id = ?""",
            (
                next_state,
                1 if is_question_stream else 0,
                int(group["chapter_ordinal"]) + 1,
                now_epoch + SOURCE_TTL_SECONDS,
                now,
                group["stream_id"],
            ),
        )
        row = connection.execute(
            "SELECT * FROM vnext_source_bundle_groups WHERE group_id = ?",
            (group_id,),
        ).fetchone()
        assert row is not None
        result = _group_snapshot(connection, row)
        connection.commit()
        return result


def _assert_attempt(
    connection: Any,
    context: SourceOwnerContext,
    *,
    task_id: str,
    attempt_id: str,
    lease_owner: str,
) -> tuple[Any, Any]:
    task = connection.execute(
        """SELECT * FROM vnext_tasks
           WHERE task_id = ? AND device_id = ? AND epoch_id = ?""",
        (task_id, context.device_id, context.epoch_id),
    ).fetchone()
    attempt = connection.execute(
        "SELECT * FROM vnext_task_attempts WHERE attempt_id = ? AND task_id = ?",
        (attempt_id, task_id),
    ).fetchone()
    if (
        task is None
        or task["state"] != "active"
        or str(task["current_attempt_id"] or "") != attempt_id
        or attempt is None
        or attempt["state"] != "running"
        or str(attempt["lease_owner"] or "") != lease_owner
        or float(attempt["lease_expires_at_epoch"] or 0) <= time.time()
    ):
        raise VNextSourceStreamError("TASK_LEASE_LOST", "任务执行权已失效", 409)
    return task, attempt


def _load_checkpoint(connection: Any, task: Any) -> tuple[dict[str, Any] | None, Any | None]:
    if task["current_checkpoint_slot"] is None:
        return None, None
    row = connection.execute(
        "SELECT * FROM vnext_task_checkpoints WHERE task_id = ? AND slot_no = ?",
        (task["task_id"], int(task["current_checkpoint_slot"])),
    ).fetchone()
    if row is None or int(row["through_chapter_ordinal"]) != int(task["checkpoint_through_chapter"]):
        raise VNextSourceStreamError("CHECKPOINT_POINTER_INVALID", "整理恢复点损坏", 500)
    plaintext = _decrypt(
        "checkpoint",
        f"{task['task_id']}:{int(row['slot_no'])}",
        str(row["aggregate_sha256"]),
        bytes(row["nonce"]),
        bytes(row["encrypted_aggregate"]),
    )
    if _digest(plaintext) != str(row["aggregate_sha256"]):
        raise VNextSourceStreamError("CHECKPOINT_HASH_MISMATCH", "整理恢复点校验失败", 500)
    try:
        decoded = json.loads(plaintext)
    except json.JSONDecodeError as error:
        raise VNextSourceStreamError("CHECKPOINT_INVALID", "整理恢复点格式损坏", 500) from error
    if not isinstance(decoded, dict):
        raise VNextSourceStreamError("CHECKPOINT_INVALID", "整理恢复点格式损坏", 500)
    return decoded, row


def load_next_chapter(
    context: SourceOwnerContext,
    task_id: str,
    *,
    attempt_id: str,
    lease_owner: str,
) -> dict[str, Any] | None:
    """Return the current aggregate and one immutable chapter to an internal worker."""
    ensure_vnext_source_stream_schema()
    task_id = _safe(task_id, "task_id")
    attempt_id = _safe(attempt_id, "attempt_id")
    lease_owner = _safe(lease_owner, "lease_owner", 200)
    with control_connection() as connection:
        task, _ = _assert_attempt(
            connection,
            context,
            task_id=task_id,
            attempt_id=attempt_id,
            lease_owner=lease_owner,
        )
        stream = connection.execute(
            "SELECT * FROM vnext_source_streams WHERE task_id = ?",
            (task_id,),
        ).fetchone()
        if stream is None or stream["state"] not in {"open", "consuming"}:
            return None
        ordinal = int(stream["next_consumable_chapter"])
        group = connection.execute(
            """SELECT * FROM vnext_source_bundle_groups
               WHERE stream_id = ? AND chapter_ordinal = ? AND state = 'complete'""",
            (stream["stream_id"], ordinal),
        ).fetchone()
        if group is None:
            return None
        aggregate, checkpoint = _load_checkpoint(connection, task)
        expected_previous = ordinal - 1
        if ordinal > 0 and (
            checkpoint is None or int(checkpoint["through_chapter_ordinal"]) != expected_previous
        ):
            raise VNextSourceStreamError("CHECKPOINT_SEQUENCE_INVALID", "整理恢复点与章节顺序不一致", 500)
        if ordinal == 0 and checkpoint is not None:
            raise VNextSourceStreamError("CHECKPOINT_SEQUENCE_INVALID", "整理恢复点与章节顺序不一致", 500)
        rows = connection.execute(
            """SELECT item.*, payload.nonce, payload.ciphertext
                 FROM vnext_source_bundle_items item
                 JOIN vnext_source_bundles bundle ON bundle.bundle_id = item.bundle_id
                 JOIN vnext_encrypted_source_payloads payload ON payload.item_id = item.item_id
                WHERE bundle.group_id = ?
                ORDER BY bundle.ordinal, item.ordinal""",
            (group["group_id"],),
        ).fetchall()
        items = []
        for row in rows:
            plaintext = _decrypt(
                "item",
                str(row["item_id"]),
                str(row["content_sha256"]),
                bytes(row["nonce"]),
                bytes(row["ciphertext"]),
            )
            if _digest(plaintext) != str(row["content_sha256"]):
                raise VNextSourceStreamError("SOURCE_CONTENT_HASH_MISMATCH", "来源正文校验失败", 500)
            items.append({
                "item_id": row["item_id"],
                "source_type": row["source_type"],
                "source_id": row["source_id"],
                "source_revision_id": row["source_revision_id"],
                "source_start_utf8": int(row["source_start_utf8"]),
                "source_end_utf8": int(row["source_end_utf8"]),
                "content_sha256": row["content_sha256"],
                "content": plaintext.decode("utf-8"),
                "start_ms": int(row["start_ms"]) if row["start_ms"] is not None else None,
                "end_ms": int(row["end_ms"]) if row["end_ms"] is not None else None,
                "speaker": row["speaker"],
            })
        return {
            "task_id": task_id,
            "stream_id": stream["stream_id"],
            "chapter_ordinal": ordinal,
            "chapter_sha256": group["chapter_sha256"],
            "source_manifest_sha256": stream["source_manifest_sha256"],
            "current_aggregate": aggregate,
            "current_checkpoint": (
                {
                    "slot_no": int(checkpoint["slot_no"]),
                    "through_chapter_ordinal": int(checkpoint["through_chapter_ordinal"]),
                    "source_prefix_sha256": checkpoint["source_prefix_sha256"],
                    "aggregate_sha256": checkpoint["aggregate_sha256"],
                }
                if checkpoint is not None
                else None
            ),
            "items": items,
        }


def load_current_checkpoint(
    context: SourceOwnerContext,
    task_id: str,
    *,
    attempt_id: str,
    lease_owner: str,
) -> dict[str, Any] | None:
    """Load only the current aggregate for crash recovery after final chapter promotion."""
    ensure_vnext_source_stream_schema()
    task_id = _safe(task_id, "task_id")
    attempt_id = _safe(attempt_id, "attempt_id")
    lease_owner = _safe(lease_owner, "lease_owner", 200)
    with control_connection() as connection:
        task, _ = _assert_attempt(
            connection,
            context,
            task_id=task_id,
            attempt_id=attempt_id,
            lease_owner=lease_owner,
        )
        aggregate, checkpoint = _load_checkpoint(connection, task)
        if aggregate is None or checkpoint is None:
            return None
        return {
            "aggregate": aggregate,
            "slot_no": int(checkpoint["slot_no"]),
            "through_chapter_ordinal": int(checkpoint["through_chapter_ordinal"]),
            "source_prefix_sha256": checkpoint["source_prefix_sha256"],
            "aggregate_sha256": checkpoint["aggregate_sha256"],
        }


def promote_checkpoint(
    context: SourceOwnerContext,
    task_id: str,
    *,
    attempt_id: str,
    lease_owner: str,
    chapter_ordinal: int,
    aggregate: dict[str, Any],
    handler_revision: str,
    provider_revision: str,
    now_epoch: int | None = None,
) -> dict[str, Any]:
    """Seal a new aggregate before deleting the just-consumed source chapter."""
    ensure_vnext_source_stream_schema()
    task_id = _safe(task_id, "task_id")
    attempt_id = _safe(attempt_id, "attempt_id")
    lease_owner = _safe(lease_owner, "lease_owner", 200)
    chapter_ordinal = _nonnegative(chapter_ordinal, "chapter_ordinal")
    handler_revision = _safe(handler_revision, "handler_revision", 180)
    provider_revision = _safe(provider_revision, "provider_revision", 180)
    if not isinstance(aggregate, dict):
        raise VNextSourceStreamError("CHECKPOINT_INVALID", "整理恢复点必须是对象", 422)
    encoded = _canonical(aggregate)
    if not encoded or len(encoded) > CHECKPOINT_SLOT_BYTES:
        raise VNextSourceStreamError("CHECKPOINT_TOO_LARGE", "整理恢复点超过 4 MiB", 413)
    aggregate_hash = _digest(encoded)
    now_epoch = int(time.time()) if now_epoch is None else _nonnegative(now_epoch, "now_epoch")
    now = utc_now()

    with control_connection() as connection:
        connection.execute("BEGIN IMMEDIATE")
        task, _ = _assert_attempt(
            connection,
            context,
            task_id=task_id,
            attempt_id=attempt_id,
            lease_owner=lease_owner,
        )
        stream = connection.execute(
            "SELECT * FROM vnext_source_streams WHERE task_id = ?",
            (task_id,),
        ).fetchone()
        if stream is None or stream["state"] not in {"open", "consuming"}:
            connection.rollback()
            raise VNextSourceStreamError("SOURCE_STREAM_CLOSED", "来源流已经结束", 409)
        if int(stream["next_consumable_chapter"]) != chapter_ordinal:
            connection.rollback()
            raise VNextSourceStreamError("CHECKPOINT_SEQUENCE_INVALID", "整理章节顺序已变化", 409)
        group = connection.execute(
            """SELECT * FROM vnext_source_bundle_groups
               WHERE stream_id = ? AND chapter_ordinal = ? AND state = 'complete'""",
            (stream["stream_id"], chapter_ordinal),
        ).fetchone()
        if group is None:
            connection.rollback()
            raise VNextSourceStreamError("SOURCE_GROUP_INCOMPLETE", "来源章节尚未完整提交", 409)
        _, current_checkpoint = _load_checkpoint(connection, task)
        if current_checkpoint is None:
            if chapter_ordinal != 0:
                connection.rollback()
                raise VNextSourceStreamError("CHECKPOINT_SEQUENCE_INVALID", "缺少上一章恢复点", 500)
            target_slot = 0
            previous_prefix = ZERO_SHA256
            previous_aggregate_hash = ZERO_SHA256
        else:
            if int(current_checkpoint["through_chapter_ordinal"]) != chapter_ordinal - 1:
                connection.rollback()
                raise VNextSourceStreamError("CHECKPOINT_SEQUENCE_INVALID", "上一章恢复点不匹配", 500)
            target_slot = 1 - int(current_checkpoint["slot_no"])
            previous_prefix = str(current_checkpoint["source_prefix_sha256"])
            previous_aggregate_hash = str(current_checkpoint["aggregate_sha256"])
        source_prefix = _advance_hash(previous_prefix, chapter_ordinal, str(group["chapter_sha256"]))
        input_hash = _digest(
            f"{previous_aggregate_hash}\0{group['chapter_sha256']}\0{handler_revision}\0{provider_revision}".encode("utf-8")
        )
        checkpoint_owner = f"{task_id}:{target_slot}"
        nonce, ciphertext = _encrypt("checkpoint", checkpoint_owner, aggregate_hash, encoded)
        if _decrypt("checkpoint", checkpoint_owner, aggregate_hash, nonce, ciphertext) != encoded:
            connection.rollback()
            raise VNextSourceStreamError("CHECKPOINT_SEAL_FAILED", "整理恢复点写入失败", 500)
        connection.execute(
            """INSERT INTO vnext_task_checkpoints(
                 task_id, slot_no, through_chapter_ordinal, source_prefix_sha256,
                 input_sha256, handler_revision, provider_revision,
                 produced_by_attempt_id, nonce, encrypted_aggregate,
                 aggregate_sha256, aggregate_bytes, sealed_at
               ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
               ON CONFLICT(task_id, slot_no) DO UPDATE SET
                 through_chapter_ordinal = excluded.through_chapter_ordinal,
                 source_prefix_sha256 = excluded.source_prefix_sha256,
                 input_sha256 = excluded.input_sha256,
                 handler_revision = excluded.handler_revision,
                 provider_revision = excluded.provider_revision,
                 produced_by_attempt_id = excluded.produced_by_attempt_id,
                 nonce = excluded.nonce,
                 encrypted_aggregate = excluded.encrypted_aggregate,
                 aggregate_sha256 = excluded.aggregate_sha256,
                 aggregate_bytes = excluded.aggregate_bytes,
                 sealed_at = excluded.sealed_at""",
            (
                task_id,
                target_slot,
                chapter_ordinal,
                source_prefix,
                input_hash,
                handler_revision,
                provider_revision,
                attempt_id,
                nonce,
                ciphertext,
                aggregate_hash,
                len(encoded),
                now,
            ),
        )
        cursor = connection.execute(
            """UPDATE vnext_tasks
                  SET current_checkpoint_slot = ?, checkpoint_through_chapter = ?, updated_at = ?
                WHERE task_id = ? AND state = 'active' AND current_attempt_id = ?""",
            (target_slot, chapter_ordinal, now, task_id, attempt_id),
        )
        if cursor.rowcount != 1:
            connection.rollback()
            raise VNextSourceStreamError("TASK_LEASE_LOST", "任务执行权已失效", 409)

        page, _ = _descriptor_for_chapter(connection, str(stream["stream_id"]), chapter_ordinal)
        consumed_count = int(page["consumed_count"]) + 1
        if consumed_count >= int(page["descriptor_count"]):
            _release(connection, str(page["reservation_id"]), now_epoch)
            connection.execute(
                "DELETE FROM vnext_source_manifest_pages WHERE stream_id = ? AND page_seq = ?",
                (stream["stream_id"], page["page_seq"]),
            )
        else:
            connection.execute(
                """UPDATE vnext_source_manifest_pages
                      SET consumed_count = ? WHERE stream_id = ? AND page_seq = ?""",
                (consumed_count, stream["stream_id"], page["page_seq"]),
            )
        _release(connection, str(group["reservation_id"]), now_epoch)
        connection.execute(
            "DELETE FROM vnext_source_bundle_groups WHERE group_id = ?",
            (group["group_id"],),
        )
        next_chapter = chapter_ordinal + 1
        final_count = (
            int(stream["final_chapter_count"])
            if stream["final_chapter_count"] is not None
            else None
        )
        state = "complete" if final_count is not None and next_chapter == final_count else "consuming"
        connection.execute(
            """UPDATE vnext_source_streams
                  SET next_consumable_chapter = ?, state = ?, expires_at_epoch = ?, updated_at = ?
                WHERE stream_id = ?""",
            (next_chapter, state, now_epoch + SOURCE_TTL_SECONDS, now, stream["stream_id"]),
        )
        connection.commit()
        return {
            "task_id": task_id,
            "slot_no": target_slot,
            "through_chapter_ordinal": chapter_ordinal,
            "source_prefix_sha256": source_prefix,
            "aggregate_sha256": aggregate_hash,
            "input_sha256": input_hash,
            "stream_state": state,
        }


def commit_checkpoint_artifact(
    context: SourceOwnerContext,
    task_id: str,
    *,
    attempt_id: str,
    lease_owner: str,
    artifact: dict[str, Any],
    contract_revision: str,
    provider_revision: str,
) -> dict[str, Any]:
    """Publish the final encrypted artifact and Task terminal in one transaction."""
    ensure_vnext_source_stream_schema()
    task_id = _safe(task_id, "task_id")
    attempt_id = _safe(attempt_id, "attempt_id")
    lease_owner = _safe(lease_owner, "lease_owner", 200)
    contract_revision = _safe(contract_revision, "contract_revision", 180)
    provider_revision = _safe(provider_revision, "provider_revision", 180)
    if not isinstance(artifact, dict):
        raise VNextSourceStreamError("ARTIFACT_INVALID", "任务结果必须是对象", 422)
    encoded = _canonical(artifact)
    if not encoded or len(encoded) > CHECKPOINT_SLOT_BYTES:
        raise VNextSourceStreamError("ARTIFACT_TOO_LARGE", "任务结果超过 4 MiB", 413)
    output_hash = _digest(encoded)
    now = utc_now()
    now_epoch = int(time.time())

    with control_connection() as connection:
        connection.execute("BEGIN IMMEDIATE")
        existing = connection.execute(
            """SELECT artifact.* FROM vnext_generated_artifacts artifact
               JOIN vnext_tasks task ON task.task_id = artifact.task_id
               WHERE artifact.task_id = ? AND task.device_id = ? AND task.epoch_id = ?""",
            (task_id, context.device_id, context.epoch_id),
        ).fetchone()
        if existing is not None:
            if (
                str(existing["output_sha256"]) != output_hash
                or str(existing["contract_revision"]) != contract_revision
                or str(existing["provider_revision"]) != provider_revision
            ):
                connection.rollback()
                raise VNextSourceStreamError("ARTIFACT_CONFLICT", "任务已提交其他结果", 409)
            result = {
                "artifact_id": existing["artifact_id"],
                "task_id": task_id,
                "source_manifest_sha256": existing["source_manifest_sha256"],
                "contract_revision": existing["contract_revision"],
                "provider_revision": existing["provider_revision"],
                "output_sha256": existing["output_sha256"],
                "created_at": existing["created_at"],
            }
            connection.commit()
            return result
        task, _ = _assert_attempt(
            connection,
            context,
            task_id=task_id,
            attempt_id=attempt_id,
            lease_owner=lease_owner,
        )
        stream = connection.execute(
            "SELECT * FROM vnext_source_streams WHERE task_id = ?",
            (task_id,),
        ).fetchone()
        if (
            stream is None
            or stream["state"] != "complete"
            or stream["source_manifest_sha256"] is None
            or stream["final_chapter_count"] is None
        ):
            connection.rollback()
            raise VNextSourceStreamError("SOURCE_STREAM_INCOMPLETE", "会议来源尚未处理完整", 409)
        final_ordinal = int(stream["final_chapter_count"]) - 1
        checkpoint, checkpoint_row = _load_checkpoint(connection, task)
        if (
            checkpoint is None
            or checkpoint_row is None
            or int(checkpoint_row["through_chapter_ordinal"]) != final_ordinal
        ):
            connection.rollback()
            raise VNextSourceStreamError("CHECKPOINT_INCOMPLETE", "整理恢复点尚未覆盖全部来源", 409)
        artifact_id = str(uuid.uuid5(
            uuid.NAMESPACE_URL,
            "\0".join(("laoji-vnext-artifact", task_id, str(stream["source_manifest_sha256"]), output_hash)),
        ))
        nonce, ciphertext = _encrypt("artifact", artifact_id, output_hash, encoded)
        connection.execute(
            """INSERT INTO vnext_generated_artifacts(
                 artifact_id, task_id, source_manifest_sha256, contract_revision,
                 provider_revision, output_sha256, nonce, encrypted_output,
                 output_bytes, created_at
               ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            (
                artifact_id,
                task_id,
                stream["source_manifest_sha256"],
                contract_revision,
                provider_revision,
                output_hash,
                nonce,
                ciphertext,
                len(encoded),
                now,
            ),
        )
        task_result = {
            "artifact_id": artifact_id,
            "source_manifest_sha256": stream["source_manifest_sha256"],
            "contract_revision": contract_revision,
            "provider_revision": provider_revision,
            "output_sha256": output_hash,
        }
        if not vnext_task_store.mark_success_in_transaction(
            connection,
            context,
            task_id=task_id,
            attempt_id=attempt_id,
            result=task_result,
            result_kind="artifact",
            lease_owner=lease_owner,
        ):
            connection.rollback()
            raise VNextSourceStreamError("TASK_LEASE_LOST", "任务执行权已失效", 409)
        connection.execute(
            "UPDATE vnext_tasks SET result_artifact_id = ? WHERE task_id = ?",
            (artifact_id, task_id),
        )
        connection.execute("DELETE FROM vnext_task_checkpoints WHERE task_id = ?", (task_id,))
        _release(connection, str(stream["checkpoint_reservation_id"]), now_epoch)
        connection.commit()
        return {**task_result, "task_id": task_id, "created_at": now}


def load_question_source_stream(
    context: SourceOwnerContext,
    stream_id: str,
) -> dict[str, Any] | None:
    """Read a complete immutable question stream without creating a derived summary.

    Question streams are deliberately not consumed chapter-by-chapter: the Q2
    reader needs the complete source snapshot for grounding, and the stream is
    removed only after the reader result and generic Task success are committed
    together.  This function is read-only and therefore safe to repeat after a
    provider timeout or process restart.
    """
    ensure_vnext_source_stream_schema()
    stream_id = _safe(stream_id, "stream_id", 180)
    with control_connection() as connection:
        stream = _stream_row(connection, context, stream_id)
        if stream is None:
            return None
        task = connection.execute(
            "SELECT * FROM vnext_tasks WHERE task_id = ? AND device_id = ? AND epoch_id = ?",
            (str(stream["task_id"]), context.device_id, context.epoch_id),
        ).fetchone()
        if task is None or str(task["capability"]) != "question":
            raise VNextSourceStreamError("SOURCE_STREAM_CAPABILITY_INVALID", "来源流能力不匹配", 409)
        if str(stream["binding_id"]) != str(task["binding_id"]):
            raise VNextSourceStreamError("SOURCE_STREAM_BINDING_INVALID", "来源流会议连接不匹配", 409)
        if stream["state"] != "complete" or stream["source_manifest_sha256"] is None:
            raise VNextSourceStreamError("SOURCE_STREAM_INCOMPLETE", "会议来源尚未上传完整", 409)
        final_count = stream["final_chapter_count"]
        if final_count is None or int(final_count) < 1:
            raise VNextSourceStreamError("SOURCE_MANIFEST_INCOMPLETE", "会议来源清单尚未完成", 409)
        groups = connection.execute(
            """SELECT * FROM vnext_source_bundle_groups
               WHERE stream_id = ? AND state = 'complete'
               ORDER BY chapter_ordinal""",
            (stream_id,),
        ).fetchall()
        if [int(row["chapter_ordinal"]) for row in groups] != list(range(int(final_count))):
            raise VNextSourceStreamError("SOURCE_GROUP_INCOMPLETE", "会议来源章节不完整", 409)
        sources: list[dict[str, Any]] = []
        for group in groups:
            rows = connection.execute(
                """SELECT item.*, payload.nonce, payload.ciphertext
                     FROM vnext_source_bundle_items item
                     JOIN vnext_source_bundles bundle ON bundle.bundle_id = item.bundle_id
                     JOIN vnext_encrypted_source_payloads payload ON payload.item_id = item.item_id
                    WHERE bundle.group_id = ?
                    ORDER BY bundle.ordinal, item.ordinal""",
                (group["group_id"],),
            ).fetchall()
            if len(rows) != int(group["declared_item_count"]):
                raise VNextSourceStreamError("SOURCE_ITEM_COUNT_MISMATCH", "会议来源条目数量不一致", 409)
            for row in rows:
                plaintext = _decrypt(
                    "item",
                    str(row["item_id"]),
                    str(row["content_sha256"]),
                    bytes(row["nonce"]),
                    bytes(row["ciphertext"]),
                )
                if _digest(plaintext) != str(row["content_sha256"]):
                    raise VNextSourceStreamError("SOURCE_CONTENT_HASH_MISMATCH", "来源正文校验失败", 500)
                try:
                    content = plaintext.decode("utf-8")
                except UnicodeDecodeError as error:
                    raise VNextSourceStreamError("SOURCE_CONTENT_INVALID", "来源正文编码无效", 500) from error
                sources.append({
                    "source_type": str(row["source_type"]),
                    "source_id": str(row["source_id"]),
                    "source_revision_id": str(row["source_revision_id"]),
                    "source_start_utf8": int(row["source_start_utf8"]),
                    "source_end_utf8": int(row["source_end_utf8"]),
                    "content_sha256": str(row["content_sha256"]),
                    "start_ms": row["start_ms"],
                    "end_ms": row["end_ms"],
                    "speaker": row["speaker"],
                    "text": content,
                })
        if not sources:
            raise VNextSourceStreamError("SOURCE_EMPTY", "会议来源为空", 409)
        return {
            "stream_id": stream_id,
            "task_id": str(task["task_id"]),
            "binding_id": str(stream["binding_id"]),
            "binding_generation": str(stream["binding_generation"]),
            "binding_revision": int(stream["binding_revision"]),
            "cancel_revision": int(stream["cancel_revision"]),
            "source_fingerprint": str(task["input_sha256"]),
            "source_manifest_sha256": str(stream["source_manifest_sha256"]),
            "sources": sources,
        }


def commit_question_result(
    context: SourceOwnerContext,
    task_id: str,
    *,
    attempt_id: str,
    lease_owner: str,
    source_stream_id: str,
    source_fingerprint: str,
    result: dict[str, Any],
) -> dict[str, Any]:
    """Publish a Q2 result and purge its immutable source stream atomically."""
    ensure_vnext_source_stream_schema()
    task_id = _safe(task_id, "task_id")
    attempt_id = _safe(attempt_id, "attempt_id")
    lease_owner = _safe(lease_owner, "lease_owner", 200)
    source_stream_id = _safe(source_stream_id, "source_stream_id", 180)
    source_fingerprint = _sha256(source_fingerprint, "source_fingerprint")
    if not isinstance(result, dict):
        raise VNextSourceStreamError("Q2_RESULT_INVALID", "问答结果必须是对象", 422)
    with control_connection() as connection:
        connection.execute("BEGIN IMMEDIATE")
        task, _attempt = _assert_attempt(
            connection,
            context,
            task_id=task_id,
            attempt_id=attempt_id,
            lease_owner=lease_owner,
        )
        if str(task["capability"]) != "question" or str(task["input_sha256"]) != source_fingerprint:
            connection.rollback()
            raise VNextSourceStreamError("Q2_SOURCE_FENCE_INVALID", "问答来源版本已变化", 409)
        stream = _stream_row(connection, context, source_stream_id)
        if (
            stream is None
            or str(stream["task_id"]) != task_id
            or stream["state"] != "complete"
        ):
            connection.rollback()
            raise VNextSourceStreamError("SOURCE_STREAM_INCOMPLETE", "会议来源尚未处理完整", 409)
        if not vnext_task_store.mark_success_in_transaction(
            connection,
            context,
            task_id=task_id,
            attempt_id=attempt_id,
            result=result,
            result_kind="content_outcome",
            lease_owner=lease_owner,
        ):
            connection.rollback()
            raise VNextSourceStreamError("TASK_LEASE_LOST", "任务执行权已失效", 409)
        connection.execute(
            """UPDATE vnext_tasks
                  SET source_stream_id = NULL, checkpoint_reservation_id = NULL,
                      updated_at = ?
                WHERE task_id = ?""",
            (utc_now(), task_id),
        )
        # Foreign-key cascades remove manifest, bundles and encrypted payloads;
        # their triggers release all reservations, including the checkpoint.
        connection.execute("DELETE FROM vnext_source_streams WHERE stream_id = ?", (source_stream_id,))
        connection.commit()
    return {"task_id": task_id, "source_stream_id": source_stream_id, **result}


def load_generated_artifact(
    context: SourceOwnerContext,
    task_id: str,
) -> dict[str, Any] | None:
    """Load a verified artifact for an internal versioned summary/question handler."""
    ensure_vnext_source_stream_schema()
    task_id = _safe(task_id, "task_id")
    with control_connection() as connection:
        row = connection.execute(
            """SELECT artifact.* FROM vnext_generated_artifacts artifact
               JOIN vnext_tasks task ON task.task_id = artifact.task_id
               WHERE artifact.task_id = ? AND task.device_id = ? AND task.epoch_id = ?""",
            (task_id, context.device_id, context.epoch_id),
        ).fetchone()
    if row is None:
        return None
    plaintext = _decrypt(
        "artifact",
        str(row["artifact_id"]),
        str(row["output_sha256"]),
        bytes(row["nonce"]),
        bytes(row["encrypted_output"]),
    )
    if _digest(plaintext) != str(row["output_sha256"]):
        raise VNextSourceStreamError("ARTIFACT_HASH_MISMATCH", "任务结果校验失败", 500)
    try:
        output = json.loads(plaintext)
    except json.JSONDecodeError as error:
        raise VNextSourceStreamError("ARTIFACT_INVALID", "任务结果格式损坏", 500) from error
    if not isinstance(output, dict):
        raise VNextSourceStreamError("ARTIFACT_INVALID", "任务结果格式损坏", 500)
    return {
        "artifact_id": row["artifact_id"],
        "task_id": row["task_id"],
        "source_manifest_sha256": row["source_manifest_sha256"],
        "contract_revision": row["contract_revision"],
        "provider_revision": row["provider_revision"],
        "output_sha256": row["output_sha256"],
        "created_at": row["created_at"],
        "output": output,
    }


def cancel_source_stream(context: SourceOwnerContext, stream_id: str) -> bool:
    ensure_vnext_source_stream_schema()
    stream_id = _safe(stream_id, "stream_id", 180)
    now = utc_now()
    now_epoch = int(time.time())
    with control_connection() as connection:
        connection.execute("BEGIN IMMEDIATE")
        stream = _stream_row(connection, context, stream_id)
        if stream is None:
            connection.rollback()
            return False
        if stream["state"] in {"cancelled", "expired"}:
            connection.commit()
            return True
        if stream["state"] == "complete":
            connection.rollback()
            return False
        reservation_rows = connection.execute(
            """SELECT reservation_id FROM vnext_source_manifest_pages WHERE stream_id = ?
               UNION ALL
               SELECT reservation_id FROM vnext_source_bundle_groups WHERE stream_id = ?
               UNION ALL
               SELECT checkpoint_reservation_id FROM vnext_source_streams WHERE stream_id = ?""",
            (stream_id, stream_id, stream_id),
        ).fetchall()
        for row in reservation_rows:
            _release(connection, str(row["reservation_id"]), now_epoch)
        connection.execute("DELETE FROM vnext_task_checkpoints WHERE task_id = ?", (stream["task_id"],))
        connection.execute("DELETE FROM vnext_source_manifest_pages WHERE stream_id = ?", (stream_id,))
        connection.execute("DELETE FROM vnext_source_bundle_groups WHERE stream_id = ?", (stream_id,))
        connection.execute(
            "UPDATE vnext_source_streams SET state = 'cancelled', updated_at = ?, expires_at_epoch = ? WHERE stream_id = ?",
            (now, now_epoch, stream_id),
        )
        vnext_task_store.cancel_task_in_transaction(
            connection,
            context,
            task_id=str(stream["task_id"]),
            now=now,
        )
        connection.commit()
        return True


def reset_store_for_tests() -> None:
    ensure_vnext_source_stream_schema()
    with control_connection() as connection:
        connection.execute("BEGIN IMMEDIATE")
        connection.execute("DELETE FROM vnext_generated_artifacts")
        connection.execute("DELETE FROM vnext_task_checkpoints")
        connection.execute("DELETE FROM vnext_source_bundle_groups")
        connection.execute("DELETE FROM vnext_source_manifest_pages")
        connection.execute("DELETE FROM vnext_source_streams")
        connection.execute("DELETE FROM vnext_source_reservations")
        connection.commit()
