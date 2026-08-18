"""Recoverable long-audio transcription using the shared Qwen3-ASR service.

The source media remains immutable.  ffmpeg streams mono 16 kHz PCM through
Silero VAD, so no whole-file WAV is created.  ASR checkpoints are committed per
speech segment before the final transcript can replace an older asset result.
"""

from __future__ import annotations

import base64
from collections import Counter
from concurrent.futures import Future, ThreadPoolExecutor
from dataclasses import dataclass
import hashlib
import json
import math
import os
from pathlib import Path
import re
import shutil
import subprocess
import threading
from typing import Callable, Iterable, Iterator
import urllib.error
import urllib.parse
import urllib.request
import uuid

import numpy as np

from app.asr.model_manager import ModelManager, SpeakerEmbeddingExtractor
from app.asr.streaming_vad import StreamingVAD
from app.config import settings
from app.services.speaker_db_service import bytes_to_ndarray, get_speaker_db
from app.privacy_logging import privacy_log


SAMPLE_RATE = 16_000
ASR_BATCH_LIMIT = 8
ASR_OFFLINE_SEGMENT_MAX_AUDIO_MS = max(
    1_000,
    min(
        120_000,
        int(os.getenv("LAOJI_ASR_OFFLINE_SEGMENT_MAX_AUDIO_MS", "4000")),
    ),
)
ASR_OFFLINE_BATCH_MAX_AUDIO_MS = max(
    ASR_OFFLINE_SEGMENT_MAX_AUDIO_MS,
    min(
        120_000,
        int(os.getenv("LAOJI_ASR_OFFLINE_BATCH_MAX_AUDIO_MS", "12000")),
    ),
)
SPEAKER_PIPELINE_MAX_PENDING = max(
    1,
    min(32, int(os.getenv("LAOJI_SPEAKER_PIPELINE_MAX_PENDING", "8"))),
)
MIN_SPEAKER_AUDIO_MS = 1_200
SPEAKER_COSINE_THRESHOLD = 0.70
SPEAKER_GAP_THRESHOLD = 0.08
SPEAKER_MINIMUM_VOTES = 2
ANONYMOUS_CLUSTER_THRESHOLD = 0.50
PIPELINE_SCHEMA_VERSION = 1
_SHA256_RE = re.compile(r"^(?:sha256:)?([0-9a-f]{64})$")
_ITEM_ID_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$")
_OPENCC_LOCK = threading.Lock()
_OPENCC_CONVERTER = None


@dataclass(frozen=True)
class SpeechAudio:
    ordinal: int
    segment_id: str
    start_ms: int
    end_ms: int
    audio: np.ndarray


@dataclass
class TranscriptRecord:
    segment_id: str
    start_ms: int
    end_ms: int
    text: str
    language: str | None
    embedding: np.ndarray | None
    ordinal: int = 0
    speaker_id: str = "unknown"
    speaker_label: str = "未识别讲话人"
    confidence: float = 0.0


@dataclass(frozen=True)
class CompactTranscriptionResult:
    model: str
    model_revision: str
    source_duration_ms: int
    turns: list[dict]
    checkpoint_dir: str


class CompactTranscriptionError(RuntimeError):
    pass


def cleanup_checkpoint_dir(path: str | Path) -> bool:
    """Remove one completed checkpoint tree without allowing path escape."""
    root = Path(path)
    checkpoint_root = (Path(settings.audio_storage_abs_path) / ".transcription-checkpoints").resolve()
    try:
        resolved = root.resolve()
        resolved.relative_to(checkpoint_root)
    except (OSError, ValueError):
        return False
    if resolved == checkpoint_root or not resolved.is_dir():
        return False
    shutil.rmtree(resolved)
    for parent in (resolved.parent, resolved.parent.parent):
        if parent != checkpoint_root and parent.is_dir():
            try:
                parent.rmdir()
            except OSError:
                pass
    return True


def _canonical_bytes(value: object) -> bytes:
    return json.dumps(
        value,
        ensure_ascii=True,
        separators=(",", ":"),
        sort_keys=True,
    ).encode("utf-8")


def _payload_sha256(value: object) -> str:
    return hashlib.sha256(_canonical_bytes(value)).hexdigest()


