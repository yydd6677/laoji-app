import json
import sqlite3
from datetime import date, timedelta

import pytest

from app.services import schedule_db_service as db


@pytest.fixture(autouse=True)
def isolated_db(tmp_path):
    db.set_db_path(str(tmp_path / "schedule.db"))
    yield
    db.close_db()


def create(user_id=1, **overrides):
    values = {
        "title": "原日程",
        "start_date": "2026-07-05",
        "event_type": "weekly",
        "start_time": "10:00",
        "end_time": "11:00",
        "color": "#123456",
        "user_id": user_id,
    }
    values.update(overrides)
    return db.create_event(**values)


def edit(event_id, request_id, patch, **overrides):
    values = {
        "event_id": event_id,
        "user_id": 1,
        "client_request_id": request_id,
        "scope": "series",
        "occurrence_date": "2026-07-05",
        "patch": patch,
    }
    values.update(overrides)
    return db.command_event_edit(**values)


def by_anchor(events, anchor):
    return next(event for event in events if event["occurrence_date"] == anchor)


def expand_weekly_catalog(catalog, anchors):
    """Small client-side projection used to prove the catalog contract."""
    projected = []
    for entry in catalog:
        if entry["is_recurrence_exception"]:
            projected.append({
                "occurrence_date": entry["occurrence_date"],
                "start_date": entry["start_date"],
                "end_date": entry["end_date"],
                "title": entry["title"],
            })
            continue
        if entry["event_type"] != "weekly":
            continue
        effective = date.fromisoformat(entry["recurrence_effective_from_date"])
        template_start = date.fromisoformat(entry["start_date"])
        start_offset = template_start - effective
        end_offset = (
            date.fromisoformat(entry["end_date"]) - effective
            if entry["end_date"] is not None
            else None
        )
        boundary = entry["excluded_after_date"]
        excluded = set(entry["excluded_occurrence_dates"])
        interval = entry["recurrence_interval"]
        for anchor_text in anchors:
            anchor = date.fromisoformat(anchor_text)
            if anchor < effective or anchor_text in excluded:
                continue
            if boundary is not None and anchor_text >= boundary:
                continue
            if (anchor - effective).days % (7 * interval) != 0:
                continue
            projected.append({
                "occurrence_date": anchor_text,
                "start_date": (anchor + start_offset).isoformat(),
                "end_date": (anchor + end_offset).isoformat() if end_offset else None,
                "title": entry["title"],
            })
    return sorted(projected, key=lambda item: item["occurrence_date"])


def test_occurrence_patch_keeps_anchor_and_shifts_cross_day_duration():
    event = create(end_date="2026-07-07", detail="保留")
    result = edit(
        event["id"],
        "event-edit-occurrence-1",
        {"start_date": "2026-07-13", "detail": None},
        scope="occurrence",
        occurrence_date="2026-07-12",
        expected_revision=1,
    )

    assert result["canonical_ref"] == {
        "source_event_id": event["id"],
        "occurrence_date": "2026-07-12",
    }
    assert result["event"]["occurrence_date"] == "2026-07-12"
    assert result["event"]["start_date"] == "2026-07-13"
    assert result["event"]["end_date"] == "2026-07-15"
    assert result["event"]["detail"] is None
    assert result["event"]["color"] == "#123456"
    assert result["event"]["is_recurrence_exception"] is True

    july = db.list_events(year=2026, month=7, user_id=1)
    moved = by_anchor(july, "2026-07-12")
    assert moved["start_date"] == "2026-07-13"
    assert moved["end_date"] == "2026-07-15"
    assert by_anchor(july, "2026-07-19")["start_date"] == "2026-07-19"


def test_explicit_null_and_omission_differ_and_noop_is_recorded():
    event = create(detail="仍保留")
    first = edit(
        event["id"],
        "event-edit-sparse-1",
        {"title": "新标题"},
        expected_revision=1,
    )
    assert first["event"]["detail"] == "仍保留"

    cleared = edit(
        event["id"],
        "event-edit-explicit-null-1",
        {"detail": None},
        expected_revision=2,
    )
    assert cleared["event"]["detail"] is None

    noop = edit(
        event["id"],
        "event-edit-noop-1",
        {"title": "新标题"},
        expected_revision=3,
    )
    assert noop["changed"] is False
    assert noop["previous_revision"] == 3
    assert noop["revision"] == 3
    assert noop["reminder_rebuild"] is None
    assert db.get_event_command("event-edit-noop-1", user_id=1) == noop


