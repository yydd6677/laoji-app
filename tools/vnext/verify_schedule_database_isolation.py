#!/usr/bin/env python3
"""Fail-closed source and SQLite contract checks for the schedule DB split."""

from __future__ import annotations

import re
import sqlite3
import tempfile
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
SCHEDULE_DB_SOURCE = ROOT / "src/data/db/openScheduleDatabase.ts"
SCHEDULE_REPOSITORY = ROOT / "src/data/repositories/localScheduleRepository.ts"
PROJECTION_REPOSITORY = (
    ROOT / "src/data/repositories/vnext/nativeProjectionCheckpointRepository.ts"
)
ERASE_COORDINATOR = ROOT / "src/services/localDataEraseCoordinator.ts"


def require(condition: bool, message: str) -> None:
    if not condition:
        raise AssertionError(message)


def extract_schedule_schema(source: str) -> str:
    match = re.search(
        r"export const SCHEDULE_DATABASE_SCHEMA_V1_SQL = `(?P<sql>.*?)`;",
        source,
        re.DOTALL,
    )
    require(match is not None, "schedule schema SQL export is missing")
    return match.group("sql").replace(
        "${LEGACY_MEETING_DATABASE_NAME}", "laoji-meeting-memory.db"
    )


def verify_source_boundaries() -> None:
    schedule_source = SCHEDULE_DB_SOURCE.read_text(encoding="utf-8")
    repository_source = SCHEDULE_REPOSITORY.read_text(encoding="utf-8")
    projection_source = PROJECTION_REPOSITORY.read_text(encoding="utf-8")
    erase_source = ERASE_COORDINATOR.read_text(encoding="utf-8")

    require("laoji-schedule.db" in schedule_source, "dedicated schedule DB name is missing")
    require(
        "openScheduleDatabase" in repository_source,
        "schedule repository does not use the dedicated database",
    )
    require(
        "openMeetingDatabase" not in repository_source
        and "withMeetingDatabaseTransaction" not in repository_source,
        "schedule repository still reaches the meeting database",
    )
    require(
        "surfaceKey === CALENDAR_SURFACE_KEY" in projection_source
        and "native_schedule_projection_checkpoints" in projection_source,
        "calendar projection checkpoints are not routed to the schedule database",
    )
    require(
        "deleteMeetingDatabase" in erase_source and "deleteScheduleDatabase" in erase_source,
        "installation-wide erase must name both isolated owners explicitly",
    )
    require(
        "DROP TABLE IF EXISTS local_schedule_events" in schedule_source,
        "legacy schedule table is never retired after verified import",
    )


def verify_sqlite_isolation() -> None:
    source = SCHEDULE_DB_SOURCE.read_text(encoding="utf-8")
    schema = extract_schedule_schema(source)
    with tempfile.TemporaryDirectory(prefix="laoji-schedule-db-") as temp_dir:
        meeting_path = Path(temp_dir) / "laoji-meeting-memory.db"
        schedule_path = Path(temp_dir) / "laoji-schedule.db"

        with sqlite3.connect(meeting_path) as meeting:
            meeting.executescript(
                """
                CREATE TABLE local_schedule_events(
                  id TEXT PRIMARY KEY,
                  source_event_id TEXT,
                  start_date TEXT NOT NULL,
                  end_date TEXT,
                  start_time TEXT,
                  end_time TEXT,
                  title TEXT NOT NULL DEFAULT '',
                  event_json TEXT NOT NULL,
                  event_revision INTEGER NOT NULL DEFAULT 1,
                  draft_source_sha256 TEXT,
                  producer_revision TEXT NOT NULL DEFAULT 'legacy-v1',
                  graph_schema_revision TEXT NOT NULL DEFAULT 'mention-graph-v1',
                  deleted_at_ms INTEGER,
                  created_at_ms INTEGER NOT NULL,
                  updated_at_ms INTEGER NOT NULL
                );
                """
            )
            meeting.execute(
                """INSERT INTO local_schedule_events(
                     id, source_event_id, start_date, title, event_json,
                     event_revision, producer_revision, graph_schema_revision,
                     created_at_ms, updated_at_ms
                   ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                (
                    "event-1",
                    "event-1",
                    "2026-08-24",
                    "项目复盘",
                    '{"id":"event-1","title":"项目复盘","startDate":"2026-08-24"}',
                    3,
                    "schedule-graph-v2",
                    "mention-graph-v1",
                    100,
                    200,
                ),
            )
            legacy_row = meeting.execute(
                "SELECT * FROM local_schedule_events WHERE id = 'event-1'"
            ).fetchone()

        with sqlite3.connect(schedule_path) as schedule:
            schedule.executescript(schema)
            require(
                not schedule.execute("PRAGMA foreign_key_list(local_schedule_events)").fetchall(),
                "schedule events unexpectedly depend on the meeting database",
            )
            schedule.execute(
                """INSERT INTO local_schedule_events(
                     id, source_event_id, start_date, end_date, start_time, end_time,
                     title, event_json, event_revision, draft_source_sha256,
                     producer_revision, graph_schema_revision, deleted_at_ms,
                     created_at_ms, updated_at_ms
                   ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                legacy_row,
            )
            schedule.execute(
                """UPDATE schedule_database_meta
                      SET legacy_source_user_version = 50,
                          legacy_imported_row_count = 1,
                          legacy_import_completed_at_ms = 300
                    WHERE singleton_id = 1"""
            )
            schedule.commit()

        meeting_path.unlink()
        require(not meeting_path.exists(), "meeting fixture was not deleted")

        with sqlite3.connect(schedule_path) as schedule:
            imported = schedule.execute(
                "SELECT title, event_revision FROM local_schedule_events WHERE id = 'event-1'"
            ).fetchone()
            require(imported == ("项目复盘", 3), "meeting DB deletion damaged schedule data")
            schedule.execute(
                """INSERT INTO native_schedule_projection_checkpoints(
                     device_epoch_id, surface_key, entity_id, entity_revision,
                     view_revision, surface_instance_id, payload_sha256, accepted_at_ms
                   ) VALUES (?, 'calendar', ?, 1, 1, ?, ?, ?)""",
                ("epoch-1", "calendar-root", "surface-1", "sha256:" + "a" * 64, 400),
            )
            schedule.commit()
            require(
                schedule.execute("PRAGMA integrity_check").fetchone() == ("ok",),
                "schedule database integrity check failed",
            )


def main() -> int:
    verify_source_boundaries()
    verify_sqlite_isolation()
    print("schedule database isolation verification passed")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
