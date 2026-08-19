"""Text-first realtime pipeline over durable chunk and event cursors."""

from __future__ import annotations

import asyncio
import base64
import hashlib
import json
import logging
from typing import Any, Awaitable, Callable

import numpy as np

from app.schemas.vnext_contracts import TranscriptStreamEventV2
from app.services import (
    vnext_asr_client,
    vnext_realtime_crypto,
    vnext_realtime_store,
    vnext_speaker_pipeline,
)


SendEvent = Callable[[dict[str, Any]], Awaitable[None]]
AsrCall = Callable[..., dict[str, Any]]
AsrBatchCall = Callable[..., dict[str, Any]]
_logger = logging.getLogger(__name__)


class VNextRealtimePipelineFailure(RuntimeError):
    def __init__(self, cause: Exception):
        super().__init__("vnext_realtime_pipeline_failed")
        self.cause = cause


async def _create_vad():
    from app.asr.model_manager import get_model_manager
    from app.asr.streaming_vad import StreamingVAD

    manager = get_model_manager()
    initialize_vad = getattr(manager, "initialize_vad", None)
    if initialize_vad is not None:
        await initialize_vad()
    elif not manager.is_initialized():
        await manager.initialize()
    model = await asyncio.to_thread(manager.create_vad_model)
    if model is None:
        raise RuntimeError("vnext_vad_not_ready")
    vad = StreamingVAD(model)
    vad.set_max_speech_duration(4500.0)
    vad.set_min_energy_threshold(0.0002)
    vad.set_min_silence_duration(650.0)
    vad.set_pre_roll_duration(400.0, initial_duration_ms=200.0)
    return vad


def _flush_vad(vad) -> list:
    segments = []
    for _ in range(40):
        segment = vad.feed(np.zeros(512, dtype=np.float32))
        if segment is not None:
            segments.append(segment)
        if getattr(vad, "state", "idle") == "idle":
            break
    return segments