def test_replay_uses_normalized_payload_before_revision_and_rejects_key_reuse():
    event = create(start_date="2026-07-06")
    first = edit(
        event["id"],
        "event-edit-idempotency-1",
        {"recurrence": {"weekdays": [3, 1, 3], "interval": 2}},
        occurrence_date="2026-07-06",
        expected_revision=1,
    )
    replay = edit(
        event["id"],
        "event-edit-idempotency-1",
        {"recurrence_interval": 2, "recurrence_weekdays": [1, 3]},
        occurrence_date="2026-07-06",
        expected_revision=1,
    )
    assert replay == first

    with pytest.raises(db.ScheduleCommandConflict, match="idempotency_key_reused"):
        edit(
            event["id"],
            "event-edit-idempotency-1",
            {"recurrence": {"interval": 3, "weekdays": [1, 3]}},
            occurrence_date="2026-07-06",
            expected_revision=1,
        )
    with pytest.raises(db.ScheduleCommandConflict, match="revision_conflict"):
        edit(
            event["id"],
            "event-edit-stale-1",
            {"title": "过期写入"},
            occurrence_date="2026-07-06",
            expected_revision=1,
        )


def test_following_creates_segment_keeps_prefix_and_source_id_stable():
    event = create(end_date="2026-07-07")
    result = edit(
        event["id"],
        "event-edit-following-1",
        {"title": "后段", "start_date": "2026-07-20"},
        scope="following",
        occurrence_date="2026-07-19",
        expected_revision=1,
    )

    assert result["segment_id"] is not None
    assert result["event"]["id"] == event["id"]
    assert result["event"]["source_event_id"] == event["id"]
    assert result["event"]["occurrence_date"] == "2026-07-19"
    assert result["event"]["start_date"] == "2026-07-20"
    assert result["event"]["end_date"] == "2026-07-22"

    updated_segment = edit(
        event["id"],
        "event-edit-following-update-1",
        {"location": "后段地点"},
        scope="following",
        occurrence_date="2026-07-19",
        expected_revision=result["revision"],
    )
    assert updated_segment["segment_id"] == result["segment_id"]

    july = db.list_events(year=2026, month=7, user_id=1)
    assert by_anchor(july, "2026-07-12")["title"] == "原日程"
    assert by_anchor(july, "2026-07-12")["start_date"] == "2026-07-12"
    assert by_anchor(july, "2026-07-19")["title"] == "后段"
    assert by_anchor(july, "2026-07-19")["location"] == "后段地点"
    assert by_anchor(july, "2026-07-26")["start_date"] == "2026-07-27"
    assert all(item["source_event_id"] == event["id"] for item in july)


def test_global_catalog_contains_templates_and_one_off_exception_without_duplicates():
    event = create(end_date="2026-07-07")
    following = edit(
        event["id"],
        "event-catalog-following-1",
        {"title": "后段", "start_date": "2026-07-20"},
        scope="following",
        occurrence_date="2026-07-19",
        expected_revision=1,
    )
    occurrence = edit(
        event["id"],
        "event-catalog-occurrence-1",
        {"title": "移动实例", "start_date": "2026-07-14"},
        scope="occurrence",
        occurrence_date="2026-07-12",
        expected_revision=following["revision"],
    )
    db.command_event_state(
        event_id=event["id"],
        user_id=1,
        client_request_id="event-catalog-delete-1",
        desired_state="absent",
        scope="occurrence",
        occurrence_date="2026-07-26",
        expected_revision=occurrence["revision"],
    )

    catalog = db.list_events(year=None, month=None, user_id=1)
    source_entries = [item for item in catalog if item["source_event_id"] == event["id"]]
    assert len(source_entries) == 3
    root = next(
        item for item in source_entries
        if item["segment_id"] is None and not item["is_recurrence_exception"]
    )
    segment = next(item for item in source_entries if item["segment_id"] is not None)
    exception = next(item for item in source_entries if item["is_recurrence_exception"])

    assert root["recurrence_effective_from_date"] == "2026-07-05"
    assert root["start_date"] == "2026-07-05"
    assert root["end_date"] == "2026-07-07"
    assert root["excluded_after_date"] == "2026-07-19"
    assert root["excluded_occurrence_dates"] == ["2026-07-12"]
    assert segment["recurrence_effective_from_date"] == "2026-07-19"
    assert segment["start_date"] == "2026-07-20"
    assert segment["end_date"] == "2026-07-22"
    assert segment["series_start_date"] == "2026-07-20"
    assert segment["series_end_date"] == "2026-07-22"
    assert segment["excluded_occurrence_dates"] == ["2026-07-26"]
    assert exception["event_type"] == "once"
    assert exception["occurrence_date"] == "2026-07-12"
    assert exception["start_date"] == "2026-07-14"
    assert exception["end_date"] == "2026-07-16"

    projected = expand_weekly_catalog(
        source_entries,
        ["2026-07-05", "2026-07-12", "2026-07-19", "2026-07-26"],
    )
    assert projected == [
        {
            "occurrence_date": "2026-07-05",
            "start_date": "2026-07-05",
            "end_date": "2026-07-07",
            "title": "原日程",
        },
        {
            "occurrence_date": "2026-07-12",
            "start_date": "2026-07-14",
            "end_date": "2026-07-16",
            "title": "移动实例",
        },
        {
            "occurrence_date": "2026-07-19",
            "start_date": "2026-07-20",
            "end_date": "2026-07-22",
            "title": "后段",
        },
    ]
    assert len({item["occurrence_date"] for item in projected}) == len(projected)

    july = db.list_events(year=2026, month=7, user_id=1)
    assert [item["occurrence_date"] for item in july] == [
        "2026-07-05",
        "2026-07-12",
        "2026-07-19",
    ]
    assert len({item["occurrence_id"] for item in july}) == len(july)


