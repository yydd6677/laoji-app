import importlib.util
import pathlib
import sys
import unittest


SCRIPTS_DIR = pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0, str(SCRIPTS_DIR))
SCRIPT = SCRIPTS_DIR / "run_compact_meeting_summary_experiment.py"
SPEC = importlib.util.spec_from_file_location("run_compact_meeting_summary_experiment", SCRIPT)
MODULE = importlib.util.module_from_spec(SPEC)
assert SPEC and SPEC.loader
sys.modules[SPEC.name] = MODULE
SPEC.loader.exec_module(MODULE)


class CompactMeetingSummaryExperimentTest(unittest.TestCase):
    def test_build_input_expands_generated_timeline_entries(self):
        case = {
            "title": "长会议",
            "timeline": [
                {
                    "generated": {
                        "count": 3,
                        "speaker_template": "成员{index}",
                        "text_template": "第{index}轮状态同步",
                    }
                },
                {"speaker": "主持人", "text": "最终决定保持现状。"},
            ],
        }

        result = MODULE.build_input(case, "2026-07-13")

        self.assertIn("成员1：第1轮状态同步", result)
        self.assertIn("成员3：第3轮状态同步", result)
        self.assertIn("主持人：最终决定保持现状。", result)
        self.assertIn("会议日期：2026-07-13", result)

    def test_extended_cases_require_explicit_inclusion(self):
        manifest = {
            "cases": [
                {"id": "CORE"},
                {"id": "LONG", "tier": "extended"},
            ]
        }

        self.assertEqual(
            [case["id"] for case in MODULE.select_cases(manifest, set(), False)],
            ["CORE"],
        )
        self.assertEqual(
            [case["id"] for case in MODULE.select_cases(manifest, set(), True)],
            ["CORE", "LONG"],
        )


if __name__ == "__main__":
    unittest.main()
