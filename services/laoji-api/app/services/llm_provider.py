"""The single, swappable LLM boundary used by LaoJi.

Generation can be sent either to the private local Ollama instance or to the
DashScope OpenAI-compatible API.  The business services deliberately know
neither transport; switching the provider is an environment-only operation.
Embeddings remain local by design, so Q&A retrieval does not start sending
meeting text to the cloud.
"""

from __future__ import annotations

from dataclasses import dataclass, field
import itertools
import math
import os
import queue
import threading
import time
from types import SimpleNamespace
from typing import Any, Callable, NamedTuple
from urllib.parse import urlsplit

import requests


GENERATION_MODEL = os.getenv("LAOJI_GENERATION_MODEL", "qwen3.5:9b").strip() or "qwen3.5:9b"
EMBEDDING_MODEL = (
    os.getenv("LAOJI_EMBEDDING_MODEL", "qwen3-embedding:0.6b").strip()
    or "qwen3-embedding:0.6b"
)
DASHSCOPE_MODEL = (
    os.getenv("LAOJI_DASHSCOPE_MODEL", "qwen3.7-flash").strip()
    or "qwen3.7-flash"
)
KEEP_ALIVE = -1
PRIORITIES = {"interactive": 0, "background": 1}


class LlmProviderError(RuntimeError):
    pass


class LlmConfig(NamedTuple):
    """Minimal immutable configuration accepted by the shared provider.

    The fields are intentionally transport-neutral.  Existing callers still
    construct an Ollama-shaped config; :func:`_canonical_config` projects it
    onto the selected backend at the last possible moment.
    """

    base_url: str
    model: str
    provider: str = "ollama"
    api_key: str = ""
    chat_path: str = "/api/chat"


def _env_bool(name: str, default: bool) -> bool:
    value = os.getenv(name)
    if value is None:
        return default
    normalized = value.strip().lower()
    if normalized in {"1", "true", "yes", "on"}:
        return True
    if normalized in {"0", "false", "no", "off"}:
        return False
    return default


def configured_provider() -> str:
    """Return the explicit generation backend.

    There is intentionally no automatic cloud/local fallback.  A silent
    fallback would make a cloud outage look like a successful local response,
    make cost attribution impossible, and could unexpectedly put private
    prompts back on a different service.  Switching remains a one-line
    environment change.
    """
    raw = os.getenv("LAOJI_LLM_PROVIDER", "ollama").strip().lower()
    aliases = {"local": "ollama", "cloud": "dashscope", "bailian": "dashscope"}
    provider = aliases.get(raw, raw)
    if provider not in {"ollama", "dashscope"}:
        raise LlmProviderError("llm_provider_invalid")
    return provider


def canonical_ollama_base_url() -> str:
    raw = os.getenv("LAOJI_OLLAMA_BASE_URL", "http://127.0.0.1:21434").strip().rstrip("/")
    parsed = urlsplit(raw)
    if (
        parsed.scheme != "http"
        or parsed.hostname not in {"127.0.0.1", "localhost", "::1"}
        or parsed.port != 21434
        or parsed.username is not None
        or parsed.password is not None
        or parsed.path not in {"", "/"}
        or parsed.query
        or parsed.fragment
    ):
        raise LlmProviderError("ollama_base_url_invalid")
    return raw


def canonical_dashscope_base_url() -> str:
    """Validate a DashScope/OpenAI-compatible base URL from server config."""
    raw = os.getenv(
        "LAOJI_DASHSCOPE_BASE_URL",
        "https://dashscope.aliyuncs.com/compatible-mode/v1",
    ).strip().rstrip("/")
    parsed = urlsplit(raw)
    if (
        parsed.scheme != "https"
        or not parsed.hostname
        or parsed.username is not None
        or parsed.password is not None
        or parsed.query
        or parsed.fragment
        or not parsed.path
    ):
        raise LlmProviderError("dashscope_base_url_invalid")
    return raw


