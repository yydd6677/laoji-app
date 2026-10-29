"""Lease recovery belongs to realtime, not to a readiness read or summary job."""

from __future__ import annotations

import asyncio
import logging

from app.services.vnext_realtime_store import recover_expired_realtime_workers

_task: asyncio.Task | None = None
_logger = logging.getLogger(__name__)


async def _maintain() -> None:
    while True:
        try:
            recovered = await asyncio.to_thread(recover_expired_realtime_workers)
            if recovered:
                _logger.info("realtime executions reconciled: count=%s", recovered)
        except asyncio.CancelledError:
            raise
        except Exception as error:
            _logger.warning("realtime lease recovery deferred: %s", type(error).__name__)
        await asyncio.sleep(30)


def start_realtime_maintenance() -> None:
    global _task
    if _task is None or _task.done():
        _task = asyncio.create_task(_maintain(), name="realtime-lease-recovery")


async def stop_realtime_maintenance() -> None:
    global _task
    task, _task = _task, None
    if task is not None:
        task.cancel()
        try:
            await task
        except asyncio.CancelledError:
            pass
