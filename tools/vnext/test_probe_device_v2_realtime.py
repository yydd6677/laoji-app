from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))

from probe_device_v2_realtime import encode_chunk


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
