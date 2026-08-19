from __future__ import annotations

import base64
import hashlib
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


def test_device_schema_can_boot_before_domain_tables(tmp_path, monkeypatch) -> None:
    database = tmp_path / "control-only.db"
    monkeypatch.setattr(settings, "DATABASE_URL", f"sqlite+aiosqlite:///{database}")
    device_identity._SCHEMA_READY.clear()  # type: ignore[attr-defined]

    # Capability barriers and device bootstrap can be probed before the ORM
    # domain tables exist. The control schema must remain independently usable.
    device_identity.ensure_device_schema()
    with device_identity.control_connection() as connection:
        assert connection.execute(
            "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'device_epochs'"
        ).fetchone() is not None
        assert connection.execute(
            "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'meetings'"
        ).fetchone() is None


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
    assert device_v2_identity.create_bootstrap_challenge(
        device_id=device_id,
        epoch_id=epoch_id,
        public_key_der=public_wire,
        request_id=request_id,
    ) == challenge
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
        purge_capability_id=str(uuid.uuid4()),
        purge_secret_sha256=hashlib.sha256(b"epoch-purge-secret").hexdigest(),
        purge_registration_request_id="epoch-purge-register-1",
    )
    assert registered["registered"] is True
    replayed = device_v2_identity.complete_bootstrap(
        challenge_id=challenge["challenge_id"],
        nonce=challenge["nonce"],
        device_id=device_id,
        epoch_id=epoch_id,
        public_key_der=public_wire,
        signature=_b64(signature),
        proof_nonce=proof,
        request_id=request_id,
        purge_capability_id=registered["purge_capability"]["capability_id"],
        purge_secret_sha256=hashlib.sha256(b"epoch-purge-secret").hexdigest(),
        purge_registration_request_id="epoch-purge-register-1",
    )
    assert replayed == registered

    public_hash = challenge["public_key_hash"]
    auth_request_id = "auth-request-1"
    auth_challenge = device_v2_identity.create_auth_challenge(
        device_id=device_id,
        epoch_id=epoch_id,
        key_version=1,
        public_key_hash=public_hash,
        request_id=auth_request_id,
    )
    assert device_v2_identity.create_auth_challenge(
        device_id=device_id,
        epoch_id=epoch_id,
        key_version=1,
        public_key_hash=public_hash,
        request_id=auth_request_id,
    ) == auth_challenge
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
    with device_identity.control_connection() as connection:
        connection.execute("UPDATE v2_tokens SET revoked_at = 1")
        connection.commit()
    with pytest.raises(device_v2_identity.DeviceV2IdentityError) as explicitly_revoked:
        device_v2_identity.authenticate_bearer(device_id, epoch_id, token["access_token"])
    assert explicitly_revoked.value.code == "BEARER_INVALID"
    with device_identity.control_connection() as connection:
        connection.execute("UPDATE v2_tokens SET revoked_at = NULL")
        connection.commit()

    new_private, new_public = _public_key_and_private()
    new_public_wire = _b64(new_public)
    new_hash = hashlib.sha256(new_public).hexdigest()
    rotate_message = device_v2_identity._message(
        "rotate",
        hashlib.sha256(f"{device_id}\n{epoch_id}\nrotate-request-1\n{new_hash}".encode()).digest(),
        device_id,
        epoch_id,
        "rotate-request-1",
        context.key_version,
    )
    rotated = device_v2_identity.rotate_key(
        context=context,
        request_id="rotate-request-1",
        new_public_key_der=new_public_wire,
        old_signature=_b64(private.sign(rotate_message, ec.ECDSA(hashes.SHA256()))),
        new_signature=_b64(new_private.sign(rotate_message, ec.ECDSA(hashes.SHA256()))),
    )
    assert rotated["key_version"] == 2
    with pytest.raises(device_v2_identity.DeviceV2IdentityError) as revoked:
        device_v2_identity.authenticate_bearer(device_id, epoch_id, token["access_token"])
    assert revoked.value.code == "BEARER_INVALID"

    with pytest.raises(device_v2_identity.DeviceV2IdentityError) as replay:
        device_v2_identity.exchange_auth_token(
            challenge_id=auth_challenge["challenge_id"],
            nonce=auth_challenge["nonce"],
            signature=_b64(auth_signature),
            request_id=auth_request_id,
        )
    assert replay.value.code == "CHALLENGE_EXPIRED"


def test_active_epoch_cannot_be_silently_replaced(tmp_path, monkeypatch) -> None:
    _setup(tmp_path, monkeypatch)
    private, public = _public_key_and_private()
    public_wire = _b64(public)
    device_id = str(uuid.uuid4())

    def register(epoch_id: str, suffix: str) -> dict:
        request_id = f"register-request-{suffix}"
        challenge = device_v2_identity.create_bootstrap_challenge(
            device_id=device_id,
            epoch_id=epoch_id,
            public_key_der=public_wire,
            request_id=request_id,
        )
        nonce = base64.urlsafe_b64decode(challenge["nonce"] + "==")
        proof = _proof(nonce, challenge["proof_difficulty_bits"])
        signature = private.sign(
            device_v2_identity._message("bootstrap", nonce, device_id, epoch_id, request_id, proof),
            ec.ECDSA(hashes.SHA256()),
        )
        return device_v2_identity.complete_bootstrap(
            challenge_id=challenge["challenge_id"],
            nonce=challenge["nonce"],
            device_id=device_id,
            epoch_id=epoch_id,
            public_key_der=public_wire,
            signature=_b64(signature),
            proof_nonce=proof,
            request_id=request_id,
            purge_capability_id=str(uuid.uuid4()),
            purge_secret_sha256=hashlib.sha256(f"secret-{suffix}".encode()).hexdigest(),
            purge_registration_request_id=f"purge-register-{suffix}",
        )

    register(str(uuid.uuid4()), "first")
    with pytest.raises(device_v2_identity.DeviceV2IdentityError) as conflict:
        register(str(uuid.uuid4()), "second")
    assert conflict.value.code == "EPOCH_ROTATION_REQUIRED"
