#!/usr/bin/env python3
"""Narrow mixed-load runner for isolated LaoJi candidate services.

The runner deliberately accepts only HTTP loopback endpoints on ports 28000-28999.
It is a measurement tool, not a release gate, scheduler implementation, or production
traffic generator. It uses only the Python standard library so the core runner works
on Linux and Windows development hosts.
"""

from __future__ import annotations

import argparse
import concurrent.futures
import copy
import dataclasses
import datetime as dt
import hashlib
import http.client
import http.server
import json
import math
import os
from pathlib import Path
import random
import re
import socket
import sys
import tempfile
import threading
import time
from typing import Any, Iterable, Mapping
import urllib.parse


RUNNER_VERSION = "1.1.0"
ALLOWED_KINDS = {"long_summary", "question", "rule_schedule", "model_schedule"}
ALLOWED_PRIORITIES = {"interactive", "background"}
ALLOWED_PHASES = {"isolated", "mixed"}
ALLOWED_HOOKS = {"cancel_queued", "cancel_running", "client_disconnect"}
FORBIDDEN_PORTS = {18020, 18035, 21434, 21436}
CANDIDATE_PORT_MIN = 28000
CANDIDATE_PORT_MAX = 28999
URL_PATTERN = re.compile(r"https?://[^\s\"'<>]+", re.IGNORECASE)
TOKEN_PATTERN = re.compile(r"[^a-zA-Z0-9_.:-]+")


class ConfigError(ValueError):
    """The manifest is invalid or violates the candidate isolation boundary."""


def _file_sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


@dataclasses.dataclass(frozen=True)
class HookSpec:
    kind: str
    every: int
    offset: int
    after_ms: float
    phases: frozenset[str]


@dataclasses.dataclass(frozen=True)
class Profile:
    name: str
    kind: str
    priority: str
    count_per_wave: int
    isolated_count: int
    arrival_offset_ms: float
    jitter_ms: float
    request: Mapping[str, Any]
    poll: Mapping[str, Any] | None
    hooks: tuple[HookSpec, ...]


@dataclasses.dataclass(frozen=True)
class RunnerConfig:
    waves: int
    wave_interval_ms: float
    max_workers: int
    seed: int
    phases: tuple[str, ...]
    interactive_queue_starvation_ms: float
    background_completion_starvation_ms: float
    profiles: tuple[Profile, ...]


@dataclasses.dataclass(frozen=True)
class Job:
    job_id: str
    phase: str
    isolation_group: str | None
    wave: int
    profile: Profile
    profile_ordinal: int
    scheduled_offset_ms: float
    hook: HookSpec | None


@dataclasses.dataclass
class HttpObservation:
    status: int
    elapsed_ms: float
    data: Mapping[str, Any]
    server_segments_ms: dict[str, float]
    trace_id: str | None
    error_code: str | None
    transport_error: str | None


@dataclasses.dataclass
class JobResult:
    job_id: str
    phase: str
    isolation_group: str | None
    wave: int
    profile: str
    kind: str
    priority: str
    outcome: str
    status: int
    error_code: str | None
    hook_requested: str | None
    hook_outcome: str | None
    scheduled_at_ms: float
    submitted_at_ms: float
    started_at_ms: float
    completed_at_ms: float
    dispatch_wait_ms: float
    client_total_ms: float
    scheduled_to_complete_ms: float
    server_segments_ms: dict[str, float]
    server_timing_responses: int
    http_responses: int
    client_trace_id: str
    trace_ids: list[str]


class AbortController:
    def __init__(self) -> None:
        self.event = threading.Event()
        self._lock = threading.Lock()
        self._connection: http.client.HTTPConnection | None = None
        self.reason: str | None = None

    def register(self, connection: http.client.HTTPConnection) -> bool:
        with self._lock:
            if self.event.is_set():
                return False
            self._connection = connection
            return True

    def clear(self, connection: http.client.HTTPConnection) -> None:
        with self._lock:
            if self._connection is connection:
                self._connection = None

    def trigger(self, reason: str) -> bool:
        with self._lock:
            if self.event.is_set():
                return False
            self.reason = reason
            self.event.set()
            connection = self._connection
        if connection is not None:
            try:
                connection.close()
            except OSError:
                pass
        return True


class QueuedHookState:
    def __init__(self, requested: bool) -> None:
        self.requested = requested
        self._lock = threading.Lock()
        self.outcome: str | None = None

    def set_once(self, outcome: str) -> None:
        with self._lock:
            if self.outcome is None:
                self.outcome = outcome


def _as_dict(value: Any, label: str) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise ConfigError(f"{label} must be an object")
    return value


def _as_int(value: Any, label: str, minimum: int, maximum: int) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or not minimum <= value <= maximum:
        raise ConfigError(f"{label} must be an integer in [{minimum}, {maximum}]")
    return value


def _as_float(value: Any, label: str, minimum: float, maximum: float) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise ConfigError(f"{label} must be a number")
    parsed = float(value)
    if not math.isfinite(parsed) or not minimum <= parsed <= maximum:
        raise ConfigError(f"{label} must be in [{minimum}, {maximum}]")
    return parsed


def _candidate_url(url: str, label: str) -> urllib.parse.SplitResult:
    try:
        parsed = urllib.parse.urlsplit(url)
        port = parsed.port
    except ValueError as exc:
        raise ConfigError(f"{label} is not a valid URL: {exc}") from exc
    if parsed.scheme.lower() != "http":
        raise ConfigError(f"{label} must use plain HTTP on an isolated loopback candidate")
    if parsed.username or parsed.password:
        raise ConfigError(f"{label} must not contain URL credentials")
    host = (parsed.hostname or "").lower()
    is_loopback = host == "localhost"
    if not is_loopback:
        try:
            is_loopback = socket.inet_pton(socket.AF_INET, host) is not None and host.startswith("127.")
        except OSError:
            try:
                is_loopback = socket.inet_pton(socket.AF_INET6, host) is not None and host == "::1"
            except OSError:
                is_loopback = False
    if not is_loopback:
        raise ConfigError(f"{label} must target localhost, 127.0.0.0/8, or ::1")
    if port is None:
        raise ConfigError(f"{label} must include an explicit candidate port")
    if port in FORBIDDEN_PORTS:
        raise ConfigError(f"{label} targets forbidden production/shared-model port {port}")
    if not CANDIDATE_PORT_MIN <= port <= CANDIDATE_PORT_MAX:
        raise ConfigError(
            f"{label} port {port} is outside the isolated candidate range "
            f"{CANDIDATE_PORT_MIN}-{CANDIDATE_PORT_MAX}"
        )
    if parsed.fragment:
        raise ConfigError(f"{label} must not contain a URL fragment")
    return parsed


