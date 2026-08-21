from __future__ import annotations

import struct

import pytest

import pulse_pipe_microphone
from pulse_pipe_microphone import PulsePipeMicrophone


def test_prime_route_uses_bounded_alternating_signal_and_settle(monkeypatch) -> None:
    microphone = PulsePipeMicrophone("laoji_test_source")
    observed: dict[str, object] = {}

    def fake_play(pcm: bytes, *, timeout: float | None = None) -> None:
        observed["pcm"] = pcm
        observed["timeout"] = timeout

    monkeypatch.setattr(microphone, "_play_pcm", fake_play)
    monkeypatch.setattr(
        pulse_pipe_microphone.time,
        "sleep",
        lambda seconds: observed.setdefault("settle", seconds),
    )

    microphone.prime_route(signal_seconds=0.2, settle_seconds=0.4)

    pcm = observed["pcm"]
    assert isinstance(pcm, bytes)
    assert len(pcm) == 48_000 * 2 // 5
    assert struct.unpack("<hhhh", pcm[:8]) == (4_096, -4_096, 4_096, -4_096)
    assert observed["timeout"] == pytest.approx(5.2)
    assert observed["settle"] == pytest.approx(0.4)


@pytest.mark.parametrize(
    ("signal_seconds", "settle_seconds"),
    ((0.09, 0.4), (2.01, 0.4), (0.2, 0.19), (0.2, 3.01)),
)
def test_prime_route_rejects_unbounded_durations(
    signal_seconds: float,
    settle_seconds: float,
) -> None:
    microphone = PulsePipeMicrophone("laoji_test_source")

    with pytest.raises(ValueError):
        microphone.prime_route(
            signal_seconds=signal_seconds,
            settle_seconds=settle_seconds,
        )


def test_source_name_must_be_a_pulse_identifier() -> None:
    with pytest.raises(ValueError):
        PulsePipeMicrophone("not a source")
