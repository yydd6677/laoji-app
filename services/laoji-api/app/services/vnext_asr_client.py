"""Strict loopback client for the isolated 8030 ASR v2 contract."""

from __future__ import annotations

import base64
import os
import urllib.parse
import urllib.request

from app.schemas.vnext_contracts import AsrBatchRequestV2, AsrBatchResponseV2


ASR_V2_BATCH_URL = os.getenv(
    "QWEN_ASR_V2_BATCH_URL",
    "http://127.0.0.1:8030/v2/asr/batch",
).strip()
ASR_TIMEOUT_SECONDS = max(5.0, float(os.getenv("QWEN_ASR_REQUEST_TIMEOUT_SECONDS", "60")))


def _opener() -> urllib.request.OpenerDirector:
    parsed = urllib.parse.urlsplit(ASR_V2_BATCH_URL)
    if (
        parsed.scheme != "http"
        or parsed.hostname not in {"127.0.0.1", "localhost", "::1"}
        or parsed.port != int(os.getenv("LAOJI_INTERNAL_ASR_PORT", "8030"))
        or parsed.path != "/v2/asr/batch"
        or parsed.username is not None
        or parsed.password is not None
        or parsed.query
        or parsed.fragment
    ):
        raise RuntimeError("asr_v2_url_invalid")
    return urllib.request.build_opener(urllib.request.ProxyHandler({}))


def transcribe_batch(
    *,
    items: list[dict],
    priority: str,
    timeout_seconds: float | None = None,
) -> dict:
    payload = AsrBatchRequestV2(
        schema_version=2,
        contract_revision="asr.batch.v2",
        priority=priority,
        items=items,
    )
    request = urllib.request.Request(
        ASR_V2_BATCH_URL,
        data=payload.model_dump_json().encode("utf-8"),
        headers={"Content-Type": "application/json", "Accept": "application/json"},
        method="POST",
    )
    with _opener().open(
        request,
        timeout=max(5.0, float(timeout_seconds or ASR_TIMEOUT_SECONDS)),
    ) as response:
        raw = response.read()
    parsed = AsrBatchResponseV2.model_validate_json(raw)
    if parsed.priority != priority:
        raise RuntimeError("asr_v2_priority_mismatch")
    expected = [str(item["id"]) for item in items]
    observed = [item.id for item in parsed.items]
    if observed != expected:
        raise RuntimeError("asr_v2_item_identity_mismatch")
    for request_item, result_item in zip(items, parsed.items, strict=True):
        if (
            result_item.stable_segment_key != str(request_item["id"])
            or result_item.segment_revision != 1
            or result_item.source_start_ms != int(request_item["source_start_ms"])
            or result_item.source_end_ms != int(request_item["source_end_ms"])
            or result_item.model_revision != parsed.model_revision
        ):
            raise RuntimeError("asr_v2_item_contract_mismatch")
    return parsed.model_dump()


def ready_snapshot() -> dict:
    parsed = urllib.parse.urlsplit(ASR_V2_BATCH_URL)
    ready_url = urllib.parse.urlunsplit((parsed.scheme, parsed.netloc, "/ready", "", ""))
    request = urllib.request.Request(ready_url, headers={"Accept": "application/json"})
    with _opener().open(request, timeout=10) as response:
        payload = json_load_bytes(response.read())
    revision = str(payload.get("model_revision") or "").strip()
    if payload.get("ready") is not True or not revision or revision == "unresolved":
        raise RuntimeError("asr_v2_not_ready")
    return payload


def json_load_bytes(raw: bytes) -> dict:
    import json

    value = json.loads(raw.decode("utf-8"))
    if not isinstance(value, dict):
        raise RuntimeError("asr_v2_response_invalid")
    return value


def transcribe_realtime_segment(
    *,
    item_id: str,
    pcm_int16: bytes,
    source_start_ms: int,
    source_end_ms: int,
    language: str = "Chinese",
) -> dict:
    payload = {
        "schema_version": 2,
        "contract_revision": "asr.batch.v2",
        "priority": "realtime",
        "items": [{
            "id": item_id,
            "pcm_base64": base64.b64encode(pcm_int16).decode("ascii"),
            "sample_rate": 16000,
            "language": language,
            "source_start_ms": source_start_ms,
            "source_end_ms": source_end_ms,
        }],
    }
    result = transcribe_batch(items=payload["items"], priority="realtime")
    return result["items"][0]
