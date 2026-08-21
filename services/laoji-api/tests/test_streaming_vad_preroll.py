import numpy as np

from app.asr.streaming_vad import StreamingVAD, VAD_WINDOW_SIZE


def _window(value: float) -> np.ndarray:
    return np.full(VAD_WINDOW_SIZE, value, dtype=np.float32)


def test_vad_pre_roll_preserves_audio_before_first_detected_speech():
    vad = StreamingVAD(None)
    vad.set_min_energy_threshold(0.5)
    vad.set_pre_roll_duration(VAD_WINDOW_SIZE * 2 * 1000 / vad.sample_rate)
    vad.min_speech_samples = VAD_WINDOW_SIZE
    vad.min_silence_samples = VAD_WINDOW_SIZE

    assert vad.feed(_window(0.1)) is None
    assert vad.feed(_window(0.2)) is None
    assert vad.feed(_window(1.0)) is None
    segment = vad.feed(_window(0.0))

    assert segment is not None
    assert segment.start_ms == 0
    assert len(segment.audio_data) == VAD_WINDOW_SIZE * 4
    np.testing.assert_allclose(segment.audio_data[:VAD_WINDOW_SIZE], 0.1)
    np.testing.assert_allclose(
        segment.audio_data[VAD_WINDOW_SIZE:VAD_WINDOW_SIZE * 2],
        0.2,
    )


def test_vad_without_pre_roll_keeps_existing_start_behavior():
    vad = StreamingVAD(None)
    vad.set_min_energy_threshold(0.5)
    vad.min_speech_samples = VAD_WINDOW_SIZE
    vad.min_silence_samples = VAD_WINDOW_SIZE

    assert vad.feed(_window(0.1)) is None
    assert vad.feed(_window(0.2)) is None
    assert vad.feed(_window(1.0)) is None
    segment = vad.feed(_window(0.0))

    assert segment is not None
    assert segment.start_ms == 64
    assert len(segment.audio_data) == VAD_WINDOW_SIZE * 2
    np.testing.assert_allclose(segment.audio_data[:VAD_WINDOW_SIZE], 1.0)


def test_vad_duration_limits_exclude_pre_roll_and_trailing_silence():
    vad = StreamingVAD(None)
    vad.set_min_energy_threshold(0.5)
    vad.set_pre_roll_duration(VAD_WINDOW_SIZE * 2 * 1000 / vad.sample_rate)
    vad.set_max_speech_duration(VAD_WINDOW_SIZE * 2 * 1000 / vad.sample_rate)
    vad.min_speech_samples = VAD_WINDOW_SIZE
    vad.min_silence_samples = VAD_WINDOW_SIZE * 4

    assert vad.feed(_window(0.1)) is None
    assert vad.feed(_window(0.2)) is None
    assert vad.feed(_window(1.0)) is None
    segment = vad.feed(_window(1.0))

    assert segment is not None
    assert len(segment.audio_data) == VAD_WINDOW_SIZE * 4


def test_vad_reset_clears_audio_but_preserves_pre_roll_configuration():
    vad = StreamingVAD(None)
    vad.set_pre_roll_duration(400, initial_duration_ms=200)
    vad.feed(_window(0.0))

    vad.reset()

    assert vad.pre_roll_samples == 6400
    assert vad.initial_pre_roll_samples == 3200
    assert vad._seen_speech is False
    assert vad._pre_roll_buffer == []


def test_vad_can_use_shorter_context_before_the_first_speech():
    vad = StreamingVAD(None)
    vad.set_min_energy_threshold(0.5)
    vad.set_pre_roll_duration(
        VAD_WINDOW_SIZE * 2 * 1000 / vad.sample_rate,
        initial_duration_ms=VAD_WINDOW_SIZE * 1000 / vad.sample_rate,
    )
    vad.min_speech_samples = VAD_WINDOW_SIZE
    vad.min_silence_samples = VAD_WINDOW_SIZE

    assert vad.feed(_window(0.1)) is None
    assert vad.feed(_window(0.2)) is None
    assert vad.feed(_window(1.0)) is None
    segment = vad.feed(_window(0.0))

    assert segment is not None
    assert segment.start_ms == 32
    assert len(segment.audio_data) == VAD_WINDOW_SIZE * 3
    np.testing.assert_allclose(segment.audio_data[:VAD_WINDOW_SIZE], 0.2)
    assert vad._active_pre_roll_samples() == VAD_WINDOW_SIZE * 2


def test_vad_configurable_silence_duration_controls_segment_latency():
    vad = StreamingVAD(None)
    vad.set_min_energy_threshold(0.5)
    vad.set_min_silence_duration(VAD_WINDOW_SIZE * 2 * 1000 / vad.sample_rate)
    vad.min_speech_samples = VAD_WINDOW_SIZE

    assert vad.feed(_window(1.0)) is None
    assert vad.feed(_window(0.0)) is None
    segment = vad.feed(_window(0.0))

    assert segment is not None
    assert vad.min_silence_samples == VAD_WINDOW_SIZE * 2


def test_vad_active_snapshot_is_read_only_and_excludes_pre_roll_from_duration():
    vad = StreamingVAD(None)
    vad.set_min_energy_threshold(0.5)
    vad.set_pre_roll_duration(VAD_WINDOW_SIZE * 2 * 1000 / vad.sample_rate)

    assert vad.feed(_window(0.1)) is None
    assert vad.feed(_window(0.2)) is None
    assert vad.feed(_window(1.0)) is None

    assert vad.active_speech_window() == (0, 32)
    preview = vad.snapshot_active_speech()

    assert preview is not None
    assert preview.segment_reason == "preview"
    assert preview.start_ms == 0
    assert preview.end_ms == 96
    assert len(preview.audio_data) == VAD_WINDOW_SIZE * 3
    assert vad.state == "speech"
    assert len(vad.speech_buffer) == 3

    preview.audio_data[:] = 0.0
    np.testing.assert_allclose(vad.speech_buffer[-1], 1.0)
