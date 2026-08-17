"""Encrypted source payloads and immutable verified documents for summary v3."""

from __future__ import annotations

import base64
from datetime import datetime, timedelta, timezone
import hashlib
import json
import os
from pathlib import Path
import sqlite3
import threading
from typing import Any
import uuid

from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from sqlalchemy.engine import make_url

from app.config import settings


PAYLOAD_TTL_SECONDS = 24 * 60 * 60
_SCHEMA_LOCK = threading.Lock()
_INITIALIZED_PATHS: set[Path] = set()


class SummaryV3StoreError(RuntimeError):
    pass


def _database_path() -> Path:
    url = make_url(settings.DATABASE_URL)
    if not url.drivername.startswith("sqlite") or not url.database:
        raise SummaryV3StoreError("summary_v3_store_requires_sqlite")
    return Path(url.database).expanduser().resolve()


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _iso(value: datetime) -> str:
    return value.astimezone(timezone.utc).isoformat()


def _connect() -> sqlite3.Connection:
    path = _database_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    connection = sqlite3.connect(path, timeout=30)
    connection.row_factory = sqlite3.Row
    connection.execute("PRAGMA journal_mode=WAL")
    connection.execute("PRAGMA foreign_keys=ON")
    connection.execute("PRAGMA busy_timeout=10000")
    with _SCHEMA_LOCK:
        if path not in _INITIALIZED_PATHS:
            connection.executescript(
                """
                CREATE TABLE IF NOT EXISTS summary_v3_source_payloads (
                    id TEXT PRIMARY KEY,
                    task_scope TEXT NOT NULL,
                    meeting_id TEXT NOT NULL,
                    nonce BLOB NOT NULL,
                    ciphertext BLOB NOT NULL,
                    content_bytes INTEGER NOT NULL,
                    created_at TEXT NOT NULL,
                    expires_at TEXT NOT NULL,
                    CHECK (content_bytes >= 0)
                );
                CREATE INDEX IF NOT EXISTS idx_summary_v3_payload_expiry
                    ON summary_v3_source_payloads(expires_at, id);

                CREATE TABLE IF NOT EXISTS summary_v3_documents (
                    id TEXT PRIMARY KEY,
                    task_id TEXT NOT NULL,
                    task_scope TEXT NOT NULL,
                    meeting_id TEXT NOT NULL,
                    source_fingerprint TEXT NOT NULL,
                    transcript_revision TEXT NOT NULL,
                    model_revision TEXT NOT NULL,
                    prompt_revision TEXT NOT NULL,
                    document_json TEXT NOT NULL,
                    coverage_json TEXT NOT NULL,
                    generated_at TEXT NOT NULL,
                    active INTEGER NOT NULL DEFAULT 1,
                    UNIQUE (
                        task_scope,
                        meeting_id,
                        source_fingerprint,
                        model_revision,
                        prompt_revision
                    ),
                    CHECK (active IN (0, 1))
                );
                CREATE INDEX IF NOT EXISTS idx_summary_v3_document_current
                    ON summary_v3_documents(task_scope, meeting_id, active, generated_at DESC, id);
                """
            )
            connection.commit()
            _INITIALIZED_PATHS.add(path)
    return connection


def _payload_key() -> bytes:
    raw = os.getenv("LAOJI_SUMMARY_V3_PAYLOAD_KEY", "").strip()
    if not raw:
        # Development/test environments may not provide a separate payload
        # key. Derive an AES-256 key from the already-required application
        # secret there; production still rejects the default SECRET_KEY in
        # Settings, so user content never relies on the placeholder value.
        fallback = str(getattr(settings, "SECRET_KEY", "") or "").strip()
        if not fallback or (
            str(getattr(settings, "ENV", "")).strip().lower() == "production"
            and fallback == "change-me-in-production"
        ):
            raise SummaryV3StoreError("summary_v3_payload_key_missing")
        return hashlib.sha256(f"laoji-summary-v3:{fallback}".encode("utf-8")).digest()
    key: bytes
    try:
        if len(raw) == 64 and all(character in "0123456789abcdefABCDEF" for character in raw):
            key = bytes.fromhex(raw)
        else:
            padding = "=" * (-len(raw) % 4)
            key = base64.urlsafe_b64decode(raw + padding)
    except (ValueError, TypeError) as exc:
        raise SummaryV3StoreError("summary_v3_payload_key_invalid") from exc
    if len(key) != 32:
        raise SummaryV3StoreError("summary_v3_payload_key_invalid")
    return key


