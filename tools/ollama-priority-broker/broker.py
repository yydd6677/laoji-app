#!/usr/bin/env python3
"""Small, dependency-free priority broker for Ollama chat/generate calls.

This is an isolated SVC-00 G1 prototype.  It intentionally implements only the
HTTP/1.1 surface needed by Ollama's ``/api/chat`` and ``/api/generate`` APIs.
"""

from __future__ import annotations

import argparse
import asyncio
from collections import deque
from dataclasses import dataclass, field
import ipaddress
import json
import logging
import re
import signal
import sys
import time
from typing import Awaitable, Callable, Iterable, TypeVar
from urllib.parse import unquote, urlsplit
import uuid


LOGGER = logging.getLogger("ollama_priority_broker")
PRIORITIES = ("interactive", "background")
ALLOWED_PATHS = ("/api/chat", "/api/generate")
MAX_HEADER_BYTES = 64 * 1024
MAX_QUEUE_DEADLINE_MS = 10 * 60 * 1000
REQUEST_ID_RE = re.compile(r"^[A-Za-z0-9._:-]{1,128}$")
T = TypeVar("T")
HOP_BY_HOP_HEADERS = {
    "connection",
    "keep-alive",
    "proxy-authenticate",
    "proxy-authorization",
    "te",
    "trailer",
    "transfer-encoding",
    "upgrade",
}
FORWARDED_REQUEST_HEADERS = {
    "accept",
    "authorization",
    "content-type",
    "traceparent",
    "tracestate",
    "user-agent",
    "x-request-id",
    "x-laoji-operation",
}


class HttpError(Exception):
    def __init__(self, status: int, code: str, message: str):
        super().__init__(message)
        self.status = status
        self.code = code
        self.message = message


class RequestCancelled(Exception):
    pass


class ClientDisconnected(Exception):
    pass


class UpstreamRequestFailed(Exception):
    def __init__(self, code: str):
        super().__init__(code)
        self.code = code


@dataclass(frozen=True)
class ListenerSpec:
    host: str
    port: int
    priority: str


@dataclass
class IncomingRequest:
    method: str
    target: str
    version: str
    headers: dict[str, str]
    body: bytes


@dataclass
class Job:
    request_id: str
    priority: str
    path: str
    request: IncomingRequest
    client_writer: asyncio.StreamWriter
    enqueued_at: float
    completion: asyncio.Future[str]
    queue_deadline_ms: int | None = None
    cancel_event: asyncio.Event = field(default_factory=asyncio.Event)
    state: str = "queued"
    cancel_reason: str | None = None
    queue_wait_ms: float | None = None
    started_at: float | None = None
    response_started: bool = False
    upstream_writer: asyncio.StreamWriter | None = None


def _json_log(event: str, **fields: object) -> None:
    LOGGER.info(json.dumps({"event": event, **fields}, ensure_ascii=True, sort_keys=True))


def parse_queue_deadline(value: str | None) -> int | None:
    """Parse an optional client queue budget without accepting ambiguous values."""

    if value is None or not value.strip():
        return None
    normalized = value.strip()
    if not normalized.isdecimal():
        raise HttpError(
            400,
            "invalid_queue_deadline",
            "X-Laoji-Queue-Deadline-Ms must be an integer in the allowed range",
        )
    deadline_ms = int(normalized)
    if not 1 <= deadline_ms <= MAX_QUEUE_DEADLINE_MS:
        raise HttpError(
            400,
            "invalid_queue_deadline",
            "X-Laoji-Queue-Deadline-Ms is outside the allowed range",
        )
    return deadline_ms


def _is_loopback(host: str) -> bool:
    if host.lower() == "localhost":
        return True
    try:
        return ipaddress.ip_address(host).is_loopback
    except ValueError:
        return False


def parse_listener_spec(value: str) -> ListenerSpec:
    address, separator, priority = value.rpartition("=")
    if not separator or priority not in PRIORITIES:
        raise argparse.ArgumentTypeError(
            "listener must be HOST:PORT=interactive or HOST:PORT=background"
        )
    if address.startswith("["):
        end = address.find("]")
        if end < 0 or address[end + 1 : end + 2] != ":":
            raise argparse.ArgumentTypeError("invalid bracketed IPv6 listener")
        host = address[1:end]
        port_text = address[end + 2 :]
    else:
        try:
            host, port_text = address.rsplit(":", 1)
        except ValueError as exc:
            raise argparse.ArgumentTypeError("listener must contain a port") from exc
    if not _is_loopback(host):
        raise argparse.ArgumentTypeError("the G1 broker only listens on loopback")
    try:
        port = int(port_text)
    except ValueError as exc:
        raise argparse.ArgumentTypeError("listener port must be an integer") from exc
    if not 0 <= port <= 65535:
        raise argparse.ArgumentTypeError("listener port is out of range")
    return ListenerSpec(host, port, priority)


def validate_upstream(value: str) -> str:
    parsed = urlsplit(value)
    if parsed.scheme != "http" or not parsed.hostname or parsed.port is None:
        raise argparse.ArgumentTypeError("upstream must be an explicit loopback http URL with a port")
    if not _is_loopback(parsed.hostname):
        raise argparse.ArgumentTypeError("the G1 broker only forwards to loopback")
    if parsed.query or parsed.fragment:
        raise argparse.ArgumentTypeError("upstream URL cannot contain a query or fragment")
    return value.rstrip("/")


