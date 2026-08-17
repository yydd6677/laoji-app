#!/usr/bin/env python3
"""Run two real R2 imports while injecting one realtime ASR request.

Run with ``PYTHONPATH=services/laoji-api`` and the isolated candidate's
DATABASE/R2/ASR environment.  The script uses the production stores without
auth dependency overrides; device-v2 HTTP authentication has a separate probe.
No credentials, presigned URLs or transcript text are persisted.
"""

from __future__ import annotations

import argparse
import base64
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
import hashlib
import json
from pathlib import Path
import subprocess
import threading
import time
import uuid
from urllib import request

from app.services import (
    device_identity,
    vnext_asr_client,
    vnext_import_transcript_store,
    vnext_task_store,
    vnext_upload_store,
)
from app.services.device_v2_identity import DeviceV2Context


@dataclass(frozen=True)
class ImportEntry:
    binding_id: str
    binding_generation: str
    session: dict
    task_id: str
    generation_id: str


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("media", type=Path)
    parser.add_argument("--timeout-seconds", type=int, default=900)
    parser.add_argument("--output", type=Path, required=True)
    return parser.parse_args()


def sha256_bytes(payload: bytes) -> str:
    return "sha256:" + hashlib.sha256(payload).hexdigest()


def put_object(url: str, payload: bytes) -> float:
    started = time.perf_counter()
    req = request.Request(
        url,
        data=payload,
        method="PUT",
        headers={"Content-Length": str(len(payload))},
    )
    with request.urlopen(req, timeout=300) as response:
        if not 200 <= response.status < 300:
            raise RuntimeError(f"R2 PUT failed: HTTP {response.status}")
    return time.perf_counter() - started


def realtime_pcm(media: Path) -> bytes:
    return subprocess.check_output([
        "ffmpeg", "-nostdin", "-hide_banner", "-loglevel", "error",
        "-ss", "0", "-t", "8", "-i", str(media), "-vn", "-ac", "1",
        "-ar", "16000", "-f", "s16le", "pipe:1",
    ])


def create_entry(
    context: DeviceV2Context,
    *,
    ordinal: int,
    source_size: int,
    source_sha256: str,
    mime_type: str,
) -> ImportEntry:
    binding_id = str(uuid.uuid4())
    binding_generation = uuid.uuid4().hex
    vnext_task_store.register_binding(
        context,
        binding_id=binding_id,
        binding_generation=binding_generation,
        binding_epoch_seq=ordinal,
        binding_revision=1,
        cancel_revision=0,
    )
    session, reused = vnext_upload_store.create_upload_session(
        context,
        session_id="concurrent-upload-" + uuid.uuid4().hex,
        binding_id=binding_id,
        binding_generation=binding_generation,
        binding_revision=1,
        cancel_revision=0,
        client_operation_id="concurrent-operation-" + uuid.uuid4().hex,
        asset_id="concurrent-asset-" + uuid.uuid4().hex,
        asset_generation=uuid.uuid4().hex,
        expected_size=source_size,
        expected_sha256=source_sha256,
        mime_type=mime_type,
    )
    if reused or session["mode"] != "single" or not session.get("put_url"):
        raise RuntimeError("concurrency probe requires two fresh single uploads")
    return ImportEntry(
        binding_id=binding_id,
        binding_generation=binding_generation,
        session=session,
        task_id="concurrent-transcript-" + uuid.uuid4().hex,
        generation_id="concurrent-generation-" + uuid.uuid4().hex,
    )


def commit_entry(
    context: DeviceV2Context,
    entry: ImportEntry,
    source_sha256: str,
) -> None:
    vnext_upload_store.complete_upload_session(
        context,
        entry.session["session_id"],
        binding_generation=entry.binding_generation,
        binding_revision=1,
        cancel_revision=0,
        parts=[],
        transcription_task_id=entry.task_id,
        transcription_generation_id=entry.generation_id,
        transcription_input_sha256=source_sha256,
    )


