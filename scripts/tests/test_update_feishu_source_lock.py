import importlib.util
import json
import os
import tempfile
import unittest
from pathlib import Path
from unittest import mock


SCRIPT = Path(__file__).resolve().parents[1] / "update_feishu_source_lock.py"
SPEC = importlib.util.spec_from_file_location("update_feishu_source_lock", SCRIPT)
assert SPEC and SPEC.loader
LOCK = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(LOCK)


class FeishuSourceLockTest(unittest.TestCase):
    def test_source_root_uses_environment_without_platform_shell_syntax(self):
        with tempfile.TemporaryDirectory() as temp:
            expected = Path(temp).resolve()
            with mock.patch.dict(os.environ, {"FEISHU_SOURCE_ROOT": temp}):
                self.assertEqual(expected, LOCK.resolve_source_root(None))

    def test_lock_is_deterministic_and_preserves_overrides(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            source = root / "source"
            (source / "java").mkdir(parents=True)
            (source / "java/A.java").write_text("class A {}\n", encoding="utf-8")
            catalog = root / "catalog.json"
            catalog.write_text(json.dumps({
                "schema_version": 1,
                "baseline_id": "feishu-android-7.71.8",
                "groups": [{"id": "ui", "paths": ["java/A.java"]}],
                "id_overrides": {"java/A.java": "stable-a"},
                "absent": [{"path": "anim/missing.xml", "reason": "fixture"}],
            }), encoding="utf-8")
            first = LOCK.build_lock(catalog, source)
            second = LOCK.build_lock(catalog, source)
            self.assertEqual(first, second)
            self.assertEqual("stable-a", first["files"][0]["id"])
            self.assertEqual(1, len(first["absent"]))

    def test_missing_and_duplicate_sources_are_rejected(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            source = root / "source"
            source.mkdir()
            catalog = root / "catalog.json"
            catalog.write_text(json.dumps({
                "schema_version": 1,
                "baseline_id": "feishu-android-7.71.8",
                "groups": [{"id": "ui", "paths": ["missing.java", "missing.java"]}],
            }), encoding="utf-8")
            with self.assertRaises(ValueError):
                LOCK.build_lock(catalog, source)


if __name__ == "__main__":
    unittest.main()