def _fsync_directory(path: Path) -> None:
    try:
        descriptor = os.open(path, os.O_RDONLY | getattr(os, "O_DIRECTORY", 0))
    except OSError:
        return
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


def _atomic_json(path: Path, payload: object) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(f".{path.name}.{uuid.uuid4().hex}.partial")
    with temporary.open("w", encoding="utf-8") as stream:
        json.dump(payload, stream, ensure_ascii=False, separators=(",", ":"), sort_keys=True)
        stream.write("\n")
        stream.flush()
        os.fsync(stream.fileno())
    os.replace(temporary, path)
    _fsync_directory(path.parent)


def _normalized_source_sha256(value: str) -> str:
    match = _SHA256_RE.fullmatch(value.strip().lower())
    if match is None:
        raise CompactTranscriptionError("recording_checksum_invalid")
    return match.group(1)


def _pipeline_fingerprint(*, model_revision: str, speaker_enabled: bool = True) -> str:
    contract = {
        "schema_version": PIPELINE_SCHEMA_VERSION,
        "model_revision": model_revision,
        "sample_rate": SAMPLE_RATE,
        "vad": {
            "silence_ms": 600,
            "pre_roll_ms": 250,
            "max_speech_ms": ASR_OFFLINE_SEGMENT_MAX_AUDIO_MS,
            "energy_threshold": 0.0002,
        },
        "asr_batch": {
            "max_items": ASR_BATCH_LIMIT,
            "max_audio_ms": ASR_OFFLINE_BATCH_MAX_AUDIO_MS,
        },
        "speaker": {
            "enabled": speaker_enabled,
            "model": "campplus-zh-cn",
            "cosine": SPEAKER_COSINE_THRESHOLD,
            "gap": SPEAKER_GAP_THRESHOLD,
            "minimum_audio_ms": MIN_SPEAKER_AUDIO_MS,
            "minimum_votes": SPEAKER_MINIMUM_VOTES,
            "anonymous_cluster": ANONYMOUS_CLUSTER_THRESHOLD,
            "pipeline_max_pending": SPEAKER_PIPELINE_MAX_PENDING,
        },
        "simplified": "opencc-t2s",
    }
    return f"sha256:{_payload_sha256(contract)}"


class CheckpointStore:
    def __init__(
        self,
        *,
        job_id: str,
        source_path: Path,
        source_sha256: str,
        source_size: int,
        model_revision: str,
        speaker_enabled: bool = True,
    ) -> None:
        safe_job_id = re.sub(r"[^A-Za-z0-9._-]", "_", job_id)[:160]
        if not safe_job_id:
            raise CompactTranscriptionError("transcription_job_id_invalid")
        revision_key = hashlib.sha256(model_revision.encode("utf-8")).hexdigest()[:16]
        self.root = (
            Path(settings.audio_storage_abs_path)
            / ".transcription-checkpoints"
            / safe_job_id
            / revision_key
        )
        self.segments = self.root / "segments"
        self.segments.mkdir(parents=True, exist_ok=True)
        fingerprint = _pipeline_fingerprint(
            model_revision=model_revision,
            speaker_enabled=speaker_enabled,
        )
        expected = {
            "schema_version": PIPELINE_SCHEMA_VERSION,
            "job_id": job_id,
            "source_path_name": source_path.name,
            "source_sha256": source_sha256,
            "source_size": source_size,
            "model_revision": model_revision,
            "pipeline_fingerprint": fingerprint,
        }
        manifest_path = self.root / "manifest.json"
        if manifest_path.is_file():
            try:
                observed = json.loads(manifest_path.read_text(encoding="utf-8"))
            except (OSError, json.JSONDecodeError) as exc:
                raise CompactTranscriptionError("checkpoint_manifest_invalid") from exc
            if observed != expected:
                raise CompactTranscriptionError("checkpoint_manifest_conflict")
        else:
            _atomic_json(manifest_path, expected)
        self.pipeline_fingerprint = fingerprint

    def load(self, segment: SpeechAudio) -> dict | None:
        path = self.segments / f"{segment.segment_id}.json"
        if not path.is_file():
            return None
        try:
            envelope = json.loads(path.read_text(encoding="utf-8"))
            body = envelope["body"]
            checksum = envelope["payload_sha256"]
        except (OSError, KeyError, TypeError, json.JSONDecodeError):
            return None
        if checksum != _payload_sha256(body):
            return None
        if (
            body.get("segment_id") != segment.segment_id
            or body.get("start_ms") != segment.start_ms
            or body.get("end_ms") != segment.end_ms
            or body.get("pipeline_fingerprint") != self.pipeline_fingerprint
            or not isinstance(body.get("text"), str)
        ):
            return None
        return body

    def save(self, segment: SpeechAudio, result: dict) -> dict:
        body = {
            "schema_version": PIPELINE_SCHEMA_VERSION,
            "pipeline_fingerprint": self.pipeline_fingerprint,
            "segment_id": segment.segment_id,
            "start_ms": segment.start_ms,
            "end_ms": segment.end_ms,
            "text": str(result.get("text") or "").strip(),
            "language": result.get("language"),
            "model_revision": str(result.get("model_revision") or ""),
            "queue_ms": max(0, int(result.get("queue_ms") or 0)),
            "infer_ms": max(0, int(result.get("infer_ms") or 0)),
        }
        _atomic_json(
            self.segments / f"{segment.segment_id}.json",
            {"body": body, "payload_sha256": _payload_sha256(body)},
        )
        return body

    def save_final(self, result: CompactTranscriptionResult) -> None:
        body = {
            "schema_version": PIPELINE_SCHEMA_VERSION,
            "pipeline_fingerprint": self.pipeline_fingerprint,
            "model": result.model,
            "model_revision": result.model_revision,
            "source_duration_ms": result.source_duration_ms,
            "turns": result.turns,
        }
        _atomic_json(
            self.root / "final.json",
            {"body": body, "payload_sha256": _payload_sha256(body)},
        )


