"""Persistent vNext capability barriers and legacy submission counters."""

from __future__ import annotations

import os
import uuid
from typing import Any

from app.config import settings
from app.services.device_identity import control_connection, utc_now


MEDIA_UPLOAD_CAPABILITY = "media.upload"
MEDIA_UPLOAD_CONTRACT_REVISION = "device-v2-r2+import-transcript-events-v2"
REALTIME_ASR_CAPABILITY = "transcript.realtime"
REALTIME_ASR_CONTRACT_REVISION = "device-v2-realtime-v2"
SCHEDULE_GRAPH_CAPABILITY = "schedule"
SCHEDULE_GRAPH_CONTRACT_REVISION = "schedule-mention-graph-v2"
SOURCE_STREAM_CAPABILITY = "summary"
SOURCE_STREAM_CONTRACT_REVISION = "facts-v3-source-stream-v2"
QUESTION_READER_CAPABILITY = "question"
QUESTION_READER_CONTRACT_REVISION = "question-reader-v2"


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


def _sha256(value: str, field: str = "evidence_sha256") -> str:
    normalized = _safe(value, field, 71)
    if len(normalized) != 71 or not normalized.startswith("sha256:"):
        raise VNextCapabilityCutoverError("CAPABILITY_EVIDENCE_INVALID", f"{field}无效", 422)
    try:
        int(normalized[7:], 16)
    except ValueError as error:
        raise VNextCapabilityCutoverError("CAPABILITY_EVIDENCE_INVALID", f"{field}无效", 422) from error
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
                legacy_reader_removal_revision TEXT,
                legacy_reader_removal_evidence_sha256 TEXT,
                adoption_basis TEXT,
                adoption_evidence_sha256 TEXT,
                legacy_retention_mode TEXT,
                legacy_submit_count INTEGER NOT NULL DEFAULT 0 CHECK(legacy_submit_count >= 0),
                last_legacy_submit_at TEXT,
                updated_at TEXT NOT NULL
            );
            """
        )
        columns = {str(row[1]) for row in connection.execute("PRAGMA table_info(capability_cutovers)")}
        additive_columns = {
            "legacy_reader_removal_revision": "TEXT",
            "legacy_reader_removal_evidence_sha256": "TEXT",
            "adoption_basis": "TEXT",
            "adoption_evidence_sha256": "TEXT",
            "legacy_retention_mode": "TEXT",
        }
        for column, declaration in additive_columns.items():
            if column not in columns:
                connection.execute(
                    f"ALTER TABLE capability_cutovers ADD COLUMN {column} {declaration}"
                )
        connection.commit()


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
        "legacy_reader_removal_revision": row["legacy_reader_removal_revision"],
        "legacy_reader_removal_evidence_sha256": row["legacy_reader_removal_evidence_sha256"],
        "adoption_basis": row["adoption_basis"],
        "adoption_evidence_sha256": row["adoption_evidence_sha256"],
        "legacy_retention_mode": row["legacy_retention_mode"],
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
    adoption_basis: str | None = None,
    adoption_evidence_sha256: str | None = None,
    legacy_retention_mode: str | None = None,
) -> dict[str, Any]:
    ensure_schema()
    normalized = _safe(capability, "capability", 120)
    revision = _safe(contract_revision, "contract_revision", 160)
    requested_barrier = _safe(barrier_id, "barrier_id", 160) if barrier_id else f"barrier-{uuid.uuid4()}"
    adoption_values = (adoption_basis, adoption_evidence_sha256, legacy_retention_mode)
    if any(value is not None for value in adoption_values) and not all(value is not None for value in adoption_values):
        raise VNextCapabilityCutoverError(
            "CAPABILITY_ADOPTION_EVIDENCE_INCOMPLETE",
            "能力采用证据不完整",
            422,
        )
    normalized_basis = _safe(adoption_basis, "adoption_basis", 120) if adoption_basis is not None else None
    normalized_evidence = _sha256(adoption_evidence_sha256) if adoption_evidence_sha256 is not None else None
    normalized_retention = (
        _safe(legacy_retention_mode, "legacy_retention_mode", 120)
        if legacy_retention_mode is not None
        else None
    )
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
                       legacy_submit_closed_at, adoption_basis,
                       adoption_evidence_sha256, legacy_retention_mode,
                       legacy_submit_count, updated_at
                   ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?)""",
                (
                    normalized, revision, requested_barrier, now, now,
                    normalized_basis, normalized_evidence, normalized_retention, now,
                ),
            )
        elif existing["legacy_submit_closed_at"] is None:
            connection.execute(
                """UPDATE capability_cutovers
                      SET barrier_id = ?, activated_at = ?, legacy_submit_closed_at = ?,
                          adoption_basis = ?, adoption_evidence_sha256 = ?,
                          legacy_retention_mode = ?, updated_at = ?
                    WHERE capability = ? AND legacy_submit_closed_at IS NULL""",
                (
                    existing["barrier_id"] or requested_barrier, now, now,
                    normalized_basis, normalized_evidence, normalized_retention,
                    now, normalized,
                ),
            )
        elif normalized_evidence is not None:
            existing_evidence = existing["adoption_evidence_sha256"]
            existing_basis = existing["adoption_basis"]
            existing_retention = existing["legacy_retention_mode"]
            existing_values = (existing_basis, existing_evidence, existing_retention)
            requested_values = (normalized_basis, normalized_evidence, normalized_retention)
            if any(value is not None for value in existing_values) and existing_values != requested_values:
                raise VNextCapabilityCutoverError(
                    "CAPABILITY_ADOPTION_PROOF_CONFLICT",
                    "能力采用证据已登记且不能替换",
                    409,
                )
            if all(value is None for value in existing_values):
                connection.execute(
                    """UPDATE capability_cutovers
                          SET adoption_basis = ?, adoption_evidence_sha256 = ?,
                              legacy_retention_mode = ?, updated_at = ?
                        WHERE capability = ?""",
                    (
                        normalized_basis, normalized_evidence,
                        normalized_retention, now, normalized,
                    ),
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


def mark_legacy_reader_removed(
    capability: str,
    contract_revision: str,
    *,
    removal_revision: str,
    evidence_sha256: str,
) -> dict[str, Any]:
    """Persist a reader-removal proof after a barrier has been closed.

    This function records an externally produced source/reference audit; it
    does not run that audit and it cannot activate a capability.  Repeating
    the exact proof is idempotent.  A different proof for the same capability
    is rejected so the deletion gate never silently replaces history.
    """
    ensure_schema()
    normalized = _safe(capability, "capability", 120)
    revision = _safe(contract_revision, "contract_revision", 160)
    removal = _safe(removal_revision, "removal_revision", 160)
    evidence = _sha256(evidence_sha256)
    now = utc_now()
    with control_connection() as connection:
        connection.execute("BEGIN IMMEDIATE")
        row = connection.execute(
            "SELECT * FROM capability_cutovers WHERE capability = ?",
            (normalized,),
        ).fetchone()
        if row is None:
            raise VNextCapabilityCutoverError("CAPABILITY_NOT_ACTIVATED", "能力尚未激活", 409)
        if row["contract_revision"] != revision:
            raise VNextCapabilityCutoverError("CAPABILITY_REVISION_CONFLICT", "能力切换协议版本冲突")
        if row["activated_at"] is None or row["legacy_submit_closed_at"] is None:
            raise VNextCapabilityCutoverError("CAPABILITY_NOT_CLOSED", "旧提交尚未关闭", 409)
        existing_evidence = row["legacy_reader_removal_evidence_sha256"]
        existing_revision = row["legacy_reader_removal_revision"]
        if row["legacy_reader_removed_at"] is not None:
            if existing_evidence == evidence and existing_revision == removal:
                return _payload(row)
            raise VNextCapabilityCutoverError(
                "CAPABILITY_READER_PROOF_CONFLICT",
                "旧读取器移除证据已登记且不能替换",
                409,
            )
        connection.execute(
            """UPDATE capability_cutovers
                  SET legacy_reader_removed_at = ?,
                      legacy_reader_removal_revision = ?,
                      legacy_reader_removal_evidence_sha256 = ?,
                      updated_at = ?
                WHERE capability = ? AND legacy_reader_removed_at IS NULL""",
            (now, removal, evidence, now, normalized),
        )
        updated = connection.execute(
            "SELECT * FROM capability_cutovers WHERE capability = ?",
            (normalized,),
        ).fetchone()
        payload = _payload(updated)
        if payload is None or payload["legacy_reader_removed_at"] is None:
            raise RuntimeError("capability_reader_removal_record_failed")
        return payload


def _candidate_or_persisted_enabled(capability: str, environment_name: str) -> bool:
    """Read a monotonic capability gate without making env the source of truth.

    Environment flags are intentionally retained for isolated candidate runs.
    Once a barrier is durably closed, a process restart must not silently turn
    the capability off just because its transient environment was rebuilt.
    """
    # Explicit candidate runs must remain usable in isolated route tests and
    # disposable environments that intentionally have no control database.
    if os.getenv(environment_name, "").strip() == "1":
        return True
    database_url = str(settings.DATABASE_URL or "").strip()
    if not database_url or database_url.endswith("/:memory:"):
        return False
    try:
        current = get_cutover(capability)
    except Exception:
        # A missing/unavailable control plane must never enable a production
        # route implicitly; callers observe the existing fail-closed behavior.
        return False
    return bool(current and current["closed"])


def realtime_asr_v2_enabled() -> bool:
    """Return the explicit opt-in for the durable realtime v2 transport.

    The route is shipped in the candidate service for protocol testing, but a
    missing flag must keep it unavailable.  This prevents a newer client from
    silently selecting a transport whose mobile projection/latency gates have
    not been accepted yet.
    """
    return _candidate_or_persisted_enabled(
        REALTIME_ASR_CAPABILITY,
        "LAOJI_VNEXT_REALTIME_V2_ENABLED",
    )


def schedule_graph_v2_enabled() -> bool:
    """Expose the MentionGraph producer only as an explicit candidate."""
    return _candidate_or_persisted_enabled(
        SCHEDULE_GRAPH_CAPABILITY,
        "LAOJI_VNEXT_SCHEDULE_GRAPH_ENABLED",
    )


def source_stream_v2_enabled() -> bool:
    """Expose the Stage 3 encrypted source owner only for candidate traffic."""
    return _candidate_or_persisted_enabled(
        SOURCE_STREAM_CAPABILITY,
        "LAOJI_VNEXT_SOURCE_STREAM_V2_ENABLED",
    )


def question_reader_v2_enabled() -> bool:
    """Expose the real Q2 reader only as an explicit candidate capability."""
    return _candidate_or_persisted_enabled(
        QUESTION_READER_CAPABILITY,
        "LAOJI_VNEXT_Q2_READER_ENABLED",
    )