def _dashscope_api_key() -> str:
    value = os.getenv("LAOJI_DASHSCOPE_API_KEY", "").strip()
    if not value:
        raise LlmProviderError("dashscope_api_key_missing")
    return value


@dataclass
class _ProviderJob:
    priority: str
    operation: str
    call: Callable[[], Any]
    queued_at: float = field(default_factory=time.perf_counter)
    finished: threading.Event = field(default_factory=threading.Event)
    result: Any = None
    error: Exception | None = None


class _ProviderCoordinator:
    def __init__(self) -> None:
        self._queue: queue.PriorityQueue[tuple[int, int, _ProviderJob]] = queue.PriorityQueue(
            maxsize=max(8, int(os.getenv("LAOJI_LLM_QUEUE_CAPACITY", "128")))
        )
        self._sequence = itertools.count()
        self._lock = threading.Lock()
        self._pending = {name: 0 for name in PRIORITIES}
        self._active: dict[str, Any] | None = None
        self._last: dict[str, Any] | None = None
        self._last_by_operation: dict[str, dict[str, Any]] = {}
        threading.Thread(target=self._worker, name="laoji-llm-provider", daemon=True).start()

    def submit(
        self,
        *,
        priority: str,
        operation: str,
        call: Callable[[], Any],
        wait_seconds: float,
    ) -> Any:
        normalized = priority.strip().lower()
        if normalized not in PRIORITIES:
            raise LlmProviderError("llm_priority_invalid")
        job = _ProviderJob(priority=normalized, operation=operation, call=call)
        try:
            self._queue.put_nowait((PRIORITIES[normalized], next(self._sequence), job))
        except queue.Full as exc:
            raise LlmProviderError("llm_queue_full") from exc
        with self._lock:
            self._pending[normalized] += 1
        if not job.finished.wait(max(1.0, wait_seconds)):
            raise LlmProviderError("llm_queue_timeout")
        if job.error is not None:
            raise job.error
        return job.result

    def snapshot(self) -> dict[str, Any]:
        with self._lock:
            return {
                "depth": sum(self._pending.values()),
                "by_priority": dict(self._pending),
                "active": dict(self._active) if self._active else None,
                "last": dict(self._last) if self._last else None,
                "last_by_operation": {
                    key: dict(value)
                    for key, value in self._last_by_operation.items()
                },
            }

    def _worker(self) -> None:
        while True:
            _rank, _sequence, job = self._queue.get()
            with self._lock:
                self._pending[job.priority] = max(0, self._pending[job.priority] - 1)
                self._active = {"priority": job.priority, "operation": job.operation}
            started = time.perf_counter()
            queue_ms = round((started - job.queued_at) * 1000, 3)
            success = False
            try:
                job.result = job.call()
                success = True
            except Exception as exc:
                job.error = exc
            finally:
                elapsed_ms = round((time.perf_counter() - started) * 1000, 3)
                with self._lock:
                    self._active = None
                    completed = {
                        "priority": job.priority,
                        "operation": job.operation,
                        "success": success,
                        "queue_ms": queue_ms,
                        "elapsed_ms": elapsed_ms,
                        "completed_at_epoch_ms": round(time.time() * 1000),
                    }
                    self._last = completed
                    self._last_by_operation[job.operation] = completed
                job.finished.set()
                self._queue.task_done()


_COORDINATOR = _ProviderCoordinator()
_SESSION = requests.Session()
_SESSION.trust_env = False
_PROBE_LOCK = threading.Lock()
_EMBEDDING_PROBE_CACHE: dict[str, Any] = {}
_INFERENCE_TELEMETRY_LOCK = threading.Lock()
_INFERENCE_TELEMETRY: dict[str, dict[str, Any]] = {}


def _bounded_nonnegative_int(value: Any) -> int | None:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    integer = int(value)
    return integer if 0 <= integer <= 9_007_199_254_740_991 else None