async def _read_head(reader: asyncio.StreamReader, timeout: float) -> bytes:
    try:
        return await asyncio.wait_for(reader.readuntil(b"\r\n\r\n"), timeout=timeout)
    except asyncio.TimeoutError as exc:
        raise HttpError(408, "header_timeout", "request headers timed out") from exc
    except asyncio.LimitOverrunError as exc:
        raise HttpError(431, "headers_too_large", "request headers are too large") from exc
    except asyncio.IncompleteReadError as exc:
        if not exc.partial:
            raise ClientDisconnected from exc
        raise HttpError(400, "incomplete_headers", "incomplete request headers") from exc


def _parse_headers(head: bytes, *, response: bool = False) -> tuple[str, list[tuple[str, str]]]:
    if len(head) > MAX_HEADER_BYTES:
        raise HttpError(431, "headers_too_large", "headers are too large")
    try:
        lines = head[:-4].decode("iso-8859-1").split("\r\n")
    except UnicodeDecodeError as exc:
        raise HttpError(400, "invalid_headers", "headers are not ISO-8859-1") from exc
    if not lines or not lines[0]:
        raise HttpError(400, "invalid_start_line", "missing HTTP start line")
    headers: list[tuple[str, str]] = []
    for line in lines[1:]:
        if not line or line[:1].isspace() or ":" not in line:
            raise HttpError(502 if response else 400, "invalid_headers", "malformed HTTP header")
        name, value = line.split(":", 1)
        name = name.strip()
        value = value.strip()
        if not name or "\r" in value or "\n" in value:
            raise HttpError(502 if response else 400, "invalid_headers", "malformed HTTP header")
        headers.append((name, value))
    return lines[0], headers


def _headers_dict(items: Iterable[tuple[str, str]]) -> dict[str, str]:
    result: dict[str, str] = {}
    for name, value in items:
        lowered = name.lower()
        result[lowered] = f"{result[lowered]}, {value}" if lowered in result else value
    return result


async def read_request(
    reader: asyncio.StreamReader,
    *,
    max_body_bytes: int,
    header_timeout: float,
) -> IncomingRequest:
    head = await _read_head(reader, header_timeout)
    start_line, header_items = _parse_headers(head)
    parts = start_line.split(" ")
    if len(parts) != 3:
        raise HttpError(400, "invalid_request_line", "malformed HTTP request line")
    method, target, version = parts
    if version not in {"HTTP/1.0", "HTTP/1.1"}:
        raise HttpError(505, "http_version_not_supported", "only HTTP/1.0 and HTTP/1.1 are supported")
    headers = _headers_dict(header_items)
    if "chunked" in headers.get("transfer-encoding", "").lower():
        raise HttpError(400, "chunked_request_unsupported", "chunked request bodies are not supported")
    raw_length = headers.get("content-length", "0")
    try:
        content_length = int(raw_length)
    except ValueError as exc:
        raise HttpError(400, "invalid_content_length", "invalid Content-Length") from exc
    if content_length < 0 or content_length > max_body_bytes:
        raise HttpError(413, "request_too_large", "request body exceeds the configured limit")
    try:
        body = await reader.readexactly(content_length) if content_length else b""
    except asyncio.IncompleteReadError as exc:
        raise HttpError(400, "incomplete_body", "request body ended early") from exc
    return IncomingRequest(method.upper(), target, version, headers, body)


def _status_reason(status: int) -> str:
    return {
        200: "OK",
        202: "Accepted",
        400: "Bad Request",
        404: "Not Found",
        405: "Method Not Allowed",
        408: "Request Timeout",
        413: "Payload Too Large",
        429: "Too Many Requests",
        431: "Request Header Fields Too Large",
        499: "Client Closed Request",
        500: "Internal Server Error",
        502: "Bad Gateway",
        503: "Service Unavailable",
        505: "HTTP Version Not Supported",
    }.get(status, "Unknown")


async def send_response_head(
    writer: asyncio.StreamWriter,
    status: int,
    headers: Iterable[tuple[str, str]],
    *,
    reason: str | None = None,
) -> None:
    clean_reason = reason if reason and "\r" not in reason and "\n" not in reason else _status_reason(status)
    lines = [f"HTTP/1.1 {status} {clean_reason}\r\n"]
    lines.extend(f"{name}: {value}\r\n" for name, value in headers)
    lines.append("\r\n")
    writer.write("".join(lines).encode("iso-8859-1"))
    await writer.drain()


async def send_json(
    writer: asyncio.StreamWriter,
    status: int,
    payload: dict[str, object],
    *,
    headers: Iterable[tuple[str, str]] = (),
) -> None:
    body = json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    response_headers = [
        ("Content-Type", "application/json; charset=utf-8"),
        ("Content-Length", str(len(body))),
        ("Connection", "close"),
        *headers,
    ]
    await send_response_head(writer, status, response_headers)
    writer.write(body)
    await writer.drain()


