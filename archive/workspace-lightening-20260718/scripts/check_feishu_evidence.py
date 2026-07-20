#!/usr/bin/env python3
"""Validate the source-evidence registry, implementation references, and parity ledger."""

from __future__ import annotations

import argparse
import re
from pathlib import Path


EVIDENCE_ID_RE = re.compile(r"`((?:CAL|MIN|UI)-[A-Z0-9-]+-\d{3})`")
CODE_EVIDENCE_ID_RE = re.compile(r"\b((?:CAL|MIN|UI)-[A-Z0-9-]+-\d{3})\b")
LEDGER_ROW_RE = re.compile(
    r"^\|\s*`(?P<id>(?:CAL|MIN|UI)-[A-Z0-9-]+-\d{3})`\s*\|"
    r"(?P<body>.+?)\|\s*(?P<status>未审阅|已取证|复审中|已实现|已关闭)\s*\|",
    re.MULTILINE,
)


def section(text: str, start: str, end: str | None = None) -> str:
    start_index = text.find(start)
    if start_index < 0:
        raise ValueError(f"missing section: {start}")
    content_start = start_index + len(start)
    if end is None:
        return text[content_start:]
    end_index = text.find(end, content_start)
    if end_index < 0:
        raise ValueError(f"missing section: {end}")
    return text[content_start:end_index]


IMPLEMENTATION_ROOTS = (
    "modules/laoji-native-platform",
    "src/native",
    "src/navigation/MainTabs.android.tsx",
    "src/components/AppActionSheet.android.tsx",
    "src/components/AppDialog.android.tsx",
    "src/components/VoiceInputModal.android.tsx",
    "src/screens/AddEventScreen.android.tsx",
    "src/screens/EventDetailScreen.android.tsx",
    "src/screens/MeetingListScreen.android.tsx",
    "src/screens/MeetingLiveScreen.android.tsx",
    "src/screens/ScheduleScreen.android.tsx",
    "src/screens/SpeakerEnrollmentScreen.android.tsx",
    "src/screens/SpeakerManagerScreen.android.tsx",
    "src/screens/TranscriptionScreen.android.tsx",
)
IMPLEMENTATION_SUFFIXES = {".js", ".kt", ".ts", ".tsx"}


def implementation_files(root: Path):
    for relative in IMPLEMENTATION_ROOTS:
        target = root / relative
        if target.is_file():
            yield target
        elif target.is_dir():
            yield from (
                path for path in target.rglob("*")
                if path.is_file() and path.suffix in IMPLEMENTATION_SUFFIXES
            )


def validate(
    source_map: Path,
    ledger: Path,
    require_closed: bool = False,
    implementation_root: Path | None = None,
) -> list[str]:
    errors: list[str] = []
    source_text = source_map.read_text(encoding="utf-8")
    ledger_text = ledger.read_text(encoding="utf-8")
    registry_text = section(source_text, "## 源码闭包", "## 关闭规则")
    registered = set(EVIDENCE_ID_RE.findall(registry_text))
    if not registered:
        errors.append("source map has no registered evidence IDs")

    rows = list(LEDGER_ROW_RE.finditer(ledger_text))
    if not rows:
        errors.append("parity ledger has no sentinel rows")
    for row in rows:
        evidence_id = row.group("id")
        status = row.group("status")
        if evidence_id not in registered:
            errors.append(f"ledger references undefined evidence ID: {evidence_id}")
        if require_closed and status != "已关闭":
            errors.append(f"evidence is not closed: {evidence_id} ({status})")

    if implementation_root is not None:
        for path in implementation_files(implementation_root):
            text = path.read_text(encoding="utf-8", errors="replace")
            for evidence_id in CODE_EVIDENCE_ID_RE.findall(text):
                if evidence_id not in registered:
                    relative = path.relative_to(implementation_root).as_posix()
                    errors.append(f"implementation references undefined evidence ID: {evidence_id} ({relative})")

    return sorted(set(errors))


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--source-map",
        type=Path,
        default=Path("docs/feishu-source-map.md"),
    )
    parser.add_argument(
        "--ledger",
        type=Path,
        default=Path("docs/feishu-parity-ledger.md"),
    )
    parser.add_argument("--require-closed", action="store_true")
    parser.add_argument("--implementation-root", type=Path, default=Path("."))
    args = parser.parse_args()

    errors = validate(
        args.source_map,
        args.ledger,
        args.require_closed,
        args.implementation_root,
    )
    if errors:
        for error in errors:
            print(f"ERROR: {error}")
        return 1
    print("Feishu evidence registry is consistent.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
