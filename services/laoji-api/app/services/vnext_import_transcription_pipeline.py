"""Recoverable R2-to-ASR handler for generic vNext transcription tasks."""

from __future__ import annotations

import asyncio
import base64
from dataclasses import dataclass
import hashlib
import itertools
import logging
import os
import shutil
import socket
import subprocess
import threading
import time
from typing import Any, Callable, Iterable, Iterator

import numpy as np

from app.asr.model_manager import ModelManager
from app.asr.streaming_vad import StreamingVAD
from app.services import (
    r2_storage_service,
    vnext_asr_client,
    vnext_import_transcript_store,
    vnext_speaker_pipeline,
    vnext_speaker_store,
    vnext_task_store,
    vnext_upload_store,
    vnext_verified_media_cache,
)
from app.services.compact_transcription_service import (
    ASR_OFFLINE_FIRST_BATCH_MAX_AUDIO_MS,
    ASR_OFFLINE_SEGMENT_MAX_AUDIO_MS,
    CompactTranscriptionError,
    SpeechAudio,
    _stable_segment_id,
    transcribe_recording_asset,
)


_logger = logging.getLogger(__name__)
QUEUE_LIMIT = max(2, min(32, int(os.getenv("LAOJI_VNEXT_IMPORT_QUEUE_LIMIT", "8"))))
LEASE_SECONDS = 30


def import_transcription_enabled() -> bool:
    return os.getenv("LAOJI_VNEXT_IMPORT_TRANSCRIPTION_ENABLED", "0").strip().lower() in {
        "1", "true", "yes", "on",
    }


@dataclass(frozen=True)
class ImportContext:
    device_id: str
    epoch_id: str


class VNextOfflineBatchClient:
    def __init__(self) -> None:
        self.model = ""
        self.model_revision = ""

    def ready(self) -> dict:
        snapshot = vnext_asr_client.ready_snapshot()
        self.model = str(snapshot.get("model") or "Qwen3-ASR")
        self.model_revision = str(snapshot["model_revision"])
        return snapshot

    def transcribe(self, segments: list[SpeechAudio], language: str) -> dict[str, dict]:
        items = []
        for segment in segments:
            pcm = (
                np.clip(segment.audio, -1.0, 1.0) * 32767.0
            ).astype("<i2", copy=False).tobytes()
            items.append({
                "id": segment.segment_id,
                "pcm_base64": base64.b64encode(pcm).decode("ascii"),
                "sample_rate": 16_000,
                "language": language,
                "source_start_ms": segment.start_ms,
                "source_end_ms": segment.end_ms,
            })
        response = vnext_asr_client.transcribe_batch(
            items=items,
            priority="offline",
            timeout_seconds=600,
        )
        if self.model_revision and response["model_revision"] != self.model_revision:
            raise CompactTranscriptionError("asr_model_revision_changed")
        self.model = str(response["model"])
        self.model_revision = str(response["model_revision"])
        return {str(item["id"]): item for item in response["items"]}


def _subprocess_creation_flags() -> int:
    if os.name == "nt":
        return int(getattr(subprocess, "CREATE_NO_WINDOW", 0))
    return 0


