#!/usr/bin/env python3
"""Destructive, self-cleaning black-box audit for deployed LaoJi user isolation."""

from __future__ import annotations

import argparse
import hashlib
import json
import secrets
import sys
import time
import uuid
from dataclasses import dataclass
from datetime import date, timedelta
from pathlib import Path
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.parse import quote, urlsplit, urlunsplit
from urllib.request import ProxyHandler, Request, build_opener


SENSITIVE_KEYS = {
    "access_token",
    "account",
    "authorization",
    "email",
    "guest_token",
    "password",
    "phone",
    "refresh_token",
    "token",
}


class AuditFailure(RuntimeError):
    pass


def validate_base_url(value: str) -> str:
    parsed = urlsplit(value.strip())
    if parsed.scheme not in {"http", "https"} or not parsed.hostname:
        raise argparse.ArgumentTypeError("base URL must be an absolute HTTP(S) URL")
    if parsed.username or parsed.password or parsed.query or parsed.fragment:
        raise argparse.ArgumentTypeError("base URL must not contain credentials, query, or fragment")
    path = parsed.path.rstrip("/")
    return urlunsplit((parsed.scheme, parsed.netloc, path, "", ""))


def redact(value: Any) -> Any:
    if isinstance(value, dict):
        return {
            key: "[redacted]" if key.lower() in SENSITIVE_KEYS else redact(item)
            for key, item in value.items()
        }
    if isinstance(value, list):
        return [redact(item) for item in value]
    return value


def stable_subject_id(account: str) -> str:
    return hashlib.sha256(account.encode("utf-8")).hexdigest()[:12]


def response_items(data: Any) -> list[dict[str, Any]]:
    if isinstance(data, list):
        return [item for item in data if isinstance(item, dict)]
    if isinstance(data, dict):
        items = data.get("items", data.get("events", []))
        if isinstance(items, list):
            return [item for item in items if isinstance(item, dict)]
    return []


@dataclass
class HttpResult:
    status: int
    data: Any
    latency_ms: float


class HttpClient:
    def __init__(self, timeout_seconds: float, respect_environment_proxy: bool = False) -> None:
        self.timeout_seconds = timeout_seconds
        self.respect_environment_proxy = respect_environment_proxy
        self.opener = build_opener() if respect_environment_proxy else build_opener(ProxyHandler({}))

    def request(
        self,
        method: str,
        url: str,
        *,
        token: str | None = None,
        body: dict[str, Any] | None = None,
    ) -> HttpResult:
        headers = {
            "Accept": "application/json",
            "User-Agent": "LaoJi-isolation-audit/1.0",
        }
        payload = None
        if token:
            headers["Authorization"] = f"Bearer {token}"
        if body is not None:
            headers["Content-Type"] = "application/json"
            payload = json.dumps(body, ensure_ascii=False).encode("utf-8")

        started = time.perf_counter()
        request = Request(url, data=payload, headers=headers, method=method)
        try:
            with self.opener.open(request, timeout=self.timeout_seconds) as response:
                status = response.status
                raw = response.read()
        except HTTPError as error:
            status = error.code
            raw = error.read()
        except (URLError, TimeoutError, OSError) as error:
            elapsed = (time.perf_counter() - started) * 1000
            raise AuditFailure(f"transport failure after {elapsed:.1f} ms: {type(error).__name__}") from error

        elapsed = (time.perf_counter() - started) * 1000
        if not raw:
            data: Any = None
        else:
            try:
                data = json.loads(raw.decode("utf-8"))
            except (UnicodeDecodeError, json.JSONDecodeError):
                data = {"non_json_response": True, "size_bytes": len(raw)}
        return HttpResult(status=status, data=data, latency_ms=round(elapsed, 1))


