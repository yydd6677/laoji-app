"""Persistent vNext capability barriers and legacy submission counters."""

from __future__ import annotations

import os
import uuid
from typing import Any

from app.services.device_identity import control_connection, utc_now


MEDIA_UPLOAD_CAPABILITY = "media.upload"
MEDIA_UPLOAD_CONTRACT_REVISION = "device-v2-r2+import-transcript-events-v2"
REALTIME_ASR_CAPABILITY = "transcript.realtime"
REALTIME_ASR_CONTRACT_REVISION = "device-v2-realtime-v2"


class VNextCapabilityCutoverError(RuntimeError):
    def __init__(self, code: str, message: str, status_code: int = 409):
        super().__init__(message)
        self.code = code
        self.message = message
        self.status_code = status_code


def _safe(value: str, field: str, maximum: int = 160) -> str:
    normalized = str(value or "").strip()
    if not normalized or len(normalized) > maximum or any(ord(char) < 32 or ord(char) == 127 for char in normalized):
        raise VNextCapabilityCutoverError("CAPABILITY_INVALID", f"{field}无效", 422)
    return normalized


def ensure_schema() -> None:
    with control_connection() as connection:
        connection.executescript(
            """
            CREATE TABLE IF NOT EXISTS capability_cutovers (
                capability TEXT PRIMARY KEY,
                contract_revision TEXT NOT NULL,
                barrier_id TEXT,
                activated_at TEXT,
                legacy_submit_closed_at TEXT,
                legacy_reader_removed_at TEXT,
                legacy_submit_count INTEGER NOT NULL DEFAULT 0 CHECK(legacy_submit_count >= 0),
                last_legacy_submit_at TEXT,
                updated_at TEXT NOT NULL
            );
            """
        )


def _payload(row: Any) -> dict[str, Any] | None:
    if row is None:
        return None
    return {
        "capability": row["capability"],
        "contract_revision": row["contract_revision"],
        "barrier_id": row["barrier_id"],
        "activated_at": row["activated_at"],
        "legacy_submit_closed_at": row["legacy_submit_closed_at"],
        "legacy_reader_removed_at": row["legacy_reader_removed_at"],
        "legacy_submit_count": int(row["legacy_submit_count"]),
        "last_legacy_submit_at": row["last_legacy_submit_at"],
        "closed": row["legacy_submit_closed_at"] is not None,
    }


def get_cutover(capability: str) -> dict[str, Any] | None:
    ensure_schema()
    normalized = _safe(capability, "capability", 120)
    with control_connection() as connection:
        return _payload(connection.execute(
            "SELECT * FROM capability_cutovers WHERE capability = ?",
            (normalized,),
        ).fetchone())


def activate_cutover(
    capability: str,
    contract_revision: str,
    *,
    barrier_id: str | None = None,
) -> dict[str, Any]:
    ensure_schema()
    normalized = _safe(capability, "capability", 120)
    revision = _safe(contract_revision, "contract_revision", 160)
    requested_barrier = _safe(barrier_id, "barrier_id", 160) if barrier_id else f"barrier-{uuid.uuid4()}"
    now = utc_now()
    with control_connection() as connection:
        connection.execute("BEGIN IMMEDIATE")
        existing = connection.execute(
            "SELECT * FROM capability_cutovers WHERE capability = ?",
            (normalized,),
        ).fetchone()
        if existing is not None and existing["contract_revision"] != revision:
            raise VNextCapabilityCutoverError(
                "CAPABILITY_REVISION_CONFLICT",
                "能力切换协议版本冲突",
            )
        if existing is None:
            connection.execute(
                """INSERT INTO capability_cutovers (
                       capability, contract_revision, barrier_id, activated_at,
                       legacy_submit_closed_at, legacy_submit_count, updated_at
                   ) VALUES (?, ?, ?, ?, ?, 0, ?)""",
                (normalized, revision, requested_barrier, now, now, now),
            )
        elif existing["legacy_submit_closed_at"] is None:
            connection.execute(
                """UPDATE capability_cutovers
                      SET barrier_id = ?, activated_at = ?, legacy_submit_closed_at = ?, updated_at = ?
                    WHERE capability = ? AND legacy_submit_closed_at IS NULL""",
                (existing["barrier_id"] or requested_barrier, now, now, now, normalized),
            )
        row = connection.execute(
            "SELECT * FROM capability_cutovers WHERE capability = ?",
            (normalized,),
        ).fetchone()
        payload = _payload(row)
        if payload is None or not payload["closed"]:
            raise RuntimeError("capability_cutover_activation_failed")
        return payload


