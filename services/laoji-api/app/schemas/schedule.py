"""
日程管理 API Schema
"""

from datetime import datetime
from typing import Annotated, Any, Dict, Optional, List, Literal
from pydantic import BaseModel, Field


ScheduleCategory = Literal["工作", "学习", "健康", "生活", "社交", "出行", "财务", "重要", "其他"]
IsoWeekday = Annotated[int, Field(ge=1, le=7)]
ISO_WEEKDAY_DESCRIPTION = "ISO 8601 weekday values: 1=Monday, 2=Tuesday, ..., 7=Sunday"


class ScheduleEventCreate(BaseModel):
    """创建日程请求"""
    title: str = Field(..., max_length=100)
    event_type: str = Field(default="once")  # once | daily | weekly | monthly | yearly
    start_date: str = Field(..., description="YYYY-MM-DD 或 MM-DD（monthly/yearly 时）")
    end_date: Optional[str] = Field(None, description="YYYY-MM-DD，跨日期事件的结束日期")
    color: Optional[str] = Field(None, max_length=32)
    spanning: Optional[bool] = None
    start_time: Optional[str] = Field(None, description="HH:MM，None 表示全天事件")
    end_time: Optional[str] = Field(None, description="HH:MM")
    is_all_day: bool = Field(default=False)
    description: Optional[str] = Field(None, max_length=500)
    location: Optional[str] = Field(None, max_length=100)
    category: Optional[ScheduleCategory] = None
    detail: Optional[str] = Field(None, max_length=1000)
    status: Optional[str] = Field(None, max_length=50)
    reminder_minutes: Optional[int] = Field(None, description="null 不提醒，0 开始时提醒，正数表示提前分钟数")
    recurrence_interval: int = Field(default=1, ge=1)
    recurrence_weekdays: Optional[List[IsoWeekday]] = Field(
        None, min_length=1, description=ISO_WEEKDAY_DESCRIPTION
    )
    recurrence_until_date: Optional[str] = Field(None, pattern=r"^\d{4}-\d{2}-\d{2}$")
    raw_text: Optional[str] = Field(None, max_length=2000, description="用户原始语音文本")
    client_request_id: Optional[str] = Field(
        None,
        min_length=8,
        max_length=96,
        pattern=r"^[A-Za-z0-9][A-Za-z0-9._:-]+$",
        description="客户端创建请求幂等键；同一用户内唯一",
    )


class ScheduleEventUpdate(BaseModel):
    """更新日程请求"""
    title: Optional[str] = Field(None, max_length=100)
    event_type: Optional[str] = None
    start_date: Optional[str] = None
    end_date: Optional[str] = None
    color: Optional[str] = Field(None, max_length=32)
    spanning: Optional[bool] = None
    start_time: Optional[str] = None
    end_time: Optional[str] = None
    is_all_day: Optional[bool] = None
    description: Optional[str] = Field(None, max_length=500)
    location: Optional[str] = Field(None, max_length=100)
    category: Optional[ScheduleCategory] = None
    detail: Optional[str] = Field(None, max_length=1000)
    status: Optional[str] = Field(None, max_length=50)
    reminder_minutes: Optional[int] = None
    raw_text: Optional[str] = Field(None, max_length=2000)
    recurrence_interval: Optional[int] = Field(None, ge=1)
    recurrence_weekdays: Optional[List[IsoWeekday]] = Field(
        None, min_length=1, description=ISO_WEEKDAY_DESCRIPTION
    )
    recurrence_until_date: Optional[str] = Field(None, pattern=r"^\d{4}-\d{2}-\d{2}$")


class ScheduleEvent(BaseModel):
    """日程事件响应"""
    id: int
    source_event_id: Optional[int] = None
    occurrence_date: Optional[str] = None
    occurrence_id: Optional[str] = None
    is_expanded: bool = False
    series_start_date: Optional[str] = None
    series_end_date: Optional[str] = None
    user_id: Optional[int] = None
    title: str
    event_type: str
    start_date: str
    end_date: Optional[str] = None
    color: Optional[str] = None
    spanning: Optional[bool] = None
    start_time: Optional[str] = None
    end_time: Optional[str] = None
    is_all_day: bool = False
    description: Optional[str] = None
    location: Optional[str] = None
    category: Optional[ScheduleCategory] = None
    detail: Optional[str] = None
    status: Optional[str] = None
    reminder_minutes: Optional[int] = None
    raw_text: Optional[str] = None
    client_request_id: Optional[str] = None
    created_at: str
    updated_at: str
    revision: int = 1
    segment_id: Optional[int] = None
    is_recurrence_exception: bool = False
    recurrence_effective_from_date: Optional[str] = Field(
        None,
        pattern=r"^\d{4}-\d{2}-\d{2}$",
        description="Inclusive ISO occurrence anchor at which this catalog template takes effect",
    )
    recurrence_interval: int = 1
    recurrence_weekdays: Optional[List[IsoWeekday]] = Field(
        None, min_length=1, description=ISO_WEEKDAY_DESCRIPTION
    )
    recurrence_until_date: Optional[str] = None
    excluded_occurrence_dates: List[str] = Field(default_factory=list)
    excluded_after_date: Optional[str] = Field(
        None,
        description="Exclusive occurrence-anchor boundary for this recurrence template",
    )


