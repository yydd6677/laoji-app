#!/usr/bin/env python3
"""Replay one real transcript through the Stage 3 device-v2 vertical slice.

The probe exercises the public candidate contracts rather than importing the
stores directly: P-256 bootstrap, binding registration, encrypted source
stream upload, durable Facts V3 generation, artifact readback, Q2 grounded on
a second immutable source stream, idempotent Q2 replay and purge.

The JSON report deliberately contains only hashes, counts, timings and
contract revisions. Transcript text, model answers, device credentials and
opaque identifiers are never persisted. Use ``--show-content`` only for an
interactive human quality review; it writes the answer and overview to stdout,
not to the report file.
"""

from __future__ import annotations

import argparse
import atexit
import hashlib
import json
from pathlib import Path
import re
import time
import uuid
from typing import Any, Iterable

from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import ec

from probe_device_v2_realtime import BootstrapState, bootstrap, refresh_auth
from probe_device_v2_upload import json_request, require_success


SHA_PREFIX = "sha256:"
DEFAULT_CHAPTER_BYTES = 48 * 1024
SRT_TIME = re.compile(
    r"^(?P<sh>\d{2}):(?P<sm>\d{2}):(?P<ss>\d{2})[,.](?P<sms>\d{3})"
    r"\s+-->\s+"
    r"(?P<eh>\d{2}):(?P<em>\d{2}):(?P<es>\d{2})[,.](?P<ems>\d{3})$"
)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("transcript", type=Path)
    parser.add_argument("--api", default="http://127.0.0.1:18023/api/device/v2")
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--question", default="这次会议主要讨论了什么？")
    parser.add_argument(
        "--chapter-bytes",
        type=int,
        default=DEFAULT_CHAPTER_BYTES,
        help="match the Android source-stream byte boundary",
    )
    parser.add_argument(
        "--chapter-seconds",
        type=int,
        default=0,
        help="optional diagnostic time boundary; zero uses only Android byte packing",
    )
    parser.add_argument("--timeout-seconds", type=int, default=900)
    parser.add_argument(
        "--skip-question",
        action="store_true",
        help="exercise only the summary source stream and artifact path",
    )
    parser.add_argument("--show-content", action="store_true")
    parser.add_argument(
        "--auth-state",
        type=Path,
        default=Path.home() / ".cache" / "laoji-vnext" / "stage3-probe-device.json",
        help="chmod-0600 candidate device key used to avoid repeated bootstrap registration",
    )
    return parser.parse_args()


def canonical(value: Any) -> bytes:
    return json.dumps(
        value,
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
    ).encode("utf-8")


def digest_bytes(value: bytes) -> str:
    return SHA_PREFIX + hashlib.sha256(value).hexdigest()


def digest_json(value: Any) -> str:
    return digest_bytes(canonical(value))


def manifest_page_sha256(descriptors: Iterable[dict[str, Any]]) -> str:
    return digest_json(list(descriptors))


def bundle_sha256(items: Iterable[dict[str, Any]]) -> str:
    material = []
    for item in items:
        content = str(item.get("content") or "")
        material.append({
            "item_id": str(item.get("item_id") or ""),
            "source_type": str(item.get("source_type") or ""),
            "source_id": str(item.get("source_id") or ""),
            "source_revision_id": str(item.get("source_revision_id") or ""),
            "source_start_utf8": int(item.get("source_start_utf8") or 0),
            "source_end_utf8": int(item.get("source_end_utf8") or 0),
            "content_sha256": str(item.get("content_sha256") or ""),
            "content_bytes": len(content.encode("utf-8")),
            "start_ms": item.get("start_ms"),
            "end_ms": item.get("end_ms"),
            "speaker": item.get("speaker"),
        })
    return digest_json(material)


def chapter_sha256(bundle_hashes: Iterable[str]) -> str:
    return digest_json(list(bundle_hashes))


def timestamp_ms(parts: tuple[str, str, str, str]) -> int:
    hour, minute, second, millis = (int(value) for value in parts)
    return (((hour * 60) + minute) * 60 + second) * 1000 + millis


