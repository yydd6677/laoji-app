from __future__ import annotations

import hashlib
import threading

import numpy as np

from app.services import compact_transcription_service as compact


class FakeManager:
    device = "cpu"

    def create_vad_model(self):
        return None

    def get_camp_model(self):
        return None


class FakeClient:
    model = "fake-qwen-asr"
    model_revision = "revision-1"

    def __init__(self):
        self.batches: list[list[str]] = []

    def ready(self):
        return {
            "ready": True,
            "model": self.model,
            "model_revision": self.model_revision,
        }

    def transcribe(self, segments, _language):
        self.batches.append([segment.segment_id for segment in segments])
        return {
            segment.segment_id: {
                "id": segment.segment_id,
                "text": f"會議內容{segment.ordinal}",
                "language": "Chinese",
                "model_revision": self.model_revision,
                "queue_ms": 1,
                "infer_ms": 2,
            }
            for segment in segments
        }


def _segments(count: int):
    return [
        compact.SpeechAudio(
            ordinal=index,
            segment_id=f"seg_{index:032d}",
            start_ms=index * 2000,
            end_ms=index * 2000 + 1500,
            audio=np.full(24_000, 0.01, dtype=np.float32),
        )
        for index in range(count)
    ]


def _long_segments(count: int):
    return [
        compact.SpeechAudio(
            ordinal=index,
            segment_id=f"long_{index:032d}",
            start_ms=index * 7000,
            end_ms=index * 7000 + 6000,
            audio=np.full(96_000, 0.01, dtype=np.float32),
        )
        for index in range(count)
    ]


def test_segment_checkpoints_resume_without_repeating_asr(tmp_path, monkeypatch):
    source = tmp_path / "meeting.mp4"
    source.write_bytes(b"immutable-source")
    monkeypatch.setattr(compact.settings, "AUDIO_STORAGE_PATH", str(tmp_path / "audio"))
    monkeypatch.setattr(compact, "ASR_OFFLINE_BATCH_MAX_AUDIO_MS", 12_000)
    monkeypatch.setattr(compact, "_probe_duration_ms", lambda _source: 21_000)
    monkeypatch.setattr(compact, "_load_registered_profiles", lambda _owner: [])
    first_client = FakeClient()

    first = compact.transcribe_recording_asset(
        source_path=str(source),
        source_sha256=hashlib.sha256(source.read_bytes()).hexdigest(),
        job_id="job-checkpoint-1",
        owner_user_id=7,
        language="zh",
        model_manager=FakeManager(),
        client=first_client,
        segment_iterator=lambda: iter(_segments(10)),
    )

    assert [len(batch) for batch in first_client.batches] == [8, 2]
    assert len(first.turns) == 10
    assert first.turns[0]["text"] == "会议内容0"
    assert source.read_bytes() == b"immutable-source"
    second_client = FakeClient()

    second = compact.transcribe_recording_asset(
        source_path=str(source),
        source_sha256=hashlib.sha256(source.read_bytes()).hexdigest(),
        job_id="job-checkpoint-1",
        owner_user_id=7,
        language="zh",
        model_manager=FakeManager(),
        client=second_client,
        segment_iterator=lambda: iter(_segments(10)),
    )

    assert second_client.batches == []
    assert second.turns == first.turns


def test_offline_batches_yield_between_bounded_audio_slices(tmp_path, monkeypatch):
    source = tmp_path / "meeting.mp4"
    source.write_bytes(b"immutable-source")
    monkeypatch.setattr(compact.settings, "AUDIO_STORAGE_PATH", str(tmp_path / "audio"))
    monkeypatch.setattr(compact, "ASR_OFFLINE_BATCH_MAX_AUDIO_MS", 4_000)
    monkeypatch.setattr(compact, "_probe_duration_ms", lambda _source: 42_000)
    monkeypatch.setattr(compact, "_load_registered_profiles", lambda _owner: [])
    client = FakeClient()

    result = compact.transcribe_recording_asset(
        source_path=str(source),
        source_sha256=hashlib.sha256(source.read_bytes()).hexdigest(),
        job_id="job-bounded-slices-1",
        owner_user_id=7,
        language="zh",
        model_manager=FakeManager(),
        client=client,
        segment_iterator=lambda: iter(_long_segments(6)),
    )

    assert [len(batch) for batch in client.batches] == [1, 1, 1, 1, 1, 1]
    assert len(result.turns) == 6