ScheduleEventCommandScope = Literal["occurrence", "following", "series"]


class ScheduleEventStateCommand(BaseModel):
    """Idempotently converge one event scope to present or absent."""
    client_request_id: str = Field(
        ...,
        min_length=8,
        max_length=96,
        pattern=r"^[A-Za-z0-9][A-Za-z0-9._:-]+$",
    )
    desired_state: Literal["present", "absent"]
    scope: ScheduleEventCommandScope = "series"
    occurrence_date: Optional[str] = Field(None, pattern=r"^\d{4}-\d{2}-\d{2}$")
    expected_revision: Optional[int] = Field(None, ge=1)


class ScheduleEventStateCommandResponse(BaseModel):
    client_request_id: str
    source_event_id: int
    desired_state: Literal["present", "absent"]
    observed_state: Literal["present", "absent"]
    scope: ScheduleEventCommandScope
    occurrence_date: Optional[str] = None
    revision: int
    changed: bool
    event: Optional[ScheduleEvent] = None


class ScheduleEventRecurrencePatch(BaseModel):
    frequency: Optional[Literal["once", "daily", "weekly", "monthly", "yearly"]] = None
    interval: Optional[int] = Field(None, ge=1)
    weekdays: Optional[List[IsoWeekday]] = Field(
        None, min_length=1, description=ISO_WEEKDAY_DESCRIPTION
    )
    until_date: Optional[str] = Field(None, pattern=r"^\d{4}-\d{2}-\d{2}$")


class ScheduleEventEditPatch(BaseModel):
    """Sparse patch; model_fields_set preserves omitted fields versus explicit nulls."""
    title: Optional[str] = Field(None, max_length=100)
    event_type: Optional[str] = None
    start_date: Optional[str] = None
    end_date: Optional[str] = None
    color: Optional[str] = Field(None, max_length=32)
    spanning: Optional[bool] = None
    start_time: Optional[str] = None
    end_time: Optional[str] = None
    is_all_day: Optional[bool] = None
    description: Optional[str] = Field(None, max_length=500)
    raw_text: Optional[str] = Field(None, max_length=2000)
    location: Optional[str] = Field(None, max_length=100)
    category: Optional[ScheduleCategory] = None
    detail: Optional[str] = Field(None, max_length=1000)
    status: Optional[str] = Field(None, max_length=50)
    reminder_minutes: Optional[int] = None
    recurrence_interval: Optional[int] = Field(None, ge=1)
    recurrence_weekdays: Optional[List[IsoWeekday]] = Field(
        None, min_length=1, description=ISO_WEEKDAY_DESCRIPTION
    )
    recurrence_until_date: Optional[str] = Field(None, pattern=r"^\d{4}-\d{2}-\d{2}$")
    recurrence: Optional[ScheduleEventRecurrencePatch] = None


class ScheduleEventEditCommand(BaseModel):
    client_request_id: str = Field(
        ...,
        min_length=8,
        max_length=96,
        pattern=r"^[A-Za-z0-9][A-Za-z0-9._:-]+$",
    )
    scope: ScheduleEventCommandScope
    occurrence_date: str = Field(..., pattern=r"^\d{4}-\d{2}-\d{2}$")
    expected_revision: Optional[int] = Field(None, ge=1)
    patch: ScheduleEventEditPatch


class ScheduleEventCanonicalRef(BaseModel):
    source_event_id: int
    occurrence_date: str


class ScheduleEventAffectedRange(BaseModel):
    from_occurrence_date: Optional[str] = None
    through_occurrence_date: Optional[str] = None


class ScheduleEventReminderRebuild(ScheduleEventAffectedRange):
    token: str


class ScheduleEventEditCommandResponse(BaseModel):
    client_request_id: str
    source_event_id: int
    canonical_ref: ScheduleEventCanonicalRef
    scope: ScheduleEventCommandScope
    segment_id: Optional[int] = None
    previous_revision: int
    revision: int
    changed: bool
    event: ScheduleEvent
    affected_range: ScheduleEventAffectedRange
    reminder_rebuild: Optional[ScheduleEventReminderRebuild] = None


class ScheduleParseRequest(BaseModel):
    """日程解析请求（纯文本）"""
    text: str = Field(..., max_length=2000, description="用户语音转写的文本")
    reference_datetime: Optional[datetime] = Field(
        None,
        description="解析所依据的参考时间；未传时才使用服务端当前时间",
    )
    timezone: Optional[str] = Field(None, max_length=64, description="IANA 时区，例如 Asia/Shanghai")
    client_rule_status: Literal["not_run", "unresolved"] = "not_run"
    client_intent: Literal["create", "clarify", "query", "delete", "reject"] = "create"