def test_global_catalog_segments_and_exceptions_are_user_isolated():
    own = create()
    other = create(user_id=2, title="另一用户")
    other_following = db.command_event_edit(
        event_id=other["id"],
        user_id=2,
        client_request_id="event-catalog-user2-following-1",
        scope="following",
        occurrence_date="2026-07-19",
        expected_revision=1,
        patch={"title": "另一用户后段"},
    )
    db.command_event_edit(
        event_id=other["id"],
        user_id=2,
        client_request_id="event-catalog-user2-occurrence-1",
        scope="occurrence",
        occurrence_date="2026-07-12",
        expected_revision=other_following["revision"],
        patch={"start_date": "2026-07-13"},
    )

    own_catalog = db.list_events(year=None, month=None, user_id=1)
    other_catalog = db.list_events(year=None, month=None, user_id=2)
    assert {item["source_event_id"] for item in own_catalog} == {own["id"]}
    assert {item["source_event_id"] for item in other_catalog} == {other["id"]}
    assert len(other_catalog) == 3
    assert sum(item["is_recurrence_exception"] for item in other_catalog) == 1


def test_series_edit_rebases_sparse_segment_and_clears_obsolete_cutoff():
    event = create()
    following = edit(
        event["id"],
        "event-edit-following-preserve-1",
        {"title": "后段标题"},
        scope="following",
        occurrence_date="2026-07-19",
        expected_revision=1,
    )
    db.command_event_state(
        event_id=event["id"],
        user_id=1,
        client_request_id="event-state-following-cutoff-1",
        desired_state="absent",
        scope="following",
        occurrence_date="2026-08-02",
        expected_revision=following["revision"],
    )

    result = edit(
        event["id"],
        "event-edit-series-rebase-1",
        {"color": "#abcdef", "recurrence": {"interval": 2}},
        expected_revision=3,
    )
    assert result["event"]["excluded_after_date"] is None
    assert result["event"]["recurrence_interval"] == 2

    july = db.list_events(year=2026, month=7, user_id=1)
    later = by_anchor(july, "2026-07-19")
    assert later["title"] == "后段标题"
    assert later["color"] == "#abcdef"


def test_custom_weekdays_interval_and_until_are_sorted_unique_and_inclusive():
    event = create(
        start_date="2026-07-06",
        recurrence_interval=2,
        recurrence_weekdays=[3, 1, 3],
        recurrence_until_date="2026-07-20",
    )
    assert event["recurrence_weekdays"] == [1, 3]

    july = db.list_events(year=2026, month=7, user_id=1)
    assert [item["occurrence_date"] for item in july] == [
        "2026-07-06",
        "2026-07-08",
        "2026-07-20",
    ]


def test_series_recurrence_geometry_orphans_old_exception_anchors():
    event = create(detail="根详情")
    occurrence = edit(
        event["id"],
        "event-edit-before-reanchor-1",
        {"detail": "单次详情"},
        scope="occurrence",
        occurrence_date="2026-07-12",
        expected_revision=1,
    )
    db.command_event_state(
        event_id=event["id"],
        user_id=1,
        client_request_id="event-state-before-reanchor-1",
        desired_state="absent",
        scope="occurrence",
        occurrence_date="2026-07-26",
        expected_revision=occurrence["revision"],
    )

    reanchored = edit(
        event["id"],
        "event-edit-reanchor-series-1",
        {"start_date": "2026-07-06"},
        occurrence_date="2026-07-05",
        expected_revision=3,
    )
    orphaned = db._get_conn().execute(
        """SELECT occurrence_date, exception_type, orphaned_at_revision
           FROM schedule_event_exceptions WHERE source_event_id = ? ORDER BY occurrence_date""",
        (event["id"],),
    ).fetchall()
    assert [(row["occurrence_date"], row["exception_type"]) for row in orphaned] == [
        ("2026-07-12", "patch"),
        ("2026-07-26", "deleted"),
    ]
    assert all(row["orphaned_at_revision"] == reanchored["revision"] for row in orphaned)
    assert [
        item["occurrence_date"] for item in db.list_events(year=2026, month=7, user_id=1)
    ] == ["2026-07-06", "2026-07-13", "2026-07-20", "2026-07-27"]


