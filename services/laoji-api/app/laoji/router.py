"""
老记 API
=======
一句话待办的独立接口层。当前仍复用日程解析、日程存储和短音频 ASR 服务，
但接口命名空间已经独立为 /api/laoji，便于后续拆成单独 app。
"""

from typing import Any, Optional

import contextvars
import hashlib
import json
import os
import re
import sys
import time
import urllib.error
import urllib.request
from difflib import SequenceMatcher
from pathlib import Path

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from fastapi.responses import JSONResponse

_PROJECT_ROOT = Path(__file__).resolve().parents[3]
if str(_PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(_PROJECT_ROOT))

from app.laoji.auth_router import get_current_user
from app.schemas.schedule import (
    ScheduleAsrTranscribeRequest,
    ScheduleAsrTranscribeResponse,
    ScheduleAudioParseRequest,
    ScheduleAudioQualityRequest,
    ScheduleClarifyRequest,
    ScheduleEvent,
    ScheduleEventCreate,
    ScheduleEventEditCommand,
    ScheduleEventEditCommandResponse,
    ScheduleEventListResponse,
    ScheduleEventStateCommand,
    ScheduleEventStateCommandResponse,
    ScheduleEventUpdate,
    ScheduleQualityItemResult,
    ScheduleQualityResponse,
    ScheduleTextQualityRequest,
    ScheduleParseRequest,
    ScheduleParseResponse,
)
from app.services import schedule_db_service as db
from app.services import schedule_parser_service as parser_service
from app.services.llm_provider import configured_provider, provider_state
from app.services.schedule_parser_service import (
    ScheduleParserUnavailable,
    apply_schedule_clarification,
    classify_schedule_intent,
    parse_schedule_audio,
    parse_schedule_text,
    transcribe_schedule_audio,
)


router = APIRouter()


class _ParseCallState:
    def __init__(self) -> None:
        self.attempted = False
        self.returned = False
        self.error: Optional[str] = None


_PARSE_CALL_STATE: contextvars.ContextVar[Optional[_ParseCallState]] = contextvars.ContextVar(
    "laoji_parse_call_state",
    default=None,
)
_ORIGINAL_CALL_OLLAMA = parser_service.call_ollama


def _schedule_generation_model_id() -> str:
    """Return the model selected by the shared generation provider.

    The parser keeps the historical ``SCHEDULE_OLLAMA_MODEL`` setting for
    local compatibility.  In cloud mode that value is stale and must not be
    emitted as if it were the model that actually processed the request.
    """
    if configured_provider() == "dashscope":
        return (
            os.getenv("LAOJI_DASHSCOPE_MODEL", "qwen3.7-flash").strip()
            or "qwen3.7-flash"
        )
    return (
        os.getenv("SCHEDULE_OLLAMA_MODEL", "qwen3.5:9b").strip()
        or "qwen3.5:9b"
    )


def _observed_call_ollama(*args: Any, **kwargs: Any) -> Any:
    state = _PARSE_CALL_STATE.get()
    if state is not None:
        state.attempted = True
    try:
        result = _ORIGINAL_CALL_OLLAMA(*args, **kwargs)
    except Exception as exc:
        if state is not None:
            state.error = str(exc)[:300]
        raise
    if state is not None:
        state.returned = True
    return result


# The parser binds call_ollama at module import time.  This wrapper observes
# the actual model call without changing parser decisions or adding fixtures.
parser_service.call_ollama = _observed_call_ollama


def _request_sha256(raw_body: bytes) -> str:
    return hashlib.sha256(raw_body).hexdigest()


def _parse_route_metadata(
    *,
    route: str,
    parsed: Optional[dict[str, Any]],
    state: _ParseCallState,
    request_id: str,
    request_sha256: str,
    latency_ms: float,
    model_only: bool = False,
) -> dict[str, Any]:
    model_success = bool(state.attempted and parsed and parsed.get("parse_source") == "local_llm")
    fallback_used = bool(state.attempted and not model_success and not model_only)
    if model_success:
        route = "model"
    elif fallback_used:
        route = "fallback"
    elif model_only and state.attempted:
        route = "model"
    return {
        "route": route,
        "model_attempted": bool(state.attempted),
        "model_success": model_success,
        "fallback_used": fallback_used,
        "model_id": _schedule_generation_model_id(),
        "request_id": request_id,
        "request_sha256": request_sha256,
        "latency_ms": round(latency_ms, 3),
        "parse_latency_ms": round(latency_ms, 3),
        "parse_source": str((parsed or {}).get("parse_source") or "rules"),
    }


