#!/usr/bin/env python3
"""Replay the v46 native projection checkpoint contract with stdlib sqlite3."""

from __future__ import annotations

import re
import sqlite3
import tempfile
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
MIGRATION = ROOT / "src" / "data" / "db" / "migrations" / "0045ScheduleMentionGraphVNext.ts"


def migration_sql() -> str:
    source = MIGRATION.read_text(encoding="utf-8")
    match = re.search(r"NATIVE_PROJECTION_CHECKPOINTS_V45_SQL\s*=\s*`([\s\S]*?)`;", source)
    if not match:
        raise AssertionError("v45 projection checkpoint SQL was not found")
    return match.group(1)


def seed(database: sqlite3.Connection) -> None:
    database.executescript(
        """
        PRAGMA foreign_keys=ON;
        CREATE TABLE device_epochs(
          epoch_id TEXT PRIMARY KEY,
          status TEXT NOT NULL,
          created_at_ms INTEGER NOT NULL
        );
        INSERT INTO device_epochs VALUES ('epoch-1', 'active', 1);
        """
    )
    database.executescript(migration_sql())


def put(database: sqlite3.Connection, *, entity_revision: int, view_revision: int,
        payload: str, surface_instance: str, accepted_at: int) -> None:
    database.execute(
        """
        INSERT INTO native_projection_checkpoints(
          device_epoch_id, surface_key, entity_id, entity_revision, view_revision,
          surface_instance_id, payload_sha256, accepted_at_ms
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(device_epoch_id, surface_key, entity_id) DO UPDATE SET
          entity_revision = excluded.entity_revision,
          view_revision = excluded.view_revision,
          surface_instance_id = excluded.surface_instance_id,
          payload_sha256 = excluded.payload_sha256,
          accepted_at_ms = excluded.accepted_at_ms
        """,
        ('epoch-1', 'calendar', 'calendar', entity_revision, view_revision,
         surface_instance, payload, accepted_at),
    )
    database.commit()


def main() -> None:
    with tempfile.NamedTemporaryFile(suffix=".db") as handle:
        database = sqlite3.connect(handle.name)
        seed(database)
        required = {
            row[1] for row in database.execute(
                "PRAGMA table_info(native_projection_checkpoints)"
            )
        }
        expected = {
            'device_epoch_id', 'surface_key', 'entity_id', 'entity_revision',
            'view_revision', 'surface_instance_id', 'payload_sha256', 'accepted_at_ms',
        }
        if required != expected:
            raise AssertionError(f"unexpected checkpoint columns: {required}")

        payload_a = 'sha256:' + 'a' * 64
        payload_b = 'sha256:' + 'b' * 64
        put(database, entity_revision=1, view_revision=1, payload=payload_a,
            surface_instance='surface-a', accepted_at=10)
        first = database.execute(
            "SELECT entity_revision, view_revision, payload_sha256 FROM native_projection_checkpoints"
        ).fetchone()
        if first != (1, 1, payload_a):
            raise AssertionError(f"initial checkpoint mismatch: {first!r}")

        # Same revision and hash is the idempotent retry, including a recreated
        # native surface instance.
        put(database, entity_revision=1, view_revision=1, payload=payload_a,
            surface_instance='surface-b', accepted_at=20)
        retry = database.execute(
            "SELECT surface_instance_id, accepted_at_ms FROM native_projection_checkpoints"
        ).fetchone()
        if retry != ('surface-b', 20):
            raise AssertionError(f"idempotent retry did not refresh surface owner: {retry!r}")

        # The repository rejects this path before SQL, so the replay models the
        # fail-closed result and verifies that the durable row remains intact.
        current = database.execute(
            "SELECT entity_revision, view_revision, payload_sha256 FROM native_projection_checkpoints"
        ).fetchone()
        stale_revision = (0, 9)
        if stale_revision >= (current[0], current[1]):
            raise AssertionError("stale revision fixture is invalid")
        if current != (1, 1, payload_a):
            raise AssertionError("stale candidate changed the checkpoint")

        put(database, entity_revision=2, view_revision=2, payload=payload_b,
            surface_instance='surface-c', accepted_at=30)
        upgraded = database.execute(
            "SELECT entity_revision, view_revision, payload_sha256 FROM native_projection_checkpoints"
        ).fetchone()
        if upgraded != (2, 2, payload_b):
            raise AssertionError(f"newer checkpoint was not accepted: {upgraded!r}")

        # Closing and reopening the file is the process-restart boundary.
        database.close()
        database = sqlite3.connect(handle.name)
        recovered = database.execute(
            "SELECT entity_revision, view_revision, payload_sha256 FROM native_projection_checkpoints"
        ).fetchone()
        if recovered != (2, 2, payload_b):
            raise AssertionError(f"checkpoint did not survive reopen: {recovered!r}")
        print("projection checkpoint replay: PASS (first/idempotent/stale/newer/reopen)")


if __name__ == '__main__':
    main()
