#!/usr/bin/env python3
"""Seed one deterministic, device-local Q2 acceptance fixture from an SRT.

This tool only prepares an offline copy of the Android meeting SQLite database.
It does not access a device, upload content, call a model, or mutate production.
The caller remains responsible for keeping a byte-for-byte backup before
installing the resulting candidate database on a dedicated emulator.
"""

from __future__ import annotations

import argparse
import hashlib
from pathlib import Path
import re
import sqlite3
import time
import unicodedata
import uuid


SRT_TIME = re.compile(
    r"^(?P<sh>\d{2}):(?P<sm>\d{2}):(?P<ss>\d{2})[,.](?P<sms>\d{3})"
    r"\s+-->\s+"
    r"(?P<eh>\d{2}):(?P<em>\d{2}):(?P<es>\d{2})[,.](?P<ems>\d{3})$"
)
FIXTURE_NAMESPACE = uuid.UUID("90413f48-165a-45e5-a08a-5ed39259393b")


def arguments() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--database", type=Path, required=True)
    parser.add_argument("--srt", type=Path, required=True)
    parser.add_argument("--title", required=True)
    parser.add_argument("--manual-note", default="")
    return parser.parse_args()


def timestamp_ms(parts: tuple[str, str, str, str]) -> int:
    hour, minute, second, millis = (int(value) for value in parts)
    return (((hour * 60) + minute) * 60 + second) * 1000 + millis


def parse_srt(path: Path) -> list[tuple[int, int, str]]:
    value = path.read_text(encoding="utf-8-sig")
    entries: list[tuple[int, int, str]] = []
    for block in re.split(r"\r?\n\s*\r?\n", value.strip()):
        lines = [line.strip() for line in block.splitlines() if line.strip()]
        time_index = next((index for index, line in enumerate(lines) if SRT_TIME.match(line)), None)
        if time_index is None or time_index + 1 >= len(lines):
            continue
        match = SRT_TIME.match(lines[time_index])
        assert match is not None
        start_ms = timestamp_ms((match["sh"], match["sm"], match["ss"], match["sms"]))
        end_ms = timestamp_ms((match["eh"], match["em"], match["es"], match["ems"]))
        text = " ".join(lines[time_index + 1:]).strip()
        if text and end_ms >= start_ms:
            entries.append((start_ms, end_ms, text))
    if not entries:
        raise ValueError("SRT does not contain a valid transcript")
    return entries


def sha256(value: bytes) -> str:
    return "sha256:" + hashlib.sha256(value).hexdigest()


def normalize_text(value: str) -> str:
    return unicodedata.normalize("NFC", value).replace("\x00", "").strip()


def ensure_processing_stages(
    connection: sqlite3.Connection,
    meeting_id: str,
    updated_at_ms: int,
) -> None:
    statuses = {
        "capture": "local_ready",
        "upload": "not_required",
        "transcript": "ready",
        "summary": "none",
        "speaker": "none",
    }
    connection.executemany(
        """INSERT INTO processing_stages (
             meeting_id, stage, status, attempt_count, progress, job_id,
             input_fingerprint, error_code, user_message_key, retryable,
             next_retry_at_ms, updated_at_ms
           ) VALUES (?, ?, ?, 0, NULL, NULL, NULL, NULL, NULL, 0, NULL, ?)
           ON CONFLICT(meeting_id, stage) DO UPDATE SET
             status = excluded.status,
             attempt_count = 0,
             progress = NULL,
             job_id = NULL,
             input_fingerprint = NULL,
             error_code = NULL,
             user_message_key = NULL,
             retryable = 0,
             next_retry_at_ms = NULL,
             updated_at_ms = excluded.updated_at_ms""",
        ((meeting_id, stage, status, updated_at_ms) for stage, status in statuses.items()),
    )