class PriorityScheduler:
    """One shared bounded queue with interactive priority and background aging."""

    def __init__(
        self,
        worker: Callable[[Job], Awaitable[None]],
        *,
        concurrency: int,
        max_active_background: int | None = None,
        max_queue: int,
        background_aging_seconds: float,
    ) -> None:
        if concurrency < 1 or max_queue < 1 or background_aging_seconds <= 0:
            raise ValueError("concurrency/max_queue must be positive and aging must exceed zero")
        if max_active_background is None:
            max_active_background = concurrency
        if not 1 <= max_active_background <= concurrency:
            raise ValueError("max_active_background must be between 1 and concurrency")
        self._worker = worker
        self.concurrency = concurrency
        self.max_active_background = max_active_background
        self.max_queue = max_queue
        self.background_aging_seconds = background_aging_seconds
        self._queues: dict[str, deque[Job]] = {priority: deque() for priority in PRIORITIES}
        self._condition = asyncio.Condition()
        self._jobs: dict[str, Job] = {}
        self._workers: list[asyncio.Task[None]] = []
        self._expiry_task: asyncio.Task[None] | None = None
        self._stopping = False
        self._draining = False
        self._active = 0
        self._active_by_priority = {priority: 0 for priority in PRIORITIES}
        self._last_dispatch_was_aged_background = False
        self._counters = {
            "accepted": 0,
            "rejected_full": 0,
            "cancelled_queued": 0,
            "cancelled_running": 0,
            "expired_queued": 0,
            "completed": 0,
            "failed": 0,
        }

    async def start(self) -> None:
        if self._workers:
            return
        self._workers = [
            asyncio.create_task(self._run_worker(index), name=f"broker-worker-{index}")
            for index in range(self.concurrency)
        ]
        self._expiry_task = asyncio.create_task(
            self._run_expiry_loop(), name="broker-queue-expiry"
        )

    def _waiting_count_locked(self) -> int:
        return sum(job.state == "queued" for queue in self._queues.values() for job in queue)

    async def submit(self, job: Job) -> bool:
        async with self._condition:
            if self._stopping:
                raise HttpError(503, "broker_stopping", "broker is stopping")
            if job.request_id in self._jobs:
                raise HttpError(400, "duplicate_request_id", "request ID is already active")
            if self._waiting_count_locked() >= self.max_queue:
                self._counters["rejected_full"] += 1
                return False
            self._jobs[job.request_id] = job
            self._queues[job.priority].append(job)
            self._counters["accepted"] += 1
            # Workers and the expiry watcher share this condition. Broadcast
            # so the watcher cannot consume the only wake-up for a worker.
            self._condition.notify_all()
        _json_log("queued", request_id=job.request_id, priority=job.priority)
        return True

    def _pop_live_locked(self, priority: str) -> Job | None:
        queue = self._queues[priority]
        while queue:
            job = queue[0]
            if job.state == "queued":
                return queue.popleft()
            queue.popleft()
        return None

    def _peek_live_locked(self, priority: str) -> Job | None:
        queue = self._queues[priority]
        while queue and queue[0].state != "queued":
            queue.popleft()
        return queue[0] if queue else None

    def _expire_queued_locked(self, now: float) -> list[str]:
        expired: list[str] = []
        for queue in self._queues.values():
            for job in queue:
                if job.state != "queued" or job.queue_deadline_ms is None:
                    continue
                if now - job.enqueued_at < job.queue_deadline_ms / 1000:
                    continue
                job.state = "cancelled"
                job.cancel_reason = "queue_deadline_exceeded"
                job.cancel_event.set()
                job.queue_wait_ms = max(0.0, (now - job.enqueued_at) * 1000)
                self._counters["expired_queued"] += 1
                if not job.completion.done():
                    job.completion.set_result(job.cancel_reason)
                expired.append(job.request_id)
        return expired

    def _pick_locked(self) -> Job | None:
        interactive = self._peek_live_locked("interactive")
        background = self._peek_live_locked("background")
        background_has_capacity = (
            self._active_by_priority["background"] < self.max_active_background
        )
        if not background_has_capacity:
            background = None
        if interactive is None and background is None:
            return None
        if interactive is None:
            self._last_dispatch_was_aged_background = False
            return self._pop_live_locked("background")
        if background is None:
            self._last_dispatch_was_aged_background = False
            return self._pop_live_locked("interactive")
        background_is_aged = (
            time.monotonic() - background.enqueued_at >= self.background_aging_seconds
        )
        if background_is_aged and not self._last_dispatch_was_aged_background:
            self._last_dispatch_was_aged_background = True
            return self._pop_live_locked("background")
        self._last_dispatch_was_aged_background = False
        return self._pop_live_locked("interactive")

    async def _next_job(self) -> Job | None:
        async with self._condition:
            while True:
                if self._stopping:
                    return None
                self._expire_queued_locked(time.monotonic())
                job = self._pick_locked()
                if job is not None:
                    self._active += 1
                    self._active_by_priority[job.priority] += 1
                    job.state = "running"
                    job.started_at = time.monotonic()
                    job.queue_wait_ms = (job.started_at - job.enqueued_at) * 1000
                    return job
                await self._condition.wait()

    async def _run_expiry_loop(self) -> None:
        """Expire queued jobs independently of workers occupied by long calls."""

        while True:
            async with self._condition:
                if self._stopping:
                    return
                now = time.monotonic()
                self._expire_queued_locked(now)
                deadlines = [
                    job.enqueued_at + job.queue_deadline_ms / 1000
                    for queue in self._queues.values()
                    for job in queue
                    if job.state == "queued" and job.queue_deadline_ms is not None
                ]
                if deadlines:
                    wait_for = max(0.0, min(deadlines) - time.monotonic())
                    try:
                        await asyncio.wait_for(self._condition.wait(), timeout=wait_for)
                    except asyncio.TimeoutError:
                        pass
                else:
                    await self._condition.wait()

    async def _run_worker(self, index: int) -> None:
        while True:
            job = await self._next_job()
            if job is None:
                return
            _json_log(
                "started",
                worker=index,
                request_id=job.request_id,
                priority=job.priority,
                queue_wait_ms=round(job.queue_wait_ms or 0.0, 3),
            )
            outcome = "completed"
            try:
                await self._worker(job)
                self._counters["completed"] += 1
            except (RequestCancelled, ClientDisconnected):
                outcome = job.cancel_reason or "cancelled"
            except UpstreamRequestFailed as exc:
                outcome = f"upstream_{exc.code}"
                self._counters["failed"] += 1
                _json_log(
                    "upstream_failed",
                    request_id=job.request_id,
                    error=exc.code,
                )
            except asyncio.CancelledError:
                outcome = "broker_stopped"
                job.cancel_event.set()
                raise
            except Exception as exc:  # pragma: no cover - last-resort containment
                outcome = "broker_error"
                self._counters["failed"] += 1
                _json_log("worker_error", request_id=job.request_id, error=type(exc).__name__)
                if not job.response_started and not job.client_writer.is_closing():
                    try:
                        await send_json(
                            job.client_writer,
                            500,
                            {"error": "broker_error", "request_id": job.request_id},
                            headers=_telemetry_headers(job),
                        )
                    except (ConnectionError, asyncio.CancelledError):
                        pass
            finally:
                job.state = "done"
                async with self._condition:
                    self._active -= 1
                    self._active_by_priority[job.priority] -= 1
                    self._condition.notify_all()
                if not job.completion.done():
                    job.completion.set_result(outcome)
                _json_log("finished", request_id=job.request_id, outcome=outcome)

    async def cancel(self, request_id: str, reason: str) -> str | None:
        upstream_writer: asyncio.StreamWriter | None = None
        async with self._condition:
            job = self._jobs.get(request_id)
            if job is None or job.state == "done":
                return None
            if job.state == "cancelled":
                return "queued"
            if job.cancel_event.is_set():
                return "running"
            if job.state == "queued":
                job.state = "cancelled"
                job.cancel_reason = reason
                job.cancel_event.set()
                self._counters["cancelled_queued"] += 1
                if not job.completion.done():
                    job.completion.set_result(reason)
                self._condition.notify_all()
                state = "queued"
            else:
                job.cancel_reason = reason
                job.cancel_event.set()
                upstream_writer = job.upstream_writer
                self._counters["cancelled_running"] += 1
                state = "running"
        if upstream_writer is not None:
            # Closing the socket makes a blocked upstream read/write wake promptly.
            upstream_writer.close()
        _json_log("cancelled", request_id=request_id, state=state, reason=reason)
        return state

    async def forget(self, request_id: str) -> None:
        async with self._condition:
            self._jobs.pop(request_id, None)

    async def snapshot(self) -> dict[str, object]:
        async with self._condition:
            return {
                "status": "stopping" if self._stopping else "ok",
                "draining": self._draining,
                "concurrency": self.concurrency,
                "max_active_background": self.max_active_background,
                "max_queue": self.max_queue,
                "background_aging_seconds": self.background_aging_seconds,
                "queued": {
                    priority: sum(job.state == "queued" for job in queue)
                    for priority, queue in self._queues.items()
                },
                "running": self._active,
                "running_by_priority": dict(self._active_by_priority),
                "counters": dict(self._counters),
            }

    async def _wait_for_workers(self, timeout: float) -> None:
        if not self._workers:
            return
        try:
            await asyncio.wait_for(asyncio.gather(*self._workers), timeout=timeout)
        except asyncio.TimeoutError:
            for task in self._workers:
                task.cancel()
            await asyncio.gather(*self._workers, return_exceptions=True)
        self._workers.clear()
        if self._expiry_task is not None:
            if not self._expiry_task.done():
                self._expiry_task.cancel()
            await asyncio.gather(self._expiry_task, return_exceptions=True)
            self._expiry_task = None

    async def drain(self, timeout: float = 5.0) -> None:
        """Stop admission, let running requests finish, then cancel on timeout."""

        if timeout <= 0:
            raise ValueError("drain timeout must be positive")
        async with self._condition:
            self._stopping = True
            self._draining = True
            queued = [job for job in self._jobs.values() if job.state == "queued"]
            for job in queued:
                job.state = "cancelled"
                job.cancel_reason = "broker_stopped"
                job.cancel_event.set()
                self._counters["cancelled_queued"] += 1
                if not job.completion.done():
                    job.completion.set_result(job.cancel_reason)
            self._condition.notify_all()

        deadline = time.monotonic() + timeout
        async with self._condition:
            while self._active:
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    break
                try:
                    await asyncio.wait_for(self._condition.wait(), timeout=remaining)
                except asyncio.TimeoutError:
                    break

        if self._active:
            running_ids = [
                job.request_id for job in self._jobs.values() if job.state == "running"
            ]
            for request_id in running_ids:
                await self.cancel(request_id, "drain_timeout")
        await self._wait_for_workers(max(0.1, timeout))

    async def close(self) -> None:
        async with self._condition:
            self._stopping = True
            self._draining = False
            jobs = list(self._jobs.values())
            self._condition.notify_all()
        for job in jobs:
            if job.state in {"queued", "running"}:
                await self.cancel(job.request_id, "broker_stopped")
        await self._wait_for_workers(5)