def stream_r2_speech_segments(
    *,
    object_key: str,
    source_sha256: str,
    vad_model: object,
    chunk_source: Callable[..., Iterable[bytes]] | None = None,
    input_url_provider: Callable[..., str] = r2_storage_service.presign_get_object,
    on_decoded_duration_ms: Callable[[int], None] | None = None,
) -> Iterator[SpeechAudio]:
    """Decode private R2 media without creating a whole-file temporary copy.

    Production uses a short-lived range-readable URL so MP4/M4A files with a
    tail ``moov`` atom remain seekable.  Tests can inject ``chunk_source`` to
    exercise the bounded stdin path without object-storage credentials.
    """
    ffmpeg = os.getenv("FFMPEG_BIN", "").strip() or shutil.which("ffmpeg")
    if not ffmpeg:
        raise CompactTranscriptionError("ffmpeg_unavailable")
    pipe_input = chunk_source is not None
    input_locator = "pipe:0" if pipe_input else input_url_provider(object_key=object_key)
    process = subprocess.Popen(
        [
            ffmpeg,
            "-nostdin",
            "-hide_banner",
            "-loglevel",
            "error",
            "-i",
            input_locator,
            "-map",
            "0:a:0",
            "-vn",
            "-ar",
            "16000",
            "-ac",
            "1",
            "-f",
            "s16le",
            "pipe:1",
        ],
        stdin=subprocess.PIPE if pipe_input else subprocess.DEVNULL,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        creationflags=_subprocess_creation_flags(),
    )
    if process.stdout is None or (pipe_input and process.stdin is None):
        process.kill()
        raise CompactTranscriptionError("audio_decode_failed")
    writer_error: list[Exception] = []

    def write_source() -> None:
        assert chunk_source is not None
        assert process.stdin is not None
        try:
            for chunk in chunk_source(object_key=object_key):
                process.stdin.write(chunk)
            process.stdin.flush()
        except (BrokenPipeError, OSError) as error:
            if process.poll() is None:
                writer_error.append(error)
        except Exception as error:
            writer_error.append(error)
        finally:
            try:
                process.stdin.close()
            except OSError:
                pass

    writer: threading.Thread | None = None
    if pipe_input:
        writer = threading.Thread(
            target=write_source,
            name="laoji-r2-ffmpeg-feed",
            daemon=True,
        )
        writer.start()
    vad = StreamingVAD(vad_model, sample_rate=16_000)
    vad.set_min_silence_duration(600)
    vad.set_pre_roll_duration(250, initial_duration_ms=250)
    vad.set_max_speech_duration(ASR_OFFLINE_FIRST_BATCH_MAX_AUDIO_MS)
    vad.set_min_energy_threshold(0.0002)
    ordinal = 0
    decoded_samples = 0

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
                emitted = SpeechAudio(
                    ordinal=ordinal,
                    segment_id=_stable_segment_id(source_sha256, ordinal, start_ms, end_ms),
                    start_ms=start_ms,
                    end_ms=end_ms,
                    audio=audio,
                )
                ordinal += 1
                yield emitted
                if ordinal == 1:
                    vad.set_max_speech_duration(ASR_OFFLINE_SEGMENT_MAX_AUDIO_MS)

    try:
        while True:
            raw = process.stdout.read(64 * 1024)
            if not raw:
                break
            if len(raw) % 2:
                raise CompactTranscriptionError("pcm_decode_invalid")
            audio = np.frombuffer(raw, dtype="<i2").astype(np.float32) / 32768.0
            decoded_samples += int(audio.size)
            if on_decoded_duration_ms is not None:
                on_decoded_duration_ms(round(decoded_samples * 1000 / 16_000))
            yield from emit(audio)
        silence = np.zeros(512, dtype=np.float32)
        for _ in range(80):
            yielded = False
            for segment in emit(silence):
                yielded = True
                yield segment
            if getattr(vad, "state", "idle") == "idle" and not yielded:
                break
        if writer is not None:
            writer.join(timeout=30)
        stderr = process.stderr.read() if process.stderr is not None else b""
        return_code = process.wait(timeout=30)
        if writer is not None and writer.is_alive():
            raise CompactTranscriptionError("r2_stream_timeout")
        if writer_error:
            raise CompactTranscriptionError("r2_stream_failed") from writer_error[0]
        if return_code != 0:
            raise CompactTranscriptionError(
                f"audio_decode_failed:{hashlib.sha256(stderr).hexdigest()[:12]}"
            )
    except BaseException:
        if process.poll() is None:
            process.kill()
        try:
            process.wait(timeout=5)
        except subprocess.TimeoutExpired:
            pass
        if writer is not None:
            writer.join(timeout=5)
        raise


