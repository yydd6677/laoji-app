import hashlib
import json
import mimetypes
import subprocess
import unicodedata
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Literal
from zoneinfo import ZoneInfo

from anyio import open_file, to_thread
from fastapi import APIRouter, Body, Depends, File, Header, HTTPException, Query, UploadFile
from fastapi.responses import FileResponse, Response
from pydantic import BaseModel, Field
from sqlalchemy import case, exists, func, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.meetings import _ensure_final_summary
from app.config import settings
from app.database import get_db
from app.laoji.auth_router import get_current_user
from app.models.meeting import Meeting
from app.models.meeting_note_root import MeetingNoteRootV2
from app.models.meeting_recording_asset import (
    MeetingRecordingAssetV2,
    MeetingRecordingTranscriptionJobV2,
)
from app.models.meeting_question import (
    MeetingQuestionCitation,
    MeetingQuestionThread,
    MeetingQuestionTurn,
)
from app.models.summary import FinalSummary
from app.models.transcript import TranscriptLine
from app.services.account_deletion_service import is_user_meeting_tombstoned
from app.services.guest_meeting_session_service import (
    GuestSessionCapacityError,
    create_guest_meeting_session,
    list_guest_transcripts,
    revoke_guest_meeting_session,
)
from app.services.meeting_note_root_service import (
    ensure_legacy_meeting_root,
    soft_delete_legacy_meeting,
    touch_legacy_meeting_root,
)
from app.services.meeting_recording_asset_service import (
    project_compat_media_upload,
    submit_transcription_job,
)
from app.services.meeting_summary_sync_service import get_effective_current_summary_document
from app.services.storage_admission import ensure_audio_upload_allowed
from app.services.app_meeting_question import (
    INSUFFICIENT_ANSWER,
    generate_meeting_question_answer,
    meeting_question_input_fingerprint,
    meeting_question_request_hash,
)
from app.workers.summary_tasks import (
    brief_greeting_summary,
    build_structured_summary_payload,
    get_summary_template,
    summary_payload_fingerprint,
    structured_summary_from_raw_json,
    submit_final_summary,
    submit_guest_summary,
    wait_for_guest_summary_status,
    wait_for_submitted_summary_status,
)

router = APIRouter()


def _default_summary_template_revision() -> int:
    """Use the current template revision when old clients omit the field."""
    return int(get_summary_template("general")["revision"])

ALLOWED_AUDIO_EXTENSIONS = {
    '.wav', '.mp3', '.m4a', '.aac', '.ogg', '.webm', '.flac',
    '.mp4', '.mov', '.mkv',
}


class AppMeetingCreate(BaseModel):
    title: str = Field(max_length=255)
    description: str | None = None
    participants: list[str] = Field(default_factory=list)
    mode: Literal['realtime', 'offline', 'whisper', 'qwen'] = 'realtime'
    location: str | None = Field(default=None, max_length=500)
    recorded_at: datetime | None = None
    client_request_id: str | None = Field(
        default=None,
        min_length=8,
        max_length=96,
        pattern=r'^[A-Za-z0-9][A-Za-z0-9._:-]+$',
    )


class AppMeetingUpdate(BaseModel):
    title: str | None = Field(default=None, max_length=255)
    description: str | None = None
    status: str | None = None
    participants: list[str] | None = None
    mode: Literal['realtime', 'offline', 'whisper', 'qwen'] | None = None
    location: str | None = Field(default=None, max_length=500)


class GuestTranscriptLine(BaseModel):
    id: str | None = Field(default=None, max_length=240)
    speaker_label: str | None = Field(default=None, max_length=120)
    speaker_id: str | None = Field(default=None, max_length=120)
    text: str = Field(min_length=1, max_length=2000)
    start_time: float | None = None
    end_time: float | None = None
    confidence: float | None = None


class GuestSummaryRequest(BaseModel):
    meeting_id: str = Field(min_length=1, max_length=160)
    title: str | None = Field(default=None, max_length=255)
    meeting_date: str | None = Field(default=None, pattern=r"^\d{4}-\d{2}-\d{2}$")
    template_id: str = Field(default='general', min_length=1, max_length=40)
    template_revision: int = Field(default_factory=_default_summary_template_revision, ge=1, le=2_147_483_647)
    transcript_lines: list[GuestTranscriptLine] = Field(min_length=1)
    force: bool = False
    carry_forward: 'SummaryCarryForwardAuthorization | None' = None
    attachment_authorization: 'SummaryAttachmentAuthorization | None' = None


class SummaryCarryForwardItem(BaseModel):
    kind: Literal['decision', 'action']
    source_meeting_id: str = Field(min_length=1, max_length=160)
    source_item_id: str = Field(min_length=1, max_length=512)
    source_title: str = Field(default='', max_length=255)
    source_occurrence_date: str = Field(pattern=r"^\d{4}-\d{2}-\d{2}$")
    content: str = Field(min_length=1, max_length=2000)
    assignee: str | None = Field(default=None, max_length=200)
    due_at: datetime | None = None


class SummaryCarryForwardAuthorization(BaseModel):
    request_id: str = Field(
        min_length=8,
        max_length=96,
        pattern=r'^[A-Za-z0-9][A-Za-z0-9._:-]+$',
    )
    items: list[SummaryCarryForwardItem] = Field(min_length=1, max_length=8)


class SummaryAttachmentItem(BaseModel):
    attachment_id: str = Field(min_length=1, max_length=512)
    kind: Literal['text']
    position_ms: int = Field(ge=0, le=2_147_483_647)
    content: str = Field(min_length=1, max_length=2000)
    content_sha256: str = Field(pattern=r'^sha256:[0-9a-f]{64}$')
    updated_at_ms: int = Field(ge=0, le=9_007_199_254_740_991)


class SummaryAttachmentAuthorization(BaseModel):
    request_id: str = Field(
        min_length=8,
        max_length=96,
        pattern=r'^[A-Za-z0-9][A-Za-z0-9._:-]+$',
    )
    items: list[SummaryAttachmentItem] = Field(min_length=1, max_length=12)


class AppSummaryGenerateRequest(BaseModel):
    carry_forward: SummaryCarryForwardAuthorization | None = None
    attachment_authorization: SummaryAttachmentAuthorization | None = None


class MeetingQuestionTranscriptSource(BaseModel):
    segment_id: str = Field(min_length=1, max_length=512)
    source_segment_id: str | None = Field(default=None, max_length=512)
    start_ms: int = Field(ge=0, le=9_007_199_254_740_991)
    end_ms: int = Field(ge=0, le=9_007_199_254_740_991)
    speaker: str | None = Field(default=None, max_length=500)
    text: str = Field(min_length=1, max_length=8000)


class MeetingQuestionSummarySource(BaseModel):
    section_id: str = Field(min_length=1, max_length=512)
    title: str | None = Field(default=None, max_length=200)
    text: str = Field(min_length=1, max_length=20000)


class MeetingQuestionManualNoteSource(BaseModel):
    revision: int = Field(ge=0, le=9_007_199_254_740_991)
    content: str = Field(min_length=1, max_length=200000)


class MeetingQuestionCitationRef(BaseModel):
    kind: Literal['transcript', 'summary', 'manual_note']
    source_id: str = Field(min_length=1, max_length=512)


class MeetingQuestionContextTurn(BaseModel):
    ordinal: int = Field(ge=0, le=10000)
    question: str = Field(min_length=1, max_length=2000)
    answer_scope: Literal['meeting', 'general'] = 'meeting'
    answer_kind: Literal['answer', 'insufficient']
    answer: str = Field(min_length=1, max_length=20000)
    citations: list[MeetingQuestionCitationRef] = Field(default_factory=list, max_length=20)


