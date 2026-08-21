import sqlite3
import threading
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.database import get_db
from app.laoji import auth_router
from app.laoji.auth_router import router
from app.services.account_deletion_service import MeetingDeletionReport
from app.services import laoji_auth_service as auth


@pytest.fixture()
def client(tmp_path, monkeypatch):
    auth.close_auth_db()
    monkeypatch.setenv("LAOJI_DB_PATH", str(tmp_path / "schedule.db"))
    monkeypatch.setenv("LAOJI_AVATAR_DIR", str(tmp_path / "avatars"))
    app = FastAPI()
    app.include_router(router, prefix="/api/auth")

    class FakeDb:
        async def rollback(self):
            return None

    async def fake_db():
        yield FakeDb()

    app.dependency_overrides[get_db] = fake_db
    with TestClient(app) as test_client:
        yield test_client, tmp_path
    auth.close_auth_db()


def register(client: TestClient, account: str = "user@example.com", password: str = "Password123"):
    response = client.post(
        "/api/auth/register",
        json={"account": account, "password": password, "nickname": "测试用户"},
    )
    assert response.status_code == 201, response.text
    return response.json()


def bearer(session: dict) -> dict[str, str]:
    return {"Authorization": f"Bearer {session['access_token']}"}


def test_profile_change_password_and_session_restore(client):
    http, _ = client
    session = register(http)
    headers = bearer(session)
    second_session = http.post(
        "/api/auth/login",
        json={"account": "user@example.com", "password": "Password123"},
    ).json()

    profile = http.patch(
        "/api/auth/me/profile",
        headers=headers,
        json={
            "nickname": "新昵称",
            "email": "new@example.com",
            "phone": "+86 138-0000-0000",
            "avatar_initial": "",
            "avatar_colors": ["#112233", "#AABBCC"],
        },
    )
    assert profile.status_code == 200, profile.text
    assert profile.json() == {
        "nickname": "新昵称",
        "email": "new@example.com",
        "phone": "+86 138-0000-0000",
        "avatar_initial": "",
        "avatar_colors": ["#112233", "#AABBCC"],
        "avatar_url": None,
    }
    assert http.get("/api/auth/me/profile", headers=headers).json() == profile.json()

    wrong = http.post(
        "/api/auth/change-password",
        headers=headers,
        json={"current_password": "WrongPass1", "new_password": "NewPassword456"},
    )
    assert wrong.status_code == 400
    assert wrong.json()["detail"] == "当前密码错误"

    changed = http.post(
        "/api/auth/change-password",
        headers=headers,
        json={"current_password": "Password123", "new_password": "NewPassword456"},
    )
    assert changed.status_code == 204
    assert http.get("/api/auth/me", headers=headers).status_code == 200
    assert http.get("/api/auth/me", headers=bearer(second_session)).status_code == 401
    assert http.post(
        "/api/auth/login",
        json={"account": "user@example.com", "password": "Password123"},
    ).status_code == 401
    assert http.post(
        "/api/auth/login",
        json={"account": "user@example.com", "password": "NewPassword456"},
    ).status_code == 200


def test_avatar_upload_is_validated_isolated_and_deletable(client):
    http, _ = client
    first = register(http, "first@example.com")
    second = register(http, "second@example.com")
    png = b"\x89PNG\r\n\x1a\n" + b"test-image-payload"

    uploaded = http.post(
        "/api/auth/me/avatar",
        headers=bearer(first),
        files={"file": ("avatar.png", png, "image/png")},
    )
    assert uploaded.status_code == 200, uploaded.text
    avatar_url = uploaded.json()["avatar_url"]
    assert avatar_url.startswith("/api/auth/avatars/u")
    avatar = http.get(avatar_url)
    assert avatar.status_code == 200
    assert avatar.content == png
    assert avatar.headers["x-content-type-options"] == "nosniff"

    assert http.get("/api/auth/me/profile", headers=bearer(second)).json()["avatar_url"] is None
    rejected = http.post(
        "/api/auth/me/avatar",
        headers=bearer(first),
        files={"file": ("avatar.txt", b"not-an-image", "text/plain")},
    )
    assert rejected.status_code == 415

    deleted = http.delete("/api/auth/me/avatar", headers=bearer(first))
    assert deleted.status_code == 200
    assert deleted.json()["avatar_url"] is None
    assert http.get(avatar_url).status_code == 404


