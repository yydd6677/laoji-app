#!/usr/bin/env python3
"""Replay a media file through the isolated ASR v2 HTTP contract.

The harness intentionally streams decoded PCM from ffmpeg.  It does not create
an intermediate WAV and keeps only one bounded batch in memory.  It is useful
for Linux and Windows candidate deployments where the service is reachable by
HTTP, including an SSH-forwarded loopback port.
"""

from __future__ import annotations

import argparse
import base64
from dataclasses import dataclass
import json
import subprocess
import sys
import time
from pathlib import Path
from urllib import request


@dataclass(frozen=True)
class Chunk:
    index: int
    start_ms: int
    end_ms: int
    pcm: bytes


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("media", type=Path)
    parser.add_argument("--endpoint", default="http://127.0.0.1:8031/v2/asr/batch")
    parser.add_argument("--chunk-seconds", type=float, default=14.0)
    parser.add_argument("--batch-size", type=int, default=8)
    parser.add_argument("--priority", choices=("realtime", "schedule", "offline"), default="offline")
    parser.add_argument("--max-chunks", type=int, default=0)
    parser.add_argument(
        "--include-items",
        action="store_true",
        help="include transcript item text in the report (off by default)",
    )
    parser.add_argument("--output", type=Path, required=True)
    return parser.parse_args()


def read_chunks(media: Path, chunk_seconds: float, max_chunks: int) -> list[Chunk]:
    if chunk_seconds <= 0:
        raise ValueError("chunk-seconds must be positive")
    chunk_bytes = max(1, round(chunk_seconds * 16_000 * 2))
    process = subprocess.Popen(
        [
            "ffmpeg", "-hide_banner", "-loglevel", "error", "-i", str(media),
            "-vn", "-ac", "1", "-ar", "16000", "-f", "s16le", "-",
        ],
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
    )
    assert process.stdout is not None
    chunks: list[Chunk] = []
    index = 0
    truncated = False
    try:
        while True:
            pcm = process.stdout.read(chunk_bytes)
            if not pcm:
                break
            start_ms = round(index * chunk_seconds * 1000)
            end_ms = start_ms + round(len(pcm) * 1000 / (16_000 * 2))
            chunks.append(Chunk(index, start_ms, end_ms, pcm))
            index += 1
            if max_chunks and index >= max_chunks:
                truncated = True
                process.stdout.close()
                break
    finally:
        return_code = process.wait()
    if return_code != 0 and not truncated:
        details = process.stderr.read().decode("utf-8", "replace") if process.stderr else ""
        raise RuntimeError(f"ffmpeg failed ({return_code}): {details[-500:]}")
    return chunks


def post_batch(endpoint: str, priority: str, chunks: list[Chunk]) -> dict:
    payload = {
        "schema_version": 2,
        "contract_revision": "asr.batch.v2",
        "priority": priority,
        "items": [
            {
                "id": f"replay-{chunk.index:06d}",
                "sample_rate": 16_000,
                "language": "Chinese",
                "source_start_ms": chunk.start_ms,
                "source_end_ms": chunk.end_ms,
                "pcm_base64": base64.b64encode(chunk.pcm).decode("ascii"),
            }
            for chunk in chunks
        ],
    }
    body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    req = request.Request(endpoint, data=body, headers={"Content-Type": "application/json"})
    with request.urlopen(req, timeout=900) as response:
        return json.loads(response.read().decode("utf-8"))


def main() -> int:
    args = parse_args()
    if not 1 <= args.batch_size <= 8:
        raise SystemExit("batch-size must be between 1 and 8")
    started = time.perf_counter()
    chunks = read_chunks(args.media, args.chunk_seconds, args.max_chunks)
    if not chunks:
        raise SystemExit("media produced no PCM")
    responses: list[dict] = []
    first_result_seconds: float | None = None
    for offset in range(0, len(chunks), args.batch_size):
        response = post_batch(args.endpoint, args.priority, chunks[offset: offset + args.batch_size])
        if "error" in response:
            raise RuntimeError(json.dumps(response, ensure_ascii=False))
        responses.append(response)
        if first_result_seconds is None:
            first_result_seconds = time.perf_counter() - started
    items = [item for response in responses for item in response.get("items", [])]
    audio_ms = sum(item.end_ms - item.start_ms for item in chunks)
    infer_ms = sum(int(response.get("infer_ms", 0)) for response in responses)
    output = {
        "media": str(args.media),
        "endpoint": args.endpoint,
        "chunk_seconds": args.chunk_seconds,
        "batch_size": args.batch_size,
        "chunks": len(chunks),
        "audio_ms": audio_ms,
        "first_result_ms": round((first_result_seconds or 0) * 1000),
        "wall_ms": round((time.perf_counter() - started) * 1000),
        "rtf": round((time.perf_counter() - started) / max(audio_ms / 1000, 0.001), 4),
        "infer_ms": infer_ms,
        "text_items": sum(bool(str(item.get("text") or "").strip()) for item in items),
        "no_speech_items": sum(item.get("outcome") == "no_speech" for item in items),
        "model_revision": next((response.get("model_revision") for response in responses), None),
    }
    if args.include_items:
        output["items"] = items
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(output, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps({key: output[key] for key in (
        "chunks", "audio_ms", "first_result_ms", "wall_ms", "rtf", "infer_ms",
        "text_items", "no_speech_items", "model_revision",
    )}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except KeyboardInterrupt:
        raise SystemExit(130)
