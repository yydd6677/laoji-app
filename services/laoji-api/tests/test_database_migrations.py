from __future__ import annotations

import sqlite3

from app.config import settings
from app.services import database_health, database_migrations


def test_orphan_summaries_are_archived_without_losing_content(tmp_path, monkeypatch):
    database = tmp_path / "meeting.db"
    with sqlite3.connect(database) as connection:
        connection.executescript(
            """
            PRAGMA foreign_keys=OFF;
            CREATE TABLE meetings (id TEXT PRIMARY KEY);
            CREATE TABLE final_summaries (
                id TEXT PRIMARY KEY,
                meeting_id TEXT NOT NULL REFERENCES meetings(id),
                overview TEXT NOT NULL,
                key_decisions_json TEXT NOT NULL,
                action_items_json TEXT NOT NULL,
                generated_at TEXT
            );
            INSERT INTO meetings(id) VALUES ('existing');
            INSERT INTO final_summaries VALUES (
                'keep', 'existing', '保留', '[]', '[]', '2026-08-05T00:00:00'
            );
            INSERT INTO final_summaries VALUES (
                'orphan', 'missing', '孤儿内容', '["决定"]', '["行动"]',
                '2026-08-05T00:00:00'
            );
            """
        )
    monkeypatch.setattr(settings, "DATABASE_URL", f"sqlite+aiosqlite:///{database}")

    assert database_migrations.archive_orphan_final_summaries() == 1
    assert database_migrations.archive_orphan_final_summaries() == 0

    with sqlite3.connect(database) as connection:
        assert connection.execute("SELECT id FROM final_summaries").fetchall() == [("keep",)]
        archived = connection.execute(
            "SELECT id, meeting_id, overview, key_decisions_json, action_items_json "
            "FROM legacy_orphan_final_summaries_v1"
        ).fetchone()
        violations = connection.execute("PRAGMA foreign_key_check").fetchall()
    assert archived == ("orphan", "missing", "孤儿内容", '["决定"]', '["行动"]')
    assert violations == []


def test_database_health_requires_wal_and_zero_foreign_key_violations(tmp_path):
    database = tmp_path / "healthy.db"
    with sqlite3.connect(database) as connection:
        connection.execute("PRAGMA journal_mode=WAL")
        connection.execute("CREATE TABLE parent(id INTEGER PRIMARY KEY)")
        connection.execute(
            "CREATE TABLE child(id INTEGER PRIMARY KEY, parent_id INTEGER REFERENCES parent(id))"
        )
        connection.commit()
    observed = database_health._inspect(database)
    assert observed == {
        "exists": True,
        "integrity": "ok",
        "foreign_key_violations": 0,
        "journal_mode": "wal",
    }
