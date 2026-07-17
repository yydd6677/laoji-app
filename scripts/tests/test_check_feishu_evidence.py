import importlib.util
import tempfile
import unittest
from pathlib import Path


SCRIPT_PATH = Path(__file__).resolve().parents[1] / "check_feishu_evidence.py"
SPEC = importlib.util.spec_from_file_location("check_feishu_evidence", SCRIPT_PATH)
assert SPEC and SPEC.loader
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


class CheckFeishuEvidenceTest(unittest.TestCase):
    def write_docs(self, root: Path, status: str = "已关闭") -> tuple[Path, Path]:
        source_map = root / "source.md"
        ledger = root / "ledger.md"
        source_map.write_text(
            "## 源码闭包\n| `CAL-DAY-001` | Day |\n## 关闭规则\n",
            encoding="utf-8",
        )
        ledger.write_text(
            f"| `CAL-DAY-001` | Day | {status} | evidence |\n",
            encoding="utf-8",
        )
        return source_map, ledger

    def test_accepts_registered_closed_evidence(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            source_map, ledger = self.write_docs(Path(temp_dir))
            self.assertEqual(MODULE.validate(source_map, ledger, True), [])

    def test_rejects_unclosed_evidence_for_release(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            source_map, ledger = self.write_docs(Path(temp_dir), "已取证")
            errors = MODULE.validate(source_map, ledger, True)
            self.assertIn("evidence is not closed: CAL-DAY-001 (已取证)", errors)

    def test_tracks_reaudit_status_in_the_ledger(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            source_map, ledger = self.write_docs(Path(temp_dir), "复审中")
            self.assertEqual(MODULE.validate(source_map, ledger), [])
            self.assertIn(
                "evidence is not closed: CAL-DAY-001 (复审中)",
                MODULE.validate(source_map, ledger, True),
            )

    def test_rejects_unknown_evidence(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            source_map, ledger = self.write_docs(Path(temp_dir))
            ledger.write_text(
                "| `MIN-ROOT-999` | Minutes | 已关闭 | evidence |\n",
                encoding="utf-8",
            )
            errors = MODULE.validate(source_map, ledger)
            self.assertIn("ledger references undefined evidence ID: MIN-ROOT-999", errors)

    def test_rejects_undefined_implementation_reference(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            source_map, ledger = self.write_docs(root)
            implementation = root / "src" / "native"
            implementation.mkdir(parents=True)
            (implementation / "contract.ts").write_text("// MIN-ROOT-999\n", encoding="utf-8")
            errors = MODULE.validate(source_map, ledger, implementation_root=root)
            self.assertIn(
                "implementation references undefined evidence ID: MIN-ROOT-999 (src/native/contract.ts)",
                errors,
            )


if __name__ == "__main__":
    unittest.main()