class BatchAsrClient:
    def __init__(self, base_url: str | None = None, *, timeout_seconds: float = 600.0):
        self.base_url = (
            base_url
            or os.getenv("LAOJI_ASR_BATCH_URL", "http://127.0.0.1:8030/v1/asr/batch")
        ).strip()
        try:
            expected_port = int(os.getenv("LAOJI_INTERNAL_ASR_PORT", "8030"))
        except ValueError as exc:
            raise CompactTranscriptionError("asr_batch_url_invalid") from exc
        if not 1 <= expected_port <= 65_535:
            raise CompactTranscriptionError("asr_batch_url_invalid")
        parsed = urllib.parse.urlsplit(self.base_url)
        if (
            parsed.scheme != "http"
            or parsed.hostname not in {"127.0.0.1", "localhost", "::1"}
            or parsed.port != expected_port
            or parsed.username is not None
            or parsed.password is not None
            or parsed.query
            or parsed.fragment
            or parsed.path != "/v1/asr/batch"
        ):
            raise CompactTranscriptionError("asr_batch_url_invalid")
        self.ready_url = urllib.parse.urlunsplit(
            (parsed.scheme, parsed.netloc, "/ready", "", "")
        )
        self.timeout_seconds = max(10.0, float(timeout_seconds))
        self._opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
        self.model = ""
        self.model_revision = ""

    def ready(self) -> dict:
        request = urllib.request.Request(self.ready_url, headers={"Accept": "application/json"})
        try:
            with self._opener.open(request, timeout=10) as response:
                payload = json.load(response)
        except (OSError, ValueError, urllib.error.URLError) as exc:
            raise CompactTranscriptionError("asr_unavailable") from exc
        revision = str(payload.get("model_revision") or "").strip()
        if payload.get("ready") is not True or not revision or revision == "unresolved":
            raise CompactTranscriptionError("asr_not_ready")
        self.model = str(payload.get("model") or "Qwen3-ASR")
        self.model_revision = revision
        return payload

    def transcribe(self, segments: list[SpeechAudio], language: str) -> dict[str, dict]:
        if not 1 <= len(segments) <= ASR_BATCH_LIMIT:
            raise CompactTranscriptionError("asr_batch_size_invalid")
        if not self.model_revision:
            self.ready()
        items = []
        for segment in segments:
            pcm = (
                np.clip(segment.audio, -1.0, 1.0) * 32767.0
            ).astype("<i2", copy=False).tobytes()
            items.append(
                {
                    "id": segment.segment_id,
                    "pcm_base64": base64.b64encode(pcm).decode("ascii"),
                    "sample_rate": SAMPLE_RATE,
                    "language": language,
                    "source_start_ms": segment.start_ms,
                    "source_end_ms": segment.end_ms,
                }
            )
        body = json.dumps(
            {"priority": "offline", "items": items},
            ensure_ascii=True,
            separators=(",", ":"),
        ).encode("utf-8")
        request = urllib.request.Request(
            self.base_url,
            data=body,
            headers={"Content-Type": "application/json", "Accept": "application/json"},
        )
        try:
            with self._opener.open(request, timeout=self.timeout_seconds) as response:
                payload = json.load(response)
        except (OSError, ValueError, urllib.error.URLError) as exc:
            raise CompactTranscriptionError("asr_batch_failed") from exc
        if payload.get("model_revision") != self.model_revision:
            raise CompactTranscriptionError("asr_model_revision_changed")
        results = payload.get("items")
        if not isinstance(results, list) or len(results) != len(segments):
            raise CompactTranscriptionError("asr_batch_response_invalid")
        expected = {segment.segment_id: segment for segment in segments}
        by_id: dict[str, dict] = {}
        for result in results:
            if not isinstance(result, dict):
                raise CompactTranscriptionError("asr_batch_response_invalid")
            item_id = str(result.get("id") or "")
            segment = expected.get(item_id)
            if (
                segment is None
                or item_id in by_id
                or result.get("source_start_ms") != segment.start_ms
                or result.get("source_end_ms") != segment.end_ms
                or not isinstance(result.get("text"), str)
            ):
                raise CompactTranscriptionError("asr_batch_response_invalid")
            by_id[item_id] = result
        if set(by_id) != set(expected):
            raise CompactTranscriptionError("asr_batch_response_invalid")
        return by_id


