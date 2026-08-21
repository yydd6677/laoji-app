from __future__ import annotations

from pathlib import Path

from verify_runtime_privacy_log import scan


def test_scan_rejects_protocol_path_and_payload_key(tmp_path: Path) -> None:
    path = tmp_path / "runtime.log"
    path.write_text(
        "INFO: WebSocket /api/device/v2/realtime/raw-session [accepted]\n"
        '{"event":"unsafe","meeting_id":"raw-meeting"}\n',
        encoding="utf-8",
    )

    assert scan(path) == [
        {"line": 1, "reason": "raw_api_protocol_path"},
        {"line": 2, "reason": "forbidden_json_key=meeting_id"},
    ]


def test_scan_accepts_bounded_operational_telemetry(tmp_path: Path) -> None:
    path = tmp_path / "runtime.log"
    path.write_text(
        '[12:34:56.789] [#00001] {"event":"service_stage","bytes":512,"status":"ok"}\n'
        "INFO: Application startup complete.\n"
        "INFO: connection open\n",
        encoding="utf-8",
    )

    assert scan(path) == []
