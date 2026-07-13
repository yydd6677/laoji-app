import importlib.util
import pathlib
import sys
import unittest


SCRIPTS_DIR = pathlib.Path(__file__).resolve().parents[1]
SCRIPT = SCRIPTS_DIR / "run_meeting_summary_quality.py"
SPEC = importlib.util.spec_from_file_location("run_meeting_summary_quality", SCRIPT)
MODULE = importlib.util.module_from_spec(SPEC)
assert SPEC and SPEC.loader
sys.modules[SPEC.name] = MODULE
SPEC.loader.exec_module(MODULE)


class MeetingSummaryQualityTest(unittest.TestCase):
    def test_rejects_overview_that_denies_nonempty_decisions(self):
        issues = MODULE.evaluate(
            {
                "overview": "会议未形成有效业务结论。",
                "key_decisions": ["8 月 1 日启用备份流程"],
                "action_items": [],
            },
            {},
        )

        self.assertIn("overview_contradicts_structured_outcomes", issues)

    def test_accepts_negative_overview_when_arrays_are_empty(self):
        issues = MODULE.evaluate(
            {
                "overview": "会议未形成明确决策或行动项。",
                "key_decisions": [],
                "action_items": [],
            },
            {},
        )

        self.assertNotIn("overview_contradicts_structured_outcomes", issues)

    def test_accepts_consistent_positive_overview(self):
        issues = MODULE.evaluate(
            {
                "overview": "会议确认 8 月 1 日启用备份流程。",
                "key_decisions": ["8 月 1 日启用备份流程"],
                "action_items": [],
            },
            {},
        )

        self.assertEqual(issues, [])


if __name__ == "__main__":
    unittest.main()