def _telemetry_headers(job: Job) -> list[tuple[str, str]]:
    wait_ms = max(0.0, job.queue_wait_ms or 0.0)
    return [
        ("Server-Timing", f"queue_wait;dur={wait_ms:.3f}"),
        ("X-Laoji-Queue-Wait-Ms", f"{wait_ms:.3f}"),
        ("X-Laoji-Broker-Priority", job.priority),
        ("X-Laoji-Broker-Request-ID", job.request_id),
        ("X-Request-ID", job.request_id),
    ]


async def _await_or_cancel(awaitable: Awaitable[T], cancel_event: asyncio.Event) -> T:
    operation = asyncio.ensure_future(awaitable)
    cancellation = asyncio.create_task(cancel_event.wait())
    try:
        done, _ = await asyncio.wait(
            {operation, cancellation},
            return_when=asyncio.FIRST_COMPLETED,
        )
        if cancellation in done or cancel_event.is_set():
            raise RequestCancelled
        return operation.result()
    finally:
        if not operation.done():
            operation.cancel()
        if not cancellation.done():
            cancellation.cancel()
        await asyncio.gather(operation, cancellation, return_exceptions=True)


def _upstream_path(base_path: str, path: str) -> str:
    prefix = base_path.rstrip("/")
    return f"{prefix}{path}" if prefix else path


