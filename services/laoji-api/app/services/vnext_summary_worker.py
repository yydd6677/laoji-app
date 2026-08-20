"""Durable single-concurrency worker for vNext source-stream summaries.

This worker is deliberately behind ``LAOJI_VNEXT_SUMMARY_SOURCE_STREAM_ENABLED``.
It owns no domain data and processes at most one immutable chapter per turn,
so realtime ASR and interactive requests can be given priority by deployment
policy.  Every turn claims a generic task lease and can be reconstructed from
SQLite after process death.
"""

from __future__ import annotations

import asyncio
import itertools
import json
import logging
import os
import socket
from dataclasses import dataclass
from typing import Any, Callable

from app.runtime_policy import env_enabled
from app.services import vnext_summary_chapter_pipeline, vnext_summary_runtime, vnext_task_store
from app.services.vnext_source_stream_store import VNextSourceStreamError


_logger = logging.getLogger(__name__)
LEASE_SECONDS = 30
HEARTBEAT_SECONDS = 10
SCAN_SECONDS = max(1.0, min(30.0, float(os.getenv("LAOJI_VNEXT_SUMMARY_SCAN_SECONDS", "2"))))
HANDLER_REVISION = vnext_summary_runtime.HANDLER_REVISION
PROVIDER_REVISION = vnext_summary_runtime.PROVIDER_ADAPTER_REVISION


def _safe_generation_failure(error: Exception) -> tuple[str, dict[str, Any]] | None:
    """Expose only the generator's already-sanitized protocol diagnostics."""
    error_type = type(error)
    if (
        error_type.__name__ != "SummaryV3GenerationError"
        or error_type.__module__ != "app.services.summary_v3_generator"
    ):
        return None
    code = str(getattr(error, "code", "") or "")
    if not code.startswith("SUMMARY_") or len(code) > 120:
        code = "SUMMARY_V3_GENERATION_FAILED"
    raw_details = getattr(error, "details", {})
    details = raw_details if isinstance(raw_details, dict) else {}
    # SummaryV3GenerationError only stores field paths/error kinds. Serializing
    # through JSON and bounding the result prevents an accidental future type
    # change from placing source/model text in logs.
    try:
        encoded = json.dumps(details, ensure_ascii=True, sort_keys=True)
    except (TypeError, ValueError):
        encoded = "{}"
    if len(encoded) > 4_096:
        encoded = "{}"
    return code, json.loads(encoded)


def summary_source_stream_enabled() -> bool:
    return env_enabled("LAOJI_VNEXT_SUMMARY_SOURCE_STREAM_ENABLED", False)


@dataclass(frozen=True)
class SummaryTaskOwner:
    device_id: str
    epoch_id: str


