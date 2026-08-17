from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import uuid

from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.meeting_action import MeetingActionItem
from app.models.meeting_summary_sync import (
    MeetingSummaryCurrentV1,
    MeetingSummaryOperationV1,
    MeetingSummarySectionStateV1,
    MeetingSummaryVersionV1,
)
from app.models.summary import FinalSummary


MAX_SAFE_INTEGER = 9_007_199_254_740_991


@dataclass(frozen=True)
class MeetingSummaryMutationResult:
    status_code: int
    payload: dict


class MeetingSummaryContractConflict(Exception):
    def __init__(self, code: str, current: dict | None = None, *, status_code: int = 409):
        super().__init__(code)
        self.code = code
        self.current = current
        self.status_code = status_code


def meeting_summary_request_hash(kind: str, identity: str, payload: dict) -> str:
    encoded = json.dumps(
        {"kind": kind, "identity": identity, "payload": payload},
        ensure_ascii=True,
        separators=(",", ":"),
        sort_keys=True,
    ).encode("utf-8")
    return f"sha256:{hashlib.sha256(encoded).hexdigest()}"


def _json(value: object) -> str:
    return json.dumps(value, ensure_ascii=True, separators=(",", ":"), sort_keys=True)


def _parse_json(value: str) -> object:
    return json.loads(value)


def _server_time(value: datetime | None) -> str | None:
    if value is None:
        return None
    aware = value.replace(tzinfo=timezone.utc) if value.tzinfo is None else value.astimezone(timezone.utc)
    return aware.isoformat(timespec="microseconds").replace("+00:00", "Z")


def _time_ms(value: datetime | None) -> int:
    if value is None:
        return 0
    aware = value.replace(tzinfo=timezone.utc) if value.tzinfo is None else value.astimezone(timezone.utc)
    return max(0, min(MAX_SAFE_INTEGER, int(aware.timestamp() * 1000)))


def _document(value: str) -> dict:
    parsed = _parse_json(value)
    if not isinstance(parsed, dict) or parsed.get("schema_version") != 2:
        raise RuntimeError("stored summary document is invalid")
    return parsed


def _section_citation_ids(section: dict) -> list[str]:
    citations = section.get("citations")
    if not isinstance(citations, list):
        return []
    return [
        str(citation.get("id"))
        for citation in citations
        if isinstance(citation, dict) and isinstance(citation.get("id"), str)
    ]


def summary_section_state_payload(state: MeetingSummarySectionStateV1) -> dict:
    visible = _parse_json(state.visible_citation_ids_json)
    if not isinstance(visible, list) or not all(isinstance(item, str) for item in visible):
        raise RuntimeError("stored summary citation visibility is invalid")
    return {
        "schema_version": 1,
        "meeting_id": state.meeting_id,
        "version_id": state.version_id,
        "section_id": state.section_id,
        "stable_key": state.stable_key,
        "ordinal": state.ordinal,
        "revision": state.revision,
        "user_text": state.user_text,
        "visible_citation_ids": visible,
        "client_updated_at_ms": state.client_updated_at_ms,
        "created_at": _server_time(state.created_at),
        "updated_at": _server_time(state.updated_at),
    }


def summary_current_payload(current: MeetingSummaryCurrentV1) -> dict:
    return {
        "schema_version": 1,
        "meeting_id": current.meeting_id,
        "version_id": current.version_id,
        "revision": current.revision,
        "client_updated_at_ms": current.client_updated_at_ms,
        "created_at": _server_time(current.created_at),
        "updated_at": _server_time(current.updated_at),
    }


def summary_version_payload(
    version: MeetingSummaryVersionV1,
    sections: list[MeetingSummarySectionStateV1],
) -> dict:
    return {
        "schema_version": 1,
        "id": version.id,
        "meeting_id": version.meeting_id,
        "status": version.status,
        "template_id": version.template_id,
        "template_revision": version.template_revision,
        "document": _document(version.generated_document_json),
        "sections": [summary_section_state_payload(section) for section in sections],
        "created_at": _server_time(version.created_at),
        "completed_at": _server_time(version.completed_at),
        "updated_at": _server_time(version.updated_at),
    }


def _structured_from_candidate(value: object, meeting_id: str, version_id: str) -> dict | None:
    from app.workers.summary_tasks import structured_summary_from_raw_json

    structured = structured_summary_from_raw_json(value, meeting_id)
    if not structured or structured.get("version_id") != version_id:
        return None
    return structured