def _parse_response_headers(request_id: str, trace_id: str, latency_ms: float) -> dict[str, str]:
    return {
        "X-Request-ID": request_id,
        "X-Trace-ID": trace_id,
        "Server-Timing": f"schedule-parse;dur={latency_ms:.3f}",
    }


def _schedule_model_health() -> dict[str, Any]:
    if configured_provider() == "dashscope":
        started = time.perf_counter()
        try:
            state = provider_state(probe=True)
            generation_ready = state.get("generation_ready") is True
            embedding_ready = state.get("embedding_model") in (state.get("models") or [])
            ready = bool(generation_ready and embedding_ready)
            return {
                "status": "ready" if ready else "unready",
                "ready": ready,
                "model_ready": generation_ready,
                "models_ready": generation_ready,
                "provider": "dashscope",
                "model_id": state.get("generation_model") or _schedule_generation_model_id(),
                "generation_ready": generation_ready,
                "embedding_ready": embedding_ready,
                "models_observed": state.get("models") or [],
                "ollama_base_url": state.get("embedding_base_url"),
                "latency_ms": round((time.perf_counter() - started) * 1000, 3),
                "error": None if ready else "generation_or_embedding_unready",
            }
        except Exception as exc:
            return {
                "status": "unready",
                "ready": False,
                "model_ready": False,
                "models_ready": False,
                "provider": "dashscope",
                "model_id": _schedule_generation_model_id(),
                "generation_ready": False,
                "embedding_ready": False,
                "models_observed": [],
                "ollama_base_url": None,
                "latency_ms": round((time.perf_counter() - started) * 1000, 3),
                "error": type(exc).__name__,
            }
    base_url = (
        os.getenv("SCHEDULE_OLLAMA_BASE_URL")
        or os.getenv("OLLAMA_BASE_URL")
        or os.getenv("SCHEDULE_OLLAMA_HOST")
        or "http://127.0.0.1:21434"
    ).rstrip("/")
    model_id = os.getenv("SCHEDULE_OLLAMA_MODEL", "qwen3.5:9b").strip() or "qwen3.5:9b"
    started = time.perf_counter()
    status: Optional[int] = None
    error: Optional[str] = None
    body: Any = None
    try:
        request = urllib.request.Request(f"{base_url}/api/tags", headers={"Accept": "application/json"})
        opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
        with opener.open(request, timeout=8) as response:
            status = int(response.status)
            body = json.loads(response.read(1_000_000).decode("utf-8", "replace"))
    except (urllib.error.URLError, urllib.error.HTTPError, TimeoutError, OSError, ValueError) as exc:
        error = str(exc)[:300]
    models = [
        str(item.get("name"))
        for item in (body.get("models") if isinstance(body, dict) else [])
        if isinstance(item, dict) and item.get("name")
    ]
    ready = status == 200 and model_id in models
    return {
        "status": "ready" if ready else "unready",
        "ready": ready,
        "model_ready": ready,
        "models_ready": ready,
        "model_id": model_id,
        "models_observed": models,
        "ollama_base_url": base_url,
        "latency_ms": round((time.perf_counter() - started) * 1000, 3),
        "error": error,
    }


