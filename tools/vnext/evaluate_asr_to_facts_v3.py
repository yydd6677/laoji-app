#!/usr/bin/env python3
"""Replay an isolated ASR v2 video directly into Facts V3.

The transcript is kept in memory only. The report contains hashes, counts,
coverage and timings, never transcript or generated text. This is an
acceptance harness for the candidate path, not a production route.
"""

from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
import time

from app.services.summary_v3_evidence import build_evidence_package
from app.services.summary_v3_generator import SummaryV3GenerationError, generate_verified_document
from tools.vnext.replay_asr_v2 import Chunk, post_batch, read_chunks, validate_batch_response


def _sha(value: object) -> str:
    encoded = json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")
    return "sha256:" + hashlib.sha256(encoded).hexdigest()


def _parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("media", type=Path)
    parser.add_argument("--endpoint", default="http://127.0.0.1:8031/v2/asr/batch")
    parser.add_argument("--chunk-seconds", type=float, default=14.0)
    parser.add_argument("--batch-size", type=int, default=8)
    parser.add_argument("--output", type=Path, required=True)
    return parser.parse_args()


def _run_asr(endpoint: str, chunks: list[Chunk], batch_size: int) -> tuple[list[dict], str, int]:
    items: list[dict] = []
    revision: str | None = None
    started = time.perf_counter()
    for offset in range(0, len(chunks), batch_size):
        batch = chunks[offset: offset + batch_size]
        response = post_batch(endpoint, "offline", batch)
        if "error" in response:
            raise RuntimeError(json.dumps(response, ensure_ascii=False))
        revision = validate_batch_response(response, batch, revision)
        items.extend(response["items"])
    if revision is None:
        raise RuntimeError("ASR returned no model revision")
    return items, revision, round((time.perf_counter() - started) * 1000)


def main() -> int:
    args = _parse_args()
    if not 1 <= args.batch_size <= 8:
        raise SystemExit("batch-size must be between 1 and 8")
    started = time.perf_counter()
    chunks = read_chunks(args.media, args.chunk_seconds, 0)
    if not chunks:
        raise SystemExit("media produced no PCM")
    asr_items, asr_revision, asr_wall_ms = _run_asr(args.endpoint, chunks, args.batch_size)
    lines = [
        {
            "id": str(item["stable_segment_key"]),
            "start_ms": int(item["source_start_ms"]),
            "end_ms": int(item["source_end_ms"]),
            "speaker": None,
            "text": str(item.get("text") or "").strip(),
        }
        for item in asr_items
        if str(item.get("text") or "").strip()
    ]
    if not lines:
        raise RuntimeError("ASR produced no text segments")
    package = build_evidence_package(lines, None, None)
    facts_started = time.perf_counter()
    try:
        generated = generate_verified_document(package)
    except SummaryV3GenerationError:
        raise
    facts_wall_ms = round((time.perf_counter() - facts_started) * 1000)
    document = generated["document"]
    report = {
        "candidate_only": True,
        "production_mutation": False,
        "source_policy": "full video decoded by isolated ASR v2; transcript retained in memory only",
        "media_name": args.media.name,
        "media_sha256": "sha256:" + hashlib.sha256(args.media.read_bytes()).hexdigest(),
        "audio_ms": sum(chunk.end_ms - chunk.start_ms for chunk in chunks),
        "asr_chunks": len(chunks),
        "asr_text_segments": len(lines),
        "asr_model_revision": asr_revision,
        "asr_wall_ms": asr_wall_ms,
        "asr_contract_validated": True,
        "transcript_sha256": _sha(lines),
        "evidence": {
            "estimated_tokens": package.estimated_tokens,
            "total_segments": package.coverage.get("total_segments"),
            "included_segments": package.coverage.get("included_segments"),
            "source_coverage": package.coverage.get("source_coverage"),
            "used_embeddings": package.coverage.get("used_embeddings"),
        },
        "facts_wall_ms": facts_wall_ms,
        "model_calls": generated.get("model_calls"),
        "facts": len(document.get("facts", [])),
        "actions": len(document.get("action_candidates", [])),
        "total_wall_ms": round((time.perf_counter() - started) * 1000),
        "passed": bool(document.get("facts")) and generated.get("model_calls") in {1, 2},
        "remaining": [
            "human fact support and action usefulness review",
            "full long-meeting source-stream replay",
            "Android summary page and recovery replay",
            "Facts V3 capability barrier",
        ],
    }
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({key: report[key] for key in (
        "media_name", "audio_ms", "asr_chunks", "asr_text_segments", "asr_wall_ms",
        "evidence", "facts_wall_ms", "model_calls", "facts", "actions", "total_wall_ms", "passed",
    )}, ensure_ascii=False))
    return 0 if report["passed"] else 1


if __name__ == "__main__":
    raise SystemExit(main())

