"""Real Q2 inference plus isolated in-process HTTP health observation.

No business database, task worker or public port is opened. Sources and the
result stay in private files; stdout contains only checks/counts/timings. A
health response is not a semantic-quality oracle for the generated answer.
"""
from __future__ import annotations

import argparse
import asyncio
import json
import os
from pathlib import Path
import time


def health_checks(observations, after, *, probe_before, probe_after):
    queue = after.get("queue") or {}
    inference = (after.get("inference") or {}).get("last_by_operation") or {}
    return {
        "active_reader_observed": "question.q2.reader.v2" in observations,
        "active_review_observed": "question.q2.evidence.v3" in observations,
        "availability_probe_not_repeated": probe_before == probe_after,
        "final_queue_idle": queue.get("depth") == 0 and queue.get("active") is None,
        "latest_review_visible": (queue.get("last") or {}).get("operation") == "question.q2.evidence.v3",
        "fresh_inference_visible": all(op in inference
            for op in ("question.q2.reader.v2", "question.q2.evidence.v3")),
    }


async def run(args):
    for row in Path(f"/proc/{args.runtime_pid}/environ").read_bytes().split(b"\0"):
        key, sep, value = row.partition(b"=")
        if sep:
            os.environ[key.decode()] = value.decode()
    if args.module_dir:
        import app.services
        app.services.__path__.insert(0, str(args.module_dir.resolve()))
    from fastapi import FastAPI
    import httpx
    from app.services import readiness_service as health, vnext_question_reader as reader
    evidence = json.loads(args.evidence.read_text())
    sources = [{"source_type": "transcript", "source_id": row["segmentId"],
        "source_revision_id": evidence["transcriptRevisionId"], "text": row["text"],
        "content_sha256": reader._sha256_text(row["text"])} for row in evidence["transcript"]]
    if evidence.get("manualNote"):
        text = evidence["manualNote"]
        sources.append({"source_type": "manual_note", "source_id": "manual-note",
            "source_revision_id": str(evidence["manualNoteRevision"]), "text": text,
            "content_sha256": reader._sha256_text(text)})
    payload = {"schema_version": 2, "contract_revision": reader.CONTRACT_REVISION,
        "provider_revision": reader.PROVIDER_REVISION, "snapshot_id": "isolated-health-observation",
        "source_stream_verified": True, "sources": sources,
        "source_fingerprint": reader._source_fingerprint(sources), "question": args.question}
    app = FastAPI()

    @app.get("/llm-state")
    async def state():
        return await health._llm_readiness_state()

    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://isolated") as client:
        await client.get("/llm-state")
        await health._LLM_READINESS_TASK
        before = (await client.get("/llm-state")).json()
        if before.get("ready") is not True:
            raise RuntimeError("real_provider_not_ready")
        completed = health._LLM_READINESS_CACHE["completed_at"]
        job = asyncio.create_task(asyncio.to_thread(reader.read_q2, payload))
        observations, elapsed = [], []
        while not job.done():
            began = time.perf_counter()
            current = (await client.get("/llm-state")).json()
            elapsed.append((time.perf_counter() - began) * 1000)
            queue = current.get("queue") or {}
            observations.append(queue.get("active", {}).get("operation") if queue.get("active") else None)
            await asyncio.sleep(.08)
        result = await job
        after = (await client.get("/llm-state")).json()
    checks = health_checks(observations, after, probe_before=completed,
                           probe_after=health._LLM_READINESS_CACHE["completed_at"])
    report = {"boundary": "isolated in-process HTTP health and real configured Q2 model",
        "checks": checks, "health_requests": len(elapsed),
        "health_wall_ms_max": round(max(elapsed), 3), "result": result}
    descriptor = os.open(args.output, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(descriptor, "w") as output:
        output.write(json.dumps(report, ensure_ascii=False, indent=2) + "\n")
    print(json.dumps({key: value for key, value in report.items() if key != "result"}), flush=True)
    return 0 if all(checks.values()) else 2


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--runtime-pid", type=int, required=True)
    parser.add_argument("--module-dir", type=Path)
    parser.add_argument("--evidence", type=Path, required=True)
    parser.add_argument("--question", required=True)
    parser.add_argument("--output", type=Path, required=True)
    raise SystemExit(asyncio.run(run(parser.parse_args())))
