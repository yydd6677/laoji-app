#!/usr/bin/env python3
"""Measure sequential real-media imports through the isolated Stage 2 worker.

The probe reuses one ephemeral device context, uploads each media object through
the real R2 contract, waits for durable stable/final events, acknowledges them,
and drains the resulting object cleanup obligations. It never records transcript
text, object URLs, credentials, or source filenames in the report.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import mimetypes
from pathlib import Path
import time
import uuid

from app.services import (
    device_identity,
    vnext_import_transcript_store,
    vnext_upload_store,
)
from app.services.device_v2_identity import DeviceV2Context
from tools.vnext.probe_stage2_concurrency import (
    commit_entry,
    create_entry,
    put_object,
)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("media", nargs="+", type=Path)
    parser.add_argument("--timeout-seconds", type=int, default=600)
    parser.add_argument("--output", type=Path, required=True)
    return parser.parse_args()


def sha256_bytes(payload: bytes) -> str:
    return "sha256:" + hashlib.sha256(payload).hexdigest()


def percentile(values: list[float], fraction: float) -> float:
    if not values:
        raise RuntimeError("performance sample set is empty")
    ordered = sorted(values)
    return ordered[max(0, min(len(ordered) - 1, math.ceil(len(ordered) * fraction) - 1))]


def wait_for_transcript(
    context: DeviceV2Context,
    task_id: str,
    *,
    started_at: float,
    timeout_seconds: int,
) -> dict:
    deadline = time.monotonic() + timeout_seconds
    first_stable_ms: int | None = None
    first_stable_source_end_ms: int | None = None
    snapshot: dict | None = None
    while time.monotonic() < deadline:
        snapshot = vnext_import_transcript_store.get_event_snapshot(
            context,
            task_id,
            after_event_seq=0,
            limit=1024,
        )
        if snapshot is not None:
            stable = [
                event
                for event in snapshot["events"]
                if event["event_kind"] == "stable" and event["outcome"] == "text"
            ]
            if stable and first_stable_ms is None:
                first_stable_ms = round((time.perf_counter() - started_at) * 1000)
                first_stable_source_end_ms = int(stable[0]["source_end_ms"])
            if snapshot["state"] in {"succeeded", "no_content", "failed", "cancelled"}:
                break
        time.sleep(0.2)
    if snapshot is None or snapshot["state"] != "succeeded":
        raise RuntimeError(f"import did not produce text: {snapshot and snapshot['state']}")
    events = list(snapshot["events"])
    if not events or events[-1]["event_kind"] != "final" or first_stable_ms is None:
        raise RuntimeError("import transcript event sequence is incomplete")
    wall_ms = round((time.perf_counter() - started_at) * 1000)
    duration_ms = int(events[-1]["source_end_ms"])
    if duration_ms < 1:
        raise RuntimeError("import source duration is invalid")
    projection_sha256 = sha256_bytes(json.dumps(
        events,
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
    ).encode("utf-8"))
    acknowledged = vnext_import_transcript_store.ack_events(
        context,
        task_id,
        through_event_seq=int(snapshot["last_event_seq"]),
        projection_sha256=projection_sha256,
    )
    if int(acknowledged["through_event_seq"]) != int(snapshot["last_event_seq"]):
        raise RuntimeError("import transcript acknowledgement did not advance")
    return {
        "state": snapshot["state"],
        "stable_events": sum(event["event_kind"] == "stable" for event in events),
        "final_events": sum(event["event_kind"] == "final" for event in events),
        "first_stable_ms": first_stable_ms,
        "first_stable_source_end_ms": first_stable_source_end_ms,
        "wall_ms": wall_ms,
        "source_duration_ms": duration_ms,
        "rtf": round(wall_ms / duration_ms, 6),
    }


def main() -> int:
    args = parse_args()
    media_paths = [path.resolve() for path in args.media]
    if not media_paths or any(not path.is_file() for path in media_paths):
        raise SystemExit("all media inputs must be files")
    context = DeviceV2Context(str(uuid.uuid4()), str(uuid.uuid4()), 1, 1)
    runs: list[dict] = []
    for ordinal, media in enumerate(media_paths, start=1):
        payload = media.read_bytes()
        if not payload:
            raise RuntimeError("media input is empty")
        source_sha256 = sha256_bytes(payload)
        entry = create_entry(
            context,
            ordinal=ordinal,
            source_size=len(payload),
            source_sha256=source_sha256,
            mime_type=mimetypes.guess_type(media.name)[0] or "application/octet-stream",
        )
        upload_ms = round(put_object(str(entry.session["put_url"]), payload) * 1000)
        commit_entry(context, entry, source_sha256)
        started_at = time.perf_counter()
        result = wait_for_transcript(
            context,
            entry.task_id,
            started_at=started_at,
            timeout_seconds=args.timeout_seconds,
        )
        runs.append({
            "ordinal": ordinal,
            "source_bytes": len(payload),
            "source_sha256": source_sha256,
            "upload_ms": upload_ms,
            **result,
        })

    with device_identity.control_connection() as connection:
        pending_epoch = connection.execute(
            "SELECT MAX(not_before_epoch) FROM vnext_object_cleanup_obligations "
            "WHERE state = 'pending'"
        ).fetchone()[0]
    cleanup_processed = (
        vnext_upload_store.process_cleanup_obligations(
            now_epoch=int(pending_epoch),
            limit=max(16, len(runs) * 2),
        )
        if pending_epoch is not None else 0
    )
    first_values = [float(run["first_stable_ms"]) for run in runs]
    rtf_values = [float(run["rtf"]) for run in runs]
    report = {
        "schema_version": 1,
        "sample_count": len(runs),
        "all_text_succeeded": all(run["state"] == "succeeded" for run in runs),
        "all_single_final": all(run["final_events"] == 1 for run in runs),
        "first_stable_ms_p50": round(percentile(first_values, 0.50), 3),
        "first_stable_ms_p95": round(percentile(first_values, 0.95), 3),
        "import_rtf_p50": round(percentile(rtf_values, 0.50), 6),
        "import_rtf_p95": round(percentile(rtf_values, 0.95), 6),
        "cleanup_processed": cleanup_processed,
        "runs": runs,
    }
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps({key: value for key, value in report.items() if key != "runs"}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