def _json_output_shape(value: str) -> dict[str, int]:
    """Describe JSON response shape numerically without retaining string data."""
    in_string = False
    escaped = False
    string_length = 0
    string_count = 0
    total_string_chars = 0
    max_string_chars = 0
    depth = 0
    max_depth = 0
    for character in value:
        if in_string:
            if escaped:
                escaped = False
                string_length += 1
            elif character == "\\":
                escaped = True
            elif character == '"':
                in_string = False
                string_count += 1
                total_string_chars += string_length
                max_string_chars = max(max_string_chars, string_length)
                string_length = 0
            else:
                string_length += 1
            continue
        if character == '"':
            in_string = True
        elif character in "[{":
            depth += 1
            max_depth = max(max_depth, depth)
        elif character in "]}":
            depth = max(0, depth - 1)
    return {
        "output_whitespace_chars": sum(character.isspace() for character in value),
        "output_newline_chars": value.count("\n") + value.count("\r"),
        "output_string_count": string_count,
        "output_total_string_chars": total_string_chars,
        "output_max_string_chars": max_string_chars,
        "output_max_nesting": max_depth,
        "output_fact_id_fields": value.count('"fact_id"'),
        "output_source_id_fields": value.count('"source_id"'),
        "output_relation_type_fields": value.count('"relation_type"'),
        "output_action_id_fields": value.count('"action_id"'),
        "output_content_fields": value.count('"content"'),
        "output_compact_fact_slots": sum(
            value.count(f'"f{index}":') for index in range(1, 13)
        ),
        "output_compact_relation_slots": sum(
            value.count(f'"r{index}":') for index in range(1, 17)
        ),
        "output_compact_action_slots": sum(
            value.count(f'"a{index}":') for index in range(1, 7)
        ),
    }


def _record_inference_telemetry(
    operation: str | None,
    *,
    provider: str,
    body: dict[str, Any],
    output_text: str,
) -> None:
    """Retain bounded performance counters without prompts or model output."""
    name = str(operation or "llm.chat").strip()[:120] or "llm.chat"
    snapshot: dict[str, Any] = {
        "provider": provider,
        "completed_at_epoch_ms": round(time.time() * 1000),
        "output_bytes": len(output_text.encode("utf-8")),
    }
    if output_text:
        snapshot.update(_json_output_shape(output_text))
    if provider == "ollama":
        for field in (
            "total_duration",
            "load_duration",
            "prompt_eval_count",
            "prompt_eval_duration",
            "eval_count",
            "eval_duration",
        ):
            value = _bounded_nonnegative_int(body.get(field))
            if value is not None:
                snapshot[field] = value
        reason = body.get("done_reason")
        if isinstance(reason, str) and reason and len(reason) <= 40:
            snapshot["done_reason"] = reason
    else:
        usage = body.get("usage") if isinstance(body.get("usage"), dict) else {}
        for field in ("prompt_tokens", "completion_tokens", "total_tokens"):
            value = _bounded_nonnegative_int(usage.get(field))
            if value is not None:
                snapshot[field] = value
    with _INFERENCE_TELEMETRY_LOCK:
        previous = _INFERENCE_TELEMETRY.get(name) or {}
        snapshot["call_count"] = int(previous.get("call_count") or 0) + 1
        for field in (
            "output_bytes",
            "total_duration",
            "load_duration",
            "prompt_eval_count",
            "prompt_eval_duration",
            "eval_count",
            "eval_duration",
            "prompt_tokens",
            "completion_tokens",
            "total_tokens",
            "output_whitespace_chars",
            "output_newline_chars",
            "output_string_count",
            "output_total_string_chars",
            "output_max_nesting",
            "output_fact_id_fields",
            "output_source_id_fields",
            "output_relation_type_fields",
            "output_action_id_fields",
            "output_content_fields",
            "output_compact_fact_slots",
            "output_compact_relation_slots",
            "output_compact_action_slots",
        ):
            current = snapshot.get(field)
            if isinstance(current, int):
                snapshot[f"cumulative_{field}"] = (
                    int(previous.get(f"cumulative_{field}") or 0) + current
                )
        _INFERENCE_TELEMETRY[name] = snapshot