def seed(database: Path, srt: Path, title: str, manual_note: str) -> tuple[str, int, int, int]:
    if not database.is_file():
        raise FileNotFoundError(database)
    raw_hash = sha256(srt.read_bytes())
    meeting_id = str(uuid.uuid5(FIXTURE_NAMESPACE, raw_hash))
    revision_id = f"{meeting_id}:transcript:srt-fixture:{raw_hash.removeprefix('sha256:')}"
    entries = parse_srt(srt)
    now_ms = int(time.time() * 1000)
    normalized_note = normalize_text(manual_note)
    with sqlite3.connect(database) as connection:
        connection.execute("PRAGMA foreign_keys=ON")
        existing = connection.execute(
            "SELECT title FROM meeting_notes WHERE id = ?",
            (meeting_id,),
        ).fetchone()
        if existing:
            if existing[0] != title:
                raise RuntimeError("fixture identity is already bound to another title")
            ensure_processing_stages(connection, meeting_id, now_ms)
            count, characters = connection.execute(
                "SELECT COUNT(*), COALESCE(SUM(length(text)), 0) FROM transcript_segments WHERE revision_id = ?",
                (revision_id,),
            ).fetchone()
            quick = connection.execute("PRAGMA quick_check").fetchone()[0]
            foreign_keys = connection.execute("PRAGMA foreign_key_check").fetchall()
            if quick != "ok" or foreign_keys:
                raise RuntimeError(f"fixture database failed integrity checks: {quick}, fk={len(foreign_keys)}")
            return meeting_id, int(count), int(characters), len(normalized_note)
        connection.execute(
            """INSERT INTO meeting_notes (
                 id, scope_key, origin, entry_point, title, lifecycle, ended_at_ms,
                 sync_state, created_at_ms, updated_at_ms, participants_json,
                 mode, client_request_id, recorded_at_ms
               ) VALUES (?, 'guest', 'ad_hoc', 'meeting_tab', ?, 'ended', ?,
                         'local', ?, ?, '[]', 'offline', ?, ?)""",
            (meeting_id, title, now_ms, now_ms, now_ms, meeting_id, now_ms),
        )
        connection.execute(
            """INSERT INTO manual_notes (
                 meeting_id, content, format, revision, dirty, last_saved_at_ms,
                 user_edited_at_ms, active_revision_id
               ) VALUES (?, ?, 'plain', ?, 0, ?, ?, ?)""",
            (
                meeting_id,
                normalized_note,
                1 if normalized_note else 0,
                now_ms,
                now_ms if normalized_note else None,
                f"manual-note:{meeting_id}:1" if normalized_note else None,
            ),
        )
        if normalized_note:
            connection.execute(
                """INSERT INTO manual_note_revisions (
                     revision_id, meeting_id, revision, content, format,
                     content_sha256, migrated_current, created_at_ms
                   ) VALUES (?, ?, 1, ?, 'plain', ?, 0, ?)""",
                (
                    f"manual-note:{meeting_id}:1",
                    meeting_id,
                    normalized_note,
                    sha256(normalized_note.encode("utf-8")),
                    now_ms,
                ),
            )
        connection.execute(
            """INSERT INTO transcript_revisions (
                 id, meeting_id, kind, status, source_provider, source_model,
                 is_active, created_at_ms, finalized_at_ms, remote_id,
                 source_manifest_sha256, text_final_at_ms
               ) VALUES (?, ?, 'final', 'ready', 'acceptance-srt', 'reference-only',
                         1, ?, ?, ?, ?, ?)""",
            (
                revision_id,
                meeting_id,
                now_ms,
                now_ms,
                f"srt-fixture:{raw_hash.removeprefix('sha256:')}",
                raw_hash,
                now_ms,
            ),
        )
        ensure_processing_stages(connection, meeting_id, now_ms)
        for ordinal, (start_ms, end_ms, text) in enumerate(entries):
            normalized = normalize_text(text)
            segment_hash = hashlib.sha256(
                f"{ordinal}:{start_ms}:{end_ms}:{normalized}".encode("utf-8")
            ).hexdigest()
            stable_key = f"srt_{segment_hash[:32]}"
            # The ID shape mirrors a stable Android source identity and
            # intentionally exercises the >180-character wire boundary.
            segment_id = f"{revision_id}:stable-segment:{segment_hash}"
            connection.execute(
                """INSERT INTO transcript_segments (
                     id, revision_id, meeting_id, ordinal, start_ms, end_ms,
                     speaker_label, text, normalized_text, confidence, is_final,
                     created_at_ms, source_segment_id, stable_segment_key,
                     segment_revision, text_state
                   ) VALUES (?, ?, ?, ?, ?, ?, '未知讲话人', ?, ?, 1.0, 1,
                             ?, ?, ?, 1, 'stable')""",
                (
                    segment_id,
                    revision_id,
                    meeting_id,
                    ordinal,
                    start_ms,
                    end_ms,
                    normalized,
                    normalized,
                    now_ms,
                    stable_key,
                    stable_key,
                ),
            )
        quick = connection.execute("PRAGMA quick_check").fetchone()[0]
        foreign_keys = connection.execute("PRAGMA foreign_key_check").fetchall()
        if quick != "ok" or foreign_keys:
            raise RuntimeError(f"fixture database failed integrity checks: {quick}, fk={len(foreign_keys)}")
        characters = sum(len(normalize_text(text)) for _, _, text in entries)
        return meeting_id, len(entries), characters, len(normalized_note)


def main() -> int:
    args = arguments()
    meeting_id, segments, characters, note_chars = seed(
        args.database.resolve(),
        args.srt.resolve(),
        normalize_text(args.title),
        args.manual_note,
    )
    print(f"meeting_id={meeting_id}")
    print(f"segments={segments}")
    print(f"characters={characters}")
    print(f"manual_note_characters={note_chars}")
    print("fixture_kind=reference_srt_not_asr_evidence")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