def test_reset_request_does_not_disclose_account_existence(client):
    http, tmp_path = client
    register(http)
    known = http.post(
        "/api/auth/password-reset-requests",
        json={"account": "user@example.com"},
    )
    unknown = http.post(
        "/api/auth/password-reset-requests",
        json={"account": "missing@example.com"},
    )
    assert known.status_code == unknown.status_code == 202
    assert known.json()["message"] == unknown.json()["message"]
    assert known.json()["request_id"] != unknown.json()["request_id"]
    duplicate = http.post(
        "/api/auth/password-reset-requests",
        json={"account": "user@example.com"},
    )
    assert duplicate.status_code == 202
    assert duplicate.json()["request_id"] == known.json()["request_id"]

    conn = sqlite3.connect(tmp_path / "schedule.db")
    rows = conn.execute(
        "SELECT account, user_id, status FROM laoji_password_reset_requests ORDER BY created_at"
    ).fetchall()
    conn.close()
    assert rows == [("user@example.com", 1, "pending")]


def test_operator_can_complete_or_reject_reset_requests(client):
    http, _ = client
    original = register(http)
    register(http, "other@example.com")
    known = http.post(
        "/api/auth/password-reset-requests",
        json={"account": "user@example.com"},
    ).json()["request_id"]
    rejected_request = http.post(
        "/api/auth/password-reset-requests",
        json={"account": "other@example.com"},
    ).json()["request_id"]

    pending = auth.list_password_reset_requests("pending")
    assert {item["request_id"] for item in pending} == {known, rejected_request}

    completed = auth.complete_password_reset_request(known, "ResetPassword789")
    assert completed["status"] == "completed"
    assert http.get("/api/auth/me", headers=bearer(original)).status_code == 401
    assert http.post(
        "/api/auth/login",
        json={"account": "user@example.com", "password": "Password123"},
    ).status_code == 401
    assert http.post(
        "/api/auth/login",
        json={"account": "user@example.com", "password": "ResetPassword789"},
    ).status_code == 200

    rejected = auth.reject_password_reset_request(rejected_request)
    assert rejected["status"] == "rejected"
    assert {item["request_id"] for item in auth.list_password_reset_requests("completed")} == {known}
    assert {item["request_id"] for item in auth.list_password_reset_requests("rejected")} == {rejected_request}


def test_login_rate_limit_survives_connections_and_returns_retry_after(client):
    http, _ = client
    register(http)
    for _ in range(8):
        response = http.post(
            "/api/auth/login",
            json={"account": "user@example.com", "password": "WrongPassword123"},
        )
        assert response.status_code == 401

    auth.close_auth_db()
    limited = http.post(
        "/api/auth/login",
        json={"account": "user@example.com", "password": "WrongPassword123"},
    )
    assert limited.status_code == 429
    assert int(limited.headers["retry-after"]) > 0
    assert limited.json()["detail"] == "请求过于频繁，请稍后重试"


def test_password_reset_rate_limit_and_database_deduplication(client):
    http, tmp_path = client
    register(http)
    request_ids = []
    for _ in range(6):
        response = http.post(
            "/api/auth/password-reset-requests",
            json={"account": "user@example.com"},
        )
        assert response.status_code == 202
        request_ids.append(response.json()["request_id"])
    assert len(set(request_ids)) == 1

    limited = http.post(
        "/api/auth/password-reset-requests",
        json={"account": "user@example.com"},
    )
    assert limited.status_code == 429
    conn = sqlite3.connect(tmp_path / "schedule.db")
    assert conn.execute("SELECT COUNT(*) FROM laoji_password_reset_requests").fetchone()[0] == 1
    conn.close()