def _candidate_summary_paths(summary: FinalSummary) -> list[Path]:
    root = summary.summary_dir
    meeting_id = summary.meeting_id
    paths: list[Path] = []
    for pattern in (
        f"final3_{meeting_id}_*.json",
        f"final_{meeting_id}_*.json",
        f"final3_{meeting_id[:8]}_*.json",
        f"final_{meeting_id[:8]}_*.json",
    ):
        paths.extend(root.glob(pattern))
    return sorted(
        {
            path
            for path in paths
            if not path.name.endswith("_eval.json")
            and not path.name.endswith("_completeness.json")
        },
        key=lambda path: path.stat().st_mtime,
        reverse=True,
    )


def _summary_document(summary: FinalSummary) -> dict:
    direct = _structured_from_candidate(summary.raw_summary_json, summary.meeting_id, summary.id)
    if direct is not None:
        return direct
    for path in _candidate_summary_paths(summary):
        try:
            candidate = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, UnicodeError, json.JSONDecodeError):
            continue
        structured = _structured_from_candidate(candidate, summary.meeting_id, summary.id)
        if structured is not None:
            return structured

    # Old rows did not retain their generated file identity. Materialize a stable,
    # citation-free v2 document instead of binding them to the latest file.
    from app.workers.summary_tasks import build_structured_summary_payload

    generated_at = _server_time(summary.generated_at)
    return build_structured_summary_payload(
        summary.meeting_id,
        summary.overview or "",
        summary.key_decisions,
        summary.action_items,
        version_id=summary.id,
        generated_at=generated_at,
    )


async def _current_is_protected(
    db: AsyncSession,
    *,
    user_id: int,
    current: MeetingSummaryCurrentV1,
) -> bool:
    version = (
        await db.execute(
            select(MeetingSummaryVersionV1).where(
                MeetingSummaryVersionV1.id == current.version_id,
                MeetingSummaryVersionV1.user_id == user_id,
                MeetingSummaryVersionV1.meeting_id == current.meeting_id,
            )
        )
    ).scalar_one_or_none()
    if version is None:
        return True
    document = _document(version.generated_document_json)
    generated_citations = {
        str(section.get("id")): _section_citation_ids(section)
        for section in document.get("sections", [])
        if isinstance(section, dict) and isinstance(section.get("id"), str)
    }
    sections = list(
        (
            await db.execute(
                select(MeetingSummarySectionStateV1).where(
                    MeetingSummarySectionStateV1.user_id == user_id,
                    MeetingSummarySectionStateV1.version_id == current.version_id,
                )
            )
        ).scalars().all()
    )
    for section in sections:
        visible = _parse_json(section.visible_citation_ids_json)
        if section.user_text is not None or visible != generated_citations.get(section.section_id, []):
            return True
    modified_action = (
        await db.execute(
            select(MeetingActionItem.id)
            .where(
                MeetingActionItem.user_id == user_id,
                MeetingActionItem.meeting_id == current.meeting_id,
                MeetingActionItem.source_summary_version_id == current.version_id,
                (
                    (MeetingActionItem.user_edited_at_ms.is_not(None))
                    | (MeetingActionItem.status != "pending")
                ),
            )
            .limit(1)
        )
    ).scalar_one_or_none()
    return modified_action is not None


