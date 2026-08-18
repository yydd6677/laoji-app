"""Privacy-safe request and model-stage telemetry for the candidate service."""

from __future__ import annotations

import contextvars
import json
import logging
import os
import re
import time
import uuid
from contextlib import contextmanager
from typing import Any

from app.privacy_logging import privacy_log

@contextmanager
def ollama_trace(_trace_id: str):
    """Compatibility span scope; model timings come from LlmProvider state."""
    yield []


LOGGER = logging.getLogger("uvicorn.error.laoji.service.telemetry")
_TRACE_ID_RE = re.compile(r"^[A-Za-z0-9._:-]{8,128}$")
_HEALTH_PATHS = {"/health", "/api/health"}
_TRACE_CONTEXT: contextvars.ContextVar[dict[str, Any] | None] = contextvars.ContextVar(
    "laoji_service_trace_context",
    default=None,
)


def _enabled(name: str, default: bool) -> bool:
    raw = os.getenv(name)
    if raw is None:
        return default
    return raw.strip().lower() in {"1", "true", "yes", "on"}


def _trace_id(scope: dict[str, Any]) -> str:
    for raw_name, raw_value in scope.get("headers") or []:
        if raw_name.lower() != b"x-trace-id":
            continue
        value = raw_value.decode("ascii", errors="ignore").strip()
        if _TRACE_ID_RE.fullmatch(value):
            return value
    return uuid.uuid4().hex


def _sum_span(spans: list[dict[str, Any]], key: str) -> float:
    return round(sum(
        float(span[key])
        for span in spans
        if isinstance(span.get(key), (int, float))
    ), 3)


def _server_timing(
    total_ms: float,
    model_spans: list[dict[str, Any]],
    stage_spans: list[dict[str, Any]],
) -> bytes:
    model_ms = _sum_span(model_spans, "model_total_ms")
    load_ms = _sum_span(model_spans, "model_load_ms")
    prompt_ms = _sum_span(model_spans, "prompt_inference_ms")
    generation_ms = _sum_span(model_spans, "generation_inference_ms")
    stage_totals: dict[str, float] = {}
    for item in stage_spans:
        duration = item.get("duration_ms")
        if not item.get("applicable", True) or not isinstance(duration, (int, float)):
            continue
        name = str(item.get("stage") or "")
        stage_totals[name] = stage_totals.get(name, 0.0) + float(duration)
    queue_ms = stage_totals.get("queue_wait", 0.0)
    load_ms += stage_totals.get("model_load_or_warmup", 0.0)
    inference_ms = prompt_ms + generation_ms + stage_totals.get("inference", 0.0)
    values = [f"app;dur={total_ms:.3f}"]
    if model_spans or stage_spans:
        values.extend((
            f"model;dur={model_ms:.3f}",
            f"load;dur={load_ms:.3f}",
            f"prompt;dur={prompt_ms:.3f}",
            f"generation;dur={generation_ms:.3f}",
            f"queue_wait;dur={queue_ms:.3f}",
            f"model_load_or_warmup;dur={load_ms:.3f}",
            f"inference;dur={inference_ms:.3f}",
            f"verification;dur={stage_totals.get('verification', 0.0):.3f}",
            f"persistence;dur={stage_totals.get('persistence', 0.0):.3f}",
        ))
    return ", ".join(values).encode("ascii")


def _safe_optional(value: Any) -> str | int | float | bool | None:
    if value is None or isinstance(value, (int, float, bool)):
        return value
    return str(value)[:160]


_CLIENT_TRACE_HEADERS = {
    b"x-laoji-client-request-id": "client_request_id",
    b"x-laoji-call-source": "call_source",
    b"x-laoji-meeting-id": "meeting_id",
    b"x-laoji-input-sha256": "input_sha256",
    b"x-laoji-input-fingerprint": "input_fingerprint",
    b"x-laoji-input-lines": "input_line_count",
    b"x-laoji-input-chars": "input_char_count",
    b"x-laoji-template-id": "template_id",
    b"x-laoji-template-revision": "template_revision",
    b"x-laoji-auth-mode": "auth_mode",
    b"x-laoji-device-id": "device_id",
    b"x-laoji-device-name": "device_name",
    b"x-laoji-platform": "platform",
    b"x-laoji-os-version": "os_version",
    b"x-laoji-app-version": "app_version",
    b"x-laoji-build-version": "build_version",
}


def _client_trace_metadata(scope: dict[str, Any]) -> dict[str, str]:
    """Read bounded, content-free client metadata for request correlation."""
    result: dict[str, str] = {}
    for raw_name, raw_value in scope.get("headers") or []:
        key = _CLIENT_TRACE_HEADERS.get(raw_name.lower())
        if not key:
            continue
        value = raw_value.decode("utf-8", errors="ignore")
        value = re.sub(r"[\x00-\x1f\x7f]", "", value).strip()[:180]
        if value:
            result[key] = value
    return result


