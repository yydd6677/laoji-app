import base64
import gzip
import json

import pytest
from pydantic import ValidationError

from app.services.question_source_codec import CompressedQuestionSources, MAX_INLINE_BYTES


def encoded(raw):
    return {"encoding": "gzip-base64", "uncompressed_bytes": len(raw),
            "data": base64.b64encode(gzip.compress(raw, mtime=0)).decode()}


def test_utf8_text_whitespace_and_source_metadata_are_lossless():
    rows = [{"text": " \t记录\n😀 \n", "source_revision_id": "r1", "content_sha256": "sha256:identity",
             "source_type": source_type} for source_type in ('transcript', 'manual_note', 'attachment')]
    assert CompressedQuestionSources(**encoded(json.dumps(rows, ensure_ascii=False).encode())).decode() == rows


@pytest.mark.parametrize("damage", ["base64", "truncated", "crc", "trailing", "multi_member", "size",
    "bomb", "json", "utf8", "object", "empty", "many"])
def test_invalid_or_oversized_frames_fail_closed(damage):
    raw = b'[{}]'
    if damage == 'json': raw = b'broken'
    if damage == 'utf8': raw = b'["\xff"]'
    if damage == 'object': raw = b'{}'
    if damage == 'empty': raw = b'[]'
    if damage == 'many': raw = json.dumps([{}] * 1025).encode()
    if damage == 'bomb': raw = b' ' * (MAX_INLINE_BYTES + 1)
    value = encoded(raw)
    data = base64.b64decode(value['data'])
    if damage == 'base64': value['data'] = 'not base64!'
    if damage == 'truncated': data = data[:-1]
    if damage == 'crc': data = data[:-8] + b'\0' * 8
    if damage == 'trailing': data += b'junk'
    if damage == 'multi_member': data += gzip.compress(b'[]')
    if damage in {'truncated','crc','trailing','multi_member'}: value['data'] = base64.b64encode(data).decode()
    if damage == 'size': value['uncompressed_bytes'] += 1
    if damage == 'bomb': value['uncompressed_bytes'] = MAX_INLINE_BYTES
    with pytest.raises((ValidationError, ValueError)):
        CompressedQuestionSources(**value).decode()


@pytest.mark.parametrize('value', [True, 1.5, '4', MAX_INLINE_BYTES + 1, 0])
def test_declared_length_must_be_a_bounded_integer(value):
    with pytest.raises(ValidationError):
        CompressedQuestionSources(**{**encoded(b'[{}]'), 'uncompressed_bytes': value})