async def _iter_upstream_body(
    reader: asyncio.StreamReader,
    headers: dict[str, str],
    cancel_event: asyncio.Event,
) -> tuple[bool, object]:
    """Return (downstream_chunked, async iterator) for the upstream body."""

    async def chunked_iterator():
        while True:
            line = await _await_or_cancel(reader.readline(), cancel_event)
            if not line:
                raise HttpError(502, "upstream_truncated", "upstream chunk header ended early")
            try:
                size = int(line.split(b";", 1)[0].strip(), 16)
            except ValueError as exc:
                raise HttpError(502, "upstream_invalid_chunk", "invalid upstream chunk size") from exc
            if size == 0:
                while True:
                    trailer = await _await_or_cancel(reader.readline(), cancel_event)
                    if trailer in {b"\r\n", b"\n", b""}:
                        return

            data = await _await_or_cancel(reader.readexactly(size), cancel_event)
            ending = await _await_or_cancel(reader.readexactly(2), cancel_event)
            if ending != b"\r\n":
                raise HttpError(502, "upstream_invalid_chunk", "invalid upstream chunk terminator")
            yield data

    async def length_iterator(length: int):
        remaining = length
        while remaining:
            data = await _await_or_cancel(reader.read(min(64 * 1024, remaining)), cancel_event)
            if not data:
                raise HttpError(502, "upstream_truncated", "upstream response ended early")
            remaining -= len(data)
            yield data

    async def eof_iterator():
        while True:
            data = await _await_or_cancel(reader.read(64 * 1024), cancel_event)
            if not data:
                return
            yield data

    transfer_encoding = headers.get("transfer-encoding", "").lower()
    if "chunked" in transfer_encoding:
        return True, chunked_iterator()
    if "content-length" in headers:
        try:
            length = int(headers["content-length"])
        except ValueError as exc:
            raise HttpError(502, "upstream_invalid_content_length", "invalid upstream Content-Length") from exc
        return False, length_iterator(length)
    return True, eof_iterator()


