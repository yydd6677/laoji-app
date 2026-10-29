import asyncio
import importlib.util
import json
from pathlib import Path
import threading
import time
from types import SimpleNamespace

import pytest

spec = importlib.util.spec_from_file_location('profile_question_api', Path(__file__).with_name('profile_question_api.py'))
profile = importlib.util.module_from_spec(spec)
spec.loader.exec_module(profile)


def trace():
    return {'started': time.perf_counter(), 'events': [], 'lock': threading.Lock()}


def test_instrument_preserves_results_and_exceptions_without_body_or_headers():
    def run(body):
        if body == 'sensitive-error': raise ValueError('original-error')
        return body
    owner = SimpleNamespace(__name__='safe.owner', run=run)
    original = profile.instrument(owner, 'run')
    assert original is run and owner.run.__name__ == 'run'
    assert owner.run('outside-request') == 'outside-request'
    current = trace()
    token = profile._TRACE.set(current)
    try:
        assert owner.run('sensitive-body') == 'sensitive-body'
        with pytest.raises(ValueError, match='original-error'): owner.run('sensitive-error')
    finally:
        profile._TRACE.reset(token)
    encoded = json.dumps(current['events'])
    assert 'sensitive' not in encoded and 'original-error' not in encoded
    assert len(current['events']) == 2
    assert all(set(row) == {'phase','start_ms','wall_ms'} for row in current['events'])


def test_concurrent_requests_keep_their_own_thread_metrics():
    owner = SimpleNamespace(__name__='safe.owner', run=lambda: time.sleep(.002))
    profile.instrument(owner, 'run')
    async def request(count):
        current = trace()
        token = profile._TRACE.set(current)
        try:
            for _ in range(count): await asyncio.to_thread(owner.run)
        finally:
            profile._TRACE.reset(token)
        return current['events']
    async def exercise(): return await asyncio.gather(request(2), request(3))
    first, second = asyncio.run(exercise())
    assert len(first) == 2 and len(second) == 3
    assert profile._TRACE.get() is None
