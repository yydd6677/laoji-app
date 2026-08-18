"""Unified readiness state for the compact LaoJi production topology."""

from __future__ import annotations

import asyncio
import os
from urllib.parse import urlsplit

import httpx

from app.asr.model_manager import get_model_manager
from app.config import settings
from app.services.database_health import database_health
from app.services.llm_provider import provider_state
from app.services.storage_admission import storage_state
from app.services.summary_task_store import task_counts, task_worker_state
from app.services import r2_storage_service


def _asr_ready_url() -> str:
    raw = os.getenv("QWEN_ASR_READY_URL", "http://127.0.0.1:8030/ready").strip()
    try:
        expected_port = int(os.getenv("LAOJI_INTERNAL_ASR_PORT", "8030"))
    except ValueError as exc:
        raise RuntimeError("qwen_asr_port_invalid") from exc
    if not 1 <= expected_port <= 65_535:
        raise RuntimeError("qwen_asr_port_invalid")
    parsed = urlsplit(raw)
    if (
        parsed.scheme != "http"
        or parsed.hostname not in {"127.0.0.1", "localhost", "::1"}
        or parsed.port != expected_port
        or parsed.path != "/ready"
        or parsed.username is not None
        or parsed.password is not None
        or parsed.query
        or parsed.fragment
    ):
        raise RuntimeError("qwen_asr_ready_url_invalid")
    return raw


async def _asr_state() -> dict:
    try:
        async with httpx.AsyncClient(timeout=5, trust_env=False) as client:
            response = await client.get(_asr_ready_url())
        response.raise_for_status()
        payload = response.json()
        queue = payload.get("queue") if isinstance(payload.get("queue"), dict) else {}
        return {
            "ready": payload.get("ready") is True,
            "model": payload.get("model"),
            "model_revision": payload.get("model_revision"),
            "queue_depth": int(queue.get("depth") or 0),
            "queue_by_priority": queue.get("by_priority") or {},
            "active_priority": queue.get("active_priority"),
            "last_inference": queue.get("last_inference"),
        }
    except Exception:
        return {
            "ready": False,
            "model": None,
            "model_revision": None,
            "queue_depth": None,
            "queue_by_priority": {},
            "active_priority": None,
            "last_inference": None,
        }


async def readiness_snapshot() -> dict:
    asr, llm, tasks, worker, databases = await asyncio.gather(
        _asr_state(),
        asyncio.to_thread(provider_state, probe=True),
        asyncio.to_thread(task_counts),
        asyncio.to_thread(task_worker_state),
        asyncio.to_thread(database_health),
    )
    manager = get_model_manager()
    support_models = {
        "ready": manager.required_models_ready(),
        "vad": manager.get_vad_model() is not None,
        "campplus": manager.get_camp_model() is not None,
    }
    storage = storage_state()
    free_gib = round(storage["free_bytes"] / 1024**3, 3)
    disk_state = {
        "free_gib": free_gib,
        "warning": storage["warning"],
        "accepting_new_audio": storage["accepting_new_audio"],
    }
    task_state = {
        "ready": worker["expired_leases"] == 0,
        "counts": tasks,
        "queue_depth": int(tasks.get("queued", 0)) + int(tasks.get("running", 0)),
        **worker,
    }
    llm_state = {
        "ready": llm.get("ready") is True,
        "provider": llm.get("provider"),
        "generation_model": llm.get("generation_model"),
        "generation_ready": llm.get("generation_ready"),
        "embedding_provider": llm.get("embedding_provider"),
        "embedding_model": llm.get("embedding_model"),
        "embedding_ready": llm.get("embedding_ready"),
        "embedding_probe_latency_ms": llm.get("embedding_probe_latency_ms"),
        "embedding_probe_error": llm.get("embedding_probe_error"),
        "queue": llm.get("queue"),
        "probe_latency_ms": llm.get("probe_latency_ms"),
    }
    ready = all(
        (
            asr["ready"],
            llm_state["ready"],
            support_models["ready"],
            task_state["ready"],
            disk_state["accepting_new_audio"],
            databases["ready"],
        )
    )
    return {
        "status": "ready" if ready else "not_ready",
        "ready": ready,
        "asr": asr,
        "llm": llm_state,
        "support_models": support_models,
        "task_worker": task_state,
        "databases": databases,
        "disk": disk_state,
        "location": {
            "provider": "amap-web-service",
            "configured": bool(os.getenv("AMAP_WEB_SERVICE_KEY", "").strip()),
        },
        "r2": {
            # R2 is an optional transfer optimization; disabled is healthy
            # because the device API intentionally falls back to its bounded
            # authenticated upload path.
            "enabled": bool(settings.R2_ENABLED),
            "configured": r2_storage_service.r2_enabled(),
            "part_size": int(settings.R2_PART_SIZE) if r2_storage_service.r2_enabled() else None,
        },
    }