class OllamaProxy:
    def __init__(self, upstream: str, *, header_timeout: float = 30.0) -> None:
        parsed = urlsplit(validate_upstream(upstream))
        assert parsed.hostname is not None and parsed.port is not None
        self.host = parsed.hostname
        self.port = parsed.port
        self.base_path = parsed.path.rstrip("/")
        self.header_timeout = header_timeout

    async def readiness(self) -> dict[str, object]:
        """Probe the upstream HTTP process without loading or generating a model."""

        writer: asyncio.StreamWriter | None = None
        try:
            reader, writer = await asyncio.wait_for(
                asyncio.open_connection(self.host, self.port),
                timeout=self.header_timeout,
            )
            path = _upstream_path(self.base_path, "/api/version")
            writer.write(
                f"GET {path} HTTP/1.1\r\n"
                f"Host: {self.host}:{self.port}\r\n"
                "Connection: close\r\n\r\n".encode("ascii")
            )
            await asyncio.wait_for(writer.drain(), timeout=self.header_timeout)
            raw_head = await asyncio.wait_for(
                reader.readuntil(b"\r\n\r\n"),
                timeout=self.header_timeout,
            )
            start_line, _ = _parse_headers(raw_head, response=True)
            parts = start_line.split(" ", 2)
            if len(parts) < 2 or not parts[0].startswith("HTTP/"):
                return {
                    "ready": False,
                    "status_code": None,
                    "error": "upstream_invalid_status",
                }
            try:
                status_code = int(parts[1])
            except ValueError:
                return {
                    "ready": False,
                    "status_code": None,
                    "error": "upstream_invalid_status",
                }
            return {
                "ready": status_code == 200,
                "status_code": status_code,
                "error": None if status_code == 200 else "upstream_not_ready",
            }
        except (OSError, asyncio.TimeoutError, asyncio.IncompleteReadError, asyncio.LimitOverrunError):
            return {
                "ready": False,
                "status_code": None,
                "error": "upstream_unavailable",
            }
        finally:
            if writer is not None:
                writer.close()
                try:
                    await writer.wait_closed()
                except (ConnectionError, OSError):
                    pass

    async def __call__(self, job: Job) -> None:
        upstream_writer: asyncio.StreamWriter | None = None
        started = time.monotonic()
        try:
            try:
                upstream_reader, upstream_writer = await asyncio.wait_for(
                    _await_or_cancel(
                        asyncio.open_connection(self.host, self.port),
                        job.cancel_event,
                    ),
                    timeout=self.header_timeout,
                )
                job.upstream_writer = upstream_writer
            except (OSError, asyncio.TimeoutError):
                if not job.client_writer.is_closing():
                    await send_json(
                        job.client_writer,
                        502,
                        {"error": "upstream_unavailable", "request_id": job.request_id},
                        headers=_telemetry_headers(job),
                    )
                job.response_started = True
                raise UpstreamRequestFailed("unavailable")

            request_headers: list[tuple[str, str]] = [
                ("Host", f"{self.host}:{self.port}"),
                ("Connection", "close"),
                ("Content-Length", str(len(job.request.body))),
                ("X-Request-ID", job.request_id),
                ("X-Laoji-Priority", job.priority),
            ]
            for name, value in job.request.headers.items():
                if name in FORWARDED_REQUEST_HEADERS and name != "x-request-id":
                    request_headers.append(("-".join(part.title() for part in name.split("-")), value))
            request_line = f"POST {_upstream_path(self.base_path, job.path)} HTTP/1.1\r\n"
            upstream_writer.write(request_line.encode("ascii"))
            for name, value in request_headers:
                upstream_writer.write(f"{name}: {value}\r\n".encode("iso-8859-1"))
            upstream_writer.write(b"\r\n")
            upstream_writer.write(job.request.body)
            try:
                await _await_or_cancel(upstream_writer.drain(), job.cancel_event)
            except (ConnectionError, OSError) as exc:
                raise HttpError(502, "upstream_write_failed", "upstream request write failed") from exc

            try:
                raw_head = await asyncio.wait_for(
                    _await_or_cancel(upstream_reader.readuntil(b"\r\n\r\n"), job.cancel_event),
                    timeout=self.header_timeout,
                )
            except asyncio.TimeoutError as exc:
                raise HttpError(502, "upstream_header_timeout", "upstream response timed out") from exc
            except asyncio.IncompleteReadError as exc:
                raise HttpError(502, "upstream_truncated", "upstream response ended before headers") from exc
            except asyncio.LimitOverrunError as exc:
                raise HttpError(502, "upstream_headers_too_large", "upstream headers are too large") from exc
            start_line, upstream_items = _parse_headers(raw_head, response=True)
            parts = start_line.split(" ", 2)
            if len(parts) < 2 or not parts[0].startswith("HTTP/"):
                raise HttpError(502, "upstream_invalid_status", "invalid upstream status line")
            try:
                status = int(parts[1])
            except ValueError as exc:
                raise HttpError(502, "upstream_invalid_status", "invalid upstream status code") from exc
            upstream_headers = _headers_dict(upstream_items)
            downstream_chunked, body_iterator = await _iter_upstream_body(
                upstream_reader, upstream_headers, job.cancel_event
            )
            response_headers: list[tuple[str, str]] = []
            for name, value in upstream_items:
                lowered = name.lower()
                if lowered in HOP_BY_HOP_HEADERS or lowered in {
                    "content-length", "server-timing", "x-request-id",
                    "x-laoji-queue-wait-ms", "x-laoji-broker-priority",
                    "x-laoji-broker-request-id",
                }:
                    continue
                response_headers.append((name, value))
            if downstream_chunked:
                response_headers.append(("Transfer-Encoding", "chunked"))
            else:
                response_headers.append(("Content-Length", upstream_headers.get("content-length", "0")))
            upstream_timing = [value for name, value in upstream_items if name.lower() == "server-timing"]
            response_headers.extend(_telemetry_headers(job))
            for value in upstream_timing:
                response_headers.append(("Server-Timing", value))
            response_headers.append(("Connection", "close"))
            upstream_reason = parts[2] if len(parts) == 3 else None
            await send_response_head(
                job.client_writer,
                status,
                response_headers,
                reason=upstream_reason,
            )
            job.response_started = True

            async for data in body_iterator:  # type: ignore[union-attr]
                if job.cancel_event.is_set():
                    raise RequestCancelled
                try:
                    if downstream_chunked:
                        job.client_writer.write(f"{len(data):X}\r\n".encode("ascii"))
                        job.client_writer.write(data)
                        job.client_writer.write(b"\r\n")
                    else:
                        job.client_writer.write(data)
                    await job.client_writer.drain()
                except (BrokenPipeError, ConnectionResetError) as exc:
                    job.cancel_reason = "client_disconnect"
                    job.cancel_event.set()
                    raise ClientDisconnected from exc
            if downstream_chunked:
                job.client_writer.write(b"0\r\n\r\n")
                await job.client_writer.drain()
            _json_log(
                "upstream_complete",
                request_id=job.request_id,
                status=status,
                upstream_elapsed_ms=round((time.monotonic() - started) * 1000, 3),
            )
        except RequestCancelled:
            if not job.response_started and not job.client_writer.is_closing():
                try:
                    await send_json(
                        job.client_writer,
                        499,
                        {
                            "error": job.cancel_reason or "request_cancelled",
                            "request_id": job.request_id,
                        },
                        headers=_telemetry_headers(job),
                    )
                    job.response_started = True
                except (BrokenPipeError, ConnectionResetError):
                    pass
            raise
        except HttpError as exc:
            if not job.response_started and not job.client_writer.is_closing():
                await send_json(
                    job.client_writer,
                    exc.status,
                    {"error": exc.code, "request_id": job.request_id},
                    headers=_telemetry_headers(job),
                )
                job.response_started = True
            elif job.response_started:
                raise
            raise UpstreamRequestFailed(exc.code) from exc
        finally:
            if upstream_writer is not None:
                upstream_writer.close()
                try:
                    await upstream_writer.wait_closed()
                except (ConnectionError, OSError):
                    pass
            job.upstream_writer = None


