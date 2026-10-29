from concurrent.futures import ThreadPoolExecutor
import sqlite3
import time

import pytest

from app.config import settings
from app.services import device_identity


def test_schema_initialization_is_singleflight_and_not_a_per_frame_write(tmp_path, monkeypatch):
    monkeypatch.setattr(settings, 'DATABASE_URL', f'sqlite:///{tmp_path / "control.db"}')
    calls = []

    @device_identity.control_schema_once
    def initialize():
        time.sleep(.005)
        calls.append(True)

    with ThreadPoolExecutor(max_workers=8) as pool:
        list(pool.map(lambda _: initialize(), range(40)))
    assert len(calls) == 1
    initialize()
    assert len(calls) == 1


def test_schema_failure_retries_instead_of_poisoning_cache(tmp_path, monkeypatch):
    monkeypatch.setattr(settings, 'DATABASE_URL', f'sqlite:///{tmp_path / "control.db"}')
    calls = []

    @device_identity.control_schema_once
    def initialize():
        calls.append(True)
        if len(calls) == 1:
            raise RuntimeError('failed migration')

    with pytest.raises(RuntimeError):
        initialize()
    initialize()
    initialize()
    assert len(calls) == 2


def test_schema_reinitializes_after_database_switch_replace_or_explicit_reset(tmp_path, monkeypatch):
    first, second = tmp_path / 'first.db', tmp_path / 'second.db'
    calls = []

    @device_identity.control_schema_once
    def initialize():
        with device_identity.control_connection() as connection:
            connection.execute('CREATE TABLE IF NOT EXISTS slice_schema (id TEXT PRIMARY KEY)')
        calls.append(True)

    monkeypatch.setattr(settings, 'DATABASE_URL', f'sqlite:///{first}')
    initialize()
    monkeypatch.setattr(settings, 'DATABASE_URL', f'sqlite:///{second}')
    initialize()
    monkeypatch.setattr(settings, 'DATABASE_URL', f'sqlite:///{first}')
    initialize()
    assert len(calls) == 2
    replacement = tmp_path / 'replacement.db'
    with sqlite3.connect(replacement) as connection:
        connection.execute('CREATE TABLE replacement_marker (id TEXT)')
    replacement.replace(first)
    initialize()
    with sqlite3.connect(first) as connection:
        assert connection.execute("SELECT name FROM sqlite_master WHERE name='slice_schema'").fetchone()
    device_identity._SCHEMA_READY.clear()
    initialize()
    assert len(calls) == 4