async def materialize_meeting_summary_versions(
    db: AsyncSession,
    *,
    user_id: int,
    meeting_id: str,
) -> None:
    summaries = list(
        (
            await db.execute(
                select(FinalSummary)
                .where(FinalSummary.meeting_id == meeting_id)
                .order_by(FinalSummary.generated_at, FinalSummary.id)
            )
        ).scalars().all()
    )
    existing_ids = set(
        (
            await db.execute(
                select(MeetingSummaryVersionV1.id).where(
                    MeetingSummaryVersionV1.user_id == user_id,
                    MeetingSummaryVersionV1.meeting_id == meeting_id,
                )
            )
        ).scalars().all()
    )
    current = (
        await db.execute(
            select(MeetingSummaryCurrentV1).where(
                MeetingSummaryCurrentV1.user_id == user_id,
                MeetingSummaryCurrentV1.meeting_id == meeting_id,
            )
        )
    ).scalar_one_or_none()

    for summary in summaries:
        if summary.id in existing_ids:
            continue
        document = _summary_document(summary)
        generated_at = summary.generated_at or datetime.utcnow()
        created_at_raw = document.get("generated_at")
        if isinstance(created_at_raw, str):
            try:
                created_at = datetime.fromisoformat(created_at_raw.replace("Z", "+00:00"))
                if created_at.tzinfo is not None:
                    created_at = created_at.astimezone(timezone.utc).replace(tzinfo=None)
            except ValueError:
                created_at = generated_at
        else:
            created_at = generated_at
        version = MeetingSummaryVersionV1(
            id=summary.id,
            user_id=user_id,
            meeting_id=meeting_id,
            status="ready",
            template_id=str(document.get("template_id") or "legacy")[:80],
            template_revision=max(1, int(document.get("template_revision") or 1)),
            generated_document_json=_json(document),
            created_at=created_at,
            completed_at=generated_at,
            updated_at=datetime.utcnow(),
        )
        db.add(version)
        await db.flush()
        created_at_ms = max(_time_ms(created_at), _time_ms(generated_at))
        for ordinal, section in enumerate(document.get("sections", [])):
            if not isinstance(section, dict):
                continue
            section_id = str(section.get("id") or "").strip()
            stable_key = str(section.get("key") or "").strip()
            if not section_id or not stable_key:
                continue
            db.add(
                MeetingSummarySectionStateV1(
                    user_id=user_id,
                    meeting_id=meeting_id,
                    version_id=summary.id,
                    section_id=section_id,
                    stable_key=stable_key,
                    ordinal=ordinal,
                    revision=1,
                    user_text=None,
                    visible_citation_ids_json=_json(_section_citation_ids(section)),
                    client_updated_at_ms=created_at_ms,
                    created_at=created_at,
                    updated_at=datetime.utcnow(),
                )
            )
        await db.flush()
        await db.execute(
            update(MeetingSummaryVersionV1)
            .where(
                MeetingSummaryVersionV1.user_id == user_id,
                MeetingSummaryVersionV1.meeting_id == meeting_id,
                MeetingSummaryVersionV1.id != summary.id,
                MeetingSummaryVersionV1.status == "ready",
            )
            .values(status="stale", updated_at=datetime.utcnow())
        )
        if current is None:
            current = MeetingSummaryCurrentV1(
                meeting_id=meeting_id,
                user_id=user_id,
                version_id=summary.id,
                revision=1,
                client_updated_at_ms=created_at_ms,
                created_at=created_at,
                updated_at=datetime.utcnow(),
            )
            db.add(current)
        elif not await _current_is_protected(db, user_id=user_id, current=current):
            current.version_id = summary.id
            current.revision += 1
            current.client_updated_at_ms = max(created_at_ms, current.client_updated_at_ms + 1)
            current.updated_at = datetime.utcnow()
        existing_ids.add(summary.id)
        await db.flush()


async def get_meeting_summary_catalog(
    db: AsyncSession,
    *,
    user_id: int,
    meeting_id: str,
) -> dict:
    await materialize_meeting_summary_versions(
        db,
        user_id=user_id,
        meeting_id=meeting_id,
    )
    versions = list(
        (
            await db.execute(
                select(MeetingSummaryVersionV1)
                .where(
                    MeetingSummaryVersionV1.user_id == user_id,
                    MeetingSummaryVersionV1.meeting_id == meeting_id,
                )
                .order_by(MeetingSummaryVersionV1.created_at.desc(), MeetingSummaryVersionV1.id.desc())
                .limit(50)
            )
        ).scalars().all()
    )
    version_ids = [version.id for version in versions]
    section_rows = [] if not version_ids else list(
        (
            await db.execute(
                select(MeetingSummarySectionStateV1)
                .where(
                    MeetingSummarySectionStateV1.user_id == user_id,
                    MeetingSummarySectionStateV1.version_id.in_(version_ids),
                )
                .order_by(
                    MeetingSummarySectionStateV1.version_id,
                    MeetingSummarySectionStateV1.ordinal,
                    MeetingSummarySectionStateV1.section_id,
                )
            )
        ).scalars().all()
    )
    by_version: dict[str, list[MeetingSummarySectionStateV1]] = {}
    for section in section_rows:
        by_version.setdefault(section.version_id, []).append(section)
    current = (
        await db.execute(
            select(MeetingSummaryCurrentV1).where(
                MeetingSummaryCurrentV1.user_id == user_id,
                MeetingSummaryCurrentV1.meeting_id == meeting_id,
            )
        )
    ).scalar_one_or_none()
    return {
        "schema_version": 1,
        "meeting_id": meeting_id,
        "current": summary_current_payload(current) if current is not None else None,
        "items": [summary_version_payload(version, by_version.get(version.id, [])) for version in versions],
    }