class MeetingQuestionRequest(BaseModel):
    schema_version: Literal[1]
    client_meeting_id: str = Field(min_length=1, max_length=512)
    client_thread_id: str = Field(min_length=1, max_length=512)
    client_request_id: str = Field(min_length=1, max_length=512)
    expected_ordinal: int = Field(ge=0, le=10000)
    input_fingerprint: str = Field(pattern=r'^sha256:[0-9a-f]{64}$')
    transcript_revision_id: str = Field(min_length=1, max_length=512)
    summary_version_id: str | None = Field(default=None, max_length=512)
    manual_note_revision: int | None = Field(default=None, ge=0, le=9_007_199_254_740_991)
    include_manual_note: bool
    question: str = Field(min_length=1, max_length=2000)
    transcript_segments: list[MeetingQuestionTranscriptSource] = Field(min_length=1, max_length=5000)
    summary_sections: list[MeetingQuestionSummarySource] = Field(default_factory=list, max_length=200)
    manual_note: MeetingQuestionManualNoteSource | None = None
    context: list[MeetingQuestionContextTurn] = Field(default_factory=list, max_length=12)


GuestSummaryRequest.model_rebuild()


class GuestRealtimeSessionCreate(BaseModel):
    title: str | None = Field(default=None, max_length=255)


class GuestImportTranscriptLine(BaseModel):
    id: str | None = Field(default=None, max_length=160)
    speaker_id: str | None = Field(default=None, max_length=120)
    speaker_label: str | None = Field(default=None, max_length=120)
    text: str = Field(min_length=1, max_length=2000)
    start_time: float | None = None
    end_time: float | None = None
    confidence: float | None = None
    created_at: datetime | None = None


class GuestImportSummary(BaseModel):
    overview: str | None = Field(default=None, max_length=20000)
    full_text: str | None = Field(default=None, max_length=50000)
    markdown: str | None = Field(default=None, max_length=50000)
    key_decisions: list[str] = Field(default_factory=list)
    action_items: list[dict] = Field(default_factory=list)
    generated_at: datetime | None = None


class GuestMeetingImportRequest(BaseModel):
    source_meeting_id: str = Field(min_length=1, max_length=160)
    transcripts: list[GuestImportTranscriptLine] = Field(default_factory=list, max_length=5000)
    summary: GuestImportSummary | None = None


def _participants(meeting: Meeting) -> list[str]:
    if not meeting.participants:
        return []
    try:
        data = json.loads(meeting.participants)
        return data if isinstance(data, list) else []
    except Exception:
        return []


def _meeting_to_dict(
    meeting: Meeting,
    *,
    transcript_count: int = 0,
    summary_available: bool = False,
) -> dict:
    return {
        'id': meeting.id,
        'title': meeting.title,
        'description': meeting.description,
        'location': meeting.location,
        'status': meeting.status,
        'mode': meeting.mode or 'realtime',
        'participants': _participants(meeting),
        'client_request_id': meeting.client_request_id,
        'recorded_at': meeting.recorded_at.isoformat() if meeting.recorded_at else None,
        'created_at': meeting.created_at.isoformat() if meeting.created_at else None,
        'updated_at': meeting.updated_at.isoformat() if meeting.updated_at else None,
        'audio_available': bool(meeting.audio_path),
        'audio_mime_type': meeting.audio_mime_type,
        'audio_file_name': meeting.audio_file_name,
        'audio_duration_sec': meeting.audio_duration_sec,
        'transcript_count': transcript_count,
        'transcript_available': transcript_count > 0,
        'summary_available': summary_available,
    }


async def _meeting_availability(db: AsyncSession, meeting_ids: list[str]) -> dict[str, dict]:
    if not meeting_ids:
        return {}
    transcript_rows = (
        await db.execute(
            select(TranscriptLine.meeting_id, func.count(TranscriptLine.id))
            .where(TranscriptLine.meeting_id.in_(meeting_ids))
            .group_by(TranscriptLine.meeting_id)
        )
    ).all()
    summary_ids = set(
        (
            await db.execute(
                select(FinalSummary.meeting_id)
                .where(FinalSummary.meeting_id.in_(meeting_ids))
                .distinct()
            )
        ).scalars().all()
    )
    transcript_counts = {str(meeting_id): int(count) for meeting_id, count in transcript_rows}
    return {
        meeting_id: {
            'transcript_count': transcript_counts.get(meeting_id, 0),
            'summary_available': meeting_id in summary_ids,
        }
        for meeting_id in meeting_ids
    }


async def _meeting_to_dict_with_availability(db: AsyncSession, meeting: Meeting) -> dict:
    availability = await _meeting_availability(db, [meeting.id])
    return _meeting_to_dict(meeting, **availability.get(meeting.id, {}))


def _user_id(current_user: dict) -> int:
    return int(current_user['id'])


def _assert_user_meeting_writable(user_id: int) -> None:
    if is_user_meeting_tombstoned(user_id):
        raise HTTPException(status_code=409, detail='账号正在删除，不能修改会议')


def _meeting_local_date(meeting: Meeting) -> str | None:
    recorded_at = getattr(meeting, 'recorded_at', None) or meeting.created_at
    if recorded_at is None:
        return None
    value = recorded_at
    if value.tzinfo is None:
        value = value.replace(tzinfo=timezone.utc)
    return value.astimezone(ZoneInfo('Asia/Shanghai')).date().isoformat()


def _summary_template_or_422(
    template_id: str,
    template_revision: int | None,
) -> dict:
    try:
        return get_summary_template(template_id, template_revision)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc


def _structured_summary_markdown(payload: dict) -> str:
    sections = payload.get('sections')
    if not isinstance(sections, list):
        return ''
    rendered = []
    for section in sections:
        if not isinstance(section, dict):
            continue
        title = str(section.get('title') or '').strip()
        content = str(section.get('content') or '').strip()
        if not title or not content:
            continue
        if section.get('kind') == 'paragraph':
            body = content
        else:
            body = '\n'.join(
                f'- {line.strip()}' for line in content.splitlines() if line.strip()
            )
        rendered.append(f'## {title}\n\n{body}')
    return '\n\n'.join(rendered)


def _preserve_contextual_structured_summary(payload: dict | None) -> bool:
    if not payload:
        return False
    return bool(payload.get('carry_forward_request_id')) or bool(payload.get('attachment_request_id')) or (
        payload.get('template_id') != 'general'
        or payload.get('template_revision') != get_summary_template('general')['revision']
    )


def _summary_carry_forward_payload(
    authorization: SummaryCarryForwardAuthorization | None,
) -> dict | None:
    if authorization is None:
        return None
    identities: set[tuple[str, str, str]] = set()
    total_chars = 0
    for item in authorization.items:
        identity = (item.kind, item.source_meeting_id, item.source_item_id)
        if identity in identities:
            raise HTTPException(status_code=422, detail='历史参考内容存在重复项')
        identities.add(identity)
        total_chars += len(item.content.strip()) + len(item.source_title.strip())
        if not item.content.strip():
            raise HTTPException(status_code=422, detail='历史参考内容为空')
    if total_chars > 12_000:
        raise HTTPException(status_code=422, detail='历史参考内容过多，请减少选择后重试')
    return authorization.model_dump(mode='json')


def _summary_attachment_payload(
    authorization: SummaryAttachmentAuthorization | None,
) -> dict | None:
    if authorization is None:
        return None
    identities: set[str] = set()
    total_chars = 0
    items = []
    for item in authorization.items:
        attachment_id = item.attachment_id.strip()
        content = item.content.replace('\r\n', '\n').replace('\r', '\n').strip()
        if (
            not attachment_id
            or any(ord(character) < 32 or ord(character) == 127 for character in attachment_id)
            or not content
        ):
            raise HTTPException(status_code=422, detail='附件内容无效')
        if attachment_id in identities:
            raise HTTPException(status_code=422, detail='附件存在重复项')
        identities.add(attachment_id)
        expected_hash = f"sha256:{hashlib.sha256(content.encode('utf-8')).hexdigest()}"
        if item.content_sha256 != expected_hash:
            raise HTTPException(status_code=409, detail='附件内容已变化，请重新选择')
        total_chars += len(content)
        items.append({
            'attachment_id': attachment_id,
            'kind': 'text',
            'position_ms': item.position_ms,
            'content': content,
            'content_sha256': expected_hash,
            'updated_at_ms': item.updated_at_ms,
        })
    if total_chars > 12_000:
        raise HTTPException(status_code=422, detail='附件内容过多，请减少选择后重试')
    return {'request_id': authorization.request_id, 'items': items}


def _question_identifier(value: str, label: str) -> str:
    normalized = value.strip()
    if (
        not normalized
        or normalized != value
        or any(ord(character) < 32 or ord(character) == 127 for character in normalized)
    ):
        raise HTTPException(status_code=422, detail=f'{label}无效')
    return normalized


