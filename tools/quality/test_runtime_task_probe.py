import importlib.util
import json
import os
from pathlib import Path
import sqlite3
import sys
from types import SimpleNamespace

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "services" / "laoji-api"))
spec = importlib.util.spec_from_file_location("runtime_task_probe", Path(__file__).with_name("probe_runtime_tasks.py"))
probe = importlib.util.module_from_spec(spec)
spec.loader.exec_module(probe)


@pytest.mark.parametrize("task_state,attempt_state,lease,realtime,expected_idle,expected_safe", [
    ("success", "succeeded", None, False, True, True),
    ("active", "running", 0, False, False, False),
    ("active", "running", 9_999_999_999, False, False, False),
    ("active", "lease_expired", 0, False, False, False),
    ("active", "queued", None, False, False, False),
    ("active", "queued", None, True, False, True),
])
def test_real_store_gate_is_read_only_and_does_not_confuse_expired_with_live(
    tmp_path, monkeypatch, capsys, task_state, attempt_state, lease, realtime, expected_idle, expected_safe,
):
    db = tmp_path / "control.sqlite"
    with sqlite3.connect(db) as c:
        c.executescript("""
          CREATE TABLE vnext_tasks(task_id TEXT,device_id TEXT,epoch_id TEXT,capability TEXT,
             updated_at TEXT,created_at TEXT,current_attempt_id TEXT,source_stream_id TEXT,state TEXT);
          CREATE TABLE vnext_task_attempts(attempt_id TEXT,state TEXT,phase TEXT,lease_expires_at_epoch REAL,lease_owner TEXT);
          CREATE TABLE vnext_realtime_asr_sessions(task_id TEXT,state TEXT,
             worker_admission_expires REAL,expires_at_epoch REAL);
        """)
        c.execute("INSERT INTO vnext_tasks VALUES(?,?,?,?,?,?,?,?,?)",
                  ("task", "device", "epoch", "transcript", "now", "now", "attempt", None, task_state))
        c.execute("INSERT INTO vnext_task_attempts VALUES(?,?,?,?,?)", ("attempt", attempt_state, "admitted", lease, None if realtime else "worker"))
        if realtime:
            c.execute("INSERT INTO vnext_realtime_asr_sessions VALUES(?,?,?,?)", ("task", "reconnecting", None, 9_999_999_999))
    monkeypatch.setitem(sys.modules, "app.config", SimpleNamespace(
        settings=SimpleNamespace(DATABASE_URL=f"sqlite:///{db}")))
    before = db.read_bytes()
    output = tmp_path / "private.json"
    code = probe.main(SimpleNamespace(runtime_pid=os.getpid(), output=output, require_idle=True))
    summary = json.loads(capsys.readouterr().out)
    assert summary["idle"] is expected_idle
    assert summary["maintenance_safe"] is expected_safe
    assert code == (0 if expected_idle else 2)
    assert "task_id" not in summary and "device_id" not in summary
    assert db.read_bytes() == before
    if attempt_state == "running":
        assert summary["counts"]["live_leases"] == int(lease > 0)
        assert summary["counts"]["expired_running_leases"] == int(lease == 0)