def parse_srt(path: Path) -> list[tuple[int, int, str]]:
    text = path.read_text(encoding="utf-8-sig")
    entries: list[tuple[int, int, str]] = []
    for block in re.split(r"\r?\n\s*\r?\n", text.strip()):
        lines = [line.strip() for line in block.splitlines() if line.strip()]
        if len(lines) < 2:
            continue
        time_index = next((index for index, line in enumerate(lines) if SRT_TIME.match(line)), None)
        if time_index is None or time_index + 1 >= len(lines):
            continue
        match = SRT_TIME.match(lines[time_index])
        assert match is not None
        start_ms = timestamp_ms((match["sh"], match["sm"], match["ss"], match["sms"]))
        end_ms = timestamp_ms((match["eh"], match["em"], match["es"], match["ems"]))
        content = " ".join(lines[time_index + 1:]).strip()
        if content and end_ms >= start_ms:
            entries.append((start_ms, end_ms, content))
    if not entries:
        raise ValueError("transcript contains no valid SRT entries")
    return entries


def build_items(
    path: Path,
    chapter_seconds: int = 0,
    chapter_bytes: int = DEFAULT_CHAPTER_BYTES,
) -> tuple[list[list[dict[str, Any]]], str]:
    entries = parse_srt(path)
    raw_hash = digest_bytes(path.read_bytes())
    source_id = "sample:" + raw_hash.removeprefix(SHA_PREFIX)[:24]
    source_revision_id = "srt:" + raw_hash.removeprefix(SHA_PREFIX)
    offset = 0
    chapters: list[list[dict[str, Any]]] = []
    current: list[dict[str, Any]] = []
    current_bytes = 0
    current_time_bucket: int | None = None
    for ordinal, (start_ms, end_ms, content) in enumerate(entries):
        encoded = content.encode("utf-8")
        start_utf8 = offset
        end_utf8 = start_utf8 + len(encoded)
        offset = end_utf8 + 1
        time_bucket = (
            start_ms // (chapter_seconds * 1000)
            if chapter_seconds > 0
            else None
        )
        if current and (
            current_bytes + len(encoded) > chapter_bytes
            or (time_bucket is not None and time_bucket != current_time_bucket)
        ):
            chapters.append(current)
            current = []
            current_bytes = 0
        if not current:
            current_time_bucket = time_bucket
        current.append({
            "item_id": f"srt-item-{ordinal:06d}-{raw_hash[-12:]}",
            "source_type": "transcript",
            "source_id": source_id,
            "source_revision_id": source_revision_id,
            "source_start_utf8": start_utf8,
            "source_end_utf8": end_utf8,
            "content_sha256": digest_bytes(encoded),
            "content": content,
            "start_ms": start_ms,
            "end_ms": end_ms,
            "speaker": None,
        })
        current_bytes += len(encoded)
    if current:
        chapters.append(current)
    return chapters, raw_hash


def persistent_device(api: str, path: Path) -> BootstrapState:
    if path.is_file():
        value = json.loads(path.read_text(encoding="utf-8"))
        if value.get("api") != api:
            raise RuntimeError("candidate auth state belongs to another API")
        private_key = serialization.load_pem_private_key(
            str(value["private_key_pem"]).encode("ascii"),
            password=None,
        )
        if not isinstance(private_key, ec.EllipticCurvePrivateKey):
            raise RuntimeError("candidate auth state key is invalid")
        state = BootstrapState(
            auth={},
            purge=dict(value["purge"]),
            device_id=str(value["device_id"]),
            epoch_id=str(value["epoch_id"]),
            private_key=private_key,
            public_key_hash=str(value["public_key_hash"]),
            key_version=int(value["key_version"]),
        )
        return BootstrapState(
            auth=refresh_auth(api, state),
            purge=state.purge,
            device_id=state.device_id,
            epoch_id=state.epoch_id,
            private_key=state.private_key,
            public_key_hash=state.public_key_hash,
            key_version=state.key_version,
        )
    state = bootstrap(api)
    path.parent.mkdir(parents=True, exist_ok=True)
    payload = {
        "schema_version": 1,
        "api": api,
        "device_id": state.device_id,
        "epoch_id": state.epoch_id,
        "public_key_hash": state.public_key_hash,
        "key_version": state.key_version,
        "next_binding_epoch_seq": 1,
        "purge": state.purge,
        "private_key_pem": state.private_key.private_bytes(
            serialization.Encoding.PEM,
            serialization.PrivateFormat.PKCS8,
            serialization.NoEncryption(),
        ).decode("ascii"),
    }
    path.write_text(json.dumps(payload, separators=(",", ":")), encoding="utf-8")
    path.chmod(0o600)
    return state


