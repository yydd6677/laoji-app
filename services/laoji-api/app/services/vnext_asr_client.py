"""Strict loopback client for the isolated 8030 ASR v2 contract."""

from __future__ import annotations

import base64
import json
import os
import urllib.request

from app.schemas.vnext_contracts import AsrBatchResponseV2


ASR_V2_BATCH_URL = os.getenv(
    "QWEN_ASR_V2_BATCH_URL",
    "http://127.0.0.1:8030/v2/asr/batch",
).strip()
ASR_TIMEOUT_SECONDS = max(5.0, float(os.getenv("QWEN_ASR_REQUEST_TIMEOUT_SECONDS", "60")))


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
    request = urllib.request.Request(
        ASR_V2_BATCH_URL,
        data=json.dumps(payload, ensure_ascii=True, separators=(",", ":")).encode("utf-8"),
        headers={"Content-Type": "application/json", "Accept": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(request, timeout=ASR_TIMEOUT_SECONDS) as response:
        raw = response.read()
    parsed = AsrBatchResponseV2.model_validate_json(raw)
    if len(parsed.items) != 1 or parsed.items[0].id != item_id:
        raise RuntimeError("asr_v2_item_identity_mismatch")
    return parsed.items[0].model_dump()
