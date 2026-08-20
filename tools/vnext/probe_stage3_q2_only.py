#!/usr/bin/env python3
"""Run one Q2 source-stream request without also scheduling a Summary.

This candidate-only probe exists for the global mixed-load gate, where Q2 is
scheduled every two minutes and Summary has an independent five-minute
cadence. The persisted report contains only hashes, counts, timings and
contract revisions; it never contains source, question, answer or citation
text, credentials, opaque IDs or file names.
"""

from __future__ import annotations

import argparse
import atexit
import json
from pathlib import Path
import time
import uuid

from probe_device_v2_upload import execute_purge_and_wait, json_request, require_success
from probe_device_v2_realtime import configure_source_ip
from probe_stage3_vertical import (
    build_items,
    create_source_stream,
    digest_bytes,
    digest_json,
    persistent_device,
    register_binding,
    validate_q2_grounding,
)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("transcript", type=Path)
    parser.add_argument("--api", default="http://127.0.0.1:18023/api/device/v2")
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--question", default="这次会议主要讨论了什么？")
    parser.add_argument("--timeout-seconds", type=int, default=300)
    parser.add_argument("--source-ip", default=None)
    parser.add_argument("--traffic-class", default="isolated-evaluation")
    parser.add_argument(
        "--auth-state",
        type=Path,
        default=Path.home() / ".cache" / "laoji-vnext" / "stage3-q2-only-device.json",
    )
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    configure_source_ip(args.source_ip)
    transcript = args.transcript.resolve()
    if not transcript.is_file():
        raise SystemExit("transcript not found")
    chapters, sample_sha256 = build_items(transcript)
    items = [item for chapter in chapters for item in chapter]
    source_texts = [str(item["content"]) for item in items]
    source_fingerprint = digest_json([{
        "content_sha256": item["content_sha256"],
        "source_start_utf8": item["source_start_utf8"],
        "source_end_utf8": item["source_end_utf8"],
    } for item in items])

    auth_state_path = args.auth_state.expanduser().resolve()
    state = persistent_device(args.api, auth_state_path)
    state.auth["X-Laoji-Traffic-Class"] = args.traffic_class
    status, capabilities = json_request(f"{args.api}/capabilities", headers=state.auth)
    capabilities = require_success(status, capabilities, "read capabilities")
    if not capabilities.get("source_stream_v2") or not capabilities.get("question_reader_v2"):
        raise RuntimeError("candidate Q2 capabilities are missing")
    binding_id, binding_generation, purge_id, purge_secret = register_binding(
        args.api,
        state.auth,
        auth_state_path,
    )
    cleanup_done = False

    def cleanup_binding() -> None:
        nonlocal cleanup_done
        if cleanup_done:
            return
        try:
            payload = execute_purge_and_wait(
                args.api, purge_id, purge_secret,
                request_prefix="q2-only-failure-cleanup", timeout_seconds=10,
            )
            cleanup_done = payload.get("state") == "confirmed"
        except Exception:
            return

    atexit.register(cleanup_binding)
    stream_id, task_id, groups = create_source_stream(
        api=args.api,
        auth=state.auth,
        binding_id=binding_id,
        binding_generation=binding_generation,
        chapters=chapters,
        capability="question",
        input_sha256=source_fingerprint,
        timeout_seconds=args.timeout_seconds,
    )
    payload = {
        "schema_version": 2,
        "contract_revision": "question.reader.v2",
        "provider_revision": "q2-reader-v2",
        "snapshot_id": "q2-only-snapshot-" + uuid.uuid4().hex,
        "source_fingerprint": source_fingerprint,
        "question": args.question,
        "binding_generation": binding_generation,
        "binding_revision": 1,
        "cancel_revision": 0,
        "task_id": task_id,
        "source_stream_id": stream_id,
        "source_stream_verified": False,
        "sources": [],
    }
    started_at_epoch_ms = round(time.time() * 1000)
    started = time.perf_counter()
    status, result = json_request(
        f"{args.api}/meetings/{binding_id}/questions-v2",
        method="POST",
        headers=state.auth,
        payload=payload,
    )
    result = require_success(status, result, "run Q2 reader")
    elapsed_ms = round((time.perf_counter() - started) * 1000)
    completed_at_epoch_ms = round(time.time() * 1000)
    citation_count, exact_count = validate_q2_grounding(result, source_texts)

    replay_started = time.perf_counter()
    replay_status, replay = json_request(
        f"{args.api}/meetings/{binding_id}/questions-v2",
        method="POST",
        headers=state.auth,
        payload=payload,
    )
    replay = require_success(replay_status, replay, "replay Q2 reader")
    replay_elapsed_ms = round((time.perf_counter() - replay_started) * 1000)

    purged = execute_purge_and_wait(
        args.api, purge_id, purge_secret,
        request_prefix="q2-only-cleanup",
    )
    cleanup_done = True
    atexit.unregister(cleanup_binding)

    report = {
        "schema_version": 1,
        "candidate_only": True,
        "production_mutation": False,
        "sample_sha256": sample_sha256,
        "source_fingerprint": source_fingerprint,
        "source": {
            "chapter_count": len(chapters),
            "item_count": len(items),
            "duration_ms": max(int(item["end_ms"]) for item in items),
        },
        "question_sha256": digest_bytes(args.question.encode("utf-8")),
        "started_at_epoch_ms": started_at_epoch_ms,
        "completed_at_epoch_ms": completed_at_epoch_ms,
        "elapsed_ms": elapsed_ms,
        "replay_elapsed_ms": replay_elapsed_ms,
        "replay_identical": digest_json(result) == digest_json(replay),
        "answer_kind": result.get("answer_kind"),
        "answer_sha256": digest_bytes(str(result.get("answer") or "").encode("utf-8")),
        "clause_count": len(result.get("clauses") or []),
        "citation_count": citation_count,
        "citation_exact_match_count": exact_count,
        "group_terminal_states": sorted({str(group.get("state")) for group in groups}),
        "contract_revision": result.get("contract_revision"),
        "provider_revision": result.get("provider_revision"),
        "model_revision": result.get("model_revision"),
        "cleanup_state": purged.get("state"),
    }
    args.output.parent.mkdir(parents=True, exist_ok=True)
    temporary = args.output.with_suffix(args.output.suffix + ".tmp")
    temporary.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    temporary.replace(args.output)
    print(json.dumps({
        "elapsed_ms": elapsed_ms,
        "answer_kind": report["answer_kind"],
        "citation_count": citation_count,
        "citation_exact_match_count": exact_count,
        "replay_identical": report["replay_identical"],
        "cleanup_state": report["cleanup_state"],
    }, ensure_ascii=False), flush=True)
    return 0 if (
        citation_count == exact_count
        and report["replay_identical"] is True
        and report["cleanup_state"] in {"completed", "confirmed"}
    ) else 1


if __name__ == "__main__":
    raise SystemExit(main())