def _store_next_binding_sequence(path: Path, value: int) -> None:
    payload = json.loads(path.read_text(encoding="utf-8"))
    payload["next_binding_epoch_seq"] = value
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(json.dumps(payload, separators=(",", ":")), encoding="utf-8")
    temporary.chmod(0o600)
    temporary.replace(path)
    path.chmod(0o600)


def register_binding(
    api: str,
    auth: dict[str, str],
    auth_state_path: Path,
) -> tuple[str, str, str, str]:
    state_payload = json.loads(auth_state_path.read_text(encoding="utf-8"))
    preferred = max(1, int(state_payload.get("next_binding_epoch_seq") or 1))
    # Older probe state predates the persisted counter. Scan only in that
    # migration case; ordinary runs make exactly one registration request.
    candidates = [preferred]
    if "next_binding_epoch_seq" not in state_payload:
        candidates.extend(value for value in range(1, 513) if value != preferred)
    last_payload: dict[str, Any] = {}
    for binding_epoch_seq in candidates:
        sequence_wait_deadline = time.monotonic() + 30
        while True:
            binding_id = str(uuid.uuid4())
            binding_generation = uuid.uuid4().hex
            purge_id = str(uuid.uuid4())
            purge_secret = uuid.uuid4().hex + uuid.uuid4().hex
            status, payload = json_request(
                f"{api}/meetings/{binding_id}",
                method="PUT",
                headers=auth,
                payload={
                    "schema_version": 2,
                    "binding_generation": binding_generation,
                    "binding_epoch_seq": binding_epoch_seq,
                    "binding_revision": 1,
                    "cancel_revision": 0,
                    "purge_capability": {
                        "capability_id": purge_id,
                        "secret_sha256": hashlib.sha256(purge_secret.encode("ascii")).hexdigest(),
                        "registration_request_id": "stage3-purge-" + uuid.uuid4().hex,
                    },
                },
            )
            last_payload = payload
            detail = payload.get("detail") if isinstance(payload, dict) else None
            code = detail.get("code") if isinstance(detail, dict) else None
            if status == 409 and code == "BINDING_SEQUENCE_GAP":
                if len(candidates) > 1:
                    break
                # A mixed-load probe can reserve consecutive sequence numbers
                # for two processes. If the higher number arrives first, wait
                # for the lower registration instead of creating another
                # device identity or scanning unrelated sequence numbers.
                if time.monotonic() < sequence_wait_deadline:
                    time.sleep(0.1)
                    continue
            require_success(status, payload, "register Stage 3 binding")
            _store_next_binding_sequence(auth_state_path, binding_epoch_seq + 1)
            return binding_id, binding_generation, purge_id, purge_secret
    raise RuntimeError(
        "register Stage 3 binding failed: stored candidate device sequence is "
        f"more than 512 registrations behind server state ({last_payload!r})"
    )