def _to_parse_response(parsed: dict, raw_text: str = "") -> ScheduleParseResponse:
    return ScheduleParseResponse(
        title=parsed.get("title", ""),
        event_type=parsed.get("event_type", "once"),
        # The parser uses an internal empty string for an unsaveable draft;
        # the public JSON/OpenAPI contract represents an omitted date as null.
        start_date=parsed.get("start_date") or None,
        end_date=parsed.get("end_date"),
        color=parsed.get("color"),
        spanning=parsed.get("spanning"),
        start_time=parsed.get("start_time"),
        end_time=parsed.get("end_time"),
        time_period=parsed.get("time_period"),
        is_all_day=parsed.get("is_all_day", False),
        description=parsed.get("description"),
        location=parsed.get("location"),
        category=parsed.get("category"),
        detail=parsed.get("detail"),
        status=parsed.get("status"),
        reminder_minutes=parsed.get("reminder_minutes"),
        recurrence_interval=parsed.get("recurrence_interval", 1),
        recurrence_weekdays=parsed.get("recurrence_weekdays"),
        recurrence_until_date=parsed.get("recurrence_until_date"),
        raw_text=parsed.get("raw_text", raw_text),
        parse_source=parsed.get("parse_source", "rules"),
        confidence=parsed.get("confidence", 0.0),
        needs_clarification=parsed.get("needs_clarification", False),
        clarification_question=parsed.get("clarification_question"),
    )


@router.get("/model-health")
async def schedule_model_health() -> dict[str, Any]:
    """只读检查日程解析实际使用的本机模型是否已加载。"""
    return _schedule_model_health()


def _parse_error(code: str, message: str, status_code: int = 422) -> JSONResponse:
    """Expose a stable Chinese parser error without leaking provider details."""
    return JSONResponse(status_code=status_code, content={"code": code, "message": message})


def _expected_dict(expected: Any) -> dict[str, Any]:
    if expected is None:
        return {}
    return expected.model_dump(exclude_none=True)


def _compare_expected(parsed: ScheduleParseResponse, expected: Any) -> tuple[dict[str, bool], dict[str, dict[str, Any]]]:
    expected_values = _expected_dict(expected)
    actual = parsed.model_dump()
    matched: dict[str, bool] = {}
    mismatches: dict[str, dict[str, Any]] = {}
    for field, expected_value in expected_values.items():
        actual_value = actual.get(field)
        ok = actual_value == expected_value
        matched[field] = ok
        if not ok:
            mismatches[field] = {"expected": expected_value, "actual": actual_value}
    return matched, mismatches


def _normalized_text(value: str) -> str:
    return re.sub(r"[\s，,。.!！?？；;：:\-_/\[\]（）()]+", "", value or "").lower()


def _transcript_score(expected: str, actual: str) -> float:
    expected_norm = _normalized_text(expected)
    actual_norm = _normalized_text(actual)
    if not expected_norm and not actual_norm:
        return 1.0
    if not expected_norm or not actual_norm:
        return 0.0
    return round(SequenceMatcher(None, expected_norm, actual_norm).ratio(), 4)