def _validate_embedded_urls(value: Any, label: str = "manifest") -> None:
    if isinstance(value, dict):
        for key, item in value.items():
            _validate_embedded_urls(item, f"{label}.{key}")
    elif isinstance(value, list):
        for index, item in enumerate(value):
            _validate_embedded_urls(item, f"{label}[{index}]")
    elif isinstance(value, str):
        for match in URL_PATTERN.finditer(value):
            _candidate_url(match.group(0).rstrip(".,);]"), label)


def _normalize_request(value: Any, label: str) -> dict[str, Any]:
    request = copy.deepcopy(_as_dict(value, label))
    method = str(request.get("method", "POST")).upper()
    if method not in {"GET", "POST", "PUT", "PATCH", "DELETE"}:
        raise ConfigError(f"{label}.method is unsupported")
    url = request.get("url")
    if not isinstance(url, str) or not url:
        raise ConfigError(f"{label}.url must be a non-empty string")
    _candidate_url(url, f"{label}.url")
    headers = request.get("headers", {})
    if not isinstance(headers, dict) or not all(isinstance(k, str) and isinstance(v, str) for k, v in headers.items()):
        raise ConfigError(f"{label}.headers must contain string keys and values")
    timeout_ms = _as_float(request.get("timeout_ms", 30_000), f"{label}.timeout_ms", 10, 3_600_000)
    request["method"] = method
    request["headers"] = dict(headers)
    request["timeout_ms"] = timeout_ms
    request.setdefault("json", None)
    return request


def _normalize_poll(value: Any, label: str) -> dict[str, Any] | None:
    if value is None:
        return None
    poll = copy.deepcopy(_as_dict(value, label))
    url_template = poll.get("url_template")
    if not isinstance(url_template, str) or "{task_id}" not in url_template:
        raise ConfigError(f"{label}.url_template must contain {{task_id}}")
    _candidate_url(url_template.replace("{task_id}", "validation-task"), f"{label}.url_template")
    poll["method"] = str(poll.get("method", "GET")).upper()
    if poll["method"] not in {"GET", "POST"}:
        raise ConfigError(f"{label}.method must be GET or POST")
    for key, default in (("task_id_path", "task_id"), ("status_path", "status")):
        if not isinstance(poll.get(key, default), str) or not poll.get(key, default):
            raise ConfigError(f"{label}.{key} must be a non-empty dot path")
        poll[key] = poll.get(key, default)
    poll["interval_ms"] = _as_float(poll.get("interval_ms", 250), f"{label}.interval_ms", 1, 60_000)
    poll["request_timeout_ms"] = _as_float(
        poll.get("request_timeout_ms", 30_000), f"{label}.request_timeout_ms", 10, 3_600_000
    )
    poll["max_wait_ms"] = _as_float(poll.get("max_wait_ms", 600_000), f"{label}.max_wait_ms", 10, 7_200_000)
    success = poll.get("terminal_success", ["SUCCESS"])
    failure = poll.get("terminal_failure", ["FAILURE"])
    if not isinstance(success, list) or not success or not all(isinstance(item, str) for item in success):
        raise ConfigError(f"{label}.terminal_success must be a non-empty string list")
    if not isinstance(failure, list) or not failure or not all(isinstance(item, str) for item in failure):
        raise ConfigError(f"{label}.terminal_failure must be a non-empty string list")
    poll["terminal_success"] = [item.upper() for item in success]
    poll["terminal_failure"] = [item.upper() for item in failure]
    headers = poll.get("headers", {})
    if not isinstance(headers, dict) or not all(isinstance(k, str) and isinstance(v, str) for k, v in headers.items()):
        raise ConfigError(f"{label}.headers must contain string keys and values")
    poll["headers"] = dict(headers)
    poll.setdefault("json", None)
    return poll


def normalize_manifest(raw: Any) -> RunnerConfig:
    manifest = _as_dict(raw, "manifest")
    if manifest.get("schema_version") != 1:
        raise ConfigError("manifest.schema_version must be 1")
    _validate_embedded_urls(manifest)
    runner = _as_dict(manifest.get("runner", {}), "manifest.runner")
    phases_value = runner.get("phases", ["isolated", "mixed"])
    if not isinstance(phases_value, list) or not phases_value:
        raise ConfigError("manifest.runner.phases must be a non-empty list")
    phases = tuple(str(item) for item in phases_value)
    if len(set(phases)) != len(phases) or any(item not in ALLOWED_PHASES for item in phases):
        raise ConfigError("manifest.runner.phases may contain isolated and mixed once each")
    starvation = _as_dict(runner.get("starvation", {}), "manifest.runner.starvation")
    profiles_value = manifest.get("profiles")
    if not isinstance(profiles_value, list) or not profiles_value:
        raise ConfigError("manifest.profiles must be a non-empty list")
    profiles: list[Profile] = []
    names: set[str] = set()
    for index, value in enumerate(profiles_value):
        label = f"manifest.profiles[{index}]"
        item = _as_dict(value, label)
        name = item.get("name")
        if not isinstance(name, str) or not name or not re.fullmatch(r"[a-zA-Z0-9_.-]+", name):
            raise ConfigError(f"{label}.name must use letters, numbers, dot, underscore, or hyphen")
        if name in names:
            raise ConfigError(f"duplicate profile name: {name}")
        names.add(name)
        kind = item.get("kind")
        if kind not in ALLOWED_KINDS:
            raise ConfigError(f"{label}.kind must be one of {sorted(ALLOWED_KINDS)}")
        default_priority = "background" if kind == "long_summary" else "interactive"
        priority = item.get("priority", default_priority)
        if priority not in ALLOWED_PRIORITIES:
            raise ConfigError(f"{label}.priority must be interactive or background")
        hooks_value = item.get("hooks", [])
        if not isinstance(hooks_value, list):
            raise ConfigError(f"{label}.hooks must be a list")
        hooks: list[HookSpec] = []
        for hook_index, hook_value in enumerate(hooks_value):
            hook_label = f"{label}.hooks[{hook_index}]"
            hook = _as_dict(hook_value, hook_label)
            hook_kind = hook.get("type")
            if hook_kind not in ALLOWED_HOOKS:
                raise ConfigError(f"{hook_label}.type must be one of {sorted(ALLOWED_HOOKS)}")
            hook_phases_value = hook.get("phases", ["mixed"])
            if not isinstance(hook_phases_value, list) or not hook_phases_value:
                raise ConfigError(f"{hook_label}.phases must be a non-empty list")
            hook_phases = frozenset(str(phase) for phase in hook_phases_value)
            if not hook_phases.issubset(ALLOWED_PHASES):
                raise ConfigError(f"{hook_label}.phases contains an unsupported phase")
            every = _as_int(hook.get("every", 1), f"{hook_label}.every", 1, 1_000_000)
            offset = _as_int(hook.get("offset", 0), f"{hook_label}.offset", 0, every - 1)
            after_default = 0 if hook_kind == "cancel_queued" else 50
            after_ms = _as_float(hook.get("after_ms", after_default), f"{hook_label}.after_ms", 0, 3_600_000)
            hooks.append(HookSpec(hook_kind, every, offset, after_ms, hook_phases))
        profiles.append(
            Profile(
                name=name,
                kind=kind,
                priority=priority,
                count_per_wave=_as_int(item.get("count_per_wave", 1), f"{label}.count_per_wave", 0, 100_000),
                isolated_count=_as_int(item.get("isolated_count", 1), f"{label}.isolated_count", 0, 100_000),
                arrival_offset_ms=_as_float(
                    item.get("arrival_offset_ms", 0), f"{label}.arrival_offset_ms", 0, 3_600_000
                ),
                jitter_ms=_as_float(item.get("jitter_ms", 0), f"{label}.jitter_ms", 0, 3_600_000),
                request=_normalize_request(item.get("request"), f"{label}.request"),
                poll=_normalize_poll(item.get("poll"), f"{label}.poll"),
                hooks=tuple(hooks),
            )
        )
    if not any(profile.count_per_wave or profile.isolated_count for profile in profiles):
        raise ConfigError("manifest has no runnable jobs")
    return RunnerConfig(
        waves=_as_int(runner.get("waves", 1), "manifest.runner.waves", 1, 10_000),
        wave_interval_ms=_as_float(
            runner.get("wave_interval_ms", 1_000), "manifest.runner.wave_interval_ms", 0, 3_600_000
        ),
        max_workers=_as_int(runner.get("max_workers", 4), "manifest.runner.max_workers", 1, 1_024),
        seed=_as_int(runner.get("seed", 20260730), "manifest.runner.seed", 0, 2_147_483_647),
        phases=phases,
        interactive_queue_starvation_ms=_as_float(
            starvation.get("interactive_queue_ms", 2_000),
            "manifest.runner.starvation.interactive_queue_ms",
            1,
            3_600_000,
        ),
        background_completion_starvation_ms=_as_float(
            starvation.get("background_completion_ms", 120_000),
            "manifest.runner.starvation.background_completion_ms",
            1,
            7_200_000,
        ),
        profiles=tuple(profiles),
    )


