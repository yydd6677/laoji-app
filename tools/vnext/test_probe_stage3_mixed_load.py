import json
from pathlib import Path

from probe_stage3_mixed_load import (
    commit_reserved_sequences,
    distribution,
    interval_overlap_ms,
    reserve_lane_auth_states,
    safe_failure_details,
)


def test_interval_overlap_requires_real_time_intersection() -> None:
    assert interval_overlap_ms(100, 300, 200, 400) == 100
    assert interval_overlap_ms(100, 200, 200, 300) == 0
    assert interval_overlap_ms(None, 200, 100, 300) == 0


def test_distribution_uses_interpolated_p95() -> None:
    result = distribution([1000, 2000, 3000, 4000])
    assert result == {
        "count": 4,
        "p50_ms": 2500.0,
        "p95_ms": 3850.0,
        "max_ms": 4000,
    }


def test_lane_auth_states_reserve_and_commit_consecutive_sequences(tmp_path: Path) -> None:
    api = "http://127.0.0.1:28023/api/device/v2"
    base = tmp_path / "base.json"
    base.write_text(json.dumps({
        "api": api,
        "next_binding_epoch_seq": 41,
        "private_key_pem": "not-a-real-key",
    }), encoding="utf-8")
    lanes = {"a": tmp_path / "a.json", "b": tmp_path / "b.json"}

    reserve_lane_auth_states(base, lanes, api)

    assert json.loads(lanes["a"].read_text())["next_binding_epoch_seq"] == 41
    assert json.loads(lanes["b"].read_text())["next_binding_epoch_seq"] == 42
    lane_b = json.loads(lanes["b"].read_text())
    lane_b["next_binding_epoch_seq"] = 43
    lanes["b"].write_text(json.dumps(lane_b), encoding="utf-8")
    commit_reserved_sequences(base, lanes)
    assert json.loads(base.read_text())["next_binding_epoch_seq"] == 43


def test_lane_reservation_recovers_sequence_from_interrupted_lane(tmp_path: Path) -> None:
    api = "http://127.0.0.1:28023/api/device/v2"
    base = tmp_path / "base.json"
    base.write_text(json.dumps({
        "api": api,
        "next_binding_epoch_seq": 41,
        "private_key_pem": "not-a-real-key",
    }), encoding="utf-8")
    lanes = {"a": tmp_path / "a.json", "b": tmp_path / "b.json"}
    lanes["b"].write_text(json.dumps({
        "api": api,
        "next_binding_epoch_seq": 44,
        "private_key_pem": "not-a-real-key",
    }), encoding="utf-8")

    reserve_lane_auth_states(base, lanes, api)

    assert json.loads(lanes["a"].read_text())["next_binding_epoch_seq"] == 44
    assert json.loads(lanes["b"].read_text())["next_binding_epoch_seq"] == 45


def test_safe_failure_details_excludes_response_content() -> None:
    details = safe_failure_details(
        'RuntimeError: create summary source stream failed: HTTP 429 '
        '{"detail":{"code":"SOURCE_STREAM_CAPACITY","message":"private text"}}\n'
    )
    assert details == {
        "http_statuses": [429],
        "reason_codes": ["SOURCE_STREAM_CAPACITY"],
        "exception_types": ["RuntimeError"],
    }
    assert "private" not in json.dumps(details)