def guard_legacy_submit(capability: str, contract_revision: str) -> None:
    ensure_schema()
    normalized = _safe(capability, "capability", 120)
    revision = _safe(contract_revision, "contract_revision", 160)
    now = utc_now()
    with control_connection() as connection:
        connection.execute("BEGIN IMMEDIATE")
        row = connection.execute(
            "SELECT * FROM capability_cutovers WHERE capability = ?",
            (normalized,),
        ).fetchone()
        if row is not None and row["legacy_submit_closed_at"] is not None:
            raise VNextCapabilityCutoverError(
                "UPGRADE_REQUIRED",
                "当前版本已停止旧录音处理入口，请升级应用",
                426,
            )
        if row is not None and row["contract_revision"] != revision:
            raise VNextCapabilityCutoverError(
                "CAPABILITY_REVISION_CONFLICT",
                "能力切换协议版本冲突",
            )
        connection.execute(
            """INSERT INTO capability_cutovers (
                   capability, contract_revision, legacy_submit_count,
                   last_legacy_submit_at, updated_at
               ) VALUES (?, ?, 1, ?, ?)
               ON CONFLICT(capability) DO UPDATE SET
                   legacy_submit_count = capability_cutovers.legacy_submit_count + 1,
                   last_legacy_submit_at = excluded.last_legacy_submit_at,
                   updated_at = excluded.updated_at""",
            (normalized, revision, now, now),
        )


def media_upload_cutover_enabled(*, prerequisites_ready: bool) -> bool:
    current = get_cutover(MEDIA_UPLOAD_CAPABILITY)
    if current and current["closed"]:
        return True
    configured = os.getenv("LAOJI_VNEXT_MEDIA_UPLOAD_BARRIER_ENABLED", "").strip() == "1"
    if not configured or not prerequisites_ready:
        return False
    barrier_id = os.getenv("LAOJI_VNEXT_MEDIA_UPLOAD_BARRIER_ID", "").strip() or None
    activate_cutover(
        MEDIA_UPLOAD_CAPABILITY,
        MEDIA_UPLOAD_CONTRACT_REVISION,
        barrier_id=barrier_id,
    )
    return True


def guard_legacy_media_upload_submit() -> None:
    guard_legacy_submit(MEDIA_UPLOAD_CAPABILITY, MEDIA_UPLOAD_CONTRACT_REVISION)


def realtime_asr_v2_enabled() -> bool:
    """Return the explicit opt-in for the durable realtime v2 transport.

    The route is shipped in the candidate service for protocol testing, but a
    missing flag must keep it unavailable.  This prevents a newer client from
    silently selecting a transport whose mobile projection/latency gates have
    not been accepted yet.
    """
    return os.getenv("LAOJI_VNEXT_REALTIME_V2_ENABLED", "").strip() == "1"


def schedule_graph_v2_enabled() -> bool:
    """Expose the MentionGraph producer only as an explicit candidate."""
    return os.getenv("LAOJI_VNEXT_SCHEDULE_GRAPH_ENABLED", "").strip() == "1"


def source_stream_v2_enabled() -> bool:
    """Expose the Stage 3 encrypted source owner only for candidate traffic."""
    return os.getenv("LAOJI_VNEXT_SOURCE_STREAM_V2_ENABLED", "").strip() == "1"
