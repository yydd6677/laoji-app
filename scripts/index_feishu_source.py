#!/usr/bin/env python3
"""Build a deterministic, source-only evidence index for Feishu feature code.

The index stores relative paths, hashes, declarations, symbol dependencies,
entry call graphs, Android resource references, and optional smali fallbacks.
It intentionally does not copy third-party source or resource contents into
the LaoJi repository. CAL-ROOT-001 / MIN-ROOT-001 / UI-SHELL-001.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import re
from pathlib import Path
from typing import Iterable


DEFAULT_GROUPS = {
    "calendar": (
        "java-sources/com/p325ss/android/lark/calendar",
        "java-sources/com/p325ss/android/lark/integrator/calendar",
        "java-sources/pd3",
    ),
    "minutes": (
        "java-sources/com/p325ss/android/lark/p446mm",
        "java-sources/com/p325ss/android/lark/minutes",
        "java-sources/com/p325ss/android/lark/officesdk/minutes",
        "java-sources/com/p325ss/android/lark/integrator/minutes",
    ),
    "common_ui": (
        "java-sources/com/p325ss/android/lark/insets",
        "java-sources/com/p325ss/android/lark/framework/assembly/navigation",
        "java-sources/com/p325ss/android/lark/framework/larkwidget",
        "java-sources/com/p325ss/android/lark/main/widget",
        "java-sources/com/p325ss/android/lark/maintab/launcher/widget",
        "java-sources/com/p325ss/android/lark/ui",
        "java-sources/com/p325ss/android/lark/widget",
    ),
}

PACKAGE_RE = re.compile(r"^\s*package\s+([A-Za-z0-9_.$]+)\s*;", re.MULTILINE)
IMPORT_RE = re.compile(r"^\s*import\s+(?:static\s+)?([A-Za-z0-9_.$*]+)\s*;", re.MULTILINE)
DECLARATION_RE = re.compile(
    r"\b(?:public\s+|protected\s+|private\s+|abstract\s+|final\s+|static\s+)*"
    r"(?:class|interface|enum)\s+([A-Za-z_$][A-Za-z0-9_$]*)"
)
RESOURCE_RE = re.compile(
    r"\bR\.(anim|animator|array|attr|bool|color|dimen|drawable|font|id|integer|"
    r"interpolator|layout|menu|mipmap|navigation|plurals|raw|string|style|transition|xml)"
    r"\.([A-Za-z0-9_]+)"
)
XML_RESOURCE_RE = re.compile(
    r"@\+?(anim|animator|array|attr|bool|color|dimen|drawable|font|id|integer|"
    r"interpolator|layout|menu|mipmap|navigation|plurals|raw|string|style|transition|xml)"
    r"/([A-Za-z0-9_.]+)"
)
VALUE_NAME_RE = re.compile(
    r"<(anim|animator|array|attr|bool|color|dimen|drawable|font|id|integer|"
    r"interpolator|layout|menu|mipmap|navigation|plurals|raw|string|style|transition|xml|item)"
    r"\b[^>]*\bname=\"([A-Za-z0-9_.]+)\"[^>]*"
)
ENTRY_SUFFIXES = (
    "Activity",
    "Fragment",
    "View",
    "Layout",
    "Dialog",
    "Sheet",
    "Presenter",
    "ViewModel",
    "Service",
    "Receiver",
)
TYPE_REFERENCE_RE = re.compile(r"\b([A-Z][A-Za-z0-9_$]{2,})\b")
METHOD_CALL_RE = re.compile(r"\b([A-Za-z_$][A-Za-z0-9_$]*)\s*\(")
CALL_KEYWORDS = {
    "if", "for", "while", "switch", "catch", "return", "throw", "new",
    "super", "this", "synchronized", "assert",
}


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def parse_group(value: str) -> tuple[str, tuple[str, ...]]:
    name, separator, roots = value.partition("=")
    parsed = tuple(item.strip().strip("/") for item in roots.split(",") if item.strip())
    if not separator or not name.strip() or not parsed:
        raise argparse.ArgumentTypeError("group must use NAME=relative/path,relative/path")
    return name.strip(), parsed


def iter_source_files(source_root: Path, roots: Iterable[str]) -> tuple[list[Path], list[str]]:
    files: set[Path] = set()
    missing: list[str] = []
    for relative_root in roots:
        target = source_root / relative_root
        if not target.is_dir():
            missing.append(relative_root)
            continue
        files.update(path for path in target.rglob("*.java") if path.is_file())
    return sorted(files), sorted(missing)


def scan_java(path: Path, source_root: Path) -> dict[str, object]:
    text = path.read_text(encoding="utf-8", errors="replace")
    package_match = PACKAGE_RE.search(text)
    declarations = sorted(set(DECLARATION_RE.findall(text)))
    imports = sorted(set(IMPORT_RE.findall(text)))
    type_references = sorted(set(TYPE_REFERENCE_RE.findall(text)) - set(declarations))
    method_calls = sorted({
        name for name in METHOD_CALL_RE.findall(text)
        if name not in CALL_KEYWORDS
    })
    resource_refs = sorted({f"{kind}/{name}" for kind, name in RESOURCE_RE.findall(text)})
    relative = path.relative_to(source_root).as_posix()
    return {
        "path": relative,
        "bytes": path.stat().st_size,
        "sha256": sha256_file(path),
        "package": package_match.group(1) if package_match else None,
        "declarations": declarations,
        "imports": imports,
        "type_references": type_references,
        "method_calls": method_calls,
        "entry_candidates": [name for name in declarations if name.endswith(ENTRY_SUFFIXES)],
        "resource_refs": resource_refs,
    }


def group_digest(files: list[dict[str, object]]) -> str:
    digest = hashlib.sha256()
    for item in files:
        digest.update(str(item["path"]).encode("utf-8"))
        digest.update(b"\0")
        digest.update(str(item["sha256"]).encode("ascii"))
        digest.update(b"\n")
    return digest.hexdigest()


def resource_definitions(res_root: Path, wanted: set[str]) -> dict[str, list[str]]:
    definitions: dict[str, set[str]] = {key: set() for key in wanted}
    if not res_root.is_dir() or not wanted:
        return {key: [] for key in sorted(wanted)}

    for path in sorted(item for item in res_root.rglob("*") if item.is_file()):
        relative = path.relative_to(res_root.parent.parent).as_posix()
        directory_kind = path.parent.name.split("-", 1)[0]
        direct_key = f"{directory_kind}/{path.stem}"
        if direct_key in definitions:
            definitions[direct_key].add(relative)

        if path.suffix.lower() != ".xml":
            continue
        text = path.read_text(encoding="utf-8", errors="replace")
        for kind, name in XML_RESOURCE_RE.findall(text):
            key = f"{kind}/{name}"
            if key in definitions:
                definitions[key].add(relative)
        if directory_kind == "values":
            for kind, name in VALUE_NAME_RE.findall(text):
                if kind == "item":
                    continue
                key = f"{kind}/{name}"
                if key in definitions:
                    definitions[key].add(relative)

    return {key: sorted(paths) for key, paths in sorted(definitions.items())}


def build_symbol_graph(group_results: dict[str, object]) -> tuple[list[dict[str, object]], list[dict[str, object]]]:
    symbols: list[dict[str, object]] = []
    fqcn_paths: dict[str, str] = {}
    simple_paths: dict[str, set[str]] = {}
    path_items: dict[str, dict[str, object]] = {}

    for group_name, group in group_results.items():
        for item in group["files"]:
            path = str(item["path"])
            path_items[path] = item
            package = item["package"]
            for declaration in item["declarations"]:
                fqcn = f"{package}.{declaration}" if package else str(declaration)
                fqcn_paths[fqcn] = path
                simple_paths.setdefault(str(declaration), set()).add(path)
                symbols.append({
                    "name": declaration,
                    "fqcn": fqcn,
                    "path": path,
                    "group": group_name,
                    "entry_candidate": declaration in item["entry_candidates"],
                })

    reverse: dict[str, set[str]] = {path: set() for path in path_items}
    edges: set[tuple[str, str, str]] = set()
    for caller, item in path_items.items():
        dependencies: set[str] = set()
        for imported in item["imports"]:
            normalized = str(imported).removesuffix(".*")
            target = fqcn_paths.get(normalized)
            if target and target != caller:
                dependencies.add(target)
                edges.add((caller, target, "import"))
        for name in item["type_references"]:
            targets = simple_paths.get(str(name), set())
            if len(targets) != 1:
                continue
            target = next(iter(targets))
            if target == caller:
                continue
            dependencies.add(target)
            edges.add((caller, target, "symbol"))
        item["dependencies"] = sorted(dependencies)
        for target in dependencies:
            reverse[target].add(caller)

    for path, item in path_items.items():
        item["referenced_by"] = sorted(reverse[path])

    entry_graph = []
    for item in path_items.values():
        if not item["entry_candidates"]:
            continue
        entry_graph.append({
            "path": item["path"],
            "entries": item["entry_candidates"],
            "dependencies": item["dependencies"],
            "callers": item["referenced_by"],
        })
    return (
        sorted(symbols, key=lambda value: (str(value["fqcn"]), str(value["path"]))),
        sorted(entry_graph, key=lambda value: str(value["path"])),
    )


def smali_prefix(java_root: str) -> str | None:
    if not java_root.startswith("java-sources/"):
        return None
    value = java_root.removeprefix("java-sources/")
    return value.replace("com/p325ss/", "com/ss/", 1).strip("/")


def build_smali_inventory(
    source_root: Path,
    groups: dict[str, tuple[str, ...]],
) -> dict[str, object]:
    smali_root = source_root / "smali"
    result: dict[str, object] = {}
    if not smali_root.is_dir():
        return result
    class_roots = sorted(path for path in smali_root.glob("smali*") if path.is_dir())
    for group_name, java_roots in sorted(groups.items()):
        prefixes = tuple(filter(None, (smali_prefix(value) for value in java_roots)))
        files: list[dict[str, object]] = []
        for class_root in class_roots:
            for prefix in prefixes:
                target = class_root / prefix
                if not target.is_dir():
                    continue
                for path in sorted(target.rglob("*.smali")):
                    files.append({
                        "path": path.relative_to(source_root).as_posix(),
                        "bytes": path.stat().st_size,
                        "sha256": sha256_file(path),
                    })
        result[group_name] = {
            "prefixes": list(prefixes),
            "file_count": len(files),
            "total_bytes": sum(int(item["bytes"]) for item in files),
            "manifest_sha256": group_digest(files),
            "files": files,
        }
    return result


def build_index(
    source_root: Path,
    groups: dict[str, tuple[str, ...]],
    include_smali: bool = False,
) -> dict[str, object]:
    summary_path = source_root / "ANALYSIS_SUMMARY.md"
    group_results: dict[str, object] = {}
    referenced_by: dict[str, set[str]] = {}

    for group_name, roots in sorted(groups.items()):
        paths, missing = iter_source_files(source_root, roots)
        files = [scan_java(path, source_root) for path in paths]
        for item in files:
            for resource_ref in item["resource_refs"]:
                referenced_by.setdefault(str(resource_ref), set()).add(str(item["path"]))
        group_results[group_name] = {
            "roots": list(roots),
            "missing_roots": missing,
            "file_count": len(files),
            "total_bytes": sum(int(item["bytes"]) for item in files),
            "manifest_sha256": group_digest(files),
            "entry_candidate_count": sum(len(item["entry_candidates"]) for item in files),
            "files": files,
        }

    symbols, entry_graph = build_symbol_graph(group_results)

    definitions = resource_definitions(
        source_root / "decoded-resources" / "res",
        set(referenced_by),
    )
    resources = [
        {
            "key": key,
            "definitions": definitions.get(key, []),
            "referenced_by": sorted(referenced_by[key]),
        }
        for key in sorted(referenced_by)
    ]
    return {
        "schema_version": 2,
        "baseline": {
            "analysis_summary_sha256": sha256_file(summary_path) if summary_path.is_file() else None,
            "java_source_root": "java-sources",
            "resource_root": "decoded-resources/res",
        },
        "groups": group_results,
        "symbols": symbols,
        "entry_call_graph": entry_graph,
        "resources": resources,
        "smali": build_smali_inventory(source_root, groups) if include_smali else {},
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source-root", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument(
        "--group",
        action="append",
        default=[],
        type=parse_group,
        help="replace defaults with NAME=relative/path,relative/path (repeatable)",
    )
    parser.add_argument(
        "--include-smali",
        action="store_true",
        help="index matching smali package trees for decompiler fallback evidence",
    )
    args = parser.parse_args()

    source_root = args.source_root.expanduser().resolve()
    if not (source_root / "java-sources").is_dir():
        parser.error(f"not a Feishu analysis root: {source_root}")
    groups = dict(args.group) if args.group else DEFAULT_GROUPS
    result = build_index(source_root, groups, include_smali=args.include_smali)

    output = args.output.expanduser().resolve()
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(
        json.dumps(result, ensure_ascii=True, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )
    print(
        json.dumps(
            {
                "output": str(output),
                "groups": {
                    name: {
                        "files": data["file_count"],
                        "bytes": data["total_bytes"],
                        "missing_roots": data["missing_roots"],
                    }
                    for name, data in result["groups"].items()
                },
                "resources": len(result["resources"]),
                "symbols": len(result["symbols"]),
                "entry_graph": len(result["entry_call_graph"]),
                "smali": {
                    name: data["file_count"]
                    for name, data in result["smali"].items()
                },
            },
            ensure_ascii=False,
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