async def _transcribe_source(
    context: ImportContext,
    source: dict[str, Any],
    *,
    attempt_id: str,
    lease_owner: str,
) -> dict[str, Any]:
    task_id = str(source["task_id"])
    speaker_run_id = vnext_speaker_store.import_speaker_run_id(task_id)
    await asyncio.to_thread(
        vnext_speaker_store.create_import_speaker_run,
        context,
        speaker_run_id=speaker_run_id,
        source_task_id=task_id,
        asset_generation=str(source["asset_generation"]),
    )
    manager = ModelManager.get_instance()
    await manager.initialize_vad()
    vad_model = await asyncio.to_thread(manager.create_vad_model)
    if vad_model is None:
        raise CompactTranscriptionError("vad_not_ready")
    client = VNextOfflineBatchClient()
    decoded_duration_ms = 0

    def observe_duration(value: int) -> None:
        nonlocal decoded_duration_ms
        decoded_duration_ms = max(decoded_duration_ms, int(value))
    def renew_lease() -> None:
        renewed = vnext_task_store.claim_attempt(
            context,
            task_id,
            lease_owner=lease_owner,
            lease_seconds=LEASE_SECONDS,
        )
        if renewed is None or str(renewed["attempt_id"]) != attempt_id:
            raise CompactTranscriptionError("transcript_worker_fenced")

    def publish_partial(rows: list[dict], _progress: float, _processed_end_ms: int) -> None:
        renew_lease()
        for row in rows:
            vnext_import_transcript_store.append_stable_event(
                context,
                task_id,
                attempt_id=attempt_id,
                lease_owner=lease_owner,
                stable_segment_key=str(row["segment_id"]),
                text=str(row["text"]),
                source_start_ms=int(row["start_ms"]),
                source_end_ms=int(row["end_ms"]),
                model_revision=str(row["model_revision"]),
            )

    def collect_speaker(segment: SpeechAudio, checkpoint: dict) -> None:
        if not str(checkpoint.get("text") or "").strip():
            return
        pcm = (
            np.clip(segment.audio, -1.0, 1.0) * 32767.0
        ).astype("<i2", copy=False).tobytes()
        try:
            vnext_speaker_store.collect_import_speaker_segment(
                context,
                speaker_run_id,
                stable_segment_key=segment.segment_id,
                source_start_ms=segment.start_ms,
                source_end_ms=segment.end_ms,
                pcm_bytes=pcm,
            )
        except Exception as error:
            # Speaker inference is an independent overlay lane. Losing one
            # automatic input must never roll back already durable text.
            _logger.warning("vnext import speaker segment deferred: %s", type(error).__name__)

    normalized_sha = str(source["source_sha256"])[7:]
    cached_source = vnext_verified_media_cache.resolve(
        asset_revision_id=str(source["asset_revision_id"]),
        source_sha256=str(source["source_sha256"]),
        expected_size=int(source["byte_size"]),
    )
    iterator = (
        None
        if cached_source is not None
        else lambda: stream_r2_speech_segments(
            object_key=str(source["object_key"]),
            source_sha256=normalized_sha,
            vad_model=vad_model,
            on_decoded_duration_ms=observe_duration,
        )
    )
    final_committed = False
    try:
        result = await asyncio.to_thread(
            transcribe_recording_asset,
            source_path=(
                str(cached_source)
                if cached_source is not None
                else f"r2-{source['asset_revision_id']}.audio"
            ),
            source_sha256=str(source["source_sha256"]),
            job_id=task_id,
            owner_user_id=0,
            language="Chinese",
            model_manager=manager,
            client=client,
            segment_iterator=iterator,
            partial=publish_partial,
            on_stable_segment=collect_speaker,
            speaker_enabled=False,
            source_size_override=(None if cached_source is not None else int(source["byte_size"])),
            source_duration_ms_override=(None if cached_source is not None else 1),
        )
    except CompactTranscriptionError as error:
        if str(error) != "no_speech":
            raise
        ready = client.ready() if not client.model_revision else {
            "model": client.model,
            "model_revision": client.model_revision,
        }
        final = await asyncio.to_thread(
            vnext_import_transcript_store.commit_final,
            context,
            task_id,
            attempt_id=attempt_id,
            lease_owner=lease_owner,
            outcome="no_speech",
            source_duration_ms=decoded_duration_ms,
            model_revision=str(ready["model_revision"]),
        )
        final_committed = True
    else:
        final = await asyncio.to_thread(
            vnext_import_transcript_store.commit_final,
            context,
            task_id,
            attempt_id=attempt_id,
            lease_owner=lease_owner,
            outcome="text",
            source_duration_ms=max(result.source_duration_ms, decoded_duration_ms),
            model_revision=result.model_revision,
        )
        final_committed = True
    if final_committed and cached_source is not None:
        await asyncio.to_thread(
            vnext_verified_media_cache.remove,
            asset_revision_id=str(source["asset_revision_id"]),
            source_sha256=str(source["source_sha256"]),
        )
    speaker = await vnext_speaker_pipeline.finalize_realtime_speaker(
        context,
        speaker_run_id,
    )
    return {"transcript": final, "speaker": speaker}


