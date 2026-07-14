import importlib.util
import pathlib
import sys
import unittest


SCRIPTS_DIR = pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0, str(SCRIPTS_DIR))
SCRIPT = SCRIPTS_DIR / "benchmark_schedule_llm.py"
SPEC = importlib.util.spec_from_file_location("benchmark_schedule_llm", SCRIPT)
MODULE = importlib.util.module_from_spec(SPEC)
assert SPEC and SPEC.loader
sys.modules[SPEC.name] = MODULE
SPEC.loader.exec_module(MODULE)


class ScheduleLlmBenchmarkTest(unittest.TestCase):
    def test_extracts_plain_fenced_and_embedded_json(self):
        expected = {"title": "开会"}

        self.assertEqual(MODULE.extract_json('{"title":"开会"}'), expected)
        self.assertEqual(MODULE.extract_json('```json\n{"title":"开会"}\n```'), expected)
        self.assertEqual(MODULE.extract_json('结果：{"title":"开会"}。'), expected)
        self.assertIsNone(MODULE.extract_json("null"))

    def test_payload_only_adds_the_requested_format(self):
        common = {
            "model": "qwen3:8b",
            "prompt": "prompt",
            "text": "text",
            "num_ctx": 8192,
            "max_tokens": 256,
            "keep_alive": "15m",
        }

        plain = MODULE.build_payload(**common, format_mode="none")
        structured = MODULE.build_payload(**common, format_mode="json")
        schema = MODULE.build_payload(**common, format_mode="schema")

        self.assertNotIn("format", plain)
        self.assertEqual(structured["format"], "json")
        self.assertEqual(schema["format"], MODULE.schedule_schema())
        self.assertFalse(plain["think"])
        self.assertEqual(plain["options"]["num_predict"], 256)

    def test_shape_validation_rejects_missing_or_invalid_fields(self):
        valid = {
            "title": "开会",
            "event_type": "once",
            "start_date": "2026-07-15",
            "end_date": None,
            "color": None,
            "spanning": False,
            "start_time": "15:00",
            "end_time": "16:00",
            "is_all_day": False,
            "description": None,
            "location": None,
            "category": "工作",
            "detail": None,
            "status": None,
            "reminder_minutes": 15,
            "confidence": 0.9,
            "needs_clarification": False,
            "clarification_question": None,
        }

        self.assertEqual(MODULE.shape_issues(valid), [])
        self.assertEqual(MODULE.shape_issues(None), [])
        self.assertIn("invalid_category", MODULE.shape_issues({**valid, "category": "娱乐"}))
        self.assertTrue(MODULE.shape_issues({"title": "开会"})[0].startswith("missing_fields:"))

        compact = {
            key: valid[key]
            for key in ("title", "event_type", "start_date", "category", "needs_clarification")
        }
        self.assertEqual(MODULE.shape_issues(compact, "compact"), [])
        self.assertTrue(MODULE.shape_issues(compact, "full")[0].startswith("missing_fields:"))


if __name__ == "__main__":
    unittest.main()
