from __future__ import annotations

import base64
import json
import re
import shutil
import unicodedata
from datetime import datetime, timezone
from typing import Literal

from fastapi import APIRouter, Depends, Header, HTTPException, Query
from fastapi.responses import JSONResponse
from pydantic import BaseModel, ConfigDict, Field, model_validator
from sqlalchemy import and_, or_, select
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import get_db
from app.config import settings
from app.laoji.auth_router import get_current_user
from app.models.meeting import Meeting
from app.models.meeting_action import MeetingActionItem
from app.models.meeting_action_share import (
    MeetingActionCollaborationEvent,
    MeetingActionCollaborationOperation,
    MeetingActionShare,
)
from app.models.meeting_content_share import MeetingContentShare, MeetingContentShareOperation
from app.models.meeting_manual_note import MeetingManualNote, MeetingManualNoteOperation
from app.models.meeting_attachment import MeetingAttachmentOperationV1, MeetingAttachmentV1
from app.models.meeting_marker import MeetingMarkerOperationV1, MeetingMarkerV1
from app.models.meeting_summary_sync import (
    MeetingSummaryCurrentV1,
    MeetingSummaryOperationV1,
    MeetingSummarySectionStateV1,
    MeetingSummaryVersionV1,
)
from app.models.meeting_tag_catalog import MeetingTagCatalogOperationV1, MeetingTagCatalogV1
from app.models.meeting_note_root import MeetingNoteRootOperationV2, MeetingNoteRootV2
from app.models.meeting_question import (
    MeetingQuestionCitation,
    MeetingQuestionThread,
    MeetingQuestionTurn,
)
from app.models.meeting_recording_asset import (
    MeetingMediaClipJobV1,
    MeetingRecordingAssetOperationV2,
    MeetingRecordingAssetV2,
    MeetingRecordingTranscriptionJobV2,
)
from app.services.meeting_recording_asset_service import (
    MEDIA_CLIP_ADJUSTMENT_STEP_MS,
    MEDIA_CLIP_MAXIMUM_DURATION_MS,
    MEDIA_CLIP_MINIMUM_DURATION_MS,
)
from app.models.meeting_occurrence import (
    MeetingOccurrenceLink,
    MeetingOccurrenceOperation,
    MeetingScheduleSnapshotV2,
)
from app.services.account_deletion_service import is_user_meeting_tombstoned
from app.services.meeting_action_service import (
    ActionContractConflict,
    action_request_hash,
    action_payload,
    upsert_meeting_action,
)
from app.services.meeting_action_collaboration_service import (
    CollaborationConfigurationError,
    CollaborationConflict,
    action_collaboration_configured,
    collaboration_request_hash,
    create_action_share,
    find_share_by_token,
    revoke_action_share,
    shared_action_payload,
    update_shared_action,
)
from app.services.meeting_manual_note_service import (
    ManualNoteContractConflict,
    find_manual_note,
    manual_note_payload,
    manual_note_request_hash,
    missing_manual_note_payload,
    upsert_meeting_manual_note,
)
from app.services.meeting_content_share_service import (
    MeetingContentShareConfigurationError,
    MeetingContentShareConflict,
    create_meeting_content_share,
    find_meeting_content_share_by_token,
    meeting_content_share_configured,
    meeting_content_share_request_hash,
    owner_share_payload_with_invite,
    public_share_payload,
    revoke_meeting_content_share,
)
from app.services.meeting_tag_catalog_service import (
    MeetingTagCatalogConflict,
    find_meeting_tag_catalog,
    meeting_tag_catalog_payload,
    meeting_tag_catalog_request_hash,
    missing_meeting_tag_catalog_payload,
    replace_meeting_tag_catalog,
)
from app.services.meeting_note_root_service import (
    MEETING_NOTE_SOFT_DELETE_DAYS,
    MeetingNoteRootConflict,
    create_meeting_note_root,
    find_meeting_note_root,
    meeting_note_root_payload,
    meeting_note_root_request_hash,
    mutate_meeting_note_root,
)
from app.services.meeting_occurrence_service import (
    OccurrenceContractConflict,
    find_occurrence_by_identity,
    find_occurrence_by_meeting,
    missing_occurrence_payload,
    occurrence_payload_for_link,
    occurrence_request_hash,
    upsert_meeting_occurrence,
)
from app.services.meeting_speaker_service import (
    SpeakerContractConflict,
    correction_payload,
    find_speaker_correction,
    retry_profile_sample,
    schedule_profile_sample_update,
    speaker_correction_request_hash,
    speaker_schema_ready,
    submit_speaker_correction,
)


router = APIRouter()

_MAX_SAFE_INTEGER = 9_007_199_254_740_991
_IDENTIFIER_RE = re.compile(r"^[^\x00-\x1f\x7f]+$")
_ACTION_CURSOR_VERSION = 1
_MEETING_ROOT_CURSOR_VERSION = 1


class ActionItemV2Upsert(BaseModel):
    model_config = ConfigDict(extra="forbid")

    schema_version: Literal[2]
    client_action_id: str = Field(min_length=1, max_length=512)
    remote_id: str | None = Field(default=None, max_length=160)
    client_created_at_ms: int = Field(ge=0, le=_MAX_SAFE_INTEGER)
    client_updated_at_ms: int = Field(ge=0, le=_MAX_SAFE_INTEGER)
    user_edited_at_ms: int | None = Field(default=None, ge=0, le=_MAX_SAFE_INTEGER)
    completed_at_ms: int | None = Field(default=None, ge=0, le=_MAX_SAFE_INTEGER)
    content: str = Field(min_length=1, max_length=20_000)
    status: Literal["pending", "completed", "dismissed"]
    assignee: str | None = Field(default=None, max_length=500)
    due_at_ms: int | None = Field(default=None, ge=0, le=_MAX_SAFE_INTEGER)
    reminder_at_ms: int | None = Field(default=None, ge=0, le=_MAX_SAFE_INTEGER)
    followup_event_source_id: str | None = Field(default=None, max_length=512)
    source_kind: Literal["generated", "manual", "marker"]
    source_summary_version_id: str | None = Field(default=None, max_length=512)
    source_segment_id: str | None = Field(default=None, max_length=512)
    source_start_ms: int | None = Field(default=None, ge=0, le=_MAX_SAFE_INTEGER)
    generation_fingerprint: str | None = Field(default=None, max_length=512)

    @model_validator(mode="after")
    def validate_state(self):
        if self.client_created_at_ms > self.client_updated_at_ms:
            raise ValueError("行动项创建时间不能晚于更新时间")
        if (
            self.user_edited_at_ms is not None
            and self.user_edited_at_ms > self.client_updated_at_ms
        ):
            raise ValueError("行动项编辑时间不能晚于更新时间")
        if (self.status == "completed") != (self.completed_at_ms is not None):
            raise ValueError("行动项完成状态与完成时间不一致")
        if self.completed_at_ms is not None and not (
            self.client_created_at_ms
            <= self.completed_at_ms
            <= self.client_updated_at_ms
        ):
            raise ValueError("行动项完成时间不在有效范围内")
        if self.status != "pending" and self.reminder_at_ms is not None:
            raise ValueError("已完成或已忽略的行动项不能保留提醒")
        if self.reminder_at_ms is not None and self.due_at_ms is None:
            raise ValueError("行动项提醒需要截止时间")
        if self.source_kind != "generated" and self.generation_fingerprint is not None:
            raise ValueError("手动行动项不能包含生成身份")
        return self


class ActionShareV1Create(BaseModel):
    model_config = ConfigDict(extra="forbid")

    schema_version: Literal[1]
    client_share_id: str = Field(min_length=1, max_length=512)
    permission: Literal["viewer", "action_editor"]


class SharedActionV1Update(BaseModel):
    model_config = ConfigDict(extra="forbid")

    schema_version: Literal[1]
    actor_id: str = Field(min_length=16, max_length=160)
    status: Literal["pending", "completed", "dismissed"]
    assignee: str | None = Field(default=None, max_length=500)
    due_at_ms: int | None = Field(default=None, ge=0, le=_MAX_SAFE_INTEGER)


MeetingContentShareKey = Literal[
    "info",
    "summary",
    "actions",
    "transcript",
    "markers",
    "attachments",
    "manualNote",
]


class MeetingContentShareSectionV1(BaseModel):
    model_config = ConfigDict(extra="forbid")

    key: MeetingContentShareKey
    title: str = Field(min_length=1, max_length=80)
    content: str = Field(min_length=1, max_length=200_000)


class MeetingContentShareSnapshotV1(BaseModel):
    model_config = ConfigDict(extra="forbid")

    schema_version: Literal[1]
    sections: list[MeetingContentShareSectionV1] = Field(min_length=1, max_length=7)
    source_summary_version_id: str | None = Field(default=None, max_length=512)

    @model_validator(mode="after")
    def validate_sections(self):
        keys = [section.key for section in self.sections]
        if len(set(keys)) != len(keys):
            raise ValueError("共享内容存在重复项")
        return self


class MeetingContentShareV1Create(BaseModel):
    model_config = ConfigDict(extra="forbid")

    schema_version: Literal[1]
    client_share_id: str = Field(min_length=1, max_length=512)
    content_scope: list[MeetingContentShareKey] = Field(min_length=1, max_length=7)
    frozen_payload: MeetingContentShareSnapshotV1
    follow_latest_summary: bool = False

    @model_validator(mode="after")
    def validate_scope(self):
        if len(set(self.content_scope)) != len(self.content_scope):
            raise ValueError("共享范围存在重复项")
        snapshot_keys = [section.key for section in self.frozen_payload.sections]
        if snapshot_keys != self.content_scope:
            raise ValueError("共享范围与冻结内容不一致")
        if self.follow_latest_summary and "summary" not in self.content_scope:
            raise ValueError("跟随最新整理结果需要包含整理结果")
        return self


class ManualNoteV2Upsert(BaseModel):
    model_config = ConfigDict(extra="forbid")

    schema_version: Literal[2]
    client_note_revision: int = Field(ge=1, le=_MAX_SAFE_INTEGER)
    client_updated_at_ms: int = Field(ge=0, le=_MAX_SAFE_INTEGER)
    user_edited_at_ms: int | None = Field(default=None, ge=0, le=_MAX_SAFE_INTEGER)
    content: str = Field(max_length=200_000)

    @model_validator(mode="after")
    def validate_state(self):
        if (
            self.user_edited_at_ms is not None
            and self.user_edited_at_ms > self.client_updated_at_ms
        ):
            raise ValueError("笔记编辑时间不能晚于更新时间")
        return self


class MeetingTagV1Item(BaseModel):
    model_config = ConfigDict(extra="forbid")

    client_tag_id: str = Field(min_length=1, max_length=160)
    name: str = Field(min_length=1, max_length=120)
    created_at_ms: int = Field(ge=0, le=_MAX_SAFE_INTEGER)
    updated_at_ms: int = Field(ge=0, le=_MAX_SAFE_INTEGER)

    @model_validator(mode="after")
    def validate_state(self):
        if self.updated_at_ms < self.created_at_ms:
            raise ValueError("标签更新时间不能早于创建时间")
        return self


class MeetingTagAssignmentV1Item(BaseModel):
    model_config = ConfigDict(extra="forbid")

    meeting_remote_id: str = Field(min_length=1, max_length=160)
    client_tag_ids: list[str] = Field(default_factory=list, max_length=20)


