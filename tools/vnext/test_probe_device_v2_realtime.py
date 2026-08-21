from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))

from probe_device_v2_realtime import (
    configure_source_ip,
    encode_chunk,
    pacing_delay_seconds,
    percentile,
    wait_speaker_overlay,
)
import probe_device_v2_realtime


def test_probe_timeline_uses_whole_milliseconds() -> None:
    pcm = (b"\x00\x00" * 16_000) + b"\x00" * 14
    trimmed = pcm[: len(pcm) - (len(pcm) % 32)]
    assert len(trimmed) == 32_000


def test_encode_chunk_matches_pcm_timeline() -> None:
    pcm = b"\x00\x00" * 16_000
    frame = encode_chunk(3, pcm, 2_000)
    assert frame[:4] == b"LJPC"
    assert frame[4] == 2
    assert len(frame) == 7 + int.from_bytes(frame[5:7], "big") + len(pcm)


def test_realtime_pacing_never_sleeps_after_the_source_clock() -> None:
    assert pacing_delay_seconds(
        audio_started_monotonic=10.0,
        source_end_ms=1_000,
        now_monotonic=10.25,
    ) == 0.75
    assert pacing_delay_seconds(
        audio_started_monotonic=10.0,
        source_end_ms=1_000,
        now_monotonic=11.5,
    ) == 0.0


def test_realtime_lag_percentile_is_interpolated() -> None:
    assert percentile([100.0, 200.0, 300.0, 400.0], 0.95) == 385.0
    assert percentile([], 0.95) is None


def test_missing_source_ip_does_not_become_hostname_none() -> None:
    configure_source_ip(None)
    assert probe_device_v2_realtime._PROBE_SOURCE_IP is None


def test_source_ip_wrapper_remains_compatible_with_python310_socket(monkeypatch) -> None:
    captured = {}

    def python310_create_connection(address, timeout=None, source_address=None):
        captured.update(
            address=address,
            timeout=timeout,
            source_address=source_address,
        )
        return "connected"

    monkeypatch.setattr(
        probe_device_v2_realtime.socket,
        "create_connection",
        python310_create_connection,
    )
    configure_source_ip("127.0.0.51")

    assert probe_device_v2_realtime.socket.create_connection(
        ("127.0.0.1", 18028), timeout=3,
    ) == "connected"
    assert captured == {
        "address": ("127.0.0.1", 18028),
        "timeout": 3,
        "source_address": ("127.0.0.51", 0),
    }


def test_speaker_overlay_wait_reports_metadata_only(monkeypatch) -> None:
    responses = iter([
        (200, {"state": "running", "overlay": None}),
        (200, {
            "state": "succeeded",
            "overlay": {
                "model_revision": "campplus-zh-test",
                "assignments": [{"automatic_label": "must-not-be-copied"}],
            },
        }),
    ])
    clock = iter([10.0, 10.0, 10.1, 10.2])
    monkeypatch.setattr(probe_device_v2_realtime, "json_request", lambda *_args, **_kwargs: next(responses))
    monkeypatch.setattr(probe_device_v2_realtime.time, "monotonic", lambda: next(clock))
    monkeypatch.setattr(probe_device_v2_realtime.time, "sleep", lambda _seconds: None)

    result = wait_speaker_overlay(
        "http://127.0.0.1:18030/api/device/v2",
        {"Authorization": "redacted"},
        "session-redacted",
        transcript_completed_monotonic=10.0,
    )

    assert result == {
        "state": "succeeded",
        "latency_ms": 200.0,
        "assignment_count": 1,
        "model_revision": "campplus-zh-test",
    }
    assert "must-not-be-copied" not in str(result)