def test_auth_rate_limit_window_is_persistent_and_expires(client):
    _, _ = client
    start = datetime.now(timezone.utc).replace(microsecond=0)
    assert auth.consume_auth_rate_limit("test", "source", limit=2, window_seconds=60, now=start) == (True, 0)
    assert auth.consume_auth_rate_limit("test", "source", limit=2, window_seconds=60, now=start) == (True, 0)
    auth.close_auth_db()
    allowed, retry_after = auth.consume_auth_rate_limit(
        "test",
        "source",
        limit=2,
        window_seconds=60,
        now=start + timedelta(seconds=10),
    )
    assert not allowed
    assert retry_after == 50
    assert auth.consume_auth_rate_limit(
        "test",
        "source",
        limit=2,
        window_seconds=60,
        now=start + timedelta(seconds=61),
    ) == (True, 0)


def test_password_reset_migration_removes_invalid_and_duplicate_pending_rows(client):
    http, tmp_path = client
    register(http)
    now = datetime.now(timezone.utc).replace(microsecond=0)
    auth.close_auth_db()
    conn = sqlite3.connect(tmp_path / "schedule.db")
    conn.execute("DROP INDEX idx_laoji_password_reset_pending_user")
    conn.executemany(
        """
        INSERT INTO laoji_password_reset_requests
            (request_id, user_id, account, status, created_at)
        VALUES (?, ?, ?, 'pending', ?)
        """,
        [
            ("old-known", 1, "user@example.com", (now - timedelta(days=1)).isoformat()),
            ("new-known", 1, "user@example.com", now.isoformat()),
            ("unknown", None, "missing@example.com", now.isoformat()),
        ],
    )
    conn.commit()
    conn.close()

    auth.init_auth_db()
    auth.close_auth_db()
    conn = sqlite3.connect(tmp_path / "schedule.db")
    rows = conn.execute(
        "SELECT request_id, user_id FROM laoji_password_reset_requests ORDER BY request_id"
    ).fetchall()
    indexes = {row[1] for row in conn.execute("PRAGMA index_list(laoji_password_reset_requests)")}
    conn.close()
    assert rows == [("new-known", 1)]
    assert "idx_laoji_password_reset_pending_user" in indexes