def load_manifest(path: Path) -> RunnerConfig:
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise ConfigError(f"unable to read manifest {path}: {exc}") from exc
    return normalize_manifest(raw)


def _hook_for(profile: Profile, phase: str, ordinal: int) -> HookSpec | None:
    for hook in profile.hooks:
        if phase in hook.phases and ordinal % hook.every == hook.offset:
            return hook
    return None


def _make_jobs(config: RunnerConfig, phase: str, isolation_group: str | None = None) -> list[Job]:
    rng_seed = config.seed ^ int(hashlib.sha256(f"{phase}:{isolation_group}".encode()).hexdigest()[:8], 16)
    rng = random.Random(rng_seed)
    profiles = [profile for profile in config.profiles if isolation_group is None or profile.name == isolation_group]
    waves = config.waves if phase == "mixed" else 1
    ordinals = {profile.name: 0 for profile in profiles}
    jobs: list[Job] = []
    for wave in range(waves):
        for profile in profiles:
            count = profile.count_per_wave if phase == "mixed" else profile.isolated_count
            for _ in range(count):
                ordinal = ordinals[profile.name]
                ordinals[profile.name] += 1
                jitter = rng.uniform(-profile.jitter_ms, profile.jitter_ms) if profile.jitter_ms else 0.0
                offset = max(0.0, wave * config.wave_interval_ms + profile.arrival_offset_ms + jitter)
                job_id = f"{phase}-{profile.name}-w{wave + 1:03d}-n{ordinal + 1:05d}"
                jobs.append(
                    Job(
                        job_id=job_id,
                        phase=phase,
                        isolation_group=isolation_group,
                        wave=wave + 1,
                        profile=profile,
                        profile_ordinal=ordinal,
                        scheduled_offset_ms=offset,
                        hook=_hook_for(profile, phase, ordinal),
                    )
                )
    return sorted(jobs, key=lambda job: (job.scheduled_offset_ms, job.profile.name, job.profile_ordinal))


def _replace_tokens(value: Any, job: Job) -> Any:
    replacements = {
        "{{job_id}}": job.job_id,
        "{{wave}}": str(job.wave),
        "{{ordinal}}": str(job.profile_ordinal),
    }
    if isinstance(value, dict):
        return {key: _replace_tokens(item, job) for key, item in value.items()}
    if isinstance(value, list):
        return [_replace_tokens(item, job) for item in value]
    if isinstance(value, str):
        result = value
        for needle, replacement in replacements.items():
            result = result.replace(needle, replacement)
        return result
    return value


def _client_trace_id(job: Job) -> str:
    digest = hashlib.sha256(job.job_id.encode("utf-8")).hexdigest()[:24]
    return f"svc00-{digest}"


def _json_path(value: Any, path: str) -> Any:
    current = value
    for token in path.split("."):
        if isinstance(current, dict) and token in current:
            current = current[token]
        else:
            return None
    return current


def _safe_code(value: Any) -> str | None:
    if value is None or isinstance(value, (dict, list)):
        return None
    text = TOKEN_PATTERN.sub("_", str(value).strip())[:96].strip("_")
    return text or None


def _extract_error_code(data: Mapping[str, Any], status: int) -> str | None:
    candidates = [
        data.get("error_code"),
        data.get("code"),
        _json_path(data, "error.code"),
        _json_path(data, "detail.code"),
        _json_path(data, "result.error_code"),
        _json_path(data, "result.code"),
    ]
    for candidate in candidates:
        code = _safe_code(candidate)
        if code:
            return code
    return f"http_{status}" if status and not 200 <= status < 300 else None


def _timing_name(value: str) -> str:
    name = value.strip().lower().replace("-", "_")
    aliases = {
        "auth": "auth_validation",
        "auth_and_validation": "auth_validation",
        "validation": "auth_validation",
        "queue": "queue_wait",
        "queue_estimate": "queue_wait",
        "model_load": "model_load_or_warmup",
        "load": "model_load_or_warmup",
        "verify": "verification",
        "repair": "verification",
    }
    return aliases.get(name, name)


def _finite_nonnegative(value: Any) -> float | None:
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    return number if math.isfinite(number) and number >= 0 else None