def test_edit_commands_are_user_isolated_and_legacy_nulls_do_not_clear_fields():
    other = create(user_id=2)
    assert edit(
        other["id"],
        "event-edit-wrong-user-1",
        {"title": "越权"},
    ) is None
    assert db.get_event_command("event-edit-wrong-user-1", user_id=2) is None

    event = create(detail="详情", status="状态", color="#654321")
    edit(
        event["id"],
        "event-edit-before-legacy-put-1",
        {"title": "后段覆盖"},
        scope="following",
        occurrence_date="2026-07-19",
        expected_revision=1,
    )
    updated = db.update_event_fields(
        event["id"],
        {
            "title": "旧 PUT 标题",
            "location": "新地点",
            "detail": None,
            "status": None,
            "color": None,
        },
        user_id=1,
        legacy_compat=True,
    )
    assert updated["title"] == "旧 PUT 标题"
    assert updated["detail"] == "详情"
    assert updated["status"] == "状态"
    assert updated["color"] == "#654321"
    later = by_anchor(db.list_events(year=2026, month=7, user_id=1), "2026-07-19")
    assert later["title"] == "后段覆盖"
    assert later["location"] == "新地点"

    columns = {
        row["name"] for row in db._get_conn().execute("PRAGMA table_info(schedule_event_commands)")
    }
    assert {"command_type", "request_json", "completed_at"} <= columns
    stored = db._get_conn().execute(
        "SELECT request_json FROM schedule_event_commands WHERE client_request_id = ?",
        ("event-edit-no-such-command",),
    ).fetchone()
    assert stored is None


def test_occurrence_patch_storage_is_sparse_and_state_commands_still_work():
    event = create(detail="原详情")
    result = edit(
        event["id"],
        "event-edit-storage-1",
        {"detail": None, "title": "单次标题"},
        scope="occurrence",
        occurrence_date="2026-07-12",
        expected_revision=1,
    )
    row = db._get_conn().execute(
        """SELECT patch_json, patch_revision FROM schedule_event_exceptions
           WHERE source_event_id = ? AND occurrence_date = ? AND exception_type = 'patch'""",
        (event["id"], "2026-07-12"),
    ).fetchone()
    assert json.loads(row["patch_json"]) == {"detail": None, "title": "单次标题"}
    assert row["patch_revision"] == result["revision"]

    deleted = db.command_event_state(
        event_id=event["id"],
        user_id=1,
        client_request_id="event-state-after-edit-1",
        desired_state="absent",
        scope="occurrence",
        occurrence_date="2026-07-19",
        expected_revision=result["revision"],
    )
    assert deleted["changed"] is True
    assert "2026-07-19" not in {
        item["occurrence_date"] for item in db.list_events(year=2026, month=7, user_id=1)
    }


def test_existing_state_command_rows_migrate_without_losing_their_type():
    legacy = sqlite3.connect(db._get_db_path())
    legacy.execute(
        """CREATE TABLE schedule_event_commands (
               id INTEGER PRIMARY KEY AUTOINCREMENT,
               user_id INTEGER NOT NULL,
               client_request_id TEXT NOT NULL,
               source_event_id INTEGER NOT NULL,
               payload_hash TEXT NOT NULL,
               response_json TEXT NOT NULL,
               created_at TEXT NOT NULL,
               UNIQUE(user_id, client_request_id)
           )"""
    )
    legacy.execute(
        """INSERT INTO schedule_event_commands
           (user_id, client_request_id, source_event_id, payload_hash, response_json, created_at)
           VALUES (1, 'legacy-state-command-1', 9, 'hash', '{"changed":false}', '2026-07-15')"""
    )
    legacy.commit()
    legacy.close()

    db._init_db()
    migrated = db._get_conn().execute(
        """SELECT command_type, request_json, completed_at
           FROM schedule_event_commands WHERE client_request_id = 'legacy-state-command-1'"""
    ).fetchone()
    assert migrated["command_type"] == "state"
    assert migrated["request_json"] is None
    assert migrated["completed_at"] is None
    assert db.get_event_command(
        "legacy-state-command-1", user_id=1, command_type="state"
    ) == {"changed": False}
