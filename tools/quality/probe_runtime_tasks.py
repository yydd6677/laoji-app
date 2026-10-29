"""Read-only generic-task maintenance gate, independent of legacy readiness.

Run inside the active API environment. No source text or device credentials
are emitted. Optional private output includes opaque recovery identities.
"""
import argparse
import json
import os
from pathlib import Path
import sqlite3
import time


def main(args):
    env = Path(f"/proc/{args.runtime_pid}/environ").read_text().split("\0")
    os.environ.update(dict(item.split("=", 1) for item in env if "=" in item))
    from app.config import settings
    from sqlalchemy.engine import make_url
    url = make_url(settings.DATABASE_URL)
    if not url.drivername.startswith("sqlite") or not url.database:
        raise RuntimeError("expected_sqlite_control_store")
    path = Path(url.database).expanduser().resolve()
    from app.services.vnext_task_health import read_task_runtime
    with sqlite3.connect(path.as_uri() + "?mode=ro", uri=True, timeout=5) as connection:
        connection.row_factory = sqlite3.Row
        connection.execute("PRAGMA query_only=ON")
        connection.execute("BEGIN")
        runtime = read_task_runtime(connection)
    tasks = runtime.pop("active_tasks")
    counts = {"active_tasks": len(tasks), "live_leases": runtime["active_leases"],
              "expired_running_leases": runtime["expired_leases"], **runtime["counts"]}
    idle = not tasks and not counts["live_leases"] and not counts["expired_running_leases"]
    # Explicitly separate a completely idle store from durable, detached
    # sessions. Never silently weaken --require-idle to mean safe-to-restart.
    maintenance_safe = not any(counts[key] for key in
        ("queued", "running", "live_leases", "expired_running_leases"))
    if args.output:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(json.dumps({"at_epoch": time.time(), "counts": counts,
            "idle": idle, "maintenance_safe": maintenance_safe, "active_tasks": tasks}, ensure_ascii=False, indent=2))
        args.output.chmod(0o600)
    print(json.dumps({"counts": counts, "idle": idle, "maintenance_safe": maintenance_safe}))
    return 2 if (args.require_idle and not idle or
        getattr(args, "require_maintenance_safe", False) and not maintenance_safe) else 0


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--runtime-pid", type=int, required=True)
    parser.add_argument("--output", type=Path)
    parser.add_argument("--require-idle", action="store_true")
    parser.add_argument("--require-maintenance-safe", action="store_true")
    raise SystemExit(main(parser.parse_args()))