def resolve_route(path: str, listener_priority: str, header_priority: str | None) -> tuple[str, str]:
    route_priority: str | None = None
    upstream_path = path
    for candidate in PRIORITIES:
        prefix = f"/{candidate}"
        if path == prefix or path.startswith(prefix + "/"):
            route_priority = candidate
            upstream_path = path[len(prefix) :] or "/"
            break
    if upstream_path not in ALLOWED_PATHS:
        raise HttpError(404, "route_not_found", "only Ollama chat and generate routes are supported")
    if header_priority is not None and header_priority not in PRIORITIES:
        raise HttpError(400, "invalid_priority", "X-Laoji-Priority must be interactive or background")
    return upstream_path, header_priority or route_priority or listener_priority


class BrokerApplication:
    def __init__(
        self,
        scheduler: PriorityScheduler,
        proxy: OllamaProxy,
        *,
        max_body_bytes: int,
        header_timeout: float,
    ) -> None:
        self.scheduler = scheduler
        self.proxy = proxy
        self.max_body_bytes = max_body_bytes
        self.header_timeout = header_timeout

    async def handle_connection(
        self,
        reader: asyncio.StreamReader,
        writer: asyncio.StreamWriter,
        listener_priority: str,
    ) -> None:
        job: Job | None = None
        disconnect_task: asyncio.Task[bytes] | None = None
        try:
            request = await read_request(
                reader,
                max_body_bytes=self.max_body_bytes,
                header_timeout=self.header_timeout,
            )
            path = urlsplit(request.target).path
            if path == "/_broker/health" and request.method == "GET":
                await send_json(writer, 200, await self.scheduler.snapshot())
                return
            if path == "/_broker/ready" and request.method == "GET":
                scheduler_snapshot = await self.scheduler.snapshot()
                upstream = await self.proxy.readiness()
                ready = bool(scheduler_snapshot.get("status") == "ok" and upstream.get("ready"))
                body = {
                    "status": "ready" if ready else "not_ready",
                    "scheduler": scheduler_snapshot,
                    "upstream": upstream,
                    # Reachability is not model loading. Provider-specific
                    # readiness must set this field only after its own probe.
                    "model_ready": False,
                }
                if not ready:
                    body["error"] = str(upstream.get("error") or "broker_not_ready")
                    body["message"] = "上游模型服务尚未就绪"
                await send_json(writer, 200 if ready else 503, body)
                return
            cancel_prefix = "/_broker/requests/"
            if path.startswith(cancel_prefix) and request.method == "DELETE":
                request_id = unquote(path[len(cancel_prefix) :])
                if not REQUEST_ID_RE.fullmatch(request_id):
                    raise HttpError(400, "invalid_request_id", "invalid request ID")
                state = await self.scheduler.cancel(request_id, "explicit_cancel")
                if state is None:
                    await send_json(writer, 404, {"error": "request_not_found", "request_id": request_id})
                else:
                    await send_json(writer, 202, {"status": "cancelling", "state": state, "request_id": request_id})
                return
            if request.method != "POST":
                raise HttpError(405, "method_not_allowed", "use POST for Ollama proxy routes")
            upstream_path, priority = resolve_route(
                path,
                listener_priority,
                request.headers.get("x-laoji-priority"),
            )
            if not request.body:
                raise HttpError(400, "empty_body", "Ollama request body is required")
            try:
                payload = json.loads(request.body)
            except (UnicodeDecodeError, json.JSONDecodeError) as exc:
                raise HttpError(400, "invalid_json", "request body must be JSON") from exc
            if not isinstance(payload, dict):
                raise HttpError(400, "invalid_json", "request body must be a JSON object")
            queue_deadline_ms = parse_queue_deadline(
                request.headers.get("x-laoji-queue-deadline-ms")
            )
            supplied_id = request.headers.get("x-request-id", "")
            request_id = supplied_id if REQUEST_ID_RE.fullmatch(supplied_id) else uuid.uuid4().hex
            loop = asyncio.get_running_loop()
            job = Job(
                request_id=request_id,
                priority=priority,
                path=upstream_path,
                request=request,
                client_writer=writer,
                enqueued_at=time.monotonic(),
                completion=loop.create_future(),
                queue_deadline_ms=queue_deadline_ms,
            )
            accepted = await self.scheduler.submit(job)
            if not accepted:
                await send_json(
                    writer,
                    429,
                    {"error": "queue_full", "request_id": request_id},
                    headers=[("Retry-After", "1"), *_telemetry_headers(job)],
                )
                return
            disconnect_task = asyncio.create_task(reader.read(1), name=f"disconnect-{request_id}")
            done, _ = await asyncio.wait(
                {job.completion, disconnect_task},
                return_when=asyncio.FIRST_COMPLETED,
            )
            if disconnect_task in done:
                await self.scheduler.cancel(request_id, "client_disconnect")
                await job.completion
            else:
                disconnect_task.cancel()
                await asyncio.gather(disconnect_task, return_exceptions=True)
                outcome = job.completion.result()
                if job.state == "cancelled" and not job.response_started and not writer.is_closing():
                    job.queue_wait_ms = (time.monotonic() - job.enqueued_at) * 1000
                    status = 408 if outcome == "queue_deadline_exceeded" else 499
                    await send_json(
                        writer,
                        status,
                        {"error": outcome, "request_id": request_id},
                        headers=_telemetry_headers(job),
                    )
                    job.response_started = True
        except ClientDisconnected:
            return
        except HttpError as exc:
            if not writer.is_closing():
                try:
                    await send_json(writer, exc.status, {"error": exc.code, "message": exc.message})
                except (ConnectionError, OSError):
                    pass
        except (BrokenPipeError, ConnectionResetError):
            if job is not None:
                await self.scheduler.cancel(job.request_id, "client_disconnect")
        finally:
            if disconnect_task is not None and not disconnect_task.done():
                disconnect_task.cancel()
            if job is not None:
                await self.scheduler.forget(job.request_id)
            writer.close()
            try:
                await writer.wait_closed()
            except (ConnectionError, OSError):
                pass


