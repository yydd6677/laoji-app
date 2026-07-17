import importlib.util
import json
import tempfile
import unittest
from pathlib import Path


SCRIPT_PATH = Path(__file__).resolve().parents[1] / "index_feishu_source.py"
SPEC = importlib.util.spec_from_file_location("index_feishu_source", SCRIPT_PATH)
assert SPEC and SPEC.loader
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


class IndexFeishuSourceTest(unittest.TestCase):
    def test_build_index_is_relative_and_resolves_resources(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            source = root / "java-sources" / "example"
            values = root / "decoded-resources" / "res" / "values"
            layout = root / "decoded-resources" / "res" / "layout"
            source.mkdir(parents=True)
            values.mkdir(parents=True)
            layout.mkdir(parents=True)
            (root / "ANALYSIS_SUMMARY.md").write_text("baseline\n", encoding="utf-8")
            (source / "ExampleActivity.java").write_text(
                "package example; import example.Helper; public class ExampleActivity { "
                "Helper helper = new Helper(); int value = R.string.title; int layout = R.layout.screen; }\n",
                encoding="utf-8",
            )
            (source / "Helper.java").write_text(
                "package example; public class Helper { void run() {} }\n",
                encoding="utf-8",
            )
            (values / "strings.xml").write_text(
                '<resources><string name="title">Title</string></resources>\n',
                encoding="utf-8",
            )
            (layout / "screen.xml").write_text("<FrameLayout />\n", encoding="utf-8")

            result = MODULE.build_index(root, {"example": ("java-sources/example",)})

            group = result["groups"]["example"]
            self.assertEqual(group["file_count"], 2)
            self.assertEqual(group["missing_roots"], [])
            activity = next(item for item in group["files"] if item["path"].endswith("ExampleActivity.java"))
            helper = next(item for item in group["files"] if item["path"].endswith("Helper.java"))
            self.assertEqual(activity["entry_candidates"], ["ExampleActivity"])
            self.assertEqual(activity["dependencies"], [helper["path"]])
            self.assertEqual(helper["referenced_by"], [activity["path"]])
            self.assertFalse(str(activity["path"]).startswith(str(root)))
            resources = {item["key"]: item for item in result["resources"]}
            self.assertEqual(
                resources["layout/screen"]["definitions"],
                ["decoded-resources/res/layout/screen.xml"],
            )
            self.assertEqual(
                resources["string/title"]["definitions"],
                ["decoded-resources/res/values/strings.xml"],
            )

    def test_output_shape_is_json_serializable(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            (root / "java-sources" / "empty").mkdir(parents=True)
            result = MODULE.build_index(root, {"empty": ("java-sources/empty",)})
            payload = json.dumps(result, sort_keys=True)
            self.assertIn('"schema_version": 2', payload)

    def test_smali_prefix_maps_jadx_relocated_ss_package(self):
        self.assertEqual(
            MODULE.smali_prefix("java-sources/com/p325ss/android/lark/calendar"),
            "com/ss/android/lark/calendar",
        )


if __name__ == "__main__":
    unittest.main()