def _subprocess_creation_flags() -> int:
    if os.name == "nt":
        return int(getattr(subprocess, "CREATE_NO_WINDOW", 0))
    return 0


def _probe_duration_ms(source: Path) -> int:
    ffprobe = os.getenv("FFPROBE_BIN", "").strip() or shutil.which("ffprobe")
    if not ffprobe:
        raise CompactTranscriptionError("ffprobe_unavailable")
    try:
        result = subprocess.run(
            [
                ffprobe,
                "-v",
                "error",
                "-select_streams",
                "a:0",
                "-show_entries",
                "format=duration",
                "-of",
                "default=noprint_wrappers=1:nokey=1",
                str(source),
            ],
            capture_output=True,
            text=True,
            timeout=30,
            check=False,
            creationflags=_subprocess_creation_flags(),
        )
        duration = float(result.stdout.strip())
    except (OSError, ValueError, subprocess.TimeoutExpired) as exc:
        raise CompactTranscriptionError("audio_probe_failed") from exc
    if result.returncode != 0 or not math.isfinite(duration) or duration <= 0:
        raise CompactTranscriptionError("audio_probe_failed")
    return max(1, round(duration * 1000))


def _stable_segment_id(source_sha256: str, ordinal: int, start_ms: int, end_ms: int) -> str:
    material = f"{source_sha256}:{ordinal}:{start_ms}:{end_ms}".encode("ascii")
    return f"seg_{hashlib.sha256(material).hexdigest()[:32]}"