@contextmanager
def telemetry_scope(
    trace_id: str,
    *,
    service: str,
    operation: str,
    task_id: str | None = None,
    emit_model_trace: bool = False,
    client_metadata: dict[str, str] | None = None,
):
    token = _TRACE_CONTEXT.set({
        "trace_id": trace_id,
        "service": service,
        "operation": operation,
        "task_id": task_id,
        "stage_spans": [],
        "client_metadata": dict(client_metadata or {}),
    })
    try:
        with ollama_trace(trace_id) as model_spans:
            try:
                yield model_spans
            finally:
                if emit_model_trace and model_spans:
                    privacy_log(
                        "service_model_trace",
                        capability=service,
                        stage=operation,
                        count=len(model_spans),
                        status="completed",
                    )
    finally:
        _TRACE_CONTEXT.reset(token)


def current_trace_context() -> dict[str, Any] | None:
    context = _TRACE_CONTEXT.get()
    return dict(context) if context is not None else None


def emit_stage(
    stage_name: str,
    duration_ms: float | None,
    *,
    status: str = "ok",
    applicable: bool = True,
    purpose: str | None = None,
    attempt: int | None = None,
    operation: str | None = None,
    **fields: Any,
) -> None:
    context = _TRACE_CONTEXT.get()
    if context is None:
        return
    payload = {
        "stage": stage_name,
        "duration_ms": round(duration_ms, 3) if duration_ms is not None else None,
        "status": status,
        "applicable": applicable,
        "purpose": purpose,
        "attempt": attempt,
    }
    stage_spans = context.get("stage_spans")
    if isinstance(stage_spans, list):
        stage_spans.append({
            "stage": stage_name,
            "duration_ms": payload["duration_ms"],
            "applicable": applicable,
        })
    safe_fields = {
        key: _safe_optional(value)
        for key, value in fields.items()
        if key in {"bytes", "count", "queue_depth", "revision", "hash_prefix", "error_type"}
    }
    privacy_log(
        "service_stage",
        capability=operation or context.get("service") or "service",
        stage=stage_name,
        duration_ms=duration_ms,
        status=status,
        purpose=purpose,
        attempt=attempt,
        **safe_fields,
    )


@contextmanager
def stage(
    stage_name: str,
    *,
    applicable: bool = True,
    purpose: str | None = None,
    attempt: int | None = None,
    operation: str | None = None,
    **fields: Any,
):
    if not applicable:
        emit_stage(
            stage_name,
            None,
            applicable=False,
            purpose=purpose,
            attempt=attempt,
            operation=operation,
            **fields,
        )
        yield
        return
    started = time.perf_counter()
    try:
        yield
    except BaseException as error:
        emit_stage(
            stage_name,
            (time.perf_counter() - started) * 1000,
            status="error",
            purpose=purpose,
            attempt=attempt,
            operation=operation,
            error_type=type(error).__name__,
            **fields,
        )
        raise
    else:
        emit_stage(
            stage_name,
            (time.perf_counter() - started) * 1000,
            purpose=purpose,
            attempt=attempt,
            operation=operation,
            **fields,
        )


class ServiceTelemetryMiddleware:
    """Attach trace and aggregate Server-Timing headers without bodies."""

    def __init__(self, app: Any, service_name: str):
        self.app = app
        self.service_name = service_name

    async def __call__(self, scope: dict[str, Any], receive: Any, send: Any) -> None:
        if scope.get("type") != "http" or not _enabled("SERVICE_TELEMETRY_ENABLED", True):
            await self.app(scope, receive, send)
            return
        trace_id = _trace_id(scope)
        client_metadata = _client_trace_metadata(scope)
        started = time.perf_counter()
        status_code = 500
        path = str(scope.get("path") or "")
        operation = f"{str(scope.get('method') or '').lower()} {path}"
        with telemetry_scope(
            trace_id,
            service=self.service_name,
            operation=operation,
            client_metadata=client_metadata,
        ) as model_spans:
            async def send_with_timing(message: dict[str, Any]) -> None:
                nonlocal status_code
                if message.get("type") == "http.response.start":
                    status_code = int(message.get("status") or 500)
                    context = _TRACE_CONTEXT.get() or {}
                    stage_spans = context.get("stage_spans")
                    headers = list(message.get("headers") or [])
                    headers.extend((
                        (b"x-trace-id", trace_id.encode("ascii")),
                        (
                            b"server-timing",
                            _server_timing(
                                (time.perf_counter() - started) * 1000,
                                model_spans,
                                stage_spans if isinstance(stage_spans, list) else [],
                            ),
                        ),
                    ))
                    message = {**message, "headers": headers}
                await send(message)

            try:
                await self.app(scope, receive, send_with_timing)
            finally:
                if path not in _HEALTH_PATHS or _enabled("SERVICE_TELEMETRY_LOG_HEALTH", False):
                    privacy_log(
                        "service_request_timing",
                        capability=self.service_name,
                        stage=str(scope.get("method") or "request"),
                        status=status_code,
                        duration_ms=(time.perf_counter() - started) * 1000,
                        count=len(model_spans),
                    )