def _inference_telemetry_snapshot() -> dict[str, dict[str, Any]]:
    with _INFERENCE_TELEMETRY_LOCK:
        return {name: dict(value) for name, value in _INFERENCE_TELEMETRY.items()}


def _reset_inference_telemetry_for_tests() -> None:
    with _INFERENCE_TELEMETRY_LOCK:
        _INFERENCE_TELEMETRY.clear()


def _embedding_inference_state(base_url: str) -> dict[str, Any]:
    """Probe a real, privacy-free embedding and cache the bounded result."""
    try:
        cache_seconds = max(
            5.0,
            min(300.0, float(os.getenv("LAOJI_LLM_READINESS_CACHE_SECONDS", "30"))),
        )
    except ValueError:
        cache_seconds = 30.0
    now = time.monotonic()
    with _PROBE_LOCK:
        cached_at = _EMBEDDING_PROBE_CACHE.get("cached_at")
        if isinstance(cached_at, float) and now - cached_at < cache_seconds:
            return dict(_EMBEDDING_PROBE_CACHE)
        started = time.perf_counter()
        ready = False
        error_code: str | None = None
        try:
            response = _SESSION.post(
                f"{base_url}/api/embed",
                json={
                    "model": EMBEDDING_MODEL,
                    "input": ["LaoJi readiness probe"],
                    "dimensions": 32,
                    "truncate": True,
                    "keep_alive": KEEP_ALIVE,
                    # Keep the privacy-free readiness probe from evicting the
                    # warm 9B generator on compact single-GPU deployments.
                    "options": {"num_ctx": 2048, "num_gpu": 0},
                },
                headers={
                    "X-Laoji-Priority": "interactive",
                    "X-Laoji-Operation": "readiness.embedding",
                },
                timeout=max(
                    1.0,
                    min(15.0, float(os.getenv("LAOJI_LLM_READINESS_EMBED_TIMEOUT", "10"))),
                ),
            )
            response.raise_for_status()
            payload = response.json()
            embeddings = payload.get("embeddings") if isinstance(payload, dict) else None
            if not isinstance(embeddings, list) or len(embeddings) != 1:
                raise LlmProviderError("embedding_response_invalid")
            _normalized_embedding(embeddings[0])
            ready = True
        except requests.Timeout:
            error_code = "embedding_probe_timeout"
        except requests.RequestException:
            error_code = "embedding_probe_failed"
        except (LlmProviderError, TypeError, ValueError):
            error_code = "embedding_probe_invalid"
        result = {
            "cached_at": now,
            "ready": ready,
            "latency_ms": round((time.perf_counter() - started) * 1000, 3),
            "error_code": error_code,
        }
        _EMBEDDING_PROBE_CACHE.clear()
        _EMBEDDING_PROBE_CACHE.update(result)
        return dict(result)


def _reset_provider_probe_cache_for_tests() -> None:
    with _PROBE_LOCK:
        _EMBEDDING_PROBE_CACHE.clear()


