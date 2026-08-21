"""Qwen3-ASR WebSocket adapter for LaoJi schedule and meeting capture.

The mobile contract is shared by schedule and meeting capture:

* client sends binary int16/16 kHz/mono PCM frames and an empty frame to stop;
* server emits config, transcript.completed, error, and ready_to_stop events;
* schedule sessions do not load speaker models or persist transcripts;
* meeting sessions keep user-scoped speaker recognition and persistence.

Qwen3-ASR inference runs behind the local 8030 service; this module owns only
the realtime WebSocket contract, VAD, speaker identity and transcript writes.
"""

import asyncio
import contextlib
import json
import os
import traceback
import urllib.parse
import urllib.request
import uuid
from collections import defaultdict
from datetime import datetime

import numpy as np
from fastapi import APIRouter, WebSocket, WebSocketDisconnect

from app.database import async_session
from app.models.meeting import Meeting
from app.models.transcript import TranscriptLine
from app.api.ws_auth import authorize_app_meeting_ws_context
from app.services.guest_meeting_session_service import append_guest_transcript
from app.privacy_logging import privacy_log

router = APIRouter()

QWEN_ASR_URL = os.getenv("QWEN_ASR_URL", "http://127.0.0.1:8030/asr")
QWEN_ASR_HEALTH_URL = os.getenv(
    "QWEN_ASR_HEALTH_URL",
    "http://127.0.0.1:8030/health",
)
QWEN_ASR_LANG = os.getenv("QWEN_ASR_LANG", "Chinese")
QWEN_ASR_REQUEST_TIMEOUT_SECONDS = float(
    os.getenv("QWEN_ASR_REQUEST_TIMEOUT_SECONDS", "60")
)
QWEN_ASR_SEGMENT_QUEUE_SIZE = max(
    1,
    int(os.getenv("QWEN_ASR_SEGMENT_QUEUE_SIZE", "16")),
)
QWEN_SCHEDULE_PREVIEW_INITIAL_MS = max(
    640,
    int(os.getenv("QWEN_SCHEDULE_PREVIEW_INITIAL_MS", "640")),
)
QWEN_SCHEDULE_PREVIEW_INTERVAL_MS = max(
    800,
    int(os.getenv("QWEN_SCHEDULE_PREVIEW_INTERVAL_MS", "1600")),
)
QWEN_SCHEDULE_PREVIEW_MAX = max(
    1,
    min(8, int(os.getenv("QWEN_SCHEDULE_PREVIEW_MAX", "4"))),
)
_CLUSTER_THRESHOLD = 0.5
_SPK_COS_THRESHOLD = 0.70
_SPK_GAP_MIN = 0.08
_SPK_MIN_AUDIO_MS = 1_200
_SPK_MIN_VOTES = 2


async def _persist_transcript(
    meeting_id: str,
    speaker_id: str,
    text: str,
    start_ms: float,
    end_ms: float,
    confidence: float,
    speaker_name: str | None = None,
) -> None:
    """Persist only transcripts whose canonical meeting still exists."""
    try:
        async with async_session() as db:
            meeting = await db.get(Meeting, meeting_id)
            if meeting is None:
                return
            db.add(
                TranscriptLine(
                    id=str(uuid.uuid4()),
                    meeting_id=meeting_id,
                    speaker_id=speaker_id,
                    speaker_label=speaker_name or speaker_id,
                    text=text,
                    start_time=start_ms / 1000.0,
                    end_time=end_ms / 1000.0,
                    confidence=confidence,
                    created_at=datetime.utcnow(),
                )
            )
            await db.commit()
    except Exception as error:
        print(
            f"[Qwen3-ASR] 转写持久化失败: {type(error).__name__}",
            flush=True,
        )


def _vad_settings_for_purpose(purpose: str) -> dict:
    """Use purpose-specific segmentation tuned for schedule and meeting input."""
    return {
        # A brief thinking pause inside a schedule request is not a sentence
        # boundary. The previous 450 ms threshold split ordinary Chinese speech
        # into many independent ASR jobs, each of which added its own full stop.
        # Meeting capture still needs bounded-latency updates, but 400 ms split
        # ordinary thinking pauses into sentence-sized ASR jobs. 650 ms keeps
        # natural clauses together while max_speech_ms continues to guarantee
        # an update during uninterrupted speech.
        "silence_ms": 650.0 if purpose == "meeting" else 900.0,
        "pre_roll_ms": 400.0,
        "initial_pre_roll_ms": 200.0 if purpose == "meeting" else 400.0,
        # Keep realtime meeting chunks below the ASR queue's long-segment
        # cliff. A schedule utterance is short and benefits from staying whole
        # across the time phrase and the action at its tail.
        "max_speech_ms": 4500.0 if purpose == "meeting" else 12000.0,
        "energy_threshold": 0.0002,
    }