async def _operation_replay(
    db: AsyncSession,
    *,
    user_id: int,
    idempotency_key: str,
    request_hash: str,
) -> MeetingSummaryMutationResult | None:
    operation = (
        await db.execute(
            select(MeetingSummaryOperationV1).where(
                MeetingSummaryOperationV1.user_id == user_id,
                MeetingSummaryOperationV1.idempotency_key == idempotency_key,
            )
        )
    ).scalar_one_or_none()
    if operation is None:
        return None
    if operation.request_hash != request_hash:
        raise MeetingSummaryContractConflict("idempotency_key_reused")
    return MeetingSummaryMutationResult(
        operation.response_status,
        json.loads(operation.response_json),
    )


async def _save_operation(
    db: AsyncSession,
    *,
    user_id: int,
    meeting_id: str,
    aggregate_id: str,
    operation_kind: str,
    idempotency_key: str,
    request_hash: str,
    result: MeetingSummaryMutationResult,
) -> None:
    db.add(
        MeetingSummaryOperationV1(
            id=str(uuid.uuid4()),
            user_id=user_id,
            meeting_id=meeting_id,
            aggregate_id=aggregate_id,
            operation_kind=operation_kind,
            idempotency_key=idempotency_key,
            request_hash=request_hash,
            response_status=result.status_code,
            response_json=_json(result.payload),
            created_at=datetime.utcnow(),
        )
    )
    await db.flush()


async def update_summary_section_state(
    db: AsyncSession,
    *,
    user_id: int,
    version_id: str,
    section_id: str,
    expected_revision: int,
    idempotency_key: str,
    request_hash: str,
    mutation: dict,
) -> MeetingSummaryMutationResult:
    replay = await _operation_replay(
        db,
        user_id=user_id,
        idempotency_key=idempotency_key,
        request_hash=request_hash,
    )
    if replay is not None:
        return replay
    version = (
        await db.execute(
            select(MeetingSummaryVersionV1).where(
                MeetingSummaryVersionV1.id == version_id,
                MeetingSummaryVersionV1.user_id == user_id,
            )
        )
    ).scalar_one_or_none()
    if version is None:
        raise LookupError("summary_version_missing")
    state = (
        await db.execute(
            select(MeetingSummarySectionStateV1).where(
                MeetingSummarySectionStateV1.user_id == user_id,
                MeetingSummarySectionStateV1.version_id == version_id,
                MeetingSummarySectionStateV1.section_id == section_id,
            )
        )
    ).scalar_one_or_none()
    if state is None:
        raise LookupError("summary_section_missing")
    if state.revision != expected_revision:
        raise MeetingSummaryContractConflict(
            "revision_conflict",
            summary_section_state_payload(state),
            status_code=412,
        )
    document = _document(version.generated_document_json)
    generated_section = next(
        (
            item
            for item in document.get("sections", [])
            if isinstance(item, dict) and item.get("id") == section_id
        ),
        None,
    )
    if generated_section is None:
        raise RuntimeError("summary section generated identity is missing")
    generated_citation_ids = _section_citation_ids(generated_section)
    requested_citation_ids = mutation["visible_citation_ids"]
    if (
        len(set(requested_citation_ids)) != len(requested_citation_ids)
        or any(item not in generated_citation_ids for item in requested_citation_ids)
    ):
        raise ValueError("summary citation visibility is invalid")
    visible_set = set(requested_citation_ids)
    normalized_visible = [item for item in generated_citation_ids if item in visible_set]
    user_text = mutation["user_text"]
    if user_text is not None:
        user_text = user_text.replace("\r\n", "\n").replace("\r", "\n").strip()
        if not user_text or len(user_text) > 20_000 or "\x00" in user_text:
            raise ValueError("summary section text is invalid")
        generated_text = str(generated_section.get("content") or "").strip()
        if user_text == generated_text:
            user_text = None
    current_visible = _parse_json(state.visible_citation_ids_json)
    if state.user_text == user_text and current_visible == normalized_visible:
        result = MeetingSummaryMutationResult(200, summary_section_state_payload(state))
    else:
        state.revision += 1
        state.user_text = user_text
        state.visible_citation_ids_json = _json(normalized_visible)
        state.client_updated_at_ms = mutation["client_updated_at_ms"]
        state.updated_at = datetime.utcnow()
        await db.flush()
        result = MeetingSummaryMutationResult(200, summary_section_state_payload(state))
    await _save_operation(
        db,
        user_id=user_id,
        meeting_id=version.meeting_id,
        aggregate_id=f"{version_id}:{section_id}",
        operation_kind="section_override",
        idempotency_key=idempotency_key,
        request_hash=request_hash,
        result=result,
    )
    return result


