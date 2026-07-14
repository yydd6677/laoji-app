import importlib.util
from datetime import date
import pathlib
import sys
import unittest


SCRIPTS_DIR = pathlib.Path(__file__).resolve().parents[1]
SCRIPT = SCRIPTS_DIR / "run_schedule_review_samples.py"
SPEC = importlib.util.spec_from_file_location("run_schedule_review_samples", SCRIPT)
MODULE = importlib.util.module_from_spec(SPEC)
assert SPEC and SPEC.loader
sys.modules[SPEC.name] = MODULE
SPEC.loader.exec_module(MODULE)


class ScheduleReviewSamplesTest(unittest.TestCase):
    def test_strict_gate_rejects_quality_latency_wall_and_route_regressions(self):
        report = {
            "rows_with_issues": 2,
            "elapsed_ms": 1900,
            "duration_ms": {"p95": 1250, "max": 1450},
            "rows": [
                {"parse_source": "local_llm"},
                {"parse_source": "rules"},
            ],
        }

        self.assertEqual(
            MODULE.schedule_gate_issues(
                report,
                max_rows_with_issues=0,
                max_case_ms=1400,
                max_p95_ms=1200,
                max_elapsed_ms=1800,
                required_parse_sources={"local_llm"},
            ),
            [
                "rows_with_issues:2>0",
                "max_case_ms:1450>1400",
                "p95_ms:1250>1200",
                "elapsed_ms:1900>1800",
                "unexpected_parse_sources:rules",
            ],
        )

    def test_strict_gate_accepts_a_clean_report_at_the_budget_boundaries(self):
        report = {
            "rows_with_issues": 0,
            "elapsed_ms": 1800,
            "duration_ms": {"p95": 1200, "max": 1400},
            "rows": [{"parse_source": "local_llm"}],
        }

        self.assertEqual(
            MODULE.schedule_gate_issues(
                report,
                max_rows_with_issues=0,
                max_case_ms=1400,
                max_p95_ms=1200,
                max_elapsed_ms=1800,
                required_parse_sources={"local_llm"},
            ),
            [],
        )

    def test_select_sample_ids_preserves_input_order_and_rejects_unknown_ids(self):
        rows = [{"id": "0002"}, {"id": "0001"}, {"id": "0003"}]

        self.assertEqual(
            [row["id"] for row in MODULE.select_sample_ids(rows, ["0003", "0001"])],
            ["0001", "0003"],
        )
        with self.assertRaisesRegex(ValueError, "unknown sample ids: 9999"):
            MODULE.select_sample_ids(rows, ["9999"])

    def test_any_parsed_negative_control_is_a_false_positive(self):
        sample = {
            "id": "NEG-1",
            "group": "negative_or_control",
            "category_hint": "other",
            "text": "明天这个词出现了，但不是让我安排明天。",
        }
        parsed = {
            "title": "相关说明",
            "event_type": "once",
            "start_date": "2026-07-15",
            "start_time": None,
            "end_time": None,
            "is_all_day": True,
            "category": "其他",
            "reminder_minutes": None,
            "needs_clarification": True,
            "parse_source": "local_llm",
        }

        issues, _ = MODULE.issue_flags(sample, parsed, None, 100)

        self.assertIn("negative_false_positive", issues)

    def test_rejected_negative_control_is_accepted(self):
        sample = {
            "id": "NEG-2",
            "group": "negative_or_control",
            "category_hint": "other",
            "text": "只是测试，不要创建日程。",
        }

        issues, review = MODULE.issue_flags(
            sample,
            None,
            'HTTP 422: {"detail":"无法提取日程"}',
            50,
        )

        self.assertEqual(issues, [])
        self.assertEqual(review, [])

    def test_ambiguous_sample_requires_clarification_only_when_date_is_missing(self):
        self.assertTrue(MODULE.ambiguous_requires_clarification("上午九点复诊，日期还没想好。"))
        self.assertTrue(MODULE.ambiguous_requires_clarification("合同审批这个事别忘了，先当待办。"))
        self.assertFalse(MODULE.ambiguous_requires_clarification("明天有个需求评审，具体几点还没定。"))
        self.assertFalse(MODULE.ambiguous_requires_clarification("下周五提交材料，时间我晚点补。"))

    def test_dated_ambiguous_event_accepts_missing_clock_without_clarification(self):
        sample = {
            "id": "AMB-DATED",
            "group": "ambiguous",
            "category_hint": "work",
            "text": "明天有个需求评审，具体几点还没定，先记一下。",
        }
        parsed = {
            "title": "需求评审",
            "event_type": "once",
            "start_date": "2026-07-15",
            "start_time": None,
            "end_time": None,
            "is_all_day": True,
            "category": "工作",
            "reminder_minutes": None,
            "needs_clarification": False,
            "parse_source": "local_llm",
        }

        issues, _ = MODULE.issue_flags(sample, parsed, None, 100)

        self.assertNotIn("missing_date_without_clarification", issues)
        self.assertNotIn("optional_time_forced_clarification", issues)

    def test_missing_date_and_optional_time_fail_in_opposite_directions(self):
        missing_date = {
            "id": "AMB-MISSING-DATE",
            "group": "ambiguous",
            "category_hint": "health",
            "text": "上午九点复诊，日期还没想好。",
        }
        dated = {
            "id": "AMB-OPTIONAL-TIME",
            "group": "ambiguous",
            "category_hint": "finance",
            "text": "明天有个还贷款，具体几点还没定。",
        }
        base = {
            "title": "待办",
            "event_type": "once",
            "start_date": "2026-07-15",
            "start_time": None,
            "end_time": None,
            "is_all_day": True,
            "reminder_minutes": None,
            "parse_source": "local_llm",
        }

        missing_issues, _ = MODULE.issue_flags(
            missing_date,
            {**base, "category": "健康", "needs_clarification": False},
            None,
            100,
        )
        dated_issues, _ = MODULE.issue_flags(
            dated,
            {**base, "category": "财务", "needs_clarification": True},
            None,
            100,
        )

        self.assertIn("missing_date_without_clarification", missing_issues)
        self.assertIn("optional_time_forced_clarification", dated_issues)

    def test_non_recurring_and_hallucinated_clock_are_hard_failures(self):
        sample = {
            "id": "SEMANTIC-1",
            "group": "date_range",
            "category_hint": "important",
            "text": "报名截止要在下周三到7月18号之间处理，提前两小时提醒。",
        }
        parsed = {
            "title": "报名截止",
            "event_type": "monthly",
            "start_date": "2026-07-22",
            "end_date": None,
            "start_time": "02:34",
            "end_time": "03:34",
            "is_all_day": False,
            "category": "重要",
            "reminder_minutes": 120,
            "needs_clarification": True,
            "parse_source": "local_llm",
        }

        issues, _ = MODULE.issue_flags(sample, parsed, None, 100)

        self.assertIn("non_recurring_as_recurrence", issues)
        self.assertIn("unexpected_time_without_clock", issues)

    def test_explicit_clock_must_not_disappear(self):
        sample = {
            "id": "SEMANTIC-2",
            "group": "deadline",
            "category_hint": "work",
            "text": "下周五下午三点前提交材料。",
        }
        parsed = {
            "title": "提交材料",
            "event_type": "once",
            "start_date": "2026-07-24",
            "end_date": None,
            "start_time": None,
            "end_time": None,
            "is_all_day": True,
            "category": "工作",
            "reminder_minutes": None,
            "needs_clarification": False,
            "parse_source": "local_llm",
        }

        issues, _ = MODULE.issue_flags(sample, parsed, None, 100)

        self.assertIn("explicit_time_missing", issues)

    def test_only_real_date_range_or_location_uncertainty_supports_clarification(self):
        self.assertTrue(MODULE.clarification_is_supported(
            "7月21号到7月20号提交材料",
            {"end_date": None},
        ))
        self.assertTrue(MODULE.clarification_is_supported(
            "本月25号到7月20号提交材料",
            {"end_date": None},
        ))
        self.assertTrue(MODULE.clarification_is_supported(
            "明天下午三点开会，地点还可能变",
            {"end_date": None},
        ))
        self.assertFalse(MODULE.clarification_is_supported(
            "明天下午三点开会，带上座位号",
            {"end_date": None},
        ))

    def test_placeholder_location_and_stale_question_are_hard_failures(self):
        sample = {
            "id": "SEMANTIC-3",
            "group": "explicit_single",
            "category_hint": "work",
            "text": "明天下午三点开会。",
        }
        parsed = {
            "title": "开会",
            "event_type": "once",
            "start_date": "2026-07-15",
            "end_date": None,
            "start_time": "15:00",
            "end_time": "16:00",
            "is_all_day": False,
            "category": "工作",
            "location": "未指定",
            "reminder_minutes": 15,
            "needs_clarification": False,
            "clarification_question": "是否需要提前提醒？",
            "parse_source": "local_llm",
        }

        issues, _ = MODULE.issue_flags(sample, parsed, None, 100)

        self.assertIn("placeholder_location", issues)
        self.assertIn("clarification_state_inconsistent", issues)

    def test_same_day_range_is_a_valid_single_day_event(self):
        self.assertTrue(MODULE.same_day_range("7月18日到7月18号整理材料"))
        self.assertTrue(MODULE.same_day_range("明天到明天持续复习"))
        self.assertFalse(MODULE.same_day_range("7月18日到7月19号整理材料"))

    def test_noise_containing_bare_bottom_does_not_count_as_month_end(self):
        text = "老记老记月先这样底10:20同事送别饭"

        self.assertTrue(MODULE.ambiguous_requires_clarification(text))
        self.assertTrue(MODULE.clarification_is_supported(
            text,
            {"clarification_question": "没有听到具体日期，需要补充日期。"},
        ))

    def test_broken_range_question_is_supported_even_when_one_token_is_corrupt(self):
        text = "7月21号到7可能月18号完成公开课直播"

        self.assertTrue(MODULE.clarification_is_supported(
            text,
            {
                "end_date": None,
                "clarification_question": "起始日期的先后顺序有矛盾，需要确认正确的开始日期和结束日期。",
            },
        ))

    def test_expected_single_date_handles_relative_corrections_and_sparse_digits(self):
        today = date(2026, 7, 14)

        self.assertEqual(MODULE.expected_single_date("明天下午三点开会", today), "2026-07-15")
        self.assertEqual(MODULE.expected_single_date("不是今天，是这周六开会", today), "2026-07-18")
        self.assertEqual(MODULE.expected_single_date("不呃是今天，是下周二开会", today), "2026-07-21")
        self.assertEqual(MODULE.expected_single_date("7月1 就是 5号提交材料", today), "2026-07-15")
        self.assertEqual(MODULE.expected_single_date("8，额，月2号复诊", today), "2026-08-02")
        self.assertEqual(MODULE.expected_single_date("下月底整理资料", today), "2026-08-31")
        self.assertIsNone(MODULE.expected_single_date("日期还没想好", today))


if __name__ == "__main__":
    unittest.main()
