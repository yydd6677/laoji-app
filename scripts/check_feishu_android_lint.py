#!/usr/bin/env python3
"""Turn Android Lint XML into a deterministic, fail-closed evidence report."""

from __future__ import annotations

import argparse
import hashlib
import json
import sys
import xml.etree.ElementTree as ET
from collections import Counter
from pathlib import Path
from typing import Any


CUSTOM_ISSUES = {
    "FeishuHighRateBridge",
    "FeishuUnknownControl",
    "FeishuUnmappedAnimation",
    "FeishuUnmappedListener",
    "FeishuUnmappedResource",
}


class ReportError(ValueError):
    pass


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def relative_path(path: Path, repo_root: Path) -> str:
    try:
        return path.resolve().relative_to(repo_root.resolve()).as_posix()
    except ValueError:
        return path.resolve().as_posix()


def parse_report(
    report: Path,
    repo_root: Path,
    detector_jar: Path | None = None,
) -> dict[str, Any]:
    if not report.is_file():
        raise ReportError(f"Android Lint report is missing: {report}")
    try:
        root = ET.parse(report).getroot()
    except (ET.ParseError, OSError) as error:
        raise ReportError(f"Android Lint report is invalid: {report}: {error}") from error
    if root.tag != "issues":
        raise ReportError(f"Android Lint report root must be <issues>: {report}")

    issues: list[dict[str, Any]] = []
    for element in root.findall("issue"):
        issue_id = element.get("id")
        severity = element.get("severity")
        message = element.get("message")
        if not issue_id or not severity or message is None:
            raise ReportError("Android Lint issue is missing id, severity, or message")
        location = element.find("location")
        location_path = location.get("file") if location is not None else None
        issue = {
            "id": issue_id,
            "severity": severity,
            "message": message,
            "path": relative_path(Path(location_path), repo_root) if location_path else None,
            "line": int(location.get("line")) if location is not None and location.get("line") else None,
            "column": int(location.get("column")) if location is not None and location.get("column") else None,
            "custom": issue_id in CUSTOM_ISSUES,
        }
        issues.append(issue)

    by_id = Counter(issue["id"] for issue in issues)
    errors = [issue for issue in issues if issue["severity"].lower() in {"error", "fatal"}]
    custom_errors = [issue for issue in errors if issue["custom"]]
    result = {
        "schema_version": 1,
        "kind": "android-lint-uast",
        "parser": {
            "path": relative_path(Path(__file__), repo_root),
            "sha256": sha256_file(Path(__file__)),
        },
        "source_report": relative_path(report, repo_root),
        "source_report_sha256": sha256_file(report),
        "issue_count": len(issues),
        "error_count": len(errors),
        "custom_error_count": len(custom_errors),
        "counts_by_id": dict(sorted(by_id.items())),
        "errors": errors,
    }
    if detector_jar is not None:
        if not detector_jar.is_file():
            raise ReportError(f"Feishu Lint detector JAR is missing: {detector_jar}")
        result["detector_jar"] = {
            "path": relative_path(detector_jar, repo_root),
            "sha256": sha256_file(detector_jar),
        }
    return result


def write_report(result: dict[str, Any], output: Path | None) -> None:
    payload = json.dumps(result, indent=2, ensure_ascii=True) + "\n"
    if output is None:
        print(payload, end="")
        return
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(payload, encoding="utf-8")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=("check", "report"))
    parser.add_argument("--repo-root", type=Path, default=Path(__file__).resolve().parents[1])
    parser.add_argument("--report", type=Path, required=True)
    parser.add_argument("--detector-jar", type=Path)
    parser.add_argument("--output", type=Path)
    args = parser.parse_args()

    repo_root = args.repo_root.resolve()
    report = args.report if args.report.is_absolute() else repo_root / args.report
    output = args.output
    if output is not None and not output.is_absolute():
        output = repo_root / output
    detector_jar = args.detector_jar
    if detector_jar is not None and not detector_jar.is_absolute():
        detector_jar = repo_root / detector_jar
    try:
        result = parse_report(report, repo_root, detector_jar)
    except ReportError as error:
        print(f"ERROR FEISHU_ANDROID_LINT_REPORT_INVALID: {error}", file=sys.stderr)
        return 2
    write_report(result, output)

    if args.command == "check" and result["error_count"]:
        print(
            "ERROR FEISHU_ANDROID_LINT_FAILED: "
            f"{result['error_count']} Android Lint errors, "
            f"including {result['custom_error_count']} Feishu evidence errors; "
            f"report={result['source_report']}",
            file=sys.stderr,
        )
        return 1
    action = "passed" if args.command == "check" else "report generated"
    print(f"Feishu Android Lint {action} ({result['issue_count']} issues, {result['error_count']} errors).")
    return 0


if __name__ == "__main__":
    sys.exit(main())
