import pytest

from app.services import schedule_db_service as db


@pytest.fixture(autouse=True)
def isolated_db(tmp_path):
    db.set_db_path(str(tmp_path / "schedule.db"))
    yield
    db.close_db()


def create(**overrides):
    values = {
        "title": "重复日程",
        "start_date": "2026-07-09",
        "event_type": "once",
        "start_time": "10:00",
        "end_time": "11:00",
        "user_id": 1,
    }
    values.update(overrides)
    return db.create_event(**values)


def test_monthly_occurrence_uses_day_of_month_and_unique_id():
    event = create(event_type="monthly")
    july = db.list_events(year=2026, month=7, user_id=1)
    august = db.list_events(year=2026, month=8, user_id=1)

    assert [item["start_date"] for item in july] == ["2026-07-09"]
    assert [item["start_date"] for item in august] == ["2026-08-09"]
    assert august[0]["source_event_id"] == event["id"]
    assert august[0]["occurrence_date"] == "2026-08-09"
    assert august[0]["occurrence_id"] == f"{event['id']}@2026-08-09"
    assert august[0]["series_start_date"] == "2026-07-09"


def test_legacy_month_day_monthly_anchor_still_expands():
    event = create(event_type="monthly", start_date="07-09")
    august = db.list_events(year=2026, month=8, user_id=1)

    assert [item["start_date"] for item in august] == ["2026-08-09"]
    assert august[0]["source_event_id"] == event["id"]
    assert august[0]["occurrence_date"] == "2026-08-09"


def test_daily_series_does_not_expand_before_its_start():
    event = create(event_type="daily", start_date="2026-07-29")
    july = db.list_events(year=2026, month=7, user_id=1)

    assert [item["start_date"] for item in july] == ["2026-07-29", "2026-07-30", "2026-07-31"]
    assert len({item["occurrence_id"] for item in july}) == 3
    assert all(item["source_event_id"] == event["id"] for item in july)


def test_cross_date_duration_moves_with_each_recurring_occurrence():
    create(
        event_type="weekly",
        start_date="2026-07-09",
        end_date="2026-07-11",
        start_time="18:00",
        end_time="09:00",
    )
    july = db.list_events(year=2026, month=7, user_id=1)

    assert july[0]["start_date"] == "2026-07-09"
    assert july[0]["end_date"] == "2026-07-11"
    assert july[1]["start_date"] == "2026-07-16"
    assert july[1]["end_date"] == "2026-07-18"
    assert all(item["spanning"] for item in july)

    august = db.list_events(year=2026, month=8, user_id=1)
    assert august[0]["start_date"] == "2026-07-30"
    assert august[0]["end_date"] == "2026-08-01"


def test_one_off_cross_month_event_keeps_stable_identity():
    event = create(start_date="2026-07-31", end_date="2026-08-02")
    august = db.list_events(year=2026, month=8, user_id=1)

    assert len(august) == 1
    assert august[0]["occurrence_id"] == str(event["id"])
    assert august[0]["source_event_id"] == event["id"]
    assert august[0]["is_expanded"] is False


def test_partial_update_can_explicitly_clear_optional_fields():
    event = create(end_date="2026-07-10", location="会议室", reminder_minutes=15)
    updated = db.update_event_fields(
        event["id"],
        {"end_date": None, "location": None, "reminder_minutes": None},
        user_id=1,
    )

    assert updated is not None
    assert updated["end_date"] is None
    assert updated["location"] is None
    assert updated["reminder_minutes"] is None


def test_create_event_reuses_same_client_request_and_rejects_payload_change():
    request_id = "event:test:1:abcdefghij"
    first = create(client_request_id=request_id)
    retry = create(client_request_id=request_id)

    assert retry["id"] == first["id"]
    assert retry["client_request_id"] == request_id
    assert db._get_conn().execute(
        "SELECT COUNT(*) FROM schedule_events WHERE user_id = ? AND client_request_id = ?",
        (1, request_id),
    ).fetchone()[0] == 1

    with pytest.raises(db.ScheduleIdempotencyConflict, match="不同日程内容"):
        create(client_request_id=request_id, title="同键但不同标题")


def test_recurrence_weekdays_use_nonempty_iso_1_through_7_values():
    with pytest.raises(ValueError, match="ISO 1..7"):
        create(event_type="weekly", recurrence_weekdays=[0, 1])
    with pytest.raises(ValueError, match="ISO 1..7"):
        create(event_type="weekly", recurrence_weekdays=[7, 8])
    with pytest.raises(ValueError, match="不能为空列表"):
        create(event_type="weekly", recurrence_weekdays=[])