class MeetingTagCatalogV1Replace(BaseModel):
    model_config = ConfigDict(extra="forbid")

    schema_version: Literal[1]
    client_updated_at_ms: int = Field(ge=0, le=_MAX_SAFE_INTEGER)
    tags: list[MeetingTagV1Item] = Field(default_factory=list, max_length=100)
    assignments: list[MeetingTagAssignmentV1Item] = Field(
        default_factory=list,
        max_length=5_000,
    )

    @model_validator(mode="after")
    def validate_state(self):
        tag_ids = [item.client_tag_id.strip() for item in self.tags]
        meeting_ids = [item.meeting_remote_id.strip() for item in self.assignments]
        if len(set(tag_ids)) != len(tag_ids):
            raise ValueError("标签标识存在重复项")
        if len(set(meeting_ids)) != len(meeting_ids):
            raise ValueError("会议标签分配存在重复项")
        known_tags = set(tag_ids)
        for assignment in self.assignments:
            assigned = [item.strip() for item in assignment.client_tag_ids]
            if len(set(assigned)) != len(assigned) or any(item not in known_tags for item in assigned):
                raise ValueError("会议标签分配引用无效")
        return self


class ScheduleSnapshotV2Upsert(BaseModel):
    model_config = ConfigDict(extra="forbid")

    event_title: str = Field(max_length=20_000)
    planned_start_ms: int | None = Field(default=None, ge=0, le=_MAX_SAFE_INTEGER)
    planned_end_ms: int | None = Field(default=None, ge=0, le=_MAX_SAFE_INTEGER)
    all_day: bool
    timezone_id: str | None = Field(default=None, max_length=160)
    location: str | None = Field(default=None, max_length=2_000)
    participants: list[str] = Field(default_factory=list, max_length=500)
    description: str | None = Field(default=None, max_length=100_000)
    captured_event_revision: int | None = Field(default=None, ge=0, le=_MAX_SAFE_INTEGER)
    captured_at_ms: int = Field(ge=0, le=_MAX_SAFE_INTEGER)

    @model_validator(mode="after")
    def validate_state(self):
        if (
            self.planned_start_ms is not None
            and self.planned_end_ms is not None
            and self.planned_end_ms < self.planned_start_ms
        ):
            raise ValueError("日程计划结束时间不能早于开始时间")
        if any(
            not item.strip() or len(item) > 1_000 or "\x00" in item
            for item in self.participants
        ):
            raise ValueError("日程参与人无效")
        return self


class OccurrenceLinkV2Upsert(BaseModel):
    model_config = ConfigDict(extra="forbid")

    schema_version: Literal[2]
    source_event_id: str = Field(min_length=1, max_length=512)
    occurrence_date: str = Field(min_length=10, max_length=10)
    calendar_revision: int | None = Field(default=None, ge=0, le=_MAX_SAFE_INTEGER)
    recurrence_segment_id: str | None = Field(default=None, max_length=512)
    series_key: str | None = Field(default=None, max_length=512)
    link_state: Literal["active", "orphaned"]
    client_updated_at_ms: int = Field(ge=0, le=_MAX_SAFE_INTEGER)
    schedule_snapshot: ScheduleSnapshotV2Upsert


class MeetingNoteV2OccurrenceRef(BaseModel):
    model_config = ConfigDict(extra="forbid")

    source_event_id: str = Field(min_length=1, max_length=512)
    occurrence_date: str = Field(min_length=10, max_length=10)
    calendar_revision: int | None = Field(default=None, ge=0, le=_MAX_SAFE_INTEGER)
    recurrence_segment_id: str | None = Field(default=None, max_length=512)
    series_key: str | None = Field(default=None, max_length=512)


class MeetingNoteV2Create(BaseModel):
    model_config = ConfigDict(extra="forbid")

    schema_version: Literal[2]
    client_note_id: str = Field(min_length=1, max_length=160)
    client_request_id: str | None = Field(
        default=None,
        min_length=8,
        max_length=96,
        pattern=r"^[A-Za-z0-9][A-Za-z0-9._:-]+$",
    )
    origin: Literal["calendar", "ad_hoc", "file_import", "share_intent"]
    entry_point: Literal[
        "calendar_detail",
        "notification",
        "widget",
        "meeting_tab",
        "quick_tile",
        "document_picker",
        "share_intent",
        "legacy_store",
        "recorder_recovery",
    ] | None = None
    title: str = Field(max_length=255)
    description: str | None = Field(default=None, max_length=100_000)
    participants: list[str] = Field(default_factory=list, max_length=500)
    location: str | None = Field(default=None, max_length=500)
    mode: Literal["realtime", "offline", "whisper", "qwen"] = "realtime"
    recorded_at: datetime | None = None
    occurrence_ref: MeetingNoteV2OccurrenceRef | None = None
    schedule_snapshot: ScheduleSnapshotV2Upsert | None = None
    supersedes_meeting_id: str | None = Field(default=None, min_length=1, max_length=160)

    @model_validator(mode="after")
    def validate_context(self):
        has_occurrence = self.occurrence_ref is not None
        if has_occurrence != (self.schedule_snapshot is not None):
            raise ValueError("日程关联与记录时计划必须同时提供")
        if self.origin == "calendar" and not has_occurrence:
            raise ValueError("日程来源的会议必须包含日程实例")
        if self.origin != "calendar" and has_occurrence:
            raise ValueError("非日程来源的会议不能包含日程实例")
        if self.supersedes_meeting_id is not None and not has_occurrence:
            raise ValueError("接替已删除会议时必须包含日程实例")
        if any(
            not item.strip() or len(item) > 1_000 or "\x00" in item
            for item in self.participants
        ):
            raise ValueError("会议参与人无效")
        return self


class MeetingNoteV2Update(BaseModel):
    model_config = ConfigDict(extra="forbid")

    schema_version: Literal[2]
    title: str | None = Field(default=None, max_length=255)
    description: str | None = Field(default=None, max_length=100_000)
    participants: list[str] | None = Field(default=None, max_length=500)
    location: str | None = Field(default=None, max_length=500)
    mode: Literal["realtime", "offline", "whisper", "qwen"] | None = None
    status: str | None = Field(default=None, min_length=1, max_length=160)
    recorded_at: datetime | None = None

    @model_validator(mode="after")
    def validate_changes(self):
        fields = self.model_fields_set - {"schema_version"}
        if not fields:
            raise ValueError("会议修改内容为空")
        labels = {
            "title": "标题",
            "participants": "参与人",
            "mode": "录制模式",
            "status": "状态",
        }
        for field_name, label in labels.items():
            if field_name in fields and getattr(self, field_name) is None:
                raise ValueError(f"会议{label}不能清空")
        if self.participants is not None and any(
            not item.strip() or len(item) > 1_000 or "\x00" in item
            for item in self.participants
        ):
            raise ValueError("会议参与人无效")
        return self


class SpeakerCorrectionV2Mutation(BaseModel):
    model_config = ConfigDict(extra="forbid")

    schema_version: Literal[2]
    client_request_id: str = Field(min_length=1, max_length=512)
    transcript_revision_id: str = Field(min_length=1, max_length=512)
    scope: Literal["segment", "cluster", "future_profile"]
    segment_ids: list[str] = Field(min_length=1, max_length=10_000)
    cluster_id: str | None = Field(default=None, max_length=512)
    speaker_profile_id: str | None = Field(default=None, max_length=160)
    display_name: str = Field(min_length=1, max_length=120)
    consent_to_profile_update: bool
    base_revision: int = Field(ge=0, le=_MAX_SAFE_INTEGER)

    @model_validator(mode="after")
    def validate_scope(self):
        if len(set(self.segment_ids)) != len(self.segment_ids):
            raise ValueError("讲话人片段不能重复")
        if any(
            not item.strip() or len(item) > 512 or not _IDENTIFIER_RE.fullmatch(item.strip())
            for item in self.segment_ids
        ):
            raise ValueError("讲话人片段标识无效")
        if self.scope != "segment" and not (self.cluster_id or "").strip():
            raise ValueError("讲话人簇标识不能为空")
        if self.scope == "future_profile":
            if not (self.speaker_profile_id or "").strip() or not self.consent_to_profile_update:
                raise ValueError("关联讲话人资料需要明确同意")
        elif self.speaker_profile_id is not None or self.consent_to_profile_update:
            raise ValueError("本场修改不能更新讲话人资料")
        return self


def _identifier(value: str, label: str, *, minimum: int = 1, maximum: int = 512) -> str:
    normalized = value.strip()
    if (
        len(normalized) < minimum
        or len(normalized) > maximum
        or not _IDENTIFIER_RE.fullmatch(normalized)
    ):
        raise HTTPException(status_code=422, detail=f"{label}无效")
    return normalized


def _precondition(if_match: str | None, if_none_match: str | None) -> tuple[str, int | None]:
    if if_match is not None and if_none_match is not None:
        raise HTTPException(status_code=400, detail="行动项版本条件不能同时指定")
    if if_none_match is not None:
        if if_none_match.strip() != "*":
            raise HTTPException(status_code=400, detail="行动项新建条件无效")
        return "create", None
    if if_match is None:
        raise HTTPException(status_code=428, detail="缺少行动项版本条件")
    raw = if_match.strip()
    if raw.startswith("W/"):
        raw = raw[2:].strip()
    if len(raw) >= 2 and raw[0] == raw[-1] == '"':
        raw = raw[1:-1]
    if not raw.isdigit():
        raise HTTPException(status_code=400, detail="行动项版本条件无效")
    revision = int(raw)
    if revision > _MAX_SAFE_INTEGER:
        raise HTTPException(status_code=400, detail="行动项版本条件无效")
    return "update", revision


def _conflict_response(error: ActionContractConflict) -> JSONResponse:
    messages = {
        "idempotency_key_reused": "同一请求标识已用于其他行动项修改",
        "action_already_exists": "行动项已在云端存在",
        "action_missing": "行动项在云端不存在",
        "revision_conflict": "行动项云端版本已变化",
        "remote_identity_mismatch": "行动项云端身份不一致",
        "action_identity_mismatch": "行动项来源身份不一致",
        "action_clock_regression": "行动项更新时间不能倒退",
        "action_clock_not_advanced": "行动项修改后需要推进更新时间",
    }
    current = error.current
    revision = current.get("revision") if isinstance(current, dict) else None
    headers = {"ETag": f'"{revision}"'} if isinstance(revision, int) else None
    return JSONResponse(
        status_code=error.status_code,
        headers=headers,
        content={
            "error": {
                "code": error.code,
                "message": messages.get(error.code, "行动项同步冲突"),
            },
            "current": current,
            "revision": revision,
        },
    )


def _collaboration_revision(if_match: str | None, label: str) -> int:
    if if_match is None:
        raise HTTPException(status_code=428, detail=f"缺少{label}版本条件")
    raw = if_match.strip()
    if raw.startswith("W/"):
        raw = raw[2:].strip()
    if len(raw) >= 2 and raw[0] == raw[-1] == '"':
        raw = raw[1:-1]
    if not raw.isdigit():
        raise HTTPException(status_code=400, detail=f"{label}版本条件无效")
    value = int(raw)
    if value < 1 or value > _MAX_SAFE_INTEGER:
        raise HTTPException(status_code=400, detail=f"{label}版本条件无效")
    return value


def _collaboration_conflict_response(error: CollaborationConflict) -> JSONResponse:
    messages = {
        "idempotency_key_reused": "同一请求标识已用于其他协作修改",
        "action_revision_conflict": "待办事项云端版本已变化",
        "share_already_exists": "这条共享链接已创建",
        "share_revision_conflict": "共享设置云端版本已变化",
        "share_not_active": "共享链接已不可用",
        "share_revoked": "共享链接已撤销",
        "share_read_only": "此链接只有查看权限",
    }
    return JSONResponse(
        status_code=error.status_code,
        content={
            "error": {
                "code": error.code,
                "message": messages.get(error.code, "待办协作版本冲突"),
            },
            "current": error.current,
        },
    )


