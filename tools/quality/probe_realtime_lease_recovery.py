"""Replay the domain recovery against a private SQLite copy by default.

--apply is an explicit owner-level maintenance action, never a SQL state patch.
The report contains counts/hashes only, not text, opaque IDs or credentials.
"""

import argparse
import hashlib
import json
import os
from pathlib import Path
import sqlite3


def fingerprint(connection, query):
    digest = hashlib.sha256()
    rows = connection.execute(query).fetchall()
    for row in rows:
        for value in row:
            encoded = value if isinstance(value, bytes) else repr(value).encode()
            digest.update(len(encoded).to_bytes(8, "big"))
            digest.update(encoded)
    return {"rows": len(rows), "sha256": digest.hexdigest()}


def invariants(path):
    with sqlite3.connect(path.as_uri() + "?mode=ro", uri=True) as c:
        return {
            "chunks": fingerprint(c, "SELECT * FROM vnext_realtime_chunk_checkpoints ORDER BY session_id,chunk_seq"),
            "events": fingerprint(c, "SELECT * FROM vnext_realtime_event_ledger ORDER BY session_id,event_seq"),
            "task_sources_and_results": fingerprint(c,
                "SELECT task_id,device_id,epoch_id,binding_id,binding_generation,capability,"
                "entity_id,entity_revision,input_sha256,generation_id,current_attempt_id,"
                "result_kind,result_json FROM vnext_tasks ORDER BY task_id"),
            "session_sources": fingerprint(c,
                "SELECT session_id,task_id,device_id,epoch_id,binding_id,binding_generation,"
                "binding_revision,cancel_revision,asset_id,asset_generation,request_sha256,"
                "last_contiguous_chunk_seq,last_durable_event_seq,payload_released_at,"
                "opened_at,last_seen_at,expires_at_epoch FROM vnext_realtime_asr_sessions ORDER BY session_id"),
        }


def main(args):
    env = Path(f"/proc/{args.runtime_pid}/environ").read_bytes().split(b"\0")
    os.environ.update({k.decode(): v.decode() for row in env if b"=" in row for k, v in [row.split(b"=", 1)]})
    from app.config import settings
    from sqlalchemy.engine import make_url
    source = Path(make_url(settings.DATABASE_URL).database).resolve()
    if args.apply:
        target = source
    else:
        target = args.database_copy.resolve()
        if target == source or target.exists():
            raise RuntimeError("fresh_private_database_copy_required")
        target.parent.mkdir(parents=True, exist_ok=True)
        with sqlite3.connect(source.as_uri() + "?mode=ro", uri=True) as src, sqlite3.connect(target) as dst:
            src.backup(dst)
        target.chmod(0o600)
        settings.DATABASE_URL = f"sqlite+aiosqlite:///{target}"
    from app.services.vnext_realtime_store import recover_expired_realtime_workers
    def task_states():
        with sqlite3.connect(target.as_uri() + "?mode=ro", uri=True) as c:
            c.row_factory = sqlite3.Row
            return {r["task_id"]: dict(r) for r in c.execute("SELECT * FROM vnext_tasks")}
    states_before = task_states()
    before = invariants(target)
    recovered = recover_expired_realtime_workers()
    after = invariants(target)
    if before != after:
        raise RuntimeError("realtime_recovery_source_invariant_changed")
    states_after = task_states()
    expired = 0
    for key, old in states_before.items():
        new = states_after[key]
        changed = {field for field in old if old[field] != new[field]}
        if changed:
            assert changed <= {"state", "error_code", "updated_at", "terminal_at"}
            assert old["state"] == "active" and new["state"] == "failure"
            assert new["error_code"] == "REALTIME_SESSION_EXPIRED"
            expired += 1
    if not args.apply:
        assert recover_expired_realtime_workers() == 0
    report = {"boundary": "production owner recovery" if args.apply else "isolated real-control-db replay",
              "reconciled_executions": recovered, "expired_sessions": expired,
              "source_cursors_results_unchanged": True, "invariants": after}
    args.output.write_text(json.dumps(report, indent=2) + "\n")
    args.output.chmod(0o600)
    print(json.dumps({k: v for k, v in report.items() if k != "invariants"}))


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--runtime-pid", type=int, required=True)
    parser.add_argument("--database-copy", type=Path)
    parser.add_argument("--apply", action="store_true")
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    if not args.apply and args.database_copy is None:
        parser.error("isolated copy path required")
    main(args)
