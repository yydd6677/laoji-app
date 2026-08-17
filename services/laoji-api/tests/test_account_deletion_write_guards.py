import pytest

from app.services import laoji_auth_service as auth
from app.services import schedule_db_service as schedules


@pytest.fixture()
def account_db(tmp_path, monkeypatch):
    db_path = tmp_path / "schedule.db"
    auth.close_auth_db()
    schedules.set_db_path(str(db_path))
    monkeypatch.setenv("LAOJI_DB_PATH", str(db_path))
    monkeypatch.setenv("LAOJI_AVATAR_DIR", str(tmp_path / "avatars"))
    user = auth.register_user("guard@example.com", "Password123", "guard")
    session = auth.create_session(int(user["id"]))
    yield user, session
    schedules.close_db()
    schedules.set_db_path(None)
    auth.close_auth_db()


def test_account_deletion_lease_revokes_sessions_and_blocks_schedule_writes(account_db):
    user, session = account_db
    user_id = int(user["id"])
    event = schedules.create_event(
        user_id=user_id,
        title="before deletion",
        start_date="2026-07-11",
    )

    revoked = auth.begin_account_deletion(user_id, "Password123")
    assert revoked == 1
    assert auth.get_user_by_token(session["access_token"]) is None
    assert auth.authenticate_user("guard@example.com", "Password123") is None

    with pytest.raises(schedules.ScheduleWriteBlocked, match="正在删除"):
        schedules.create_event(
            user_id=user_id,
            title="late event",
            start_date="2026-07-12",
        )
    with pytest.raises(schedules.ScheduleWriteBlocked, match="正在删除"):
        schedules.update_event_fields(event["id"], {"title": "late update"}, user_id=user_id)
    with pytest.raises(schedules.ScheduleWriteBlocked, match="正在删除"):
        schedules.delete_event(event["id"], user_id=user_id)

    auth.cancel_account_deletion(user_id)
    restored = auth.authenticate_user("guard@example.com", "Password123")
    assert restored is not None
    schedules.create_event(
        user_id=user_id,
        title="after retry release",
        start_date="2026-07-13",
    )


def test_deleted_user_cannot_leave_orphan_schedule_event(account_db):
    user, _ = account_db
    user_id = int(user["id"])
    auth.begin_account_deletion(user_id, "Password123")
    auth.delete_account_data_after_verification(user_id)
    with pytest.raises(schedules.ScheduleWriteBlocked, match="账号不存在"):
        schedules.create_event(
            user_id=user_id,
            title="orphan",
            start_date="2026-07-14",
        )


def test_failed_or_competing_deletion_cannot_destroy_another_lease_or_session(account_db):
    user, session = account_db
    user_id = int(user["id"])
    operation_id = "owned-auth-operation"

    leased_sessions = auth.begin_account_deletion(
        user_id,
        "Password123",
        operation_id=operation_id,
        revoke_sessions=False,
    )
    assert leased_sessions == 1
    assert auth.get_user_by_token(session["access_token"]) is None

    with pytest.raises(auth.AccountDeletionInProgress, match="另一项"):
        auth.begin_account_deletion(
            user_id,
            "Password123",
            operation_id="competing-auth-operation",
            revoke_sessions=False,
        )
    assert not auth.cancel_account_deletion(
        user_id,
        operation_id="competing-auth-operation",
    )
    assert auth.get_user_by_token(session["access_token"]) is None

    assert auth.cancel_account_deletion(user_id, operation_id=operation_id)
    assert auth.get_user_by_token(session["access_token"]) is not None


def test_expired_deletion_lease_restores_token_and_clears_write_block(account_db):
    user, session = account_db
    user_id = int(user["id"])
    auth.begin_account_deletion(
        user_id,
        "Password123",
        operation_id="expired-auth-operation",
        revoke_sessions=False,
    )
    conn = auth._get_conn()
    conn.execute(
        "UPDATE laoji_users SET deletion_lease_expires_at = ? WHERE id = ?",
        ("2000-01-01T00:00:00+00:00", user_id),
    )
    conn.commit()

    assert auth.get_user_by_token(session["access_token"]) is not None
    lease = conn.execute(
        """
        SELECT deletion_started_at, deletion_lease_expires_at,
               deletion_revoked_sessions, deletion_operation_id
        FROM laoji_users WHERE id = ?
        """,
        (user_id,),
    ).fetchone()
    assert tuple(lease) == (None, None, 0, None)
    updated = auth.update_profile(user_id, {"nickname": "lease recovered"})
    assert updated["nickname"] == "lease recovered"


def test_schedule_default_path_honors_shared_laoji_db_environment(tmp_path, monkeypatch):
    shared_path = tmp_path / "isolated" / "shared-schedule.db"
    schedules.set_db_path(None)
    monkeypatch.setenv("LAOJI_DB_PATH", str(shared_path))
    event = schedules.create_event(title="isolated", start_date="2026-07-15")
    assert event["title"] == "isolated"
    assert shared_path.exists()
    assert schedules._get_db_path() == str(shared_path.resolve())
    schedules.close_db()