def test_auth_rate_limit_is_atomic_under_concurrent_requests(client):
    _, _ = client
    auth.init_auth_db()
    barrier = threading.Barrier(12)
    results: list[tuple[bool, int]] = []
    errors: list[BaseException] = []

    def consume() -> None:
        try:
            barrier.wait(timeout=5)
            results.append(auth.consume_auth_rate_limit(
                "concurrent-login",
                "same-source-account",
                limit=5,
                window_seconds=900,
            ))
        except BaseException as exc:
            errors.append(exc)
        finally:
            auth.close_auth_db()

    threads = [threading.Thread(target=consume) for _ in range(12)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join(15)

    assert all(not thread.is_alive() for thread in threads)
    assert errors == []
    assert sum(1 for allowed, _ in results if allowed) == 5
    assert sum(1 for allowed, _ in results if not allowed) == 7


def test_registration_requires_eight_character_password(client):
    http, _ = client
    response = http.post(
        "/api/auth/register",
        json={"account": "user@example.com", "password": "1234567"},
    )
    assert response.status_code == 422


def test_profile_session_and_avatar_writes_are_blocked_during_deletion_lease(client):
    http, tmp_path = client
    session = register(http)
    user_id = int(session["user"]["id"])
    auth.begin_account_deletion(user_id, "Password123")

    with pytest.raises(auth.AccountWriteBlocked, match="正在删除"):
        auth.create_session(user_id)
    with pytest.raises(auth.AccountWriteBlocked, match="正在删除"):
        auth.update_profile(user_id, {"nickname": "late profile"})
    with pytest.raises(auth.AccountWriteBlocked, match="正在删除"):
        auth.save_avatar(user_id, b"\x89PNG\r\n\x1a\nlate", "png")
    with pytest.raises(auth.AccountWriteBlocked, match="正在删除"):
        auth.delete_avatar(user_id)
    with pytest.raises(auth.AccountWriteBlocked, match="正在删除"):
        auth.change_password(user_id, "Password123", "NewPassword456")
    assert list((tmp_path / "avatars").iterdir()) == []

    auth.cancel_account_deletion(user_id)
    assert auth.update_profile(user_id, {"nickname": "retry works"})["nickname"] == "retry works"


def test_avatar_write_serializes_with_deletion_and_leaves_no_orphan(client, monkeypatch):
    http, tmp_path = client
    session = register(http)
    user_id = int(session["user"]["id"])
    temp_written = threading.Event()
    allow_avatar_commit = threading.Event()
    deletion_leased = threading.Event()
    allow_account_delete = threading.Event()
    errors: list[BaseException] = []
    original_write_bytes = Path.write_bytes

    def delayed_write(path: Path, content: bytes) -> int:
        result = original_write_bytes(path, content)
        if path.name.endswith(".tmp"):
            temp_written.set()
            assert allow_avatar_commit.wait(5)
        return result

    monkeypatch.setattr(Path, "write_bytes", delayed_write)

    def upload_avatar() -> None:
        try:
            auth.save_avatar(user_id, b"\x89PNG\r\n\x1a\nserialized", "png")
        except BaseException as exc:  # surfaced in the main test thread
            errors.append(exc)
        finally:
            auth.close_auth_db()

    def delete_account() -> None:
        try:
            auth.begin_account_deletion(user_id, "Password123")
            deletion_leased.set()
            assert allow_account_delete.wait(5)
            auth.delete_account_data_after_verification(user_id)
        except BaseException as exc:  # surfaced in the main test thread
            errors.append(exc)
        finally:
            auth.close_auth_db()

    upload_thread = threading.Thread(target=upload_avatar)
    delete_thread = threading.Thread(target=delete_account)
    upload_thread.start()
    assert temp_written.wait(5)
    delete_thread.start()
    time.sleep(0.05)
    assert not deletion_leased.is_set()

    allow_avatar_commit.set()
    upload_thread.join(5)
    assert not upload_thread.is_alive()
    assert deletion_leased.wait(5)
    allow_account_delete.set()
    delete_thread.join(5)
    assert not delete_thread.is_alive()
    assert errors == []
    assert auth.get_user_by_id(user_id) is None
    assert list((tmp_path / "avatars").iterdir()) == []


def test_public_account_deletion_request_is_generic_and_queryable(client):
    http, _ = client
    register(http)
    known = http.post(
        "/api/auth/account-deletion-requests",
        json={
            "account": "user@example.com",
            "contact": "contact@example.com",
            "reason": "不再使用",
        },
    )
    unknown = http.post(
        "/api/auth/account-deletion-requests",
        json={
            "account": "missing@example.com",
            "contact": "contact@example.com",
        },
    )
    assert known.status_code == unknown.status_code == 202
    assert known.json()["message"] == unknown.json()["message"]
    known_id = known.json()["request_id"]
    status = http.get(f"/api/auth/account-deletion-requests/{known_id}")
    assert status.status_code == 200
    assert status.json()["status"] == "pending"
    assert "account" not in status.json()
    assert "contact" not in status.json()

    duplicate = http.post(
        "/api/auth/account-deletion-requests",
        json={"account": "user@example.com", "contact": "contact@example.com"},
    )
    assert duplicate.status_code == 202
    assert duplicate.json()["request_id"] == known_id

    different_contact = http.post(
        "/api/auth/account-deletion-requests",
        json={"account": "user@example.com", "contact": "another@example.com"},
    )
    assert different_contact.status_code == 202
    assert different_contact.json()["request_id"] != known_id


def test_account_deletion_request_retention_and_stale_processing_recovery(client):
    http, tmp_path = client
    expired_id = http.post(
        "/api/auth/account-deletion-requests",
        json={"account": "expired@example.com", "contact": "expired-contact@example.com"},
    ).json()["request_id"]
    processing_id = http.post(
        "/api/auth/account-deletion-requests",
        json={"account": "processing@example.com", "contact": "processing-contact@example.com"},
    ).json()["request_id"]

    conn = sqlite3.connect(tmp_path / "schedule.db")
    conn.execute(
        "UPDATE laoji_account_deletion_requests SET created_at = ? WHERE request_id = ?",
        ("2000-01-01T00:00:00+00:00", expired_id),
    )
    conn.execute(
        """
        UPDATE laoji_account_deletion_requests
        SET status = 'processing', processing_started_at = ?
        WHERE request_id = ?
        """,
        ("2000-01-01T00:00:00+00:00", processing_id),
    )
    conn.commit()
    conn.close()

    auth.init_auth_db()

    conn = sqlite3.connect(tmp_path / "schedule.db")
    conn.row_factory = sqlite3.Row
    assert conn.execute(
        "SELECT 1 FROM laoji_account_deletion_requests WHERE request_id = ?",
        (expired_id,),
    ).fetchone() is None
    recovered = conn.execute(
        """
        SELECT status, processing_started_at, last_error
        FROM laoji_account_deletion_requests WHERE request_id = ?
        """,
        (processing_id,),
    ).fetchone()
    conn.close()
    assert recovered is not None
    assert recovered["status"] == "pending"
    assert recovered["processing_started_at"] is None
    assert recovered["last_error"] == "处理租约超过 24 小时，已自动恢复为待处理"


def test_concurrent_account_deletion_requests_are_deduplicated(client):
    _, tmp_path = client
    auth.init_auth_db()
    barrier = threading.Barrier(2)
    request_ids: list[str] = []
    errors: list[BaseException] = []

    def submit() -> None:
        try:
            barrier.wait(timeout=5)
            request_ids.append(
                auth.create_account_deletion_request(
                    "concurrent@example.com",
                    "same-contact@example.com",
                )
            )
        except BaseException as exc:
            errors.append(exc)
        finally:
            auth.close_auth_db()

    threads = [threading.Thread(target=submit) for _ in range(2)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join(10)

    assert all(not thread.is_alive() for thread in threads)
    assert errors == []
    assert len(request_ids) == 2
    assert len(set(request_ids)) == 1
    conn = sqlite3.connect(tmp_path / "schedule.db")
    row_count = conn.execute(
        """
        SELECT COUNT(*) FROM laoji_account_deletion_requests
        WHERE account = ? AND contact = ?
        """,
        ("concurrent@example.com", "same-contact@example.com"),
    ).fetchone()[0]
    conn.close()
    assert row_count == 1


def test_operator_claim_requires_explicit_resume_and_records_failed_attempt(client):
    http, _ = client
    register(http)
    request_id = http.post(
        "/api/auth/account-deletion-requests",
        json={"account": "user@example.com", "contact": "contact@example.com"},
    ).json()["request_id"]

    claimed = auth.claim_account_deletion_request(request_id)
    assert claimed["status"] == "processing"
    assert claimed["attempt_count"] == 1
    with pytest.raises(ValueError, match="--resume"):
        auth.claim_account_deletion_request(request_id)

    resumed = auth.claim_account_deletion_request(request_id, resume=True)
    assert resumed["status"] == "processing"
    assert resumed["attempt_count"] == 2
    auth.release_account_deletion_request(request_id, "temporary cleanup failure")

    pending = auth.list_account_deletion_requests("pending")
    assert len(pending) == 1
    assert pending[0]["request_id"] == request_id
    assert pending[0]["last_error"] == "temporary cleanup failure"
    assert pending[0]["processing_started_at"] is None


def test_authenticated_account_deletion_cascades_and_revokes_sessions(client, monkeypatch):
    http, tmp_path = client
    session = register(http)
    headers = bearer(session)
    second_session = http.post(
        "/api/auth/login",
        json={"account": "user@example.com", "password": "Password123"},
    ).json()
    reset_id = http.post(
        "/api/auth/password-reset-requests",
        json={"account": "user@example.com"},
    ).json()["request_id"]
    delete_request_id = http.post(
        "/api/auth/account-deletion-requests",
        json={"account": "user@example.com", "contact": "contact@example.com"},
    ).json()["request_id"]

    png = b"\x89PNG\r\n\x1a\n" + b"delete-me"
    avatar_url = http.post(
        "/api/auth/me/avatar",
        headers=headers,
        files={"file": ("avatar.png", png, "image/png")},
    ).json()["avatar_url"]

    conn = sqlite3.connect(tmp_path / "schedule.db")
    conn.execute("CREATE TABLE schedule_events (id INTEGER PRIMARY KEY, user_id INTEGER)")
    conn.execute("INSERT INTO schedule_events(user_id) VALUES (1)")
    conn.commit()
    conn.close()

    calls = {"begin": 0, "preflight": 0, "delete": 0, "voiceprints": 0, "finalize": 0, "guard": 0}

    async def fake_begin_guard(user_id, db, operation_id):
        assert user_id == 1
        assert operation_id
        calls["begin"] += 1

    async def fake_preflight(user_id, db, operation_id):
        assert user_id == 1
        assert operation_id
        calls["preflight"] += 1

    async def fake_meeting_delete(user_id, db, operation_id):
        assert user_id == 1
        assert operation_id
        calls["delete"] += 1
        return MeetingDeletionReport(meetings_deleted=2, meeting_ids=("m1", "m2"))

    async def fake_finalize(user_id, db, operation_id):
        assert user_id == 1
        assert operation_id
        calls["finalize"] += 1

    def fake_voiceprint_delete(user_id):
        assert user_id == 1
        calls["voiceprints"] += 1
        return 1

    async def fake_finalize_guard(user_id, db, operation_id):
        assert user_id == 1
        assert operation_id
        calls["guard"] += 1

    monkeypatch.setattr(auth_router, "begin_user_meeting_deletion", fake_begin_guard)
    monkeypatch.setattr(auth_router, "preflight_user_meeting_deletion", fake_preflight)
    monkeypatch.setattr(auth_router, "delete_user_meeting_data", fake_meeting_delete)
    monkeypatch.setattr(auth_router, "delete_user_voiceprints", fake_voiceprint_delete)
    monkeypatch.setattr(auth_router, "finalize_user_meeting_deletion", fake_finalize)
    monkeypatch.setattr(auth_router, "finalize_user_deletion_guard", fake_finalize_guard)

    wrong = http.request(
        "DELETE",
        "/api/auth/me",
        headers=headers,
        json={"current_password": "WrongPass1", "confirmation": "删除账号"},
    )
    assert wrong.status_code == 400
    assert calls == {"begin": 0, "preflight": 0, "delete": 0, "voiceprints": 0, "finalize": 0, "guard": 0}
    assert http.get("/api/auth/me", headers=headers).status_code == 200

    invalid_confirmation = http.request(
        "DELETE",
        "/api/auth/me",
        headers=headers,
        json={"current_password": "Password123", "confirmation": "删除"},
    )
    assert invalid_confirmation.status_code == 422
    assert calls == {"begin": 0, "preflight": 0, "delete": 0, "voiceprints": 0, "finalize": 0, "guard": 0}

    deleted = http.request(
        "DELETE",
        "/api/auth/me",
        headers=headers,
        json={"current_password": "Password123", "confirmation": "删除账号"},
    )
    assert deleted.status_code == 200, deleted.text
    assert deleted.json() == {
        "deleted": True,
        "events_deleted": 1,
        "meetings_deleted": 2,
        "sessions_deleted": 2,
        "cleanup_pending": 0,
    }
    assert calls == {"begin": 1, "preflight": 1, "delete": 1, "voiceprints": 1, "finalize": 1, "guard": 1}
    assert http.get("/api/auth/me", headers=headers).status_code == 401
    assert http.get("/api/auth/me", headers=bearer(second_session)).status_code == 401
    assert http.post(
        "/api/auth/login",
        json={"account": "user@example.com", "password": "Password123"},
    ).status_code == 401
    assert http.get(avatar_url).status_code == 404

    conn = sqlite3.connect(tmp_path / "schedule.db")
    assert conn.execute("SELECT COUNT(*) FROM laoji_users").fetchone()[0] == 0
    assert conn.execute("SELECT COUNT(*) FROM laoji_sessions").fetchone()[0] == 0
    assert conn.execute("SELECT COUNT(*) FROM schedule_events").fetchone()[0] == 0
    assert conn.execute(
        "SELECT COUNT(*) FROM laoji_password_reset_requests WHERE request_id = ?",
        (reset_id,),
    ).fetchone()[0] == 0
    request_row = conn.execute(
        """
        SELECT status, user_id, account, contact, reason
        FROM laoji_account_deletion_requests WHERE request_id = ?
        """,
        (delete_request_id,),
    ).fetchone()
    conn.close()
    assert request_row == ("completed", None, None, None, None)


def test_authenticated_account_deletion_conflict_preserves_sessions(client, monkeypatch):
    http, tmp_path = client
    first_session = register(http)
    second_session = http.post(
        "/api/auth/login",
        json={"account": "user@example.com", "password": "Password123"},
    ).json()
    lifecycle: list[tuple[str, str]] = []

    async def fake_begin_guard(user_id, db, operation_id):
        assert user_id == 1
        lifecycle.append(("begin", operation_id))

    async def fake_preflight(user_id, db, operation_id):
        assert user_id == 1
        lifecycle.append(("preflight", operation_id))
        raise auth_router.AccountDeletionConflict("请先结束正在录制或处理中的会议")

    async def fake_cancel_guard(user_id, db, operation_id):
        assert user_id == 1
        lifecycle.append(("cancel", operation_id))

    monkeypatch.setattr(auth_router, "begin_user_meeting_deletion", fake_begin_guard)
    monkeypatch.setattr(auth_router, "preflight_user_meeting_deletion", fake_preflight)
    monkeypatch.setattr(auth_router, "cancel_user_meeting_deletion", fake_cancel_guard)

    response = http.request(
        "DELETE",
        "/api/auth/me",
        headers=bearer(first_session),
        json={"current_password": "Password123", "confirmation": "删除账号"},
    )
    assert response.status_code == 409
    assert response.json()["detail"] == "请先结束正在录制或处理中的会议"
    assert [name for name, _ in lifecycle] == ["begin", "preflight", "cancel"]
    assert len({operation_id for _, operation_id in lifecycle}) == 1
    assert http.get("/api/auth/me", headers=bearer(first_session)).status_code == 200
    assert http.get("/api/auth/me", headers=bearer(second_session)).status_code == 200

    conn = sqlite3.connect(tmp_path / "schedule.db")
    assert conn.execute("SELECT COUNT(*) FROM laoji_sessions WHERE user_id = 1").fetchone()[0] == 2
    lease = conn.execute(
        """
        SELECT deletion_started_at, deletion_lease_expires_at, deletion_operation_id
        FROM laoji_users WHERE id = 1
        """
    ).fetchone()
    conn.close()
    assert lease == (None, None, None)
