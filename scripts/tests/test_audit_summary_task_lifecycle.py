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
            duplicate = getattr(self, "guest_submitted", False)
            self.guest_submitted = True
            task_id = "task-1" if self.reused or not duplicate else "task-2"
            return result(202, {"task_id": task_id, "reused": duplicate and self.reused}, 1.0)
        if method == "POST" and path.endswith("/api/auth/register"):
            return result(201, {"access_token": "secret-token"}, 1.0)
        if method == "POST" and path.endswith("/api/laoji/meetings"):
            return result(201, {"id": "meeting-1"}, 1.0)
        if method == "GET" and "/summaries/task/" in path:
            return result(404, {"detail": "not found"}, 1.0)
        if method == "GET" and "/guest-summary/tasks/" in path:
            self.poll_count += 1
            status = "PENDING" if self.poll_count == 1 else "SUCCESS"
            return result(200, {"status": status, "result": {}}, 1.0)
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
        self.assertEqual(http.poll_count, 2)

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