def stream_speech_segments(
    source: Path,
    *,
    source_sha256: str,
    vad_model: object,
) -> Iterator[SpeechAudio]:
    ffmpeg = os.getenv("FFMPEG_BIN", "").strip() or shutil.which("ffmpeg")
    if not ffmpeg:
        raise CompactTranscriptionError("ffmpeg_unavailable")
    vad = StreamingVAD(vad_model, sample_rate=SAMPLE_RATE)
    vad.set_min_silence_duration(600)
    vad.set_pre_roll_duration(250, initial_duration_ms=250)
    vad.set_max_speech_duration(ASR_OFFLINE_SEGMENT_MAX_AUDIO_MS)
    vad.set_min_energy_threshold(0.0002)
    process = subprocess.Popen(
        [
            ffmpeg,
            "-nostdin",
            "-hide_banner",
            "-loglevel",
            "error",
            "-i",
            str(source),
            "-map",
            "0:a:0",
            "-vn",
            "-ar",
            str(SAMPLE_RATE),
            "-ac",
            "1",
            "-f",
            "s16le",
            "-",
        ],
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        creationflags=_subprocess_creation_flags(),
    )
    if process.stdout is None:
        process.kill()
        raise CompactTranscriptionError("audio_decode_failed")
    ordinal = 0

    def emit(chunk: np.ndarray) -> Iterator[SpeechAudio]:
        nonlocal ordinal
        next_chunk = chunk
        while True:
            segment = vad.feed(next_chunk)
            next_chunk = np.empty(0, dtype=np.float32)
            if segment is None:
                return
            start_ms = max(0, int(segment.start_ms))
            end_ms = max(start_ms + 1, int(segment.end_ms))
            audio = np.asarray(segment.audio_data, dtype=np.float32)
            if audio.size:
                yield SpeechAudio(
                    ordinal=ordinal,
                    segment_id=_stable_segment_id(source_sha256, ordinal, start_ms, end_ms),
                    start_ms=start_ms,
                    end_ms=end_ms,
                    audio=audio,
                )
                ordinal += 1

    try:
        while True:
            raw = process.stdout.read(64 * 1024)
            if not raw:
                break
            if len(raw) % 2:
                raise CompactTranscriptionError("pcm_decode_invalid")
            audio = np.frombuffer(raw, dtype="<i2").astype(np.float32) / 32768.0
            yield from emit(audio)
        silence = np.zeros(512, dtype=np.float32)
        for _ in range(80):
            yielded = False
            for segment in emit(silence):
                yielded = True
                yield segment
            if getattr(vad, "state", "idle") == "idle" and not yielded:
                break
        stderr = process.stderr.read() if process.stderr is not None else b""
        return_code = process.wait(timeout=30)
        if return_code != 0:
            raise CompactTranscriptionError(
                f"audio_decode_failed:{hashlib.sha256(stderr).hexdigest()[:12]}"
            )
    except BaseException:
        if process.poll() is None:
            process.kill()
            process.wait(timeout=5)
        raise


def _simplified(text: str) -> str:
    global _OPENCC_CONVERTER
    normalized = str(text or "").strip()
    if not normalized:
        return ""
    with _OPENCC_LOCK:
        if _OPENCC_CONVERTER is None:
            try:
                import opencc

                _OPENCC_CONVERTER = opencc.OpenCC("t2s")
            except Exception as exc:
                raise CompactTranscriptionError("simplified_converter_unavailable") from exc
        return str(_OPENCC_CONVERTER.convert(normalized)).strip()


def _unit_embedding(value: object) -> np.ndarray | None:
    if value is None:
        return None
    embedding = bytes_to_ndarray(value)
    if embedding is None:
        return None
    embedding = np.asarray(embedding, dtype=np.float32).reshape(-1)
    norm = float(np.linalg.norm(embedding))
    if not math.isfinite(norm) or norm < 1e-6:
        return None
    return embedding / norm


def _load_registered_profiles(owner_user_id: int) -> list[dict]:
    profiles = []
    for raw in get_speaker_db().load_for_owner(owner_user_id, active_only=True):
        embedding_value = raw.get("embedding_mean")
        if embedding_value is None or (
            hasattr(embedding_value, "__len__") and len(embedding_value) == 0
        ):
            embedding_value = raw.get("embedding")
        embedding = _unit_embedding(embedding_value)
        if embedding is None:
            continue
        profiles.append(
            {
                "speaker_id": str(raw.get("speaker_id") or ""),
                "name": str(raw.get("name") or raw.get("speaker_id") or "未命名讲话人"),
                "embedding": embedding,
            }
        )
    return [profile for profile in profiles if profile["speaker_id"]]


def _extract_embedding(
    extractor: SpeakerEmbeddingExtractor | None,
    segment: SpeechAudio,
) -> np.ndarray | None:
    if extractor is None or segment.end_ms - segment.start_ms < MIN_SPEAKER_AUDIO_MS:
        return None
    try:
        return _unit_embedding(extractor.extract(segment.audio))
    except Exception:
        return None


