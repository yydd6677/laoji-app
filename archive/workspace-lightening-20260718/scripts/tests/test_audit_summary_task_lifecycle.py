from __future__ import annotations

import importlib.util
import sys
import unittest
from pathlib import Path
from typing import Any
from urllib.parse import urlsplit


SCRIPTS_DIR = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(SCRIPTS_DIR))
SPEC = importlib.util.spec_from_file_location(
    "audit_summary_task_lifecycle",
    SCRIPTS_DIR / "audit_summary_task_lifecycle.py",
)
assert SPEC and SPEC.loader
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


class FakeHttp:
    respect_environment_proxy = False

    def __init__(self, *, reused: bool = True) -> None:
        self.reused = reused
        self.poll_count = 0
        self.task_polls: dict[str, int] = {}
        self.guest_tasks: dict[str, str] = {}
        self.task_sequence = 0
        self.deleted = False

    def request(
        self,
        method: str,
        url: str,
        *,
        token: str | None = None,
        body: dict[str, Any] | None = None,
    ) -> Any:
        path = urlsplit(url).path
        result = MODULE.HttpResult
        if method == "POST" and path.endswith("/guest-summary"):
            assert body is not None
            changed = len(body.get("transcript_lines", [])) > 2
            force = body.get("force") is True
            key = "changed" if changed else "original"
            existing = self.guest_tasks.get(key)
            if existing and not force and self.reused:
                return result(202, {"task_id": existing, "reused": True}, 1.0)
            self.task_sequence += 1
            task_id = f"task-{self.task_sequence}"
            if not force:
                self.guest_tasks[key] = task_id
            return result(202, {"task_id": task_id, "reused": False}, 1.0)
        if method == "POST" and path.endswith("/api/auth/register"):
            return result(201, {"access_token": "secret-token"}, 1.0)
        if method == "POST" and path.endswith("/api/laoji/meetings"):
            return result(201, {"id": "meeting-1"}, 1.0)
        if method == "GET" and "/summaries/task/" in path:
            return result(404, {"detail": "not found"}, 1.0)
        if method == "GET" and "/guest-summary/tasks/" in path:
            task_id = path.rsplit("/", 1)[-1]
            if task_id not in {f"task-{index}" for index in range(1, self.task_sequence + 1)}:
                return result(404, {"detail": "not found"}, 1.0)
            self.poll_count += 1
            task_polls = self.task_polls.get(task_id, 0) + 1
            self.task_polls[task_id] = task_polls
            status = "PENDING" if task_polls == 1 else "SUCCESS"
            return result(200, {
                "status": status,
                "result": {"overview": "审计总结"},
                "long_poll_supported": True,
            }, 1.0)
        if method == "DELETE" and path.endswith("/api/auth/me"):
            self.deleted = True
            return result(200, {"deleted": True}, 1.0)
        raise AssertionError(f"unexpected request: {method} {path} token={bool(token)} body={bool(body)}")


class SummaryTaskLifecycleAuditTests(unittest.TestCase):
    def test_passes_reuse_scope_completion_and_cleanup_contract(self) -> None:
        http = FakeHttp()
        audit = MODULE.SummaryTaskLifecycleAudit(
            "https://auth.example.com",
            "https://meeting.example.com",
            5,
            5,
            http=http,
        )
        report = audit.run()

        self.assertTrue(report["summary"]["passed"])
        self.assertTrue(report["summary"]["cleanup_passed"])
        self.assertTrue(http.deleted)
        self.assertGreaterEqual(http.poll_count, 6)

    def test_fails_when_duplicate_submission_creates_a_new_task_without_inventing_cleanup_failure(self) -> None:
        http = FakeHttp(reused=False)
        audit = MODULE.SummaryTaskLifecycleAudit(
            "https://auth.example.com",
            "https://meeting.example.com",
            5,
            5,
            http=http,
        )
        report = audit.run()

        self.assertFalse(report["summary"]["passed"])
        self.assertTrue(report["summary"]["cleanup_passed"])
        self.assertFalse(http.deleted)
        self.assertIn("safely reused", report["summary"]["fatal_error"])


if __name__ == "__main__":
    unittest.main()