def _payload_aad(payload_id: str, task_scope: str, meeting_id: str) -> bytes:
    return f"laoji-summary-v3\0{payload_id}\0{task_scope}\0{meeting_id}".encode("utf-8")


def save_source_payload(
    *,
    task_scope: str,
    meeting_id: str,
    payload: dict[str, Any],
    ttl_seconds: int = PAYLOAD_TTL_SECONDS,
) -> str:
    encoded = json.dumps(
        payload,
        ensure_ascii=False,
        separators=(",", ":"),
        sort_keys=True,
    ).encode("utf-8")
    payload_id = str(uuid.uuid4())
    nonce = os.urandom(12)
    ciphertext = AESGCM(_payload_key()).encrypt(
        nonce,
        encoded,
        _payload_aad(payload_id, task_scope, meeting_id),
    )
    now = _now()
    expires = now + timedelta(seconds=max(60, min(PAYLOAD_TTL_SECONDS, int(ttl_seconds))))
    with _connect() as connection:
        connection.execute(
            """
            INSERT INTO summary_v3_source_payloads (
                id, task_scope, meeting_id, nonce, ciphertext,
                content_bytes, created_at, expires_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                payload_id,
                task_scope,
                meeting_id,
                nonce,
                ciphertext,
                len(encoded),
                _iso(now),
                _iso(expires),
            ),
        )
        connection.commit()
    return payload_id


def load_source_payload(
    payload_id: str,
    *,
    task_scope: str,
    meeting_id: str,
) -> dict[str, Any]:
    with _connect() as connection:
        row = connection.execute(
            """
            SELECT * FROM summary_v3_source_payloads
            WHERE id = ? AND task_scope = ? AND meeting_id = ?
            """,
            (payload_id, task_scope, meeting_id),
        ).fetchone()
        if row is None:
            raise SummaryV3StoreError("summary_v3_payload_missing")
        if str(row["expires_at"]) <= _iso(_now()):
            connection.execute("DELETE FROM summary_v3_source_payloads WHERE id = ?", (payload_id,))
            connection.commit()
            raise SummaryV3StoreError("summary_v3_payload_expired")
    try:
        plaintext = AESGCM(_payload_key()).decrypt(
            bytes(row["nonce"]),
            bytes(row["ciphertext"]),
            _payload_aad(payload_id, task_scope, meeting_id),
        )
        decoded = json.loads(plaintext)
    except Exception as exc:
        raise SummaryV3StoreError("summary_v3_payload_decrypt_failed") from exc
    if not isinstance(decoded, dict):
        raise SummaryV3StoreError("summary_v3_payload_invalid")
    return decoded


def delete_source_payload(payload_id: str) -> bool:
    with _connect() as connection:
        cursor = connection.execute(
            "DELETE FROM summary_v3_source_payloads WHERE id = ?",
            (payload_id,),
        )
        connection.commit()
        return cursor.rowcount == 1


def purge_expired_source_payloads() -> int:
    with _connect() as connection:
        cursor = connection.execute(
            "DELETE FROM summary_v3_source_payloads WHERE expires_at <= ?",
            (_iso(_now()),),
        )
        connection.commit()
        return int(cursor.rowcount)


def source_payload_metadata(payload_id: str) -> dict[str, Any] | None:
    """Return redaction-safe metadata only; ciphertext and user text never leave the store."""
    with _connect() as connection:
        row = connection.execute(
            """
            SELECT id, task_scope, meeting_id, content_bytes, created_at, expires_at
            FROM summary_v3_source_payloads WHERE id = ?
            """,
            (payload_id,),
        ).fetchone()
    return dict(row) if row is not None else None


def _decode_document(row: sqlite3.Row | None) -> dict[str, Any] | None:
    if row is None:
        return None
    value = dict(row)
    try:
        value["document"] = json.loads(value.pop("document_json"))
        value["coverage"] = json.loads(value.pop("coverage_json"))
    except (TypeError, json.JSONDecodeError) as exc:
        raise SummaryV3StoreError("summary_v3_document_invalid") from exc
    value["active"] = bool(value["active"])
    return value


def find_document_by_identity(
    *,
    task_scope: str,
    meeting_id: str,
    source_fingerprint: str,
    model_revision: str,
    prompt_revision: str,
) -> dict[str, Any] | None:
    with _connect() as connection:
        row = connection.execute(
            """
            SELECT * FROM summary_v3_documents
            WHERE task_scope = ? AND meeting_id = ? AND source_fingerprint = ?
              AND model_revision = ? AND prompt_revision = ?
            LIMIT 1
            """,
            (
                task_scope,
                meeting_id,
                source_fingerprint,
                model_revision,
                prompt_revision,
            ),
        ).fetchone()
    return _decode_document(row)


def latest_document(*, task_scope: str, meeting_id: str) -> dict[str, Any] | None:
    with _connect() as connection:
        row = connection.execute(
            """
            SELECT * FROM summary_v3_documents
            WHERE task_scope = ? AND meeting_id = ? AND active = 1
            ORDER BY generated_at DESC, id DESC LIMIT 1
            """,
            (task_scope, meeting_id),
        ).fetchone()
    return _decode_document(row)


def persist_document(
    *,
    task_id: str,
    task_scope: str,
    meeting_id: str,
    source_fingerprint: str,
    transcript_revision: str,
    model_revision: str,
    prompt_revision: str,
    document: dict[str, Any],
    coverage: dict[str, Any],
) -> dict[str, Any]:
    encoded_document = json.dumps(
        document,
        ensure_ascii=False,
        separators=(",", ":"),
        sort_keys=True,
    )
    encoded_coverage = json.dumps(
        coverage,
        ensure_ascii=False,
        separators=(",", ":"),
        sort_keys=True,
    )
    generated_at = _iso(_now())
    document_id = str(
        uuid.uuid5(
            uuid.NAMESPACE_URL,
            "\0".join(
                (
                    "laoji-summary-v3",
                    task_scope,
                    meeting_id,
                    source_fingerprint,
                    model_revision,
                    prompt_revision,
                )
            ),
        )
    )
    with _connect() as connection:
        connection.execute("BEGIN IMMEDIATE")
        existing = connection.execute(
            """
            SELECT * FROM summary_v3_documents
            WHERE task_scope = ? AND meeting_id = ? AND source_fingerprint = ?
              AND model_revision = ? AND prompt_revision = ?
            LIMIT 1
            """,
            (
                task_scope,
                meeting_id,
                source_fingerprint,
                model_revision,
                prompt_revision,
            ),
        ).fetchone()
        if existing is None:
            connection.execute(
                "UPDATE summary_v3_documents SET active = 0 WHERE task_scope = ? AND meeting_id = ?",
                (task_scope, meeting_id),
            )
            connection.execute(
                """
                INSERT INTO summary_v3_documents (
                    id, task_id, task_scope, meeting_id, source_fingerprint,
                    transcript_revision, model_revision, prompt_revision,
                    document_json, coverage_json, generated_at, active
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
                """,
                (
                    document_id,
                    task_id,
                    task_scope,
                    meeting_id,
                    source_fingerprint,
                    transcript_revision,
                    model_revision,
                    prompt_revision,
                    encoded_document,
                    encoded_coverage,
                    generated_at,
                ),
            )
        else:
            document_id = str(existing["id"])
            connection.execute(
                "UPDATE summary_v3_documents SET active = CASE WHEN id = ? THEN 1 ELSE 0 END WHERE task_scope = ? AND meeting_id = ?",
                (document_id, task_scope, meeting_id),
            )
        row = connection.execute(
            "SELECT * FROM summary_v3_documents WHERE id = ?",
            (document_id,),
        ).fetchone()
        connection.commit()
    decoded = _decode_document(row)
    if decoded is None:
        raise SummaryV3StoreError("summary_v3_document_persist_failed")
    return decoded


def source_fingerprint(payload: dict[str, Any]) -> str:
    encoded = json.dumps(
        payload,
        ensure_ascii=False,
        separators=(",", ":"),
        sort_keys=True,
    ).encode("utf-8")
    return f"sha256:{hashlib.sha256(encoded).hexdigest()}"


def reset_store_for_tests() -> None:
    with _SCHEMA_LOCK:
        _INITIALIZED_PATHS.clear()