def _question_text(value: str, label: str) -> str:
    normalized = unicodedata.normalize('NFC', value.replace('\r\n', '\n').replace('\r', '\n')).strip()
    if not normalized or '\x00' in normalized:
        raise HTTPException(status_code=422, detail=f'{label}无效')
    return normalized


def _question_context_text(value: str, label: str) -> str:
    normalized = unicodedata.normalize('NFC', value.replace('\r\n', '\n').replace('\r', '\n')).strip()
    if not normalized or '\x00' in normalized:
        raise HTTPException(status_code=422, detail=f'{label}无效')
    return normalized


def _meeting_question_payload(data: MeetingQuestionRequest) -> dict:
    payload = data.model_dump(mode='json')
    for key, label in (
        ('client_meeting_id', '本机会议标识'),
        ('client_thread_id', '问答记录标识'),
        ('client_request_id', '问答请求标识'),
        ('transcript_revision_id', '文字记录版本'),
    ):
        _question_identifier(payload[key], label)
    if payload['summary_version_id'] is not None:
        _question_identifier(payload['summary_version_id'], '整理结果版本')
    _question_text(payload['question'], '问题')

    segment_ids: set[str] = set()
    total_chars = len(payload['question'])
    for segment in payload['transcript_segments']:
        segment_id = _question_identifier(segment['segment_id'], '文字记录片段标识')
        if segment_id in segment_ids:
            raise HTTPException(status_code=422, detail='文字记录包含重复片段')
        segment_ids.add(segment_id)
        if segment['source_segment_id'] is not None:
            _question_identifier(segment['source_segment_id'], '文字记录来源标识')
        if segment['end_ms'] < segment['start_ms']:
            raise HTTPException(status_code=422, detail='文字记录片段时间无效')
        _question_text(segment['text'], '文字记录内容')
        if segment['speaker'] is not None and '\x00' in segment['speaker']:
            raise HTTPException(status_code=422, detail='讲话人名称无效')
        total_chars += len(segment['text'])

    section_ids: set[str] = set()
    for section in payload['summary_sections']:
        section_id = _question_identifier(section['section_id'], '整理结果段落标识')
        if section_id in section_ids:
            raise HTTPException(status_code=422, detail='整理结果包含重复段落')
        section_ids.add(section_id)
        _question_text(section['text'], '整理结果内容')
        if section['title'] is not None and '\x00' in section['title']:
            raise HTTPException(status_code=422, detail='整理结果标题无效')
        total_chars += len(section['text'])
    if bool(payload['summary_version_id']) != bool(payload['summary_sections']):
        raise HTTPException(status_code=422, detail='整理结果版本与内容不一致')

    manual_note = payload['manual_note']
    if payload['include_manual_note']:
        if (
            manual_note is None
            or payload['manual_note_revision'] is None
            or manual_note['revision'] != payload['manual_note_revision']
        ):
            raise HTTPException(status_code=422, detail='我的笔记授权范围无效')
        _question_text(manual_note['content'], '我的笔记内容')
        total_chars += len(manual_note['content'])
    elif manual_note is not None or payload['manual_note_revision'] is not None:
        raise HTTPException(status_code=422, detail='未授权时不能发送我的笔记')
    if total_chars > 2_000_000:
        raise HTTPException(status_code=413, detail='会议内容过长，暂时无法问答')

    allowed_sources = {
        ('transcript', source_id) for source_id in segment_ids
    } | {
        ('summary', source_id) for source_id in section_ids
    }
    if payload['include_manual_note']:
        allowed_sources.add(('manual_note', f"manual-note:{payload['manual_note_revision']}"))
    context = payload['context']
    expected_start = payload['expected_ordinal'] - len(context)
    if expected_start < 0:
        raise HTTPException(status_code=422, detail='问答上下文轮次无效')
    for index, turn in enumerate(context):
        if turn['ordinal'] != expected_start + index:
            raise HTTPException(status_code=422, detail='问答上下文轮次不连续')
        turn['question'] = _question_context_text(turn['question'], '历史问题')
        turn['answer'] = _question_context_text(turn['answer'], '历史回答')
        identities: set[tuple[str, str]] = set()
        for citation in turn['citations']:
            identity = (citation['kind'], _question_identifier(citation['source_id'], '历史回答来源'))
            if identity not in allowed_sources or identity in identities:
                raise HTTPException(status_code=409, detail='历史回答来源与当前会议版本不一致')
            identities.add(identity)
        if (
            turn['answer_scope'] == 'meeting'
            and turn['answer_kind'] == 'answer'
            and not identities
        ):
            raise HTTPException(status_code=422, detail='历史回答缺少来源')
        if turn['answer_scope'] == 'meeting' and turn['answer_kind'] == 'insufficient' and (
            turn['answer'] != INSUFFICIENT_ANSWER or identities
        ):
            raise HTTPException(status_code=422, detail='历史无来源回答格式无效')
        if turn['answer_scope'] == 'general' and (
            turn['answer_kind'] != 'answer' or identities
        ):
            raise HTTPException(status_code=422, detail='历史普通回答格式无效')

    expected_fingerprint = meeting_question_input_fingerprint(payload)
    if payload['input_fingerprint'] != expected_fingerprint:
        raise HTTPException(status_code=409, detail='会议问答来源已变化，请重新打开问答')
    return payload


async def _assert_owned_carry_forward_sources(
    payload: dict | None,
    *,
    user_id: int,
    current_meeting_id: str,
    db: AsyncSession,
) -> None:
    if payload is None:
        return
    source_ids = {str(item['source_meeting_id']) for item in payload['items']}
    if current_meeting_id in source_ids:
        raise HTTPException(status_code=422, detail='不能把本次会议作为历史参考')
    owned_ids = set((await db.execute(
        select(Meeting.id).where(
            Meeting.user_id == user_id,
            Meeting.id.in_(source_ids),
            _meeting_is_active_clause(),
        )
    )).scalars().all())
    if owned_ids != source_ids:
        raise HTTPException(status_code=409, detail='历史参考来源已变化，请重新选择')


def _datetime_ms(value: datetime) -> int:
    if value.tzinfo is None:
        value = value.replace(tzinfo=timezone.utc)
    return max(0, int(value.timestamp() * 1000))


def _question_thread_matches(thread: MeetingQuestionThread, payload: dict) -> bool:
    return (
        thread.input_fingerprint == payload['input_fingerprint']
        and thread.transcript_revision_id == payload['transcript_revision_id']
        and thread.summary_version_id == payload['summary_version_id']
        and thread.manual_note_revision == payload['manual_note_revision']
        and bool(thread.include_manual_note) == payload['include_manual_note']
    )


def _question_citations_belong_to_payload(
    citations: list[dict[str, str]],
    payload: dict,
) -> bool:
    """Fail closed for stored/idempotent turns as well as fresh model output."""
    allowed = {
        ("transcript", str(item["segment_id"]))
        for item in payload.get("transcript_segments") or []
    }
    allowed.update(
        ("summary", str(item["section_id"]))
        for item in payload.get("summary_sections") or []
    )
    if payload.get("include_manual_note") and payload.get("manual_note") is not None:
        allowed.add(("manual_note", f"manual-note:{payload['manual_note']['revision']}"))
    seen: set[tuple[str, str]] = set()
    for item in citations:
        identity = (str(item.get("kind") or ""), str(item.get("source_id") or ""))
        if identity not in allowed or identity in seen:
            return False
        seen.add(identity)
    return True