class VNextRealtimeTextPipeline:
    def __init__(
        self,
        context,
        session_id: str,
        asset_generation: str,
        task_id: str,
        worker_generation: str,
        attempt_id: str,
        lease_owner: str,
        send_event: SendEvent,
        *,
        vad_factory: Callable[[], Awaitable[Any]] = _create_vad,
        asr_call: AsrCall = vnext_asr_client.transcribe_realtime_segment,
        asr_batch_call: AsrBatchCall = vnext_asr_client.transcribe_batch,
    ) -> None:
        self.context = context
        self.session_id = session_id
        self.asset_generation = asset_generation
        self.task_id = task_id
        self.worker_generation = worker_generation
        self.attempt_id = attempt_id
        self.lease_owner = lease_owner
        self.send_event = send_event
        self.vad_factory = vad_factory
        self.asr_call = asr_call
        self.asr_batch_call = asr_batch_call
        self._wake = asyncio.Event()
        self._finalize = False
        self._task: asyncio.Task | None = None
        self._failure: Exception | None = None
        self._last_fed_chunk_seq = -1
        self._last_event_seq = 0
        self._timeline_offset_ms: int | None = None
        self._text_event_count = 0
        self._last_source_end_ms = 0
        self._last_model_revision = "no-asr-inference"
        self._vad = None
        self._known_segment_keys: set[str] = set()
        self._checkpoint_ready = False

    def start(self) -> None:
        if self._task is None:
            self._task = asyncio.create_task(self._run())
            self._wake.set()

    def notify_chunk(self) -> None:
        self._wake.set()

    async def finalize(self) -> None:
        self._finalize = True
        self._wake.set()
        if self._task is not None:
            await self._task
        self.ensure_available()

    def ensure_available(self) -> None:
        if self._failure is not None:
            raise VNextRealtimePipelineFailure(self._failure) from self._failure

    async def close(self) -> None:
        if self._task is None or self._task.done():
            return
        self._task.cancel()
        try:
            await self._task
        except asyncio.CancelledError:
            pass

    async def _run(self) -> None:
        try:
            resume = await asyncio.to_thread(
                vnext_realtime_store.get_realtime_pipeline_resume,
                self.context,
                self.session_id,
            )
            self._last_event_seq = int(resume["session"]["last_durable_event_seq"])
            self._text_event_count = sum(
                1 for event in resume["stable_segments"]
                if event["outcome"] == "text"
            )
            self._known_segment_keys = {
                str(event["stable_segment_key"])
                for event in resume["stable_segments"]
                if event["stable_segment_key"]
            }
            if resume["stable_segments"]:
                self._last_source_end_ms = max(
                    int(event["source_end_ms"]) for event in resume["stable_segments"]
                )
                persisted = resume["last_stable"]
                if persisted is not None:
                    identity = f"{self.session_id}:event:{int(persisted['event_seq'])}"
                    plaintext = vnext_realtime_crypto.open_event(
                        identity, bytes(persisted["encrypted_payload"]),
                    )
                    decoded = json.loads(plaintext.decode("utf-8"))
                    self._last_model_revision = str(
                        decoded.get("model_revision") or self._last_model_revision
                    )
            self._vad = await self.vad_factory()
            while True:
                await self._wake.wait()
                self._wake.clear()
                await self._drain_chunks()
                if self._finalize:
                    await self._finish()
                    return
        except asyncio.CancelledError:
            raise
        except Exception as error:
            self._failure = error

    async def _drain_chunks(self) -> None:
        chunks = await asyncio.to_thread(
            vnext_realtime_store.get_unconsumed_chunks,
            self.context,
            self.session_id,
        )
        for chunk in chunks:
            chunk_seq = int(chunk["chunk_seq"])
            if chunk_seq <= self._last_fed_chunk_seq:
                continue
            pcm = await asyncio.to_thread(
                vnext_realtime_crypto.read_chunk,
                str(chunk["encrypted_spool_locator"]),
            )
            if self._timeline_offset_ms is None:
                self._timeline_offset_ms = int(chunk["start_ms"])
            self._last_source_end_ms = max(self._last_source_end_ms, int(chunk["end_ms"]))
            audio = np.frombuffer(pcm, dtype="<i2").astype(np.float32) / 32768.0
            segments = []
            for offset in range(0, len(audio), 512):
                segment = await asyncio.to_thread(self._vad.feed, audio[offset:offset + 512])
                if segment is not None:
                    segments.append(segment)
            self._last_fed_chunk_seq = chunk_seq
            if segments:
                self._checkpoint_ready = True
                await self._publish_segments(segments)
            if self._checkpoint_ready and getattr(self._vad, "state", "idle") == "idle":
                locators = await asyncio.to_thread(
                    vnext_realtime_store.advance_chunk_consumption,
                    self.context,
                    self.session_id,
                    through_chunk_seq=chunk_seq,
                    worker_generation=self.worker_generation,
                )
                for locator in locators:
                    await asyncio.to_thread(vnext_realtime_crypto.delete_chunk, locator)
                self._checkpoint_ready = False

    def _segment_request(self, segment) -> tuple[str, bytes, int, int]:
        offset = self._timeline_offset_ms or 0
        source_start_ms = offset + int(segment.start_ms)
        source_end_ms = offset + int(segment.end_ms)
        identity_seed = (
            f"{self.asset_generation}\0{source_start_ms}\0{source_end_ms}"
        ).encode("utf-8")
        stable_key = "segment:" + hashlib.sha256(identity_seed).hexdigest()[:40]
        pcm16 = (np.clip(segment.audio_data, -1.0, 1.0) * 32767.0).astype("<i2").tobytes()
        return stable_key, pcm16, source_start_ms, source_end_ms

    async def _publish_segments(self, segments: list) -> None:
        """Use one ASR request for multiple VAD segments from one durable drain."""
        requests = []
        for segment in segments:
            stable_key, pcm16, source_start_ms, source_end_ms = self._segment_request(segment)
            if stable_key in self._known_segment_keys:
                continue
            requests.append((segment, stable_key, pcm16, source_start_ms, source_end_ms))
        if not requests:
            return
        if len(requests) == 1:
            segment, stable_key, pcm16, source_start_ms, source_end_ms = requests[0]
            result = await asyncio.to_thread(
                self.asr_call,
                item_id=stable_key,
                pcm_int16=pcm16,
                source_start_ms=source_start_ms,
                source_end_ms=source_end_ms,
            )
            await self._commit_segment(
                segment, stable_key, pcm16, source_start_ms, source_end_ms, result,
            )
            return

        items = [{
            "id": stable_key,
            "pcm_base64": base64.b64encode(pcm16).decode("ascii"),
            "sample_rate": 16_000,
            "language": "Chinese",
            "source_start_ms": source_start_ms,
            "source_end_ms": source_end_ms,
        } for _segment, stable_key, pcm16, source_start_ms, source_end_ms in requests]
        response = await asyncio.to_thread(
            self.asr_batch_call,
            items=items,
            priority="realtime",
        )
        results = response.get("items") if isinstance(response, dict) else None
        if not isinstance(results, list) or len(results) != len(requests):
            raise RuntimeError("realtime_asr_batch_response_invalid")
        by_id = {str(item.get("id")): item for item in results if isinstance(item, dict)}
        if len(by_id) != len(results):
            raise RuntimeError("realtime_asr_batch_response_invalid")
        validated = []
        for segment, stable_key, pcm16, source_start_ms, source_end_ms in requests:
            result = by_id.get(stable_key)
            if result is None:
                raise RuntimeError("realtime_asr_batch_item_missing")
            if (
                int(result.get("source_start_ms", -1)) != source_start_ms
                or int(result.get("source_end_ms", -1)) != source_end_ms
                or str(result.get("stable_segment_key") or stable_key) != stable_key
            ):
                raise RuntimeError("realtime_asr_batch_item_mismatch")
            validated.append(
                (segment, stable_key, pcm16, source_start_ms, source_end_ms, result)
            )
        for segment, stable_key, pcm16, source_start_ms, source_end_ms, result in validated:
            await self._commit_segment(
                segment, stable_key, pcm16, source_start_ms, source_end_ms, result,
            )

    async def _publish_segment(self, segment) -> None:
        await self._publish_segments([segment])

    async def _commit_segment(
        self,
        segment,
        stable_key: str,
        pcm16: bytes,
        source_start_ms: int,
        source_end_ms: int,
        result: dict[str, Any],
    ) -> None:
        self._last_model_revision = str(result["model_revision"])
        self._last_event_seq += 1
        event = TranscriptStreamEventV2(
            schema_version=2,
            contract_revision="transcript.stream.v2",
            session_id=self.session_id,
            event_sequence=self._last_event_seq,
            event_kind="stable",
            stable_segment_key=stable_key,
            segment_revision=int(result["segment_revision"]),
            text_state="stable",
            outcome=result["outcome"],
            text=result["text"],
            source_start_ms=source_start_ms,
            source_end_ms=source_end_ms,
            model_revision=result["model_revision"],
        ).model_dump()
        payload = json.dumps(event, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
        envelope = vnext_realtime_crypto.seal_event(
            f"{self.session_id}:event:{self._last_event_seq}", payload,
        )
        await asyncio.to_thread(
            vnext_realtime_store.append_durable_event,
            self.context,
            self.session_id,
            event_seq=self._last_event_seq,
            event_kind="stable",
            stable_segment_key=stable_key,
            segment_revision=int(result["segment_revision"]),
            outcome=result["outcome"],
            source_start_ms=source_start_ms,
            source_end_ms=source_end_ms,
            payload_sha256="sha256:" + hashlib.sha256(payload).hexdigest(),
            encrypted_payload=envelope,
            worker_generation=self.worker_generation,
        )
        self._known_segment_keys.add(stable_key)
        if result["outcome"] == "text":
            self._text_event_count += 1
        await self.send_event(event)
        if (
            result["outcome"] == "text"
            and hasattr(self.context, "device_id")
            and hasattr(self.context, "epoch_id")
        ):
            try:
                await vnext_speaker_pipeline.collect_realtime_speaker_segment(
                    self.context,
                    self.session_id,
                    stable_segment_key=stable_key,
                    source_start_ms=source_start_ms,
                    source_end_ms=source_end_ms,
                    pcm_bytes=pcm16,
                    worker_generation=self.worker_generation,
                )
            except Exception as error:
                # Speaker attribution is an optional late overlay. It must never
                # turn an already durable text event into a transcript failure.
                _logger.warning(
                    "vnext speaker segment collection failed: %s",
                    type(error).__name__,
                )

    async def _finish(self) -> None:
        remaining = await asyncio.to_thread(
            vnext_realtime_store.get_unconsumed_chunks,
            self.context,
            self.session_id,
        )
        for segment in await asyncio.to_thread(_flush_vad, self._vad):
            await self._publish_segment(segment)
        self._last_event_seq += 1
        outcome = "text" if self._text_event_count else "no_speech"
        event = TranscriptStreamEventV2(
            schema_version=2,
            contract_revision="transcript.stream.v2",
            session_id=self.session_id,
            event_sequence=self._last_event_seq,
            event_kind="final",
            stable_segment_key=None,
            segment_revision=1,
            text_state="final",
            outcome=outcome,
            text="",
            source_start_ms=0,
            source_end_ms=max(
                [self._last_source_end_ms]
                + [int(chunk["end_ms"]) for chunk in remaining]
            ),
            model_revision=self._last_model_revision,
        ).model_dump()
        payload = json.dumps(event, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
        envelope = vnext_realtime_crypto.seal_event(
            f"{self.session_id}:event:{self._last_event_seq}", payload,
        )
        await asyncio.to_thread(
            vnext_realtime_store.append_terminal_event_and_complete_task,
            self.context,
            self.session_id,
            event_seq=self._last_event_seq,
            outcome=outcome,
            source_start_ms=event["source_start_ms"],
            source_end_ms=event["source_end_ms"],
            payload_sha256="sha256:" + hashlib.sha256(payload).hexdigest(),
            encrypted_payload=envelope,
            consume_through_chunk_seq=(
                self._last_fed_chunk_seq if self._last_fed_chunk_seq >= 0 else None
            ),
            worker_generation=self.worker_generation,
            attempt_id=self.attempt_id,
            lease_owner=self.lease_owner,
        )
        for chunk in remaining:
            await asyncio.to_thread(
                vnext_realtime_crypto.delete_chunk,
                str(chunk["encrypted_spool_locator"]),
            )
        await self.send_event(event)
        if hasattr(self.context, "device_id") and hasattr(self.context, "epoch_id"):
            try:
                await vnext_speaker_pipeline.finalize_realtime_speaker(
                    self.context,
                    self.session_id,
                )
            except Exception as error:
                _logger.warning(
                    "vnext speaker finalization failed: %s",
                    type(error).__name__,
                )
