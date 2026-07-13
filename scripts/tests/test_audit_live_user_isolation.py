import argparse
import importlib.util
import pathlib
import sys
import unittest


SCRIPT = pathlib.Path(__file__).resolve().parents[1] / "audit_live_user_isolation.py"
SPEC = importlib.util.spec_from_file_location("audit_live_user_isolation", SCRIPT)
MODULE = importlib.util.module_from_spec(SPEC)
assert SPEC and SPEC.loader
sys.modules[SPEC.name] = MODULE
SPEC.loader.exec_module(MODULE)


class LiveIsolationAuditHelpersTest(unittest.TestCase):
    def test_base_url_validation_normalizes_trailing_slash(self):
        self.assertEqual(MODULE.validate_base_url("https://api.example.com/root/"), "https://api.example.com/root")

    def test_base_url_validation_rejects_credentials_and_query(self):
        for value in ("ftp://api.example.com", "https://user:pass@example.com", "https://example.com?a=1"):
            with self.subTest(value=value), self.assertRaises(argparse.ArgumentTypeError):
                MODULE.validate_base_url(value)

    def test_redact_removes_nested_credentials(self):
        value = {
            "account": "secret@example.com",
            "nested": [{"access_token": "secret-token", "events_deleted": 1}],
        }
        self.assertEqual(
            MODULE.redact(value),
            {"account": "[redacted]", "nested": [{"access_token": "[redacted]", "events_deleted": 1}]},
        )

    def test_response_items_accepts_supported_envelopes(self):
        self.assertEqual(MODULE.response_items([{"id": 1}]), [{"id": 1}])
        self.assertEqual(MODULE.response_items({"items": [{"id": 2}]}), [{"id": 2}])
        self.assertEqual(MODULE.response_items({"events": [{"id": 3}]}), [{"id": 3}])
        self.assertEqual(MODULE.response_items({"items": "invalid"}), [])

    def test_subject_identifier_is_stable_but_not_the_account(self):
        first = MODULE.stable_subject_id("audit@example.com")
        self.assertEqual(first, MODULE.stable_subject_id("audit@example.com"))
        self.assertEqual(len(first), 12)
        self.assertNotIn("audit", first)

    def test_idempotency_payloads_are_stable_and_keys_are_user_reusable(self):
        audit = MODULE.IsolationAudit("https://auth.example.com", "https://meeting.example.com", 1)
        self.assertFalse(audit.http.respect_environment_proxy)
        self.assertEqual(audit.event_payload("A"), audit.event_payload("A"))
        self.assertEqual(audit.meeting_payload("A"), audit.meeting_payload("A"))
        self.assertEqual(audit.event_payload("A")["client_request_id"], audit.event_payload("B")["client_request_id"])
        self.assertEqual(audit.meeting_payload("A")["client_request_id"], audit.meeting_payload("B")["client_request_id"])
        self.assertNotEqual(audit.event_payload("A")["title"], audit.event_payload("B")["title"])

    def test_environment_proxy_must_be_explicitly_enabled(self):
        audit = MODULE.IsolationAudit(
            "https://auth.example.com",
            "https://meeting.example.com",
            1,
            respect_environment_proxy=True,
        )
        self.assertTrue(audit.http.respect_environment_proxy)


if __name__ == "__main__":
    unittest.main()