async def _meeting_question_response(
    db: AsyncSession,
    *,
    payload: dict,
    answer: dict,
    created_at: datetime,
    completed_at: datetime,
    thread: MeetingQuestionThread | None,
    turn: MeetingQuestionTurn | None,
    transient: bool,
) -> dict:
    if turn is not None:
        citations = [
            {'kind': citation.kind, 'source_id': citation.source_id}
            for citation in (
                await db.execute(
                    select(MeetingQuestionCitation)
                    .where(MeetingQuestionCitation.turn_id == turn.id)
                    .order_by(MeetingQuestionCitation.ordinal, MeetingQuestionCitation.id)
                )
            ).scalars().all()
        ]
        stored_answer_is_safe = _question_citations_belong_to_payload(citations, payload)
        if turn.answer_scope == 'meeting' and turn.answer_kind == 'answer' and not citations:
            stored_answer_is_safe = False
        if turn.answer_scope == 'meeting' and turn.answer_kind == 'insufficient' and citations:
            stored_answer_is_safe = False
        if turn.answer_scope == 'general' and (turn.answer_kind != 'answer' or citations):
            stored_answer_is_safe = False
        answer = (
            {
                'answer_scope': turn.answer_scope,
                'answer_kind': turn.answer_kind,
                'answer': turn.answer,
                'citations': citations,
            }
            if stored_answer_is_safe
            else {
                'answer_scope': 'meeting',
                'answer_kind': 'insufficient',
                'answer': INSUFFICIENT_ANSWER,
                'citations': [],
            }
        )
        created_at = turn.created_at
        completed_at = turn.completed_at
    return {
        'schema_version': 1,
        'client_meeting_id': payload['client_meeting_id'],
        'client_thread_id': payload['client_thread_id'],
        'client_request_id': payload['client_request_id'],
        'remote_thread_id': thread.id if thread is not None else None,
        'remote_turn_id': turn.id if turn is not None else None,
        'ordinal': payload['expected_ordinal'],
        'input_fingerprint': payload['input_fingerprint'],
        'transcript_revision_id': payload['transcript_revision_id'],
        'summary_version_id': payload['summary_version_id'],
        'manual_note_revision': payload['manual_note_revision'],
        'answer_scope': answer.get('answer_scope', 'meeting'),
        'answer_kind': answer['answer_kind'],
        'answer': answer['answer'],
        'citations': answer['citations'],
        'created_at_ms': _datetime_ms(created_at),
        'completed_at_ms': _datetime_ms(completed_at),
        'transient': transient,
    }


async def _find_meeting_question_thread(
    db: AsyncSession,
    *,
    user_id: int,
    meeting_id: str,
    client_thread_id: str,
) -> MeetingQuestionThread | None:
    return (
        await db.execute(
            select(MeetingQuestionThread).where(
                MeetingQuestionThread.user_id == user_id,
                MeetingQuestionThread.meeting_id == meeting_id,
                MeetingQuestionThread.client_thread_id == client_thread_id,
            )
        )
    ).scalar_one_or_none()


async def _find_meeting_question_turn(
    db: AsyncSession,
    *,
    thread_id: str,
    client_request_id: str,
) -> MeetingQuestionTurn | None:
    return (
        await db.execute(
            select(MeetingQuestionTurn).where(
                MeetingQuestionTurn.thread_id == thread_id,
                MeetingQuestionTurn.client_request_id == client_request_id,
            )
        )
    ).scalar_one_or_none()


def _naive_utc(value: datetime | None) -> datetime | None:
    if value is None:
        return None
    if value.tzinfo is None:
        return value
    return value.astimezone(timezone.utc).replace(tzinfo=None)


def _stable_import_uuid(*parts: object) -> str:
    identity = ':'.join(str(part) for part in parts)
    return str(uuid.uuid5(uuid.NAMESPACE_URL, f'laoji-guest-import:{identity}'))


async def _get_owned_meeting(meeting_id: str, user_id: int, db: AsyncSession) -> Meeting:
    result = await db.execute(
        select(Meeting).where(
            Meeting.id == meeting_id,
            Meeting.user_id == user_id,
            _meeting_is_active_clause(),
        )
    )
    meeting = result.scalar_one_or_none()
    if meeting is None:
        raise HTTPException(status_code=404, detail='会议不存在或无权访问')
    return meeting


def _meeting_is_active_clause():
    return ~exists().where(
        MeetingNoteRootV2.meeting_id == Meeting.id,
        MeetingNoteRootV2.lifecycle == "deleted",
    )


def _safe_audio_name(filename: str | None) -> tuple[str, str]:
    raw = (filename or 'recording.wav').replace('\\', '/').split('/')[-1]
    stem = Path(raw).stem[:80] or 'recording'
    ext = Path(raw).suffix.lower() or '.wav'
    if ext not in ALLOWED_AUDIO_EXTENSIONS:
        raise HTTPException(status_code=400, detail=f'不支持的音频格式: {ext}')
    safe_stem = ''.join(ch if ch.isalnum() or ch in {'-', '_'} else '_' for ch in stem).strip('_') or 'recording'
    return f'{safe_stem}{ext}', ext


def _storage_dir(user_id: int) -> Path:
    path = Path(settings.audio_storage_abs_path) / 'app-meetings' / f'user-{user_id}'
    path.mkdir(parents=True, exist_ok=True)
    return path


def _probe_duration_sec(path: Path) -> float | None:
    try:
        result = subprocess.run(
            ['ffprobe', '-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', str(path)],
            capture_output=True,
            text=True,
            timeout=10,
        )
        if result.returncode == 0:
            value = float((result.stdout or '').strip())
            return round(value, 3) if value > 0 else None
    except Exception:
        return None
    return None


async def _save_audio_file(
    meeting: Meeting,
    user_id: int,
    file: UploadFile,
    db: AsyncSession,
) -> Path:
    safe_name, ext = _safe_audio_name(file.filename)
    target = _storage_dir(user_id) / f'{meeting.id}_{uuid.uuid4().hex}{ext}'
    temporary = target.with_name(f'.{target.name}.part')
    total_bytes = 0
    try:
        async with await open_file(temporary, 'xb') as output:
            while chunk := await file.read(settings.MEETING_AUDIO_CHUNK_BYTES):
                total_bytes += len(chunk)
                if total_bytes > settings.MEETING_AUDIO_MAX_BYTES:
                    raise HTTPException(
                        status_code=413,
                        detail=f'音频文件不能超过 {settings.MEETING_AUDIO_MAX_BYTES // 1024 // 1024} MB',
                    )
                await output.write(chunk)
            await output.flush()
        if total_bytes == 0:
            raise HTTPException(status_code=400, detail='音频文件为空')
        await to_thread.run_sync(temporary.replace, target)
    except BaseException:
        temporary.unlink(missing_ok=True)
        raise

    meeting.audio_path = str(target)
    meeting.audio_file_name = safe_name
    meeting.audio_mime_type = file.content_type or mimetypes.guess_type(safe_name)[0] or 'application/octet-stream'
    meeting.audio_duration_sec = await to_thread.run_sync(_probe_duration_sec, target)
    meeting.updated_at = datetime.utcnow()
    try:
        await touch_legacy_meeting_root(db, meeting)
        await db.flush()
    except Exception:
        await to_thread.run_sync(target.unlink, True)
        raise

    return target


def _audio_info(meeting: Meeting) -> dict | None:
    if not meeting.audio_path or not Path(meeting.audio_path).exists():
        return None
    return {
        'url': f'/api/laoji/meetings/{meeting.id}/audio/file',
        'mime_type': meeting.audio_mime_type,
        'duration_sec': meeting.audio_duration_sec,
        'file_name': meeting.audio_file_name,
        'expires_at': None,
        'requires_auth': True,
    }


def _transcript_to_dict(line: TranscriptLine) -> dict:
    return {
        'id': line.id,
        'meeting_id': line.meeting_id,
        'recording_asset_id': line.recording_asset_id,
        'transcription_job_id': line.transcription_job_id,
        'speaker_id': line.speaker_id,
        'speaker_label': line.speaker_label,
        'text': line.text,
        'start_time': line.start_time,
        'end_time': line.end_time,
        'confidence': line.confidence,
        'created_at': line.created_at.isoformat() if line.created_at else None,
    }


def _app_transcript_status(meeting: Meeting) -> str:
    status = str(meeting.status or '').strip().lower()
    if status in {'recording', 'paused', 'processing', 'transcribing', 'finalizing'}:
        return 'incomplete'
    if status in {'ended', 'completed', 'done', 'processed'}:
        return 'complete'
    if status in {'failed', 'error'}:
        return 'failed'
    return 'unknown'