def _call_ollama_transport(
    config: Any,
    system_prompt: str,
    transcript: str,
    *,
    timeout: int = 0,
    max_tokens: int | None = None,
    options: dict[str, Any] | None = None,
    response_format: str | dict[str, Any] | None = None,
    priority: str | None = None,
    telemetry_operation: str | None = None,
) -> str:
    """Call Ollama directly so compact production has no legacy package dependency."""
    try:
        default_max_tokens = int(os.getenv("MEETING_SUMMARY_MAX_TOKENS", "2048"))
    except ValueError:
        default_max_tokens = 2048
    try:
        # v3 reserves 10,240 input tokens plus protocol/output headroom inside
        # Ollama's 16,384-token context.  Keep the cap here so a deployment
        # cannot silently fall back to the old 8k window for local generation.
        default_num_ctx = int(os.getenv("MEETING_SUMMARY_NUM_CTX", "16384"))
    except ValueError:
        default_num_ctx = 16384
    request_options: dict[str, Any] = {
        "temperature": 0.1,
        "num_ctx": min(16_384, max(4_096, default_num_ctx)),
        "num_predict": default_max_tokens if max_tokens is None else max_tokens,
    }
    if options:
        request_options.update(options)
    payload: dict[str, Any] = {
        "model": str(config.model),
        "messages": [
            {"role": "system", "content": "/no_think\n" + str(system_prompt)},
            {"role": "user", "content": str(transcript)},
        ],
        "stream": False,
        "think": False,
        "keep_alive": KEEP_ALIVE,
        "options": request_options,
    }
    if response_format is not None:
        payload["format"] = response_format
    active_priority = (priority or "interactive").strip().lower()
    headers = {
        "X-Laoji-Priority": active_priority,
    }
    if telemetry_operation:
        headers["X-Laoji-Operation"] = telemetry_operation
    timeout_seconds = timeout if timeout > 0 else int(os.getenv("MEETING_SUMMARY_TIMEOUT", "600"))
    try:
        response = _SESSION.post(
            f"{config.base_url}{config.chat_path or '/api/chat'}",
            json=payload,
            headers=headers,
            timeout=timeout_seconds,
        )
        response.raise_for_status()
        body = response.json()
    except requests.Timeout as exc:
        raise LlmProviderError("ollama_request_timeout") from exc
    except requests.RequestException as exc:
        raise LlmProviderError("ollama_request_failed") from exc
    except (TypeError, ValueError) as exc:
        raise LlmProviderError("ollama_response_invalid") from exc
    content = body.get("message", {}).get("content") if isinstance(body, dict) else None
    if not isinstance(content, str):
        raise LlmProviderError("ollama_response_invalid")
    _record_inference_telemetry(
        telemetry_operation,
        provider="ollama",
        body=body,
        output_text=content,
    )
    return content


def _cloud_response_format(
    response_format: str | dict[str, Any] | None,
) -> dict[str, str] | dict[str, Any] | None:
    """Translate the Ollama JSON-format contract to OpenAI-compatible JSON.

    Ollama accepts the full JSON schema object directly.  DashScope's
    OpenAI-compatible endpoint accepts JSON-object mode, while the prompts
    and our existing response validators continue to enforce the detailed
    LaoJi schema.  Sending JSON-object mode therefore preserves the business
    contract without coupling every caller to a cloud-specific schema shape.
    """
    if response_format is None:
        return None
    if isinstance(response_format, str):
        return {"type": "json_object"} if response_format.lower() in {
            "json", "json_object", "json_schema"
        } else None
    if isinstance(response_format, dict):
        format_type = str(response_format.get("type") or "").strip().lower()
        if format_type in {"json_object", "json_schema"}:
            return response_format
        # The existing callers pass an Ollama schema whose top-level type is
        # "object".  Keep the detailed schema in the prompt and ask the cloud
        # endpoint for a syntactically valid object.
        if format_type == "object" or "properties" in response_format:
            return {"type": "json_object"}
    return None


