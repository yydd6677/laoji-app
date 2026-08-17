import pytest

from app.services import schedule_db_service as db


@pytest.fixture(autouse=True)
def isolated_db(tmp_path):
    db.set_db_path(str(tmp_path / "schedule.db"))
    yield
    db.close_db()


def create(user_id=1, **overrides):
    values = {
        "title": "重复日程",
        "start_date": "2026-07-05",
        "event_type": "weekly",
        "start_time": "10:00",
        "end_time": "11:00",
        "user_id": user_id,
    }
    values.update(overrides)
    return db.create_event(**values)


def command(event_id, request_id, desired_state, **overrides):
    values = {
        "event_id": event_id,
        "user_id": 1,
        "client_request_id": request_id,
        "desired_state": desired_state,
        "scope": "series",
    }
    values.update(overrides)
    return db.command_event_state(**values)


def test_series_delete_and_restore_keep_the_same_source_id_and_replay_response():
    event = create()
    deleted = command(event["id"], "event-command-delete-1", "absent")

    assert deleted["observed_state"] == "absent"
    assert deleted["changed"] is True
    assert db.get_event(event["id"], user_id=1) is None
    assert db.get_event(event["id"], user_id=1, include_deleted=True)["id"] == event["id"]
    assert db.list_events(year=2026, month=7, user_id=1) == []

    replay = command(event["id"], "event-command-delete-1", "absent")
    assert replay == deleted

    restored = command(
        event["id"],
        "event-command-restore-1",
        "present",
        expected_revision=deleted["revision"],
    )
    assert restored["event"]["id"] == event["id"]
    assert restored["event"]["source_event_id"] == event["id"]
    assert db.get_event(event["id"], user_id=1)["id"] == event["id"]


def test_same_command_key_rejects_a_changed_payload():
    event = create()
    command(event["id"], "event-command-conflict-1", "absent")
    with pytest.raises(db.ScheduleCommandConflict, match="不能用于不同操作"):
        command(event["id"], "event-command-conflict-1", "present")


def test_occurrence_delete_and_restore_do_not_affect_other_instances():
    event = create()
    deleted = command(
        event["id"],
        "event-command-occurrence-delete-1",
        "absent",
        scope="occurrence",
        occurrence_date="2026-07-12",
    )
    july_dates = [item["occurrence_date"] for item in db.list_events(year=2026, month=7, user_id=1)]
    assert "2026-07-12" not in july_dates
    assert "2026-07-05" in july_dates
    assert "2026-07-19" in july_dates

    command(
        event["id"],
        "event-command-occurrence-restore-1",
        "present",
        scope="occurrence",
        occurrence_date="2026-07-12",
        expected_revision=deleted["revision"],
    )
    assert "2026-07-12" in [
        item["occurrence_date"] for item in db.list_events(year=2026, month=7, user_id=1)
    ]


def test_following_delete_and_restore_use_an_exclusive_anchor_cutoff():
    event = create()
    deleted = command(
        event["id"],
        "event-command-following-delete-1",
        "absent",
        scope="following",
        occurrence_date="2026-07-19",
    )
    assert [item["occurrence_date"] for item in db.list_events(year=2026, month=7, user_id=1)] == [
        "2026-07-05",
        "2026-07-12",
    ]

    command(
        event["id"],
        "event-command-following-restore-1",
        "present",
        scope="following",
        occurrence_date="2026-07-19",
        expected_revision=deleted["revision"],
    )
    assert "2026-07-26" in [
        item["occurrence_date"] for item in db.list_events(year=2026, month=7, user_id=1)
    ]


def test_invalid_occurrence_and_stale_revision_are_rejected_without_mutation():
    event = create()
    with pytest.raises(ValueError, match="不是该重复日程"):
        command(
            event["id"],
            "event-command-invalid-date-1",
            "absent",
            scope="occurrence",
            occurrence_date="2026-07-13",
        )
    with pytest.raises(db.ScheduleCommandConflict, match="版本已变化"):
        command(
            event["id"],
            "event-command-stale-revision-1",
            "absent",
            expected_revision=99,
        )
    assert db.get_event(event["id"], user_id=1) is not None


def test_commands_are_user_isolated():
    event = create(user_id=2)
    assert command(event["id"], "event-command-wrong-user-1", "absent") is None
    assert db.get_event(event["id"], user_id=2) is not None


def test_legacy_delete_uses_a_tombstone_instead_of_destroying_identity():
    event = create()
    assert db.delete_event(event["id"], user_id=1) is True
    assert db.get_event(event["id"], user_id=1) is None
    assert db.get_event(event["id"], user_id=1, include_deleted=True)["id"] == event["id"]