def _extract_server_timing(headers: Iterable[tuple[str, str]], data: Mapping[str, Any]) -> dict[str, float]:
    segments: dict[str, float] = {}
    for header_name, header_value in headers:
        lowered = header_name.lower()
        if lowered == "server-timing":
            for entry in header_value.split(","):
                parts = [part.strip() for part in entry.split(";") if part.strip()]
                if not parts:
                    continue
                duration = None
                for parameter in parts[1:]:
                    if parameter.lower().startswith("dur="):
                        duration = _finite_nonnegative(parameter.split("=", 1)[1].strip().strip('"'))
                        break
                if duration is not None:
                    name = _timing_name(parts[0])
                    segments[name] = segments.get(name, 0.0) + duration
        elif lowered.startswith("x-laoji-timing-"):
            duration = _finite_nonnegative(header_value)
            if duration is not None:
                name = _timing_name(lowered.removeprefix("x-laoji-timing-"))
                segments[name] = segments.get(name, 0.0) + duration
    embedded = data.get("timing_ms") or data.get("_timing_ms")
    if isinstance(embedded, dict):
        for raw_name, raw_value in embedded.items():
            duration = _finite_nonnegative(raw_value)
            if duration is not None:
                name = _timing_name(str(raw_name))
                segments[name] = segments.get(name, 0.0) + duration
    return segments


def _http_json(
    request_spec: Mapping[str, Any],
    controller: AbortController,
    job: Job,
) -> HttpObservation:
    url = str(request_spec["url"])
    parsed = _candidate_url(url, f"runtime endpoint for {job.profile.name}")
    timeout_s = float(request_spec["timeout_ms"]) / 1_000
    connection = http.client.HTTPConnection(parsed.hostname, parsed.port, timeout=timeout_s)
    if not controller.register(connection):
        return HttpObservation(0, 0.0, {}, {}, None, controller.reason, controller.reason)
    body_value = _replace_tokens(request_spec.get("json"), job)
    body = None if body_value is None else json.dumps(body_value, ensure_ascii=False).encode("utf-8")
    headers = dict(request_spec.get("headers", {}))
    headers.setdefault("Accept", "application/json")
    headers.setdefault("Connection", "close")
    client_trace_id = _client_trace_id(job)
    headers.setdefault("X-Request-ID", client_trace_id)
    headers.setdefault("X-Trace-ID", client_trace_id)
    if body is not None:
        headers.setdefault("Content-Type", "application/json")
        headers["Content-Length"] = str(len(body))
    target = parsed.path or "/"
    if parsed.query:
        target += f"?{parsed.query}"
    started = time.perf_counter()
    try:
        connection.request(str(request_spec["method"]), target, body=body, headers=headers)
        response = connection.getresponse()
        raw = response.read()
        elapsed_ms = (time.perf_counter() - started) * 1_000
        response_headers = response.getheaders()
        try:
            decoded = json.loads(raw.decode("utf-8")) if raw else {}
        except (UnicodeDecodeError, json.JSONDecodeError):
            decoded = {}
        data = decoded if isinstance(decoded, dict) else {"response_type": type(decoded).__name__}
        trace_id = None
        for name, value in response_headers:
            if name.lower() in {"x-trace-id", "x-request-id", "trace-id"}:
                trace_id = _safe_code(value)
                break
        if controller.event.is_set():
            reason = controller.reason or "cancelled_running"
            return HttpObservation(0, elapsed_ms, {}, {}, trace_id, reason, reason)
        return HttpObservation(
            status=response.status,
            elapsed_ms=elapsed_ms,
            data=data,
            server_segments_ms=_extract_server_timing(response_headers, data),
            trace_id=trace_id,
            error_code=_extract_error_code(data, response.status),
            transport_error=None,
        )
    except Exception as exc:
        elapsed_ms = (time.perf_counter() - started) * 1_000
        if controller.event.is_set():
            reason = controller.reason or "cancelled_running"
            return HttpObservation(0, elapsed_ms, {}, {}, None, reason, reason)
        name = type(exc).__name__
        code = "timeout" if isinstance(exc, (TimeoutError, socket.timeout)) else f"transport_{name}"
        return HttpObservation(0, elapsed_ms, {}, {}, None, code, code)
    finally:
        controller.clear(connection)
        try:
            connection.close()
        except OSError:
            pass


def _aggregate_segments(observations: Iterable[HttpObservation]) -> dict[str, float]:
    totals: dict[str, float] = {}
    for observation in observations:
        for name, duration in observation.server_segments_ms.items():
            totals[name] = totals.get(name, 0.0) + duration
    return totals


def _execute_job(job: Job, epoch: float, submitted_at: float, queued_state: QueuedHookState) -> JobResult:
    started_at = time.perf_counter()
    controller = AbortController()
    hook_timer: threading.Timer | None = None
    if job.hook and job.hook.kind in {"cancel_running", "client_disconnect"}:
        hook_timer = threading.Timer(
            job.hook.after_ms / 1_000,
            controller.trigger,
            args=(job.hook.kind,),
        )
        hook_timer.daemon = True
        hook_timer.start()
    observations: list[HttpObservation] = []
    outcome = "error"
    status = 0
    error_code: str | None = None
    try:
        request_spec = dict(job.profile.request)
        first = _http_json(request_spec, controller, job)
        observations.append(first)
        status = first.status
        error_code = first.error_code
        if first.transport_error:
            outcome = first.transport_error
        elif not 200 <= first.status < 300:
            outcome = "error"
        elif job.profile.poll is None:
            outcome = "success"
        else:
            poll = job.profile.poll
            task_id = _json_path(first.data, str(poll["task_id_path"]))
            if not isinstance(task_id, (str, int)) or not str(task_id):
                error_code = "contract_missing_task_id"
                outcome = "error"
            else:
                deadline = time.perf_counter() + float(poll["max_wait_ms"]) / 1_000
                success_states = set(poll["terminal_success"])
                failure_states = set(poll["terminal_failure"])
                while True:
                    if controller.event.wait(float(poll["interval_ms"]) / 1_000):
                        outcome = controller.reason or "cancelled_running"
                        error_code = outcome
                        status = 0
                        break
                    if time.perf_counter() >= deadline:
                        outcome = "error"
                        error_code = "poll_timeout"
                        status = 0
                        break
                    poll_url = str(poll["url_template"]).replace(
                        "{task_id}", urllib.parse.quote(str(task_id), safe="")
                    )
                    poll_spec = {
                        "url": poll_url,
                        "method": poll["method"],
                        "headers": poll["headers"],
                        "json": poll.get("json"),
                        "timeout_ms": poll["request_timeout_ms"],
                    }
                    observation = _http_json(poll_spec, controller, job)
                    observations.append(observation)
                    status = observation.status
                    error_code = observation.error_code
                    if observation.transport_error:
                        outcome = observation.transport_error
                        break
                    if not 200 <= observation.status < 300:
                        outcome = "error"
                        break
                    terminal = _safe_code(_json_path(observation.data, str(poll["status_path"])))
                    terminal = terminal.upper() if terminal else ""
                    if terminal in success_states:
                        outcome = "success"
                        error_code = None
                        break
                    if terminal in failure_states:
                        outcome = "error"
                        error_code = _extract_error_code(observation.data, observation.status) or f"terminal_{terminal.lower()}"
                        break
    finally:
        if hook_timer is not None:
            hook_timer.cancel()
    completed_at = time.perf_counter()
    hook_requested = job.hook.kind if job.hook else None
    hook_outcome: str | None = None
    if job.hook:
        if job.hook.kind == "cancel_queued":
            hook_outcome = queued_state.outcome or "cancel_queued_missed"
        elif outcome == job.hook.kind:
            hook_outcome = outcome
        else:
            hook_outcome = f"{job.hook.kind}_missed"
    traces = [observation.trace_id for observation in observations if observation.trace_id]
    return JobResult(
        job_id=job.job_id,
        phase=job.phase,
        isolation_group=job.isolation_group,
        wave=job.wave,
        profile=job.profile.name,
        kind=job.profile.kind,
        priority=job.profile.priority,
        outcome=outcome,
        status=status,
        error_code=error_code,
        hook_requested=hook_requested,
        hook_outcome=hook_outcome,
        scheduled_at_ms=job.scheduled_offset_ms,
        submitted_at_ms=(submitted_at - epoch) * 1_000,
        started_at_ms=(started_at - epoch) * 1_000,
        completed_at_ms=(completed_at - epoch) * 1_000,
        dispatch_wait_ms=(started_at - submitted_at) * 1_000,
        client_total_ms=(completed_at - started_at) * 1_000,
        scheduled_to_complete_ms=(completed_at - epoch) * 1_000 - job.scheduled_offset_ms,
        server_segments_ms=_aggregate_segments(observations),
        server_timing_responses=sum(bool(observation.server_segments_ms) for observation in observations),
        http_responses=len(observations),
        client_trace_id=_client_trace_id(job),
        trace_ids=list(dict.fromkeys(traces)),
    )