def _call_dashscope_transport(
    config: Any,
    system_prompt: str,
    transcript: str,
    *,
    timeout: int = 0,
    max_tokens: int | None = None,
    options: dict[str, Any] | None = None,
    response_format: str | dict[str, Any] | None = None,
    priority: str | None = None,
    telemetry_operation: str | None = None,
) -> str:
    """Call Bailian/DashScope through its OpenAI-compatible chat endpoint."""
    try:
        default_max_tokens = int(os.getenv("MEETING_SUMMARY_MAX_TOKENS", "2048"))
    except ValueError:
        default_max_tokens = 2048
    request_options = dict(options or {})
    request_max_tokens = max_tokens
    if request_max_tokens is None:
        request_max_tokens = request_options.pop("num_predict", default_max_tokens)
    else:
        request_options.pop("num_predict", None)

    # num_ctx and keep_alive are Ollama-only.  Only forward parameters shared
    # by the OpenAI-compatible API; silently forwarding Ollama keys causes
    # DashScope to reject otherwise valid requests.
    supported_options = {
        key: request_options[key]
        for key in (
            "temperature",
            "top_p",
            "presence_penalty",
            "frequency_penalty",
            "seed",
        )
        if key in request_options
    }
    payload: dict[str, Any] = {
        "model": str(config.model),
        "messages": [
            # Keep the existing no-think marker for prompt compatibility and
            # hard-disable thinking through the provider-specific flag below.
            {"role": "system", "content": "/no_think\n" + str(system_prompt)},
            {"role": "user", "content": str(transcript)},
        ],
        "stream": False,
        "enable_thinking": _env_bool("LAOJI_DASHSCOPE_ENABLE_THINKING", False),
        "max_tokens": max(1, int(request_max_tokens)),
        **supported_options,
    }
    cloud_format = _cloud_response_format(response_format)
    if cloud_format is not None:
        payload["response_format"] = cloud_format

    headers = {
        "Authorization": f"Bearer {config.api_key}",
        "Content-Type": "application/json",
        "X-Laoji-Priority": (priority or "interactive").strip().lower(),
    }
    if telemetry_operation:
        headers["X-Laoji-Operation"] = telemetry_operation
    timeout_seconds = timeout if timeout > 0 else int(os.getenv("MEETING_SUMMARY_TIMEOUT", "600"))
    try:
        response = _SESSION.post(
            f"{config.base_url}{config.chat_path or '/chat/completions'}",
            json=payload,
            headers=headers,
            timeout=timeout_seconds,
        )
        response.raise_for_status()
        body = response.json()
    except requests.Timeout as exc:
        raise LlmProviderError("dashscope_request_timeout") from exc
    except requests.HTTPError as exc:
        # Do not include the response body: provider error payloads can echo
        # user text, and logging them would also make redaction harder.
        status = getattr(response, "status_code", "unknown")
        raise LlmProviderError(f"dashscope_request_failed_{status}") from exc
    except requests.RequestException as exc:
        raise LlmProviderError("dashscope_request_failed") from exc
    except (TypeError, ValueError) as exc:
        raise LlmProviderError("dashscope_response_invalid") from exc

    choices = body.get("choices") if isinstance(body, dict) else None
    if not isinstance(choices, list) or not choices:
        raise LlmProviderError("dashscope_response_invalid")
    message = choices[0].get("message") if isinstance(choices[0], dict) else None
    content = message.get("content") if isinstance(message, dict) else None
    if isinstance(content, str):
        _record_inference_telemetry(
            telemetry_operation,
            provider="dashscope",
            body=body,
            output_text=content,
        )
        return content
    # Some OpenAI-compatible gateways return multimodal content blocks even
    # for a text-only request.  Flatten only text blocks; never stringify
    # metadata or reasoning fields into the business response.
    if isinstance(content, list):
        text_parts = [
            str(item.get("text"))
            for item in content
            if isinstance(item, dict) and isinstance(item.get("text"), str)
        ]
        if text_parts:
            joined = "".join(text_parts)
            _record_inference_telemetry(
                telemetry_operation,
                provider="dashscope",
                body=body,
                output_text=joined,
            )
            return joined
    raise LlmProviderError("dashscope_response_invalid")


def _canonical_config(config: Any) -> Any:
    provider = configured_provider()
    if provider == "dashscope":
        values = {
            "provider": "dashscope",
            "base_url": canonical_dashscope_base_url(),
            "model": (
                os.getenv("LAOJI_DASHSCOPE_MODEL", DASHSCOPE_MODEL).strip()
                or DASHSCOPE_MODEL
            ),
            "api_key": _dashscope_api_key(),
            "chat_path": "/chat/completions",
        }
    else:
        values = {
            "provider": "ollama",
            "base_url": canonical_ollama_base_url(),
            "model": GENERATION_MODEL,
            "api_key": "",
            "chat_path": "/api/chat",
        }
    if hasattr(config, "_replace"):
        supported = {key: value for key, value in values.items() if hasattr(config, key)}
        return config._replace(**supported)
    current = dict(vars(config)) if hasattr(config, "__dict__") else {}
    current.update(values)
    return SimpleNamespace(**current)