def _assign_speakers(records: list[TranscriptRecord], profiles: list[dict]) -> None:
    clusters: list[dict] = []
    previous_cluster: int | None = None
    previous_end_ms = -1
    for record in records:
        embedding = record.embedding
        cluster_index: int | None = None
        if embedding is not None and clusters:
            similarities = [
                (
                    float(np.dot(embedding, cluster["centroid"]))
                    if cluster["centroid"] is not None
                    else -1.0
                )
                for cluster in clusters
            ]
            candidate = int(np.argmax(similarities))
            if similarities[candidate] >= ANONYMOUS_CLUSTER_THRESHOLD:
                cluster_index = candidate
        if cluster_index is None and embedding is None and previous_cluster is not None:
            if record.start_ms - previous_end_ms <= 1_500:
                cluster_index = previous_cluster
        if cluster_index is None:
            clusters.append(
                {
                    "centroid": embedding.copy() if embedding is not None else None,
                    "embedding_count": 1 if embedding is not None else 0,
                    "records": [],
                    "votes": Counter(),
                    "scores": {},
                }
            )
            cluster_index = len(clusters) - 1
        cluster = clusters[cluster_index]
        if embedding is not None:
            if cluster["centroid"] is None:
                cluster["centroid"] = embedding.copy()
                cluster["embedding_count"] = 1
            elif cluster["records"]:
                count = int(cluster["embedding_count"])
                centroid = cluster["centroid"] * count + embedding
                norm = float(np.linalg.norm(centroid))
                if norm >= 1e-6:
                    cluster["centroid"] = centroid / norm
                    cluster["embedding_count"] = count + 1
            if profiles:
                scores = sorted(
                    (
                        (float(np.dot(embedding, profile["embedding"])), profile)
                        for profile in profiles
                    ),
                    key=lambda item: item[0],
                    reverse=True,
                )
                top_score, top_profile = scores[0]
                second_score = scores[1][0] if len(scores) > 1 else -1.0
                if (
                    top_score >= SPEAKER_COSINE_THRESHOLD
                    and top_score - second_score >= SPEAKER_GAP_THRESHOLD
                    and record.end_ms - record.start_ms >= MIN_SPEAKER_AUDIO_MS
                ):
                    speaker_id = top_profile["speaker_id"]
                    cluster["votes"][speaker_id] += 1
                    cluster["scores"].setdefault(speaker_id, []).append(top_score)
        cluster["records"].append(record)
        previous_cluster = cluster_index
        previous_end_ms = record.end_ms

    profiles_by_id = {profile["speaker_id"]: profile for profile in profiles}
    for index, cluster in enumerate(clusters, start=1):
        accepted_id = None
        if cluster["votes"]:
            candidate_id, count = cluster["votes"].most_common(1)[0]
            if count >= SPEAKER_MINIMUM_VOTES:
                accepted_id = candidate_id
        if accepted_id is not None:
            profile = profiles_by_id[accepted_id]
            confidence = sum(cluster["scores"][accepted_id]) / len(cluster["scores"][accepted_id])
            speaker_id = accepted_id
            speaker_label = profile["name"]
        else:
            confidence = 0.0
            speaker_id = f"anonymous_{index}"
            speaker_label = f"发言人 {index}"
        for record in cluster["records"]:
            record.speaker_id = speaker_id
            record.speaker_label = speaker_label
            record.confidence = float(confidence)


def _trim_repeated_boundary(left: str, right: str) -> str:
    if not left or not right:
        return right
    maximum = min(len(left), len(right), 80)
    for length in range(maximum, 1, -1):
        if left[-length:] == right[:length]:
            return right[length:].lstrip()
    return right


def _deduplicate_overlaps(records: list[TranscriptRecord]) -> list[TranscriptRecord]:
    output: list[TranscriptRecord] = []
    for record in sorted(records, key=lambda item: (item.start_ms, item.end_ms, item.segment_id)):
        if not record.text:
            continue
        if output and record.start_ms < output[-1].end_ms:
            record.text = _trim_repeated_boundary(output[-1].text, record.text)
        if record.text:
            output.append(record)
    return output