def _queued_cancel_result(job: Job, epoch: float, submitted_at: float) -> JobResult:
    completed_at = time.perf_counter()
    return JobResult(
        job_id=job.job_id,
        phase=job.phase,
        isolation_group=job.isolation_group,
        wave=job.wave,
        profile=job.profile.name,
        kind=job.profile.kind,
        priority=job.profile.priority,
        outcome="cancel_queued",
        status=0,
        error_code="cancel_queued",
        hook_requested="cancel_queued",
        hook_outcome="cancel_queued",
        scheduled_at_ms=job.scheduled_offset_ms,
        submitted_at_ms=(submitted_at - epoch) * 1_000,
        started_at_ms=0.0,
        completed_at_ms=(completed_at - epoch) * 1_000,
        dispatch_wait_ms=max(0.0, (completed_at - submitted_at) * 1_000),
        client_total_ms=0.0,
        scheduled_to_complete_ms=(completed_at - epoch) * 1_000 - job.scheduled_offset_ms,
        server_segments_ms={},
        server_timing_responses=0,
        http_responses=0,
        client_trace_id=_client_trace_id(job),
        trace_ids=[],
    )


def _run_jobs(jobs: list[Job], max_workers: int) -> list[JobResult]:
    if not jobs:
        return []
    epoch = time.perf_counter()
    futures: dict[concurrent.futures.Future[JobResult], tuple[Job, float, QueuedHookState]] = {}
    timers: list[threading.Timer] = []
    with concurrent.futures.ThreadPoolExecutor(max_workers=max_workers, thread_name_prefix="svc00") as executor:
        for job in jobs:
            target = epoch + job.scheduled_offset_ms / 1_000
            remaining = target - time.perf_counter()
            if remaining > 0:
                time.sleep(remaining)
            submitted_at = time.perf_counter()
            queued_state = QueuedHookState(bool(job.hook and job.hook.kind == "cancel_queued"))
            future = executor.submit(_execute_job, job, epoch, submitted_at, queued_state)
            futures[future] = (job, submitted_at, queued_state)
            if job.hook and job.hook.kind == "cancel_queued":
                def cancel_queued(
                    target_future: concurrent.futures.Future[JobResult] = future,
                    state: QueuedHookState = queued_state,
                ) -> None:
                    state.set_once("cancel_queued" if target_future.cancel() else "cancel_queued_missed")

                timer = threading.Timer(job.hook.after_ms / 1_000, cancel_queued)
                timer.daemon = True
                timer.start()
                timers.append(timer)
        concurrent.futures.wait(futures)
    for timer in timers:
        timer.cancel()
    results: list[JobResult] = []
    for future, (job, submitted_at, queued_state) in futures.items():
        if future.cancelled():
            results.append(_queued_cancel_result(job, epoch, submitted_at))
        else:
            results.append(future.result())
    return sorted(results, key=lambda item: (item.completed_at_ms, item.job_id))


def _percentile(values: Iterable[float], percentile: float) -> float | None:
    ordered = sorted(float(value) for value in values if math.isfinite(float(value)))
    if not ordered:
        return None
    if len(ordered) == 1:
        return round(ordered[0], 3)
    position = (len(ordered) - 1) * percentile
    lower = math.floor(position)
    upper = math.ceil(position)
    if lower == upper:
        return round(ordered[lower], 3)
    value = ordered[lower] + (ordered[upper] - ordered[lower]) * (position - lower)
    return round(value, 3)


def _distribution(values: Iterable[float]) -> dict[str, float | None]:
    materialized = list(values)
    return {
        "p50": _percentile(materialized, 0.50),
        "p95": _percentile(materialized, 0.95),
        "p99": _percentile(materialized, 0.99),
        "max": round(max(materialized), 3) if materialized else None,
    }


def _count_by(values: Iterable[str | None]) -> dict[str, int]:
    counts: dict[str, int] = {}
    for value in values:
        key = value or "none"
        counts[key] = counts.get(key, 0) + 1
    return dict(sorted(counts.items()))


def _successful(results: Iterable[JobResult]) -> list[JobResult]:
    return [result for result in results if result.outcome == "success"]


def _summary_for(results: list[JobResult]) -> dict[str, Any]:
    successful = _successful(results)
    segment_names = sorted({name for result in successful for name in result.server_segments_ms})
    return {
        "requests": len(results),
        "successes": len(successful),
        "outcomes": _count_by(result.outcome for result in results),
        "errors": _count_by(
            result.error_code
            for result in results
            if result.outcome not in {"success", "cancel_queued", "cancel_running", "client_disconnect"}
        ),
        "successful_latency_ms": {
            "client_total": _distribution(result.client_total_ms for result in successful),
            "dispatch_wait": _distribution(result.dispatch_wait_ms for result in successful),
            "scheduled_to_complete": _distribution(result.scheduled_to_complete_ms for result in successful),
        },
        "server_timing": {
            "response_coverage": round(
                sum(result.server_timing_responses for result in results)
                / max(1, sum(result.http_responses for result in results)),
                6,
            ),
            "segments_ms": {
                name: _distribution(result.server_segments_ms[name] for result in successful if name in result.server_segments_ms)
                for name in segment_names
            },
        },
    }


