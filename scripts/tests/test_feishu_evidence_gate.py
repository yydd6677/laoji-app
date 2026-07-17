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
        product_scope = {
            "schema_version": 1,
            "baseline_id": "feishu-android-7.71.8",
            "root_routes": [f"Route{index}" for index in range(16)],
            "main_tab_destinations": ["Schedule", "Meetings"],
            "module_decisions": [
                {"module": name, "status": "approved"}
                for name in ("common-shell", "calendar", "minutes", "account-static")
            ],
        }
        tombstones = {"schema_version": 1, "tombstones": []}
        manifest = {
            "schema_version": 1,
            "baseline_id": "feishu-android-7.71.8",
            "source_lock": "evidence/feishu/source-lock.json",
            "deviations": "evidence/feishu/deviations.json",
            "product_scope": "evidence/feishu/product-scope.json",
            "tombstones": "evidence/feishu/tombstones.json",
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
            ("product-scope.json", product_scope),
            ("tombstones.json", tombstones),
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

    def write_audit_reports(self, root: Path):
        ts_source = root / "src/AuditScreen.tsx"
        ts_source.write_text("export const AuditScreen = () => null;\n", encoding="utf-8")
        scripts = root / "scripts"
        scripts.mkdir()
        ts_scanner = scripts / "feishu_ui_ast_gate.js"
        ts_scanner.write_text("// fixture scanner\n", encoding="utf-8")
        lint_parser = scripts / "check_feishu_android_lint.py"
        lint_parser.write_text("# fixture parser\n", encoding="utf-8")
        workspace_gate = scripts / "check_workspace_source_resolution.js"
        workspace_gate.write_text("// fixture workspace gate\n", encoding="utf-8")
        (root / "node_modules").mkdir()
        package_lock = root / "package-lock.json"
        package_lock.write_text("{}\n", encoding="utf-8")
        metro = root / "metro.config.js"
        metro.write_text("// fixture metro\n", encoding="utf-8")
        plugin = root / "plugins/withLaojiNativePlatform.js"
        plugin.parent.mkdir()
        plugin.write_text("// fixture plugin\n", encoding="utf-8")
        module_package = root / "modules/laoji-native-platform/package.json"
        module_package.parent.mkdir(parents=True)
        module_package.write_text('{"name":"laoji-native-platform"}\n', encoding="utf-8")
        manifest_path = root / "evidence/feishu/manifest.json"
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        product_scope_path = root / manifest["product_scope"]

        build = root / "build"
        build.mkdir(exist_ok=True)
        ts_report = build / "feishu-ui-ast-report.json"
        ts_report.write_text(
            json.dumps({
                "schemaVersion": 1,
                "kind": "typescript-ast",
                "scanner": {
                    "path": "scripts/feishu_ui_ast_gate.js",
                    "sha256": GATE.sha256_file(ts_scanner),
                    "typescriptVersion": "fixture",
                },
                "manifest": {
                    "path": "evidence/feishu/manifest.json",
                    "sha256": GATE.sha256_file(manifest_path),
                },
                "productScope": {
                    "path": manifest["product_scope"],
                    "sha256": GATE.sha256_file(product_scope_path),
                },
                "files": [{
                    "path": "src/AuditScreen.tsx",
                    "sourceSha256": GATE.sha256_file(ts_source),
                }],
                "errors": [],
            }),
            encoding="utf-8",
        )

        lint_xml = root / "reports/lint-results-release.xml"
        lint_xml.parent.mkdir()
        lint_xml.write_text("<issues />\n", encoding="utf-8")
        detector = root / "tools/feishu-evidence-lint.jar"
        detector.parent.mkdir()
        detector.write_bytes(b"detector")
        android_report = build / "feishu-android-uast-report.json"
        android_report.write_text(
            json.dumps({
                "schema_version": 1,
                "kind": "android-lint-uast",
                "parser": {
                    "path": "scripts/check_feishu_android_lint.py",
                    "sha256": GATE.sha256_file(lint_parser),
                },
                "source_report": "reports/lint-results-release.xml",
                "source_report_sha256": GATE.sha256_file(lint_xml),
                "detector_jar": {
                    "path": "tools/feishu-evidence-lint.jar",
                    "sha256": GATE.sha256_file(detector),
                },
                "issue_count": 0,
                "error_count": 0,
                "custom_error_count": 0,
                "counts_by_id": {},
                "errors": [],
            }),
            encoding="utf-8",
        )
        workspace_report = build / "workspace-source-resolution-report.json"
        workspace_inputs = [workspace_gate, package_lock, metro, plugin, module_package]
        workspace_report.write_text(
            json.dumps({
                "schemaVersion": 1,
                "kind": "workspace-source-resolution",
                "inputs": [{
                    "path": item.relative_to(root).as_posix(),
                    "sha256": GATE.sha256_file(item),
                } for item in workspace_inputs],
                "nodeModules": {
                    "path": "node_modules",
                    "realPath": "node_modules",
                    "symbolicLink": False,
                },
                "resolutions": {
                    "laoji-native-platform/package.json": "modules/laoji-native-platform/package.json",
                },
                "autolinking": {
                    "moduleCount": 1,
                    "laojiSourceDir": "modules/laoji-native-platform/android",
                },
                "errors": [],
            }),
            encoding="utf-8",
        )
        return ts_source

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

    def test_product_scope_cardinality_and_tombstoned_ids_are_rejected(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            source_root, manifest_path, manifest = self.write_fixture(root)
            product_scope_path = root / manifest["product_scope"]
            product_scope = json.loads(product_scope_path.read_text())
            product_scope["root_routes"].pop()
            product_scope_path.write_text(json.dumps(product_scope), encoding="utf-8")
            tombstones_path = root / manifest["tombstones"]
            tombstones_path.write_text(
                json.dumps({
                    "schema_version": 1,
                    "tombstones": [{
                        "id": "UI-TEST-001",
                        "reason": "split",
                        "replaced_by": ["UI-TEST-A-001", "UI-TEST-B-001"],
                    }],
                }),
                encoding="utf-8",
            )
            codes = self.codes(self.validate(root, source_root, manifest_path))
            self.assertIn("PRODUCT_SCOPE_INVALID", codes)
            self.assertIn("EVIDENCE_ID_TOMBSTONED", codes)

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

    def test_audit_reports_bind_their_real_inputs(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            self.write_fixture(root)
            ts_source = self.write_audit_reports(root)
            references, errors = GATE.collect_audit_reports(root, require_clean=True, require_all=True)
            self.assertEqual([], errors)
            self.assertEqual(
                {"typescript_ast", "android_lint_uast", "workspace_resolution"},
                set(references),
            )
            ts_source.write_text("export const AuditScreen = () => 'changed';\n", encoding="utf-8")
            _, errors = GATE.collect_audit_reports(root, require_clean=True, require_all=True)
            self.assertIn("AUDIT_REPORT_STALE", self.codes(errors))

    def test_recorded_proof_contains_current_ast_report_hashes(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            _, manifest_path, manifest = self.write_fixture(root)
            report = root / "build/result.xml"
            report.parent.mkdir(exist_ok=True)
            report.write_text(
                '<testsuite tests="1" failures="0" errors="0" skipped="0">'
                '<testcase classname="WidgetTest" name="widgetMatchesSource" />'
                '</testsuite>',
                encoding="utf-8",
            )
            manifest["evidence"][0]["tests"][0]["symbol"] = "widgetMatchesSource"
            manifest_path.write_text(json.dumps(manifest), encoding="utf-8")
            GATE.sync_ledger(root, manifest, write=True)
            self.write_audit_reports(root)
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
            value = json.loads(proof.read_text(encoding="utf-8"))
            self.assertEqual(
                {"typescript_ast", "android_lint_uast", "workspace_resolution"},
                set(value["audit_reports"]),
            )
            self.assertEqual(
                GATE.sha256_file(root / "build/feishu-ui-ast-report.json"),
                value["audit_reports"]["typescript_ast"]["sha256"],
            )


if __name__ == "__main__":
    unittest.main()