def call_llm(
    config: Any,
    system_prompt: str,
    transcript: str,
    timeout: int = 0,
    max_tokens: int | None = None,
    options: dict[str, Any] | None = None,
    response_format: str | dict[str, Any] | None = None,
    priority: str | None = None,
    telemetry_operation: str | None = None,
) -> str:
    active_priority = (priority or "interactive").strip().lower()
    operation = telemetry_operation or "llm.chat"
    timeout_seconds = timeout if timeout > 0 else int(os.getenv("MEETING_SUMMARY_TIMEOUT", "600"))

    def invoke() -> str:
        canonical = _canonical_config(config)
        transport = (
            _call_dashscope_transport
            if canonical.provider == "dashscope"
            else _call_ollama_transport
        )
        return transport(
            canonical,
            system_prompt,
            transcript,
            timeout=timeout,
            max_tokens=max_tokens,
            options=options,
            response_format=response_format,
            priority=active_priority,
            telemetry_operation=telemetry_operation,
        )

    return _COORDINATOR.submit(
        priority=active_priority,
        operation=operation,
        call=invoke,
        wait_seconds=timeout_seconds + 30,
    )


def _normalized_embedding(values: list[Any]) -> tuple[float, ...]:
    vector = tuple(float(value) for value in values)
    norm = sum(value * value for value in vector) ** 0.5
    if not vector or norm <= 0 or not all(math.isfinite(value) for value in vector):
        raise LlmProviderError("embedding_vector_invalid")
    return tuple(value / norm for value in vector)


def embed_texts(
    texts: list[str],
    *,
    priority: str = "interactive",
    operation: str = "meeting.embedding",
    timeout_seconds: float | None = None,
    num_gpu: int | None = None,
) -> list[tuple[float, ...]]:
    if not texts:
        return []
    if timeout_seconds is None:
        timeout_seconds = max(
            1.0,
            min(60.0, float(os.getenv("MEETING_QUESTION_EMBEDDING_TIMEOUT", "15"))),
        )
    else:
        timeout_seconds = max(1.0, min(60.0, float(timeout_seconds)))
    try:
        num_ctx = int(os.getenv("MEETING_QUESTION_EMBEDDING_NUM_CTX", "8192"))
    except ValueError:
        num_ctx = 8192
    num_ctx = min(8192, max(2048, num_ctx))
    if num_gpu is not None:
        num_gpu = max(0, min(999, int(num_gpu)))

    def invoke() -> list[tuple[float, ...]]:
        try:
            response = _SESSION.post(
                f"{canonical_ollama_base_url()}/api/embed",
                json={
                    "model": EMBEDDING_MODEL,
                    "input": texts,
                    "dimensions": max(
                        32,
                        min(1024, int(os.getenv("MEETING_QUESTION_EMBEDDING_DIMENSIONS", "256"))),
                    ),
                    "truncate": True,
                    "keep_alive": KEEP_ALIVE,
                    "options": {
                        "num_ctx": num_ctx,
                        **({"num_gpu": num_gpu} if num_gpu is not None else {}),
                    },
                },
                headers={
                    "X-Laoji-Priority": priority,
                    "X-Laoji-Operation": operation,
                },
                timeout=timeout_seconds,
            )
            response.raise_for_status()
            payload = response.json()
        except requests.Timeout as exc:
            raise LlmProviderError("ollama_embedding_timeout") from exc
        except requests.RequestException as exc:
            raise LlmProviderError("ollama_embedding_failed") from exc
        except (TypeError, ValueError) as exc:
            raise LlmProviderError("embedding_response_invalid") from exc
        embeddings = payload.get("embeddings")
        if not isinstance(embeddings, list) or len(embeddings) != len(texts):
            raise LlmProviderError("embedding_response_invalid")
        _record_inference_telemetry(
            operation,
            provider="ollama",
            body=payload,
            output_text="",
        )
        return [_normalized_embedding(item) for item in embeddings]

    return _COORDINATOR.submit(
        priority=priority,
        operation=operation,
        call=invoke,
        wait_seconds=timeout_seconds + 30,
    )