class ScheduleParseResponse(BaseModel):
    """日程解析响应"""
    # A clarification draft may legitimately have no event subject yet.
    title: Optional[str] = None
    event_type: str
    # null means the parser could not determine a saveable date yet.
    start_date: Optional[str] = None
    end_date: Optional[str] = None
    color: Optional[str] = None
    spanning: Optional[bool] = None
    start_time: Optional[str] = None
    end_time: Optional[str] = None
    time_period: Optional[Literal["early_morning", "morning", "noon", "afternoon", "evening", "night"]] = None
    is_all_day: bool = False
    description: Optional[str] = None
    location: Optional[str] = None
    category: Optional[ScheduleCategory] = None
    detail: Optional[str] = None
    status: Optional[str] = None
    reminder_minutes: Optional[int] = None
    raw_text: str
    parse_source: str = Field(default="rules", description="rules | local_llm")
    confidence: float = Field(default=0.0, ge=0.0, le=1.0)
    needs_clarification: bool = False
    clarification_question: Optional[str] = None
    # Server-side route evidence is additive and optional for older clients.
    # The parse endpoint fills these fields; other schedule responses may omit
    # them while their existing contracts remain unchanged.
    route: Optional[str] = None
    model_attempted: Optional[bool] = None
    model_success: Optional[bool] = None
    fallback_used: Optional[bool] = None
    model_id: Optional[str] = None
    request_id: Optional[str] = None
    request_sha256: Optional[str] = None
    latency_ms: Optional[float] = None
    parse_latency_ms: Optional[float] = None


class ScheduleClarifyRequest(BaseModel):
    """对已有解析结果进行追问补充"""
    current: ScheduleParseResponse
    answer: str = Field(..., max_length=1000, description="用户针对追问的补充回答")
    reference_datetime: Optional[datetime] = Field(
        None,
        description="必须沿用初次解析的参考时间",
    )
    timezone: Optional[str] = Field(None, max_length=64, description="IANA 时区，例如 Asia/Shanghai")


class ScheduleAudioParseRequest(BaseModel):
    """语音解析请求（包含 base64 音频）"""
    audio_base64: str = Field(..., description="wav/m4a 音频 base64 编码")
    filename: str = Field(default="recording.wav")


class ScheduleAsrTranscribeRequest(BaseModel):
    """轻量 ASR 转写请求（老记一句话录音）"""
    audio_base64: str = Field(..., description="16k 单声道 wav 音频 base64 编码")
    filename: str = Field(default="recording.wav")


class ScheduleAsrTranscribeResponse(BaseModel):
    """轻量 ASR 转写响应"""
    text: str
    duration_sec: float = 0.0
    provider: str = "qwen3-asr"


class ScheduleParseExpectation(BaseModel):
    """诊断接口中的期望结构化字段。只填写需要比较的字段。"""
    title: Optional[str] = None
    event_type: Optional[str] = None
    start_date: Optional[str] = None
    end_date: Optional[str] = None
    category: Optional[ScheduleCategory] = None
    start_time: Optional[str] = None
    end_time: Optional[str] = None
    is_all_day: Optional[bool] = None
    reminder_minutes: Optional[int] = None
    needs_clarification: Optional[bool] = None


class ScheduleTextQualitySample(BaseModel):
    id: Optional[str] = Field(None, max_length=80)
    text: str = Field(..., max_length=2000)
    reference_datetime: Optional[datetime] = None
    timezone: Optional[str] = Field(None, max_length=64)
    expected: Optional[ScheduleParseExpectation] = None


class ScheduleAudioQualitySample(BaseModel):
    id: Optional[str] = Field(None, max_length=80)
    audio_base64: str = Field(..., max_length=20000000, description="mp3/wav/aac/m4a 等音频 base64")
    filename: str = Field(default="sample.wav", max_length=120)
    expected_text: Optional[str] = Field(None, max_length=2000)
    expected: Optional[ScheduleParseExpectation] = None


class ScheduleTextQualityRequest(BaseModel):
    samples: List[ScheduleTextQualitySample] = Field(..., min_length=1, max_length=30)


class ScheduleAudioQualityRequest(BaseModel):
    samples: List[ScheduleAudioQualitySample] = Field(..., min_length=1, max_length=8)
    min_transcript_score: float = Field(default=0.85, ge=0.0, le=1.0)


class ScheduleQualityItemResult(BaseModel):
    id: Optional[str] = None
    input_text: Optional[str] = None
    filename: Optional[str] = None
    transcript: Optional[str] = None
    transcript_score: Optional[float] = None
    parsed: Optional[ScheduleParseResponse] = None
    ok: bool
    duration_ms: int
    matched: Dict[str, bool] = Field(default_factory=dict)
    mismatches: Dict[str, Dict[str, Any]] = Field(default_factory=dict)
    error: Optional[str] = None


class ScheduleQualityResponse(BaseModel):
    total: int
    passed: int
    items: List[ScheduleQualityItemResult]


class ScheduleEventListResponse(BaseModel):
    """日程列表响应"""
    events: List[ScheduleEvent]
    total: int
