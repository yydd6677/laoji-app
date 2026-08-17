"""Encrypted, atomic spool and event payload envelopes for realtime ASR."""

from __future__ import annotations

import hashlib
import hmac
import os
from pathlib import Path
import secrets

from cryptography.hazmat.primitives.ciphers.aead import AESGCM

from app.config import settings


MAGIC = b"LJRT\x01"
NONCE_BYTES = 12
MAX_CHUNK_BYTES = 1024 * 1024
MAX_EVENT_BYTES = 256 * 1024


def _key() -> bytes:
    return hashlib.sha256(
        b"laoji-vnext-realtime-aesgcm\0" + settings.SECRET_KEY.encode("utf-8")
    ).digest()


def _opaque_locator(
    *,
    device_id: str,
    epoch_id: str,
    session_id: str,
    chunk_seq: int,
    content_sha256: str,
) -> str:
    message = (
        f"{device_id}\0{epoch_id}\0{session_id}\0{chunk_seq}\0{content_sha256}"
    ).encode("utf-8")
    digest = hmac.new(_key(), message, hashlib.sha256).hexdigest()
    return f"chunk:{digest}"


def _path(locator: str) -> Path:
    prefix, separator, digest = locator.partition(":")
    if prefix != "chunk" or not separator or len(digest) != 64:
        raise ValueError("realtime_spool_locator_invalid")
    int(digest, 16)
    root = Path(settings.vnext_realtime_spool_abs_path).resolve()
    return root / digest[:2] / f"{digest}.bin"


def _seal(plaintext: bytes, aad: bytes, maximum: int) -> bytes:
    if not isinstance(plaintext, bytes) or not 1 <= len(plaintext) <= maximum:
        raise ValueError("realtime_payload_size_invalid")
    nonce = secrets.token_bytes(NONCE_BYTES)
    ciphertext = AESGCM(_key()).encrypt(nonce, plaintext, aad)
    return MAGIC + nonce + ciphertext


def _open(envelope: bytes, aad: bytes, maximum: int) -> bytes:
    if not envelope.startswith(MAGIC) or len(envelope) <= len(MAGIC) + NONCE_BYTES:
        raise ValueError("realtime_envelope_invalid")
    nonce_start = len(MAGIC)
    nonce = envelope[nonce_start:nonce_start + NONCE_BYTES]
    ciphertext = envelope[nonce_start + NONCE_BYTES:]
    plaintext = AESGCM(_key()).decrypt(nonce, ciphertext, aad)
    if not 1 <= len(plaintext) <= maximum:
        raise ValueError("realtime_payload_size_invalid")
    return plaintext


def seal_chunk(
    *,
    device_id: str,
    epoch_id: str,
    session_id: str,
    chunk_seq: int,
    content_sha256: str,
    pcm_bytes: bytes,
) -> str:
    locator = _opaque_locator(
        device_id=device_id,
        epoch_id=epoch_id,
        session_id=session_id,
        chunk_seq=chunk_seq,
        content_sha256=content_sha256,
    )
    path = _path(locator)
    aad = locator.encode("ascii")
    if path.is_file():
        if _open(path.read_bytes(), aad, MAX_CHUNK_BYTES) != pcm_bytes:
            raise ValueError("realtime_spool_replay_conflict")
        return locator
    path.parent.mkdir(parents=True, exist_ok=True)
    envelope = _seal(pcm_bytes, aad, MAX_CHUNK_BYTES)
    temporary = path.with_name(f".{path.name}.{os.getpid()}.{secrets.token_hex(4)}.tmp")
    try:
        with temporary.open("xb") as output:
            output.write(envelope)
            output.flush()
            os.fsync(output.fileno())
        os.replace(temporary, path)
    finally:
        temporary.unlink(missing_ok=True)
    return locator


def read_chunk(locator: str) -> bytes:
    path = _path(locator)
    return _open(path.read_bytes(), locator.encode("ascii"), MAX_CHUNK_BYTES)


def delete_chunk(locator: str) -> None:
    path = _path(locator)
    path.unlink(missing_ok=True)
    try:
        path.parent.rmdir()
    except OSError:
        pass


def seal_event(event_identity: str, payload: bytes) -> bytes:
    normalized = str(event_identity or "").strip()
    if not normalized or len(normalized) > 512:
        raise ValueError("realtime_event_identity_invalid")
    return _seal(payload, normalized.encode("utf-8"), MAX_EVENT_BYTES)


def open_event(event_identity: str, envelope: bytes) -> bytes:
    normalized = str(event_identity or "").strip()
    return _open(envelope, normalized.encode("utf-8"), MAX_EVENT_BYTES)
