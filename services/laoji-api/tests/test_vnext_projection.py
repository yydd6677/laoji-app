from app.services.vnext_projection import (
    action_matches_projection,
    build_projection_envelope,
    is_newer_projection,
    payload_sha256,
)


def _envelope(*, entity_revision=1, view_revision=1, payload=None, surface="calendar-1"):
    return build_projection_envelope(
        device_epoch="epoch-12345678",
        entity_id="event-42",
        entity_revision=entity_revision,
        view_revision=view_revision,
        surface_instance_id=surface,
        payload=payload or {"title": "开会", "date": "2026-08-19"},
    )


def test_payload_hash_is_canonical_and_prefixed():
    assert payload_sha256({"b": 2, "a": 1}) == payload_sha256({"a": 1, "b": 2})
    assert payload_sha256({"a": 1}).startswith("sha256:")


def test_newer_view_wins_but_late_response_is_rejected():
    current = _envelope(view_revision=3)
    assert is_newer_projection(current, _envelope(view_revision=4)) is True
    assert is_newer_projection(current, _envelope(view_revision=2)) is False


def test_equal_revision_only_allows_same_payload():
    current = _envelope()
    assert is_newer_projection(current, _envelope()) is True
    assert is_newer_projection(current, _envelope(payload={"title": "改过"})) is False


def test_epoch_entity_or_surface_mismatch_is_stale():
    current = _envelope()
    assert is_newer_projection(current, _envelope(surface="other-surface")) is False
    changed = build_projection_envelope(
        device_epoch="new-epoch-123456",
        entity_id="event-42",
        entity_revision=9,
        view_revision=9,
        surface_instance_id="calendar-1",
        payload={"title": "开会"},
    )
    assert is_newer_projection(current, changed) is False


def test_action_must_match_visible_snapshot_exactly():
    envelope = _envelope(entity_revision=4, view_revision=7)
    kwargs = {
        "device_epoch": "epoch-12345678",
        "entity_id": "event-42",
        "entity_revision": 4,
        "view_revision": 7,
        "surface_instance_id": "calendar-1",
    }
    assert action_matches_projection(envelope, **kwargs) is True
    assert action_matches_projection(envelope, **{**kwargs, "view_revision": 6}) is False
    assert action_matches_projection(envelope, **{**kwargs, "surface_instance_id": "calendar-2"}) is False
