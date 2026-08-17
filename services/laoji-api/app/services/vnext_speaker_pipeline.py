"""Low-priority CAM++ worker for durable vNext speaker overlays."""

from __future__ import annotations

import asyncio
from collections import Counter, OrderedDict
import hashlib
import itertools
import logging
import math
import os
import socket
from typing import Any, Awaitable, Callable

import numpy as np

from app.asr.model_manager import ModelManager, SpeakerEmbeddingExtractor
from app.services import (
    vnext_speaker_crypto,
    vnext_speaker_store,
    vnext_task_store,
)


MIN_SPEAKER_AUDIO_MS = 1_200
SPEAKER_COSINE_THRESHOLD = 0.70
SPEAKER_GAP_THRESHOLD = 0.08
SPEAKER_MINIMUM_VOTES = 2
ANONYMOUS_CLUSTER_THRESHOLD = 0.50
QUEUE_LIMIT = max(8, min(256, int(os.getenv("LAOJI_VNEXT_SPEAKER_QUEUE_LIMIT", "64"))))
CACHE_LIMIT = max(16, min(1024, int(os.getenv("LAOJI_VNEXT_SPEAKER_CACHE_LIMIT", "256"))))


_logger = logging.getLogger(__name__)
EmbeddingCall = Callable[[bytes], Awaitable[tuple[np.ndarray, str]]]


def _unit_embedding(value: np.ndarray) -> np.ndarray:
    embedding = np.asarray(value, dtype=np.float32).reshape(-1)
    norm = float(np.linalg.norm(embedding))
    if embedding.size < 1 or not math.isfinite(norm) or norm < 1e-6:
        raise ValueError("speaker_embedding_invalid")
    return embedding / norm


async def _default_embedding_call(pcm_bytes: bytes) -> tuple[np.ndarray, str]:
    manager = ModelManager.get_instance()
    if manager.get_camp_model() is None:
        await manager.initialize()
    model = manager.get_camp_model()
    if model is None:
        raise RuntimeError("campplus_not_ready")
    extractor = SpeakerEmbeddingExtractor(model, device=manager.device)
    embedding = await asyncio.to_thread(extractor.extract_from_bytes, pcm_bytes)
    return _unit_embedding(embedding), manager.camp_model_revision


async def extract_embedding_from_pcm(pcm_bytes: bytes) -> tuple[np.ndarray, str]:
    return await _default_embedding_call(pcm_bytes)


def assign_speaker_overlay(
    source_segments: list[dict[str, Any]],
    embeddings: dict[str, np.ndarray | None],
    profiles: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    """Cluster once, then apply conservative profile votes to every stable segment."""
    clusters: list[dict[str, Any]] = []
    previous_cluster: int | None = None
    previous_end_ms = -1
    records: list[dict[str, Any]] = []
    for segment in source_segments:
        stable_key = str(segment["stable_segment_key"])
        embedding = embeddings.get(stable_key)
        if embedding is not None:
            embedding = _unit_embedding(embedding)
        cluster_index: int | None = None
        if embedding is not None and clusters:
            similarities = [
                float(np.dot(embedding, cluster["centroid"]))
                if cluster["centroid"] is not None else -1.0
                for cluster in clusters
            ]
            candidate = int(np.argmax(similarities))
            if similarities[candidate] >= ANONYMOUS_CLUSTER_THRESHOLD:
                cluster_index = candidate
        start_ms = int(segment["source_start_ms"])
        end_ms = int(segment["source_end_ms"])
        if cluster_index is None and embedding is None and previous_cluster is not None:
            if start_ms - previous_end_ms <= 1_500:
                cluster_index = previous_cluster
        if cluster_index is None:
            clusters.append({
                "centroid": embedding.copy() if embedding is not None else None,
                "embedding_count": 1 if embedding is not None else 0,
                "records": [],
                "votes": Counter(),
                "scores": {},
            })
            cluster_index = len(clusters) - 1
        cluster = clusters[cluster_index]
        if embedding is not None:
            count = int(cluster["embedding_count"])
            if cluster["centroid"] is None:
                cluster["centroid"] = embedding.copy()
                cluster["embedding_count"] = 1
            elif count > 0 and cluster["records"]:
                centroid = cluster["centroid"] * count + embedding
                centroid_norm = float(np.linalg.norm(centroid))
                if centroid_norm >= 1e-6:
                    cluster["centroid"] = centroid / centroid_norm
                    cluster["embedding_count"] = count + 1
            if profiles and end_ms - start_ms >= MIN_SPEAKER_AUDIO_MS:
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
                ):
                    profile_id = str(top_profile["speaker_id"])
                    cluster["votes"][profile_id] += 1
                    cluster["scores"].setdefault(profile_id, []).append(top_score)
        record = {
            "stable_segment_key": stable_key,
            "cluster_index": cluster_index,
        }
        records.append(record)
        cluster["records"].append(record)
        previous_cluster = cluster_index
        previous_end_ms = end_ms

    profiles_by_id = {str(profile["speaker_id"]): profile for profile in profiles}
    assignments: list[dict[str, Any]] = []
    for index, cluster in enumerate(clusters, start=1):
        accepted_id: str | None = None
        if cluster["votes"]:
            candidate_id, vote_count = cluster["votes"].most_common(1)[0]
            if vote_count >= SPEAKER_MINIMUM_VOTES:
                accepted_id = str(candidate_id)
        anonymous_label = f"发言人 {index}"
        if accepted_id is not None:
            profile = profiles_by_id[accepted_id]
            score_values = cluster["scores"][accepted_id]
            label = str(profile["name"])
            confidence: float | None = round(
                float(sum(score_values) / len(score_values)),
                6,
            )
            profile_revision: int | None = int(profile["profile_revision"])
        else:
            label = anonymous_label
            confidence = None
            profile_revision = None
        for record in cluster["records"]:
            assignments.append({
                "stable_segment_key": record["stable_segment_key"],
                "automatic_label": label,
                "anonymous_label": anonymous_label,
                "speaker_cluster_id": f"cluster:{index}",
                "speaker_profile_id": accepted_id,
                "profile_revision": profile_revision,
                "confidence": confidence,
            })
    return sorted(assignments, key=lambda item: item["stable_segment_key"])


