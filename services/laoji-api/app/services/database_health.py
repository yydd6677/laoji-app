"""Privacy-safe integrity state for LaoJi's three SQLite databases."""

from __future__ import annotations

import os
from pathlib import Path
import sqlite3
import threading
import time

from sqlalchemy.engine import make_url

from app.config import settings
from app.services.speaker_db_service import get_speaker_db


_LOCK = threading.Lock()
_CACHED_AT = 0.0
_CACHED: dict | None = None


def _main_path() -> Path:
    url = make_url(settings.DATABASE_URL)
    if not url.drivername.startswith("sqlite") or not url.database:
        raise RuntimeError("main_database_not_sqlite")
    return Path(url.database).expanduser().resolve()


def _schedule_path() -> Path:
    configured = os.getenv("LAOJI_DB_PATH", "").strip()
    if configured:
        return Path(configured).expanduser().resolve()
    return Path(__file__).resolve().parents[2] / "data" / "schedule.db"


def _inspect(path: Path) -> dict:
    if not path.is_file():
        return {
            "exists": False,
            "integrity": "missing",
            "foreign_key_violations": None,
            "journal_mode": None,
        }
    try:
        connection = sqlite3.connect(f"file:{path}?mode=ro", uri=True, timeout=5)
        try:
            connection.execute("PRAGMA busy_timeout=5000")
            integrity = str(connection.execute("PRAGMA quick_check").fetchone()[0])
            violations = len(connection.execute("PRAGMA foreign_key_check").fetchall())
            journal_mode = str(connection.execute("PRAGMA journal_mode").fetchone()[0]).lower()
        finally:
            connection.close()
        return {
            "exists": True,
            "integrity": integrity,
            "foreign_key_violations": violations,
            "journal_mode": journal_mode,
        }
    except sqlite3.Error:
        return {
            "exists": True,
            "integrity": "error",
            "foreign_key_violations": None,
            "journal_mode": None,
        }


def database_health(*, refresh: bool = False) -> dict:
    global _CACHED_AT, _CACHED
    now = time.monotonic()
    with _LOCK:
        if not refresh and _CACHED is not None and now - _CACHED_AT < 30:
            return _CACHED
        databases = {
            "main": _inspect(_main_path()),
            "schedule": _inspect(_schedule_path()),
            "speaker": _inspect(Path(get_speaker_db().db_path).resolve()),
        }
        ready = all(
            item["exists"]
            and item["integrity"] == "ok"
            and item["foreign_key_violations"] == 0
            and item["journal_mode"] == "wal"
            for item in databases.values()
        )
        _CACHED = {"ready": ready, "databases": databases}
        _CACHED_AT = now
        return _CACHED


def reset_database_health_cache_for_tests() -> None:
    global _CACHED_AT, _CACHED
    with _LOCK:
        _CACHED_AT = 0.0
        _CACHED = None
