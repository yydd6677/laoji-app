import importlib.util
import pathlib
import sys
import unittest
from unittest import mock


SCRIPTS_DIR = pathlib.Path(__file__).resolve().parents[1]
SCRIPT = SCRIPTS_DIR / "run_meeting_summary_quality.py"
SPEC = importlib.util.spec_from_file_location("run_meeting_summary_quality", SCRIPT)
MODULE = importlib.util.module_from_spec(SPEC)
assert SPEC and SPEC.loader
sys.modules[SPEC.name] = MODULE
SPEC.loader.exec_module(MODULE)


class MeetingSummaryQualityTest(unittest.TestCase):
    def test_transcript_length_gate_counts_generated_lines(self):
        case = {
            "id": "MS-LENGTH",
            "title": "超长会议",
            "generated_context": {
                "count": 3,
                "speaker_template": "成员{index}",
                "text_template": "第{index}轮状态同步没有形成新结论。",
            },
            "transcript": [{"speaker": "主持人", "text": "最终决定继续。"}],
        }

        count = MODULE.transcript_char_count(case)

        self.assertEqual(count, sum(len(line["text"]) for line in MODULE.build_lines(case)))
        self.assertEqual(MODULE.cases_below_minimum_chars([case], count), [])
        self.assertEqual(
            MODULE.cases_below_minimum_chars([case], count + 1),
            [("MS-LENGTH", count)],
        )

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

    def test_force_requests_a_fresh_public_summary_task(self):
        case = {
            "id": "MS-FORCE",
            "title": "强制重算",
            "transcript": [{"speaker": "主持人", "text": "最终决定继续。"}],
            "expect": {},
        }
        with mock.patch.object(MODULE, "request_json", side_effect=[
            {"task_id": "task-new"},
            {"status": "SUCCESS", "result": {"overview": "继续", "key_decisions": [], "action_items": []}},
        ]) as request_json:
            result = MODULE.run_case(
                "https://meeting.example.com",
                case,
                "2026-07-13",
                timeout=1,
                poll_interval=0,
                wait_ms=5000,
                force=True,
            )

        self.assertTrue(result["passed"])
        self.assertTrue(request_json.call_args_list[0].kwargs["payload"]["force"])
        self.assertTrue(request_json.call_args_list[1].args[0].endswith("?wait_ms=0"))

    def test_require_fresh_rejects_a_replayed_task(self):
        case = {
            "id": "MS-REPLAY",
            "title": "缓存重放检测",
            "transcript": [{"speaker": "主持人", "text": "最终决定继续。"}],
            "expect": {},
        }
        with mock.patch.object(MODULE, "request_json", side_effect=[
            {"task_id": "task-old", "reused": True},
            {"status": "SUCCESS", "result": {"overview": "继续", "key_decisions": [], "action_items": []}},
        ]):
            result = MODULE.run_case(
                "https://meeting.example.com",
                case,
                "2026-07-13",
                timeout=1,
                poll_interval=0,
                force=True,
                require_fresh=True,
            )

        self.assertFalse(result["passed"])
        self.assertIn("task_reused", result["issues"])

    def test_records_queue_and_running_state_transitions(self):
        case = {
            "id": "MS-STATES",
            "title": "任务状态",
            "transcript": [{"speaker": "主持人", "text": "最终决定继续。"}],
            "expect": {},
        }
        with mock.patch.object(MODULE, "request_json", side_effect=[
            {"task_id": "task-new", "reused": False},
            {"status": "PENDING", "result": None},
            {"status": "STARTED", "result": None},
            {"status": "SUCCESS", "result": {"overview": "继续", "key_decisions": [], "action_items": []}},
        ]):
            result = MODULE.run_case(
                "https://meeting.example.com",
                case,
                "2026-07-13",
                timeout=1,
                poll_interval=0,
                force=True,
                run_label="run-1",
                require_fresh=True,
            )

        self.assertTrue(result["passed"])
        self.assertEqual(result["observed_states"], ["PENDING", "STARTED", "SUCCESS"])
        self.assertEqual(result["poll_requests"], 3)
        self.assertIsNotNone(result["first_started_ms"])
        self.assertTrue(result["meeting_id"].endswith("run-1"))

    def test_long_poll_support_skips_the_legacy_poll_delay(self):
        case = {
            "id": "MS-LONG-POLL",
            "title": "长轮询",
            "transcript": [{"speaker": "主持人", "text": "最终决定继续。"}],
            "expect": {},
        }
        with mock.patch.object(MODULE, "request_json", side_effect=[
            {"task_id": "task-new", "reused": False},
            {"status": "STARTED", "result": None, "long_poll_supported": True},
            {
                "status": "SUCCESS",
                "result": {"overview": "继续", "key_decisions": [], "action_items": []},
                "long_poll_supported": True,
            },
        ]), mock.patch.object(MODULE.time, "sleep") as sleep:
            result = MODULE.run_case(
                "https://meeting.example.com",
                case,
                "2026-07-13",
                timeout=1,
                poll_interval=0.25,
                wait_ms=5000,
                force=True,
            )

        self.assertTrue(result["passed"])
        self.assertEqual(result["poll_requests"], 2)
        sleep.assert_not_called()

    def test_percentile_interpolates_without_mutating_input(self):
        values = [40, 10, 30, 20]

        self.assertEqual(MODULE.percentile(values, 0.5), 25)
        self.assertEqual(MODULE.percentile(values, 0.95), 38.5)
        self.assertEqual(values, [40, 10, 30, 20])


if __name__ == "__main__":
    unittest.main()