def _qwen_service_health() -> dict | None:
    try:
        with urllib.request.urlopen(QWEN_ASR_HEALTH_URL, timeout=3) as response:
            payload = json.loads(response.read().decode("utf-8"))
        return payload if payload.get("ready") is True else None
    except Exception:
        return None


def _qwen_transcribe(
    pcm_int16_bytes: bytes,
    language: str = "Chinese",
    priority: str = "realtime",
) -> dict:
    if priority not in {"realtime", "schedule", "offline"}:
        raise ValueError("qwen_asr_priority_invalid")
    query = urllib.parse.urlencode({"language": language, "priority": priority})
    request = urllib.request.Request(
        "%s?%s" % (QWEN_ASR_URL, query),
        data=pcm_int16_bytes,
        headers={"Content-Type": "application/octet-stream"},
    )
    with urllib.request.urlopen(
        request,
        timeout=QWEN_ASR_REQUEST_TIMEOUT_SECONDS,
    ) as response:
        payload = json.loads(response.read().decode("utf-8"))
    if "error" in payload:
        raise RuntimeError(payload["error"])
    return payload


def _speaker_profiles_for_context(speaker_db, auth_context):
    if auth_context.mode == "user" and auth_context.user_id is not None:
        return speaker_db.load_for_owner(auth_context.user_id, active_only=True)
    if (
        auth_context.mode == "device"
        and auth_context.user_id is not None
        and auth_context.epoch_id
    ):
        return speaker_db.load_for_owner_epoch(
            auth_context.user_id,
            auth_context.epoch_id,
            active_only=True,
        )
    if auth_context.mode == "prototype":
        return speaker_db.load_all(active_only=True)
    return []


def _cache_guest_transcript(auth_context, session_id: str, message: dict) -> dict:
    """Cache a final guest line and expose its stable identity to the client."""
    if auth_context.mode != "guest" or message.get("type") != "transcript.completed":
        return message
    stored = append_guest_transcript(
        session_id,
        speaker_id=message.get("speaker_id"),
        speaker_label=message.get("speaker_name"),
        text=str(message.get("text") or ""),
        start_time=message.get("start_time"),
        end_time=message.get("end_time"),
        confidence=message.get("speaker_confidence"),
    )
    if stored is None:
        return message
    return {**message, "id": stored["id"]}


def _build_speaker_engine(model_manager, speaker_profiles):
    """Reuse the warm CAM++ model without leaking profiles across users."""
    try:
        from app.asr.enhanced_engine import EnhancedRecognitionEngine
        from app.asr.model_manager import SpeakerEmbeddingExtractor
        from app.services.speaker_db_service import bytes_to_ndarray

        camp_model = model_manager.get_camp_model()
        if camp_model is None:
            return None
        extractor = SpeakerEmbeddingExtractor(
            camp_model,
            device=model_manager.device,
        )
        engine = EnhancedRecognitionEngine(extractor)
        for profile in speaker_profiles:
            embedding = bytes_to_ndarray(profile.get("embedding"))
            if embedding is None:
                continue
            engine.register_embedding(
                profile["speaker_id"],
                embedding,
                name=profile.get("name"),
                role=profile.get("role"),
            )
        return engine
    except Exception as exc:
        privacy_log(
            "asr_speaker_engine_unavailable",
            capability="transcript.realtime",
            error_type=type(exc).__name__,
            status="degraded",
        )
        return None


def _identify(engine, audio_f32):
    try:
        result = engine.identify(audio_f32)
        if result and result.matches:
            top = result.matches[0]
            second = (
                float(result.matches[1].cosine_score)
                if len(result.matches) > 1
                else 0.0
            )
            return {
                "speaker_id": top.speaker_id,
                "name": top.name or top.speaker_id,
                "cos": float(top.cosine_score),
                "gap": float(top.cosine_score) - second,
            }
    except Exception as exc:
        privacy_log(
            "asr_speaker_identification_failed",
            capability="transcript.realtime",
            error_type=type(exc).__name__,
        )
    return None


