from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))

from probe_device_v2_realtime import (
    configure_source_ip,
    encode_chunk,
    pacing_delay_seconds,
    percentile,
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