@router.post("/parse", response_model=ScheduleParseResponse)
async def parse_text(request: ScheduleParseRequest, raw_request: Request):
    """将自然语言文本解析为老记日程草稿，并返回真实路径 telemetry。"""
    started = time.perf_counter()
    raw_body = await raw_request.body()
    request_sha256 = _request_sha256(raw_body)
    request_id = raw_request.headers.get("x-request-id") or request_sha256[:24]
    trace_id = raw_request.headers.get("x-trace-id") or f"laoji-parse-{request_id}"
    state = _ParseCallState()
    token = _PARSE_CALL_STATE.set(state)

    def _error_response(
        code: str,
        message: str,
        status_code: int,
        route: str = "reject",
        *,
        model_only: bool = False,
    ) -> JSONResponse:
        body: dict[str, Any] = {"code": code, "message": message}
        body.update(_parse_route_metadata(
            route=route,
            parsed=None,
            state=state,
            request_id=request_id,
            request_sha256=request_sha256,
            latency_ms=(time.perf_counter() - started) * 1000,
            model_only=model_only,
        ))
        latency = float(body["latency_ms"])
        return JSONResponse(
            status_code=status_code,
            content=body,
            headers=_parse_response_headers(request_id, trace_id, latency),
        )

    try:
        model_only = (
            request.client_rule_status == "unresolved"
            and request.client_intent == "create"
        )
        intent, code, message = ("create", None, None) if model_only else classify_schedule_intent(request.text)
        if intent != "create":
            operation_route = intent if intent in {"query", "delete"} else "reject"
            return _error_response(
                code or "not_schedule",
                message or "这段内容不是日程安排",
                422,
                operation_route,
            )
        try:
            parsed = await parse_schedule_text(
                request.text,
                reference_datetime=request.reference_datetime,
                timezone_name=request.timezone,
                model_only=model_only,
            )
        except ScheduleParserUnavailable:
            return _error_response(
                "parser_unavailable",
                "日程解析服务暂时不可用，请稍后重试",
                503,
                "model" if model_only else "fallback",
                model_only=model_only,
            )
        except ValueError as exc:
            return _error_response("invalid_schedule", str(exc), 422)
        if parsed is None:
            return _error_response(
                "not_schedule",
                "没有识别到可创建的日程，请补充具体安排。",
                422,
                "model" if model_only else "reject",
                model_only=model_only,
            )
        body = _to_parse_response(parsed, raw_text=request.text).model_dump()
        body.update(_parse_route_metadata(
            route="quick",
            parsed=parsed,
            state=state,
            request_id=request_id,
            request_sha256=request_sha256,
            latency_ms=(time.perf_counter() - started) * 1000,
            model_only=model_only,
        ))
        latency = float(body["latency_ms"])
        return JSONResponse(
            status_code=200,
            content=body,
            headers=_parse_response_headers(request_id, trace_id, latency),
        )
    finally:
        _PARSE_CALL_STATE.reset(token)


@router.post("/diagnostics/parse-quality", response_model=ScheduleQualityResponse)
async def diagnose_parse_quality(
    request: ScheduleTextQualityRequest,
    current_user: dict = Depends(get_current_user),
):
    """批量检测自然语言解析质量；需要登录态，避免公网滥用。"""
    items: list[ScheduleQualityItemResult] = []
    for sample in request.samples:
        started = time.perf_counter()
        matched: dict[str, bool] = {}
        mismatches: dict[str, dict[str, Any]] = {}
        parsed_response: Optional[ScheduleParseResponse] = None
        error: Optional[str] = None
        try:
            parsed = await parse_schedule_text(
                sample.text,
                reference_datetime=sample.reference_datetime,
                timezone_name=sample.timezone,
            )
            if parsed is None:
                error = "parse returned null"
            else:
                parsed_response = _to_parse_response(parsed, raw_text=sample.text)
                matched, mismatches = _compare_expected(parsed_response, sample.expected)
        except Exception as exc:
            error = str(exc)
        duration_ms = int((time.perf_counter() - started) * 1000)
        ok = parsed_response is not None and not mismatches and error is None
        items.append(ScheduleQualityItemResult(
            id=sample.id,
            input_text=sample.text,
            parsed=parsed_response,
            ok=ok,
            duration_ms=duration_ms,
            matched=matched,
            mismatches=mismatches,
            error=error,
        ))
    return ScheduleQualityResponse(total=len(items), passed=sum(1 for item in items if item.ok), items=items)


