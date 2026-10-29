import asyncio

import pytest

from app.services import vnext_realtime_maintenance as maintenance


@pytest.mark.asyncio
async def test_recovery_loop_is_single_owner_and_stops(monkeypatch):
    calls = []
    done = asyncio.Event()
    loop = asyncio.get_running_loop()

    def recover():
        calls.append(1)
        loop.call_soon_threadsafe(done.set)
        return 0

    monkeypatch.setattr(maintenance, "recover_expired_realtime_workers", recover)
    maintenance.start_realtime_maintenance()
    task = maintenance._task
    maintenance.start_realtime_maintenance()
    assert maintenance._task is task
    await asyncio.wait_for(done.wait(), 2)
    await maintenance.stop_realtime_maintenance()
    assert maintenance._task is None and task.done() and len(calls) == 1