class VNextSpeakerOverlayWorker:
    def __init__(self, *, embedding_call: EmbeddingCall = _default_embedding_call) -> None:
        self.embedding_call = embedding_call
        self._queue: asyncio.PriorityQueue[tuple[int, int, str, str, str | None]] = (
            asyncio.PriorityQueue(maxsize=QUEUE_LIMIT)
        )
        self._sequence = itertools.count()
        self._task: asyncio.Task | None = None
        self._closed = False
        self._cache: OrderedDict[tuple[str, str], tuple[np.ndarray | None, str]] = OrderedDict()
        self._lease_owner = f"speaker:{socket.gethostname()}:{os.getpid()}"

    def start(self) -> None:
        if self._task is None or self._task.done():
            self._closed = False
            self._task = asyncio.create_task(self._run(), name="vnext-speaker-overlay")

    async def stop(self) -> None:
        self._closed = True
        if self._task is None:
            return
        self._task.cancel()
        try:
            await self._task
        except asyncio.CancelledError:
            pass
        self._task = None
        self._cache.clear()

    def notify_segment(
        self,
        context: vnext_speaker_store.SpeakerOwnerContext,
        session_id: str,
        stable_segment_key: str,
    ) -> None:
        self.start()
        self._put_nowait(20, context, session_id, stable_segment_key)

    def notify_finalize(
        self,
        context: vnext_speaker_store.SpeakerOwnerContext,
        session_id: str,
    ) -> None:
        self.start()
        self._put_nowait(10, context, session_id, None)

    def _put_nowait(
        self,
        priority: int,
        context: vnext_speaker_store.SpeakerOwnerContext,
        session_id: str,
        stable_segment_key: str | None,
    ) -> None:
        try:
            self._queue.put_nowait((
                priority,
                next(self._sequence),
                str(context.device_id),
                str(context.epoch_id),
                f"{session_id}\0{stable_segment_key or ''}",
            ))
        except asyncio.QueueFull:
            # PCM is already durable. The periodic scan will recover final work.
            return

    async def _run(self) -> None:
        while not self._closed:
            try:
                item = await asyncio.wait_for(self._queue.get(), timeout=1.0)
            except asyncio.TimeoutError:
                await self._scan_ready()
                continue
            try:
                _priority, _sequence, device_id, epoch_id, payload = item
                session_id, _separator, stable_key = payload.partition("\0")
                context = vnext_speaker_store.StoredSpeakerContext(device_id, epoch_id)
                if stable_key:
                    await self._precompute(context, session_id, stable_key)
                else:
                    await self._process_final(context, session_id)
            except asyncio.CancelledError:
                raise
            except Exception as error:
                _logger.warning("vnext speaker worker item failed: %s", type(error).__name__)
            finally:
                self._queue.task_done()

    async def _scan_ready(self) -> None:
        rows = await asyncio.to_thread(vnext_speaker_store.list_ready_runs, 16)
        for row in rows:
            context = vnext_speaker_store.StoredSpeakerContext(
                str(row["device_id"]),
                str(row["epoch_id"]),
            )
            self._put_nowait(10, context, str(row["session_id"]), None)

    def _cache_put(
        self,
        session_id: str,
        stable_key: str,
        value: tuple[np.ndarray | None, str],
    ) -> None:
        key = (session_id, stable_key)
        self._cache[key] = value
        self._cache.move_to_end(key)
        while len(self._cache) > CACHE_LIMIT:
            self._cache.popitem(last=False)

    async def _embedding_for(
        self,
        session_id: str,
        row: dict[str, Any],
    ) -> tuple[np.ndarray | None, str]:
        stable_key = str(row["stable_segment_key"])
        key = (session_id, stable_key)
        cached = self._cache.get(key)
        if cached is not None:
            self._cache.move_to_end(key)
            return cached
        duration_ms = int(row["source_end_ms"]) - int(row["source_start_ms"])
        if duration_ms < MIN_SPEAKER_AUDIO_MS:
            result = (None, "campplus-skipped-short")
            self._cache_put(session_id, stable_key, result)
            return result
        pcm = await asyncio.to_thread(
            vnext_speaker_crypto.read_segment,
            str(row["encrypted_spool_locator"]),
        )
        try:
            await asyncio.sleep(0)
            embedding, revision = await self.embedding_call(pcm)
            result = (_unit_embedding(embedding), str(revision))
        except Exception:
            result = (None, "campplus-unavailable")
        self._cache_put(session_id, stable_key, result)
        return result

    async def _precompute(
        self,
        context: vnext_speaker_store.SpeakerOwnerContext,
        session_id: str,
        stable_key: str,
    ) -> None:
        work = await asyncio.to_thread(vnext_speaker_store.get_run_work, context, session_id)
        row = next(
            (item for item in work["inputs"] if item["stable_segment_key"] == stable_key),
            None,
        )
        if row is not None:
            await self._embedding_for(session_id, row)

    async def _process_final(
        self,
        context: vnext_speaker_store.SpeakerOwnerContext,
        session_id: str,
    ) -> None:
        work = await asyncio.to_thread(vnext_speaker_store.get_run_work, context, session_id)
        run = work["run"]
        task_id = str(run.get("task_id") or "")
        if not task_id or run["state"] not in {"queued", "running"}:
            return
        attempt = await asyncio.to_thread(
            vnext_task_store.claim_attempt,
            context,
            task_id,
            lease_owner=self._lease_owner,
            lease_seconds=300,
        )
        if attempt is None:
            return
        attempt_id = str(attempt["attempt_id"])
        if work["profile_manifest_sha256"] != run["profile_manifest_sha256"]:
            replacement = await asyncio.to_thread(
                vnext_speaker_store.replace_task_after_profile_change,
                context,
                session_id,
                task_id=task_id,
                attempt_id=attempt_id,
                lease_owner=self._lease_owner,
            )
            if replacement["replaced"]:
                self.notify_finalize(context, session_id)
            return
        if not await asyncio.to_thread(
            vnext_speaker_store.mark_run_running,
            context,
            session_id,
            task_id,
        ):
            return
        try:
            input_by_key = {
                str(row["stable_segment_key"]): row
                for row in work["inputs"]
            }
            embeddings: dict[str, np.ndarray | None] = {}
            model_revisions: list[str] = []
            for segment in work["source_segments"]:
                stable_key = str(segment["stable_segment_key"])
                row = input_by_key.get(stable_key)
                if row is None:
                    embeddings[stable_key] = None
                    continue
                embedding, revision = await self._embedding_for(session_id, row)
                embeddings[stable_key] = embedding
                model_revisions.append(revision)
            profiles = await asyncio.to_thread(
                vnext_speaker_store.load_profiles_for_inference,
                context,
            )
            assignments = assign_speaker_overlay(
                work["source_segments"],
                embeddings,
                profiles,
            )
            model_revision = (
                next((item for item in model_revisions if item.startswith("campplus-zh-")), None)
                or (model_revisions[0] if model_revisions else "campplus-unavailable")
            )
            await asyncio.to_thread(
                vnext_speaker_store.commit_overlay,
                context,
                session_id,
                task_id=task_id,
                attempt_id=attempt_id,
                lease_owner=self._lease_owner,
                source_manifest_sha256=str(run["source_manifest_sha256"]),
                profile_manifest_sha256=str(run["profile_manifest_sha256"]),
                model_revision=model_revision,
                assignments=assignments,
            )
            for key in [key for key in self._cache if key[0] == session_id]:
                self._cache.pop(key, None)
        except vnext_speaker_store.VNextSpeakerError as error:
            if error.code == "SPEAKER_PROFILE_CHANGED":
                replacement = await asyncio.to_thread(
                    vnext_speaker_store.replace_task_after_profile_change,
                    context,
                    session_id,
                    task_id=task_id,
                    attempt_id=attempt_id,
                    lease_owner=self._lease_owner,
                )
                if replacement["replaced"]:
                    self.notify_finalize(context, session_id)
                return
            retryable = error.code not in {
                "SPEAKER_SOURCE_CHANGED",
                "SPEAKER_WORKER_FENCED",
            }
            await asyncio.to_thread(
                vnext_speaker_store.mark_run_failure,
                context,
                session_id,
                task_id=task_id,
                attempt_id=attempt_id,
                lease_owner=self._lease_owner,
                error_code=error.code,
                retryable=retryable,
            )
        except Exception as error:
            await asyncio.to_thread(
                vnext_speaker_store.mark_run_failure,
                context,
                session_id,
                task_id=task_id,
                attempt_id=attempt_id,
                lease_owner=self._lease_owner,
                error_code=f"SPEAKER_{type(error).__name__.upper()[:80]}",
                retryable=True,
            )


