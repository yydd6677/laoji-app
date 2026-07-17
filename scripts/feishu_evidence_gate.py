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


@dataclass(frozen=True)
class GateError:
    code: str
    message: str

    def render(self) -> str:
        return f"{self.code}: {self.message}"


def read_json(path: Path) -> dict[str, Any]:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError as error:
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
    deviations = repo_root / str(manifest.get("deviations", ""))
    return canonical_sha256(
        {
            "baseline_id": manifest.get("baseline_id"),
            "entry": stable_entry,
            "files": files,
            "source_lock_sha256": sha256_file(source_lock) if source_lock.is_file() else None,
            "deviations_sha256": sha256_file(deviations) if deviations.is_file() else None,
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
        f"- Release inventory complete: `{'yes' if coverage.get('release_inventory_complete') else 'no'}`",
        "- 未纳入当前 manifest 的既有 UI/交互条目统一视为 `未审阅`。",
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


def validate(
    repo_root: Path,
    manifest_path: Path,
    mode: str,
    source_root: Path | None,
) -> list[GateError]:
    errors: list[GateError] = []
    try:
        manifest = read_json(manifest_path)
        lock_path = repo_root / str(manifest.get("source_lock", ""))
        deviations_path = repo_root / str(manifest.get("deviations", ""))
        source_lock = read_json(lock_path)
        deviations_doc = read_json(deviations_path)
    except ValueError as error:
        return [GateError("SCHEMA_INVALID", str(error))]

    if manifest.get("schema_version") != 1 or source_lock.get("schema_version") != 1:
        errors.append(GateError("SCHEMA_INVALID", "schema_version must equal 1"))
    if manifest.get("baseline_id") != source_lock.get("baseline", {}).get("id"):
        errors.append(GateError("BASELINE_MISMATCH", "manifest baseline does not match source lock"))

    source_files = unique_objects(source_lock.get("files"), "id", "source files", errors)
    deviations = unique_objects(deviations_doc.get("deviations"), "id", "deviations", errors)
    evidence = unique_objects(manifest.get("evidence"), "id", "evidence", errors)
    errors.extend(sync_ledger(repo_root, manifest, write=False))

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
                elif evidence_id not in target.read_text(encoding="utf-8", errors="replace"):
                    errors.append(GateError("TEST_MARKER_MISSING", f"{evidence_id}: {relative}"))

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
        coverage = manifest.get("coverage", {})
        if coverage.get("release_inventory_complete") is not True:
            errors.append(GateError("RELEASE_INVENTORY_INCOMPLETE", "full reachable-route inventory is not closed"))
        for evidence_id in manifest.get("required_release_evidence", []):
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
    lock_path = repo_root / manifest["source_lock"]
    deviations_path = repo_root / manifest["deviations"]
    attestation = {
        "schema_version": 1,
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "git_commit": git_output(repo_root, "rev-parse", "HEAD"),
        "baseline_id": manifest["baseline_id"],
        "source_lock_sha256": sha256_file(lock_path),
        "manifest_sha256": sha256_file(manifest_path),
        "deviations_sha256": sha256_file(deviations_path),
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
        write_attestation(repo_root, manifest_path, output)
        print(f"Wrote parity attestation to {output}")
    else:
        print(f"Feishu evidence gate passed ({mode}).")
    return 0


if __name__ == "__main__":
    sys.exit(main())
