#!/usr/bin/env python3
"""Destructive, self-cleaning black-box audit for meeting-summary task lifecycle."""

from __future__ import annotations

import argparse
import json
import secrets
import sys
import time
import uuid
from pathlib import Path
from typing import Any
from urllib.parse import quote

from audit_live_user_isolation import AuditFailure, HttpClient, HttpResult, redact, validate_base_url


class SummaryTaskLifecycleAudit:
    def __init__(
        self,
        auth_base: str,
        meeting_base: str,
        timeout_seconds: float,
        poll_timeout_seconds: float,
        respect_environment_proxy: bool = False,
        http: HttpClient | None = None,
    ) -> None:
        self.auth_base = auth_base
        self.meeting_base = meeting_base
        self.http = http or HttpClient(timeout_seconds, respect_environment_proxy)
        self.poll_timeout_seconds = poll_timeout_seconds
        self.run_id = uuid.uuid4().hex
        self.account: dict[str, Any] | None = None
        self.checks: list[dict[str, Any]] = []
        self.cleanup: list[dict[str, Any]] = []

    @staticmethod
    def url(base: str, path: str) -> str:
        return f"{base}{path}"

    def record(
        self,
        name: str,
        result: HttpResult,
        passed: bool,
        expected: str,
        summary: dict[str, Any] | None = None,
    ) -> None:
        entry: dict[str, Any] = {
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
        self.record(name, result, passed, f"status in {sorted(allowed)}")
        if not passed:
            raise AuditFailure(f"{name} returned HTTP {result.status}")

    def register_account(self) -> None:
        account = f"laoji.summary.audit.{self.run_id}@example.com"
        password = f"Aa1!{secrets.token_urlsafe(18)}"
        result = self.http.request(
            "POST",
            self.url(self.auth_base, "/api/auth/register"),
            body={"account": account, "password": password, "nickname": "总结任务审计"},
        )
        self.require_status("register_temporary_account", result, {201})
        token = result.data.get("access_token") if isinstance(result.data, dict) else None
        if not isinstance(token, str) or not token:
            raise AuditFailure("temporary account registration returned no access token")
        self.account = {"account": account, "password": password, "token": token, "deleted": False}

    def delete_account(self) -> None:
        if not self.account or self.account.get("deleted"):
            return
        result = self.http.request(
            "DELETE",
            self.url(self.auth_base, "/api/auth/me"),
            token=str(self.account["token"]),
            body={"current_password": self.account["password"], "confirmation": "删除账号"},
        )
        deleted = result.status == 200 and isinstance(result.data, dict) and result.data.get("deleted") is True
        self.account["deleted"] = deleted
        self.cleanup.append({
            "name": "delete_temporary_account",
            "passed": deleted,
            "status": result.status,
            "latency_ms": result.latency_ms,
            "expected": "HTTP 200 with deleted=true",
        })

    def guest_payload(self, meeting_id: str) -> dict[str, Any]:
        return {
            "meeting_id": meeting_id,
            "title": "总结任务生命周期审计",
            "meeting_date": "2026-07-13",
            "force": False,
            "transcript_lines": [
                {
                    "speaker_label": "主持人",
                    "text": "本次审计确认相同输入只能复用同一个总结任务。",
                    "start_time": 0,
                    "end_time": 4,
                },
                {
                    "speaker_label": "成员",
                    "text": "审计结束后删除临时账号，不保留会议资料。",
                    "start_time": 4,
                    "end_time": 8,
                },
            ],
        }

    def submit_guest_summary_twice(self) -> str:
        meeting_id = f"audit-guest-{self.run_id}"
        path = "/api/laoji/meetings/guest-summary"
        first = self.http.request("POST", self.url(self.meeting_base, path), body=self.guest_payload(meeting_id))
        self.require_status("submit_guest_summary_first", first, {200, 202})
        second = self.http.request("POST", self.url(self.meeting_base, path), body=self.guest_payload(meeting_id))
        self.require_status("submit_guest_summary_duplicate", second, {200, 202})

        first_task = first.data.get("task_id") if isinstance(first.data, dict) else None
        second_task = second.data.get("task_id") if isinstance(second.data, dict) else None
        first_reused = first.data.get("reused") if isinstance(first.data, dict) else None
        second_reused = second.data.get("reused") if isinstance(second.data, dict) else None
        passed = (
            isinstance(first_task, str)
            and bool(first_task)
            and first_task == second_task
            and first_reused is False
            and second_reused is True
        )
        self.record(
            "duplicate_guest_submission_reuses_task",
            second,
            passed,
            "same task_id, first reused=false, second reused=true",
            {"same_task_id": first_task == second_task, "first_reused": first_reused, "second_reused": second_reused},
        )
        if not passed:
            raise AuditFailure("duplicate guest summary submission was not safely reused")
        return first_task

    def create_owned_meeting(self) -> str:
        if not self.account:
            raise AuditFailure("temporary account is missing")
        result = self.http.request(
            "POST",
            self.url(self.meeting_base, "/api/laoji/meetings"),
            token=str(self.account["token"]),
            body={
                "title": "总结任务归属审计",
                "description": "自动清理的临时会议",
                "participants": [],
                "mode": "realtime",
                "client_request_id": f"summary-audit:{self.run_id}",
            },
        )
        self.require_status("create_owned_meeting", result, {201})
        meeting_id = result.data.get("id") if isinstance(result.data, dict) else None
        if not isinstance(meeting_id, str) or not meeting_id:
            raise AuditFailure("owned meeting creation returned no string id")
        return meeting_id

    def verify_guest_task_not_readable_as_account(self, meeting_id: str, guest_task_id: str) -> None:
        if not self.account:
            raise AuditFailure("temporary account is missing")
        path = (
            f"/api/laoji/meetings/{quote(meeting_id, safe='')}/summaries/task/"
            f"{quote(guest_task_id, safe='')}"
        )
        result = self.http.request(
            "GET",
            self.url(self.meeting_base, path),
            token=str(self.account["token"]),
        )
        self.record(
            "guest_task_rejected_by_authenticated_meeting_route",
            result,
            result.status == 404,
            "HTTP 404 for a task outside the account and meeting scope",
        )
        if result.status != 404:
            raise AuditFailure("guest summary task leaked through an authenticated meeting route")

    def wait_for_guest_task(self, task_id: str) -> None:
        deadline = time.monotonic() + self.poll_timeout_seconds
        attempts = 0
        while time.monotonic() <= deadline:
            attempts += 1
            result = self.http.request(
                "GET",
                self.url(
                    self.meeting_base,
                    f"/api/laoji/meetings/guest-summary/tasks/{quote(task_id, safe='')}",
                ),
            )
            self.require_status(f"poll_guest_summary_{attempts}", result, {200})
            status = result.data.get("status") if isinstance(result.data, dict) else None
            if status == "SUCCESS":
                self.record(
                    "guest_summary_reaches_success",
                    result,
                    True,
                    "status=SUCCESS before timeout",
                    {"attempts": attempts},
                )
                return
            if status == "FAILURE":
                self.record("guest_summary_reaches_success", result, False, "status=SUCCESS before timeout")
                raise AuditFailure("guest summary task returned FAILURE")
            if status not in {"PENDING", "STARTED", "GENERATING"}:
                raise AuditFailure(f"guest summary task returned unknown status: {status!r}")
            time.sleep(1.0)
        raise AuditFailure("guest summary task did not finish before the audit timeout")

    def run(self) -> dict[str, Any]:
        started = time.time()
        fatal_error: str | None = None
        try:
            guest_task_id = self.submit_guest_summary_twice()
            self.register_account()
            meeting_id = self.create_owned_meeting()
            self.verify_guest_task_not_readable_as_account(meeting_id, guest_task_id)
            self.wait_for_guest_task(guest_task_id)
        except AuditFailure as error:
            fatal_error = str(error)
        finally:
            try:
                self.delete_account()
            except AuditFailure as error:
                self.cleanup.append({
                    "name": "delete_temporary_account",
                    "passed": False,
                    "error_type": type(error).__name__,
                })

        cleanup_ok = self.account is None or (
            bool(self.account.get("deleted"))
            and all(item.get("passed") for item in self.cleanup)
        )
        checks_passed = sum(1 for item in self.checks if item.get("passed"))
        overall_passed = fatal_error is None and checks_passed == len(self.checks) and cleanup_ok
        return {
            "schema_version": 1,
            "audit": "laoji_summary_task_lifecycle",
            "run_id": self.run_id,
            "started_at_epoch": int(started),
            "duration_ms": round((time.time() - started) * 1000, 1),
            "service_origins": {"auth": self.auth_base, "meeting": self.meeting_base},
            "network": {"environment_proxy": self.http.respect_environment_proxy},
            "summary": {
                "passed": overall_passed,
                "checks_passed": checks_passed,
                "checks_total": len(self.checks),
                "cleanup_passed": cleanup_ok,
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
    parser.add_argument("--poll-timeout-seconds", type=float, default=180.0)
    parser.add_argument("--output", type=Path)
    parser.add_argument("--report-stdout", action="store_true")
    parser.add_argument("--respect-environment-proxy", action="store_true")
    parser.add_argument(
        "--confirm-live-mutations",
        action="store_true",
        help="required acknowledgement that a temporary account, meeting, and summary task will be created",
    )
    args = parser.parse_args()
    if not args.confirm_live_mutations:
        parser.error("--confirm-live-mutations is required")
    if args.timeout_seconds <= 0 or args.timeout_seconds > 120:
        parser.error("--timeout-seconds must be in (0, 120]")
    if args.poll_timeout_seconds <= 0 or args.poll_timeout_seconds > 600:
        parser.error("--poll-timeout-seconds must be in (0, 600]")
    return args


def main() -> int:
    args = parse_args()
    report = SummaryTaskLifecycleAudit(
        args.auth_base,
        args.meeting_base,
        args.timeout_seconds,
        args.poll_timeout_seconds,
        respect_environment_proxy=args.respect_environment_proxy,
    ).run()
    rendered = json.dumps(redact(report), ensure_ascii=False, indent=2) + "\n"
    if args.output:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(rendered, encoding="utf-8")
    if args.report_stdout:
        print(rendered, end="")
    else:
        summary = report["summary"]
        print(
            f"summary task lifecycle audit: {'PASS' if summary['passed'] else 'FAIL'}; "
            f"checks={summary['checks_passed']}/{summary['checks_total']}; "
            f"cleanup={'PASS' if summary['cleanup_passed'] else 'FAIL'}"
        )
        if args.output:
            print(f"report: {args.output}")
    return 0 if report["summary"]["passed"] else 1


if __name__ == "__main__":
    sys.exit(main())