def create_source_stream(
    *,
    api: str,
    auth: dict[str, str],
    binding_id: str,
    binding_generation: str,
    chapters: list[list[dict[str, Any]]],
    capability: str,
    input_sha256: str,
    timeout_seconds: int,
    summary_revisions: dict[str, str] | None = None,
) -> tuple[str, str, list[dict[str, Any]]]:
    suffix = uuid.uuid4().hex
    stream_id = f"stage3-{capability}-stream-{suffix}"
    task_id = f"stage3-{capability}-task-{suffix}"
    create_payload = {
        "schema_version": 2,
        "contract_revision": "source.stream.v2",
        "stream_id": stream_id,
        "task_id": task_id,
        "binding_generation": binding_generation,
        "binding_revision": 1,
        "cancel_revision": 0,
        "client_operation_id": f"stage3-{capability}-operation-{suffix}",
        "generation_id": f"stage3-{capability}-generation-{suffix}",
        "request_sha256": digest_json({
            "capability": capability,
            "input_sha256": input_sha256,
            "chapters": len(chapters),
        }),
        "capability": capability,
        "entity_id": "stage3-meeting-" + suffix,
        "entity_revision": 1,
        "task_input_sha256": input_sha256,
    }
    if capability == "summary":
        required_revisions = (
            "summary_handler_revision",
            "summary_prompt_revision",
            "summary_model_revision",
        )
        if summary_revisions is None or any(
            not summary_revisions.get(name) for name in required_revisions
        ):
            raise RuntimeError("candidate summary runtime revisions are missing")
        create_payload.update({name: summary_revisions[name] for name in required_revisions})
    status, created = json_request(
        f"{api}/meetings/{binding_id}/source-streams",
        method="POST",
        headers=auth,
        payload=create_payload,
    )
    require_success(status, created, f"create {capability} source stream")

    prepared: list[dict[str, Any]] = []
    descriptors: list[dict[str, Any]] = []
    for ordinal, items in enumerate(chapters):
        bundle_hash = bundle_sha256(items)
        descriptor = {
            "chapter_ordinal": ordinal,
            "declared_bundle_count": 1,
            "declared_item_count": len(items),
            "declared_uncompressed_bytes": sum(len(item["content"].encode("utf-8")) for item in items),
            "chapter_sha256": chapter_sha256([bundle_hash]),
        }
        descriptors.append(descriptor)
        prepared.append({"descriptor": descriptor, "bundle_hash": bundle_hash, "items": items})
    status, manifest = json_request(
        f"{api}/source-streams/{stream_id}/manifest-pages",
        method="POST",
        headers=auth,
        payload={
            "schema_version": 2,
            "contract_revision": "source.stream.v2",
            "page_seq": 0,
            "first_chapter_ordinal": 0,
            "descriptors": descriptors,
            "page_sha256": manifest_page_sha256(descriptors),
            "final_page": True,
        },
    )
    require_success(status, manifest, f"upload {capability} manifest")

    snapshots: list[dict[str, Any]] = []
    for ordinal, chapter in enumerate(prepared):
        # Summary streams deliberately allow only one chapter of look-ahead.
        # Wait for the durable checkpoint owner to consume enough source
        # before opening the next group. Question streams advance their cursor
        # at group commit and therefore normally pass this on the first poll.
        upload_deadline = time.monotonic() + timeout_seconds
        while True:
            status, stream_snapshot = json_request(
                f"{api}/source-streams/{stream_id}",
                headers=auth,
            )
            stream_snapshot = require_success(
                status,
                stream_snapshot,
                f"read {capability} source stream",
            )
            if ordinal <= int(stream_snapshot["next_consumable_chapter"]) + 1:
                break
            task_status, task_wire = json_request(
                f"{api}/tasks/{task_id}",
                headers=auth,
            )
            if task_status == 200:
                task = task_wire.get("task") if isinstance(task_wire, dict) else None
                if isinstance(task, dict) and task.get("state") in {
                    "failure",
                    "cancelled",
                }:
                    raise RuntimeError(
                        f"{capability} task stopped while uploading: {task.get('error_code')}"
                    )
            elif task_status not in {0, 404}:
                raise RuntimeError(
                    f"read {capability} task failed: HTTP {task_status} {task_wire}"
                )
            if time.monotonic() >= upload_deadline:
                raise TimeoutError(
                    f"{capability} source upload window did not advance to chapter {ordinal}"
                )
            time.sleep(0.5)
        group_id = f"stage3-{capability}-group-{ordinal}-{suffix}"
        descriptor = chapter["descriptor"]
        status, group = json_request(
            f"{api}/source-streams/{stream_id}/groups",
            method="POST",
            headers=auth,
            payload={
                "schema_version": 2,
                "contract_revision": "source.stream.v2",
                "group_id": group_id,
                "chapter_ordinal": ordinal,
                "declared_bundle_count": 1,
                "declared_item_count": descriptor["declared_item_count"],
                "declared_uncompressed_bytes": descriptor["declared_uncompressed_bytes"],
                "chapter_sha256": descriptor["chapter_sha256"],
                "request_sha256": digest_json({"group_id": group_id, "chapter": ordinal}),
            },
        )
        require_success(status, group, f"create {capability} chapter {ordinal}")
        status, bundle = json_request(
            f"{api}/source-bundle-groups/{group_id}/bundles",
            method="POST",
            headers=auth,
            payload={
                "schema_version": 2,
                "contract_revision": "source.stream.v2",
                "bundle_id": f"stage3-{capability}-bundle-{ordinal}-{suffix}",
                "ordinal": 0,
                "bundle_sha256": chapter["bundle_hash"],
                "items": chapter["items"],
            },
        )
        require_success(status, bundle, f"upload {capability} chapter {ordinal}")
        status, committed = json_request(
            f"{api}/source-bundle-groups/{group_id}/commit",
            method="POST",
            headers=auth,
            payload={},
        )
        committed = require_success(status, committed, f"commit {capability} chapter {ordinal}")
        snapshots.append(committed["group"])
    return stream_id, task_id, snapshots