def main() -> int:
    args = parse_args()
    media = args.media.resolve()
    payload = media.read_bytes()
    if not payload:
        raise SystemExit("media is empty")
    source_sha256 = sha256_bytes(payload)
    context = DeviceV2Context(str(uuid.uuid4()), str(uuid.uuid4()), 1, 1)
    entries = [
        create_entry(
            context,
            ordinal=ordinal,
            source_size=len(payload),
            source_sha256=source_sha256,
            mime_type="video/mp4",
        )
        for ordinal in (1, 2)
    ]
    started = time.perf_counter()
    with ThreadPoolExecutor(max_workers=2) as executor:
        futures = [
            executor.submit(put_object, str(entry.session["put_url"]), payload)
            for entry in entries
        ]
        upload_seconds = [future.result() for future in futures]
    for entry in entries:
        commit_entry(context, entry, source_sha256)

    realtime_result: dict = {}
    realtime_failure: list[BaseException] = []
    pcm = realtime_pcm(media)

    def inject_realtime() -> None:
        try:
            deadline = time.monotonic() + args.timeout_seconds
            while time.monotonic() < deadline:
                if any(
                    (snapshot := vnext_import_transcript_store.get_event_snapshot(
                        context, entry.task_id, after_event_seq=0, limit=1,
                    )) is not None and int(snapshot["last_event_seq"]) > 0
                    for entry in entries
                ):
                    break
                time.sleep(0.2)
            else:
                raise RuntimeError("offline task never published a stable event")
            request_started = time.perf_counter()
            response = vnext_asr_client.transcribe_batch(
                priority="realtime",
                timeout_seconds=600,
                items=[{
                    "id": "concurrency-realtime",
                    "pcm_base64": base64.b64encode(pcm).decode("ascii"),
                    "sample_rate": 16_000,
                    "language": "Chinese",
                    "source_start_ms": 0,
                    "source_end_ms": round(len(pcm) * 1000 / (16_000 * 2)),
                }],
            )
            item = response["items"][0]
            realtime_result.update({
                "wall_ms": round((time.perf_counter() - request_started) * 1000),
                "queue_ms": int(item["queue_ms"]),
                "infer_ms": int(item["infer_ms"]),
                "outcome": item["outcome"],
                "model_revision": item["model_revision"],
            })
        except BaseException as exc:
            realtime_failure.append(exc)

    realtime_thread = threading.Thread(target=inject_realtime, name="vnext-realtime-probe")
    realtime_thread.start()
    deadline = time.monotonic() + args.timeout_seconds
    snapshots: dict[str, dict] = {}
    while time.monotonic() < deadline:
        for entry in entries:
            snapshot = vnext_import_transcript_store.get_event_snapshot(
                context, entry.task_id, after_event_seq=0, limit=1024,
            )
            if snapshot is not None:
                snapshots[entry.task_id] = snapshot
        if len(snapshots) == 2 and all(
            snapshot["state"] in {"succeeded", "no_content", "failed", "cancelled"}
            for snapshot in snapshots.values()
        ):
            break
        time.sleep(1)
    realtime_thread.join(timeout=600)
    if realtime_thread.is_alive():
        raise RuntimeError("realtime probe did not finish")
    if realtime_failure:
        raise RuntimeError("realtime probe failed") from realtime_failure[0]
    if len(snapshots) != 2 or any(
        snapshot["state"] not in {"succeeded", "no_content"}
        for snapshot in snapshots.values()
    ):
        raise RuntimeError(f"imports did not finish: {snapshots}")

    stable_counts = []
    final_counts = []
    for entry in entries:
        snapshot = snapshots[entry.task_id]
        events = snapshot["events"]
        stable_counts.append(sum(event["event_kind"] == "stable" for event in events))
        final_counts.append(sum(event["event_kind"] == "final" for event in events))
        projection = sha256_bytes(json.dumps(
            events,
            ensure_ascii=False,
            sort_keys=True,
            separators=(",", ":"),
        ).encode())
        vnext_import_transcript_store.ack_events(
            context,
            entry.task_id,
            through_event_seq=int(snapshot["last_event_seq"]),
            projection_sha256=projection,
        )

    with device_identity.control_connection() as connection:
        pending = connection.execute(
            "SELECT MAX(not_before_epoch) FROM vnext_object_cleanup_obligations WHERE state = 'pending'"
        ).fetchone()[0]
        task_counts = {
            str(row[0]): int(row[1])
            for row in connection.execute(
                "SELECT capability, COUNT(*) FROM vnext_tasks "
                "WHERE device_id = ? AND epoch_id = ? GROUP BY capability",
                (context.device_id, context.epoch_id),
            ).fetchall()
        }
        task_total = int(connection.execute(
            "SELECT COUNT(*) FROM vnext_tasks WHERE device_id = ? AND epoch_id = ?",
            (context.device_id, context.epoch_id),
        ).fetchone()[0])
    cleanup_processed = (
        vnext_upload_store.process_cleanup_obligations(now_epoch=int(pending), limit=16)
        if pending is not None else 0
    )
    report = {
        "source_bytes_each": len(payload),
        "source_sha256": source_sha256,
        "upload_count": 2,
        "upload_wall_ms": [round(value * 1000) for value in upload_seconds],
        "task_count": task_total,
        "task_counts_by_capability": task_counts,
        "task_states": [snapshots[entry.task_id]["state"] for entry in entries],
        "stable_event_counts": stable_counts,
        "final_event_counts": final_counts,
        "realtime": realtime_result,
        "cleanup_processed": cleanup_processed,
        "wall_ms": round((time.perf_counter() - started) * 1000),
    }
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps(report, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
