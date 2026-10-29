"""Encrypted transient PCM and voiceprint payloads for the vNext speaker lane."""

from __future__ import annotations

import hashlib
import hmac
import os
from pathlib import Path
import secrets
import time

from cryptography.hazmat.primitives.ciphers.aead import AESGCM

from app.config import settings


MAGIC = b"LJSP\x01"
NONCE_BYTES = 12
MAX_SEGMENT_BYTES = 1024 * 1024
MAX_PAYLOAD_BYTES = 4 * 1024 * 1024


def _key() -> bytes:
    return hashlib.sha256(
        b"laoji-vnext-speaker-aesgcm\0" + settings.SECRET_KEY.encode("utf-8")
    ).digest()


def _seal(plaintext: bytes, identity: str, maximum: int) -> bytes:
    if not isinstance(plaintext, bytes) or not 1 <= len(plaintext) <= maximum:
        raise ValueError("speaker_payload_size_invalid")
    normalized = str(identity or "").strip()
    if not normalized or len(normalized) > 1024:
        raise ValueError("speaker_payload_identity_invalid")
    nonce = secrets.token_bytes(NONCE_BYTES)
    ciphertext = AESGCM(_key()).encrypt(nonce, plaintext, normalized.encode("utf-8"))
    return MAGIC + nonce + ciphertext


def _open(envelope: bytes, identity: str, maximum: int) -> bytes:
    if not isinstance(envelope, bytes) or not envelope.startswith(MAGIC):
        raise ValueError("speaker_envelope_invalid")
    if len(envelope) <= len(MAGIC) + NONCE_BYTES:
        raise ValueError("speaker_envelope_invalid")
    nonce_start = len(MAGIC)
    nonce = envelope[nonce_start:nonce_start + NONCE_BYTES]
    ciphertext = envelope[nonce_start + NONCE_BYTES:]
    plaintext = AESGCM(_key()).decrypt(
        nonce,
        ciphertext,
        str(identity or "").strip().encode("utf-8"),
    )
    if not 1 <= len(plaintext) <= maximum:
        raise ValueError("speaker_payload_size_invalid")
    return plaintext


def seal_payload(identity: str, plaintext: bytes) -> bytes:
    return _seal(plaintext, identity, MAX_PAYLOAD_BYTES)


def open_payload(identity: str, envelope: bytes) -> bytes:
    return _open(envelope, identity, MAX_PAYLOAD_BYTES)


def _segment_locator(
    *,
    device_id: str,
    epoch_id: str,
    session_id: str,
    stable_segment_key: str,
    content_sha256: str,
) -> str:
    material = (
        f"{device_id}\0{epoch_id}\0{session_id}\0{stable_segment_key}\0{content_sha256}"
    ).encode("utf-8")
    return "speaker:" + hmac.new(_key(), material, hashlib.sha256).hexdigest()


def _segment_path(locator: str) -> Path:
    prefix, separator, digest = str(locator or "").partition(":")
    if prefix != "speaker" or not separator or len(digest) != 64:
        raise ValueError("speaker_spool_locator_invalid")
    int(digest, 16)
    root = Path(settings.vnext_speaker_spool_abs_path).resolve()
    return root / digest[:2] / f"{digest}.bin"


def seal_segment(
    *,
    device_id: str,
    epoch_id: str,
    session_id: str,
    stable_segment_key: str,
    content_sha256: str,
    pcm_bytes: bytes,
) -> str:
    locator = _segment_locator(
        device_id=device_id,
        epoch_id=epoch_id,
        session_id=session_id,
        stable_segment_key=stable_segment_key,
        content_sha256=content_sha256,
    )
    path = _segment_path(locator)
    if path.is_file():
        if _open(path.read_bytes(), locator, MAX_SEGMENT_BYTES) != pcm_bytes:
            raise ValueError("speaker_spool_replay_conflict")
        return locator
    path.parent.mkdir(parents=True, exist_ok=True)
    envelope = _seal(pcm_bytes, locator, MAX_SEGMENT_BYTES)
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


def read_segment(locator: str) -> bytes:
    return _open(_segment_path(locator).read_bytes(), locator, MAX_SEGMENT_BYTES)


def delete_segment(locator: str) -> None:
    path = _segment_path(locator)
    path.unlink(missing_ok=True)
    try:
        path.parent.rmdir()
    except OSError:
        pass


def delete_orphan_segments(
    referenced_locators: set[str],
    *,
    older_than_epoch: float | None = None,
) -> dict[str, int]:
    root = Path(settings.vnext_speaker_spool_abs_path).resolve()
    if not root.is_dir():
        return {"files": 0, "bytes": 0}
    cutoff = time.time() - 3600 if older_than_epoch is None else float(older_than_epoch)
    files = 0
    byte_count = 0
    for shard in root.iterdir():
        if not shard.is_dir() or len(shard.name) != 2:
            continue
        try:
            int(shard.name, 16)
        except ValueError:
            continue
        for path in shard.iterdir():
            if not path.is_file() or path.suffix != ".bin" or len(path.stem) != 64:
                continue
            try:
                int(path.stem, 16)
                stat = path.stat()
            except (OSError, ValueError):
                continue
            locator = f"speaker:{path.stem}"
            if locator in referenced_locators or stat.st_mtime > cutoff:
                continue
            try:
                path.unlink()
            except FileNotFoundError:
                continue
            files += 1
            byte_count += int(stat.st_size)
        try:
            shard.rmdir()
        except OSError:
            pass
    return {"files": files, "bytes": byte_count}