def _app_transcript_revision_id(
    meeting: Meeting,
    total: int,
    status: str,
    recording_revisions: list[str] | None = None,
) -> str | None:
    if status != 'complete':
        return None
    updated_at = meeting.updated_at.isoformat() if meeting.updated_at else ''
    payload = json.dumps(
        [
            str(meeting.id),
            updated_at,
            max(0, int(total)),
            sorted(recording_revisions or []),
        ],
        ensure_ascii=True,
        separators=(',', ':'),
    ).encode('utf-8')
    return f'meeting-transcript:{hashlib.sha256(payload).hexdigest()}'


def _app_transcript_snapshot_status(
    meeting: Meeting,
    total: int,
    latest_jobs: list[MeetingRecordingTranscriptionJobV2],
) -> str:
    meeting_status = _app_transcript_status(meeting)
    if meeting_status == 'incomplete' or any(
        job.status in {'queued', 'running'} for job in latest_jobs
    ):
        return 'incomplete'
    # A failed retry must not invalidate transcript rows that are already
    # readable and immutable. The failed job remains visible through its own
    # processing contract while this endpoint exposes the current content
    # revision consumed by Summary and citations.
    if total > 0:
        return 'complete'
    if meeting_status == 'failed' or any(job.status == 'failed' for job in latest_jobs):
        return 'failed'
    return meeting_status


@router.post('/guest-sessions', status_code=201)
async def create_guest_realtime_session(data: GuestRealtimeSessionCreate):
    del data
    try:
        session = create_guest_meeting_session()
    except GuestSessionCapacityError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    return {
        'meeting_id': session.meeting_id,
        'guest_token': session.token,
        'expires_at': session.expires_at,
        'transient': True,
    }


@router.delete('/guest-sessions/{meeting_id}', status_code=204)
async def delete_guest_realtime_session(
    meeting_id: str,
    guest_token: str = Header(alias='X-Guest-Session-Token'),
):
    if not revoke_guest_meeting_session(meeting_id, guest_token):
        raise HTTPException(status_code=404, detail='游客实时会议不存在或已过期')
    return Response(status_code=204)


@router.get('/guest-sessions/{meeting_id}/transcripts')
async def get_guest_realtime_transcripts(
    meeting_id: str,
    limit: int = Query(default=1000, ge=1, le=1000),
    offset: int = Query(default=0, ge=0),
    guest_token: str = Header(alias='X-Guest-Session-Token'),
):
    page = list_guest_transcripts(
        meeting_id,
        guest_token,
        offset=offset,
        limit=limit,
    )
    if page is None:
        raise HTTPException(status_code=404, detail='游客实时会议不存在或已过期')
    return page


@router.post('/guest-summary', status_code=202)
async def generate_guest_meeting_summary(data: GuestSummaryRequest):
    template = _summary_template_or_422(data.template_id, data.template_revision)
    carry_forward = _summary_carry_forward_payload(data.carry_forward)
    attachment_authorization = _summary_attachment_payload(data.attachment_authorization)
    total_chars = sum(len(line.text.strip()) for line in data.transcript_lines)
    if total_chars <= 0:
        raise HTTPException(status_code=400, detail='会议暂无转写文本')
    transcript_lines = [
        {
            'id': (line.id or '').strip() or f'guest:{data.meeting_id}:{index}',
            'speaker': line.speaker_label or line.speaker_id or '发言人',
            'speaker_id': line.speaker_id,
            'text': line.text.strip(),
            'start': line.start_time,
            'end': line.end_time,
            'confidence': line.confidence,
        }
        for index, line in enumerate(data.transcript_lines)
        if line.text.strip()
    ]
    fingerprint = summary_payload_fingerprint(
        transcript_lines,
        meeting_title=data.title,
        meeting_date=data.meeting_date,
        template_id=template['id'],
        template_revision=template['revision'],
        carry_forward=carry_forward,
        attachment_authorization=attachment_authorization,
    )
    task = submit_guest_summary(
        data.meeting_id,
        transcript_lines,
        meeting_title=data.title,
        meeting_date=data.meeting_date,
        dedupe_key=f'guest:{data.meeting_id}:{fingerprint}',
        force=data.force,
        template_id=template['id'],
        template_revision=template['revision'],
        carry_forward=carry_forward,
        attachment_authorization=attachment_authorization,
    )
    return {
        'message': '游客会议总结任务已提交',
        'task_id': task.id,
        'transcript_count': len(transcript_lines),
        'transient': True,
        'reused': task.reused,
        'template_id': template['id'],
        'template_revision': template['revision'],
        'carry_forward_request_id': carry_forward['request_id'] if carry_forward else None,
        'attachment_request_id': attachment_authorization['request_id'] if attachment_authorization else None,
    }


@router.get('/guest-summary/tasks/{task_id}')
async def get_guest_meeting_summary_task(
    task_id: str,
    wait_ms: int = Query(default=0, ge=0, le=5000),
):
    status = await wait_for_guest_summary_status(
        task_id,
        timeout_seconds=wait_ms / 1000,
    )
    if status is None:
        raise HTTPException(status_code=404, detail='游客总结任务不存在或已过期')
    return status


@router.post('/guest-questions')
async def answer_guest_meeting_question(data: MeetingQuestionRequest):
    payload = _meeting_question_payload(data)
    created_at = datetime.utcnow()
    try:
        answer = await to_thread.run_sync(generate_meeting_question_answer, payload)
    except Exception as exc:
        raise HTTPException(status_code=502, detail='会议问答服务暂时不可用，请稍后重试') from exc
    completed_at = max(datetime.utcnow(), created_at)
    return await _meeting_question_response(
        None,
        payload=payload,
        answer=answer,
        created_at=created_at,
        completed_at=completed_at,
        thread=None,
        turn=None,
        transient=True,
    )