def _meeting_content_share_conflict_response(
    error: MeetingContentShareConflict,
) -> JSONResponse:
    messages = {
        "idempotency_key_reused": "同一请求标识已用于其他共享操作",
        "share_already_exists": "这条共享链接已创建",
        "share_revision_conflict": "共享设置云端版本已变化",
        "share_not_active": "共享链接已不可用",
        "share_missing": "共享链接已不存在",
    }
    return JSONResponse(
        status_code=error.status_code,
        content={
            "error": {
                "code": error.code,
                "message": messages.get(error.code, "共享链接版本冲突"),
            },
            "current": error.current,
        },
    )


def _manual_note_precondition(
    if_match: str | None,
    if_none_match: str | None,
) -> tuple[str, int | None]:
    if if_match is not None and if_none_match is not None:
        raise HTTPException(status_code=400, detail="笔记版本条件不能同时指定")
    if if_none_match is not None:
        if if_none_match.strip() != "*":
            raise HTTPException(status_code=400, detail="笔记新建条件无效")
        return "create", None
    if if_match is None:
        raise HTTPException(status_code=428, detail="缺少笔记版本条件")
    raw = if_match.strip()
    if raw.startswith("W/"):
        raw = raw[2:].strip()
    if len(raw) >= 2 and raw[0] == raw[-1] == '"':
        raw = raw[1:-1]
    if not raw.isdigit():
        raise HTTPException(status_code=400, detail="笔记版本条件无效")
    revision = int(raw)
    if revision < 1 or revision > _MAX_SAFE_INTEGER:
        raise HTTPException(status_code=400, detail="笔记版本条件无效")
    return "update", revision


def _manual_note_conflict_response(error: ManualNoteContractConflict) -> JSONResponse:
    messages = {
        "idempotency_key_reused": "同一请求标识已用于其他笔记修改",
        "manual_note_already_exists": "云端已存在这份笔记",
        "manual_note_missing": "云端不存在这份笔记",
        "revision_conflict": "笔记云端版本已变化",
        "manual_note_clock_regression": "笔记更新时间不能倒退",
        "manual_note_clock_not_advanced": "笔记修改后需要推进更新时间",
    }
    current = error.current
    revision = current.get("revision") if isinstance(current, dict) else None
    headers = {"ETag": f'"{revision}"'} if isinstance(revision, int) else None
    return JSONResponse(
        status_code=error.status_code,
        headers=headers,
        content={
            "error": {
                "code": error.code,
                "message": messages.get(error.code, "笔记同步冲突"),
            },
            "current": current,
            "revision": revision,
        },
    )


def _meeting_tag_catalog_precondition(
    if_match: str | None,
    if_none_match: str | None,
) -> tuple[str, int | None]:
    if if_match is not None and if_none_match is not None:
        raise HTTPException(status_code=400, detail="标签版本条件不能同时指定")
    if if_none_match is not None:
        if if_none_match.strip() != "*":
            raise HTTPException(status_code=400, detail="标签新建条件无效")
        return "create", None
    if if_match is None:
        raise HTTPException(status_code=428, detail="缺少标签版本条件")
    raw = if_match.strip()
    if raw.startswith("W/"):
        raw = raw[2:].strip()
    if len(raw) >= 2 and raw[0] == raw[-1] == '"':
        raw = raw[1:-1]
    if not raw.isdigit():
        raise HTTPException(status_code=400, detail="标签版本条件无效")
    revision = int(raw)
    if revision < 1 or revision > _MAX_SAFE_INTEGER:
        raise HTTPException(status_code=400, detail="标签版本条件无效")
    return "update", revision


def _meeting_tag_catalog_conflict_response(
    error: MeetingTagCatalogConflict,
) -> JSONResponse:
    messages = {
        "idempotency_key_reused": "同一请求标识已用于其他标签修改",
        "catalog_already_exists": "云端已存在标签数据",
        "catalog_missing": "云端标签数据不存在",
        "revision_conflict": "标签云端版本已变化",
    }
    current = error.current
    revision = current.get("revision") if isinstance(current, dict) else None
    headers = {"ETag": f'"{revision}"'} if isinstance(revision, int) else None
    return JSONResponse(
        status_code=error.status_code,
        headers=headers,
        content={
            "error": {
                "code": error.code,
                "message": messages.get(error.code, "标签同步冲突"),
            },
            "current": current,
            "revision": revision,
        },
    )


def _meeting_tag_name(value: str) -> str:
    normalized = " ".join(unicodedata.normalize("NFKC", value).split())
    if (
        not normalized
        or len(normalized) > 30
        or any(ord(character) < 32 or ord(character) == 127 for character in normalized)
    ):
        raise HTTPException(status_code=422, detail="标签名称需为 1 至 30 个字符")
    return normalized


def _occurrence_date(value: str) -> str:
    normalized = value.strip()
    if not re.fullmatch(r"\d{4}-\d{2}-\d{2}", normalized):
        raise HTTPException(status_code=422, detail="日程实例日期无效")
    try:
        parsed = datetime.strptime(normalized, "%Y-%m-%d")
    except ValueError as error:
        raise HTTPException(status_code=422, detail="日程实例日期无效") from error
    if parsed.strftime("%Y-%m-%d") != normalized:
        raise HTTPException(status_code=422, detail="日程实例日期无效")
    return normalized


def _occurrence_precondition(
    if_match: str | None,
    if_none_match: str | None,
) -> tuple[str, int | None]:
    if if_match is not None and if_none_match is not None:
        raise HTTPException(status_code=400, detail="日程关联版本条件不能同时指定")
    if if_none_match is not None:
        if if_none_match.strip() != "*":
            raise HTTPException(status_code=400, detail="日程关联新建条件无效")
        return "create", None
    if if_match is None:
        raise HTTPException(status_code=428, detail="缺少日程关联版本条件")
    raw = if_match.strip()
    if raw.startswith("W/"):
        raw = raw[2:].strip()
    if len(raw) >= 2 and raw[0] == raw[-1] == '"':
        raw = raw[1:-1]
    if not raw.isdigit():
        raise HTTPException(status_code=400, detail="日程关联版本条件无效")
    revision = int(raw)
    if revision < 1 or revision > _MAX_SAFE_INTEGER:
        raise HTTPException(status_code=400, detail="日程关联版本条件无效")
    return "update", revision


def _occurrence_conflict_response(error: OccurrenceContractConflict) -> JSONResponse:
    messages = {
        "idempotency_key_reused": "同一请求标识已用于其他日程关联修改",
        "occurrence_already_bound": "这个日程实例已关联其他会议记录",
        "meeting_already_bound": "这条会议记录已关联其他日程实例",
        "occurrence_missing": "云端不存在这项日程关联",
        "revision_conflict": "日程关联云端版本已变化",
        "occurrence_identity_mismatch": "日程关联身份不一致",
        "schedule_snapshot_immutable": "记录时的日程计划不能被覆盖",
        "occurrence_clock_regression": "日程关联更新时间不能倒退",
        "occurrence_clock_not_advanced": "修改日程关联后需要推进更新时间",
    }
    current = error.current
    revision = current.get("revision") if isinstance(current, dict) else None
    headers = {"ETag": f'"{revision}"'} if isinstance(revision, int) else None
    return JSONResponse(
        status_code=error.status_code,
        headers=headers,
        content={
            "error": {
                "code": error.code,
                "message": messages.get(error.code, "日程关联同步冲突"),
            },
            "current": current,
            "revision": revision,
        },
    )


def _meeting_root_revision(if_match: str | None) -> int:
    if if_match is None:
        raise HTTPException(status_code=428, detail="缺少会议记录版本条件")
    raw = if_match.strip()
    if raw.startswith("W/"):
        raw = raw[2:].strip()
    if len(raw) >= 2 and raw[0] == raw[-1] == '"':
        raw = raw[1:-1]
    if not raw.isdigit():
        raise HTTPException(status_code=400, detail="会议记录版本条件无效")
    revision = int(raw)
    if revision < 1 or revision > _MAX_SAFE_INTEGER:
        raise HTTPException(status_code=400, detail="会议记录版本条件无效")
    return revision


def _meeting_root_conflict_response(error: MeetingNoteRootConflict) -> JSONResponse:
    messages = {
        "idempotency_key_reused": "同一请求标识已用于其他会议记录修改",
        "client_note_id_conflict": "本机会议标识已在云端使用",
        "occurrence_already_bound": "这个日程实例已关联其他会议记录",
        "meeting_note_missing": "云端不存在这条会议记录",
        "meeting_note_deleted": "这条会议记录已删除",
        "occurrence_replacement_missing": "待接替的日程会议已发生变化",
        "occurrence_superseded": "该日程已由新的会议记录接替",
        "revision_conflict": "会议记录云端版本已变化",
    }
    current = error.current
    revision = current.get("revision") if isinstance(current, dict) else None
    headers = {"ETag": f'"{revision}"'} if isinstance(revision, int) else None
    return JSONResponse(
        status_code=error.status_code,
        headers=headers,
        content={
            "error": {
                "code": error.code,
                "message": messages.get(error.code, "会议记录同步冲突"),
            },
            "current": current,
            "revision": revision,
        },
    )


def _naive_utc(value: datetime | None) -> datetime | None:
    if value is None:
        return None
    if value.tzinfo is None:
        return value
    return value.astimezone(timezone.utc).replace(tzinfo=None)


def _encode_meeting_root_cursor(updated_at: datetime, meeting_id: str) -> str:
    payload = json.dumps(
        {
            "v": _MEETING_ROOT_CURSOR_VERSION,
            "updated_at": _cursor_time(updated_at),
            "id": meeting_id,
        },
        ensure_ascii=True,
        separators=(",", ":"),
        sort_keys=True,
    ).encode("utf-8")
    return base64.urlsafe_b64encode(payload).decode("ascii").rstrip("=")


def _decode_meeting_root_cursor(value: str) -> tuple[datetime, str]:
    try:
        normalized = value.strip()
        if (
            not normalized
            or len(normalized) > 2048
            or not re.fullmatch(r"[A-Za-z0-9_-]+", normalized)
        ):
            raise ValueError
        padding = "=" * (-len(normalized) % 4)
        raw = base64.b64decode(normalized + padding, altchars=b"-_", validate=True)
        decoded = json.loads(raw.decode("utf-8"))
        if not isinstance(decoded, dict) or set(decoded) != {"v", "updated_at", "id"}:
            raise ValueError
        if decoded["v"] != _MEETING_ROOT_CURSOR_VERSION:
            raise ValueError
        meeting_id = decoded["id"]
        if not isinstance(meeting_id, str) or not re.fullmatch(r"[0-9a-fA-F-]{36}", meeting_id):
            raise ValueError
        raw_time = decoded["updated_at"]
        if not isinstance(raw_time, str) or not raw_time.endswith("Z"):
            raise ValueError
        aware = datetime.fromisoformat(raw_time[:-1] + "+00:00")
        updated_at = aware.astimezone(timezone.utc).replace(tzinfo=None)
    except (ValueError, TypeError, UnicodeDecodeError, json.JSONDecodeError) as error:
        raise HTTPException(status_code=400, detail="会议记录同步游标无效") from error
    return updated_at, meeting_id


async def _action_schema_ready(db: AsyncSession) -> bool:
    try:
        await db.execute(select(MeetingActionItem.id).limit(1))
        return True
    except SQLAlchemyError:
        await db.rollback()
        return False


async def _action_collaboration_schema_ready(db: AsyncSession) -> bool:
    if not action_collaboration_configured():
        return False
    try:
        await db.execute(select(MeetingActionShare.id).limit(1))
        await db.execute(select(MeetingActionCollaborationOperation.id).limit(1))
        await db.execute(select(MeetingActionCollaborationEvent.id).limit(1))
        return True
    except SQLAlchemyError:
        await db.rollback()
        return False