_worker: VNextSpeakerOverlayWorker | None = None


def get_speaker_overlay_worker() -> VNextSpeakerOverlayWorker:
    global _worker
    if _worker is None:
        _worker = VNextSpeakerOverlayWorker()
    return _worker


def start_speaker_overlay_worker() -> None:
    get_speaker_overlay_worker().start()


async def stop_speaker_overlay_worker() -> None:
    if _worker is not None:
        await _worker.stop()


async def collect_realtime_speaker_segment(
    context: vnext_speaker_store.SpeakerOwnerContext,
    session_id: str,
    *,
    stable_segment_key: str,
    source_start_ms: int,
    source_end_ms: int,
    pcm_bytes: bytes,
    worker_generation: str,
) -> None:
    content_sha256 = "sha256:" + hashlib.sha256(pcm_bytes).hexdigest()
    locator = await asyncio.to_thread(
        vnext_speaker_crypto.seal_segment,
        device_id=context.device_id,
        epoch_id=context.epoch_id,
        session_id=session_id,
        stable_segment_key=stable_segment_key,
        content_sha256=content_sha256,
        pcm_bytes=pcm_bytes,
    )
    try:
        await asyncio.to_thread(
            vnext_speaker_store.collect_speaker_segment,
            context,
            session_id,
            stable_segment_key=stable_segment_key,
            source_start_ms=source_start_ms,
            source_end_ms=source_end_ms,
            byte_size=len(pcm_bytes),
            content_sha256=content_sha256,
            encrypted_spool_locator=locator,
            worker_generation=worker_generation,
        )
    except Exception:
        referenced = await asyncio.to_thread(
            vnext_speaker_store.is_spool_locator_referenced,
            locator,
        )
        if not referenced:
            await asyncio.to_thread(vnext_speaker_crypto.delete_segment, locator)
        raise
    get_speaker_overlay_worker().notify_segment(context, session_id, stable_segment_key)


async def finalize_realtime_speaker(
    context: vnext_speaker_store.SpeakerOwnerContext,
    session_id: str,
) -> dict[str, Any]:
    result = await asyncio.to_thread(
        vnext_speaker_store.finalize_speaker_run,
        context,
        session_id,
        model_revision="campplus-zh-v1",
    )
    if result["state"] == "queued":
        get_speaker_overlay_worker().notify_finalize(context, session_id)
    return result