def _starvation(config: RunnerConfig, results: list[JobResult]) -> dict[str, Any]:
    interactive = [
        result
        for result in results
        if result.phase == "mixed"
        and result.priority == "interactive"
        and result.outcome not in {"cancel_queued", "cancel_running", "client_disconnect"}
    ]
    background = [
        result
        for result in results
        if result.phase == "mixed"
        and result.priority == "background"
        and result.outcome not in {"cancel_queued", "cancel_running", "client_disconnect"}
    ]
    with_server_queue = [result for result in interactive if "queue_wait" in result.server_segments_ms]
    combined = [result.dispatch_wait_ms + result.server_segments_ms["queue_wait"] for result in with_server_queue]
    client_starved = [
        result for result in interactive if result.dispatch_wait_ms > config.interactive_queue_starvation_ms
    ]
    combined_starved = [value for value in combined if value > config.interactive_queue_starvation_ms]
    background_starved = [
        result
        for result in background
        if result.outcome != "success"
        or result.scheduled_to_complete_ms > config.background_completion_starvation_ms
    ]
    return {
        "definition": {
            "interactive": "client dispatch wait plus reported Server-Timing queue_wait",
            "background": "non-success or scheduled-to-complete above the configured finite-run threshold",
            "limitation": "missing server queue telemetry is unmeasured, never inferred from total latency",
        },
        "thresholds_ms": {
            "interactive_queue": config.interactive_queue_starvation_ms,
            "background_completion": config.background_completion_starvation_ms,
        },
        "interactive": {
            "eligible": len(interactive),
            "client_dispatch_starved": len(client_starved),
            "server_queue_measured": len(with_server_queue),
            "server_queue_unmeasured": len(interactive) - len(with_server_queue),
            "combined_queue_starved": len(combined_starved),
            "combined_queue_ms": _distribution(combined),
        },
        "background": {
            "eligible": len(background),
            "starved_or_incomplete": len(background_starved),
            "scheduled_to_complete_ms": _distribution(
                result.scheduled_to_complete_ms for result in background if result.outcome == "success"
            ),
        },
    }


def _degradation(results: list[JobResult]) -> dict[str, Any]:
    output: dict[str, Any] = {}
    for kind in sorted(ALLOWED_KINDS):
        isolated = [result.client_total_ms for result in results if result.phase == "isolated" and result.kind == kind and result.outcome == "success"]
        mixed = [result.client_total_ms for result in results if result.phase == "mixed" and result.kind == kind and result.outcome == "success"]
        isolated_p95 = _percentile(isolated, 0.95)
        mixed_p95 = _percentile(mixed, 0.95)
        degradation = None
        if isolated_p95 is not None and mixed_p95 is not None and isolated_p95 > 0:
            degradation = round((mixed_p95 / isolated_p95 - 1.0) * 100, 3)
        output[kind] = {
            "isolated_successes": len(isolated),
            "mixed_successes": len(mixed),
            "isolated_p95_ms": isolated_p95,
            "mixed_p95_ms": mixed_p95,
            "p95_degradation_percent": degradation,
        }
    return output


def _route_evidence(results: list[JobResult]) -> dict[str, Any]:
    output: dict[str, Any] = {}
    for kind in sorted(ALLOWED_KINDS):
        selected = [result for result in results if result.outcome == "success" and result.kind == kind]
        with_inference = [
            result for result in selected if result.server_segments_ms.get("inference", 0.0) > 0
        ]
        output[kind] = {
            "successful_requests": len(selected),
            "inference_positive": len(with_inference),
            "inference_missing_or_zero": len(selected) - len(with_inference),
            "interpretation": (
                "model route is evidenced only when inference is positive"
                if kind == "model_schedule"
                else "profile classification; inspect unexpected inference separately"
            ),
        }
    return output


def build_report(
    config: RunnerConfig,
    results: list[JobResult],
    *,
    manifest_path: Path | None = None,
    manifest_sha256: str | None = None,
) -> dict[str, Any]:
    by_phase_kind: dict[str, Any] = {}
    for phase in config.phases:
        by_phase_kind[phase] = {}
        for kind in sorted(ALLOWED_KINDS):
            selected = [result for result in results if result.phase == phase and result.kind == kind]
            if selected:
                by_phase_kind[phase][kind] = _summary_for(selected)
    origins: set[str] = set()
    for profile in config.profiles:
        urls = [str(profile.request["url"])]
        if profile.poll is not None:
            urls.append(str(profile.poll["url_template"]).replace("{task_id}", "report-task"))
        for url in urls:
            parsed = _candidate_url(url, f"profile {profile.name}")
            origins.add(f"{parsed.scheme}://{parsed.hostname}:{parsed.port}")
    records = []
    for result in results:
        record = dataclasses.asdict(result)
        record["server_segments_ms"] = {
            key: round(value, 3) for key, value in sorted(result.server_segments_ms.items())
        }
        for field in (
            "scheduled_at_ms",
            "submitted_at_ms",
            "started_at_ms",
            "completed_at_ms",
            "dispatch_wait_ms",
            "client_total_ms",
            "scheduled_to_complete_ms",
        ):
            record[field] = round(float(record[field]), 3)
        records.append(record)
    return {
        "schema_version": 1,
        "runner_version": RUNNER_VERSION,
        "generated_at": dt.datetime.now(dt.timezone.utc).isoformat(),
        "measurement_scope": "isolated_loopback_candidate_only",
        "artifacts": {
            "runner_path": str(Path(__file__).resolve()),
            "runner_sha256": _file_sha256(Path(__file__).resolve()),
            "manifest_path": str(manifest_path.resolve()) if manifest_path is not None else None,
            "manifest_sha256": manifest_sha256,
        },
        "safety": {
            "allowed_schemes": ["http"],
            "allowed_hosts": ["localhost", "127.0.0.0/8", "::1"],
            "allowed_ports": [CANDIDATE_PORT_MIN, CANDIDATE_PORT_MAX],
            "hard_forbidden_ports": sorted(FORBIDDEN_PORTS),
            "override_supported": False,
            "origins": sorted(origins),
            "request_payloads_and_headers_recorded": False,
        },
        "configuration": {
            "phases": list(config.phases),
            "waves": config.waves,
            "wave_interval_ms": config.wave_interval_ms,
            "max_workers": config.max_workers,
            "seed": config.seed,
            "profiles": [
                {
                    "name": profile.name,
                    "kind": profile.kind,
                    "priority": profile.priority,
                    "count_per_wave": profile.count_per_wave,
                    "isolated_count": profile.isolated_count,
                    "has_poll_workflow": profile.poll is not None,
                    "hooks": [hook.kind for hook in profile.hooks],
                }
                for profile in config.profiles
            ],
        },
        "overall": _summary_for(results),
        "by_phase_and_kind": by_phase_kind,
        "hooks": {
            "requested": _count_by(result.hook_requested for result in results if result.hook_requested),
            "outcomes": _count_by(result.hook_outcome for result in results if result.hook_requested),
        },
        "starvation": _starvation(config, results),
        "mixed_vs_isolated": _degradation(results),
        "route_evidence": _route_evidence(results),
        "records": records,
        "interpretation_limits": [
            "This runner reports measurements and does not make a release decision.",
            "A client-side disconnect does not prove that an asynchronous server task was cancelled.",
            "Missing Server-Timing queue_wait makes server starvation unmeasured.",
            "Resource/OOM and durable-task correctness need separate candidate-side telemetry and fault injection.",
        ],
    }


