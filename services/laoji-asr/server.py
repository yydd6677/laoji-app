"""Compact Qwen3-ASR service shared by realtime and batch transcription.

Public contracts:
  * ``POST /asr`` keeps the legacy 16 kHz signed-int16 PCM contract.
  * ``POST /v1/asr/batch`` accepts one to eight base64 PCM items.
  * ``POST /v2/asr/batch`` adds stable segment revisions and NO_SPEECH outcomes.
  * ``GET /health`` and ``GET /ready`` expose non-sensitive runtime state.

All inference is serialized by one priority coordinator.  The queue priority is
``realtime`` > ``schedule`` > ``offline``; an inference call already executing
on the GPU cannot be preempted.
"""

from __future__ import annotations

import base64
import binascii
from dataclasses import dataclass, field
from datetime import datetime, timezone
import itertools
import json
import os
from pathlib import Path
import queue
import re
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Callable
from urllib.parse import parse_qs, urlparse

os.environ.setdefault("HF_ENDPOINT", "https://hf-mirror.com")
os.environ.setdefault("HF_HUB_OFFLINE", "1")

import numpy as np
import torch


MODEL = None
MODEL_ID = os.getenv("QWEN_ASR_MODEL", "Qwen/Qwen3-ASR-1.7B").strip()
DEVICE = os.getenv("QWEN_ASR_DEVICE", "cuda:0").strip()
MAX_BATCH_SIZE = max(1, min(8, int(os.getenv("QWEN_ASR_MAX_BATCH_SIZE", "8"))))
MAX_NEW_TOKENS = max(32, int(os.getenv("QWEN_ASR_MAX_NEW_TOKENS", "256")))
MAX_AUDIO_BYTES = max(
    32_000,
    int(os.getenv("QWEN_ASR_MAX_AUDIO_BYTES", str(8 * 1024 * 1024))),
)
MAX_BATCH_REQUEST_BYTES = max(
    MAX_AUDIO_BYTES,
    int(
        os.getenv(
            "QWEN_ASR_MAX_BATCH_REQUEST_BYTES",
            str(MAX_AUDIO_BYTES * MAX_BATCH_SIZE * 4 // 3 + 1024 * 1024),
        )
    ),
)
MAX_QUEUED_REQUESTS = max(1, int(os.getenv("QWEN_ASR_MAX_QUEUED_REQUESTS", "64")))
MICROBATCH_ENABLED = os.getenv("QWEN_ASR_MICROBATCH_ENABLED", "1").strip().lower() in {
    "1", "true", "yes", "on",
}
MICROBATCH_WINDOW_SECONDS = max(
    0.0,
    min(0.050, float(os.getenv("QWEN_ASR_MICROBATCH_WINDOW_MS", "12")) / 1000.0),
)
MICROBATCH_MAX_ITEMS = max(
    1,
    min(MAX_BATCH_SIZE, int(os.getenv("QWEN_ASR_MICROBATCH_MAX_ITEMS", "8"))),
)
MICROBATCH_MAX_AUDIO_MS = max(
    1_000,
    int(os.getenv("QWEN_ASR_MICROBATCH_MAX_AUDIO_MS", "14000")),
)
# VAD normally removes silence before this service is called, but imports and
# short schedule recordings can still contain a complete low-energy window.
# Keep the gate conservative so quiet speech is still sent to Qwen; callers
# that need a different microphone floor can tune it without changing the
# contract or the model path.
SILENCE_RMS_THRESHOLD = max(
    0.0,
    min(0.05, float(os.getenv("QWEN_ASR_SILENCE_RMS_THRESHOLD", "0.0005"))),
)
SILENCE_PEAK_THRESHOLD = max(
    0.0,
    min(0.2, float(os.getenv("QWEN_ASR_SILENCE_PEAK_THRESHOLD", "0.002"))),
)
REQUEST_WAIT_SECONDS = max(
    10.0,
    float(os.getenv("QWEN_ASR_REQUEST_WAIT_SECONDS", "900")),
)
MODEL_REVISION = os.getenv("QWEN_ASR_MODEL_REVISION", "").strip()

PRIORITY_ORDER = {"realtime": 0, "schedule": 1, "offline": 2}
LANGUAGE_MAP = {
    "zh": "Chinese",
    "chinese": "Chinese",
    "en": "English",
    "english": "English",
}
ITEM_ID_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$")


class AsrServiceError(RuntimeError):
    def __init__(self, code: str, message: str, status: int = 400):
        super().__init__(code)
        self.code = code
        self.message = message
        self.status = status


@dataclass
class InferenceItem:
    item_id: str
    pcm: np.ndarray
    language: str | None
    source_start_ms: int
    source_end_ms: int


@dataclass
class InferenceJob:
    priority: str
    items: list[InferenceItem]
    enqueued_at: float = field(default_factory=time.perf_counter)
    finished: threading.Event = field(default_factory=threading.Event)
    response: dict | None = None
    error: Exception | None = None


def _utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _resolve_model_revision(model_id: str) -> str:
    configured = MODEL_REVISION.strip()
    if configured:
        return configured
    model_path = Path(model_id).expanduser()
    if model_path.is_dir() and model_path.parent.name == "snapshots":
        return model_path.name
    if "/" in model_id and not model_path.exists():
        organization, name = model_id.split("/", 1)
        cache = (
            Path(os.getenv("HF_HOME", "~/.cache/huggingface")).expanduser()
            / "hub"
            / f"models--{organization}--{name}"
            / "refs"
            / "main"
        )
        try:
            revision = cache.read_text(encoding="utf-8").strip()
            if revision:
                return revision
        except OSError:
            pass
    return "unresolved"


def _normalize_language(value: object) -> str | None:
    raw = str(value or "Chinese").strip()
    if not raw or raw.lower() == "auto":
        return None
    return LANGUAGE_MAP.get(raw.lower(), raw)


def _decode_pcm(raw: bytes) -> np.ndarray:
    if not raw:
        return np.empty(0, dtype=np.float32)
    if len(raw) > MAX_AUDIO_BYTES:
        raise AsrServiceError("audio_too_large", "单段音频过大", 413)
    if len(raw) % 2:
        raise AsrServiceError("pcm_invalid", "PCM 音频必须使用 int16 采样", 400)
    return np.frombuffer(raw, dtype="<i2").astype(np.float32) / 32768.0


def _is_effectively_silent(pcm: np.ndarray) -> bool:
    """Return true only for empty or uniformly low-energy PCM.

    ASR models can hallucinate short interjections for digital silence. This
    deterministic guard runs before batching and therefore applies equally to
    legacy, v1 batch and v2 batch requests. Requiring both RMS and peak below
    their floors avoids classifying a quiet but real speech transient as empty.
    """
    if pcm.size == 0:
        return True
    if not np.isfinite(pcm).all():
        return False
    rms = float(np.sqrt(np.mean(np.square(pcm, dtype=np.float64))))
    peak = float(np.max(np.abs(pcm)))
    return rms <= SILENCE_RMS_THRESHOLD and peak <= SILENCE_PEAK_THRESHOLD


def _parse_batch_request(raw: bytes) -> tuple[str, list[InferenceItem]]:
    try:
        payload = json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise AsrServiceError("json_invalid", "批量转写请求不是有效 JSON", 400) from exc
    if not isinstance(payload, dict):
        raise AsrServiceError("request_invalid", "批量转写请求格式无效", 400)
    priority = str(payload.get("priority") or "offline").strip().lower()
    if priority not in PRIORITY_ORDER:
        raise AsrServiceError("priority_invalid", "转写优先级无效", 422)
    raw_items = payload.get("items")
    if not isinstance(raw_items, list) or not 1 <= len(raw_items) <= MAX_BATCH_SIZE:
        raise AsrServiceError(
            "batch_size_invalid",
            f"每批必须包含 1 到 {MAX_BATCH_SIZE} 段音频",
            422,
        )
    items: list[InferenceItem] = []
    seen_ids: set[str] = set()
    for raw_item in raw_items:
        if not isinstance(raw_item, dict):
            raise AsrServiceError("item_invalid", "批量转写项目格式无效", 422)
        item_id = str(raw_item.get("id") or "").strip()
        if not ITEM_ID_RE.fullmatch(item_id) or item_id in seen_ids:
            raise AsrServiceError("item_id_invalid", "转写项目标识无效或重复", 422)
        seen_ids.add(item_id)
        if raw_item.get("sample_rate", 16_000) != 16_000:
            raise AsrServiceError("sample_rate_invalid", "PCM 音频采样率必须为 16000 Hz", 422)
        encoded = raw_item.get("pcm_base64")
        if not isinstance(encoded, str) or not encoded:
            raise AsrServiceError("pcm_missing", "转写项目缺少 PCM 音频", 422)
        try:
            pcm_bytes = base64.b64decode(encoded, validate=True)
        except (binascii.Error, ValueError) as exc:
            raise AsrServiceError("pcm_base64_invalid", "PCM 音频编码无效", 422) from exc
        pcm = _decode_pcm(pcm_bytes)
        try:
            source_start_ms = int(raw_item.get("source_start_ms", 0))
            default_end = source_start_ms + round(pcm.size * 1000 / 16_000)
            source_end_ms = int(raw_item.get("source_end_ms", default_end))
        except (TypeError, ValueError) as exc:
            raise AsrServiceError("source_range_invalid", "音频源时间范围无效", 422) from exc
        if source_start_ms < 0 or source_end_ms < source_start_ms:
            raise AsrServiceError("source_range_invalid", "音频源时间范围无效", 422)
        items.append(
            InferenceItem(
                item_id=item_id,
                pcm=pcm,
                language=_normalize_language(raw_item.get("language", "Chinese")),
                source_start_ms=source_start_ms,
                source_end_ms=source_end_ms,
            )
        )
    return priority, items


def _parse_v2_batch_request(raw: bytes) -> tuple[str, list[InferenceItem]]:
    try:
        payload = json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise AsrServiceError("json_invalid", "批量转写请求不是有效 JSON", 400) from exc
    if not isinstance(payload, dict):
        raise AsrServiceError("request_invalid", "批量转写请求格式无效", 400)
    if payload.get("schema_version") != 2 or payload.get("contract_revision") != "asr.batch.v2":
        raise AsrServiceError("contract_revision_invalid", "批量转写合同版本无效", 422)
    if set(payload) != {"schema_version", "contract_revision", "priority", "items"}:
        raise AsrServiceError("request_fields_invalid", "批量转写请求字段无效", 422)
    raw_items = payload.get("items")
    if not isinstance(raw_items, list):
        raise AsrServiceError("batch_size_invalid", "批量转写项目无效", 422)
    allowed_item_fields = {
        "id", "pcm_base64", "sample_rate", "language",
        "source_start_ms", "source_end_ms",
    }
    for item in raw_items:
        if (
            not isinstance(item, dict)
            or not {"id", "pcm_base64", "source_start_ms", "source_end_ms"}.issubset(item)
            or not set(item).issubset(allowed_item_fields)
        ):
            raise AsrServiceError("item_fields_invalid", "批量转写项目字段无效", 422)
    return _parse_batch_request(raw)


def _v2_batch_response(batch: dict) -> dict:
    items = []
    for raw in batch["items"]:
        text = str(raw.get("text") or "").strip()
        items.append(
            {
                **raw,
                "stable_segment_key": raw["id"],
                "segment_revision": 1,
                "text_state": "stable",
                "outcome": "text" if text else "no_speech",
                "text": text,
            }
        )
    return {
        **batch,
        "schema_version": 2,
        "contract_revision": "asr.batch.v2",
        "items": items,
    }


class InferenceCoordinator:
    def __init__(
        self,
        model_getter: Callable[[], object | None],
        *,
        max_queued_requests: int = MAX_QUEUED_REQUESTS,
    ) -> None:
        self._model_getter = model_getter
        self._queue: queue.PriorityQueue[tuple[int, int, InferenceJob | None]] = (
            queue.PriorityQueue(maxsize=max_queued_requests)
        )
        self._sequence = itertools.count()
        self._metrics_lock = threading.Lock()
        self._pending = {name: 0 for name in PRIORITY_ORDER}
        self._active_priority: str | None = None
        self._last_inference: dict | None = None
        self._closed = False
        self._worker = threading.Thread(
            target=self._worker_loop,
            name="qwen3-asr-inference",
            daemon=True,
        )
        self._worker.start()

    def submit(self, priority: str, items: list[InferenceItem]) -> dict:
        if priority not in PRIORITY_ORDER:
            raise AsrServiceError("priority_invalid", "转写优先级无效", 422)
        if self._closed:
            raise AsrServiceError("service_stopping", "转写服务正在停止", 503)
        job = InferenceJob(priority=priority, items=items)
        entry = (PRIORITY_ORDER[priority], next(self._sequence), job)
        try:
            self._queue.put_nowait(entry)
        except queue.Full as exc:
            raise AsrServiceError("queue_full", "转写任务较多，请稍后重试", 429) from exc
        with self._metrics_lock:
            self._pending[priority] += 1
        if not job.finished.wait(REQUEST_WAIT_SECONDS):
            raise AsrServiceError("inference_timeout", "转写等待超时，请稍后重试", 504)
        if job.error is not None:
            raise AsrServiceError("inference_failed", "语音转写失败，请稍后重试", 500)
        assert job.response is not None
        return job.response

    def snapshot(self) -> dict:
        with self._metrics_lock:
            return {
                "depth": sum(self._pending.values()),
                "by_priority": dict(self._pending),
                "active_priority": self._active_priority,
                "last_inference": dict(self._last_inference) if self._last_inference else None,
            }

    def close(self) -> None:
        self._closed = True
        self._queue.put((99, next(self._sequence), None))
        self._worker.join(timeout=2)

    def _collect_microbatch(self, first: InferenceJob) -> list[InferenceJob]:
        """Collect same-priority jobs for one model call without reordering work."""
        if not MICROBATCH_ENABLED or MICROBATCH_WINDOW_SECONDS <= 0:
            return [first]
        jobs = [first]
        item_count = len(first.items)
        audio_ms = sum(round(item.pcm.size * 1000 / 16_000) for item in first.items)
        if item_count >= MICROBATCH_MAX_ITEMS:
            return jobs
        deadline = time.perf_counter() + MICROBATCH_WINDOW_SECONDS
        rank = PRIORITY_ORDER[first.priority]
        while item_count < MICROBATCH_MAX_ITEMS:
            remaining = deadline - time.perf_counter()
            if remaining <= 0:
                break
            try:
                candidate_rank, sequence, candidate = self._queue.get(timeout=remaining)
            except queue.Empty:
                break
            if candidate is None:
                # Keep the stop marker in the queue for the next worker turn.
                self._queue.put((candidate_rank, sequence, candidate))
                self._queue.task_done()
                break
            if (
                candidate_rank != rank
                or candidate.priority != first.priority
                or item_count + len(candidate.items) > MICROBATCH_MAX_ITEMS
                or audio_ms + sum(
                    round(item.pcm.size * 1000 / 16_000)
                    for item in candidate.items
                ) > MICROBATCH_MAX_AUDIO_MS
            ):
                self._queue.put((candidate_rank, sequence, candidate))
                self._queue.task_done()
                break
            jobs.append(candidate)
            item_count += len(candidate.items)
            audio_ms += sum(round(item.pcm.size * 1000 / 16_000) for item in candidate.items)
            with self._metrics_lock:
                self._pending[candidate.priority] = max(
                    0, self._pending[candidate.priority] - 1,
                )
        return jobs

    def _worker_loop(self) -> None:
        while True:
            _rank, _sequence, first = self._queue.get()
            if first is None:
                self._queue.task_done()
                return
            jobs = self._collect_microbatch(first)
            with self._metrics_lock:
                self._pending[first.priority] = max(0, self._pending[first.priority] - 1)
                self._active_priority = first.priority
            started_at = time.perf_counter()
            success = False
            infer_ms = 0
            queue_ms = max(0, round((started_at - first.enqueued_at) * 1000))
            total_items = sum(len(job.items) for job in jobs)
            try:
                model = self._model_getter()
                if model is None:
                    raise RuntimeError("model_not_ready")
                flat_items = [item for job in jobs for item in job.items]
                infer_items = [
                    item
                    for item in flat_items
                    if item.pcm.size and not _is_effectively_silent(item.pcm)
                ]
                results_by_item = {}
                if infer_items:
                    infer_started = time.perf_counter()
                    with torch.inference_mode():
                        results = model.transcribe(
                            audio=[(item.pcm, 16_000) for item in infer_items],
                            language=[item.language for item in infer_items],
                        )
                    infer_ms = max(0, round((time.perf_counter() - infer_started) * 1000))
                    if len(results) != len(infer_items):
                        raise RuntimeError("batch_result_size_mismatch")
                    # ``/asr`` intentionally uses the same item id (``legacy``)
                    # for every request.  Key by object identity so merging
                    # independent jobs never lets one response steal another.
                    results_by_item = dict(zip((id(item) for item in infer_items), results))
                revision = _resolve_model_revision(MODEL_ID)
                for job in jobs:
                    job_queue_ms = max(0, round((started_at - job.enqueued_at) * 1000))
                    response_items = []
                    for item in job.items:
                        result = results_by_item.get(id(item))
                        response_items.append(
                            {
                                "id": item.item_id,
                                "text": getattr(result, "text", "") if result else "",
                                "language": getattr(result, "language", None) if result else None,
                                "source_start_ms": item.source_start_ms,
                                "source_end_ms": item.source_end_ms,
                                "audio_ms": round(item.pcm.size * 1000 / 16_000),
                                "model_revision": revision,
                                "queue_ms": job_queue_ms,
                                "infer_ms": infer_ms,
                            }
                        )
                    job.response = {
                        "schema_version": 1,
                        "model": MODEL_ID,
                        "model_revision": revision,
                        "priority": job.priority,
                        "queue_ms": job_queue_ms,
                        "infer_ms": infer_ms,
                        "items": response_items,
                    }
                success = True
                print(
                    "[Qwen3-ASR] infer priority=%s jobs=%d batch=%d audio_ms=%d "
                    "queue_ms=%d infer_ms=%d"
                    % (
                        first.priority,
                        len(jobs),
                        total_items,
                        sum(round(item.pcm.size * 1000 / 16_000) for item in flat_items),
                        queue_ms,
                        infer_ms,
                    ),
                    flush=True,
                )
            except Exception as exc:
                for job in jobs:
                    job.error = exc
                print(
                    "[Qwen3-ASR] inference failed priority=%s jobs=%d batch=%d error=%s"
                    % (first.priority, len(jobs), total_items, type(exc).__name__),
                    flush=True,
                )
            finally:
                with self._metrics_lock:
                    self._active_priority = None
                    self._last_inference = {
                        "at": _utc_now(),
                        "success": success,
                        "priority": first.priority,
                        "batch_size": total_items,
                        "queue_ms": queue_ms,
                        "infer_ms": infer_ms,
                    }
                for job in jobs:
                    job.finished.set()
                    self._queue.task_done()


COORDINATOR: InferenceCoordinator | None = None


def load_model() -> None:
    global MODEL
    if not MODEL_ID:
        raise RuntimeError("QWEN_ASR_MODEL is empty")
    from qwen_asr import Qwen3ASRModel

    print(f"[Qwen3-ASR] loading model={MODEL_ID} device={DEVICE}", flush=True)
    started_at = time.perf_counter()
    MODEL = Qwen3ASRModel.from_pretrained(
        MODEL_ID,
        dtype=torch.bfloat16,
        device_map=DEVICE,
        max_inference_batch_size=MAX_BATCH_SIZE,
        max_new_tokens=MAX_NEW_TOKENS,
    )
    print(
        "[Qwen3-ASR] ready model=%s revision=%s load_ms=%d"
        % (
            MODEL_ID,
            _resolve_model_revision(MODEL_ID),
            round((time.perf_counter() - started_at) * 1000),
        ),
        flush=True,
    )


def _ready_payload() -> dict:
    queue_state = COORDINATOR.snapshot() if COORDINATOR is not None else {
        "depth": 0,
        "by_priority": {name: 0 for name in PRIORITY_ORDER},
        "active_priority": None,
        "last_inference": None,
    }
    revision = _resolve_model_revision(MODEL_ID)
    # The API uses the revision as part of the transcript idempotency fence.
    # A loaded model without a pinned revision must never advertise ready.
    ready = (
        MODEL is not None
        and COORDINATOR is not None
        and revision
        and revision != "unresolved"
    )
    return {
        "status": "ready" if ready else "not_ready",
        "ready": ready,
        "model": MODEL_ID,
        "model_revision": revision,
        "device": DEVICE,
        "max_batch_size": MAX_BATCH_SIZE,
        "queue": queue_state,
    }


class Handler(BaseHTTPRequestHandler):
    server_version = "LaoJiQwen3ASR/2.0"

    def _json(self, payload: object, status: int = 200) -> None:
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def _error(self, error: AsrServiceError) -> None:
        self._json(
            {"error": error.message, "code": error.code},
            status=error.status,
        )

    def _content_length(self, maximum: int) -> int:
        try:
            length = int(self.headers.get("Content-Length", "0"))
        except ValueError as exc:
            raise AsrServiceError("content_length_invalid", "请求长度无效", 400) from exc
        if length < 0 or length > maximum:
            raise AsrServiceError("request_too_large", "转写请求过大", 413)
        return length

    def do_GET(self) -> None:
        if urlparse(self.path).path not in {"/health", "/ready"}:
            self.send_error(404)
            return
        self._json(_ready_payload())

    def do_POST(self) -> None:
        parsed = urlparse(self.path)
        if parsed.path not in {"/asr", "/v1/asr/batch", "/v2/asr/batch"}:
            self.send_error(404)
            return
        if MODEL is None or COORDINATOR is None:
            self._error(AsrServiceError("model_not_ready", "转写模型尚未就绪", 503))
            return
        try:
            if parsed.path in {"/v1/asr/batch", "/v2/asr/batch"}:
                length = self._content_length(MAX_BATCH_REQUEST_BYTES)
                raw = self.rfile.read(length)
                if parsed.path == "/v2/asr/batch":
                    priority, items = _parse_v2_batch_request(raw)
                    self._json(_v2_batch_response(COORDINATOR.submit(priority, items)))
                else:
                    priority, items = _parse_batch_request(raw)
                    self._json(COORDINATOR.submit(priority, items))
                return

            length = self._content_length(MAX_AUDIO_BYTES)
            pcm = _decode_pcm(self.rfile.read(length) if length else b"")
            query = parse_qs(parsed.query)
            priority = str(query.get("priority", ["realtime"])[0]).strip().lower()
            language = _normalize_language(query.get("language", ["Chinese"])[0])
            item = InferenceItem(
                item_id="legacy",
                pcm=pcm,
                language=language,
                source_start_ms=0,
                source_end_ms=round(pcm.size * 1000 / 16_000),
            )
            batch = COORDINATOR.submit(priority, [item])
            result = batch["items"][0]
            self._json(
                {
                    "text": result["text"],
                    "language": result["language"],
                    "infer_ms": result["infer_ms"],
                    "queue_ms": result["queue_ms"],
                    "audio_ms": result["audio_ms"],
                    "model": batch["model"],
                    "model_revision": batch["model_revision"],
                }
            )
        except AsrServiceError as exc:
            self._error(exc)

    def log_message(self, _format: str, *_args: object) -> None:
        return


class Server(ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = True


def main() -> None:
    global COORDINATOR
    port = int(os.getenv("QWEN_ASR_PORT", "8030"))
    load_model()
    revision = _resolve_model_revision(MODEL_ID)
    if not revision or revision == "unresolved":
        raise RuntimeError(
            "QWEN_ASR_MODEL_REVISION must be pinned; refusing to start an unversioned ASR service"
        )
    COORDINATOR = InferenceCoordinator(lambda: MODEL)
    server = Server(("127.0.0.1", port), Handler)
    print(f"[Qwen3-ASR] listening on 127.0.0.1:{port}", flush=True)
    try:
        server.serve_forever()
    finally:
        COORDINATOR.close()


if __name__ == "__main__":
    main()