class VNextImportTranscriptionWorker:
    def __init__(
        self,
        *,
        transcribe_source: Callable[..., Any] = _transcribe_source,
    ) -> None:
        self.transcribe_source = transcribe_source
        self._queue: asyncio.PriorityQueue[tuple[int, int, str, str, str]] = (
            asyncio.PriorityQueue(maxsize=QUEUE_LIMIT)
        )
        self._sequence = itertools.count()
        self._task: asyncio.Task | None = None
        self._maintenance_task: asyncio.Task | None = None
        self._closed = False
        self._queued: set[str] = set()
        self._last_cache_prune_epoch = 0.0
        self._lease_owner = f"import-transcript:{socket.gethostname()}:{os.getpid()}"

    def start(self) -> None:
        if self._task is None or self._task.done():
            self._closed = False
            self._task = asyncio.create_task(self._run(), name="vnext-import-transcription")
        if self._maintenance_task is None or self._maintenance_task.done():
            self._maintenance_task = asyncio.create_task(
                self._maintain(),
                name="vnext-import-transcription-maintenance",
            )

    async def stop(self) -> None:
        self._closed = True
        tasks = [task for task in (self._task, self._maintenance_task) if task is not None]
        for task in tasks:
            task.cancel()
        for task in tasks:
            try:
                await task
            except asyncio.CancelledError:
                pass
        self._task = None
        self._maintenance_task = None
        self._queued.clear()

    def notify(self, source: dict[str, Any]) -> None:
        task_id = str(source["task_id"])
        if task_id in self._queued:
            return
        try:
            self._queue.put_nowait((
                20,
                next(self._sequence),
                str(source["device_id"]),
                str(source["epoch_id"]),
                task_id,
            ))
        except asyncio.QueueFull:
            return
        self._queued.add(task_id)

    async def _scan(self) -> None:
        await asyncio.to_thread(vnext_upload_store.expire_upload_sessions, limit=16)
        await asyncio.to_thread(vnext_upload_store.queue_terminal_task_source_cleanup, limit=16)
        await asyncio.to_thread(vnext_upload_store.process_cleanup_obligations, limit=16)
        await asyncio.to_thread(vnext_import_transcript_store.purge_expired_event_payloads, limit=64)
        sources = await asyncio.to_thread(vnext_upload_store.list_pending_transcription_sources, 16)
        for source in sources:
            self.notify(source)
        now = time.time()
        if now - self._last_cache_prune_epoch >= 30.0:
            active = await asyncio.to_thread(
                vnext_upload_store.list_active_transcription_cache_identities,
            )
            await asyncio.to_thread(vnext_verified_media_cache.prune, active)
            self._last_cache_prune_epoch = now

    async def _maintain(self) -> None:
        while not self._closed:
            try:
                await self._scan()
            except asyncio.CancelledError:
                raise
            except Exception as error:
                _logger.warning("vnext import maintenance failed: %s", type(error).__name__)
            await asyncio.sleep(1.0)

    async def _run(self) -> None:
        while not self._closed:
            item = await self._queue.get()
            _priority, _sequence, device_id, epoch_id, task_id = item
            self._queued.discard(task_id)
            try:
                await self._process(ImportContext(device_id, epoch_id), task_id)
            except asyncio.CancelledError:
                raise
            except Exception as error:
                _logger.warning("vnext import worker item failed: %s", type(error).__name__)
            finally:
                self._queue.task_done()

    async def _process(self, context: ImportContext, task_id: str) -> None:
        task = await asyncio.to_thread(vnext_task_store.get_task, context, task_id)
        if task is None or task["state"] != "active":
            return
        source = await asyncio.to_thread(
            vnext_upload_store.get_verified_transcription_source,
            context,
            task_id,
        )
        source["task_id"] = task_id
        await asyncio.to_thread(vnext_import_transcript_store.ensure_run, context, source)
        attempt = await asyncio.to_thread(
            vnext_task_store.claim_attempt,
            context,
            task_id,
            lease_owner=self._lease_owner,
            lease_seconds=LEASE_SECONDS,
        )
        if attempt is None:
            return
        attempt_id = str(attempt["attempt_id"])
        if not await asyncio.to_thread(
            vnext_import_transcript_store.mark_running,
            context,
            task_id,
            attempt_id,
            self._lease_owner,
        ):
            return
        heartbeat_failed = asyncio.Event()

        async def heartbeat() -> None:
            while True:
                await asyncio.sleep(10)
                renewed = await asyncio.to_thread(
                    vnext_task_store.claim_attempt,
                    context,
                    task_id,
                    lease_owner=self._lease_owner,
                    lease_seconds=LEASE_SECONDS,
                )
                if renewed is None or str(renewed["attempt_id"]) != attempt_id:
                    heartbeat_failed.set()
                    return

        heartbeat_task = asyncio.create_task(heartbeat(), name=f"vnext-import-heartbeat:{task_id}")
        try:
            result = self.transcribe_source(
                context,
                source,
                attempt_id=attempt_id,
                lease_owner=self._lease_owner,
            )
            if asyncio.iscoroutine(result):
                await result
            if heartbeat_failed.is_set():
                raise CompactTranscriptionError("transcript_worker_fenced")
        except Exception as error:
            code = (
                str(error).strip()[:160]
                if isinstance(error, CompactTranscriptionError) and str(error).strip()
                else f"TRANSCRIPT_{type(error).__name__.upper()[:80]}"
            )
            retryable = code not in {
                "recording_checksum_invalid",
                "recording_content_missing",
                "audio_decode_failed",
            }
            await asyncio.to_thread(
                vnext_import_transcript_store.mark_failure,
                context,
                task_id,
                attempt_id=attempt_id,
                lease_owner=self._lease_owner,
                error_code=code,
                retryable=retryable,
            )
        finally:
            heartbeat_task.cancel()
            try:
                await heartbeat_task
            except asyncio.CancelledError:
                pass


_worker: VNextImportTranscriptionWorker | None = None


def get_import_transcription_worker() -> VNextImportTranscriptionWorker:
    global _worker
    if _worker is None:
        _worker = VNextImportTranscriptionWorker()
    return _worker


def start_import_transcription_worker() -> None:
    if import_transcription_enabled():
        get_import_transcription_worker().start()


async def stop_import_transcription_worker() -> None:
    if _worker is not None:
        await _worker.stop()
