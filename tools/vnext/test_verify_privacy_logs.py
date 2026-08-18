from __future__ import annotations

import json
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).parent))

from verify_privacy_logs import scan


def test_scan_rejects_user_identifier_in_print(tmp_path: Path) -> None:
    source = tmp_path / "unsafe.py"
    source.write_text("print(f'meeting={meeting_id}')\n", encoding="utf-8")
    findings = scan(tmp_path)
    assert len(findings) == 1
    assert "meeting_id" in str(findings[0]["reason"])


def test_scan_accepts_bounded_operational_fields(tmp_path: Path) -> None:
    source = tmp_path / "safe.py"
    source.write_text(
        "print(json.dumps({'event': 'stage', 'bytes': size, 'status': 'ok'}))\n",
        encoding="utf-8",
    )
    assert scan(tmp_path) == []