async def _meeting_content_share_schema_ready(db: AsyncSession) -> bool:
    if not meeting_content_share_configured():
        return False
    try:
        await db.execute(select(MeetingContentShare.id).limit(1))
        await db.execute(select(MeetingContentShareOperation.id).limit(1))
        return True
    except SQLAlchemyError:
        await db.rollback()
        return False


async def _manual_note_schema_ready(db: AsyncSession) -> bool:
    try:
        await db.execute(select(MeetingManualNote.id).limit(1))
        await db.execute(select(MeetingManualNoteOperation.id).limit(1))
        return True
    except SQLAlchemyError:
        await db.rollback()
        return False


async def _meeting_tag_catalog_schema_ready(db: AsyncSession) -> bool:
    try:
        await db.execute(select(MeetingTagCatalogV1.user_id).limit(1))
        await db.execute(select(MeetingTagCatalogOperationV1.id).limit(1))
        return True
    except SQLAlchemyError:
        await db.rollback()
        return False


async def _occurrence_schema_ready(db: AsyncSession) -> bool:
    try:
        await db.execute(select(MeetingOccurrenceLink.id).limit(1))
        await db.execute(select(MeetingScheduleSnapshotV2.id).limit(1))
        await db.execute(select(MeetingOccurrenceOperation.id).limit(1))
        return True
    except SQLAlchemyError:
        await db.rollback()
        return False


async def _meeting_root_schema_ready(db: AsyncSession) -> bool:
    try:
        await db.execute(select(MeetingNoteRootV2.meeting_id).limit(1))
        await db.execute(select(MeetingNoteRootOperationV2.id).limit(1))
        return True
    except SQLAlchemyError:
        await db.rollback()
        return False


async def _meeting_question_schema_ready(db: AsyncSession) -> bool:
    try:
        await db.execute(select(MeetingQuestionThread.id).limit(1))
        await db.execute(select(MeetingQuestionTurn.id).limit(1))
        await db.execute(select(MeetingQuestionCitation.id).limit(1))
        return True
    except SQLAlchemyError:
        await db.rollback()
        return False


async def _recording_asset_schema_ready(db: AsyncSession) -> bool:
    try:
        await db.execute(select(MeetingRecordingAssetV2.id).limit(1))
        await db.execute(select(MeetingRecordingAssetOperationV2.id).limit(1))
        await db.execute(select(MeetingRecordingTranscriptionJobV2.id).limit(1))
        return True
    except SQLAlchemyError:
        await db.rollback()
        return False


async def _meeting_attachment_schema_ready(db: AsyncSession) -> bool:
    try:
        await db.execute(select(MeetingAttachmentV1.id).limit(1))
        await db.execute(select(MeetingAttachmentOperationV1.id).limit(1))
        return True
    except SQLAlchemyError:
        await db.rollback()
        return False


async def _meeting_marker_schema_ready(db: AsyncSession) -> bool:
    try:
        await db.execute(select(MeetingMarkerV1.id).limit(1))
        await db.execute(select(MeetingMarkerOperationV1.id).limit(1))
        return True
    except SQLAlchemyError:
        await db.rollback()
        return False


async def _meeting_summary_schema_ready(db: AsyncSession) -> bool:
    try:
        await db.execute(select(MeetingSummaryVersionV1.id).limit(1))
        await db.execute(select(MeetingSummarySectionStateV1.id).limit(1))
        await db.execute(select(MeetingSummaryCurrentV1.meeting_id).limit(1))
        await db.execute(select(MeetingSummaryOperationV1.id).limit(1))
        return True
    except SQLAlchemyError:
        await db.rollback()
        return False


async def _media_clip_schema_ready(db: AsyncSession) -> bool:
    try:
        await db.execute(select(MeetingMediaClipJobV1.id).limit(1))
        return True
    except SQLAlchemyError:
        await db.rollback()
        return False


def _cursor_time(value: datetime) -> str:
    if value.tzinfo is None:
        value = value.replace(tzinfo=timezone.utc)
    return value.astimezone(timezone.utc).isoformat(timespec="microseconds").replace("+00:00", "Z")


def _encode_action_cursor(updated_at: datetime, action_id: str) -> str:
    payload = json.dumps(
        {"v": _ACTION_CURSOR_VERSION, "updated_at": _cursor_time(updated_at), "id": action_id},
        ensure_ascii=True,
        separators=(",", ":"),
        sort_keys=True,
    ).encode("utf-8")
    return base64.urlsafe_b64encode(payload).decode("ascii").rstrip("=")


def _decode_action_cursor(value: str) -> tuple[datetime, str]:
    try:
        normalized = value.strip()
        if not normalized or len(normalized) > 2048 or not re.fullmatch(r"[A-Za-z0-9_-]+", normalized):
            raise ValueError
        padding = "=" * (-len(normalized) % 4)
        raw = base64.b64decode(normalized + padding, altchars=b"-_", validate=True)
        decoded = json.loads(raw.decode("utf-8"))
        if not isinstance(decoded, dict) or set(decoded) != {"v", "updated_at", "id"}:
            raise ValueError
        if decoded["v"] != _ACTION_CURSOR_VERSION:
            raise ValueError
        action_id = decoded["id"]
        if not isinstance(action_id, str) or not re.fullmatch(r"[0-9a-fA-F-]{36}", action_id):
            raise ValueError
        raw_time = decoded["updated_at"]
        if not isinstance(raw_time, str) or not raw_time.endswith("Z"):
            raise ValueError
        aware = datetime.fromisoformat(raw_time[:-1] + "+00:00")
        updated_at = aware.astimezone(timezone.utc).replace(tzinfo=None)
    except (ValueError, TypeError, UnicodeDecodeError, json.JSONDecodeError) as error:
        raise HTTPException(status_code=400, detail="行动项同步游标无效") from error
    return updated_at, action_id


@router.get("/capabilities")
async def get_laoji_capabilities(db: AsyncSession = Depends(get_db)):
    meeting_root_schema_ready = await _meeting_root_schema_ready(db)
    action_schema_ready = await _action_schema_ready(db)
    action_collaboration_schema_ready = (
        action_schema_ready and await _action_collaboration_schema_ready(db)
    )
    meeting_content_share_schema_ready = await _meeting_content_share_schema_ready(db)
    manual_note_schema_ready = await _manual_note_schema_ready(db)
    meeting_tag_catalog_schema_ready = await _meeting_tag_catalog_schema_ready(db)
    occurrence_schema_ready = await _occurrence_schema_ready(db)
    meeting_question_schema_ready = await _meeting_question_schema_ready(db)
    recording_asset_schema_ready = await _recording_asset_schema_ready(db)
    meeting_attachment_schema_ready = await _meeting_attachment_schema_ready(db)
    meeting_marker_schema_ready = await _meeting_marker_schema_ready(db)
    meeting_summary_schema_ready = await _meeting_summary_schema_ready(db)
    media_clip_schema_ready = (
        recording_asset_schema_ready and await _media_clip_schema_ready(db)
    )
    speaker_correction_schema_ready = await speaker_schema_ready(db)
    media_import = None
    if (
        recording_asset_schema_ready
        and shutil.which("ffmpeg") is not None
        and shutil.which("ffprobe") is not None
    ):
        media_import = {
            "mime_types": [
                "audio/wav",
                "audio/mpeg",
                "audio/mp4",
                "audio/aac",
                "audio/ogg",
                "audio/webm",
                "audio/flac",
                "video/mp4",
                "video/webm",
                "video/quicktime",
                "video/x-matroska",
            ],
            "max_bytes": settings.MEETING_AUDIO_MAX_BYTES,
        }
    return {
        "schema_version": 1,
        "meeting_notes_v2": meeting_root_schema_ready,
        "structured_summary_v2": True,
        "summary_citations": True,
        "summary_versions_v1": meeting_summary_schema_ready,
        "summary_attachments_text": True,
        "summary_attachments_image": False,
        "meeting_attachments_v1": meeting_attachment_schema_ready,
        "meeting_markers_v1": meeting_marker_schema_ready,
        "meeting_questions_v1": meeting_question_schema_ready,
        "action_items_v2": action_schema_ready,
        "action_items_pull_v2": action_schema_ready,
        "action_collaboration_v1": action_collaboration_schema_ready,
        "meeting_content_shares_v1": meeting_content_share_schema_ready,
        "manual_notes_v2": manual_note_schema_ready,
        "meeting_tags_v1": meeting_tag_catalog_schema_ready,
        "occurrence_links_v2": occurrence_schema_ready,
        "recording_assets_v2": recording_asset_schema_ready,
        # Each completed RecordingAsset can start a new immutable Transcript
        # generation by using a fresh request and idempotency identity.
        "transcript_reprocess_v1": recording_asset_schema_ready,
        "media_clips_v1": {
            "minimum_duration_ms": MEDIA_CLIP_MINIMUM_DURATION_MS,
            "maximum_duration_ms": MEDIA_CLIP_MAXIMUM_DURATION_MS,
            "adjustment_step_ms": MEDIA_CLIP_ADJUSTMENT_STEP_MS,
            "output_mime_type": "audio/wav",
        } if (
            media_clip_schema_ready
            and shutil.which("ffmpeg") is not None
            and shutil.which("ffprobe") is not None
        ) else None,
        "speaker_corrections": speaker_correction_schema_ready,
        "speaker_profiles_v2": speaker_correction_schema_ready,
        "speaker_reprocess_v1": speaker_correction_schema_ready,
        "media_import": media_import,
        "sync_cursor": False,
        "soft_delete_days": MEETING_NOTE_SOFT_DELETE_DAYS if meeting_root_schema_ready else None,
    }