async def select_current_summary_version(
    db: AsyncSession,
    *,
    user_id: int,
    meeting_id: str,
    expected_revision: int,
    idempotency_key: str,
    request_hash: str,
    mutation: dict,
) -> MeetingSummaryMutationResult:
    replay = await _operation_replay(
        db,
        user_id=user_id,
        idempotency_key=idempotency_key,
        request_hash=request_hash,
    )
    if replay is not None:
        return replay
    target = (
        await db.execute(
            select(MeetingSummaryVersionV1).where(
                MeetingSummaryVersionV1.id == mutation["version_id"],
                MeetingSummaryVersionV1.user_id == user_id,
                MeetingSummaryVersionV1.meeting_id == meeting_id,
                MeetingSummaryVersionV1.status.in_(("ready", "stale")),
            )
        )
    ).scalar_one_or_none()
    if target is None:
        raise LookupError("summary_version_missing")
    current = (
        await db.execute(
            select(MeetingSummaryCurrentV1).where(
                MeetingSummaryCurrentV1.user_id == user_id,
                MeetingSummaryCurrentV1.meeting_id == meeting_id,
            )
        )
    ).scalar_one_or_none()
    if current is None:
        raise LookupError("summary_current_missing")
    if current.revision != expected_revision:
        raise MeetingSummaryContractConflict(
            "revision_conflict",
            summary_current_payload(current),
            status_code=412,
        )
    if current.version_id != target.id:
        current.version_id = target.id
        current.revision += 1
        current.client_updated_at_ms = mutation["client_updated_at_ms"]
        current.updated_at = datetime.utcnow()
        await db.flush()
    result = MeetingSummaryMutationResult(200, summary_current_payload(current))
    await _save_operation(
        db,
        user_id=user_id,
        meeting_id=meeting_id,
        aggregate_id=meeting_id,
        operation_kind="select_version",
        idempotency_key=idempotency_key,
        request_hash=request_hash,
        result=result,
    )
    return result


async def get_effective_current_summary_document(
    db: AsyncSession,
    *,
    user_id: int,
    meeting_id: str,
) -> tuple[MeetingSummaryVersionV1, dict] | None:
    await materialize_meeting_summary_versions(db, user_id=user_id, meeting_id=meeting_id)
    current = (
        await db.execute(
            select(MeetingSummaryCurrentV1).where(
                MeetingSummaryCurrentV1.user_id == user_id,
                MeetingSummaryCurrentV1.meeting_id == meeting_id,
            )
        )
    ).scalar_one_or_none()
    if current is None:
        return None
    version = (
        await db.execute(
            select(MeetingSummaryVersionV1).where(
                MeetingSummaryVersionV1.id == current.version_id,
                MeetingSummaryVersionV1.user_id == user_id,
                MeetingSummaryVersionV1.meeting_id == meeting_id,
            )
        )
    ).scalar_one_or_none()
    if version is None:
        return None
    states = list(
        (
            await db.execute(
                select(MeetingSummarySectionStateV1).where(
                    MeetingSummarySectionStateV1.user_id == user_id,
                    MeetingSummarySectionStateV1.version_id == version.id,
                )
            )
        ).scalars().all()
    )
    by_id = {state.section_id: state for state in states}
    document = _document(version.generated_document_json)
    effective_sections = []
    for generated in document.get("sections", []):
        if not isinstance(generated, dict):
            continue
        section = dict(generated)
        state = by_id.get(str(section.get("id") or ""))
        if state is not None:
            visible = set(_parse_json(state.visible_citation_ids_json))
            section["content"] = state.user_text if state.user_text is not None else section.get("content", "")
            section["citations"] = [
                citation
                for citation in section.get("citations", [])
                if isinstance(citation, dict) and citation.get("id") in visible
            ]
            section["user_edited"] = state.user_text is not None or len(visible) != len(_section_citation_ids(generated))
            section["user_edited_at_ms"] = state.client_updated_at_ms if section["user_edited"] else None
        effective_sections.append(section)
    document = {**document, "status": version.status, "sections": effective_sections}
    return version, document
