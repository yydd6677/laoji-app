from __future__ import annotations

import sqlite3

import pytest

from app.schemas.vnext_contracts import SourceBundleItemV2
from app.services import question_inline_sources as inline, vnext_question_reader as reader
from app.services import vnext_source_stream_store as store, vnext_task_store as tasks
from test_vnext_source_stream_store import _setup, _hash_text


def _payload(generation, count=17):
    sources = [{"source_type": "transcript", "source_id": f"segment-{i}",
        "source_revision_id": "current-revision", "text": f" 第{i}项工作\n核对完成。 ",
        "content_sha256": _hash_text(f" 第{i}项工作\n核对完成。 ")} for i in range(count)]
    return {"task_id": "q2-task:" + "a" * 64, "source_stream_id": "q2-source-stream:" + "a" * 64,
        "source_entity_id": "local-meeting", "source_fingerprint": reader._source_fingerprint(sources),
        "binding_generation": generation, "binding_revision": 2, "cancel_revision": 0, "sources": sources}


def test_batch_submission_keeps_encrypted_source_owner_and_is_idempotent(tmp_path, monkeypatch):
    database, context, generation = _setup(tmp_path, monkeypatch)
    payload = _payload(generation)
    inline.prepare(context, "binding-source-1", payload)
    first = store.load_question_source_stream(context, payload["source_stream_id"])
    inline.prepare(context, "binding-source-1", payload)
    assert store.load_question_source_stream(context, payload["source_stream_id"]) == first
    assert [s["text"] for s in first["sources"]] == [s["text"] for s in payload["sources"]]
    with sqlite3.connect(database) as db:
        assert db.execute("SELECT count(*) FROM vnext_tasks").fetchone()[0] == 1
        assert db.execute("SELECT count(*) FROM vnext_source_bundles").fetchone()[0] <= 8
    assert "核对完成".encode() not in database.read_bytes()
    attempt = tasks.claim_attempt(context, payload["task_id"], lease_owner="inline-test")
    store.commit_question_result(context, payload["task_id"], attempt_id=attempt["attempt_id"],
        lease_owner="inline-test", source_stream_id=payload["source_stream_id"],
        source_fingerprint=payload["source_fingerprint"], result={"answer": "完成"})
    assert store.get_source_stream(context, payload["source_stream_id"]) is None


@pytest.mark.parametrize("checkpoint", ["manifest", "bundle", "commit"])
def test_interruption_replays_same_checkpoints_without_second_task(tmp_path, monkeypatch, checkpoint):
    _database, context, generation = _setup(tmp_path, monkeypatch)
    payload = _payload(generation)
    name = {"manifest": "append_manifest_page", "bundle": "append_bundle", "commit": "commit_bundle_group"}[checkpoint]
    original = getattr(store, name)
    calls = 0
    def interrupted(*args, **kwargs):
        nonlocal calls
        result = original(*args, **kwargs)
        calls += 1
        if calls == (2 if checkpoint == "bundle" else 1):
            raise RuntimeError("process interrupted after persistence")
        return result
    monkeypatch.setattr(store, name, interrupted)
    with pytest.raises(RuntimeError):
        inline.prepare(context, "binding-source-1", payload)
    monkeypatch.setattr(store, name, original)
    inline.prepare(context, "binding-source-1", payload)
    assert len(store.load_question_source_stream(context, payload["source_stream_id"])["sources"]) == 17


@pytest.mark.parametrize("damage", ["hash", "fingerprint", "stream", "binding", "size"])
def test_invalid_batch_is_rejected_without_accepted_sources(tmp_path, monkeypatch, damage):
    database, context, generation = _setup(tmp_path, monkeypatch)
    payload = _payload(generation)
    if damage == "hash": payload["sources"][0]["text"] += "篡改"
    if damage == "fingerprint": payload["source_fingerprint"] = _hash_text("wrong")
    if damage == "stream": payload["source_stream_id"] += "b"
    if damage == "binding": payload["binding_generation"] = "f" * 32
    if damage == "size": monkeypatch.setattr(inline, "MAX_INLINE_BYTES", 100)
    with pytest.raises((reader.Q2ReaderError, store.VNextSourceStreamError)):
        inline.prepare(context, "binding-source-1", payload)
    with sqlite3.connect(database) as db:
        assert db.execute("SELECT count(*) FROM vnext_encrypted_source_payloads").fetchone()[0] == 0


def test_multipart_wire_never_strips_source_whitespace():
    text = " \t首行\n下一行😀 \n"
    item = SourceBundleItemV2.model_validate({"item_id": "test-item-1", "source_type": "manual_note",
        "source_id": "note", "source_revision_id": "revision", "content": text,
        "content_sha256": _hash_text(text), "source_start_utf8": 0, "source_end_utf8": len(text.encode())})
    assert item.content == text