@router.post("/diagnostics/audio-quality", response_model=ScheduleQualityResponse)
async def diagnose_audio_quality(
    request: ScheduleAudioQualityRequest,
    current_user: dict = Depends(get_current_user),
):
    """批量检测音频 ASR 与结构化解析质量；需要登录态，避免公网滥用。"""
    items: list[ScheduleQualityItemResult] = []
    for sample in request.samples:
        started = time.perf_counter()
        matched: dict[str, bool] = {}
        mismatches: dict[str, dict[str, Any]] = {}
        transcript: Optional[str] = None
        score: Optional[float] = None
        parsed_response: Optional[ScheduleParseResponse] = None
        error: Optional[str] = None
        try:
            asr = await transcribe_schedule_audio(sample.audio_base64, sample.filename)
            transcript = str((asr or {}).get("text") or "").strip()
            if not transcript:
                error = "transcript is empty"
            if sample.expected_text is not None:
                score = _transcript_score(sample.expected_text, transcript)
                transcript_ok = score >= request.min_transcript_score
                matched["transcript"] = transcript_ok
                if not transcript_ok:
                    mismatches["transcript"] = {
                        "expected": sample.expected_text,
                        "actual": transcript,
                        "score": score,
                        "min_score": request.min_transcript_score,
                    }
            if transcript:
                parsed = await parse_schedule_text(transcript)
                if parsed is None:
                    error = error or "parse returned null"
                else:
                    parsed_response = _to_parse_response(parsed, raw_text=transcript)
                    parse_matched, parse_mismatches = _compare_expected(parsed_response, sample.expected)
                    matched.update(parse_matched)
                    mismatches.update(parse_mismatches)
        except Exception as exc:
            error = str(exc)
        duration_ms = int((time.perf_counter() - started) * 1000)
        ok = transcript is not None and parsed_response is not None and not mismatches and error is None
        items.append(ScheduleQualityItemResult(
            id=sample.id,
            filename=sample.filename,
            transcript=transcript,
            transcript_score=score,
            parsed=parsed_response,
            ok=ok,
            duration_ms=duration_ms,
            matched=matched,
            mismatches=mismatches,
            error=error,
        ))
    return ScheduleQualityResponse(total=len(items), passed=sum(1 for item in items if item.ok), items=items)


@router.post("/clarify", response_model=ScheduleParseResponse)
async def clarify_text(request: ScheduleClarifyRequest):
    """把用户对追问的补充应用到当前日程草稿。"""
    try:
        parsed = apply_schedule_clarification(
            request.current.model_dump(),
            request.answer,
            reference_datetime=request.reference_datetime,
            timezone_name=request.timezone,
        )
    except ValueError as exc:
        return _parse_error("invalid_schedule", str(exc))
    if parsed is None:
        return _parse_error("invalid_schedule", "没有理解这次补充，请直接填写具体日期或时间")
    return _to_parse_response(parsed, raw_text=request.current.raw_text)


@router.post("/parse-audio", response_model=ScheduleParseResponse)
async def parse_audio(request: ScheduleAudioParseRequest):
    """将语音音频直接解析为日程：ASR 转写 -> 结构化解析。"""
    parsed = await parse_schedule_audio(request.audio_base64, request.filename)
    if parsed is None:
        raise HTTPException(
            status_code=422,
            detail="无法从语音中提取日程，请确保麦克风清晰并说得更明确",
        )
    return _to_parse_response(parsed)


@router.post("/asr/transcribe", response_model=ScheduleAsrTranscribeResponse)
async def transcribe_audio(request: ScheduleAsrTranscribeRequest):
    """老记轻量 ASR：录音后一次性转写，只返回文字。"""
    result = await transcribe_schedule_audio(request.audio_base64, request.filename)
    if result is None:
        raise HTTPException(status_code=422, detail="没有识别到有效语音，请确认音量和录音内容")
    return ScheduleAsrTranscribeResponse(**result)


@router.post("/events", response_model=ScheduleEvent, status_code=201)
def create_event(request: ScheduleEventCreate, current_user: dict = Depends(get_current_user)):
    """创建当前登录用户的老记日程。"""
    try:
        event = db.create_event(
            user_id=int(current_user["id"]),
            title=request.title,
            event_type=request.event_type,
            start_date=request.start_date,
            end_date=request.end_date,
            color=request.color,
            start_time=request.start_time,
            end_time=request.end_time,
            is_all_day=request.is_all_day,
            description=request.description,
            location=request.location,
            category=request.category,
            detail=request.detail,
            status=request.status,
            reminder_minutes=request.reminder_minutes,
            raw_text=request.raw_text,
            client_request_id=request.client_request_id,
            recurrence_interval=request.recurrence_interval,
            recurrence_weekdays=request.recurrence_weekdays,
            recurrence_until_date=request.recurrence_until_date,
        )
    except (db.ScheduleWriteBlocked, db.ScheduleIdempotencyConflict) as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    return ScheduleEvent(**event)


