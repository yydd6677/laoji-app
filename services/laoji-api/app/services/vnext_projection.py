"""ProjectionEnvelope construction and stale-action fencing.

The envelope is a transport contract, not a UI state store.  Keeping this
logic here makes native and JS projections agree on when a snapshot is stale
without letting a late network response mutate a newer surface instance.
"""

from __future__ import annotations

import hashlib
import json
from typing import Any, Mapping

from app.schemas.vnext_contracts import ProjectionEnvelope


def _canonical(value: Any) -> bytes:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")


def payload_sha256(payload: Mapping[str, Any]) -> str:
    return "sha256:" + hashlib.sha256(_canonical(payload)).hexdigest()


def build_projection_envelope(
    *,
    device_epoch: str,
    entity_id: str,
    entity_revision: int,
    view_revision: int,
    surface_instance_id: str,
    payload: Mapping[str, Any],
) -> ProjectionEnvelope:
    """Build a validated immutable projection snapshot."""
    body = dict(payload)
    return ProjectionEnvelope(
        device_epoch=device_epoch,
        entity_id=entity_id,
        entity_revision=entity_revision,
        view_revision=view_revision,
        surface_instance_id=surface_instance_id,
        payload_sha256=payload_sha256(body),
        payload=body,
    )


def is_newer_projection(
    current: ProjectionEnvelope | None,
    incoming: ProjectionEnvelope,
) -> bool:
    """Return whether ``incoming`` may replace ``current`` on one surface.

    A different device epoch, entity or surface instance is never comparable.
    Equal revisions are idempotent only when their payload hash agrees; a
    conflicting equal revision is rejected instead of last-write-wins.
    """
    if current is None:
        return True
    if (
        current.device_epoch != incoming.device_epoch
        or current.entity_id != incoming.entity_id
        or current.surface_instance_id != incoming.surface_instance_id
    ):
        return False
    current_key = (current.entity_revision, current.view_revision)
    incoming_key = (incoming.entity_revision, incoming.view_revision)
    if incoming_key < current_key:
        return False
    if incoming_key == current_key:
        return incoming.payload_sha256 == current.payload_sha256
    return True


def action_matches_projection(
    envelope: ProjectionEnvelope,
    *,
    device_epoch: str,
    entity_id: str,
    entity_revision: int,
    view_revision: int,
    surface_instance_id: str,
) -> bool:
    """Fence a delayed button/gesture action against the visible snapshot."""
    return (
        envelope.device_epoch == device_epoch
        and envelope.entity_id == entity_id
        and envelope.entity_revision == entity_revision
        and envelope.view_revision == view_revision
        and envelope.surface_instance_id == surface_instance_id
    )