def provider_state(*, probe: bool = False) -> dict[str, Any]:
    provider = configured_provider()
    if provider == "dashscope":
        generation_base_url = canonical_dashscope_base_url()
        generation_model = (
            os.getenv("LAOJI_DASHSCOPE_MODEL", DASHSCOPE_MODEL).strip()
            or DASHSCOPE_MODEL
        )
    else:
        generation_base_url = canonical_ollama_base_url()
        generation_model = GENERATION_MODEL
    state = {
        "provider": provider,
        "base_url": generation_base_url,
        "generation_model": generation_model,
        "generation_ready": None,
        "embedding_provider": "ollama",
        "embedding_base_url": canonical_ollama_base_url(),
        "embedding_model": EMBEDDING_MODEL,
        "embedding_ready": None,
        "embedding_probe_latency_ms": None,
        "embedding_probe_error": None,
        "queue": _COORDINATOR.snapshot(),
        "inference": {"last_by_operation": _inference_telemetry_snapshot()},
        "ready": None,
        "models": [],
        "probe_latency_ms": None,
    }
    if not probe:
        return state
    started = time.perf_counter()
    try:
        embedding_response = _SESSION.get(
            f"{canonical_ollama_base_url()}/api/tags",
            timeout=5,
        )
        embedding_response.raise_for_status()
        embedding_payload = embedding_response.json()
        models = sorted(
            str(item.get("name"))
            for item in embedding_payload.get("models", [])
            if isinstance(item, dict) and item.get("name")
        )
        state["models"] = models
        embedding_available = EMBEDDING_MODEL in models
        embedding_probe = (
            _embedding_inference_state(canonical_ollama_base_url())
            if embedding_available
            else {"ready": False, "latency_ms": 0.0, "error_code": "embedding_model_missing"}
        )
        embedding_ready = embedding_probe.get("ready") is True
        state["embedding_ready"] = embedding_ready
        state["embedding_probe_latency_ms"] = embedding_probe.get("latency_ms")
        state["embedding_probe_error"] = embedding_probe.get("error_code")

        if provider == "dashscope":
            # The workspace-compatible endpoint may not expose /models.  A
            # successful authenticated OPTIONS/GET is useful when available,
            # but a 404 from an otherwise reachable gateway is not a reason to
            # declare the configured provider down.  Actual generation remains
            # the authoritative cloud probe and is never triggered here (it
            # would spend tokens during every readiness poll).
            _dashscope_api_key()
            try:
                cloud_probe = _SESSION.get(
                    f"{generation_base_url}/models",
                    headers={"Authorization": f"Bearer {_dashscope_api_key()}"},
                    timeout=5,
                )
                # A reachable endpoint is not enough: an invalid or revoked
                # key must make readiness fail closed.  404/405 are kept
                # compatible with gateways that do not expose /models, while
                # authentication failures are never reported as ready.
                state["generation_ready"] = (
                    cloud_probe.status_code < 500
                    and cloud_probe.status_code not in {401, 403}
                )
            except requests.RequestException:
                state["generation_ready"] = False
            state["ready"] = bool(state["generation_ready"] and embedding_ready)
        else:
            state["generation_ready"] = generation_model in models
            state["ready"] = bool(state["generation_ready"] and embedding_ready)
    except Exception:
        state["generation_ready"] = False
        state["embedding_ready"] = False
        state["ready"] = False
    state["probe_latency_ms"] = round((time.perf_counter() - started) * 1000, 3)
    return state