def test_campplus_overlaps_batched_asr_without_delaying_first_batch(tmp_path, monkeypatch):
    source = tmp_path / "meeting.mp4"
    source.write_bytes(b"immutable-source")
    monkeypatch.setattr(compact.settings, "AUDIO_STORAGE_PATH", str(tmp_path / "audio"))
    monkeypatch.setattr(compact, "ASR_OFFLINE_BATCH_MAX_AUDIO_MS", 12_000)
    monkeypatch.setattr(compact, "SPEAKER_PIPELINE_MAX_PENDING", 8)
    monkeypatch.setattr(compact, "_probe_duration_ms", lambda _source: 4_000)
    monkeypatch.setattr(compact, "_load_registered_profiles", lambda _owner: [])
    extraction_started = threading.Event()
    release_extraction = threading.Event()
    extraction_finished = threading.Event()

    class FakeExtractor:
        def __init__(self, _model, device):
            assert device == "cpu"

        def extract(self, _audio):
            extraction_started.set()
            assert release_extraction.wait(2)
            extraction_finished.set()
            return np.array([1.0, 0.0], dtype=np.float32)

    class SpeakerManager(FakeManager):
        def get_camp_model(self):
            return object()

    class ObservingClient(FakeClient):
        def transcribe(self, segments, language):
            assert extraction_started.wait(2)
            assert not extraction_finished.is_set()
            release_extraction.set()
            return super().transcribe(segments, language)

    monkeypatch.setattr(compact, "SpeakerEmbeddingExtractor", FakeExtractor)
    client = ObservingClient()
    result = compact.transcribe_recording_asset(
        source_path=str(source),
        source_sha256=hashlib.sha256(source.read_bytes()).hexdigest(),
        job_id="job-overlap-1",
        owner_user_id=7,
        language="zh",
        model_manager=SpeakerManager(),
        client=client,
        segment_iterator=lambda: iter(_segments(2)),
    )

    assert [len(batch) for batch in client.batches] == [2]
    assert extraction_finished.is_set()
    assert len(result.turns) == 2


def test_registered_name_requires_two_conservative_votes():
    enrolled = np.array([1.0, 0.0], dtype=np.float32)
    profiles = [{"speaker_id": "known", "name": "张三", "embedding": enrolled}]
    records = [
        compact.TranscriptRecord(
            segment_id=f"segment-{index}",
            start_ms=index * 2000,
            end_ms=index * 2000 + 1500,
            text="测试",
            language="Chinese",
            embedding=np.array([0.99, 0.01], dtype=np.float32),
        )
        for index in range(2)
    ]

    compact._assign_speakers(records, profiles)

    assert [record.speaker_id for record in records] == ["known", "known"]
    assert [record.speaker_label for record in records] == ["张三", "张三"]

    one_vote = [
        compact.TranscriptRecord(
            segment_id="single",
            start_ms=0,
            end_ms=1500,
            text="单段",
            language="Chinese",
            embedding=np.array([1.0, 0.0], dtype=np.float32),
        )
    ]
    compact._assign_speakers(one_vote, profiles)
    assert one_vote[0].speaker_id == "anonymous_1"
    assert one_vote[0].speaker_label == "发言人 1"


def test_embedding_after_unvoiced_cluster_does_not_compare_with_none():
    records = [
        compact.TranscriptRecord(
            segment_id="without-embedding",
            start_ms=0,
            end_ms=900,
            text="短句",
            language="Chinese",
            embedding=None,
        ),
        compact.TranscriptRecord(
            segment_id="with-embedding",
            start_ms=3000,
            end_ms=4700,
            text="有效语音",
            language="Chinese",
            embedding=np.array([1.0, 0.0], dtype=np.float32),
        ),
    ]

    compact._assign_speakers(records, [])

    assert records[0].speaker_id == "anonymous_1"
    assert records[1].speaker_id == "anonymous_2"


def test_only_overlapping_boundary_text_is_trimmed():
    records = [
        compact.TranscriptRecord(
            segment_id="left",
            start_ms=0,
            end_ms=2000,
            text="今天讨论项目进度",
            language="Chinese",
            embedding=None,
        ),
        compact.TranscriptRecord(
            segment_id="right",
            start_ms=1800,
            end_ms=4000,
            text="项目进度和交付风险",
            language="Chinese",
            embedding=None,
        ),
        compact.TranscriptRecord(
            segment_id="later",
            start_ms=5000,
            end_ms=6000,
            text="交付风险",
            language="Chinese",
            embedding=None,
        ),
    ]

    output = compact._deduplicate_overlaps(records)

    assert [record.text for record in output] == [
        "今天讨论项目进度",
        "和交付风险",
        "交付风险",
    ]