@router.post("/v2/meeting-notes")
async def post_meeting_note_v2(
    data: MeetingNoteV2Create,
    idempotency_key: str | None = Header(default=None, alias="Idempotency-Key"),
    current_user: dict = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    user_id = int(current_user["id"])
    if is_user_meeting_tombstoned(user_id):
        raise HTTPException(status_code=409, detail="账号正在删除，不能创建会议记录")
    if idempotency_key is None:
        raise HTTPException(status_code=428, detail="缺少会议记录请求标识")
    idempotency_key = _identifier(idempotency_key, "会议记录请求标识")
    mutation = data.model_dump()
    mutation["client_note_id"] = _identifier(
        data.client_note_id,
        "本机会议标识",
        maximum=160,
    )
    if data.supersedes_meeting_id is not None:
        mutation["supersedes_meeting_id"] = _identifier(
            data.supersedes_meeting_id,
            "待接替会议标识",
            maximum=160,
        )
    else:
        # Preserve the request hash generated by clients that created a root
        # before the optional replacement field existed.  Retrying the same
        # idempotency key after deployment must remain a replay, not become an
        # idempotency-key conflict merely because Pydantic added a null field.
        mutation.pop("supersedes_meeting_id", None)
    mutation["title"] = data.title.strip()
    if "\x00" in data.title or (data.description is not None and "\x00" in data.description):
        raise HTTPException(status_code=422, detail="会议文字包含无效字符")
    mutation["description"] = data.description
    mutation["participants"] = [item.strip() for item in data.participants]
    mutation["location"] = data.location.strip() if data.location and data.location.strip() else None
    mutation["recorded_at"] = _naive_utc(data.recorded_at)
    if data.occurrence_ref is not None and data.schedule_snapshot is not None:
        occurrence = data.occurrence_ref.model_dump()
        occurrence["source_event_id"] = _identifier(
            data.occurrence_ref.source_event_id,
            "日程来源标识",
        )
        occurrence["occurrence_date"] = _occurrence_date(data.occurrence_ref.occurrence_date)
        for field_name, label in (
            ("recurrence_segment_id", "日程分段标识"),
            ("series_key", "日程序列标识"),
        ):
            value = occurrence.get(field_name)
            if value is not None:
                occurrence[field_name] = _identifier(value, label)
        snapshot = data.schedule_snapshot.model_dump()
        snapshot["participants"] = [item.strip() for item in data.schedule_snapshot.participants]
        mutation["occurrence_ref"] = occurrence
        mutation["schedule_snapshot"] = snapshot
    request_hash = meeting_note_root_request_hash(
        "create",
        mutation["client_note_id"],
        mutation,
    )
    try:
        result = await create_meeting_note_root(
            db,
            user_id=user_id,
            idempotency_key=idempotency_key,
            request_hash=request_hash,
            mutation=mutation,
        )
    except MeetingNoteRootConflict as error:
        return _meeting_root_conflict_response(error)
    except SQLAlchemyError as error:
        await db.rollback()
        raise HTTPException(status_code=503, detail="会议记录服务暂不可用，请稍后重试") from error
    return JSONResponse(
        status_code=result.status_code,
        headers={"ETag": f'"{result.payload["revision"]}"'},
        content=result.payload,
    )


@router.get("/v2/meeting-notes")
async def list_meeting_notes_v2(
    cursor: str | None = Query(default=None, max_length=2048),
    limit: int = Query(default=50, ge=1, le=100),
    current_user: dict = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    user_id = int(current_user["id"])
    query = (
        select(MeetingNoteRootV2, Meeting)
        .join(Meeting, Meeting.id == MeetingNoteRootV2.meeting_id)
        .where(
            MeetingNoteRootV2.user_id == user_id,
            Meeting.user_id == user_id,
        )
    )
    if cursor is not None:
        cursor_updated_at, cursor_id = _decode_meeting_root_cursor(cursor)
        query = query.where(or_(
            MeetingNoteRootV2.updated_at > cursor_updated_at,
            and_(
                MeetingNoteRootV2.updated_at == cursor_updated_at,
                MeetingNoteRootV2.meeting_id > cursor_id,
            ),
        ))
    try:
        rows = (await db.execute(
            query.order_by(
                MeetingNoteRootV2.updated_at,
                MeetingNoteRootV2.meeting_id,
            ).limit(limit + 1)
        )).all()
        page = rows[:limit]
        items = [
            await meeting_note_root_payload(db, meeting, root)
            for root, meeting in page
        ]
    except SQLAlchemyError as error:
        await db.rollback()
        raise HTTPException(status_code=503, detail="会议记录服务暂不可用，请稍后重试") from error
    next_cursor = (
        _encode_meeting_root_cursor(page[-1][0].updated_at, page[-1][0].meeting_id)
        if page else cursor
    )
    return {
        "schema_version": 2,
        "items": items,
        "next_cursor": next_cursor,
        "has_more": len(rows) > limit,
    }


@router.get("/v2/meeting-notes/{meeting_id}")
async def get_meeting_note_v2(
    meeting_id: str,
    current_user: dict = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    user_id = int(current_user["id"])
    meeting_id = _identifier(meeting_id, "会议标识", maximum=160)
    root = await find_meeting_note_root(db, user_id=user_id, meeting_id=meeting_id)
    meeting = (await db.execute(select(Meeting).where(
        Meeting.id == meeting_id,
        Meeting.user_id == user_id,
    ))).scalar_one_or_none()
    if root is None or meeting is None:
        raise HTTPException(status_code=404, detail="会议不存在或无权访问")
    payload = await meeting_note_root_payload(db, meeting, root)
    return JSONResponse(
        headers={"ETag": f'"{root.revision}"'},
        content=payload,
    )


def _speaker_conflict_response(error: SpeakerContractConflict) -> JSONResponse:
    messages = {
        "speaker_request_reused": "讲话人修正请求标识已被其他操作使用",
        "transcript_not_stable": "文字记录尚未完成，暂时不能修改讲话人",
        "transcript_revision_changed": "文字记录已更新，请刷新后重试",
        "assignment_revision_conflict": "讲话人修正的云端版本已变化",
        "speaker_segments_changed": "讲话人片段已变化，请刷新后重试",
        "speaker_cluster_changed": "讲话人分段已变化，请刷新后重试",
        "speaker_profile_name_changed": "讲话人资料名称已变化，请刷新后重试",
    }
    body = {
        "error": error.code,
        "message": messages.get(error.code, "讲话人修正暂时无法保存"),
        "assignment_revision": error.current_revision,
        "current": error.current,
    }
    headers = (
        {"ETag": f'"{error.current_revision}"'}
        if error.current_revision is not None else None
    )
    return JSONResponse(status_code=error.status_code, headers=headers, content=body)


@router.post("/v2/meeting-notes/{meeting_id}/speaker-corrections")
async def post_speaker_correction_v2(
    meeting_id: str,
    data: SpeakerCorrectionV2Mutation,
    idempotency_key: str | None = Header(default=None, alias="Idempotency-Key"),
    current_user: dict = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    user_id = int(current_user["id"])
    if is_user_meeting_tombstoned(user_id):
        raise HTTPException(status_code=409, detail="账号正在删除，不能修改讲话人")
    meeting_id = _identifier(meeting_id, "会议标识", maximum=160)
    if idempotency_key is None:
        raise HTTPException(status_code=428, detail="缺少讲话人修正请求标识")
    idempotency_key = _identifier(idempotency_key, "讲话人修正请求标识")
    mutation = data.model_dump()
    mutation["client_request_id"] = _identifier(
        data.client_request_id,
        "讲话人修正标识",
    )
    mutation["transcript_revision_id"] = _identifier(
        data.transcript_revision_id,
        "文字记录版本",
    )
    mutation["segment_ids"] = [
        _identifier(item, "讲话人片段标识") for item in data.segment_ids
    ]
    mutation["cluster_id"] = (
        _identifier(data.cluster_id, "讲话人簇标识") if data.cluster_id else None
    )
    mutation["speaker_profile_id"] = (
        _identifier(data.speaker_profile_id, "讲话人资料标识", maximum=160)
        if data.speaker_profile_id else None
    )
    mutation["display_name"] = " ".join(data.display_name.strip().split())
    if not mutation["display_name"]:
        raise HTTPException(status_code=422, detail="讲话人名称不能为空")
    request_hash = speaker_correction_request_hash(meeting_id, mutation)
    try:
        result = await submit_speaker_correction(
            db,
            user_id=user_id,
            meeting_id=meeting_id,
            idempotency_key=idempotency_key,
            request_hash=request_hash,
            mutation=mutation,
        )
    except SpeakerContractConflict as error:
        return _speaker_conflict_response(error)
    except LookupError as error:
        message = (
            "讲话人资料不存在或已撤销"
            if str(error) == "speaker_profile_missing"
            else "会议不存在或无权访问"
        )
        raise HTTPException(status_code=404, detail=message) from error
    except SQLAlchemyError as error:
        await db.rollback()
        raise HTTPException(status_code=503, detail="讲话人修正服务暂不可用，请稍后重试") from error
    if result.payload.get("sample_state") == "queued" and result.correction_id:
        schedule_profile_sample_update(result.correction_id)
    return JSONResponse(
        status_code=result.status_code,
        headers={"ETag": f'"{result.payload["assignment_revision"]}"'},
        content=result.payload,
    )


@router.get("/v2/meeting-notes/{meeting_id}/speaker-corrections/{correction_id}")
async def get_speaker_correction_v2(
    meeting_id: str,
    correction_id: str,
    current_user: dict = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    correction = await find_speaker_correction(
        db,
        user_id=int(current_user["id"]),
        meeting_id=_identifier(meeting_id, "会议标识", maximum=160),
        correction_id=_identifier(correction_id, "讲话人修正标识", maximum=160),
    )
    if correction is None:
        raise HTTPException(status_code=404, detail="讲话人修正不存在或无权访问")
    return JSONResponse(
        headers={"ETag": f'"{correction.assignment_revision}"'},
        content=correction_payload(correction),
    )


@router.post("/v2/meeting-notes/{meeting_id}/speaker-corrections/{correction_id}/profile-sample/retry")
async def retry_speaker_profile_sample_v2(
    meeting_id: str,
    correction_id: str,
    current_user: dict = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    try:
        correction = await retry_profile_sample(
            db,
            user_id=int(current_user["id"]),
            meeting_id=_identifier(meeting_id, "会议标识", maximum=160),
            correction_id=_identifier(correction_id, "讲话人修正标识", maximum=160),
        )
    except LookupError as error:
        raise HTTPException(status_code=404, detail="讲话人修正不存在或无权访问") from error
    if correction.sample_state == "queued":
        schedule_profile_sample_update(correction.id)
    return JSONResponse(
        headers={"ETag": f'"{correction.assignment_revision}"'},
        content=correction_payload(correction),
    )


@router.patch("/v2/meeting-notes/{meeting_id}")
async def patch_meeting_note_v2(
    meeting_id: str,
    data: MeetingNoteV2Update,
    if_match: str | None = Header(default=None, alias="If-Match"),
    idempotency_key: str | None = Header(default=None, alias="Idempotency-Key"),
    current_user: dict = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    user_id = int(current_user["id"])
    if is_user_meeting_tombstoned(user_id):
        raise HTTPException(status_code=409, detail="账号正在删除，不能修改会议记录")
    meeting_id = _identifier(meeting_id, "会议标识", maximum=160)
    expected_revision = _meeting_root_revision(if_match)
    if idempotency_key is None:
        raise HTTPException(status_code=428, detail="缺少会议记录请求标识")
    idempotency_key = _identifier(idempotency_key, "会议记录请求标识")
    mutation = data.model_dump(exclude_unset=True)
    mutation.pop("schema_version", None)
    if "title" in mutation:
        if "\x00" in mutation["title"]:
            raise HTTPException(status_code=422, detail="会议标题包含无效字符")
        mutation["title"] = mutation["title"].strip()
    if "description" in mutation and mutation["description"] is not None and "\x00" in mutation["description"]:
        raise HTTPException(status_code=422, detail="会议说明包含无效字符")
    if "participants" in mutation:
        mutation["participants"] = [item.strip() for item in mutation["participants"]]
    if "location" in mutation:
        mutation["location"] = (
            mutation["location"].strip()
            if mutation["location"] and mutation["location"].strip()
            else None
        )
    if "status" in mutation:
        mutation["status"] = _identifier(mutation["status"], "会议状态", maximum=160)
    if "recorded_at" in mutation:
        mutation["recorded_at"] = _naive_utc(mutation["recorded_at"])
    request_hash = meeting_note_root_request_hash("update", meeting_id, mutation)
    try:
        result = await mutate_meeting_note_root(
            db,
            user_id=user_id,
            meeting_id=meeting_id,
            idempotency_key=idempotency_key,
            request_hash=request_hash,
            operation_kind="update",
            expected_revision=expected_revision,
            mutation=mutation,
        )
    except MeetingNoteRootConflict as error:
        return _meeting_root_conflict_response(error)
    except SQLAlchemyError as error:
        await db.rollback()
        raise HTTPException(status_code=503, detail="会议记录服务暂不可用，请稍后重试") from error
    return JSONResponse(
        status_code=result.status_code,
        headers={"ETag": f'"{result.payload["revision"]}"'},
        content=result.payload,
    )


async def _meeting_note_lifecycle_mutation(
    *,
    meeting_id: str,
    operation_kind: Literal["delete", "restore"],
    if_match: str | None,
    idempotency_key: str | None,
    current_user: dict,
    db: AsyncSession,
) -> JSONResponse:
    user_id = int(current_user["id"])
    if is_user_meeting_tombstoned(user_id):
        raise HTTPException(status_code=409, detail="账号正在删除，不能修改会议记录")
    meeting_id = _identifier(meeting_id, "会议标识", maximum=160)
    expected_revision = _meeting_root_revision(if_match)
    if idempotency_key is None:
        raise HTTPException(status_code=428, detail="缺少会议记录请求标识")
    idempotency_key = _identifier(idempotency_key, "会议记录请求标识")
    request_hash = meeting_note_root_request_hash(operation_kind, meeting_id, {})
    try:
        result = await mutate_meeting_note_root(
            db,
            user_id=user_id,
            meeting_id=meeting_id,
            idempotency_key=idempotency_key,
            request_hash=request_hash,
            operation_kind=operation_kind,
            expected_revision=expected_revision,
            mutation={},
        )
    except MeetingNoteRootConflict as error:
        return _meeting_root_conflict_response(error)
    except SQLAlchemyError as error:
        await db.rollback()
        raise HTTPException(status_code=503, detail="会议记录服务暂不可用，请稍后重试") from error
    return JSONResponse(
        status_code=result.status_code,
        headers={"ETag": f'"{result.payload["revision"]}"'},
        content=result.payload,
    )


@router.delete("/v2/meeting-notes/{meeting_id}")
async def delete_meeting_note_v2(
    meeting_id: str,
    if_match: str | None = Header(default=None, alias="If-Match"),
    idempotency_key: str | None = Header(default=None, alias="Idempotency-Key"),
    current_user: dict = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    return await _meeting_note_lifecycle_mutation(
        meeting_id=meeting_id,
        operation_kind="delete",
        if_match=if_match,
        idempotency_key=idempotency_key,
        current_user=current_user,
        db=db,
    )


@router.post("/v2/meeting-notes/{meeting_id}/restore")
async def restore_meeting_note_v2(
    meeting_id: str,
    if_match: str | None = Header(default=None, alias="If-Match"),
    idempotency_key: str | None = Header(default=None, alias="Idempotency-Key"),
    current_user: dict = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    return await _meeting_note_lifecycle_mutation(
        meeting_id=meeting_id,
        operation_kind="restore",
        if_match=if_match,
        idempotency_key=idempotency_key,
        current_user=current_user,
        db=db,
    )


async def _owned_meeting(
    db: AsyncSession,
    *,
    meeting_id: str,
    user_id: int,
) -> Meeting:
    meeting = (await db.execute(
        select(Meeting).where(
            Meeting.id == meeting_id,
            Meeting.user_id == user_id,
            ~select(MeetingNoteRootV2.meeting_id).where(
                MeetingNoteRootV2.meeting_id == Meeting.id,
                MeetingNoteRootV2.lifecycle == "deleted",
            ).exists(),
        )
    )).scalar_one_or_none()
    if meeting is None:
        raise HTTPException(status_code=404, detail="会议不存在或无权访问")
    return meeting


@router.get("/v2/meeting-notes/{meeting_id}/occurrence-link")
async def get_meeting_occurrence_v2(
    meeting_id: str,
    current_user: dict = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    user_id = int(current_user["id"])
    meeting_id = _identifier(meeting_id, "会议标识", maximum=160)
    await _owned_meeting(db, meeting_id=meeting_id, user_id=user_id)
    try:
        link = await find_occurrence_by_meeting(
            db,
            user_id=user_id,
            meeting_id=meeting_id,
        )
        payload = (
            await occurrence_payload_for_link(db, link)
            if link is not None
            else missing_occurrence_payload(
                meeting_id=meeting_id,
                source_event_id=None,
                occurrence_date=None,
            )
        )
    except (SQLAlchemyError, RuntimeError) as error:
        raise HTTPException(status_code=503, detail="日程关联服务暂不可用，请稍后重试") from error
    return JSONResponse(
        status_code=200,
        headers={"ETag": f'"{payload["revision"]}"'},
        content=payload,
    )


@router.get("/v2/occurrence-links/lookup")
async def get_occurrence_binding_v2(
    source_event_id: str = Query(min_length=1, max_length=512),
    occurrence_date: str = Query(min_length=10, max_length=10),
    current_user: dict = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    user_id = int(current_user["id"])
    source_event_id = _identifier(source_event_id, "日程标识")
    occurrence_date = _occurrence_date(occurrence_date)
    try:
        link = await find_occurrence_by_identity(
            db,
            user_id=user_id,
            source_event_id=source_event_id,
            occurrence_date=occurrence_date,
        )
        payload = (
            await occurrence_payload_for_link(db, link)
            if link is not None
            else missing_occurrence_payload(
                meeting_id=None,
                source_event_id=source_event_id,
                occurrence_date=occurrence_date,
            )
        )
    except (SQLAlchemyError, RuntimeError) as error:
        raise HTTPException(status_code=503, detail="日程关联服务暂不可用，请稍后重试") from error
    return JSONResponse(
        status_code=200,
        headers={"ETag": f'"{payload["revision"]}"'},
        content=payload,
    )


@router.put("/v2/meeting-notes/{meeting_id}/occurrence-link")
async def put_meeting_occurrence_v2(
    meeting_id: str,
    data: OccurrenceLinkV2Upsert,
    idempotency_key: str = Header(alias="Idempotency-Key"),
    if_match: str | None = Header(default=None, alias="If-Match"),
    if_none_match: str | None = Header(default=None, alias="If-None-Match"),
    current_user: dict = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    user_id = int(current_user["id"])
    if is_user_meeting_tombstoned(user_id):
        raise HTTPException(status_code=409, detail="账号正在删除，不能修改会议")
    meeting_id = _identifier(meeting_id, "会议标识", maximum=160)
    idempotency_key = _identifier(idempotency_key, "请求标识", minimum=8, maximum=512)
    precondition, expected_revision = _occurrence_precondition(if_match, if_none_match)
    await _owned_meeting(db, meeting_id=meeting_id, user_id=user_id)

    mutation = data.model_dump(mode="json")
    mutation["source_event_id"] = _identifier(data.source_event_id, "日程标识")
    mutation["occurrence_date"] = _occurrence_date(data.occurrence_date)
    for field, label in (
        ("recurrence_segment_id", "重复日程分段标识"),
        ("series_key", "重复日程系列标识"),
    ):
        value = mutation.get(field)
        mutation[field] = (
            _identifier(value, label)
            if isinstance(value, str) and value.strip()
            else None
        )

    snapshot = mutation["schedule_snapshot"]
    snapshot["event_title"] = snapshot["event_title"].strip()
    if "\x00" in snapshot["event_title"]:
        raise HTTPException(status_code=422, detail="日程标题包含无效字符")
    for field, label, maximum in (
        ("timezone_id", "日程时区", 160),
        ("location", "日程地点", 2_000),
    ):
        value = snapshot.get(field)
        normalized = value.strip() if isinstance(value, str) else ""
        if normalized and (len(normalized) > maximum or "\x00" in normalized):
            raise HTTPException(status_code=422, detail=f"{label}无效")
        snapshot[field] = normalized or None
    description = snapshot.get("description")
    if isinstance(description, str):
        description = description.replace("\r\n", "\n").replace("\r", "\n")
        if "\x00" in description:
            raise HTTPException(status_code=422, detail="日程说明包含无效字符")
        snapshot["description"] = description or None
    participants: list[str] = []
    for participant in snapshot["participants"]:
        normalized = participant.strip()
        if normalized and normalized not in participants:
            participants.append(normalized)
    snapshot["participants"] = participants

    request_hash = occurrence_request_hash(
        meeting_id,
        mutation,
        precondition=precondition,
        expected_revision=expected_revision,
    )
    try:
        result = await upsert_meeting_occurrence(
            db,
            user_id=user_id,
            meeting_id=meeting_id,
            idempotency_key=idempotency_key,
            request_hash=request_hash,
            mutation=mutation,
            precondition=precondition,
            expected_revision=expected_revision,
        )
    except OccurrenceContractConflict as error:
        return _occurrence_conflict_response(error)
    except (SQLAlchemyError, RuntimeError) as error:
        raise HTTPException(status_code=503, detail="日程关联服务暂不可用，请稍后重试") from error
    return JSONResponse(
        status_code=result.status_code,
        headers={
            "ETag": f'"{result.payload["revision"]}"',
            "X-Idempotent-Replay": "true" if result.replayed else "false",
        },
        content=result.payload,
    )


@router.get("/v1/meeting-tags")
async def get_meeting_tag_catalog_v1(
    current_user: dict = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    user_id = int(current_user["id"])
    try:
        catalog = await find_meeting_tag_catalog(db, user_id=user_id)
        payload = (
            meeting_tag_catalog_payload(catalog)
            if catalog is not None
            else missing_meeting_tag_catalog_payload()
        )
    except (SQLAlchemyError, RuntimeError, json.JSONDecodeError) as error:
        await db.rollback()
        raise HTTPException(status_code=503, detail="标签服务暂不可用，请稍后重试") from error
    return JSONResponse(
        status_code=200,
        headers={"ETag": f'"{payload["revision"]}"'},
        content=payload,
    )


@router.put("/v1/meeting-tags")
async def put_meeting_tag_catalog_v1(
    data: MeetingTagCatalogV1Replace,
    idempotency_key: str | None = Header(default=None, alias="Idempotency-Key"),
    if_match: str | None = Header(default=None, alias="If-Match"),
    if_none_match: str | None = Header(default=None, alias="If-None-Match"),
    current_user: dict = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    user_id = int(current_user["id"])
    if is_user_meeting_tombstoned(user_id):
        raise HTTPException(status_code=409, detail="账号正在删除，不能修改标签")
    if idempotency_key is None:
        raise HTTPException(status_code=428, detail="缺少标签请求标识")
    idempotency_key = _identifier(idempotency_key, "标签请求标识", minimum=8, maximum=512)
    precondition, expected_revision = _meeting_tag_catalog_precondition(
        if_match,
        if_none_match,
    )
    tags = []
    normalized_names: set[str] = set()
    for item in data.tags:
        client_tag_id = _identifier(item.client_tag_id, "标签标识", maximum=160)
        name = _meeting_tag_name(item.name)
        normalized_name = name.lower()
        if normalized_name in normalized_names:
            raise HTTPException(status_code=422, detail="标签名称存在重复项")
        normalized_names.add(normalized_name)
        tags.append({
            "client_tag_id": client_tag_id,
            "name": name,
            "created_at_ms": item.created_at_ms,
            "updated_at_ms": item.updated_at_ms,
        })
    tags.sort(key=lambda item: item["client_tag_id"])
    known_tag_ids = {item["client_tag_id"] for item in tags}
    assignments = []
    meeting_ids: set[str] = set()
    for item in data.assignments:
        meeting_id = _identifier(item.meeting_remote_id, "会议标识", maximum=160)
        tag_ids = sorted(
            _identifier(tag_id, "标签标识", maximum=160)
            for tag_id in item.client_tag_ids
        )
        if meeting_id in meeting_ids or len(set(tag_ids)) != len(tag_ids):
            raise HTTPException(status_code=422, detail="会议标签分配存在重复项")
        if any(tag_id not in known_tag_ids for tag_id in tag_ids):
            raise HTTPException(status_code=422, detail="会议标签分配引用无效")
        meeting_ids.add(meeting_id)
        assignments.append({
            "meeting_remote_id": meeting_id,
            "client_tag_ids": tag_ids,
        })
    assignments.sort(key=lambda item: item["meeting_remote_id"])
    if meeting_ids:
        owned = set((await db.execute(
            select(MeetingNoteRootV2.meeting_id)
            .join(Meeting, Meeting.id == MeetingNoteRootV2.meeting_id)
            .where(
                MeetingNoteRootV2.user_id == user_id,
                Meeting.user_id == user_id,
                MeetingNoteRootV2.lifecycle == "active",
                MeetingNoteRootV2.meeting_id.in_(meeting_ids),
            )
        )).scalars().all())
        if owned != meeting_ids:
            raise HTTPException(status_code=404, detail="部分会议不存在或无权访问")
    mutation = {
        "client_updated_at_ms": data.client_updated_at_ms,
        "tags": tags,
        "assignments": assignments,
    }
    request_hash = meeting_tag_catalog_request_hash(
        mutation,
        precondition=precondition,
        expected_revision=expected_revision,
    )
    try:
        result = await replace_meeting_tag_catalog(
            db,
            user_id=user_id,
            idempotency_key=idempotency_key,
            request_hash=request_hash,
            mutation=mutation,
            precondition=precondition,
            expected_revision=expected_revision,
        )
    except MeetingTagCatalogConflict as error:
        return _meeting_tag_catalog_conflict_response(error)
    except SQLAlchemyError as error:
        await db.rollback()
        raise HTTPException(status_code=503, detail="标签暂时无法同步，请稍后重试") from error
    return JSONResponse(
        status_code=result.status_code,
        headers={
            "ETag": f'"{result.payload["revision"]}"',
            "X-Idempotent-Replay": "true" if result.replayed else "false",
        },
        content=result.payload,
    )


@router.get("/v2/meeting-notes/{meeting_id}/manual-note")
async def get_meeting_manual_note_v2(
    meeting_id: str,
    current_user: dict = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    user_id = int(current_user["id"])
    meeting_id = _identifier(meeting_id, "会议标识", maximum=160)
    await _owned_meeting(db, meeting_id=meeting_id, user_id=user_id)
    try:
        note = await find_manual_note(db, user_id=user_id, meeting_id=meeting_id)
    except SQLAlchemyError as error:
        raise HTTPException(status_code=503, detail="笔记服务暂不可用，请稍后重试") from error
    payload = manual_note_payload(note) if note else missing_manual_note_payload(meeting_id)
    return JSONResponse(
        status_code=200,
        headers={"ETag": f'"{payload["revision"]}"'},
        content=payload,
    )


@router.put("/v2/meeting-notes/{meeting_id}/manual-note")
async def put_meeting_manual_note_v2(
    meeting_id: str,
    data: ManualNoteV2Upsert,
    idempotency_key: str = Header(alias="Idempotency-Key"),
    if_match: str | None = Header(default=None, alias="If-Match"),
    if_none_match: str | None = Header(default=None, alias="If-None-Match"),
    current_user: dict = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    user_id = int(current_user["id"])
    if is_user_meeting_tombstoned(user_id):
        raise HTTPException(status_code=409, detail="账号正在删除，不能修改会议")
    meeting_id = _identifier(meeting_id, "会议标识", maximum=160)
    idempotency_key = _identifier(idempotency_key, "请求标识", minimum=8, maximum=512)
    precondition, expected_revision = _manual_note_precondition(if_match, if_none_match)
    await _owned_meeting(db, meeting_id=meeting_id, user_id=user_id)
    mutation = data.model_dump(mode="json")
    mutation["content"] = data.content.replace("\r\n", "\n").replace("\r", "\n")
    if "\x00" in mutation["content"]:
        raise HTTPException(status_code=422, detail="笔记内容包含无效字符")
    request_hash = manual_note_request_hash(
        meeting_id,
        mutation,
        precondition=precondition,
        expected_revision=expected_revision,
    )
    try:
        result = await upsert_meeting_manual_note(
            db,
            user_id=user_id,
            meeting_id=meeting_id,
            idempotency_key=idempotency_key,
            request_hash=request_hash,
            mutation=mutation,
            precondition=precondition,
            expected_revision=expected_revision,
        )
    except ManualNoteContractConflict as error:
        return _manual_note_conflict_response(error)
    except SQLAlchemyError as error:
        raise HTTPException(status_code=503, detail="笔记服务暂不可用，请稍后重试") from error
    return JSONResponse(
        status_code=result.status_code,
        headers={
            "ETag": f'"{result.payload["revision"]}"',
            "X-Idempotent-Replay": "true" if result.replayed else "false",
        },
        content=result.payload,
    )


@router.get("/v2/meeting-notes/{meeting_id}/action-items")
async def get_meeting_actions_v2(
    meeting_id: str,
    cursor: str | None = Query(default=None, max_length=2048),
    limit: int = Query(default=100, ge=1, le=200),
    current_user: dict = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    user_id = int(current_user["id"])
    meeting_id = _identifier(meeting_id, "会议标识", maximum=160)
    meeting = (await db.execute(
        select(Meeting.id).where(Meeting.id == meeting_id, Meeting.user_id == user_id)
    )).scalar_one_or_none()
    if meeting is None:
        raise HTTPException(status_code=404, detail="会议不存在或无权访问")

    conditions = [
        MeetingActionItem.user_id == user_id,
        MeetingActionItem.meeting_id == meeting_id,
    ]
    if cursor is not None:
        cursor_updated_at, cursor_id = _decode_action_cursor(cursor)
        conditions.append(or_(
            MeetingActionItem.updated_at > cursor_updated_at,
            and_(
                MeetingActionItem.updated_at == cursor_updated_at,
                MeetingActionItem.id > cursor_id,
            ),
        ))
    try:
        result = await db.execute(
            select(MeetingActionItem)
            .where(*conditions)
            .order_by(MeetingActionItem.updated_at, MeetingActionItem.id)
            .limit(limit + 1)
        )
    except SQLAlchemyError as error:
        raise HTTPException(status_code=503, detail="行动项服务暂不可用，请稍后重试") from error
    rows = list(result.scalars().all())
    has_more = len(rows) > limit
    page = rows[:limit]
    next_cursor = _encode_action_cursor(page[-1].updated_at, page[-1].id) if page else cursor
    return {
        "schema_version": 2,
        "meeting_id": meeting_id,
        "items": [action_payload(action) for action in page],
        "next_cursor": next_cursor,
        "has_more": has_more,
    }


@router.put("/v2/meeting-notes/{meeting_id}/action-items/{client_action_id}")
async def put_meeting_action_v2(
    meeting_id: str,
    client_action_id: str,
    data: ActionItemV2Upsert,
    idempotency_key: str = Header(alias="Idempotency-Key"),
    if_match: str | None = Header(default=None, alias="If-Match"),
    if_none_match: str | None = Header(default=None, alias="If-None-Match"),
    current_user: dict = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    user_id = int(current_user["id"])
    if is_user_meeting_tombstoned(user_id):
        raise HTTPException(status_code=409, detail="账号正在删除，不能修改会议")
    meeting_id = _identifier(meeting_id, "会议标识", maximum=160)
    client_action_id = _identifier(client_action_id, "行动项标识")
    body_action_id = _identifier(data.client_action_id, "行动项标识")
    if body_action_id != client_action_id:
        raise HTTPException(status_code=422, detail="行动项标识与请求路径不一致")
    idempotency_key = _identifier(
        idempotency_key,
        "请求标识",
        minimum=8,
        maximum=512,
    )
    precondition, expected_revision = _precondition(if_match, if_none_match)
    meeting = (await db.execute(
        select(Meeting).where(Meeting.id == meeting_id, Meeting.user_id == user_id)
    )).scalar_one_or_none()
    if meeting is None:
        raise HTTPException(status_code=404, detail="会议不存在或无权访问")

    mutation = data.model_dump(mode="json")
    mutation["client_action_id"] = body_action_id
    mutation["content"] = data.content.strip()
    if not mutation["content"] or "\x00" in mutation["content"]:
        raise HTTPException(status_code=422, detail="行动项内容不能为空")
    for field, label, maximum in (
        ("remote_id", "行动项云端标识", 160),
        ("followup_event_source_id", "后续日程标识", 512),
        ("source_summary_version_id", "整理结果标识", 512),
        ("source_segment_id", "文字记录片段标识", 512),
        ("generation_fingerprint", "行动项生成标识", 512),
    ):
        value = mutation.get(field)
        mutation[field] = (
            _identifier(value, label, maximum=maximum)
            if isinstance(value, str) and value.strip()
            else None
        )
    for field in (
        "assignee",
    ):
        value = mutation.get(field)
        mutation[field] = value.strip() if isinstance(value, str) and value.strip() else None
        if mutation[field] is not None and "\x00" in mutation[field]:
            raise HTTPException(status_code=422, detail="行动项负责人无效")

    request_hash = action_request_hash(
        meeting_id,
        client_action_id,
        mutation,
        precondition=precondition,
        expected_revision=expected_revision,
    )
    try:
        result = await upsert_meeting_action(
            db,
            user_id=user_id,
            meeting_id=meeting_id,
            client_action_id=client_action_id,
            idempotency_key=idempotency_key,
            request_hash=request_hash,
            mutation=mutation,
            precondition=precondition,
            expected_revision=expected_revision,
        )
    except ActionContractConflict as error:
        return _conflict_response(error)
    except SQLAlchemyError as error:
        raise HTTPException(status_code=503, detail="行动项服务暂不可用，请稍后重试") from error

    revision = result.payload["revision"]
    return JSONResponse(
        status_code=result.status_code,
        headers={
            "ETag": f'"{revision}"',
            "X-Idempotent-Replay": "true" if result.replayed else "false",
        },
        content=result.payload,
    )


@router.post("/v2/meeting-notes/{meeting_id}/action-items/{client_action_id}/shares")
async def post_meeting_action_share_v1(
    meeting_id: str,
    client_action_id: str,
    data: ActionShareV1Create,
    idempotency_key: str = Header(alias="Idempotency-Key"),
    if_match: str | None = Header(default=None, alias="If-Match"),
    current_user: dict = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    user_id = int(current_user["id"])
    if is_user_meeting_tombstoned(user_id):
        raise HTTPException(status_code=409, detail="账号正在删除，不能共享待办")
    meeting_id = _identifier(meeting_id, "会议标识", maximum=160)
    client_action_id = _identifier(client_action_id, "行动项标识")
    client_share_id = _identifier(data.client_share_id, "共享标识")
    idempotency_key = _identifier(idempotency_key, "请求标识", minimum=8, maximum=512)
    expected_action_revision = _collaboration_revision(if_match, "行动项")
    action = (await db.execute(
        select(MeetingActionItem).where(
            MeetingActionItem.user_id == user_id,
            MeetingActionItem.meeting_id == meeting_id,
            MeetingActionItem.client_action_id == client_action_id,
        )
    )).scalar_one_or_none()
    if action is None:
        raise HTTPException(status_code=404, detail="行动项不存在或无权访问")
    request_hash = collaboration_request_hash({
        "operation": "create_share",
        "owner_user_id": user_id,
        "meeting_id": meeting_id,
        "client_action_id": client_action_id,
        "client_share_id": client_share_id,
        "permission": data.permission,
        "expected_action_revision": expected_action_revision,
    })
    try:
        result = await create_action_share(
            db,
            owner_user_id=user_id,
            meeting_id=meeting_id,
            action=action,
            client_share_id=client_share_id,
            permission=data.permission,
            expected_action_revision=expected_action_revision,
            idempotency_key=idempotency_key,
            request_hash=request_hash,
        )
    except CollaborationConflict as error:
        return _collaboration_conflict_response(error)
    except CollaborationConfigurationError as error:
        raise HTTPException(status_code=503, detail="待办共享服务尚未配置") from error
    except SQLAlchemyError as error:
        raise HTTPException(status_code=503, detail="待办共享服务暂不可用，请稍后重试") from error
    return JSONResponse(
        status_code=result.status_code,
        headers={
            "ETag": f'"{result.payload["revision"]}"',
            "X-Idempotent-Replay": "true" if result.replayed else "false",
        },
        content=result.payload,
    )


@router.delete("/v2/meeting-notes/{meeting_id}/action-items/{client_action_id}/shares/{client_share_id}")
async def delete_meeting_action_share_v1(
    meeting_id: str,
    client_action_id: str,
    client_share_id: str,
    idempotency_key: str = Header(alias="Idempotency-Key"),
    if_match: str | None = Header(default=None, alias="If-Match"),
    current_user: dict = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    user_id = int(current_user["id"])
    meeting_id = _identifier(meeting_id, "会议标识", maximum=160)
    client_action_id = _identifier(client_action_id, "行动项标识")
    client_share_id = _identifier(client_share_id, "共享标识")
    idempotency_key = _identifier(idempotency_key, "请求标识", minimum=8, maximum=512)
    expected_share_revision = _collaboration_revision(if_match, "共享")
    row = (await db.execute(
        select(MeetingActionShare, MeetingActionItem)
        .join(MeetingActionItem, MeetingActionItem.id == MeetingActionShare.action_id)
        .where(
            MeetingActionShare.owner_user_id == user_id,
            MeetingActionShare.meeting_id == meeting_id,
            MeetingActionShare.client_share_id == client_share_id,
            MeetingActionItem.client_action_id == client_action_id,
            MeetingActionItem.user_id == user_id,
        )
    )).one_or_none()
    if row is None:
        raise HTTPException(status_code=404, detail="共享链接不存在或无权访问")
    share, action = row
    request_hash = collaboration_request_hash({
        "operation": "revoke_share",
        "owner_user_id": user_id,
        "meeting_id": meeting_id,
        "client_action_id": client_action_id,
        "client_share_id": client_share_id,
        "expected_share_revision": expected_share_revision,
    })
    try:
        result = await revoke_action_share(
            db,
            owner_user_id=user_id,
            action=action,
            share=share,
            expected_share_revision=expected_share_revision,
            idempotency_key=idempotency_key,
            request_hash=request_hash,
        )
    except CollaborationConflict as error:
        return _collaboration_conflict_response(error)
    except SQLAlchemyError as error:
        raise HTTPException(status_code=503, detail="共享链接暂时无法撤销，请稍后重试") from error
    return JSONResponse(
        status_code=result.status_code,
        headers={
            "ETag": f'"{result.payload["revision"]}"',
            "X-Idempotent-Replay": "true" if result.replayed else "false",
        },
        content=result.payload,
    )


@router.get("/v2/meeting-notes/{meeting_id}/shares")
async def get_meeting_content_shares_v1(
    meeting_id: str,
    current_user: dict = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    user_id = int(current_user["id"])
    meeting_id = _identifier(meeting_id, "会议标识", maximum=160)
    meeting = (await db.execute(
        select(Meeting.id).where(Meeting.id == meeting_id, Meeting.user_id == user_id)
    )).scalar_one_or_none()
    if meeting is None:
        raise HTTPException(status_code=404, detail="会议记录不存在或无权访问")
    try:
        rows = (await db.execute(
            select(MeetingContentShare).where(
                MeetingContentShare.owner_user_id == user_id,
                MeetingContentShare.meeting_id == meeting_id,
            ).order_by(
                MeetingContentShare.created_at.desc(),
                MeetingContentShare.id.desc(),
            )
        )).scalars().all()
        items = [owner_share_payload_with_invite(row) for row in rows]
    except MeetingContentShareConfigurationError as error:
        raise HTTPException(status_code=503, detail="会议资料共享服务尚未配置") from error
    except SQLAlchemyError as error:
        raise HTTPException(status_code=503, detail="共享链接暂时无法读取，请稍后重试") from error
    return {"schema_version": 1, "items": items}


@router.post("/v2/meeting-notes/{meeting_id}/shares")
async def post_meeting_content_share_v1(
    meeting_id: str,
    data: MeetingContentShareV1Create,
    idempotency_key: str = Header(alias="Idempotency-Key"),
    current_user: dict = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    user_id = int(current_user["id"])
    if is_user_meeting_tombstoned(user_id):
        raise HTTPException(status_code=409, detail="账号正在删除，不能创建共享链接")
    meeting_id = _identifier(meeting_id, "会议标识", maximum=160)
    client_share_id = _identifier(data.client_share_id, "共享标识")
    idempotency_key = _identifier(idempotency_key, "请求标识", minimum=8, maximum=512)
    meeting = (await db.execute(
        select(Meeting.id).where(Meeting.id == meeting_id, Meeting.user_id == user_id)
    )).scalar_one_or_none()
    if meeting is None:
        raise HTTPException(status_code=404, detail="会议记录不存在或无权访问")
    content_scope = list(data.content_scope)
    frozen_payload = data.frozen_payload.model_dump(mode="json")
    request_hash = meeting_content_share_request_hash({
        "operation": "create_share",
        "owner_user_id": user_id,
        "meeting_id": meeting_id,
        "client_share_id": client_share_id,
        "content_scope": content_scope,
        "frozen_payload": frozen_payload,
        "follow_latest_summary": data.follow_latest_summary,
    })
    try:
        result = await create_meeting_content_share(
            db,
            owner_user_id=user_id,
            meeting_id=meeting_id,
            client_share_id=client_share_id,
            content_scope=content_scope,
            frozen_payload=frozen_payload,
            follow_latest_summary=data.follow_latest_summary,
            source_summary_version_id=data.frozen_payload.source_summary_version_id,
            idempotency_key=idempotency_key,
            request_hash=request_hash,
        )
    except MeetingContentShareConflict as error:
        return _meeting_content_share_conflict_response(error)
    except MeetingContentShareConfigurationError as error:
        raise HTTPException(status_code=503, detail="会议资料共享服务尚未配置") from error
    except ValueError as error:
        raise HTTPException(status_code=413, detail="共享内容过大，请减少后重试") from error
    except SQLAlchemyError as error:
        raise HTTPException(status_code=503, detail="共享链接暂时无法创建，请稍后重试") from error
    return JSONResponse(
        status_code=result.status_code,
        headers={
            "ETag": f'"{result.payload["revision"]}"',
            "X-Idempotent-Replay": "true" if result.replayed else "false",
        },
        content=result.payload,
    )


@router.delete("/v2/meeting-notes/{meeting_id}/shares/{client_share_id}")
async def delete_meeting_content_share_v1(
    meeting_id: str,
    client_share_id: str,
    idempotency_key: str = Header(alias="Idempotency-Key"),
    if_match: str | None = Header(default=None, alias="If-Match"),
    current_user: dict = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    user_id = int(current_user["id"])
    meeting_id = _identifier(meeting_id, "会议标识", maximum=160)
    client_share_id = _identifier(client_share_id, "共享标识")
    idempotency_key = _identifier(idempotency_key, "请求标识", minimum=8, maximum=512)
    expected_share_revision = _collaboration_revision(if_match, "共享")
    share = (await db.execute(
        select(MeetingContentShare).where(
            MeetingContentShare.owner_user_id == user_id,
            MeetingContentShare.meeting_id == meeting_id,
            MeetingContentShare.client_share_id == client_share_id,
        )
    )).scalar_one_or_none()
    if share is None:
        raise HTTPException(status_code=404, detail="共享链接不存在或无权访问")
    request_hash = meeting_content_share_request_hash({
        "operation": "revoke_share",
        "owner_user_id": user_id,
        "meeting_id": meeting_id,
        "client_share_id": client_share_id,
        "expected_share_revision": expected_share_revision,
    })
    try:
        result = await revoke_meeting_content_share(
            db,
            owner_user_id=user_id,
            share=share,
            expected_share_revision=expected_share_revision,
            idempotency_key=idempotency_key,
            request_hash=request_hash,
        )
    except MeetingContentShareConflict as error:
        return _meeting_content_share_conflict_response(error)
    except SQLAlchemyError as error:
        raise HTTPException(status_code=503, detail="共享链接暂时无法撤销，请稍后重试") from error
    return JSONResponse(
        status_code=result.status_code,
        headers={
            "ETag": f'"{result.payload["revision"]}"',
            "X-Idempotent-Replay": "true" if result.replayed else "false",
        },
        content=result.payload,
    )


def _collaboration_token(value: str) -> str:
    normalized = value.strip()
    if not re.fullmatch(r"[A-Za-z0-9_-]{32,256}", normalized):
        raise HTTPException(status_code=404, detail="共享链接无效或已失效")
    return normalized


@router.get("/v2/shared-actions/{token}")
async def get_shared_action_v1(
    token: str,
    db: AsyncSession = Depends(get_db),
):
    found = await find_share_by_token(db, _collaboration_token(token))
    if found is None:
        raise HTTPException(status_code=404, detail="共享链接无效或已失效")
    share, action = found
    if share.status != "active":
        raise HTTPException(status_code=410, detail="共享链接已撤销")
    payload = shared_action_payload(share, action, actor_label="共享者")
    return JSONResponse(
        status_code=200,
        headers={"ETag": f'"{action.revision}"'},
        content=payload,
    )


@router.get("/v2/shared-meetings/{token}")
async def get_shared_meeting_content_v1(
    token: str,
    db: AsyncSession = Depends(get_db),
):
    share = await find_meeting_content_share_by_token(db, _collaboration_token(token))
    if share is None:
        raise HTTPException(status_code=404, detail="共享链接无效或已失效")
    if share.status != "active":
        raise HTTPException(status_code=410, detail="共享链接已撤销")
    try:
        payload = await public_share_payload(db, share)
    except (ValueError, SQLAlchemyError) as error:
        raise HTTPException(status_code=503, detail="共享内容暂时无法读取，请稍后重试") from error
    return JSONResponse(
        status_code=200,
        headers={"ETag": f'"{share.revision}"'},
        content=payload,
    )


@router.put("/v2/shared-actions/{token}")
async def put_shared_action_v1(
    token: str,
    data: SharedActionV1Update,
    idempotency_key: str = Header(alias="Idempotency-Key"),
    if_match: str | None = Header(default=None, alias="If-Match"),
    db: AsyncSession = Depends(get_db),
):
    token = _collaboration_token(token)
    idempotency_key = _identifier(idempotency_key, "请求标识", minimum=8, maximum=512)
    actor_id = _identifier(data.actor_id, "协作者标识", minimum=16, maximum=160)
    expected_action_revision = _collaboration_revision(if_match, "行动项")
    assignee = data.assignee.strip() if isinstance(data.assignee, str) and data.assignee.strip() else None
    if assignee is not None and "\x00" in assignee:
        raise HTTPException(status_code=422, detail="行动项负责人无效")
    found = await find_share_by_token(db, token)
    if found is None:
        raise HTTPException(status_code=404, detail="共享链接无效或已失效")
    share, action = found
    request_hash = collaboration_request_hash({
        "operation": "update_shared_action",
        "share_id": share.id,
        "actor_id": actor_id,
        "expected_action_revision": expected_action_revision,
        "status": data.status,
        "assignee": assignee,
        "due_at_ms": data.due_at_ms,
    })
    try:
        result = await update_shared_action(
            db,
            share=share,
            action=action,
            actor_id=actor_id,
            expected_action_revision=expected_action_revision,
            idempotency_key=idempotency_key,
            request_hash=request_hash,
            status=data.status,
            assignee=assignee,
            due_at_ms=data.due_at_ms,
        )
    except CollaborationConflict as error:
        return _collaboration_conflict_response(error)
    except SQLAlchemyError as error:
        raise HTTPException(status_code=503, detail="共享待办暂时无法更新，请稍后重试") from error
    return JSONResponse(
        status_code=result.status_code,
        headers={
            "ETag": f'"{result.payload["action"]["revision"]}"',
            "X-Idempotent-Replay": "true" if result.replayed else "false",
        },
        content=result.payload,
    )
