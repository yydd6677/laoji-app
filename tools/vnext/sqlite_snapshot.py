#!/usr/bin/env python3
"""Portable SQLite snapshot and restore utility for the vNext Stage 0 gate.

The tool uses SQLite's online backup API rather than shell-only ``cp`` or
``sqlite3`` commands.  It is safe to use on Linux and Windows and never
touches a running production database unless the caller explicitly supplies
that path.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import sqlite3
import sys
import tempfile
from pathlib import Path


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def _integrity(path: Path) -> str:
    with sqlite3.connect(path) as connection:
        result = connection.execute("PRAGMA integrity_check").fetchone()
    return str(result[0]) if result else "missing-result"


def _backup(source: Path, destination: Path) -> None:
    if not source.is_file():
        raise FileNotFoundError(source)
    destination.parent.mkdir(parents=True, exist_ok=True)
    temporary: Path | None = None
    try:
        with tempfile.NamedTemporaryFile(
            prefix=f".{destination.name}.",
            suffix=".tmp",
            dir=destination.parent,
            delete=False,
        ) as handle:
            temporary = Path(handle.name)
        with sqlite3.connect(f"file:{source}?mode=ro", uri=True) as source_db:
            with sqlite3.connect(temporary) as destination_db:
                source_db.backup(destination_db)
                destination_db.execute("PRAGMA journal_mode=DELETE")
                destination_db.commit()
        os.replace(temporary, destination)
        temporary = None
    finally:
        if temporary is not None:
            temporary.unlink(missing_ok=True)


def _metadata(path: Path) -> dict[str, object]:
    with sqlite3.connect(path) as connection:
        tables = [row[0] for row in connection.execute(
            "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
        )]
    return {
        "path": str(path),
        "bytes": path.stat().st_size,
        "sha256": _sha256(path),
        "integrity": _integrity(path),
        "tables": tables,
    }


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    subparsers = parser.add_subparsers(dest="command", required=True)

    backup = subparsers.add_parser("backup", help="create a consistent SQLite backup")
    backup.add_argument("source", type=Path)
    backup.add_argument("destination", type=Path)

    restore = subparsers.add_parser("restore", help="restore a snapshot atomically")
    restore.add_argument("snapshot", type=Path)
    restore.add_argument("destination", type=Path)

    inspect = subparsers.add_parser("inspect", help="print snapshot metadata")
    inspect.add_argument("database", type=Path)

    args = parser.parse_args(argv)
    if args.command == "backup":
        _backup(args.source, args.destination)
        result = _metadata(args.destination)
    elif args.command == "restore":
        _backup(args.snapshot, args.destination)
        result = _metadata(args.destination)
    else:
        result = _metadata(args.database)
    if result["integrity"] != "ok":
        print(json.dumps(result, ensure_ascii=False, sort_keys=True))
        return 1
    print(json.dumps(result, ensure_ascii=False, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