def transcribe_recording_asset(
    *,
    source_path: str,
    source_sha256: str,
    job_id: str,
    owner_user_id: int,
    language: str,
    model_manager: ModelManager | None = None,
    client: BatchAsrClient | None = None,
    segment_iterator: Callable[[], Iterable[SpeechAudio]] | None = None,
    progress: Callable[[float], None] | None = None,
    partial: Callable[[list[dict], float, int], None] | None = None,
    on_speech_segment: Callable[[SpeechAudio], None] | None = None,
    on_stable_segment: Callable[[SpeechAudio, dict], None] | None = None,
    speaker_enabled: bool = True,
    source_size_override: int | None = None,
    source_duration_ms_override: int | None = None,
) -> CompactTranscriptionResult:
    source = Path(source_path)
    if segment_iterator is None and (not source.is_file() or source.stat().st_size < 1):
        raise CompactTranscriptionError("recording_content_missing")
    source_size = (
        int(source_size_override)
        if source_size_override is not None
        else int(source.stat().st_size)
    )
    if source_size < 1:
        raise CompactTranscriptionError("recording_content_missing")
    source_digest = _normalized_source_sha256(source_sha256)
    asr = client or BatchAsrClient()
    ready = asr.ready()
    model_revision = str(ready.get("model_revision") or "")
    store = CheckpointStore(
        job_id=job_id,
        source_path=source,
        source_sha256=source_digest,
        source_size=source_size,
        model_revision=model_revision,
        speaker_enabled=speaker_enabled,
    )
    duration_ms = (
        max(1, int(source_duration_ms_override))
        if source_duration_ms_override is not None
        else _probe_duration_ms(source)
    )
    manager = model_manager or ModelManager.get_instance()
    vad_model = manager.create_vad_model()
    if vad_model is None and segment_iterator is None:
        raise CompactTranscriptionError("vad_not_ready")
    camp_model = manager.get_camp_model() if speaker_enabled else None
    extractor = (
        SpeakerEmbeddingExtractor(camp_model, device=manager.device)
        if camp_model is not None
        else None
    )
    profiles = _load_registered_profiles(owner_user_id) if speaker_enabled else []
    records: list[TranscriptRecord] = []
    pending: list[tuple[SpeechAudio, Future[np.ndarray | None] | None]] = []
    speaker_tasks: list[
        tuple[TranscriptRecord, Future[np.ndarray | None]]
    ] = []
    pending_audio_ms = 0
    observed_end_ms = 0
    speaker_executor = (
        ThreadPoolExecutor(max_workers=1, thread_name_prefix="laoji-campplus")
        if extractor is not None
        else None
    )

    def report(value: float) -> None:
        if progress is not None:
            progress(min(1.0, max(0.0, value)))

    def submit_embedding(segment: SpeechAudio) -> Future[np.ndarray | None] | None:
        if speaker_executor is None:
            return None
        return speaker_executor.submit(_extract_embedding, extractor, segment)

    def settle_speaker_tasks(*, wait_for_one: bool = False) -> None:
        nonlocal speaker_tasks
        remaining: list[tuple[TranscriptRecord, Future[np.ndarray | None]]] = []
        waited = False
        for record, future in speaker_tasks:
            should_wait = wait_for_one and not waited
            if not future.done() and not should_wait:
                remaining.append((record, future))
                continue
            record.embedding = future.result()
            waited = waited or should_wait
        speaker_tasks = remaining

    def flush() -> None:
        nonlocal pending_audio_ms
        if not pending:
            return
        segments = [item[0] for item in pending]
        results = asr.transcribe(segments, language)
        published: list[dict] = []
        stable_callbacks: list[tuple[SpeechAudio, dict]] = []
        for segment, embedding_future in pending:
            checkpoint = store.save(segment, results[segment.segment_id])
            if on_stable_segment is not None:
                stable_callbacks.append((segment, checkpoint))
            record = TranscriptRecord(
                ordinal=segment.ordinal,
                segment_id=segment.segment_id,
                start_ms=segment.start_ms,
                end_ms=segment.end_ms,
                text=_simplified(checkpoint["text"]),
                language=checkpoint.get("language"),
                embedding=None,
            )
            records.append(record)
            if embedding_future is not None:
                speaker_tasks.append((record, embedding_future))
            if record.text.strip():
                published.append({
                    "ordinal": record.ordinal,
                    "segment_id": record.segment_id,
                    "text": record.text,
                    "language": record.language,
                    "model_revision": model_revision,
                    "start_ms": record.start_ms,
                    "end_ms": record.end_ms,
                    "confidence": 0.0,
                })
        pending.clear()
        pending_audio_ms = 0
        if partial is not None and published:
            processed_end_ms = max(item["end_ms"] for item in published)
            partial(
                published,
                min(1.0, max(0.0, 0.05 + 0.80 * processed_end_ms / max(1, duration_ms))),
                processed_end_ms,
            )
        # Stable text is the user-facing critical path. Speaker spool work is
        # deliberately invoked only after the durable text callback returned.
        if on_stable_segment is not None:
            for segment, checkpoint in stable_callbacks:
                on_stable_segment(segment, checkpoint)
        settle_speaker_tasks()
        while len(speaker_tasks) > SPEAKER_PIPELINE_MAX_PENDING:
            settle_speaker_tasks(wait_for_one=True)

    iterator = (
        segment_iterator()
        if segment_iterator is not None
        else stream_speech_segments(
            source,
            source_sha256=source_digest,
            vad_model=vad_model,
        )
    )
    try:
        for segment in iterator:
            if not _ITEM_ID_RE.fullmatch(segment.segment_id):
                raise CompactTranscriptionError("segment_id_invalid")
            observed_end_ms = max(observed_end_ms, segment.end_ms)
            if on_speech_segment is not None:
                on_speech_segment(segment)
            segment_audio_ms = max(
                1,
                round(segment.audio.size * 1000 / SAMPLE_RATE),
            )
            if pending and (
                len(pending) >= ASR_BATCH_LIMIT
                or pending_audio_ms + segment_audio_ms > ASR_OFFLINE_BATCH_MAX_AUDIO_MS
            ):
                flush()
            embedding_future = submit_embedding(segment)
            checkpoint = store.load(segment)
            if checkpoint is not None:
                record = TranscriptRecord(
                    ordinal=segment.ordinal,
                    segment_id=segment.segment_id,
                    start_ms=segment.start_ms,
                    end_ms=segment.end_ms,
                    text=_simplified(checkpoint["text"]),
                    language=checkpoint.get("language"),
                    embedding=None,
                )
                records.append(record)
                if partial is not None and record.text.strip():
                    partial(
                        [{
                            "ordinal": record.ordinal,
                            "segment_id": record.segment_id,
                            "text": record.text,
                            "language": record.language,
                            "model_revision": model_revision,
                            "start_ms": record.start_ms,
                            "end_ms": record.end_ms,
                            "confidence": 0.0,
                        }],
                        min(1.0, max(0.0, 0.05 + 0.80 * record.end_ms / max(1, duration_ms))),
                        record.end_ms,
                    )
                if on_stable_segment is not None:
                    on_stable_segment(segment, checkpoint)
                if embedding_future is not None:
                    speaker_tasks.append((record, embedding_future))
            else:
                pending.append((segment, embedding_future))
                pending_audio_ms += segment_audio_ms
                if (
                    len(pending) >= ASR_BATCH_LIMIT
                    or pending_audio_ms >= ASR_OFFLINE_BATCH_MAX_AUDIO_MS
                ):
                    flush()
            settle_speaker_tasks()
            while len(speaker_tasks) > SPEAKER_PIPELINE_MAX_PENDING:
                settle_speaker_tasks(wait_for_one=True)
            report(0.05 + 0.80 * observed_end_ms / max(1, duration_ms))
        flush()
        while speaker_tasks:
            settle_speaker_tasks(wait_for_one=True)
    finally:
        if speaker_executor is not None:
            speaker_executor.shutdown(wait=True, cancel_futures=False)
    records = _deduplicate_overlaps(records)
    if not records:
        raise CompactTranscriptionError("no_speech")
    if speaker_enabled:
        _assign_speakers(records, profiles)
    turns = [
        {
            "segment_id": record.segment_id,
            "speaker_id": record.speaker_id,
            "speaker_label": record.speaker_label,
            "text": record.text,
            "start_ms": record.start_ms,
            "end_ms": record.end_ms,
            "confidence": round(record.confidence, 6),
        }
        for record in records
    ]
    result = CompactTranscriptionResult(
        model=asr.model,
        model_revision=model_revision,
        source_duration_ms=max(duration_ms, observed_end_ms),
        turns=turns,
        checkpoint_dir=str(store.root),
    )
    store.save_final(result)
    report(1.0)
    privacy_log(
        "transcription_completed",
        capability="media.upload",
        segments=len(turns),
        duration_ms=duration_ms,
        model_revision=model_revision,
        status="completed",
    )
    return result