def run_config(
    config: RunnerConfig,
    *,
    manifest_path: Path | None = None,
    manifest_sha256: str | None = None,
) -> dict[str, Any]:
    results: list[JobResult] = []
    if "isolated" in config.phases:
        for profile in config.profiles:
            jobs = _make_jobs(config, "isolated", profile.name)
            results.extend(_run_jobs(jobs, config.max_workers))
    if "mixed" in config.phases:
        results.extend(_run_jobs(_make_jobs(config, "mixed"), config.max_workers))
    return build_report(
        config,
        results,
        manifest_path=manifest_path,
        manifest_sha256=manifest_sha256,
    )


def _find_test_port() -> int:
    start = CANDIDATE_PORT_MIN + (os.getpid() % 800)
    for port in list(range(start, CANDIDATE_PORT_MAX + 1)) + list(range(CANDIDATE_PORT_MIN, start)):
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as probe:
            try:
                probe.bind(("127.0.0.1", port))
            except OSError:
                continue
            return port
    raise RuntimeError("no free 280xx port for self-test")


class _MockState:
    def __init__(self) -> None:
        self.lock = threading.Lock()
        self.polls: dict[str, int] = {}


class _MockHandler(http.server.BaseHTTPRequestHandler):
    server_version = "LaoJiSvc00Mock/1"

    def log_message(self, _format: str, *_args: Any) -> None:
        return

    def _read_json(self) -> dict[str, Any]:
        length = int(self.headers.get("Content-Length", "0"))
        raw = self.rfile.read(length) if length else b"{}"
        try:
            value = json.loads(raw)
        except json.JSONDecodeError:
            return {}
        return value if isinstance(value, dict) else {}

    def _send(self, payload: Mapping[str, Any], delay_s: float, timing: str) -> None:
        time.sleep(delay_s)
        body = json.dumps(payload).encode("utf-8")
        try:
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Server-Timing", timing)
            self.send_header(
                "X-Trace-ID",
                self.headers.get("X-Trace-ID")
                or self.headers.get("X-Request-ID", "mock-missing-trace"),
            )
            self.end_headers()
            self.wfile.write(body)
        except (BrokenPipeError, ConnectionResetError):
            pass

    def do_POST(self) -> None:  # noqa: N802 - stdlib handler API
        payload = self._read_json()
        if self.path == "/summary":
            task_id = str(payload.get("meeting_id", "task"))
            self._send(
                {"task_id": task_id},
                0.11,
                "app;dur=110, queue_wait;dur=8, inference;dur=90, persistence;dur=2",
            )
        elif self.path == "/question":
            self._send(
                {"answer": "ok", "timing_ms": {"verification": 3}},
                0.075,
                "app;dur=75, queue_wait;dur=6, inference;dur=60",
            )
        elif self.path == "/schedule":
            is_model = payload.get("lane") == "model"
            delay = 0.055 if is_model else 0.008
            inference = 42 if is_model else 0
            self._send(
                {"status": "complete"},
                delay,
                f"app;dur={delay * 1000:.3f}, queue_wait;dur=1, inference;dur={inference}",
            )
        else:
            self.send_error(404)

    def do_GET(self) -> None:  # noqa: N802 - stdlib handler API
        prefix = "/summary/tasks/"
        if not self.path.startswith(prefix):
            self.send_error(404)
            return
        task_id = urllib.parse.unquote(self.path[len(prefix):].split("?", 1)[0])
        state = self.server.mock_state  # type: ignore[attr-defined]
        with state.lock:
            count = state.polls.get(task_id, 0) + 1
            state.polls[task_id] = count
        terminal = "SUCCESS" if count >= 2 else "STARTED"
        self._send(
            {"task_id": task_id, "status": terminal},
            0.025,
            "app;dur=25, queue_wait;dur=2, inference;dur=15",
        )


def _self_test_manifest(port: int) -> dict[str, Any]:
    base = f"http://127.0.0.1:{port}"
    return {
        "schema_version": 1,
        "runner": {
            "phases": ["isolated", "mixed"],
            "waves": 2,
            "wave_interval_ms": 25,
            "max_workers": 2,
            "seed": 20260730,
            "starvation": {"interactive_queue_ms": 500, "background_completion_ms": 2_000},
        },
        "profiles": [
            {
                "name": "summary",
                "kind": "long_summary",
                "priority": "background",
                "count_per_wave": 2,
                "isolated_count": 1,
                "request": {
                    "url": f"{base}/summary",
                    "method": "POST",
                    "timeout_ms": 1_000,
                    "json": {"meeting_id": "{{job_id}}"},
                },
                "poll": {
                    "url_template": f"{base}/summary/tasks/{{task_id}}",
                    "interval_ms": 5,
                    "request_timeout_ms": 1_000,
                    "max_wait_ms": 1_000,
                },
                "hooks": [
                    {"type": "cancel_running", "every": 2, "offset": 0, "after_ms": 20, "phases": ["mixed"]}
                ],
            },
            {
                "name": "question",
                "kind": "question",
                "count_per_wave": 2,
                "isolated_count": 1,
                "request": {"url": f"{base}/question", "method": "POST", "json": {"question": "test"}},
                "hooks": [
                    {"type": "client_disconnect", "every": 2, "offset": 0, "after_ms": 15, "phases": ["mixed"]}
                ],
            },
            {
                "name": "rule",
                "kind": "rule_schedule",
                "count_per_wave": 3,
                "isolated_count": 1,
                "arrival_offset_ms": 2,
                "request": {"url": f"{base}/schedule", "method": "POST", "json": {"lane": "rule"}},
                "hooks": [
                    {"type": "cancel_queued", "every": 2, "offset": 0, "after_ms": 1, "phases": ["mixed"]}
                ],
            },
            {
                "name": "model",
                "kind": "model_schedule",
                "count_per_wave": 2,
                "isolated_count": 1,
                "arrival_offset_ms": 1,
                "request": {"url": f"{base}/schedule", "method": "POST", "json": {"lane": "model"}},
            },
        ],
    }


