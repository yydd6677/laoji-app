import importlib.util
import os
import tempfile
import unittest
from pathlib import Path


SCRIPT = Path(__file__).resolve().parents[1] / "check_feishu_android_lint.py"
SPEC = importlib.util.spec_from_file_location("check_feishu_android_lint", SCRIPT)
assert SPEC and SPEC.loader
GATE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(GATE)


class FeishuAndroidLintReportTest(unittest.TestCase):
    def write_android_source(self, root: Path) -> Path:
        source = root / "modules/laoji-native-platform/android/src/main/java/example/Widget.kt"
        source.parent.mkdir(parents=True)
        source.write_text("class Widget\n", encoding="utf-8")
        return source

    def test_missing_or_malformed_report_is_rejected(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            with self.assertRaises(GATE.ReportError):
                GATE.parse_report(root / "missing.xml", root)
            malformed = root / "lint.xml"
            malformed.write_text("<not-issues />", encoding="utf-8")
            with self.assertRaises(GATE.ReportError):
                GATE.parse_report(malformed, root)

    def test_custom_and_platform_errors_are_counted(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            source = self.write_android_source(root)
            report = root / "lint.xml"
            report.write_text(
                """<?xml version="1.0" encoding="UTF-8"?>
                <issues>
                  <issue id="FeishuUnknownControl" severity="Error" message="unmapped">
                    <location file="%s" line="7" column="3" />
                  </issue>
                  <issue id="NewApi" severity="Fatal" message="unsupported">
                    <location file="%s" line="9" column="5" />
                  </issue>
                  <issue id="SetTextI18n" severity="Warning" message="literal" />
                </issues>
                """ % (root / "src/Widget.kt", root / "src/Widget.kt"),
                encoding="utf-8",
            )
            result = GATE.parse_report(report, root)
            self.assertEqual(3, result["issue_count"])
            self.assertEqual(2, result["error_count"])
            self.assertEqual(1, result["custom_error_count"])
            self.assertEqual("src/Widget.kt", result["errors"][0]["path"])
            self.assertEqual(
                {"FeishuUnknownControl": 1, "NewApi": 1, "SetTextI18n": 1},
                result["counts_by_id"],
            )
            self.assertEqual(
                [{"path": source.relative_to(root).as_posix(), "sha256": GATE.sha256_file(source)}],
                result["inputs"],
            )

    def test_warning_only_report_is_clean(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            self.write_android_source(root)
            report = root / "lint.xml"
            report.write_text(
                '<issues><issue id="SetTextI18n" severity="Warning" message="literal" /></issues>',
                encoding="utf-8",
            )
            result = GATE.parse_report(report, root)
            self.assertEqual(0, result["error_count"])
            self.assertEqual(0, result["custom_error_count"])

    def test_report_older_than_android_source_is_rejected(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            source = self.write_android_source(root)
            report = root / "lint.xml"
            report.write_text("<issues />", encoding="utf-8")
            newer = report.stat().st_mtime_ns + 1_000_000
            os.utime(source, ns=(newer, newer))

            with self.assertRaisesRegex(GATE.ReportError, "rerun lintRelease"):
                GATE.parse_report(report, root)


if __name__ == "__main__":
    unittest.main()