@router.get("/events", response_model=ScheduleEventListResponse)
def list_events(
    year: Optional[int] = Query(None, ge=2000, le=2100),
    month: Optional[int] = Query(None, ge=1, le=12),
    current_user: dict = Depends(get_current_user),
):
    """传入 year + month 展开月份；不传年月返回可本地展开的全局 catalog。"""
    events = db.list_events(year=year, month=month, user_id=int(current_user["id"]))
    return ScheduleEventListResponse(
        events=[ScheduleEvent(**event) for event in events],
        total=len(events),
    )


@router.get("/events/{event_id}", response_model=ScheduleEvent)
def get_event(event_id: int, current_user: dict = Depends(get_current_user)):
    """获取当前登录用户的单个老记日程详情。"""
    event = db.get_event(event_id, user_id=int(current_user["id"]))
    if event is None:
        raise HTTPException(status_code=404, detail="日程不存在")
    return ScheduleEvent(**event)


@router.put("/events/{event_id}", response_model=ScheduleEvent)
def update_event(
    event_id: int,
    request: ScheduleEventUpdate,
    current_user: dict = Depends(get_current_user),
):
    """更新当前登录用户的老记日程。"""
    try:
        event = db.update_event_fields(
            event_id=event_id,
            user_id=int(current_user["id"]),
            changes=request.model_dump(exclude_unset=True, exclude={"spanning"}),
            legacy_compat=True,
        )
    except db.ScheduleWriteBlocked as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    if event is None:
        raise HTTPException(status_code=404, detail="日程不存在")
    return ScheduleEvent(**event)


@router.delete("/events/{event_id}", status_code=204)
def delete_event(event_id: int, current_user: dict = Depends(get_current_user)):
    """删除当前登录用户的老记日程。"""
    try:
        deleted = db.delete_event(event_id, user_id=int(current_user["id"]))
    except db.ScheduleWriteBlocked as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    if not deleted:
        raise HTTPException(status_code=404, detail="日程不存在")


@router.post("/events/{event_id}/commands", response_model=ScheduleEventStateCommandResponse)
def command_event_state(
    event_id: int,
    request: ScheduleEventStateCommand,
    current_user: dict = Depends(get_current_user),
):
    """幂等地删除或恢复整个系列、单个实例或此后实例。"""
    try:
        result = db.command_event_state(
            event_id=event_id,
            user_id=int(current_user["id"]),
            client_request_id=request.client_request_id,
            desired_state=request.desired_state,
            scope=request.scope,
            occurrence_date=request.occurrence_date,
            expected_revision=request.expected_revision,
        )
    except (db.ScheduleWriteBlocked, db.ScheduleCommandConflict) as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    if result is None:
        raise HTTPException(status_code=404, detail="日程不存在")
    return ScheduleEventStateCommandResponse(**result)


@router.post(
    "/events/{event_id}/edit-commands",
    response_model=ScheduleEventEditCommandResponse,
)
def command_event_edit(
    event_id: int,
    request: ScheduleEventEditCommand,
    current_user: dict = Depends(get_current_user),
):
    """Replay-safe sparse editing for an occurrence, following instances, or a series."""
    try:
        result = db.command_event_edit(
            event_id=event_id,
            user_id=int(current_user["id"]),
            client_request_id=request.client_request_id,
            scope=request.scope,
            occurrence_date=request.occurrence_date,
            expected_revision=request.expected_revision,
            patch=request.patch.model_dump(exclude_unset=True),
        )
    except db.ScheduleCommandConflict as exc:
        raise HTTPException(status_code=409, detail=exc.code) from exc
    except db.ScheduleWriteBlocked as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    if result is None:
        raise HTTPException(status_code=404, detail="日程不存在")
    return ScheduleEventEditCommandResponse(**result)


@router.get(
    "/event-commands/{client_request_id}",
    response_model=ScheduleEventEditCommandResponse,
)
def get_event_edit_command(
    client_request_id: str,
    current_user: dict = Depends(get_current_user),
):
    result = db.get_event_command(
        client_request_id=client_request_id,
        user_id=int(current_user["id"]),
        command_type="edit",
    )
    if result is None:
        raise HTTPException(status_code=404, detail="事件编辑命令不存在")
    return ScheduleEventEditCommandResponse(**result)
