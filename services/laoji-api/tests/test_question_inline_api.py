import hashlib
import base64
import gzip
import json
import uuid

import pytest

from app.api import device_v2
from app.config import settings
from app.services import vnext_source_stream_store as store, vnext_question_reader as reader
from test_device_v2_api import _client


@pytest.mark.parametrize('compressed', [False, True])
def test_inline_api_replays_result_without_recreating_private_source(tmp_path, monkeypatch, compressed):
    client, context = _client(tmp_path, monkeypatch)
    monkeypatch.setattr(settings, "SECRET_KEY", "inline-question-route-test-key")
    # Only the isolated fixture bypasses a historical rollout gate, never auth.
    if hasattr(device_v2, "_require_question_reader_v2"):
        monkeypatch.setattr(device_v2, "_require_question_reader_v2", lambda: None)
    binding, generation = str(uuid.uuid4()), uuid.uuid4().hex
    assert client.put(f"/api/device/v2/meetings/{binding}", json={"schema_version": 2,
        "binding_generation": generation, "binding_epoch_seq": 1, "binding_revision": 1,
        "cancel_revision": 0, "purge_capability": {"capability_id": str(uuid.uuid4()),
        "secret_sha256": hashlib.sha256(b"test secret").hexdigest(), "registration_request_id": "inline-binding"}}).status_code == 200
    text = " 张敏周五提交。\n"
    sources = [{"source_type": "transcript", "source_id": "segment", "source_revision_id": "revision",
                "content_sha256": reader._sha256_text(text), "text": text}]
    payload = {"schema_version": 2, "contract_revision": "question.reader.v2", "provider_revision": "q2-reader-v2",
        "snapshot_id": "snapshot", "source_fingerprint": reader._source_fingerprint(sources), "question": "谁提交？",
        "binding_generation": generation, "binding_revision": 1, "cancel_revision": 0,
        "task_id": "q2-task:" + "d" * 64, "source_stream_id": "q2-source-stream:" + "d" * 64,
        "prepare_sources": True, "source_entity_id": "local-meeting", "sources": sources}
    if compressed:
        raw = json.dumps(payload.pop('sources'), ensure_ascii=False, separators=(',', ':')).encode()
        payload['compressed_sources'] = {'encoding': 'gzip-base64', 'uncompressed_bytes': len(raw),
            'data': base64.b64encode(gzip.compress(raw, mtime=0)).decode()}
    calls = []
    def fake_reader(value):
        calls.append(value)
        assert value["sources"][0]["text"] == text
        return {"schema_version": 2, "answer_kind": "not_stated", "answer": "未说明。", "clauses": []}
    monkeypatch.setattr(reader, "read_q2", fake_reader)
    url = f"/api/device/v2/meetings/{binding}/questions-v2"
    first = client.post(url, json=payload)
    assert first.status_code == 200, first.text
    assert len(calls) == 1
    assert store.get_source_stream(context, payload["source_stream_id"]) is None
    same_wire = client.post(url, json=payload)
    assert same_wire.status_code == 200 and same_wire.json() == first.json()
    assert len(calls) == 1 and store.get_source_stream(context, payload["source_stream_id"]) is None
    again = client.post(url, json={**payload, "sources": [], "compressed_sources": None})
    assert again.status_code == 200, again.text
    assert again.json() == first.json() and len(calls) == 1
    assert store.get_source_stream(context, payload["source_stream_id"]) is None
    assert client.post(url, json={**payload, "binding_revision": 2}).status_code == 409
    assert client.post(url, json={**payload, "source_entity_id": "another"}).status_code == 409
    assert client.post(url, json={**payload, "task_id": " " * 8}).status_code == 422


@pytest.mark.parametrize('damage', ['mixed', 'unprepared', 'no_stream', 'extra_field', 'row_type', 'hash'])
def test_compressed_source_validation_cannot_bypass_typed_or_hash_owner(damage):
    from app.api.device_v2 import Q2ReaderRequest
    from pydantic import ValidationError
    text = ' \n本周跟进。😀 '
    row = {'source_type': 'transcript', 'source_id': 's1', 'source_revision_id': 'r1',
           'content_sha256': 'sha256:' + hashlib.sha256(text.encode()).hexdigest(), 'text': text}
    if damage == 'extra_field': row['unknown'] = 'bad'
    raw = json.dumps([1 if damage == 'row_type' else row], ensure_ascii=False).encode()
    payload = {'schema_version': 2, 'contract_revision': 'question.reader.v2', 'provider_revision': 'q2-reader-v2',
        'snapshot_id': 's', 'source_fingerprint': 'sha256:' + 'a' * 64, 'question': '后续安排是什么？',
        'binding_generation': 'a' * 32, 'binding_revision': 1, 'cancel_revision': 0,
        'prepare_sources': True, 'source_stream_id': 'stream-test',
        'compressed_sources': {'encoding': 'gzip-base64', 'uncompressed_bytes': len(raw),
                              'data': base64.b64encode(gzip.compress(raw)).decode()}}
    if damage == 'mixed': payload['sources'] = [row]
    if damage == 'unprepared': payload['prepare_sources'] = False
    if damage == 'no_stream': payload['source_stream_id'] = None
    if damage == 'hash':
        model = Q2ReaderRequest.model_validate(payload)
        model.sources[0].text += '篡改'
        with pytest.raises(reader.Q2ReaderError, match='校验失败'):
            reader._source_payload(model.model_dump()['sources'])
    else:
        with pytest.raises(ValidationError):
            Q2ReaderRequest.model_validate(payload)
