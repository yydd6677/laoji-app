from __future__ import annotations

import base64
import sqlite3
import uuid

import pytest
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec

from app.config import settings
from app.services import device_identity, device_v2_identity


def _b64(value: bytes) -> str:
    return base64.urlsafe_b64encode(value).decode("ascii").rstrip("=")


def _setup(tmp_path, monkeypatch):
    database = tmp_path / "device-v2.db"
    monkeypatch.setattr(settings, "DATABASE_URL", f"sqlite+aiosqlite:///{database}")
    device_identity._SCHEMA_READY.clear()  # type: ignore[attr-defined]
    with sqlite3.connect(database) as connection:
        connection.execute(
            "CREATE TABLE meetings (id TEXT PRIMARY KEY, user_id INTEGER, updated_at TEXT, data_epoch_id TEXT)"
        )
    device_v2_identity.ensure_v2_schema()


def _public_key_and_private():
    private = ec.generate_private_key(ec.SECP256R1())
    public = private.public_key().public_bytes(
        serialization.Encoding.DER,
        serialization.PublicFormat.SubjectPublicKeyInfo,
    )
    return private, public


def _proof(nonce: bytes, difficulty: int) -> int:
    for value in range(2**32):
        if device_v2_identity._pow_valid(nonce, value, difficulty):
            return value
    raise AssertionError("proof search exceeded test bound")


def test_p256_bootstrap_auth_and_bearer_fence(tmp_path, monkeypatch) -> None:
    _setup(tmp_path, monkeypatch)
    private, public = _public_key_and_private()
    device_id = str(uuid.uuid4())
    epoch_id = str(uuid.uuid4())
    request_id = "register-request-1"
    public_wire = _b64(public)
    challenge = device_v2_identity.create_bootstrap_challenge(
        device_id=device_id,
        epoch_id=epoch_id,
        public_key_der=public_wire,
        request_id=request_id,
    )
    nonce = base64.urlsafe_b64decode(challenge["nonce"] + "==")
    proof = _proof(nonce, challenge["proof_difficulty_bits"])
    signature = private.sign(
        device_v2_identity._message(
            "bootstrap", nonce, device_id, epoch_id, request_id, proof,
        ),
        ec.ECDSA(hashes.SHA256()),
    )
    registered = device_v2_identity.complete_bootstrap(
        challenge_id=challenge["challenge_id"],
        nonce=challenge["nonce"],
        device_id=device_id,
        epoch_id=epoch_id,
        public_key_der=public_wire,
        signature=_b64(signature),
        proof_nonce=proof,
        request_id=request_id,
    )
    assert registered["registered"] is True

    public_hash = challenge["public_key_hash"]
    auth_request_id = "auth-request-1"
    auth_challenge = device_v2_identity.create_auth_challenge(
        device_id=device_id,
        epoch_id=epoch_id,
        key_version=1,
        public_key_hash=public_hash,
        request_id=auth_request_id,
    )
    auth_nonce = base64.urlsafe_b64decode(auth_challenge["nonce"] + "==")
    auth_signature = private.sign(
        device_v2_identity._message("auth", auth_nonce, device_id, epoch_id, auth_request_id),
        ec.ECDSA(hashes.SHA256()),
    )
    token = device_v2_identity.exchange_auth_token(
        challenge_id=auth_challenge["challenge_id"],
        nonce=auth_challenge["nonce"],
        signature=_b64(auth_signature),
        request_id=auth_request_id,
    )
    context = device_v2_identity.authenticate_bearer(device_id, epoch_id, token["access_token"])
    assert context.device_id == device_id
    assert context.epoch_id == epoch_id

    with pytest.raises(device_v2_identity.DeviceV2IdentityError) as replay:
        device_v2_identity.exchange_auth_token(
            challenge_id=auth_challenge["challenge_id"],
            nonce=auth_challenge["nonce"],
            signature=_b64(auth_signature),
            request_id=auth_request_id,
        )
    assert replay.value.code == "CHALLENGE_EXPIRED"
