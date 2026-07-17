import hashlib
import importlib.util
import json
import sys
import tempfile
import unittest
from pathlib import Path


SCRIPT = Path(__file__).resolve().parents[1] / "feishu_evidence_gate.py"
SPEC = importlib.util.spec_from_file_location("feishu_evidence_gate", SCRIPT)
assert SPEC and SPEC.loader
GATE = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = GATE
SPEC.loader.exec_module(GATE)


class FeishuEvidenceGateTest(unittest.TestCase):
    def write_fixture(self, root: Path):
        source_root = root / "feishu"
        source = source_root / "java-sources/example/Authority.java"
        source.parent.mkdir(parents=True)
        source.write_text("class Authority { int height = 50; }\n", encoding="utf-8")

        implementation = root / "src/Widget.kt"
        implementation.parent.mkdir(parents=True)
        implementation.write_text(
            "// UI-TEST-001\nclass EvidenceWidget { val height = 50f }\n",
            encoding="utf-8",
        )
        test = root / "tests/WidgetTest.kt"
        test.parent.mkdir(parents=True)
        test.write_text("// UI-TEST-001\n", encoding="utf-8")

        evidence = root / "evidence/feishu"
        evidence.mkdir(parents=True)
        source_lock = {
            "schema_version": 1,
            "baseline": {"id": "feishu-android-7.71.8"},
            "files": [
                {
                    "id": "authority",
                    "path": "java-sources/example/Authority.java",
                    "sha256": hashlib.sha256(source.read_bytes()).hexdigest(),
                }
            ],
        }
        deviations = {"schema_version": 1, "deviations": []}
        manifest = {
            "schema_version": 1,
            "baseline_id": "feishu-android-7.71.8",
            "source_lock": "evidence/feishu/source-lock.json",
            "deviations": "evidence/feishu/deviations.json",
            "coverage": {"phase": "pilot", "release_inventory_complete": False},
            "required_release_evidence": ["UI-TEST-001"],
            "evidence": [
                {
                    "id": "UI-TEST-001",
                    "module": "test",
                    "status": "implemented",
                    "decision": "keep",
                    "source_refs": ["authority"],
                    "deviation_refs": [],
                    "requirements": {"height_dp": 50},
                    "implementation": [
                        {
                            "path": "src/Widget.kt",
                            "symbols": ["EvidenceWidget"],
                            "required_patterns": ["50f"],
                            "forbidden_patterns": ["extraModeButton"],
                        }
                    ],
                    "tests": [{"path": "tests/WidgetTest.kt", "kind": "unit"}],
                    "blockers": [],
                }
            ],
        }
        for name, value in (
            ("source-lock.json", source_lock),
            ("deviations.json", deviations),
            ("manifest.json", manifest),
        ):
            (evidence / name).write_text(json.dumps(value), encoding="utf-8")
        docs = root / "docs"
        docs.mkdir()
        (docs / "feishu-parity-ledger.md").write_text(
            "# Ledger\n\n" + GATE.render_ledger_status(manifest) + "\n",
            encoding="utf-8",
        )
        return source_root, evidence / "manifest.json", manifest

    def validate(self, root: Path, source_root: Path, manifest_path: Path, mode="static"):
        return GATE.validate(root, manifest_path, mode, source_root)

    def codes(self, errors):
        return {error.code for error in errors}

    def test_valid_static_fixture_passes(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            source_root, manifest, _ = self.write_fixture(root)
            self.assertEqual([], self.validate(root, source_root, manifest))

    def test_source_hash_mutation_is_rejected(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            source_root, manifest, _ = self.write_fixture(root)
            (source_root / "java-sources/example/Authority.java").write_text("changed\n")
            self.assertIn("SOURCE_HASH_MISMATCH", self.codes(self.validate(root, source_root, manifest)))

    def test_extra_self_authored_control_is_rejected(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            source_root, manifest, _ = self.write_fixture(root)
            (root / "src/Widget.kt").write_text(
                "// UI-TEST-001\nclass EvidenceWidget { val height = 50f; val extraModeButton = 1 }\n"
            )
            self.assertIn("FORBIDDEN_IMPLEMENTATION", self.codes(self.validate(root, source_root, manifest)))

    def test_wrong_source_dimension_is_rejected(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            source_root, manifest, _ = self.write_fixture(root)
            (root / "src/Widget.kt").write_text(
                "// UI-TEST-001\nclass EvidenceWidget { val height = 48f }\n"
            )
            self.assertIn("REQUIRED_CONTRACT_MISSING", self.codes(self.validate(root, source_root, manifest)))

    def test_empty_click_and_destructive_snapshot_patterns_are_rejected(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            source_root, manifest_path, manifest = self.write_fixture(root)
            manifest["evidence"][0]["implementation"][0]["forbidden_patterns"] = [
                r"performClick\(\).*super\.performClick",
                r"setSnapshot[\s\S]{0,100}notifyDataSetChanged",
            ]
            manifest_path.write_text(json.dumps(manifest), encoding="utf-8")
            (root / "src/Widget.kt").write_text(
                "// UI-TEST-001\nclass EvidenceWidget {\n"
                " val height = 50f\n"
                " fun performClick() = super.performClick()\n"
                " fun setSnapshot() { notifyDataSetChanged() }\n"
                "}\n"
            )
            errors = self.validate(root, source_root, manifest_path)
            self.assertEqual(2, sum(error.code == "FORBIDDEN_IMPLEMENTATION" for error in errors))

    def test_unapproved_or_unknown_deviation_is_rejected(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            source_root, manifest_path, manifest = self.write_fixture(root)
            manifest["evidence"][0]["deviation_refs"] = ["DEV-NOT-APPROVED-001"]
            manifest_path.write_text(json.dumps(manifest), encoding="utf-8")
            self.assertIn("DEVIATION_UNKNOWN", self.codes(self.validate(root, source_root, manifest_path)))

    def test_missing_test_marker_is_rejected(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            source_root, manifest, _ = self.write_fixture(root)
            (root / "tests/WidgetTest.kt").write_text("// unrelated\n")
            self.assertIn("TEST_MARKER_MISSING", self.codes(self.validate(root, source_root, manifest)))

    def test_release_cannot_be_closed_by_editing_status_only(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            source_root, manifest_path, manifest = self.write_fixture(root)
            manifest["evidence"][0]["status"] = "closed"
            manifest_path.write_text(json.dumps(manifest), encoding="utf-8")
            self.assertIn(
                "RELEASE_INVENTORY_INCOMPLETE",
                self.codes(self.validate(root, source_root, manifest_path, mode="release")),
            )
            self.assertIn(
                "VERIFICATION_PROOF_MISSING",
                self.codes(self.validate(root, source_root, manifest_path, mode="release")),
            )
            self.assertIn(
                "CLOSURE_PROOF_MISSING",
                self.codes(self.validate(root, source_root, manifest_path, mode="release")),
            )

    def test_verified_status_requires_current_test_proof(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            source_root, manifest_path, manifest = self.write_fixture(root)
            report = root / "build/test-results/result.xml"
            report.parent.mkdir(parents=True)
            report.write_text(
                '<testsuite tests="1" failures="0" errors="0" skipped="0">'
                '<testcase classname="WidgetTest" name="widgetMatchesSource" />'
                '</testsuite>',
                encoding="utf-8",
            )
            manifest["evidence"][0]["status"] = "verified"
            manifest["evidence"][0]["tests"][0]["symbol"] = "widgetMatchesSource"
            manifest["evidence"][0]["proof_refs"] = ["evidence/feishu/proofs/UI-TEST-001.json"]
            manifest_path.write_text(json.dumps(manifest), encoding="utf-8")
            GATE.sync_ledger(root, manifest, write=True)
            proof = root / "evidence/feishu/proofs/UI-TEST-001.json"
            GATE.record_proof(
                root,
                manifest_path,
                "UI-TEST-001",
                report,
                proof,
                "unit",
                "host",
                None,
                "fixture",
            )
            self.assertEqual([], self.validate(root, source_root, manifest_path))
            (root / "src/Widget.kt").write_text(
                "// UI-TEST-001\nclass EvidenceWidget { val height = 50f; val changed = true }\n",
                encoding="utf-8",
            )
            self.assertIn(
                "VERIFICATION_PROOF_STALE",
                self.codes(self.validate(root, source_root, manifest_path)),
            )

    def test_artifact_hash_lives_in_non_recursive_sidecar(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            attestation = root / "embedded.json"
            artifact = root / "app.apk"
            sidecar = root / "app.attestation.json"
            attestation.write_text('{"schema_version": 1, "artifact_sha256": null}\n')
            artifact.write_bytes(b"apk")
            GATE.finalize_attestation(attestation, artifact, sidecar)
            value = json.loads(sidecar.read_text())
            self.assertEqual(hashlib.sha256(b"apk").hexdigest(), value["artifact_sha256"])


if __name__ == "__main__":
    unittest.main()