class _OnlineSpeakerCluster:
    def __init__(self, threshold: float = _CLUSTER_THRESHOLD):
        self.threshold = threshold
        self.centroids = []

    def assign(self, embedding):
        if embedding is None or np.linalg.norm(embedding) < 1e-6:
            return None
        best = None
        best_similarity = -1.0
        for centroid in self.centroids:
            similarity = float(
                np.dot(embedding, centroid["embedding"])
                / (
                    np.linalg.norm(embedding)
                    * np.linalg.norm(centroid["embedding"])
                    + 1e-8
                )
            )
            if similarity > best_similarity:
                best_similarity = similarity
                best = centroid
        if best is not None and best_similarity >= self.threshold:
            best["embedding"] = (
                best["embedding"] * best["count"] + embedding
            ) / (best["count"] + 1)
            best["count"] += 1
            return best["label"]
        label = "speaker_%d" % (len(self.centroids) + 1)
        self.centroids.append(
            {"label": label, "embedding": embedding.copy(), "count": 1}
        )
        return label


def _configure_vad(vad, purpose: str) -> dict:
    settings = _vad_settings_for_purpose(purpose)
    vad.set_max_speech_duration(settings["max_speech_ms"])
    vad.set_min_energy_threshold(settings["energy_threshold"])
    vad.set_min_silence_duration(settings["silence_ms"])
    vad.set_pre_roll_duration(
        settings["pre_roll_ms"],
        initial_duration_ms=settings["initial_pre_roll_ms"],
    )
    return settings


def _flush_vad(vad) -> list:
    """Advance VAD with bounded silence and return every final segment."""
    segments = []
    for _ in range(40):
        segment = vad.feed(np.zeros(512, dtype=np.float32))
        if segment is not None:
            segments.append(segment)
        if getattr(vad, "state", "idle") == "idle":
            break
    return segments


@router.websocket("/ws/meeting/{meeting_id}/qwen")
async def qwen_meeting_websocket_endpoint(websocket: WebSocket, meeting_id: str):
    await _serve_qwen(
        websocket,
        meeting_id,
        purpose="meeting",
        enable_speaker_recognition=True,
        persist_transcript=True,
    )


@router.websocket("/ws/laoji/schedule/{session_id}/qwen")
async def qwen_schedule_websocket_endpoint(websocket: WebSocket, session_id: str):
    await _serve_qwen(
        websocket,
        session_id,
        purpose="schedule",
        enable_speaker_recognition=False,
        persist_transcript=False,
    )