def wait_task(
    api: str,
    auth: dict[str, str],
    task_id: str,
    timeout_seconds: int,
) -> tuple[dict[str, Any], int]:
    started = time.perf_counter()
    deadline = time.monotonic() + timeout_seconds
    last: dict[str, Any] | None = None
    while time.monotonic() < deadline:
        status, payload = json_request(f"{api}/tasks/{task_id}", headers=auth)
        if status == 200:
            last = payload["task"]
            if last.get("state") in {"success", "failure", "cancelled"}:
                return last, round((time.perf_counter() - started) * 1000)
        elif status not in {0, 404}:
            raise RuntimeError(f"task poll failed: HTTP {status} {payload}")
        time.sleep(0.5)
    raise TimeoutError(f"task did not finish: {last}")


def validate_facts_grounding(document: dict[str, Any], source_texts: list[str]) -> tuple[int, int]:
    checked = 0
    matched = 0
    normalized_sources = [" ".join(text.split()) for text in source_texts]
    # Facts V3 deterministically packs adjacent ASR/SRT rows before model
    # generation. A citation can therefore span multiple original rows while
    # remaining a verbatim, ordered substring of the meeting source.
    normalized_source_stream = " ".join(normalized_sources)
    for fact in list(document.get("facts") or []):
        for source in list(fact.get("sources") or []):
            quote = " ".join(str(source.get("quote") or "").split())
            if not quote:
                continue
            checked += 1
            if quote in normalized_source_stream:
                matched += 1
    return checked, matched


def validate_q2_grounding(result: dict[str, Any], source_texts: list[str]) -> tuple[int, int]:
    checked = 0
    matched = 0
    normalized_sources = [" ".join(text.split()) for text in source_texts]
    normalized_source_stream = " ".join(normalized_sources)
    for clause in list(result.get("clauses") or []):
        for citation in list(clause.get("citations") or []):
            quote = " ".join(str(citation.get("quote") or "").split())
            if not quote:
                continue
            checked += 1
            if quote in normalized_source_stream:
                matched += 1
    return checked, matched


def task_attempt_number(task: dict[str, Any]) -> int | None:
    match = re.search(r":attempt:(\d+):", str(task.get("current_attempt_id") or ""))
    return int(match.group(1)) if match else None