class IsolationAudit:
    def __init__(
        self,
        auth_base: str,
        meeting_base: str,
        timeout_seconds: float,
        respect_environment_proxy: bool = False,
    ) -> None:
        self.auth_base = auth_base
        self.meeting_base = meeting_base
        self.http = HttpClient(timeout_seconds, respect_environment_proxy)
        self.run_id = uuid.uuid4().hex
        self.shared_event_key = f"audit:{self.run_id}:event"
        self.shared_meeting_key = f"audit:{self.run_id}:meeting"
        self.accounts: dict[str, dict[str, Any]] = {}
        self.checks: list[dict[str, Any]] = []
        self.cleanup: list[dict[str, Any]] = []

    def url(self, base: str, path: str) -> str:
        return f"{base}{path}"

    def record(
        self,
        name: str,
        result: HttpResult,
        passed: bool,
        *,
        expected: str,
        summary: dict[str, Any] | None = None,
    ) -> None:
        entry = {
            "name": name,
            "passed": passed,
            "status": result.status,
            "latency_ms": result.latency_ms,
            "expected": expected,
        }
        if summary:
            entry["summary"] = redact(summary)
        self.checks.append(entry)

    def require_status(self, name: str, result: HttpResult, allowed: set[int]) -> None:
        passed = result.status in allowed
        self.record(name, result, passed, expected=f"status in {sorted(allowed)}")
        if not passed:
            raise AuditFailure(f"{name} returned HTTP {result.status}")

    def check_status(self, name: str, result: HttpResult, allowed: set[int]) -> bool:
        passed = result.status in allowed
        self.record(name, result, passed, expected=f"status in {sorted(allowed)}")
        return passed

    def check_condition(
        self,
        name: str,
        result: HttpResult,
        condition: bool,
        expected: str,
        summary: dict[str, Any] | None = None,
    ) -> bool:
        self.record(name, result, condition, expected=expected, summary=summary)
        return condition

    def register(self, label: str) -> None:
        account = f"laoji.audit.{self.run_id}.{label.lower()}@example.com"
        password = f"Aa1!{secrets.token_urlsafe(18)}"
        result = self.http.request(
            "POST",
            self.url(self.auth_base, "/api/auth/register"),
            body={"account": account, "password": password, "nickname": f"隔离审计{label}"},
        )
        self.require_status(f"register_{label}", result, {201})
        if not isinstance(result.data, dict) or not isinstance(result.data.get("access_token"), str):
            raise AuditFailure(f"register_{label} did not return an access token")
        self.accounts[label] = {
            "account": account,
            "password": password,
            "token": result.data["access_token"],
            "subject_id": stable_subject_id(account),
            "deleted": False,
        }

    def token(self, label: str) -> str:
        return str(self.accounts[label]["token"])

    def event_payload(self, label: str) -> dict[str, Any]:
        return {
            "title": f"隔离审计日程{label}",
            "event_type": "once",
            "start_date": (date.today() + timedelta(days=7)).isoformat(),
            "start_time": "10:00",
            "end_time": "11:00",
            "is_all_day": False,
            "category": "工作",
            "raw_text": f"隔离审计临时日程{label}",
            "client_request_id": self.shared_event_key,
        }

    def create_event(self, label: str) -> tuple[HttpResult, int]:
        result = self.http.request(
            "POST",
            self.url(self.auth_base, "/api/laoji/events"),
            token=self.token(label),
            body=self.event_payload(label),
        )
        self.require_status(f"create_event_{label}", result, {201})
        event_id = result.data.get("id") if isinstance(result.data, dict) else None
        if not isinstance(event_id, int):
            raise AuditFailure(f"create_event_{label} returned no integer id")
        return result, event_id

    def meeting_payload(self, label: str) -> dict[str, Any]:
        return {
            "title": f"隔离审计会议{label}",
            "description": "自动清理的跨账号隔离审计数据",
            "participants": [],
            "mode": "realtime",
            "client_request_id": self.shared_meeting_key,
        }

    def create_meeting(self, label: str) -> tuple[HttpResult, str]:
        result = self.http.request(
            "POST",
            self.url(self.meeting_base, "/api/laoji/meetings"),
            token=self.token(label),
            body=self.meeting_payload(label),
        )
        self.require_status(f"create_meeting_{label}", result, {201})
        meeting_id = result.data.get("id") if isinstance(result.data, dict) else None
        if not isinstance(meeting_id, str) or not meeting_id:
            raise AuditFailure(f"create_meeting_{label} returned no string id")
        return result, meeting_id

    def delete_account(self, label: str, *, cleanup_only: bool = False) -> HttpResult:
        account = self.accounts[label]
        token = str(account.get("token", ""))
        result = self.http.request(
            "DELETE",
            self.url(self.auth_base, "/api/auth/me"),
            token=token,
            body={"current_password": account["password"], "confirmation": "删除账号"},
        )
        if result.status == 401:
            login = self.http.request(
                "POST",
                self.url(self.auth_base, "/api/auth/login"),
                body={"account": account["account"], "password": account["password"]},
            )
            if login.status == 200 and isinstance(login.data, dict) and isinstance(login.data.get("access_token"), str):
                account["token"] = login.data["access_token"]
                result = self.http.request(
                    "DELETE",
                    self.url(self.auth_base, "/api/auth/me"),
                    token=account["token"],
                    body={"current_password": account["password"], "confirmation": "删除账号"},
                )
        deleted = result.status == 200 and isinstance(result.data, dict) and result.data.get("deleted") is True
        account["deleted"] = deleted
        summary = {
            key: result.data.get(key)
            for key in ("deleted", "events_deleted", "meetings_deleted", "sessions_deleted", "cleanup_pending")
            if isinstance(result.data, dict) and key in result.data
        }
        target = self.cleanup if cleanup_only else self.checks
        entry = {
            "name": f"cleanup_account_{label}" if cleanup_only else f"delete_account_{label}",
            "passed": deleted,
            "status": result.status,
            "latency_ms": result.latency_ms,
            "expected": "HTTP 200 with deleted=true",
            "summary": redact(summary),
        }
        target.append(entry)
        return result

    def run(self) -> dict[str, Any]:
        started = time.time()
        fatal_error: str | None = None
        try:
            unauth_events = self.http.request("GET", self.url(self.auth_base, "/api/laoji/events"))
            self.check_status("events_require_auth", unauth_events, {401})
            unauth_meetings = self.http.request("GET", self.url(self.meeting_base, "/api/laoji/meetings?page=1&size=10"))
            self.check_status("meetings_require_auth", unauth_meetings, {401})

            self.register("A")
            self.register("B")

            _, event_a = self.create_event("A")
            duplicate_a = self.http.request(
                "POST",
                self.url(self.auth_base, "/api/laoji/events"),
                token=self.token("A"),
                body=self.event_payload("A"),
            )
            duplicate_a_id = duplicate_a.data.get("id") if isinstance(duplicate_a.data, dict) else None
            self.check_condition(
                "event_idempotency_same_user",
                duplicate_a,
                duplicate_a.status in {200, 201} and duplicate_a_id == event_a,
                "same user and client_request_id return the original event",
            )
            conflicting_event_payload = self.event_payload("A")
            conflicting_event_payload["title"] = "同一键的不同日程"
            conflicting_event = self.http.request(
                "POST",
                self.url(self.auth_base, "/api/laoji/events"),
                token=self.token("A"),
                body=conflicting_event_payload,
            )
            self.check_status("event_idempotency_payload_conflict_rejected", conflicting_event, {409})
            _, event_b = self.create_event("B")
            self.check_condition(
                "event_idempotency_is_user_scoped",
                HttpResult(200, None, 0.0),
                event_a != event_b,
                "different users may reuse the same client_request_id",
            )

            list_a = self.http.request("GET", self.url(self.auth_base, "/api/laoji/events"), token=self.token("A"))
            list_b = self.http.request("GET", self.url(self.auth_base, "/api/laoji/events"), token=self.token("B"))
            ids_a = {item.get("id") for item in response_items(list_a.data)}
            ids_b = {item.get("id") for item in response_items(list_b.data)}
            self.check_condition("event_list_isolation_A", list_a, list_a.status == 200 and event_a in ids_a and event_b not in ids_a, "A sees only A event")
            self.check_condition("event_list_isolation_B", list_b, list_b.status == 200 and event_b in ids_b and event_a not in ids_b, "B sees only B event")

            cross_event_update = self.http.request(
                "PUT",
                self.url(self.auth_base, f"/api/laoji/events/{event_a}"),
                token=self.token("B"),
                body={"title": "越权修改"},
            )
            self.check_status("cross_user_event_update_denied", cross_event_update, {403, 404})
            cross_event_delete = self.http.request(
                "DELETE",
                self.url(self.auth_base, f"/api/laoji/events/{event_a}"),
                token=self.token("B"),
            )
            self.check_status("cross_user_event_delete_denied", cross_event_delete, {403, 404})
            verify_event_a = self.http.request("GET", self.url(self.auth_base, "/api/laoji/events"), token=self.token("A"))
            surviving_ids = {item.get("id") for item in response_items(verify_event_a.data)}
            self.check_condition("event_survives_cross_user_attempts", verify_event_a, verify_event_a.status == 200 and event_a in surviving_ids, "A event still exists")

            _, meeting_a = self.create_meeting("A")
            duplicate_meeting_a = self.http.request(
                "POST",
                self.url(self.meeting_base, "/api/laoji/meetings"),
                token=self.token("A"),
                body=self.meeting_payload("A"),
            )
            duplicate_meeting_a_id = duplicate_meeting_a.data.get("id") if isinstance(duplicate_meeting_a.data, dict) else None
            self.check_condition(
                "meeting_idempotency_same_user",
                duplicate_meeting_a,
                duplicate_meeting_a.status in {200, 201} and duplicate_meeting_a_id == meeting_a,
                "same user and client_request_id return the original meeting",
            )
            conflicting_meeting_payload = self.meeting_payload("A")
            conflicting_meeting_payload["title"] = "同一键的不同会议"
            conflicting_meeting = self.http.request(
                "POST",
                self.url(self.meeting_base, "/api/laoji/meetings"),
                token=self.token("A"),
                body=conflicting_meeting_payload,
            )
            self.check_status("meeting_idempotency_payload_conflict_rejected", conflicting_meeting, {409})
            _, meeting_b = self.create_meeting("B")
            self.check_condition(
                "meeting_idempotency_is_user_scoped",
                HttpResult(200, None, 0.0),
                meeting_a != meeting_b,
                "different users may reuse the same client_request_id",
            )

            meetings_a = self.http.request("GET", self.url(self.meeting_base, "/api/laoji/meetings?page=1&size=100"), token=self.token("A"))
            meetings_b = self.http.request("GET", self.url(self.meeting_base, "/api/laoji/meetings?page=1&size=100"), token=self.token("B"))
            meeting_ids_a = {item.get("id") for item in response_items(meetings_a.data)}
            meeting_ids_b = {item.get("id") for item in response_items(meetings_b.data)}
            self.check_condition("meeting_list_isolation_A", meetings_a, meetings_a.status == 200 and meeting_a in meeting_ids_a and meeting_b not in meeting_ids_a, "A sees only A meeting")
            self.check_condition("meeting_list_isolation_B", meetings_b, meetings_b.status == 200 and meeting_b in meeting_ids_b and meeting_a not in meeting_ids_b, "B sees only B meeting")

            encoded_meeting_a = quote(meeting_a, safe="")
            cross_transcript = self.http.request(
                "GET",
                self.url(self.meeting_base, f"/api/laoji/meetings/{encoded_meeting_a}/transcripts?offset=0&limit=10"),
                token=self.token("B"),
            )
            self.check_status("cross_user_transcript_read_denied", cross_transcript, {403, 404})
            cross_meeting_update = self.http.request(
                "PATCH",
                self.url(self.meeting_base, f"/api/laoji/meetings/{encoded_meeting_a}"),
                token=self.token("B"),
                body={"title": "越权修改"},
            )
            self.check_status("cross_user_meeting_update_denied", cross_meeting_update, {403, 404})
            cross_meeting_delete = self.http.request(
                "DELETE",
                self.url(self.meeting_base, f"/api/laoji/meetings/{encoded_meeting_a}"),
                token=self.token("B"),
            )
            self.check_status("cross_user_meeting_delete_denied", cross_meeting_delete, {403, 404})
            verify_meeting_a = self.http.request("GET", self.url(self.meeting_base, "/api/laoji/meetings?page=1&size=100"), token=self.token("A"))
            surviving_meetings = {item.get("id") for item in response_items(verify_meeting_a.data)}
            self.check_condition("meeting_survives_cross_user_attempts", verify_meeting_a, verify_meeting_a.status == 200 and meeting_a in surviving_meetings, "A meeting still exists")

            old_token_a = self.token("A")
            delete_a = self.delete_account("A")
            counts_a = delete_a.data if isinstance(delete_a.data, dict) else {}
            self.check_condition(
                "account_A_cascade_counts",
                delete_a,
                delete_a.status == 200
                and counts_a.get("events_deleted", 0) >= 1
                and counts_a.get("meetings_deleted", 0) >= 1
                and counts_a.get("sessions_deleted", 0) >= 1
                and counts_a.get("cleanup_pending", -1) == 0,
                "event, meeting and session deleted with no pending cleanup",
                {key: counts_a.get(key) for key in ("events_deleted", "meetings_deleted", "sessions_deleted", "cleanup_pending")},
            )
            old_a_auth = self.http.request("GET", self.url(self.auth_base, "/api/auth/me"), token=old_token_a)
            self.check_status("deleted_account_A_token_rejected_by_auth", old_a_auth, {401})
            old_a_events = self.http.request("GET", self.url(self.auth_base, "/api/laoji/events"), token=old_token_a)
            self.check_status("deleted_account_A_token_rejected_by_events", old_a_events, {401})
            old_a_meetings = self.http.request("GET", self.url(self.meeting_base, "/api/laoji/meetings?page=1&size=10"), token=old_token_a)
            self.check_status("deleted_account_A_token_rejected_by_meetings", old_a_meetings, {401})

            old_token_b = self.token("B")
            delete_b = self.delete_account("B")
            counts_b = delete_b.data if isinstance(delete_b.data, dict) else {}
            self.check_condition(
                "account_B_cascade_counts",
                delete_b,
                delete_b.status == 200
                and counts_b.get("events_deleted", 0) >= 1
                and counts_b.get("meetings_deleted", 0) >= 1
                and counts_b.get("sessions_deleted", 0) >= 1
                and counts_b.get("cleanup_pending", -1) == 0,
                "event, meeting and session deleted with no pending cleanup",
                {key: counts_b.get(key) for key in ("events_deleted", "meetings_deleted", "sessions_deleted", "cleanup_pending")},
            )
            old_b_auth = self.http.request("GET", self.url(self.auth_base, "/api/auth/me"), token=old_token_b)
            self.check_status("deleted_account_B_token_rejected_by_auth", old_b_auth, {401})
            old_b_meetings = self.http.request("GET", self.url(self.meeting_base, "/api/laoji/meetings?page=1&size=10"), token=old_token_b)
            self.check_status("deleted_account_B_token_rejected_by_meetings", old_b_meetings, {401})
        except AuditFailure as error:
            fatal_error = str(error)
        finally:
            for label in ("A", "B"):
                account = self.accounts.get(label)
                if account and not account.get("deleted"):
                    try:
                        self.delete_account(label, cleanup_only=True)
                    except AuditFailure as error:
                        self.cleanup.append({
                            "name": f"cleanup_account_{label}",
                            "passed": False,
                            "error_type": type(error).__name__,
                        })

        passed_checks = sum(1 for item in self.checks if item.get("passed"))
        cleanup_ok = all(item.get("passed") for item in self.cleanup)
        account_cleanup_ok = all(account.get("deleted") for account in self.accounts.values())
        overall_passed = fatal_error is None and passed_checks == len(self.checks) and cleanup_ok and account_cleanup_ok
        return {
            "schema_version": 1,
            "audit": "laoji_live_user_isolation",
            "run_id": self.run_id,
            "started_at_epoch": int(started),
            "duration_ms": round((time.time() - started) * 1000, 1),
            "service_origins": {
                "auth": self.auth_base,
                "meeting": self.meeting_base,
            },
            "network": {
                "environment_proxy": self.http.respect_environment_proxy,
            },
            "subjects": {
                label: {"subject_id": account["subject_id"], "deleted": bool(account.get("deleted"))}
                for label, account in self.accounts.items()
            },
            "summary": {
                "passed": overall_passed,
                "checks_passed": passed_checks,
                "checks_total": len(self.checks),
                "cleanup_passed": cleanup_ok and account_cleanup_ok,
                "fatal_error": fatal_error,
            },
            "checks": self.checks,
            "cleanup": self.cleanup,
        }


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--auth-base", required=True, type=validate_base_url)
    parser.add_argument("--meeting-base", required=True, type=validate_base_url)
    parser.add_argument("--timeout-seconds", type=float, default=15.0)
    parser.add_argument("--output", type=Path)
    parser.add_argument(
        "--report-stdout",
        action="store_true",
        help="write the complete sanitized JSON report to stdout instead of the human summary",
    )
    parser.add_argument(
        "--respect-environment-proxy",
        action="store_true",
        help="opt in to HTTP(S) proxy variables; direct connections are the safer audit default",
    )
    parser.add_argument(
        "--confirm-live-mutations",
        action="store_true",
        help="required acknowledgement that two temporary accounts and records will be created and deleted",
    )
    args = parser.parse_args()
    if not args.confirm_live_mutations:
        parser.error("--confirm-live-mutations is required")
    if args.timeout_seconds <= 0 or args.timeout_seconds > 120:
        parser.error("--timeout-seconds must be in (0, 120]")
    return args


def main() -> int:
    args = parse_args()
    report = IsolationAudit(
        args.auth_base,
        args.meeting_base,
        args.timeout_seconds,
        respect_environment_proxy=args.respect_environment_proxy,
    ).run()
    rendered = json.dumps(redact(report), ensure_ascii=False, indent=2) + "\n"
    if args.output:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(rendered, encoding="utf-8")
    if args.report_stdout:
        print(rendered, end="")
        return 0 if report["summary"]["passed"] else 1
    summary = report["summary"]
    print(
        f"live isolation audit: {'PASS' if summary['passed'] else 'FAIL'}; "
        f"checks={summary['checks_passed']}/{summary['checks_total']}; "
        f"cleanup={'PASS' if summary['cleanup_passed'] else 'FAIL'}"
    )
    if args.output:
        print(f"report: {args.output}")
    return 0 if summary["passed"] else 1


if __name__ == "__main__":
    sys.exit(main())