async def _serve_qwen(
    websocket: WebSocket,
    session_id: str,
    *,
    purpose: str,
    enable_speaker_recognition: bool,
    persist_transcript: bool,
):
    await websocket.accept()
    auth_context = await authorize_app_meeting_ws_context(
        websocket,
        session_id,
        require_binding=purpose == "meeting",
    )
    if auth_context is None:
        return

    health = await asyncio.to_thread(_qwen_service_health)
    if health is None:
        await websocket.send_json(
            {
                "type": "error",
                "message": "Qwen3-ASR 服务尚未就绪，请稍后重试",
            }
        )
        return

    model_name = str(health.get("model") or "Qwen3-ASR")
    try:
        await websocket.send_json(
            {
                "type": "config",
                "useAudioWorklet": True,
                "mode": "full",
                "purpose": purpose,
                "source": "qwen3-asr",
                "model": model_name,
                "transcript_revision_protocol": "replace_by_revision_key_v1",
            }
        )
    except Exception:
        return

    from app.asr.model_manager import get_model_manager
    from app.asr.streaming_vad import StreamingVAD

    model_manager = get_model_manager()
    if not model_manager.is_initialized():
        await model_manager.initialize()

    speaker_profiles = []
    speaker_engine = None
    if enable_speaker_recognition:
        from app.services.speaker_db_service import get_speaker_db

        speaker_profiles = _speaker_profiles_for_context(
            get_speaker_db(),
            auth_context,
        )
        speaker_engine = await asyncio.to_thread(
            _build_speaker_engine,
            model_manager,
            speaker_profiles,
        )

    extractor = getattr(speaker_engine, "extractor", None)
    cluster = _OnlineSpeakerCluster()
    cluster_identity_votes = defaultdict(
        lambda: defaultdict(lambda: {"count": 0, "score_sum": 0.0, "name": None})
    )
    vad_model = await asyncio.to_thread(model_manager.create_vad_model)
    vad = StreamingVAD(vad_model)
    vad_settings = _configure_vad(vad, purpose)

    privacy_log(
        "asr_session_ready",
        capability="transcript.realtime",
        purpose=purpose,
        model_revision=model_name,
        count=len(speaker_profiles),
        status="ready",
    )

    segment_queue = asyncio.Queue(maxsize=QWEN_ASR_SEGMENT_QUEUE_SIZE)

    async def process_segment(
        segment,
        *,
        is_final: bool,
        revision_key: str | None,
    ):
        audio = segment.audio_data
        if audio is None or len(audio) < 1600:
            return
        request_started = asyncio.get_running_loop().time()
        pcm16 = (
            np.clip(audio, -1.0, 1.0) * 32767.0
        ).astype(np.int16).tobytes()
        try:
            result = await asyncio.to_thread(
                _qwen_transcribe,
                pcm16,
                QWEN_ASR_LANG,
                "realtime" if purpose == "meeting" else "schedule",
            )
        except Exception as exc:
            privacy_log(
                "asr_transcription_failed",
                capability="transcript.realtime",
                error_type=type(exc).__name__,
                status="failure",
            )
            if is_final:
                with contextlib.suppress(Exception):
                    await websocket.send_json(
                        {
                            "type": "error",
                            "message": "Qwen3-ASR 转写失败，请重试",
                        }
                    )
            return

        text = str(result.get("text") or "").strip()
        if not text:
            return

        privacy_log(
            "asr_transcript_emitted",
            capability="transcript.realtime",
            purpose=purpose,
            stage="final" if is_final else "preview",
            status="ready",
            duration_ms=int(len(audio) * 1000 / 16000),
            wall_ms=round(
                (asyncio.get_running_loop().time() - request_started) * 1000,
                3,
            ),
            infer_ms=result.get("infer_ms"),
        )

        speaker_label = "unknown" if purpose == "schedule" else "speaker_1"
        identified = False
        identity_name = None
        identity_id = None
        confidence = 0.0
        best_name = None
        best_score = None
        if extractor is not None:
            try:
                embedding = await asyncio.to_thread(extractor.extract, audio)
                speaker_label = cluster.assign(embedding) or speaker_label
            except Exception:
                pass

        if speaker_engine is not None:
            identification = await asyncio.to_thread(
                _identify,
                speaker_engine,
                audio,
            )
            if identification:
                best_name = identification["name"]
                best_score = identification["cos"]
                segment_duration_ms = int(segment.end_ms) - int(segment.start_ms)
                if (
                    identification["cos"] >= _SPK_COS_THRESHOLD
                    and identification["gap"] >= _SPK_GAP_MIN
                    and segment_duration_ms >= _SPK_MIN_AUDIO_MS
                ):
                    vote = cluster_identity_votes[speaker_label][
                        identification["speaker_id"]
                    ]
                    vote["count"] += 1
                    vote["score_sum"] += float(identification["cos"])
                    vote["name"] = best_name
                privacy_log(
                    "asr_speaker_score",
                    capability="transcript.realtime",
                    status=("accepted" if (
                        identification["cos"] >= _SPK_COS_THRESHOLD
                        and identification["gap"] >= _SPK_GAP_MIN
                        and segment_duration_ms >= _SPK_MIN_AUDIO_MS
                    ) else "rejected"),
                    duration_ms=segment_duration_ms,
                )
            votes = cluster_identity_votes.get(speaker_label)
            if votes:
                identity_id, identity_vote = max(
                    votes.items(),
                    key=lambda item: (item[1]["count"], item[1]["score_sum"]),
                )
                if identity_vote["count"] >= _SPK_MIN_VOTES:
                    identity_name = identity_vote["name"] or identity_id
                    identified = True
                    confidence = float(
                        identity_vote["score_sum"] / identity_vote["count"]
                    )

        display_name = identity_name if identified else speaker_label
        output_speaker_id = str(identity_id) if identified else speaker_label
        message = {
            "type": "transcript.completed" if is_final else "transcript.partial",
            "source": "qwen3-asr",
            "model": str(result.get("model") or model_name),
            "purpose": purpose,
            "speaker_id": output_speaker_id,
            "speaker_name": display_name,
            "text": text,
            "start_ms": int(segment.start_ms),
            "end_ms": int(segment.end_ms),
            "start_time": segment.start_ms / 1000.0,
            "end_time": segment.end_ms / 1000.0,
            "is_final": is_final,
            "revision_key": revision_key,
            "speaker_confidence": confidence,
            "identified": identified,
            "best_guess_name": best_name,
            "best_guess_score": best_score,
            "segment_reason": getattr(segment, "segment_reason", None),
            "infer_ms": result.get("infer_ms"),
        }
        if persist_transcript and is_final:
            message = _cache_guest_transcript(auth_context, session_id, message)
        try:
            await websocket.send_json(message)
        except Exception:
            return
        if persist_transcript and is_final and auth_context.mode != "guest":
            asyncio.create_task(
                _persist_transcript(
                    meeting_id=session_id,
                    speaker_id=output_speaker_id,
                    text=text,
                    start_ms=segment.start_ms,
                    end_ms=segment.end_ms,
                    confidence=confidence,
                    speaker_name=display_name,
                )
            )

    preview_in_flight = False
    preview_effective_ms_by_start: dict[int, int] = {}

    async def segment_worker():
        nonlocal preview_in_flight
        while True:
            job = await segment_queue.get()
            try:
                if job is None:
                    return
                segment, is_final, revision_key = job
                await process_segment(
                    segment,
                    is_final=is_final,
                    revision_key=revision_key,
                )
            finally:
                if job is not None and not job[1]:
                    preview_in_flight = False
                segment_queue.task_done()

    worker_task = asyncio.create_task(segment_worker())
    clean_stop = False
    disconnected = False
    received_frame_count = 0
    received_pcm_bytes = 0
    active_speech_observation_count = 0
    preview_enqueued_count = 0
    final_enqueued_count = 0
    try:
        while True:
            frame = await websocket.receive_bytes()
            if frame == b"":
                clean_stop = True
                tail_segments = await asyncio.to_thread(_flush_vad, vad)
                for segment in tail_segments:
                    revision_key = (
                        "schedule:%d" % int(segment.start_ms)
                        if purpose == "schedule"
                        else None
                    )
                    final_enqueued_count += 1
                    await segment_queue.put((segment, True, revision_key))
                break
            if len(frame) % 2 != 0:
                await websocket.send_json(
                    {"type": "error", "message": "语音帧格式无效"}
                )
                continue
            received_frame_count += 1
            received_pcm_bytes += len(frame)
            pcm = np.frombuffer(frame, dtype=np.int16).astype(np.float32) / 32768.0
            segment = await asyncio.to_thread(vad.feed, pcm)
            if segment is not None:
                revision_key = (
                    "schedule:%d" % int(segment.start_ms)
                    if purpose == "schedule"
                    else None
                )
                preview_effective_ms_by_start.pop(int(segment.start_ms), None)
                final_enqueued_count += 1
                await segment_queue.put((segment, True, revision_key))
            elif (
                purpose == "schedule"
                and not preview_in_flight
                and preview_enqueued_count < QWEN_SCHEDULE_PREVIEW_MAX
            ):
                active_window = vad.active_speech_window()
                if active_window is None:
                    continue
                active_speech_observation_count += 1
                start_ms, effective_ms = active_window
                previous_ms = preview_effective_ms_by_start.get(start_ms)
                preview_due = (
                    effective_ms >= QWEN_SCHEDULE_PREVIEW_INITIAL_MS
                    if previous_ms is None
                    else effective_ms - previous_ms >= QWEN_SCHEDULE_PREVIEW_INTERVAL_MS
                )
                if not preview_due:
                    continue
                preview = vad.snapshot_active_speech()
                if preview is None:
                    continue
                preview_in_flight = True
                preview_effective_ms_by_start[start_ms] = effective_ms
                preview_enqueued_count += 1
                privacy_log(
                    "asr_preview_enqueued",
                    capability="transcript.realtime",
                    purpose=purpose,
                    status="queued",
                    duration_ms=int(len(preview.audio_data) * 1000 / 16000),
                    audio_ms=effective_ms,
                )
                await segment_queue.put(
                    (preview, False, "schedule:%d" % start_ms)
                )
    except WebSocketDisconnect:
        disconnected = True
        privacy_log(
            "asr_client_disconnected",
            capability="transcript.realtime",
            purpose=purpose,
            status="disconnected",
        )
    except Exception as exc:
        privacy_log(
            "asr_websocket_failed",
            capability="transcript.realtime",
            purpose=purpose,
            error_type=type(exc).__name__,
            status="failure",
        )
    finally:
        await segment_queue.put(None)
        with contextlib.suppress(Exception):
            await worker_task
        if clean_stop and not disconnected:
            with contextlib.suppress(Exception):
                await websocket.send_json({"type": "ready_to_stop"})
        privacy_log(
            "asr_session_cleaned",
            capability="transcript.realtime",
            purpose=purpose,
            status="closed",
            count=received_frame_count,
            bytes=received_pcm_bytes,
        )
        privacy_log(
            "asr_session_active_speech_observations",
            capability="transcript.realtime",
            purpose=purpose,
            status="closed",
            count=active_speech_observation_count,
        )
        privacy_log(
            "asr_session_enqueued_segments",
            capability="transcript.realtime",
            purpose=purpose,
            status="closed",
            count=preview_enqueued_count,
            segments=final_enqueued_count,
        )