def self_test() -> dict[str, Any]:
    rejected: list[str] = []
    for port in sorted(FORBIDDEN_PORTS | {27999, 29000}):
        bad = _self_test_manifest(CANDIDATE_PORT_MIN)
        bad["profiles"][0]["request"]["url"] = f"http://127.0.0.1:{port}/unsafe"
        try:
            normalize_manifest(bad)
        except ConfigError:
            rejected.append(str(port))
        else:
            raise AssertionError(f"unsafe port {port} was accepted")
    bad_host = _self_test_manifest(CANDIDATE_PORT_MIN)
    bad_host["profiles"][0]["request"]["url"] = f"http://192.0.2.10:{CANDIDATE_PORT_MIN}/unsafe"
    try:
        normalize_manifest(bad_host)
    except ConfigError:
        rejected.append("non_loopback")
    else:
        raise AssertionError("non-loopback endpoint was accepted")
    bad_downstream = _self_test_manifest(CANDIDATE_PORT_MIN)
    bad_downstream["profiles"][0]["request"]["json"]["downstream_base_url"] = (
        "http://127.0.0.1:21434"
    )
    try:
        normalize_manifest(bad_downstream)
    except ConfigError:
        rejected.append("embedded_shared_model_url")
    else:
        raise AssertionError("embedded shared-model URL was accepted")

    timing = _extract_server_timing(
        [("Server-Timing", "app;dur=12.5, queue_estimate;dur=3"), ("X-Laoji-Timing-Load", "4")],
        {"timing_ms": {"verification": 2}},
    )
    expected_timing = {"app": 12.5, "queue_wait": 3.0, "model_load_or_warmup": 4.0, "verification": 2.0}
    if timing != expected_timing:
        raise AssertionError(f"Server-Timing parser mismatch: {timing}")

    port = _find_test_port()
    server = http.server.ThreadingHTTPServer(("127.0.0.1", port), _MockHandler)
    server.mock_state = _MockState()  # type: ignore[attr-defined]
    thread = threading.Thread(target=server.serve_forever, name="svc00-self-test-server", daemon=True)
    thread.start()
    try:
        config = normalize_manifest(_self_test_manifest(port))
        report = run_config(config)
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=5)
    kinds = {
        record["kind"] for record in report["records"] if record["outcome"] == "success"
    }
    if kinds != ALLOWED_KINDS:
        raise AssertionError(f"not every workload kind completed successfully: {sorted(kinds)}")
    hook_outcomes = report["hooks"]["outcomes"]
    for required in ("cancel_queued", "cancel_running", "client_disconnect"):
        if hook_outcomes.get(required, 0) < 1:
            raise AssertionError(f"hook {required} was not exercised: {hook_outcomes}")
    latency = report["overall"]["successful_latency_ms"]["client_total"]
    if any(latency[name] is None for name in ("p50", "p95", "p99", "max")):
        raise AssertionError(f"latency percentiles missing: {latency}")
    if report["overall"]["server_timing"]["response_coverage"] <= 0:
        raise AssertionError("Server-Timing coverage was not measured")
    if set(report["mixed_vs_isolated"]) != ALLOWED_KINDS:
        raise AssertionError("mixed/isolated comparison is incomplete")
    if report["route_evidence"]["model_schedule"]["inference_positive"] < 1:
        raise AssertionError("model schedule route evidence was not recorded")
    if report["route_evidence"]["rule_schedule"]["inference_positive"] != 0:
        raise AssertionError("rule schedule unexpectedly reported model inference")
    artifacts = report.get("artifacts") or {}
    if not re.fullmatch(r"[0-9a-f]{64}", str(artifacts.get("runner_sha256") or "")):
        raise AssertionError(f"runner artifact hash is missing or invalid: {artifacts}")
    if artifacts.get("manifest_path") is not None or artifacts.get("manifest_sha256") is not None:
        raise AssertionError(f"in-memory self-test unexpectedly reports a manifest file: {artifacts}")
    for record in report["records"]:
        if record["outcome"] == "success" and record["client_trace_id"] not in record["trace_ids"]:
            raise AssertionError(f"trace ID was not correlated for {record['job_id']}")
    with tempfile.TemporaryDirectory(prefix="laoji-svc00-") as temp_dir:
        report_path = Path(temp_dir) / "report.json"
        report_path.write_text(json.dumps(report, ensure_ascii=False), encoding="utf-8")
        json.loads(report_path.read_text(encoding="utf-8"))
    return {
        "status": "passed",
        "unsafe_targets_rejected": rejected,
        "requests": report["overall"]["requests"],
        "successes": report["overall"]["successes"],
        "hook_outcomes": hook_outcomes,
        "server_timing_coverage": report["overall"]["server_timing"]["response_coverage"],
        "latency_ms": latency,
    }


def _write_report(report: Mapping[str, Any], path: Path | None) -> None:
    encoded = json.dumps(report, ensure_ascii=False, indent=2, sort_keys=True) + "\n"
    if path is None:
        sys.stdout.write(encoded)
        return
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(encoded, encoding="utf-8")
    print(f"wrote {path}")


def _validation_summary(config: RunnerConfig) -> dict[str, Any]:
    return {
        "status": "valid",
        "runner_version": RUNNER_VERSION,
        "phases": list(config.phases),
        "profiles": [
            {
                "name": profile.name,
                "kind": profile.kind,
                "priority": profile.priority,
                "count_per_wave": profile.count_per_wave,
                "isolated_count": profile.isolated_count,
                "poll_workflow": profile.poll is not None,
            }
            for profile in config.profiles
        ],
        "candidate_boundary": {
            "ports": [CANDIDATE_PORT_MIN, CANDIDATE_PORT_MAX],
            "forbidden": sorted(FORBIDDEN_PORTS),
            "override_supported": False,
        },
    }


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    subparsers = parser.add_subparsers(dest="command", required=True)
    validate_parser = subparsers.add_parser("validate", help="validate a manifest without sending requests")
    validate_parser.add_argument("manifest", type=Path)
    run_parser = subparsers.add_parser("run", help="run an explicitly confirmed isolated candidate workload")
    run_parser.add_argument("manifest", type=Path)
    run_parser.add_argument("--confirm-candidate-run", action="store_true", required=True)
    run_parser.add_argument("--json-out", type=Path)
    subparsers.add_parser("self-test", help="run the local mock server and deterministic safety checks")
    args = parser.parse_args(argv)
    try:
        if args.command == "self-test":
            _write_report(self_test(), None)
            return 0
        manifest_path = args.manifest.resolve()
        manifest_sha256 = _file_sha256(manifest_path)
        config = load_manifest(manifest_path)
        if args.command == "validate":
            _write_report(_validation_summary(config), None)
            return 0
        report = run_config(
            config,
            manifest_path=manifest_path,
            manifest_sha256=manifest_sha256,
        )
        if _file_sha256(manifest_path) != manifest_sha256:
            raise AssertionError("manifest changed while the workload was running")
        _write_report(report, args.json_out)
        return 0
    except (ConfigError, AssertionError) as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 2
    except KeyboardInterrupt:
        print("interrupted; no release conclusion was produced", file=sys.stderr)
        return 130


if __name__ == "__main__":
    raise SystemExit(main())
