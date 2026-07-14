#!/usr/bin/env python3
"""Destructive, self-cleaning black-box audit for meeting-summary task lifecycle."""

from __future__ import annotations

import argparse
import json
import os
import secrets
import subprocess
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
        audio_file: Path | None = None,
        respect_environment_proxy: bool = False,
        http: HttpClient | None = None,
    ) -> None:
        self.auth_base = auth_base
        self.meeting_base = meeting_base
        self.http = http or HttpClient(timeout_seconds, respect_environment_proxy)
        self.poll_timeout_seconds = poll_timeout_seconds
        self.audio_file = audio_file
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

    def guest_payload(
        self,
        meeting_id: str,
        *,
        force: bool = False,
        changed: bool = False,
    ) -> dict[str, Any]:
        payload = {
            "meeting_id": meeting_id,
            "title": "总结任务生命周期审计",
            "meeting_date": "2026-07-13",
            "force": force,
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
        if changed:
            payload["transcript_lines"].append({
                "speaker_label": "主持人",
                "text": "补充要求是把发布风险登记到会后行动项。",
                "start_time": 8,
                "end_time": 12,
            })
        return payload

    @staticmethod
    def task_id(result: HttpResult, label: str) -> str:
        value = result.data.get("task_id") if isinstance(result.data, dict) else None
        if not isinstance(value, str) or not value:
            raise AuditFailure(f"{label} returned no task_id")
        return value

    @staticmethod
    def has_summary_text(value: Any) -> bool:
        if isinstance(value, str):
            return bool(value.strip())
        if isinstance(value, list):
            return any(SummaryTaskLifecycleAudit.has_summary_text(item) for item in value)
        if isinstance(value, dict):
            return any(
                SummaryTaskLifecycleAudit.has_summary_text(value.get(key))
                for key in ("overview", "full_text", "markdown", "summary", "content")
            )
        return False

    def submit_guest(self, payload: dict[str, Any], name: str) -> HttpResult:
        result = self.http.request(
            "POST",
            self.url(self.meeting_base, "/api/laoji/meetings/guest-summary"),
            body=payload,
        )
        self.require_status(name, result, {200, 202})
        self.task_id(result, name)
        return result

    def submit_guest_summary_twice(self) -> str:
        meeting_id = f"audit-guest-{self.run_id}"
        payload = self.guest_payload(meeting_id)
        first = self.submit_guest(payload, "submit_guest_summary_first")
        second = self.submit_guest(payload, "submit_guest_summary_duplicate")

        first_task = self.task_id(first, "submit_guest_summary_first")
        second_task = self.task_id(second, "submit_guest_summary_duplicate")
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

    def guest_task_status(self, task_id: str, name: str, *, wait_ms: int = 5000) -> HttpResult:
        result = self.http.request(
            "GET",
            self.url(
                self.meeting_base,
                f"/api/laoji/meetings/guest-summary/tasks/{quote(task_id, safe='')}"
                f"?wait_ms={wait_ms}",
            ),
        )
        self.require_status(name, result, {200})
        return result

    def wait_for_guest_task(self, task_id: str, label: str) -> HttpResult:
        deadline = time.monotonic() + self.poll_timeout_seconds
        attempts = 0
        while time.monotonic() <= deadline:
            attempts += 1
            result = self.guest_task_status(task_id, f"poll_{label}_{attempts}")
            status = result.data.get("status") if isinstance(result.data, dict) else None
            if status == "SUCCESS":
                has_text = self.has_summary_text(result.data.get("result"))
                self.record(
                    f"{label}_reaches_success_with_content",
                    result,
                    has_text,
                    "status=SUCCESS with non-empty summary content before timeout",
                    {"attempts": attempts, "has_summary_text": has_text},
                )
                if not has_text:
                    raise AuditFailure(f"{label} returned an empty summary")
                return result
            if status == "FAILURE":
                self.record(f"{label}_reaches_success_with_content", result, False, "status=SUCCESS before timeout")
                raise AuditFailure(f"{label} returned FAILURE")
            if status not in {"PENDING", "STARTED", "GENERATING"}:
                raise AuditFailure(f"guest summary task returned unknown status: {status!r}")
            if not (isinstance(result.data, dict) and result.data.get("long_poll_supported") is True):
                time.sleep(1.0)
        raise AuditFailure(f"{label} did not finish before the audit timeout")

    def verify_guest_lifecycle_after_completion(self, meeting_id: str, task_id: str) -> None:
        replay = self.submit_guest(self.guest_payload(meeting_id), "submit_guest_summary_after_success")
        replay_task = self.task_id(replay, "submit_guest_summary_after_success")
        replay_reused = replay.data.get("reused") if isinstance(replay.data, dict) else None
        replay_ok = replay_task == task_id and replay_reused is True
        self.record(
            "successful_guest_submission_replays_task",
            replay,
            replay_ok,
            "same task_id and reused=true within the replay window",
            {"same_task_id": replay_task == task_id, "reused": replay_reused},
        )
        if not replay_ok:
            raise AuditFailure("successful guest summary was not replayed")

        changed = self.submit_guest(
            self.guest_payload(meeting_id, changed=True),
            "submit_guest_summary_changed_input",
        )
        changed_task = self.task_id(changed, "submit_guest_summary_changed_input")
        changed_reused = changed.data.get("reused") if isinstance(changed.data, dict) else None
        changed_ok = changed_task != task_id and changed_reused is False
        self.record(
            "changed_guest_input_creates_new_task",
            changed,
            changed_ok,
            "different task_id and reused=false when transcript content changes",
            {"different_task_id": changed_task != task_id, "reused": changed_reused},
        )
        if not changed_ok:
            raise AuditFailure("changed guest summary input reused stale work")
        self.wait_for_guest_task(changed_task, "changed_guest_summary")

        forced = self.submit_guest(
            self.guest_payload(meeting_id, force=True),
            "submit_guest_summary_forced",
        )
        forced_task = self.task_id(forced, "submit_guest_summary_forced")
        forced_reused = forced.data.get("reused") if isinstance(forced.data, dict) else None
        forced_ok = forced_task != task_id and forced_reused is False
        self.record(
            "forced_guest_regeneration_creates_new_task",
            forced,
            forced_ok,
            "different task_id and reused=false when force=true",
            {"different_task_id": forced_task != task_id, "reused": forced_reused},
        )
        if not forced_ok:
            raise AuditFailure("forced guest summary regeneration reused stale work")
        self.wait_for_guest_task(forced_task, "forced_guest_summary")

        missing = self.http.request(
            "GET",
            self.url(
                self.meeting_base,
                f"/api/laoji/meetings/guest-summary/tasks/{uuid.uuid4().hex}",
            ),
        )
        self.record(
            "unknown_guest_task_is_not_disclosed",
            missing,
            missing.status == 404,
            "HTTP 404 for an unknown task id",
        )
        if missing.status != 404:
            raise AuditFailure("unknown guest summary task did not return 404")

    def seed_authenticated_transcript(self, meeting_id: str) -> None:
        if not self.account or not self.audio_file:
            raise AuditFailure("authenticated transcript seed requires an account and audio file")
        probe_script = Path(__file__).resolve().with_name("probe_realtime_asr_file.js")
        command = [
            "node",
            str(probe_script),
            "--base-url",
            self.meeting_base,
            "--route",
            "meeting",
            "--meeting-id",
            meeting_id,
            "--file",
            str(self.audio_file),
        ]
        environment = os.environ.copy()
        environment["NODE_USE_ENV_PROXY"] = "0"
        environment["LAOJI_ACCESS_TOKEN"] = str(self.account["token"])
        started = time.perf_counter()
        try:
            completed = subprocess.run(
                command,
                cwd=Path(__file__).resolve().parents[1],
                env=environment,
                capture_output=True,
                text=True,
                timeout=self.poll_timeout_seconds,
                check=False,
            )
        except (OSError, subprocess.TimeoutExpired) as error:
            raise AuditFailure(f"authenticated realtime probe failed: {type(error).__name__}") from error
        latency_ms = round((time.perf_counter() - started) * 1000, 1)
        if completed.returncode != 0:
            detail = completed.stderr.strip().splitlines()[-1][:240] if completed.stderr.strip() else "no detail"
            raise AuditFailure(f"authenticated realtime probe exited {completed.returncode}: {detail}")
        try:
            report = json.loads(completed.stdout.strip().splitlines()[-1])
        except (IndexError, json.JSONDecodeError) as error:
            raise AuditFailure("authenticated realtime probe returned invalid JSON") from error
        transcripts = report.get("transcripts") if isinstance(report, dict) else None
        passed = (
            isinstance(report, dict)
            and report.get("session_mode") == "authenticated"
            and isinstance(transcripts, list)
            and any(isinstance(item, dict) and str(item.get("text", "")).strip() for item in transcripts)
        )
        synthetic = HttpResult(200 if passed else 500, None, latency_ms)
        self.record(
            "authenticated_realtime_probe_produces_transcript",
            synthetic,
            passed,
            "authenticated WebSocket emits at least one non-empty completed transcript",
            {
                "transcript_count": len(transcripts) if isinstance(transcripts, list) else 0,
                "first_completed_ms": report.get("timing", {}).get("first_completed_ms") if isinstance(report, dict) else None,
            },
        )
        if not passed:
            raise AuditFailure("authenticated realtime probe produced no transcript")

        transcript_result = self.http.request(
            "GET",
            self.url(
                self.meeting_base,
                f"/api/laoji/meetings/{quote(meeting_id, safe='')}/transcripts?offset=0&limit=100",
            ),
            token=str(self.account["token"]),
        )
        items = transcript_result.data.get("items") if isinstance(transcript_result.data, dict) else None
        persisted = (
            transcript_result.status == 200
            and isinstance(items, list)
            and any(isinstance(item, dict) and str(item.get("text", "")).strip() for item in items)
        )
        self.record(
            "authenticated_realtime_transcript_is_persisted",
            transcript_result,
            persisted,
            "GET transcripts returns the completed WebSocket transcript",
            {"transcript_count": len(items) if isinstance(items, list) else 0},
        )
        if not persisted:
            raise AuditFailure("authenticated realtime transcript was not persisted")

    def submit_authenticated_summary(self, meeting_id: str, *, force: bool, name: str) -> HttpResult:
        if not self.account:
            raise AuditFailure("temporary account is missing")
        result = self.http.request(
            "POST",
            self.url(
                self.meeting_base,
                f"/api/laoji/meetings/{quote(meeting_id, safe='')}/summaries/generate"
                f"?summary_type=final&force={'true' if force else 'false'}",
            ),
            token=str(self.account["token"]),
        )
        self.require_status(name, result, {200, 202})
        self.task_id(result, name)
        return result

    def wait_for_authenticated_task(self, meeting_id: str, task_id: str, label: str) -> HttpResult:
        if not self.account:
            raise AuditFailure("temporary account is missing")
        deadline = time.monotonic() + self.poll_timeout_seconds
        attempts = 0
        while time.monotonic() <= deadline:
            attempts += 1
            result = self.http.request(
                "GET",
                self.url(
                    self.meeting_base,
                    f"/api/laoji/meetings/{quote(meeting_id, safe='')}/summaries/task/"
                    f"{quote(task_id, safe='')}?wait_ms=5000",
                ),
                token=str(self.account["token"]),
            )
            self.require_status(f"poll_{label}_{attempts}", result, {200})
            status = result.data.get("status") if isinstance(result.data, dict) else None
            if status == "SUCCESS":
                self.record(
                    f"{label}_reaches_success",
                    result,
                    True,
                    "status=SUCCESS before timeout",
                    {"attempts": attempts},
                )
                return result
            if status == "FAILURE":
                self.record(f"{label}_reaches_success", result, False, "status=SUCCESS before timeout")
                raise AuditFailure(f"{label} returned FAILURE")
            if status not in {"PENDING", "STARTED", "GENERATING"}:
                raise AuditFailure(f"authenticated summary task returned unknown status: {status!r}")
            if not (isinstance(result.data, dict) and result.data.get("long_poll_supported") is True):
                time.sleep(1.0)
        raise AuditFailure(f"{label} did not finish before the audit timeout")

    def fetch_authenticated_summary(self, meeting_id: str, name: str) -> HttpResult:
        if not self.account:
            raise AuditFailure("temporary account is missing")
        result = self.http.request(
            "GET",
            self.url(
                self.meeting_base,
                f"/api/laoji/meetings/{quote(meeting_id, safe='')}/summaries/final",
            ),
            token=str(self.account["token"]),
        )
        has_content = result.status == 200 and self.has_summary_text(result.data)
        self.record(
            name,
            result,
            has_content,
            "HTTP 200 with durable non-empty final summary content",
            {"has_summary_text": has_content},
        )
        if not has_content:
            raise AuditFailure("authenticated final summary was not persisted")
        return result

    def verify_authenticated_summary_lifecycle(self, meeting_id: str) -> None:
        first = self.submit_authenticated_summary(
            meeting_id,
            force=False,
            name="submit_authenticated_summary_first",
        )
        duplicate = self.submit_authenticated_summary(
            meeting_id,
            force=False,
            name="submit_authenticated_summary_duplicate",
        )
        first_task = self.task_id(first, "submit_authenticated_summary_first")
        duplicate_task = self.task_id(duplicate, "submit_authenticated_summary_duplicate")
        duplicate_reused = duplicate.data.get("reused") if isinstance(duplicate.data, dict) else None
        duplicate_ok = first_task == duplicate_task and duplicate_reused is True
        self.record(
            "duplicate_authenticated_submission_reuses_task",
            duplicate,
            duplicate_ok,
            "same task_id and duplicate reused=true",
            {"same_task_id": first_task == duplicate_task, "reused": duplicate_reused},
        )
        if not duplicate_ok:
            raise AuditFailure("duplicate authenticated summary submission was not reused")
        self.wait_for_authenticated_task(meeting_id, first_task, "authenticated_summary")
        self.fetch_authenticated_summary(meeting_id, "authenticated_final_summary_is_persisted")

        replay = self.submit_authenticated_summary(
            meeting_id,
            force=False,
            name="submit_authenticated_summary_after_success",
        )
        replay_task = self.task_id(replay, "submit_authenticated_summary_after_success")
        replay_reused = replay.data.get("reused") if isinstance(replay.data, dict) else None
        replay_ok = replay_task == first_task and replay_reused is True
        self.record(
            "successful_authenticated_submission_replays_task",
            replay,
            replay_ok,
            "same task_id and reused=true within the replay window",
            {"same_task_id": replay_task == first_task, "reused": replay_reused},
        )
        if not replay_ok:
            raise AuditFailure("successful authenticated summary was not replayed")

        forced = self.submit_authenticated_summary(
            meeting_id,
            force=True,
            name="submit_authenticated_summary_forced",
        )
        forced_task = self.task_id(forced, "submit_authenticated_summary_forced")
        forced_reused = forced.data.get("reused") if isinstance(forced.data, dict) else None
        forced_ok = forced_task != first_task and forced_reused is False
        self.record(
            "forced_authenticated_regeneration_creates_new_task",
            forced,
            forced_ok,
            "different task_id and reused=false when force=true",
            {"different_task_id": forced_task != first_task, "reused": forced_reused},
        )
        if not forced_ok:
            raise AuditFailure("forced authenticated summary regeneration reused stale work")
        self.wait_for_authenticated_task(meeting_id, forced_task, "forced_authenticated_summary")
        self.fetch_authenticated_summary(meeting_id, "forced_authenticated_summary_is_persisted")

    def run(self) -> dict[str, Any]:
        started = time.time()
        fatal_error: str | None = None
        try:
            guest_task_id = self.submit_guest_summary_twice()
            self.guest_task_status(guest_task_id, "poll_guest_summary_before_pause", wait_ms=0)
            self.register_account()
            meeting_id = self.create_owned_meeting()
            self.verify_guest_task_not_readable_as_account(meeting_id, guest_task_id)
            resumed = self.wait_for_guest_task(guest_task_id, "resumed_guest_summary")
            self.record(
                "guest_polling_resumes_after_client_pause",
                resumed,
                True,
                "the original task remains readable and reaches SUCCESS after polling pauses",
            )
            guest_meeting_id = f"audit-guest-{self.run_id}"
            self.verify_guest_lifecycle_after_completion(guest_meeting_id, guest_task_id)
            if self.audio_file:
                self.seed_authenticated_transcript(meeting_id)
                self.verify_authenticated_summary_lifecycle(meeting_id)
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
    parser.add_argument(
        "--audio-file",
        type=Path,
        help="optional speech file used to exercise authenticated realtime transcription and summary persistence",
    )
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
    if args.audio_file:
        args.audio_file = args.audio_file.expanduser().resolve()
        if not args.audio_file.is_file():
            parser.error("--audio-file must be an existing file")
    return args


def main() -> int:
    args = parse_args()
    report = SummaryTaskLifecycleAudit(
        args.auth_base,
        args.meeting_base,
        args.timeout_seconds,
        args.poll_timeout_seconds,
        audio_file=args.audio_file,
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