@router.post('/{meeting_id}/questions')
async def answer_app_meeting_question(
    meeting_id: str,
    data: MeetingQuestionRequest,
    current_user: dict = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    payload = _meeting_question_payload(data)
    user_id = _user_id(current_user)
    _assert_user_meeting_writable(user_id)
    meeting = await _get_owned_meeting(meeting_id, user_id, db)
    owned_meeting_id = str(meeting.id)

    request_hash = meeting_question_request_hash(payload)
    thread = await _find_meeting_question_thread(
        db,
        user_id=user_id,
        meeting_id=owned_meeting_id,
        client_thread_id=payload['client_thread_id'],
    )
    if thread is not None:
        if not _question_thread_matches(thread, payload):
            raise HTTPException(status_code=409, detail='问答记录的会议来源已变化')
        existing = await _find_meeting_question_turn(
            db,
            thread_id=thread.id,
            client_request_id=payload['client_request_id'],
        )
        if existing is not None:
            if existing.request_hash != request_hash:
                raise HTTPException(status_code=409, detail='同一问答请求标识已用于其他问题')
            return await _meeting_question_response(
                db,
                payload=payload,
                answer={},
                created_at=existing.created_at,
                completed_at=existing.completed_at,
                thread=thread,
                turn=existing,
                transient=False,
            )
        occupied = (
            await db.execute(
                select(MeetingQuestionTurn.id).where(
                    MeetingQuestionTurn.thread_id == thread.id,
                    MeetingQuestionTurn.ordinal == payload['expected_ordinal'],
                )
            )
        ).scalar_one_or_none()
        if occupied is not None:
            raise HTTPException(status_code=409, detail='问答轮次已在其他位置更新')
        turn_count = int((await db.execute(
            select(func.count(MeetingQuestionTurn.id)).where(
                MeetingQuestionTurn.thread_id == thread.id
            )
        )).scalar_one())
        if turn_count != payload['expected_ordinal']:
            raise HTTPException(status_code=409, detail='问答上下文已在其他位置更新')
    elif payload['expected_ordinal'] != 0:
        raise HTTPException(status_code=409, detail='云端不存在这段问答上下文')

    created_at = datetime.utcnow()
    try:
        answer = await to_thread.run_sync(generate_meeting_question_answer, payload)
    except Exception as exc:
        raise HTTPException(status_code=502, detail='会议问答服务暂时不可用，请稍后重试') from exc
    completed_at = max(datetime.utcnow(), created_at)

    # Recheck after model execution so a simultaneous request cannot silently
    # create a second turn at the same ordinal.
    thread = await _find_meeting_question_thread(
        db,
        user_id=user_id,
        meeting_id=owned_meeting_id,
        client_thread_id=payload['client_thread_id'],
    )
    if thread is None:
        thread = MeetingQuestionThread(
            user_id=user_id,
            meeting_id=owned_meeting_id,
            client_thread_id=payload['client_thread_id'],
            input_fingerprint=payload['input_fingerprint'],
            transcript_revision_id=payload['transcript_revision_id'],
            summary_version_id=payload['summary_version_id'],
            manual_note_revision=payload['manual_note_revision'],
            include_manual_note=payload['include_manual_note'],
            created_at=created_at,
            updated_at=completed_at,
        )
        db.add(thread)
        try:
            await db.flush()
        except IntegrityError:
            await db.rollback()
            thread = await _find_meeting_question_thread(
                db,
                user_id=user_id,
                meeting_id=owned_meeting_id,
                client_thread_id=payload['client_thread_id'],
            )
            if thread is None:
                raise HTTPException(status_code=409, detail='问答记录创建冲突')
    if not _question_thread_matches(thread, payload):
        raise HTTPException(status_code=409, detail='问答记录的会议来源已变化')
    existing = await _find_meeting_question_turn(
        db,
        thread_id=thread.id,
        client_request_id=payload['client_request_id'],
    )
    if existing is not None:
        if existing.request_hash != request_hash:
            raise HTTPException(status_code=409, detail='同一问答请求标识已用于其他问题')
        return await _meeting_question_response(
            db,
            payload=payload,
            answer={},
            created_at=existing.created_at,
            completed_at=existing.completed_at,
            thread=thread,
            turn=existing,
            transient=False,
        )
    turn_count = int((await db.execute(
        select(func.count(MeetingQuestionTurn.id)).where(
            MeetingQuestionTurn.thread_id == thread.id
        )
    )).scalar_one())
    if turn_count != payload['expected_ordinal']:
        raise HTTPException(status_code=409, detail='问答上下文已在其他位置更新')

    turn = MeetingQuestionTurn(
        thread_id=thread.id,
        client_request_id=payload['client_request_id'],
        request_hash=request_hash,
        ordinal=payload['expected_ordinal'],
        question=payload['question'],
        answer_scope=answer.get('answer_scope', 'meeting'),
        answer_kind=answer['answer_kind'],
        answer=answer['answer'],
        created_at=created_at,
        completed_at=completed_at,
    )
    db.add(turn)
    await db.flush()
    for ordinal, citation in enumerate(answer['citations']):
        db.add(MeetingQuestionCitation(
            turn_id=turn.id,
            kind=citation['kind'],
            source_id=citation['source_id'],
            ordinal=ordinal,
        ))
    thread.updated_at = completed_at
    await db.flush()
    return await _meeting_question_response(
        db,
        payload=payload,
        answer=answer,
        created_at=created_at,
        completed_at=completed_at,
        thread=thread,
        turn=turn,
        transient=False,
    )


@router.post('', status_code=201)
async def create_app_meeting(
    data: AppMeetingCreate,
    current_user: dict = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    user_id = _user_id(current_user)
    _assert_user_meeting_writable(user_id)
    client_request_id = data.client_request_id.strip() if data.client_request_id else None
    location = data.location.strip() if data.location and data.location.strip() else None
    recorded_at = _naive_utc(data.recorded_at)
    if client_request_id:
        existing = (
            await db.execute(
                select(Meeting).where(
                    Meeting.user_id == user_id,
                    Meeting.client_request_id == client_request_id,
                )
            )
        ).scalar_one_or_none()
        if existing is not None:
            root = await ensure_legacy_meeting_root(db, existing)
            if root.lifecycle == 'deleted':
                raise HTTPException(status_code=409, detail='这条会议记录已删除')
            if (
                existing.title != data.title.strip()
                or existing.description != data.description
                or _participants(existing) != data.participants
                or existing.mode != data.mode
                or existing.location != location
                or existing.recorded_at != recorded_at
            ):
                raise HTTPException(status_code=409, detail='同一创建请求标识不能用于不同会议内容')
            await db.flush()
            return _meeting_to_dict(existing)
    meeting = Meeting(
        id=str(uuid.uuid4()),
        user_id=user_id,
        app_owned=1,
        client_request_id=client_request_id,
        title=data.title.strip(),
        description=data.description,
        location=location,
        participants=json.dumps(data.participants, ensure_ascii=False),
        status='created',
        mode=data.mode,
        recorded_at=recorded_at,
        created_at=datetime.utcnow(),
        updated_at=datetime.utcnow(),
    )
    db.add(meeting)
    try:
        await db.flush()
        await ensure_legacy_meeting_root(db, meeting)
        await db.flush()
    except IntegrityError:
        await db.rollback()
        if not client_request_id:
            raise
        existing = (
            await db.execute(
                select(Meeting).where(
                    Meeting.user_id == user_id,
                    Meeting.client_request_id == client_request_id,
                )
            )
        ).scalar_one_or_none()
        if existing is None:
            raise
        root = await ensure_legacy_meeting_root(db, existing)
        if root.lifecycle == 'deleted':
            raise HTTPException(status_code=409, detail='这条会议记录已删除')
        if (
            existing.title != data.title.strip()
            or existing.description != data.description
            or _participants(existing) != data.participants
            or existing.mode != data.mode
            or existing.location != location
            or existing.recorded_at != recorded_at
        ):
            raise HTTPException(status_code=409, detail='同一创建请求标识不能用于不同会议内容')
        await db.flush()
        return _meeting_to_dict(existing)
    await db.refresh(meeting)
    return _meeting_to_dict(meeting)


@router.get('')
async def list_app_meetings(
    page: int = 1,
    size: int = 50,
    current_user: dict = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    page = max(1, page)
    size = min(100, max(1, size))
    user_id = _user_id(current_user)
    total_q = await db.execute(select(func.count(Meeting.id)).where(
        Meeting.user_id == user_id,
        _meeting_is_active_clause(),
    ))
    result = await db.execute(
        select(Meeting)
        .where(Meeting.user_id == user_id, _meeting_is_active_clause())
        .order_by(func.coalesce(Meeting.recorded_at, Meeting.created_at).desc())
        .offset((page - 1) * size)
        .limit(size)
    )
    items = list(result.scalars().all())
    availability = await _meeting_availability(db, [item.id for item in items])
    return {
        'items': [_meeting_to_dict(item, **availability.get(item.id, {})) for item in items],
        'total': total_q.scalar() or 0,
        'page': page,
        'size': size,
    }


@router.get('/{meeting_id}')
async def get_app_meeting(
    meeting_id: str,
    current_user: dict = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    meeting = await _get_owned_meeting(meeting_id, _user_id(current_user), db)
    return await _meeting_to_dict_with_availability(db, meeting)


@router.patch('/{meeting_id}')
async def update_app_meeting(
    meeting_id: str,
    data: AppMeetingUpdate,
    current_user: dict = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    _assert_user_meeting_writable(_user_id(current_user))
    meeting = await _get_owned_meeting(meeting_id, _user_id(current_user), db)
    if data.title is not None:
        meeting.title = data.title.strip()
    if 'description' in data.model_fields_set:
        meeting.description = data.description
    if data.status is not None:
        meeting.status = data.status
    if data.participants is not None:
        meeting.participants = json.dumps(data.participants, ensure_ascii=False)
    if data.mode is not None:
        meeting.mode = data.mode
    if 'location' in data.model_fields_set:
        meeting.location = data.location.strip() if data.location and data.location.strip() else None
    meeting.updated_at = datetime.utcnow()
    await touch_legacy_meeting_root(db, meeting)
    await db.flush()
    await db.refresh(meeting)
    return await _meeting_to_dict_with_availability(db, meeting)


@router.post('/{meeting_id}/imports/guest')
async def import_guest_meeting_data(
    meeting_id: str,
    data: GuestMeetingImportRequest,
    current_user: dict = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    user_id = _user_id(current_user)
    _assert_user_meeting_writable(user_id)
    meeting = await _get_owned_meeting(meeting_id, user_id, db)
    transcript_ids = [
        _stable_import_uuid(user_id, data.source_meeting_id, 'transcript', line.id or index)
        for index, line in enumerate(data.transcripts)
    ]
    existing_transcript_ids = set()
    if transcript_ids:
        existing_transcript_ids = set(
            (
                await db.execute(
                    select(TranscriptLine.id).where(TranscriptLine.id.in_(transcript_ids))
                )
            ).scalars().all()
        )

    inserted_transcripts = 0
    for index, line in enumerate(data.transcripts):
        text = line.text.strip()
        line_id = transcript_ids[index]
        if not text or line_id in existing_transcript_ids:
            continue
        start_time = max(0.0, float(line.start_time or 0.0))
        end_time = max(start_time, float(line.end_time if line.end_time is not None else start_time))
        confidence = min(1.0, max(0.0, float(line.confidence or 0.0)))
        db.add(TranscriptLine(
            id=line_id,
            meeting_id=meeting.id,
            speaker_id=(line.speaker_id or 'unknown')[:50],
            speaker_label=(line.speaker_label or '发言人')[:100],
            text=text,
            start_time=start_time,
            end_time=end_time,
            confidence=confidence,
            created_at=_naive_utc(line.created_at) or datetime.utcnow(),
        ))
        inserted_transcripts += 1

    summary_id = _stable_import_uuid(user_id, data.source_meeting_id, 'summary')
    existing_summary = (
        await db.execute(select(FinalSummary).where(FinalSummary.id == summary_id))
    ).scalar_one_or_none()
    summary_imported = existing_summary is not None
    if data.summary is not None and existing_summary is None:
        overview = (
            data.summary.overview
            or data.summary.full_text
            or data.summary.markdown
            or ''
        ).strip()
        decisions = [item.strip()[:1000] for item in data.summary.key_decisions if item.strip()]
        actions = [item for item in data.summary.action_items if isinstance(item, dict)]
        if overview or decisions or actions:
            summary = FinalSummary(
                id=summary_id,
                meeting_id=meeting.id,
                overview=overview or '本次会议未提供文字总结。',
                generated_at=_naive_utc(data.summary.generated_at) or datetime.utcnow(),
            )
            summary.key_decisions = decisions[:50]
            summary.action_items = actions[:100]
            db.add(summary)
            summary_imported = True

    meeting.updated_at = datetime.utcnow()
    await touch_legacy_meeting_root(db, meeting)
    await db.flush()
    transcript_count = int((
        await db.execute(
            select(func.count(TranscriptLine.id)).where(TranscriptLine.meeting_id == meeting.id)
        )
    ).scalar() or 0)
    return {
        'meeting_id': meeting.id,
        'transcript_count': transcript_count,
        'summary_imported': summary_imported,
        'already_imported': inserted_transcripts == 0 and (
            data.summary is None or existing_summary is not None
        ),
    }


@router.delete('/{meeting_id}', status_code=204)
async def delete_app_meeting(
    meeting_id: str,
    current_user: dict = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    _assert_user_meeting_writable(_user_id(current_user))
    meeting = await _get_owned_meeting(meeting_id, _user_id(current_user), db)
    await soft_delete_legacy_meeting(db, meeting)


@router.post('/{meeting_id}/audio')
async def upload_app_meeting_audio(
    meeting_id: str,
    file: UploadFile = File(...),
    current_user: dict = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    ensure_audio_upload_allowed()
    _assert_user_meeting_writable(_user_id(current_user))
    user_id = _user_id(current_user)
    meeting = await _get_owned_meeting(meeting_id, user_id, db)
    permanent = await _save_audio_file(meeting, user_id, file, db)
    uploaded_file_name = meeting.audio_file_name or permanent.name
    uploaded_mime_type = meeting.audio_mime_type or 'application/octet-stream'
    uploaded_duration_ms = (
        round(meeting.audio_duration_sec * 1000)
        if meeting.audio_duration_sec is not None
        else None
    )
    asset, _job, _submit = await project_compat_media_upload(
        db,
        meeting=meeting,
        user_id=user_id,
        source_path=permanent,
        file_name=uploaded_file_name,
        mime_type=uploaded_mime_type,
        duration_ms=uploaded_duration_ms,
        start_transcription=False,
    )
    await db.commit()
    return {
        **(_audio_info(meeting) or {'url': None}),
        'recording_asset_id': asset['id'],
    }


@router.get('/{meeting_id}/audio')
async def get_app_meeting_audio_info(
    meeting_id: str,
    current_user: dict = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    meeting = await _get_owned_meeting(meeting_id, _user_id(current_user), db)
    info = _audio_info(meeting)
    if not info:
        raise HTTPException(status_code=404, detail='暂无录音文件')
    return info


@router.get('/{meeting_id}/audio/file')
async def download_app_meeting_audio(
    meeting_id: str,
    current_user: dict = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    meeting = await _get_owned_meeting(meeting_id, _user_id(current_user), db)
    if not meeting.audio_path or not Path(meeting.audio_path).exists():
        raise HTTPException(status_code=404, detail='暂无录音文件')
    return FileResponse(
        meeting.audio_path,
        media_type=meeting.audio_mime_type or 'application/octet-stream',
        filename=meeting.audio_file_name or f'{meeting.id}.wav',
    )


@router.post('/{meeting_id}/upload')
async def upload_app_audio_for_processing(
    meeting_id: str,
    file: UploadFile = File(...),
    current_user: dict = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    ensure_audio_upload_allowed()
    _assert_user_meeting_writable(_user_id(current_user))
    user_id = _user_id(current_user)
    meeting = await _get_owned_meeting(meeting_id, user_id, db)
    permanent = await _save_audio_file(meeting, user_id, file, db)
    uploaded_file_name = meeting.audio_file_name or permanent.name
    uploaded_mime_type = meeting.audio_mime_type or 'application/octet-stream'
    uploaded_duration_ms = (
        round(meeting.audio_duration_sec * 1000)
        if meeting.audio_duration_sec is not None
        else None
    )
    asset, job, should_submit = await project_compat_media_upload(
        db,
        meeting=meeting,
        user_id=user_id,
        source_path=permanent,
        file_name=uploaded_file_name,
        mime_type=uploaded_mime_type,
        duration_ms=uploaded_duration_ms,
        start_transcription=True,
    )
    await db.commit()
    if should_submit and job is not None:
        submit_transcription_job(job['job_id'])
    return {
        'status': job['status'] if job is not None else 'uploaded',
        'message': '音频文件上传成功，正在后台处理',
        'meeting_id': meeting_id,
        'file_size': asset['byte_size'],
        'audio': _audio_info(meeting),
        'recording_asset_id': asset['id'],
        'job_id': job['job_id'] if job is not None else None,
    }


@router.get('/{meeting_id}/status')
async def get_app_meeting_status(
    meeting_id: str,
    current_user: dict = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    meeting = await _get_owned_meeting(meeting_id, _user_id(current_user), db)
    return {
        'meeting_id': meeting.id,
        'status': meeting.status,
        'title': meeting.title,
        'updated_at': meeting.updated_at.isoformat() if meeting.updated_at else None,
    }


@router.get('/{meeting_id}/transcripts')
async def get_app_meeting_transcripts(
    meeting_id: str,
    limit: int = 1000,
    offset: int = 0,
    current_user: dict = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    meeting = await _get_owned_meeting(meeting_id, _user_id(current_user), db)
    limit = min(1000, max(1, limit))
    offset = max(0, offset)
    total_q = await db.execute(select(func.count(TranscriptLine.id)).where(TranscriptLine.meeting_id == meeting_id))
    asset_order = case(
        (TranscriptLine.recording_asset_id.is_(None), 0),
        (MeetingRecordingAssetV2.role == 'primary', 1),
        else_=2,
    )
    result = await db.execute(
        select(TranscriptLine)
        .outerjoin(
            MeetingRecordingAssetV2,
            MeetingRecordingAssetV2.id == TranscriptLine.recording_asset_id,
        )
        .where(TranscriptLine.meeting_id == meeting_id)
        .order_by(
            asset_order,
            MeetingRecordingAssetV2.created_at,
            MeetingRecordingAssetV2.id,
            TranscriptLine.start_time,
            TranscriptLine.id,
        )
        .offset(offset)
        .limit(limit)
    )
    total = int(total_q.scalar() or 0)
    jobs = list((await db.execute(
        select(MeetingRecordingTranscriptionJobV2)
        .where(MeetingRecordingTranscriptionJobV2.meeting_id == meeting_id)
        .order_by(
            MeetingRecordingTranscriptionJobV2.created_at,
            MeetingRecordingTranscriptionJobV2.id,
        )
    )).scalars().all())
    latest_job_by_asset = {}
    for job in jobs:
        latest_job_by_asset[job.asset_id] = job
    latest_jobs = list(latest_job_by_asset.values())
    transcript_status = _app_transcript_snapshot_status(meeting, total, latest_jobs)
    return {
        'items': [_transcript_to_dict(line) for line in result.scalars().all()],
        'total': total,
        'transcript_status': transcript_status,
        'is_complete': (
            True if transcript_status == 'complete'
            else False if transcript_status in {'incomplete', 'failed'}
            else None
        ),
        'transcript_revision_id': _app_transcript_revision_id(
            meeting,
            total,
            transcript_status,
            [
                f'{job.asset_id}:{job.result_revision_id}'
                for job in latest_jobs
                if job.status == 'completed' and job.result_revision_id
            ],
        ),
    }


@router.post('/{meeting_id}/summaries/generate', status_code=202)
async def generate_app_meeting_summary(
    meeting_id: str,
    summary_type: str = 'final',
    force: bool = False,
    template_id: str = 'general',
    template_revision: int | None = None,
    request: AppSummaryGenerateRequest | None = Body(default=None),
    current_user: dict = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    template = _summary_template_or_422(template_id, template_revision)
    user_id = _user_id(current_user)
    _assert_user_meeting_writable(user_id)
    meeting = await _get_owned_meeting(meeting_id, user_id, db)
    carry_forward = _summary_carry_forward_payload(request.carry_forward if request else None)
    attachment_authorization = _summary_attachment_payload(
        request.attachment_authorization if request else None
    )
    await _assert_owned_carry_forward_sources(
        carry_forward,
        user_id=user_id,
        current_meeting_id=meeting.id,
        db=db,
    )
    result = await db.execute(
        select(TranscriptLine)
        .where(TranscriptLine.meeting_id == meeting_id)
        .order_by(TranscriptLine.start_time)
    )
    transcript_lines = [
        {
            'id': line.id,
            'speaker': line.speaker_label,
            'speaker_id': line.speaker_id,
            'text': line.text,
            'start': line.start_time,
            'end': line.end_time,
            'confidence': line.confidence,
        }
        for line in result.scalars().all()
    ]
    if not transcript_lines:
        raise HTTPException(status_code=400, detail='会议暂无转写文本')
    if summary_type != 'final':
        raise HTTPException(status_code=400, detail='App 会议当前只支持 final 总结')
    fingerprint = summary_payload_fingerprint(
        transcript_lines,
        meeting_title=meeting.title,
        meeting_date=_meeting_local_date(meeting),
        template_id=template['id'],
        template_revision=template['revision'],
        carry_forward=carry_forward,
        attachment_authorization=attachment_authorization,
    )
    try:
        task = submit_final_summary(
            meeting_id,
            transcript_lines,
            [],
            meeting_title=meeting.title,
            meeting_date=_meeting_local_date(meeting),
            task_scope=f'user:{user_id}',
            dedupe_key=f'app:{user_id}:{meeting_id}:{fingerprint}',
            force=force,
            template_id=template['id'],
            template_revision=template['revision'],
            carry_forward=carry_forward,
            attachment_authorization=attachment_authorization,
        )
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f'最终总结生成失败: {str(exc)[:240]}') from exc
    return {
        'message': '最终总结任务已提交',
        'task_id': task.id,
        'transcript_count': len(transcript_lines),
        'reused': task.reused,
        'template_id': template['id'],
        'template_revision': template['revision'],
        'carry_forward_request_id': carry_forward['request_id'] if carry_forward else None,
        'attachment_request_id': attachment_authorization['request_id'] if attachment_authorization else None,
    }


@router.get('/{meeting_id}/summaries/task/{task_id}')
async def get_app_summary_task_status(
    meeting_id: str,
    task_id: str,
    wait_ms: int = Query(default=0, ge=0, le=5000),
    current_user: dict = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    user_id = _user_id(current_user)
    await _get_owned_meeting(meeting_id, user_id, db)
    local_status = await wait_for_submitted_summary_status(
        task_id,
        timeout_seconds=wait_ms / 1000,
        expected_scope=f'user:{user_id}',
        expected_meeting_id=meeting_id,
    )
    if local_status is None:
        raise HTTPException(status_code=404, detail='总结任务不存在、已过期或不属于当前会议')
    return local_status


@router.get('/{meeting_id}/summaries/final')
async def get_app_final_summary(
    meeting_id: str,
    current_user: dict = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    user_id = _user_id(current_user)
    meeting = await _get_owned_meeting(meeting_id, user_id, db)
    effective = await get_effective_current_summary_document(
        db,
        user_id=user_id,
        meeting_id=meeting.id,
    )
    if effective is not None:
        version, structured = effective
        action_items = [
            {
                'id': item['id'],
                'content': item.get('content', ''),
                'assignee': item.get('assignee'),
                'due_date': item.get('due_date'),
                'status': item.get('status', 'pending'),
            }
            for item in structured.get('action_item_candidates', [])
            if isinstance(item, dict) and isinstance(item.get('id'), str)
        ]
        overview_section = next(
            (
                section
                for section in structured.get('sections', [])
                if isinstance(section, dict) and section.get('key') == 'overview'
            ),
            None,
        )
        overview = (
            str(overview_section.get('content') or '').strip()
            if overview_section is not None
            else ''
        )
        full_text = _structured_summary_markdown(structured) or overview
        generated_at = structured.get('generated_at') or version.completed_at.isoformat()
        return {
            'id': version.id,
            'meeting_id': version.meeting_id,
            'overview': overview,
            'full_text': full_text,
            'markdown': full_text or None,
            'raw_json': None,
            'key_decisions': [],
            'action_items': action_items,
            'generated_at': generated_at,
            **structured,
        }
    summary = await _ensure_final_summary(db, meeting.id)
    if not summary:
        raise HTTPException(status_code=404, detail='摘要生成中或尚未生成，请稍后重试')
    transcript_result = await db.execute(
        select(TranscriptLine)
        .where(TranscriptLine.meeting_id == meeting.id)
        .order_by(TranscriptLine.start_time)
    )
    brief_summary = brief_greeting_summary([
        {'text': line.text}
        for line in transcript_result.scalars().all()
    ])
    existing_structured = structured_summary_from_raw_json(
        summary.raw_summary_json,
        summary.meeting_id,
    )
    preserve_context = _preserve_contextual_structured_summary(existing_structured)
    if brief_summary is not None and not preserve_context and (
        summary.overview != brief_summary['overview']
        or summary.key_decisions
        or summary.action_items
    ):
        summary.overview = brief_summary['overview']
        summary.key_decisions = []
        summary.action_items = []
        summary.generated_at = datetime.utcnow()
        await db.flush()
    generated_at = summary.generated_at.isoformat() if summary.generated_at else None
    effective_structured = (
        existing_structured
        if brief_summary is None or preserve_context
        else None
    )
    structured = effective_structured or build_structured_summary_payload(
        summary.meeting_id,
        summary.overview or '',
        summary.key_decisions,
        summary.action_items,
        version_id=summary.id,
        generated_at=generated_at,
    )
    action_items = [
        {
            'id': item['id'],
            'content': item.get('content', ''),
            'assignee': item.get('assignee'),
            'due_date': item.get('due_date'),
            'status': item.get('status', 'pending'),
        }
        for item in structured['action_item_candidates']
    ]
    markdown = None if brief_summary is not None and not preserve_context else summary.markdown_text
    safe_full_text = markdown or _structured_summary_markdown(structured) or summary.overview
    return {
        'id': summary.id,
        'meeting_id': summary.meeting_id,
        'overview': summary.overview,
        'full_text': (
            brief_summary['overview']
            if brief_summary is not None and not preserve_context
            else safe_full_text
        ),
        'markdown': markdown,
        'raw_json': None,
        'key_decisions': summary.key_decisions,
        'action_items': action_items,
        'generated_at': generated_at,
        **structured,
    }