def main() -> int:
    args = parse_args()
    transcript = args.transcript.resolve()
    if not transcript.is_file():
        raise SystemExit(f"transcript not found: {transcript}")
    if args.chapter_seconds < 0 or (0 < args.chapter_seconds < 60):
        raise SystemExit("chapter-seconds must be zero or at least 60")
    if args.chapter_bytes < 1024:
        raise SystemExit("chapter-bytes must be at least 1024")
    started = time.perf_counter()
    chapters, sample_sha256 = build_items(
        transcript,
        args.chapter_seconds,
        args.chapter_bytes,
    )
    all_items = [item for chapter in chapters for item in chapter]
    source_texts = [str(item["content"]) for item in all_items]
    source_fingerprint = digest_json([{
        "content_sha256": item["content_sha256"],
        "source_start_utf8": item["source_start_utf8"],
        "source_end_utf8": item["source_end_utf8"],
    } for item in all_items])

    auth_state_path = args.auth_state.expanduser().resolve()
    state = persistent_device(args.api, auth_state_path)
    status, capabilities = json_request(f"{args.api}/capabilities", headers=state.auth)
    capabilities = require_success(status, capabilities, "read capabilities")
    required = ("source_stream_v2", "question_reader_v2")
    if any(not capabilities.get(name) for name in required):
        raise RuntimeError(f"candidate capabilities missing: {required}")
    summary_revisions = {
        name: str(capabilities.get(name) or "")
        for name in (
            "summary_handler_revision",
            "summary_prompt_revision",
            "summary_model_revision",
        )
    }
    if any(not value for value in summary_revisions.values()):
        raise RuntimeError("candidate summary runtime revisions are missing")
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
        status, _payload = json_request(
            f"{args.api}/purge-capabilities/{purge_id}/execute",
            method="POST",
            headers={
                "Authorization": f"LaojiPurge {purge_secret}",
                "X-Laoji-Purge-Request-Id": "stage3-cleanup-" + uuid.uuid4().hex,
            },
        )
        cleanup_done = 200 <= status < 300

    atexit.register(cleanup_binding)

    summary_started_at_epoch_ms = round(time.time() * 1000)
    summary_end_to_end_started = time.perf_counter()
    summary_stream_id, summary_task_id, summary_groups = create_source_stream(
        api=args.api,
        auth=state.auth,
        binding_id=binding_id,
        binding_generation=binding_generation,
        chapters=chapters,
        capability="summary",
        input_sha256=source_fingerprint,
        timeout_seconds=args.timeout_seconds,
        summary_revisions=summary_revisions,
    )
    del summary_stream_id
    summary_task, summary_elapsed_ms = wait_task(
        args.api, state.auth, summary_task_id, args.timeout_seconds,
    )
    summary_end_to_end_elapsed_ms = round(
        (time.perf_counter() - summary_end_to_end_started) * 1000
    )
    if summary_task.get("state") != "success":
        raise RuntimeError(f"summary task failed: {summary_task.get('error_code')}")
    status, artifact_wire = json_request(
        f"{args.api}/tasks/{summary_task_id}/artifact",
        headers=state.auth,
    )
    artifact = require_success(status, artifact_wire, "read Facts V3 artifact")["artifact"]
    output = dict(artifact.get("output") or {})
    if (
        output.get("prompt_revision") != summary_revisions["summary_prompt_revision"]
        or output.get("model_revision") != summary_revisions["summary_model_revision"]
    ):
        raise RuntimeError("summary artifact runtime revision does not match admission fence")
    facts_document = dict(output.get("facts_document") or {})
    fact_checked, fact_matched = validate_facts_grounding(facts_document, source_texts)
    summary_completed_at_epoch_ms = round(time.time() * 1000)

    question_groups: list[dict[str, Any]] = []
    q2_result: dict[str, Any] | None = None
    replay_result: dict[str, Any] | None = None
    q2_elapsed_ms: int | None = None
    q2_started_at_epoch_ms: int | None = None
    q2_completed_at_epoch_ms: int | None = None
    replay_elapsed_ms: int | None = None
    q2_checked = 0
    q2_matched = 0
    if not args.skip_question:
        question_stream_id, question_task_id, question_groups = create_source_stream(
            api=args.api,
            auth=state.auth,
            binding_id=binding_id,
            binding_generation=binding_generation,
            chapters=chapters,
            capability="question",
            input_sha256=source_fingerprint,
            timeout_seconds=args.timeout_seconds,
        )
        question_payload = {
            "schema_version": 2,
            "contract_revision": "question.reader.v2",
            "provider_revision": "q2-reader-v2",
            "snapshot_id": "stage3-q2-snapshot-" + uuid.uuid4().hex,
            "source_fingerprint": source_fingerprint,
            "question": args.question,
            "binding_generation": binding_generation,
            "binding_revision": 1,
            "cancel_revision": 0,
            "task_id": question_task_id,
            "source_stream_id": question_stream_id,
            "source_stream_verified": False,
            "sources": [],
        }
        q2_started_at_epoch_ms = round(time.time() * 1000)
        q2_started = time.perf_counter()
        status, q2_result = json_request(
            f"{args.api}/meetings/{binding_id}/questions-v2",
            method="POST",
            headers=state.auth,
            payload=question_payload,
        )
        q2_result = require_success(status, q2_result, "run Q2 reader")
        q2_elapsed_ms = round((time.perf_counter() - q2_started) * 1000)
        q2_completed_at_epoch_ms = round(time.time() * 1000)
        q2_checked, q2_matched = validate_q2_grounding(q2_result, source_texts)
        replay_started = time.perf_counter()
        replay_status, replay_result = json_request(
            f"{args.api}/meetings/{binding_id}/questions-v2",
            method="POST",
            headers=state.auth,
            payload=question_payload,
        )
        replay_result = require_success(replay_status, replay_result, "replay Q2 reader")
        replay_elapsed_ms = round((time.perf_counter() - replay_started) * 1000)

    purge_status, purge_result = json_request(
        f"{args.api}/purge-capabilities/{purge_id}/execute",
        method="POST",
        headers={
            "Authorization": f"LaojiPurge {purge_secret}",
            "X-Laoji-Purge-Request-Id": "stage3-cleanup-" + uuid.uuid4().hex,
        },
    )
    purge_result = require_success(purge_status, purge_result, "purge Stage 3 binding")
    cleanup_done = True
    atexit.unregister(cleanup_binding)

    overview = dict(facts_document.get("overview") or {})
    report = {
        "schema_version": 1,
        "candidate_api": args.api,
        "sample_sha256": sample_sha256,
        "source_fingerprint": source_fingerprint,
        "input": {
            "chapter_count": len(chapters),
            "item_count": len(all_items),
            "duration_ms": max(int(item["end_ms"]) for item in all_items),
            "chapter_seconds": args.chapter_seconds,
            "chapter_bytes": args.chapter_bytes,
        },
        "capabilities": {
            **{name: bool(capabilities.get(name)) for name in (
                "schedule_graph_v2", "source_stream_v2", "question_reader_v2",
            )},
            **summary_revisions,
        },
        "summary": {
            "state": summary_task.get("state"),
            "started_at_epoch_ms": summary_started_at_epoch_ms,
            "completed_at_epoch_ms": summary_completed_at_epoch_ms,
            "end_to_end_elapsed_ms": summary_end_to_end_elapsed_ms,
            "elapsed_ms": summary_elapsed_ms,
            "final_attempt_number": task_attempt_number(summary_task),
            "group_terminal_states": sorted({str(group.get("state")) for group in summary_groups}),
            "artifact_contract_revision": artifact.get("contract_revision"),
            "artifact_provider_revision": artifact.get("provider_revision"),
            "artifact_prompt_revision": output.get("prompt_revision"),
            "artifact_model_revision": output.get("model_revision"),
            "facts_schema_version": facts_document.get("schema_version"),
            "through_chapter_ordinal": output.get("through_chapter_ordinal"),
            "coverage": output.get("coverage"),
            "facts_count": len(facts_document.get("facts") or []),
            "action_candidate_count": len(facts_document.get("action_candidates") or []),
            "citation_count": fact_checked,
            "citation_exact_match_count": fact_matched,
            "overview_sha256": digest_bytes(str(overview.get("text") or "").encode("utf-8")),
        },
        "question": None if q2_result is None or replay_result is None else {
            "contract_revision": q2_result.get("contract_revision"),
            "provider_revision": q2_result.get("provider_revision"),
            "model_revision": q2_result.get("model_revision"),
            "question_sha256": digest_bytes(args.question.encode("utf-8")),
            "started_at_epoch_ms": q2_started_at_epoch_ms,
            "completed_at_epoch_ms": q2_completed_at_epoch_ms,
            "elapsed_ms": q2_elapsed_ms,
            "replay_elapsed_ms": replay_elapsed_ms,
            "replay_identical": digest_json(q2_result) == digest_json(replay_result),
            "answer_kind": q2_result.get("answer_kind"),
            "answer_sha256": digest_bytes(str(q2_result.get("answer") or "").encode("utf-8")),
            "clause_count": len(q2_result.get("clauses") or []),
            "citation_count": q2_checked,
            "citation_exact_match_count": q2_matched,
            "group_terminal_states": sorted({str(group.get("state")) for group in question_groups}),
        },
        "cleanup": {
            "state": purge_result.get("state"),
            "error_code": purge_result.get("error_code"),
        },
        "total_elapsed_ms": round((time.perf_counter() - started) * 1000),
    }
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    if args.show_content:
        print(json.dumps({
            "overview": overview.get("text"),
            "answer": q2_result.get("answer") if q2_result else None,
            "clauses": q2_result.get("clauses") if q2_result else None,
        }, ensure_ascii=False, indent=2))
    print(json.dumps(report, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