class BrokerServer:
    def __init__(
        self,
        listeners: list[ListenerSpec],
        proxy: OllamaProxy,
        *,
        concurrency: int = 1,
        max_active_background: int | None = None,
        max_queue: int = 64,
        background_aging_seconds: float = 15.0,
        max_body_bytes: int = 16 * 1024 * 1024,
        header_timeout: float = 15.0,
    ) -> None:
        if not listeners:
            raise ValueError("at least one listener is required")
        self.listeners = listeners
        self.scheduler = PriorityScheduler(
            proxy,
            concurrency=concurrency,
            max_active_background=max_active_background,
            max_queue=max_queue,
            background_aging_seconds=background_aging_seconds,
        )
        self.application = BrokerApplication(
            self.scheduler,
            proxy,
            max_body_bytes=max_body_bytes,
            header_timeout=header_timeout,
        )
        self.servers: list[asyncio.AbstractServer] = []

    async def start(self) -> list[ListenerSpec]:
        await self.scheduler.start()
        bound: list[ListenerSpec] = []
        for spec in self.listeners:
            server = await asyncio.start_server(
                lambda reader, writer, priority=spec.priority: self.application.handle_connection(
                    reader, writer, priority
                ),
                spec.host,
                spec.port,
                limit=MAX_HEADER_BYTES + 1,
            )
            self.servers.append(server)
            socket = server.sockets[0]
            address = socket.getsockname()
            bound.append(ListenerSpec(spec.host, int(address[1]), spec.priority))
        return bound

    async def serve_forever(self) -> None:
        await asyncio.gather(*(server.serve_forever() for server in self.servers))

    async def close(self) -> None:
        for server in self.servers:
            server.close()
        await self.scheduler.close()
        await asyncio.gather(*(server.wait_closed() for server in self.servers))

    async def drain(self, timeout: float = 5.0) -> None:
        for server in self.servers:
            server.close()
        await self.scheduler.drain(timeout)
        await asyncio.gather(*(server.wait_closed() for server in self.servers))


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--upstream", required=True, type=validate_upstream)
    parser.add_argument(
        "--listen",
        action="append",
        type=parse_listener_spec,
        help="repeatable HOST:PORT=PRIORITY; defaults to isolated 28434/28435",
    )
    parser.add_argument("--concurrency", type=int, default=1)
    parser.add_argument(
        "--max-active-background",
        type=int,
        default=None,
        help="maximum running background requests; defaults to --concurrency",
    )
    parser.add_argument("--max-queue", type=int, default=64)
    parser.add_argument("--background-aging-seconds", type=float, default=15.0)
    parser.add_argument("--max-body-bytes", type=int, default=16 * 1024 * 1024)
    parser.add_argument("--header-timeout", type=float, default=15.0)
    parser.add_argument("--upstream-header-timeout", type=float, default=300.0)
    parser.add_argument("--log-level", default="INFO")
    return parser


async def async_main(args: argparse.Namespace) -> int:
    listeners = args.listen or [
        ListenerSpec("127.0.0.1", 28434, "interactive"),
        ListenerSpec("127.0.0.1", 28435, "background"),
    ]
    if args.concurrency < 1 or args.max_queue < 1:
        raise SystemExit("--concurrency and --max-queue must be positive")
    if (
        args.max_active_background is not None
        and not 1 <= args.max_active_background <= args.concurrency
    ):
        raise SystemExit(
            "--max-active-background must be between 1 and --concurrency"
        )
    if args.header_timeout <= 0 or args.upstream_header_timeout <= 0:
        raise SystemExit("header timeouts must be positive")
    proxy = OllamaProxy(
        args.upstream,
        header_timeout=args.upstream_header_timeout,
    )
    server = BrokerServer(
        listeners,
        proxy,
        concurrency=args.concurrency,
        max_active_background=args.max_active_background,
        max_queue=args.max_queue,
        background_aging_seconds=args.background_aging_seconds,
        max_body_bytes=args.max_body_bytes,
        header_timeout=args.header_timeout,
    )
    bound = await server.start()
    for listener in bound:
        _json_log("listening", host=listener.host, port=listener.port, priority=listener.priority)
    loop = asyncio.get_running_loop()
    stop_event = asyncio.Event()
    for signal_name in ("SIGINT", "SIGTERM"):
        signum = getattr(signal, signal_name, None)
        if signum is None:
            continue
        try:
            loop.add_signal_handler(signum, stop_event.set)
        except (NotImplementedError, RuntimeError):
            pass
    serve_task = asyncio.create_task(server.serve_forever())
    stop_task = asyncio.create_task(stop_event.wait())
    try:
        done, _ = await asyncio.wait({serve_task, stop_task}, return_when=asyncio.FIRST_COMPLETED)
        if serve_task in done:
            await serve_task
    except KeyboardInterrupt:  # Windows event loops may not support signal handlers.
        pass
    finally:
        stop_task.cancel()
        serve_task.cancel()
        await asyncio.gather(stop_task, serve_task, return_exceptions=True)
        await server.drain()
    return 0


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    logging.basicConfig(
        level=getattr(logging, args.log_level.upper(), logging.INFO),
        format="%(asctime)s %(levelname)s %(message)s",
    )
    try:
        return asyncio.run(async_main(args))
    except KeyboardInterrupt:
        return 130


if __name__ == "__main__":
    raise SystemExit(main())