class VNextSummarySourceStreamWorker:
    def __init__(
        self,
        *,
        process_chapter: Callable[..., dict[str, Any]] = vnext_summary_chapter_pipeline.process_next_summary_chapter,
        scan_seconds: float = SCAN_SECONDS,
    ) -> None:
        self.process_chapter = process_chapter
        self.scan_seconds = scan_seconds
        self._task: asyncio.Task | None = None
        self._closed = False
        self._sequence = itertools.count()
        self._queued: set[str] = set()
        self._queue: asyncio.PriorityQueue[tuple[int, int, str, str, str]] = asyncio.PriorityQueue(maxsize=32)
        self._lease_owner = f"summary-source:{socket.gethostname()}:{os.getpid()}"

    def start(self) -> None:
        if not summary_source_stream_enabled():
            return
        if self._task is None or self._task.done():
            self._closed = False
            self._task = asyncio.create_task(self._run(), name="vnext-summary-source-stream")

    async def stop(self) -> None:
        self._closed = True
        if self._task is not None:
            self._task.cancel()
            try:
                await self._task
            except asyncio.CancelledError:
                pass
        self._task = None
        self._queued.clear()

    def notify(self, item: dict[str, str]) -> None:
        task_id = str(item["task_id"])
        if task_id in self._queued:
            return
        try:
            self._queue.put_nowait((10, next(self._sequence), str(item["device_id"]), str(item["epoch_id"]), task_id))
        except asyncio.QueueFull:
            return
        self._queued.add(task_id)

    async def _scan(self) -> None:
        rows = await asyncio.to_thread(vnext_task_store.pending_source_stream_tasks, 32)
        for row in rows:
            self.notify(row)

    async def _maintain(self) -> None:
        while not self._closed:
            try:
                await self._scan()
            except asyncio.CancelledError:
                raise
            except Exception as error:
                _logger.warning("vnext summary scan failed: %s", type(error).__name__)
            await asyncio.sleep(self.scan_seconds)

    async def _run(self) -> None:
        maintenance = asyncio.create_task(self._maintain(), name="vnext-summary-source-maintenance")
        try:
            while not self._closed:
                _priority, _sequence, device_id, epoch_id, task_id = await self._queue.get()
                self._queued.discard(task_id)
                try:
                    await self._process(SummaryTaskOwner(device_id, epoch_id), task_id)
                except asyncio.CancelledError:
                    raise
                except Exception as error:
                    _logger.warning("vnext summary worker item failed: %s", type(error).__name__)
                finally:
                    self._queue.task_done()
        finally:
            maintenance.cancel()
            try:
                await maintenance
            except asyncio.CancelledError:
                pass

    async def _process(self, context: SummaryTaskOwner, task_id: str) -> None:
        task = await asyncio.to_thread(vnext_task_store.get_task, context, task_id)
        if task is None or task.get("state") != "active" or not task.get("source_stream_id"):
            return
        attempt = await asyncio.to_thread(
            vnext_task_store.claim_attempt,
            context,
            task_id,
            lease_owner=self._lease_owner,
            lease_seconds=LEASE_SECONDS,
        )
        if attempt is None:
            return
        attempt_id = str(attempt["attempt_id"])
        heartbeat_failed = asyncio.Event()

        async def heartbeat() -> None:
            while True:
                await asyncio.sleep(HEARTBEAT_SECONDS)
                refreshed = await asyncio.to_thread(
                    vnext_task_store.claim_attempt,
                    context,
                    task_id,
                    lease_owner=self._lease_owner,
                    lease_seconds=LEASE_SECONDS,
                )
                if refreshed is None or str(refreshed["attempt_id"]) != attempt_id:
                    heartbeat_failed.set()
                    return

        heartbeat_task = asyncio.create_task(heartbeat(), name=f"vnext-summary-heartbeat:{task_id}")
        try:
            runtime_revision = vnext_summary_runtime.current_summary_runtime_revision()
            result = await asyncio.to_thread(
                self.process_chapter,
                context,
                task_id,
                attempt_id=attempt_id,
                lease_owner=self._lease_owner,
                handler_revision=runtime_revision.handler_revision,
                provider_revision=runtime_revision.provider_revision,
                prompt_revision=runtime_revision.prompt_revision,
                model_revision=runtime_revision.model_revision,
                generate_verified_chapter=vnext_summary_chapter_pipeline.generate_verified_summary_chapter,
            )
            if heartbeat_failed.is_set():
                raise VNextSourceStreamError("TASK_LEASE_LOST", "任务执行权已失效", 409)
            # Awaiting source or a committed chapter is intentionally left
            # active; the next scan will resume it without creating a task.
            if result.get("state") in {"awaiting_source", "chapter_committed"}:
                return
        except asyncio.CancelledError:
            raise
        except VNextSourceStreamError as error:
            retryable = error.code not in {
                "CHECKPOINT_INVALID",
                "CHECKPOINT_POINTER_INVALID",
                "CHECKPOINT_HASH_MISMATCH",
                "SUMMARY_RUNTIME_REVISION_CHANGED",
                "SUMMARY_RUNTIME_REVISION_MISSING",
            }
            await asyncio.to_thread(
                vnext_task_store.mark_failure,
                context,
                task_id,
                attempt_id,
                error.code,
                retryable=retryable,
                retry_after_seconds=5 if retryable else 0,
                lease_owner=self._lease_owner,
            )
        except Exception as error:
            generation_failure = _safe_generation_failure(error)
            error_code = (
                generation_failure[0]
                if generation_failure is not None
                else f"SUMMARY_{type(error).__name__.upper()[:80]}"
            )
            if generation_failure is not None:
                _logger.warning(
                    "vnext summary generation rejected: code=%s details=%s",
                    generation_failure[0],
                    json.dumps(
                        generation_failure[1],
                        ensure_ascii=True,
                        sort_keys=True,
                        separators=(",", ":"),
                    ),
                )
            await asyncio.to_thread(
                vnext_task_store.mark_failure,
                context,
                task_id,
                attempt_id,
                error_code,
                # Generation already contains the sole schema-repair call.
                # Retrying the same immutable package at temperature zero
                # would exceed the per-operation model-call contract and can
                # loop forever without new evidence or user intent.
                retryable=generation_failure is None,
                retry_after_seconds=30 if generation_failure is None else 0,
                lease_owner=self._lease_owner,
            )
        finally:
            heartbeat_task.cancel()
            try:
                await heartbeat_task
            except asyncio.CancelledError:
                pass


_worker: VNextSummarySourceStreamWorker | None = None


def get_summary_source_stream_worker() -> VNextSummarySourceStreamWorker:
    global _worker
    if _worker is None:
        _worker = VNextSummarySourceStreamWorker()
    return _worker


def start_summary_source_stream_worker() -> None:
    if summary_source_stream_enabled():
        get_summary_source_stream_worker().start()


async def stop_summary_source_stream_worker() -> None:
    if _worker is not None:
        await _worker.stop()
