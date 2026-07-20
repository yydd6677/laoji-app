#!/usr/bin/env python3
"""Fail closed when source evidence, implementation coverage, or release proof is incomplete."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import subprocess
import sys
import xml.etree.ElementTree as ET
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable


EVIDENCE_ID_RE = re.compile(r"^(?:CAL|MIN|UI)-[A-Z0-9-]+-\d{3}$")
DEVIATION_ID_RE = re.compile(r"^DEV-[A-Z0-9-]+-\d{3}$")
ALLOWED_STATUSES = {"blocked", "source_locked", "contract_ready", "implemented", "verified", "closed"}
ALLOWED_DECISIONS = {"keep", "delete", "business_replace"}
LEDGER_START = "<!-- BEGIN GENERATED FEISHU EVIDENCE STATUS -->"
LEDGER_END = "<!-- END GENERATED FEISHU EVIDENCE STATUS -->"
STATUS_LABELS = {
    "blocked": "阻断",
    "source_locked": "已锁源",
    "contract_ready": "合同完成",
    "implemented": "已实现",
    "verified": "已验证",
    "closed": "已关闭",
}
AUDIT_REPORT_PATHS = {
    "typescript_ast": "build/feishu-ui-ast-report.json",
    "android_lint_uast": "build/feishu-android-uast-report.json",
    "workspace_resolution": "build/workspace-source-resolution-report.json",
}


@dataclass(frozen=True)
class GateError:
    code: str
    message: str

    def render(self) -> str:
        return f"{self.code}: {self.message}"


def read_json(path: Path) -> dict[str, Any]:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except OSError as error:
        raise ValueError(f"missing JSON file: {path}") from error
    except json.JSONDecodeError as error:
        raise ValueError(f"invalid JSON file {path}: {error}") from error
    if not isinstance(value, dict):
        raise ValueError(f"JSON root must be an object: {path}")
    return value


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def canonical_sha256(value: Any) -> str:
    payload = json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=True)
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()


def repo_relative_file(repo_root: Path, relative: str) -> Path:
    path = Path(relative)
    if path.is_absolute():
        raise ValueError(f"path must be repository-relative: {relative}")
    target = (repo_root / path).resolve()
    try:
        target.relative_to(repo_root.resolve())
    except ValueError as error:
        raise ValueError(f"path escapes repository root: {relative}") from error
    return target


def validate_audit_report(
    repo_root: Path,
    kind: str,
    relative: str,
    require_clean: bool,
) -> tuple[dict[str, Any] | None, list[GateError]]:
    errors: list[GateError] = []
    try:
        path = repo_relative_file(repo_root, relative)
        report = read_json(path)
    except ValueError as error:
        return None, [GateError("AUDIT_REPORT_INVALID", f"{kind}: {error}")]

    error_count = 0
    if kind == "typescript_ast":
        if report.get("schemaVersion") != 1 or report.get("kind") != "typescript-ast":
            errors.append(GateError("AUDIT_REPORT_INVALID", f"{kind}: schema or kind mismatch"))
        for label, key in (
            ("scanner", "scanner"),
            ("manifest", "manifest"),
            ("product scope", "productScope"),
        ):
            reference = report.get(key)
            if not isinstance(reference, dict):
                errors.append(GateError("AUDIT_REPORT_INVALID", f"{kind}: missing {label} input"))
                continue
            input_relative = reference.get("path")
            expected = reference.get("sha256")
            try:
                input_path = repo_relative_file(repo_root, input_relative)
            except (TypeError, ValueError) as error:
                errors.append(GateError("AUDIT_REPORT_INVALID", f"{kind}: {label}: {error}"))
                continue
            if not input_path.is_file() or not isinstance(expected, str) or sha256_file(input_path) != expected:
                errors.append(GateError("AUDIT_REPORT_STALE", f"{kind}: {input_relative}"))
        files = report.get("files")
        if not isinstance(files, list) or not files:
            errors.append(GateError("AUDIT_REPORT_INVALID", f"{kind}: no scanned source files"))
        else:
            for item in files:
                if not isinstance(item, dict):
                    errors.append(GateError("AUDIT_REPORT_INVALID", f"{kind}: invalid source entry"))
                    continue
                input_relative = item.get("path")
                expected = item.get("sourceSha256")
                try:
                    input_path = repo_relative_file(repo_root, input_relative)
                except (TypeError, ValueError) as error:
                    errors.append(GateError("AUDIT_REPORT_INVALID", f"{kind}: source: {error}"))
                    continue
                if not input_path.is_file() or not isinstance(expected, str) or sha256_file(input_path) != expected:
                    errors.append(GateError("AUDIT_REPORT_STALE", f"{kind}: {input_relative}"))
        report_errors = report.get("errors")
        if not isinstance(report_errors, list):
            errors.append(GateError("AUDIT_REPORT_INVALID", f"{kind}: errors must be an array"))
        else:
            error_count = len(report_errors)
    elif kind == "android_lint_uast":
        if report.get("schema_version") != 1 or report.get("kind") != "android-lint-uast":
            errors.append(GateError("AUDIT_REPORT_INVALID", f"{kind}: schema or kind mismatch"))
        parser = report.get("parser")
        if not isinstance(parser, dict):
            errors.append(GateError("AUDIT_REPORT_INVALID", f"{kind}: parser is not bound"))
        else:
            parser_relative = parser.get("path")
            parser_sha = parser.get("sha256")
            try:
                parser_path = repo_relative_file(repo_root, parser_relative)
            except (TypeError, ValueError) as error:
                errors.append(GateError("AUDIT_REPORT_INVALID", f"{kind}: parser: {error}"))
            else:
                if not parser_path.is_file() or not isinstance(parser_sha, str) or sha256_file(parser_path) != parser_sha:
                    errors.append(GateError("AUDIT_REPORT_STALE", f"{kind}: {parser_relative}"))
        source_relative = report.get("source_report")
        expected = report.get("source_report_sha256")
        try:
            source_path = repo_relative_file(repo_root, source_relative)
        except (TypeError, ValueError) as error:
            errors.append(GateError("AUDIT_REPORT_INVALID", f"{kind}: source report: {error}"))
        else:
            if not source_path.is_file() or not isinstance(expected, str) or sha256_file(source_path) != expected:
                errors.append(GateError("AUDIT_REPORT_STALE", f"{kind}: {source_relative}"))
        inputs = report.get("inputs")
        if not isinstance(inputs, list) or not inputs:
            errors.append(GateError("AUDIT_REPORT_INVALID", f"{kind}: no bound Kotlin/Java/XML inputs"))
        else:
            for item in inputs:
                if not isinstance(item, dict):
                    errors.append(GateError("AUDIT_REPORT_INVALID", f"{kind}: invalid source input"))
                    continue
                input_relative = item.get("path")
                input_sha = item.get("sha256")
                try:
                    input_path = repo_relative_file(repo_root, input_relative)
                except (TypeError, ValueError) as error:
                    errors.append(GateError("AUDIT_REPORT_INVALID", f"{kind}: source input: {error}"))
                    continue
                if not input_path.is_file() or not isinstance(input_sha, str) or sha256_file(input_path) != input_sha:
                    errors.append(GateError("AUDIT_REPORT_STALE", f"{kind}: {input_relative}"))
        detector = report.get("detector_jar")
        if not isinstance(detector, dict):
            errors.append(GateError("AUDIT_REPORT_INVALID", f"{kind}: detector JAR is not bound"))
        else:
            detector_relative = detector.get("path")
            detector_sha = detector.get("sha256")
            try:
                detector_path = repo_relative_file(repo_root, detector_relative)
            except (TypeError, ValueError) as error:
                errors.append(GateError("AUDIT_REPORT_INVALID", f"{kind}: detector JAR: {error}"))
            else:
                if not detector_path.is_file() or not isinstance(detector_sha, str) or sha256_file(detector_path) != detector_sha:
                    errors.append(GateError("AUDIT_REPORT_STALE", f"{kind}: {detector_relative}"))
        error_count = report.get("error_count", -1)
        report_errors = report.get("errors")
        if not isinstance(error_count, int) or error_count < 0 or not isinstance(report_errors, list):
            errors.append(GateError("AUDIT_REPORT_INVALID", f"{kind}: invalid error inventory"))
            error_count = 0
        elif error_count != len(report_errors):
            errors.append(GateError("AUDIT_REPORT_INVALID", f"{kind}: error count mismatch"))
    elif kind == "workspace_resolution":
        if report.get("schemaVersion") != 1 or report.get("kind") != "workspace-source-resolution":
            errors.append(GateError("AUDIT_REPORT_INVALID", f"{kind}: schema or kind mismatch"))
        inputs = report.get("inputs")
        if not isinstance(inputs, list) or not inputs:
            errors.append(GateError("AUDIT_REPORT_INVALID", f"{kind}: no bound inputs"))
        else:
            for item in inputs:
                if not isinstance(item, dict):
                    errors.append(GateError("AUDIT_REPORT_INVALID", f"{kind}: invalid input"))
                    continue
                input_relative = item.get("path")
                expected = item.get("sha256")
                try:
                    input_path = repo_relative_file(repo_root, input_relative)
                except (TypeError, ValueError) as error:
                    errors.append(GateError("AUDIT_REPORT_INVALID", f"{kind}: input: {error}"))
                    continue
                if not input_path.is_file() or not isinstance(expected, str) or sha256_file(input_path) != expected:
                    errors.append(GateError("AUDIT_REPORT_STALE", f"{kind}: {input_relative}"))
        node_modules = repo_root / "node_modules"
        node_modules_report = report.get("nodeModules")
        if (
            not node_modules.is_dir()
            or node_modules.is_symlink()
            or not isinstance(node_modules_report, dict)
            or node_modules_report.get("symbolicLink") is not False
            or node_modules_report.get("realPath") != "node_modules"
        ):
            errors.append(GateError("AUDIT_REPORT_FAILED", f"{kind}: node_modules is not worktree-local"))
        resolutions = report.get("resolutions")
        if not isinstance(resolutions, dict) or resolutions.get("laoji-native-platform/package.json") != (
            "modules/laoji-native-platform/package.json"
        ):
            errors.append(GateError("AUDIT_REPORT_FAILED", f"{kind}: local module resolution mismatch"))
        autolinking = report.get("autolinking")
        if not isinstance(autolinking, dict) or autolinking.get("laojiSourceDir") != (
            "modules/laoji-native-platform/android"
        ):
            errors.append(GateError("AUDIT_REPORT_FAILED", f"{kind}: Expo autolinking mismatch"))
        report_errors = report.get("errors")
        if not isinstance(report_errors, list):
            errors.append(GateError("AUDIT_REPORT_INVALID", f"{kind}: errors must be an array"))
        else:
            error_count = len(report_errors)
    else:
        errors.append(GateError("AUDIT_REPORT_INVALID", f"unknown audit kind {kind}"))

    if require_clean and error_count:
        errors.append(GateError("AUDIT_REPORT_FAILED", f"{kind}: {error_count} errors"))
    reference = {
        "kind": kind,
        "path": relative,
        "sha256": sha256_file(path),
        "error_count": error_count,
    }
    return reference, errors


def collect_audit_reports(
    repo_root: Path,
    require_clean: bool,
    require_all: bool,
) -> tuple[dict[str, dict[str, Any]], list[GateError]]:
    references: dict[str, dict[str, Any]] = {}
    errors: list[GateError] = []
    for kind, relative in AUDIT_REPORT_PATHS.items():
        path = repo_root / relative
        if not path.is_file() and not require_all:
            continue
        if not path.is_file():
            errors.append(GateError("AUDIT_REPORT_MISSING", f"{kind}: {relative}"))
            continue
        reference, report_errors = validate_audit_report(repo_root, kind, relative, require_clean)
        errors.extend(report_errors)
        if reference is not None:
            references[kind] = reference
    return references, errors


def evidence_input_sha256(
    repo_root: Path,
    manifest: dict[str, Any],
    entry: dict[str, Any],
) -> str:
    stable_entry = {
        key: value
        for key, value in entry.items()
        if key not in {"status", "blockers", "proof_refs"}
    }
    files: dict[str, str] = {}
    for collection in (entry.get("implementation", []), entry.get("tests", [])):
        if not isinstance(collection, list):
            continue
        for item in collection:
            if not isinstance(item, dict) or not isinstance(item.get("path"), str):
                continue
            relative = item["path"]
            target = repo_root / relative
            if target.is_file():
                files[relative] = sha256_file(target)
    source_lock = repo_root / str(manifest.get("source_lock", ""))
    source_catalog = repo_root / str(manifest.get("source_catalog", ""))
    capability_inventory = repo_root / str(manifest.get("capability_inventory", ""))
    deviations = repo_root / str(manifest.get("deviations", ""))
    product_scope = repo_root / str(manifest.get("product_scope", ""))
    tombstones = repo_root / str(manifest.get("tombstones", ""))
    gate_script = repo_root / "scripts/feishu_evidence_gate.py"
    return canonical_sha256(
        {
            "baseline_id": manifest.get("baseline_id"),
            "entry": stable_entry,
            "files": files,
            "source_lock_sha256": sha256_file(source_lock) if source_lock.is_file() else None,
            "source_catalog_sha256": sha256_file(source_catalog) if source_catalog.is_file() else None,
            "capability_inventory_sha256": (
                sha256_file(capability_inventory) if capability_inventory.is_file() else None
            ),
            "deviations_sha256": sha256_file(deviations) if deviations.is_file() else None,
            "product_scope_sha256": sha256_file(product_scope) if product_scope.is_file() else None,
            "tombstones_sha256": sha256_file(tombstones) if tombstones.is_file() else None,
            "evidence_gate_sha256": sha256_file(gate_script) if gate_script.is_file() else None,
        }
    )


def junit_report(report: Path) -> dict[str, Any]:
    try:
        root = ET.parse(report).getroot()
    except (ET.ParseError, OSError) as error:
        raise ValueError(f"invalid JUnit report {report}: {error}") from error
    suites = [root] if root.tag == "testsuite" else list(root.findall(".//testsuite"))
    cases = [
        {"class_name": case.get("classname", ""), "name": case.get("name", "")}
        for suite in suites
        for case in suite.findall("testcase")
    ]
    return {
        "tests": sum(int(suite.get("tests", "0")) for suite in suites),
        "failures": sum(int(suite.get("failures", "0")) for suite in suites),
        "errors": sum(int(suite.get("errors", "0")) for suite in suites),
        "skipped": sum(int(suite.get("skipped", "0")) for suite in suites),
        "testcases": cases,
    }


def validate_proof(
    repo_root: Path,
    manifest: dict[str, Any],
    evidence_id: str,
    entry: dict[str, Any],
    proof_relative: str,
    mode: str,
) -> list[GateError]:
    errors: list[GateError] = []
    proof_path = repo_root / proof_relative
    try:
        proof = read_json(proof_path)
    except ValueError as error:
        return [GateError("VERIFICATION_PROOF_INVALID", f"{evidence_id}: {error}")]
    if proof.get("schema_version") != 1 or proof.get("evidence_id") != evidence_id:
        errors.append(GateError("VERIFICATION_PROOF_INVALID", f"{evidence_id}: {proof_relative}"))
        return errors
    expected_input = evidence_input_sha256(repo_root, manifest, entry)
    if proof.get("input_sha256") != expected_input:
        errors.append(GateError("VERIFICATION_PROOF_STALE", f"{evidence_id}: {proof_relative}"))
    report = proof.get("report", {})
    if not isinstance(report, dict) or report.get("tests", 0) <= 0:
        errors.append(GateError("VERIFICATION_PROOF_INVALID", f"{evidence_id}: no executed tests"))
    if report.get("failures") != 0 or report.get("errors") != 0:
        errors.append(GateError("VERIFICATION_PROOF_FAILED", f"{evidence_id}: {proof_relative}"))
    testcases = {
        case.get("name")
        for case in report.get("testcases", [])
        if isinstance(case, dict) and isinstance(case.get("name"), str)
    }
    for test in entry.get("tests", []):
        symbol = test.get("symbol") if isinstance(test, dict) else None
        if symbol and symbol not in testcases:
            errors.append(GateError("VERIFICATION_TESTCASE_MISSING", f"{evidence_id}: {symbol}"))
    proof_audits = proof.get("audit_reports")
    if proof_audits is not None or mode == "release":
        current_audits, audit_errors = collect_audit_reports(
            repo_root,
            require_clean=mode == "release",
            require_all=mode == "release",
        )
        errors.extend(
            GateError(error.code, f"{evidence_id}: {error.message}") for error in audit_errors
        )
        if not isinstance(proof_audits, dict):
            errors.append(GateError("VERIFICATION_AUDIT_PROOF_MISSING", evidence_id))
        else:
            if mode == "release":
                for kind in AUDIT_REPORT_PATHS:
                    if kind not in proof_audits:
                        errors.append(
                            GateError("VERIFICATION_AUDIT_PROOF_MISSING", f"{evidence_id}: {kind}")
                        )
            for kind, recorded in proof_audits.items():
                current = current_audits.get(kind)
                if not isinstance(recorded, dict) or current is None:
                    errors.append(
                        GateError("VERIFICATION_AUDIT_PROOF_INVALID", f"{evidence_id}: {kind}")
                    )
                    continue
                if any(recorded.get(key) != current.get(key) for key in ("path", "sha256", "error_count")):
                    errors.append(
                        GateError("VERIFICATION_AUDIT_PROOF_STALE", f"{evidence_id}: {kind}")
                    )
    if mode == "release":
        report_relative = report.get("path")
        live_report = repo_root / str(report_relative)
        if not isinstance(report_relative, str) or not live_report.is_file():
            errors.append(GateError("VERIFICATION_REPORT_MISSING", f"{evidence_id}: {report_relative}"))
        elif sha256_file(live_report) != report.get("sha256"):
            errors.append(GateError("VERIFICATION_REPORT_STALE", f"{evidence_id}: {report_relative}"))
    return errors


def resolve_source_root(explicit: str | None) -> Path | None:
    candidates: list[Path] = []
    if explicit:
        candidates.append(Path(explicit).expanduser())
    if os.environ.get("FEISHU_SOURCE_ROOT"):
        candidates.append(Path(os.environ["FEISHU_SOURCE_ROOT"]).expanduser())
    candidates.extend(
        [
            Path.home() / "文档" / "apk-analysis" / "base-feishu-7.71.8",
            Path.home() / "Documents" / "apk-analysis" / "base-feishu-7.71.8",
        ]
    )
    return next((candidate.resolve() for candidate in candidates if candidate.is_dir()), None)


def render_ledger_status(manifest: dict[str, Any]) -> str:
    coverage = manifest.get("coverage", {})
    lines = [
        LEDGER_START,
        "",
        f"- Manifest phase: `{coverage.get('phase', 'unknown')}`",
        f"- Source inventory complete: `{'yes' if coverage.get('source_inventory_complete') else 'no'}`",
        f"- Implementation inventory complete: `{'yes' if coverage.get('implementation_inventory_complete') else 'no'}`",
        f"- Release inventory complete: `{'yes' if coverage.get('release_inventory_complete') else 'no'}`",
        "- `capability-inventory.json` 中尚未进入 manifest 的条目表示源码已锁定、实现尚未登记；不得据此宣称已实现或已关闭。",
        "",
        "| 证据 ID | 模块 | 机器状态 | 决策 | 阻断数 |",
        "| --- | --- | --- | --- | --- |",
    ]
    for entry in sorted(manifest.get("evidence", []), key=lambda value: value.get("id", "")):
        lines.append(
            "| `{id}` | {module} | {status} | `{decision}` | {blockers} |".format(
                id=entry.get("id", "invalid"),
                module=entry.get("module", "unknown"),
                status=STATUS_LABELS.get(entry.get("status"), entry.get("status", "invalid")),
                decision=entry.get("decision", "invalid"),
                blockers=len(entry.get("blockers", [])),
            )
        )
    lines.extend(["", LEDGER_END])
    return "\n".join(lines)


def sync_ledger(repo_root: Path, manifest: dict[str, Any], write: bool) -> list[GateError]:
    ledger_path = repo_root / "docs/feishu-parity-ledger.md"
    if not ledger_path.is_file():
        return [GateError("LEDGER_MISSING", str(ledger_path))]
    text = ledger_path.read_text(encoding="utf-8")
    expected = render_ledger_status(manifest)
    start = text.find(LEDGER_START)
    end = text.find(LEDGER_END)
    if start < 0 or end < start:
        return [GateError("LEDGER_GENERATED_BLOCK_MISSING", str(ledger_path))]
    end += len(LEDGER_END)
    actual = text[start:end]
    if actual == expected:
        return []
    if write:
        ledger_path.write_text(text[:start] + expected + text[end:], encoding="utf-8")
        return []
    return [GateError("LEDGER_OUT_OF_SYNC", "run feishu_evidence_gate.py sync-docs")]


def unique_objects(items: Any, key: str, label: str, errors: list[GateError]) -> dict[str, dict[str, Any]]:
    if not isinstance(items, list):
        errors.append(GateError("SCHEMA_INVALID", f"{label} must be an array"))
        return {}
    result: dict[str, dict[str, Any]] = {}
    for index, item in enumerate(items):
        if not isinstance(item, dict) or not isinstance(item.get(key), str):
            errors.append(GateError("SCHEMA_INVALID", f"{label}[{index}] must contain string {key}"))
            continue
        identifier = item[key]
        if identifier in result:
            errors.append(GateError("DUPLICATE_ID", f"duplicate {label} id {identifier}"))
            continue
        result[identifier] = item
    return result


def validate_kotlin_evidence_references(
    repo_root: Path,
    known_ids: set[str],
) -> list[GateError]:
    errors: list[GateError] = []
    source_root = repo_root / "modules/laoji-native-platform/android/src"
    if not source_root.is_dir():
        return errors
    annotation_re = re.compile(r"@FeishuEvidence\s*\((.*?)\)", re.DOTALL)
    runtime_call_re = re.compile(r"FeishuEvidenceRuntime\.bind\s*\(")
    runtime_bind_re = re.compile(
        r'FeishuEvidenceRuntime\.bind\s*\([^,]+,\s*"([^"]+)"',
        re.DOTALL,
    )
    string_re = re.compile(r'"([^"\\]*(?:\\.[^"\\]*)*)"')
    for path in sorted((*source_root.rglob("*.kt"), *source_root.rglob("*.java"))):
        text = path.read_text(encoding="utf-8", errors="replace")
        relative = path.relative_to(repo_root).as_posix()
        for annotation in annotation_re.finditer(text):
            line = text.count("\n", 0, annotation.start()) + 1
            identifiers = string_re.findall(annotation.group(1))
            non_literal = re.sub(r"[\s,]", "", string_re.sub("", annotation.group(1)))
            if not identifiers or non_literal:
                errors.append(GateError(
                    "EVIDENCE_ANNOTATION_INVALID",
                    f"{relative}:{line}: @FeishuEvidence requires literal IDs",
                ))
                if not identifiers:
                    continue
            for identifier in identifiers:
                if not EVIDENCE_ID_RE.fullmatch(identifier):
                    errors.append(GateError(
                        "EVIDENCE_ANNOTATION_INVALID",
                        f"{relative}:{line}: {identifier}",
                    ))
                elif identifier not in known_ids:
                    errors.append(GateError(
                        "EVIDENCE_REFERENCE_UNKNOWN",
                        f"{relative}:{line}: {identifier}",
                    ))
        runtime_binds = list(runtime_bind_re.finditer(text))
        matched_starts = {runtime_bind.start() for runtime_bind in runtime_binds}
        for runtime_call in runtime_call_re.finditer(text):
            if runtime_call.start() not in matched_starts:
                line = text.count("\n", 0, runtime_call.start()) + 1
                errors.append(GateError(
                    "EVIDENCE_RUNTIME_BIND_INVALID",
                    f"{relative}:{line}: runtime evidence ID must be literal",
                ))
        for runtime_bind in runtime_binds:
            line = text.count("\n", 0, runtime_bind.start()) + 1
            identifier = runtime_bind.group(1)
            if not EVIDENCE_ID_RE.fullmatch(identifier):
                errors.append(GateError(
                    "EVIDENCE_RUNTIME_BIND_INVALID",
                    f"{relative}:{line}: {identifier}",
                ))
            elif identifier not in known_ids:
                errors.append(GateError(
                    "EVIDENCE_REFERENCE_UNKNOWN",
                    f"{relative}:{line}: {identifier}",
                ))
    return errors


def validate(
    repo_root: Path,
    manifest_path: Path,
    mode: str,
    source_root: Path | None,
) -> list[GateError]:
    errors: list[GateError] = []
    try:
        manifest = read_json(manifest_path)
        source_catalog_path = repo_root / str(manifest.get("source_catalog", ""))
        capability_inventory_path = repo_root / str(manifest.get("capability_inventory", ""))
        lock_path = repo_root / str(manifest.get("source_lock", ""))
        deviations_path = repo_root / str(manifest.get("deviations", ""))
        product_scope_path = repo_root / str(manifest.get("product_scope", ""))
        tombstones_path = repo_root / str(manifest.get("tombstones", ""))
        source_lock = read_json(lock_path)
        source_catalog = read_json(source_catalog_path)
        capability_inventory = read_json(capability_inventory_path)
        deviations_doc = read_json(deviations_path)
        product_scope = read_json(product_scope_path)
        tombstones_doc = read_json(tombstones_path)
    except ValueError as error:
        return [GateError("SCHEMA_INVALID", str(error))]

    if (
        manifest.get("schema_version") != 1
        or source_catalog.get("schema_version") != 1
        or capability_inventory.get("schema_version") != 1
        or source_lock.get("schema_version") != 1
    ):
        errors.append(GateError("SCHEMA_INVALID", "schema_version must equal 1"))
    if manifest.get("baseline_id") != source_catalog.get("baseline_id"):
        errors.append(GateError("BASELINE_MISMATCH", "manifest baseline does not match source catalog"))
    if manifest.get("baseline_id") != capability_inventory.get("baseline_id"):
        errors.append(GateError("BASELINE_MISMATCH", "manifest baseline does not match capability inventory"))
    if manifest.get("baseline_id") != source_lock.get("baseline", {}).get("id"):
        errors.append(GateError("BASELINE_MISMATCH", "manifest baseline does not match source lock"))
    if source_lock.get("baseline", {}).get("catalog_sha256") != sha256_file(source_catalog_path):
        errors.append(GateError("SOURCE_CATALOG_STALE", "source lock was not generated from current catalog"))
    if manifest.get("baseline_id") != product_scope.get("baseline_id"):
        errors.append(GateError("BASELINE_MISMATCH", "manifest baseline does not match product scope"))

    source_files = unique_objects(source_lock.get("files"), "id", "source files", errors)
    deviations = unique_objects(deviations_doc.get("deviations"), "id", "deviations", errors)
    evidence = unique_objects(manifest.get("evidence"), "id", "evidence", errors)
    inventory = unique_objects(capability_inventory.get("entries"), "id", "capability inventory", errors)
    tombstones = unique_objects(tombstones_doc.get("tombstones"), "id", "tombstones", errors)
    errors.extend(sync_ledger(repo_root, manifest, write=False))
    errors.extend(validate_kotlin_evidence_references(repo_root, set(inventory)))

    for evidence_id, item in inventory.items():
        if not EVIDENCE_ID_RE.fullmatch(evidence_id):
            errors.append(GateError("SCHEMA_INVALID", f"invalid capability inventory id {evidence_id}"))
        if item.get("decision") not in ALLOWED_DECISIONS:
            errors.append(GateError("SCHEMA_INVALID", f"{evidence_id} has invalid inventory decision"))
        if not isinstance(item.get("release_required"), bool):
            errors.append(GateError("SCHEMA_INVALID", f"{evidence_id} needs release_required"))
        source_refs = item.get("source_refs")
        if not isinstance(source_refs, list) or not source_refs:
            errors.append(GateError("SOURCE_CLOSURE_MISSING", evidence_id))
        else:
            for source_id in source_refs:
                if source_id not in source_files:
                    errors.append(GateError("SOURCE_REFERENCE_UNKNOWN", f"{evidence_id}: {source_id}"))
        for deviation_id in item.get("deviation_refs", []):
            if deviation_id not in deviations:
                errors.append(GateError("DEVIATION_UNKNOWN", f"{evidence_id}: {deviation_id}"))
            elif deviations[deviation_id].get("status") != "approved":
                errors.append(GateError("DEVIATION_UNAPPROVED", f"{evidence_id}: {deviation_id}"))

    for evidence_id, entry in evidence.items():
        inventory_entry = inventory.get(evidence_id)
        if inventory_entry is None:
            errors.append(GateError("CAPABILITY_INVENTORY_MISSING", evidence_id))
        elif (
            entry.get("module") != inventory_entry.get("module")
            or entry.get("decision") != inventory_entry.get("decision")
        ):
            errors.append(GateError("CAPABILITY_INVENTORY_MISMATCH", evidence_id))

    root_routes = product_scope.get("root_routes")
    tab_destinations = product_scope.get("main_tab_destinations")
    if not isinstance(root_routes, list) or len(root_routes) != 16 or len(set(root_routes)) != 16:
        errors.append(GateError("PRODUCT_SCOPE_INVALID", "product scope must contain 16 unique root routes"))
    if not isinstance(tab_destinations, list) or len(tab_destinations) != 2 or len(set(tab_destinations)) != 2:
        errors.append(GateError("PRODUCT_SCOPE_INVALID", "product scope must contain 2 unique main-tab destinations"))
    modules = product_scope.get("module_decisions")
    expected_modules = {"common-shell", "calendar", "minutes", "account-static"}
    actual_modules = {
        item.get("module") for item in modules if isinstance(item, dict)
    } if isinstance(modules, list) else set()
    if actual_modules != expected_modules:
        errors.append(GateError("PRODUCT_SCOPE_INVALID", "all four approved module decisions are required"))
    if isinstance(modules, list):
        for module in modules:
            if not isinstance(module, dict):
                continue
            for deviation_id in module.get("deviation_refs", []):
                if deviation_id not in deviations:
                    errors.append(GateError("DEVIATION_UNKNOWN", f"product scope: {deviation_id}"))

    for tombstone_id, tombstone in tombstones.items():
        if not EVIDENCE_ID_RE.fullmatch(tombstone_id):
            errors.append(GateError("SCHEMA_INVALID", f"invalid tombstone id {tombstone_id}"))
        replacements = tombstone.get("replaced_by")
        if not isinstance(replacements, list) or not replacements or any(
            not isinstance(value, str) or not EVIDENCE_ID_RE.fullmatch(value) or value == tombstone_id
            for value in replacements
        ):
            errors.append(GateError("SCHEMA_INVALID", f"invalid replacements for tombstone {tombstone_id}"))
        if tombstone_id in evidence:
            errors.append(GateError("EVIDENCE_ID_TOMBSTONED", tombstone_id))

    for identifier, deviation in deviations.items():
        if not DEVIATION_ID_RE.fullmatch(identifier):
            errors.append(GateError("SCHEMA_INVALID", f"invalid deviation id {identifier}"))
        if deviation.get("status") != "approved":
            errors.append(GateError("DEVIATION_UNAPPROVED", identifier))
        if not str(deviation.get("decision", "")).strip():
            errors.append(GateError("SCHEMA_INVALID", f"deviation {identifier} has no decision"))
        if not str(deviation.get("approval_basis", "")).strip():
            errors.append(GateError("SCHEMA_INVALID", f"deviation {identifier} has no approval basis"))

    if source_root is None:
        errors.append(GateError("SOURCE_ROOT_MISSING", "set FEISHU_SOURCE_ROOT or pass --source-root"))
    else:
        for source_id, source in source_files.items():
            relative = source.get("path")
            expected = source.get("sha256")
            if not isinstance(relative, str) or not isinstance(expected, str):
                errors.append(GateError("SCHEMA_INVALID", f"source {source_id} needs path and sha256"))
                continue
            target = source_root / relative
            if not target.is_file():
                errors.append(GateError("SOURCE_FILE_MISSING", f"{source_id}: {relative}"))
            elif sha256_file(target) != expected:
                errors.append(GateError("SOURCE_HASH_MISMATCH", f"{source_id}: {relative}"))

    for evidence_id, entry in evidence.items():
        if not EVIDENCE_ID_RE.fullmatch(evidence_id):
            errors.append(GateError("SCHEMA_INVALID", f"invalid evidence id {evidence_id}"))
        if entry.get("status") not in ALLOWED_STATUSES:
            errors.append(GateError("SCHEMA_INVALID", f"{evidence_id} has invalid status"))
        if entry.get("decision") not in ALLOWED_DECISIONS:
            errors.append(GateError("SCHEMA_INVALID", f"{evidence_id} has invalid decision"))
        source_refs = entry.get("source_refs")
        if not isinstance(source_refs, list) or not source_refs:
            errors.append(GateError("SOURCE_CLOSURE_MISSING", evidence_id))
        else:
            for source_id in source_refs:
                if source_id not in source_files:
                    errors.append(GateError("SOURCE_REFERENCE_UNKNOWN", f"{evidence_id}: {source_id}"))
        for deviation_id in entry.get("deviation_refs", []):
            if deviation_id not in deviations:
                errors.append(GateError("DEVIATION_UNKNOWN", f"{evidence_id}: {deviation_id}"))
            elif deviations[deviation_id].get("status") != "approved":
                errors.append(GateError("DEVIATION_UNAPPROVED", f"{evidence_id}: {deviation_id}"))

        implementations = entry.get("implementation")
        if not isinstance(implementations, list) or not implementations:
            errors.append(GateError("IMPLEMENTATION_UNMAPPED", evidence_id))
            continue
        for implementation in implementations:
            relative = implementation.get("path")
            if not isinstance(relative, str):
                errors.append(GateError("SCHEMA_INVALID", f"{evidence_id} implementation has no path"))
                continue
            target = repo_root / relative
            if not target.is_file():
                errors.append(GateError("IMPLEMENTATION_FILE_MISSING", f"{evidence_id}: {relative}"))
                continue
            text = target.read_text(encoding="utf-8", errors="replace")
            if evidence_id not in text:
                errors.append(GateError("IMPLEMENTATION_MARKER_MISSING", f"{evidence_id}: {relative}"))
            for symbol in implementation.get("symbols", []):
                if symbol not in text:
                    errors.append(GateError("IMPLEMENTATION_SYMBOL_MISSING", f"{evidence_id}: {symbol} in {relative}"))
            for pattern in implementation.get("required_patterns", []):
                if re.search(pattern, text, re.MULTILINE) is None:
                    errors.append(GateError("REQUIRED_CONTRACT_MISSING", f"{evidence_id}: {pattern} in {relative}"))
            ordered_patterns = implementation.get("ordered_patterns", [])
            if not isinstance(ordered_patterns, list) or not all(
                isinstance(pattern, str) for pattern in ordered_patterns
            ):
                errors.append(GateError("SCHEMA_INVALID", f"{evidence_id}: ordered_patterns in {relative}"))
            else:
                cursor = 0
                for pattern in ordered_patterns:
                    match = re.search(pattern, text[cursor:], re.MULTILINE)
                    if match is None:
                        errors.append(
                            GateError("ORDERED_CONTRACT_MISSING", f"{evidence_id}: {pattern} in {relative}")
                        )
                        break
                    cursor += match.end()
            for pattern in implementation.get("forbidden_patterns", []):
                if re.search(pattern, text, re.MULTILINE) is not None:
                    errors.append(GateError("FORBIDDEN_IMPLEMENTATION", f"{evidence_id}: {pattern} in {relative}"))

        tests = entry.get("tests")
        if not isinstance(tests, list) or not tests:
            errors.append(GateError("TEST_EVIDENCE_MISSING", evidence_id))
        else:
            for test in tests:
                relative = test.get("path")
                target = repo_root / str(relative)
                if not isinstance(relative, str) or not target.is_file():
                    errors.append(GateError("TEST_FILE_MISSING", f"{evidence_id}: {relative}"))
                    continue
                test_text = target.read_text(encoding="utf-8", errors="replace")
                if evidence_id not in test_text:
                    errors.append(GateError("TEST_MARKER_MISSING", f"{evidence_id}: {relative}"))
                symbol = test.get("symbol") if isinstance(test, dict) else None
                if isinstance(symbol, str) and symbol not in test_text:
                    errors.append(GateError("TEST_SYMBOL_MISSING", f"{evidence_id}: {symbol} in {relative}"))

        proof_refs = entry.get("proof_refs", [])
        if entry.get("status") in {"verified", "closed"} and not proof_refs:
            errors.append(GateError("VERIFICATION_PROOF_MISSING", evidence_id))
        elif not isinstance(proof_refs, list):
            errors.append(GateError("SCHEMA_INVALID", f"{evidence_id} proof_refs must be an array"))
        else:
            for proof_relative in proof_refs:
                if not isinstance(proof_relative, str):
                    errors.append(GateError("SCHEMA_INVALID", f"{evidence_id} proof ref must be a path"))
                    continue
                errors.extend(
                    validate_proof(repo_root, manifest, evidence_id, entry, proof_relative, mode)
                )
        if entry.get("status") == "closed":
            closure_proofs = []
            for proof_relative in proof_refs if isinstance(proof_refs, list) else []:
                try:
                    proof = read_json(repo_root / str(proof_relative))
                except ValueError:
                    continue
                if proof.get("proof_kind") == "closure" and proof.get("independent_review") is True:
                    closure_proofs.append(proof)
            if not closure_proofs:
                errors.append(GateError("CLOSURE_PROOF_MISSING", evidence_id))
            if entry.get("requirements", {}).get("device_verification_required") is True and not any(
                proof.get("runtime", {}).get("device_kind") == "physical" for proof in closure_proofs
            ):
                errors.append(GateError("PHYSICAL_DEVICE_PROOF_MISSING", evidence_id))

    if mode == "release":
        _, audit_errors = collect_audit_reports(
            repo_root,
            require_clean=True,
            require_all=True,
        )
        errors.extend(audit_errors)
        coverage = manifest.get("coverage", {})
        if coverage.get("release_inventory_complete") is not True:
            errors.append(GateError("RELEASE_INVENTORY_INCOMPLETE", "full reachable-route inventory is not closed"))
        required_release = manifest.get("required_release_evidence")
        if isinstance(required_release, dict):
            if required_release != {
                "source": "capability_inventory",
                "selector": "release_required",
            }:
                errors.append(GateError("SCHEMA_INVALID", "invalid required release evidence selector"))
            required_release_ids = [
                evidence_id
                for evidence_id, item in inventory.items()
                if item.get("release_required") is True
            ]
        elif isinstance(required_release, list):
            required_release_ids = required_release
        else:
            errors.append(GateError("SCHEMA_INVALID", "required_release_evidence is invalid"))
            required_release_ids = []
        for evidence_id in required_release_ids:
            entry = evidence.get(evidence_id)
            if entry is None:
                errors.append(GateError("RELEASE_EVIDENCE_MISSING", evidence_id))
            elif entry.get("status") != "closed" or entry.get("blockers"):
                errors.append(GateError("RELEASE_EVIDENCE_OPEN", evidence_id))
        try:
            status = subprocess.run(
                ["git", "status", "--porcelain", "--untracked-files=all"],
                cwd=repo_root,
                check=True,
                capture_output=True,
                text=True,
            ).stdout.strip()
            if status:
                errors.append(GateError("RELEASE_WORKTREE_DIRTY", "release attestation requires a clean worktree"))
        except (OSError, subprocess.CalledProcessError):
            errors.append(GateError("GIT_STATE_UNAVAILABLE", "could not verify release worktree state"))

    return sorted(set(errors), key=lambda error: (error.code, error.message))


def git_output(repo_root: Path, *args: str) -> str:
    return subprocess.run(
        ["git", *args],
        cwd=repo_root,
        check=True,
        capture_output=True,
        text=True,
    ).stdout.strip()


def write_attestation(repo_root: Path, manifest_path: Path, output: Path) -> None:
    manifest = read_json(manifest_path)
    source_catalog_path = repo_root / manifest["source_catalog"]
    capability_inventory_path = repo_root / manifest["capability_inventory"]
    lock_path = repo_root / manifest["source_lock"]
    deviations_path = repo_root / manifest["deviations"]
    product_scope_path = repo_root / manifest["product_scope"]
    tombstones_path = repo_root / manifest["tombstones"]
    audit_reports, audit_errors = collect_audit_reports(
        repo_root,
        require_clean=True,
        require_all=True,
    )
    if audit_errors:
        raise ValueError("; ".join(error.render() for error in audit_errors))
    attestation = {
        "schema_version": 1,
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "git_commit": git_output(repo_root, "rev-parse", "HEAD"),
        "baseline_id": manifest["baseline_id"],
        "source_catalog_sha256": sha256_file(source_catalog_path),
        "capability_inventory_sha256": sha256_file(capability_inventory_path),
        "source_lock_sha256": sha256_file(lock_path),
        "manifest_sha256": sha256_file(manifest_path),
        "deviations_sha256": sha256_file(deviations_path),
        "product_scope_sha256": sha256_file(product_scope_path),
        "tombstones_sha256": sha256_file(tombstones_path),
        "audit_reports": audit_reports,
        "closed_evidence": sorted(
            entry["id"] for entry in manifest["evidence"] if entry.get("status") == "closed"
        ),
        "artifact_sha256": None,
        "artifact_hash_location": "sidecar",
    }
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(attestation, indent=2, ensure_ascii=True) + "\n", encoding="utf-8")


def finalize_attestation(attestation_path: Path, artifact_path: Path, output: Path) -> None:
    attestation = read_json(attestation_path)
    attestation["artifact_sha256"] = sha256_file(artifact_path)
    attestation["artifact_size_bytes"] = artifact_path.stat().st_size
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(attestation, indent=2, ensure_ascii=True) + "\n", encoding="utf-8")


def record_proof(
    repo_root: Path,
    manifest_path: Path,
    evidence_id: str,
    report_path: Path,
    output: Path,
    proof_kind: str,
    device_kind: str,
    api_level: int | None,
    device_name: str | None,
) -> None:
    manifest = read_json(manifest_path)
    entries = {entry.get("id"): entry for entry in manifest.get("evidence", []) if isinstance(entry, dict)}
    entry = entries.get(evidence_id)
    if entry is None:
        raise ValueError(f"unknown evidence id {evidence_id}")
    report_path = report_path.resolve()
    try:
        report_relative = report_path.relative_to(repo_root).as_posix()
    except ValueError as error:
        raise ValueError("proof report must live under the repository root") from error
    result = junit_report(report_path)
    if result["tests"] <= 0 or result["failures"] or result["errors"]:
        raise ValueError("proof report must contain passing executed tests")
    case_names = {case["name"] for case in result["testcases"]}
    missing = [
        test["symbol"]
        for test in entry.get("tests", [])
        if isinstance(test, dict) and test.get("symbol") and test["symbol"] not in case_names
    ]
    if missing:
        raise ValueError(f"proof report is missing required testcases: {', '.join(missing)}")
    audit_reports, audit_errors = collect_audit_reports(
        repo_root,
        require_clean=False,
        require_all=False,
    )
    if audit_errors:
        raise ValueError("; ".join(error.render() for error in audit_errors))
    proof = {
        "schema_version": 1,
        "evidence_id": evidence_id,
        "proof_kind": proof_kind,
        "recorded_at": datetime.now(timezone.utc).isoformat(),
        "input_sha256": evidence_input_sha256(repo_root, manifest, entry),
        "report": {
            "path": report_relative,
            "sha256": sha256_file(report_path),
            **result,
        },
        "audit_reports": audit_reports,
        "runtime": {
            "device_kind": device_kind,
            "api_level": api_level,
            "device_name": device_name,
        },
        "independent_review": False,
    }
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(proof, indent=2, ensure_ascii=True) + "\n", encoding="utf-8")


def print_errors(errors: Iterable[GateError], json_output: bool) -> None:
    values = list(errors)
    if json_output:
        print(json.dumps([error.__dict__ for error in values], indent=2, ensure_ascii=True))
    else:
        for error in values:
            print(f"ERROR {error.render()}")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repo-root", type=Path, default=Path(__file__).resolve().parents[1])
    parser.add_argument("--manifest", type=Path, default=Path("evidence/feishu/manifest.json"))
    subparsers = parser.add_subparsers(dest="command", required=True)

    check = subparsers.add_parser("check")
    check.add_argument("--mode", choices=("static", "release"), default="static")
    check.add_argument("--source-root")
    check.add_argument("--json", action="store_true")

    attest = subparsers.add_parser("attest")
    attest.add_argument("--source-root")
    attest.add_argument("--output", type=Path, required=True)

    finalize = subparsers.add_parser("finalize")
    finalize.add_argument("--attestation", type=Path, required=True)
    finalize.add_argument("--artifact", type=Path, required=True)
    finalize.add_argument("--output", type=Path, required=True)

    proof = subparsers.add_parser("record-proof")
    proof.add_argument("--id", required=True)
    proof.add_argument("--report", type=Path, required=True)
    proof.add_argument("--output", type=Path)
    proof.add_argument("--proof-kind", default="androidTest")
    proof.add_argument("--device-kind", choices=("emulator", "physical", "host"), required=True)
    proof.add_argument("--api-level", type=int)
    proof.add_argument("--device-name")

    subparsers.add_parser("sync-docs")

    args = parser.parse_args()
    repo_root = args.repo_root.resolve()
    manifest_path = args.manifest if args.manifest.is_absolute() else repo_root / args.manifest

    if args.command == "finalize":
        finalize_attestation(args.attestation, args.artifact, args.output)
        return 0

    if args.command == "record-proof":
        report = args.report if args.report.is_absolute() else repo_root / args.report
        output = args.output or Path(f"evidence/feishu/proofs/{args.id}.json")
        output = output if output.is_absolute() else repo_root / output
        try:
            record_proof(
                repo_root,
                manifest_path,
                args.id,
                report,
                output,
                args.proof_kind,
                args.device_kind,
                args.api_level,
                args.device_name,
            )
        except ValueError as error:
            print(f"ERROR VERIFICATION_PROOF_INVALID: {error}")
            return 1
        print(f"Wrote verification proof to {output}")
        return 0

    if args.command == "sync-docs":
        manifest = read_json(manifest_path)
        errors = sync_ledger(repo_root, manifest, write=True)
        if errors:
            print_errors(errors, False)
            return 1
        print("Synchronized generated Feishu evidence status.")
        return 0

    source_root = resolve_source_root(args.source_root)
    mode = "release" if args.command == "attest" else args.mode
    errors = validate(repo_root, manifest_path, mode, source_root)
    if errors:
        print_errors(errors, getattr(args, "json", False))
        return 1
    if args.command == "attest":
        output = args.output if args.output.is_absolute() else repo_root / args.output
        try:
            write_attestation(repo_root, manifest_path, output)
        except ValueError as error:
            print(f"ERROR PARITY_ATTESTATION_INVALID: {error}")
            return 1
        print(f"Wrote parity attestation to {output}")
    else:
        print(f"Feishu evidence gate passed ({mode}).")
    return 0


if __name__ == "__main__":
    sys.exit(main())
