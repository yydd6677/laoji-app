#!/usr/bin/env python3
"""Generate or verify the deterministic Feishu source lock from its catalog."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import sys
from pathlib import Path
from typing import Any


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def read_json(path: Path) -> dict[str, Any]:
    value = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(value, dict):
        raise ValueError(f"JSON root must be an object: {path}")
    return value


def stable_id(group: str, relative: str) -> str:
    stem = re.sub(r"[^a-z0-9]+", "-", Path(relative).stem.lower()).strip("-")[:40]
    suffix = hashlib.sha256(relative.encode("utf-8")).hexdigest()[:8]
    return f"{group}-{stem}-{suffix}"


def resolve_source_root(explicit: Path | None) -> Path:
    candidates: list[Path] = []
    if explicit is not None:
        candidates.append(explicit.expanduser())
    configured = os.environ.get("FEISHU_SOURCE_ROOT")
    if configured:
        candidates.append(Path(configured).expanduser())
    candidates.extend(
        [
            Path.home() / "文档" / "apk-analysis" / "base-feishu-7.71.8",
            Path.home() / "Documents" / "apk-analysis" / "base-feishu-7.71.8",
        ]
    )
    source_root = next((candidate.resolve() for candidate in candidates if candidate.is_dir()), None)
    if source_root is None:
        raise ValueError(
            "Feishu source root not found; pass --source-root or set FEISHU_SOURCE_ROOT"
        )
    return source_root


def build_lock(catalog_path: Path, source_root: Path) -> dict[str, Any]:
    catalog = read_json(catalog_path)
    if catalog.get("schema_version") != 1:
        raise ValueError("source catalog schema_version must equal 1")
    overrides = catalog.get("id_overrides", {})
    if not isinstance(overrides, dict):
        raise ValueError("id_overrides must be an object")

    entries: list[dict[str, str]] = []
    paths_seen: set[str] = set()
    ids_seen: set[str] = set()
    groups = catalog.get("groups")
    if not isinstance(groups, list) or not groups:
        raise ValueError("source catalog must contain groups")
    for group in groups:
        if not isinstance(group, dict) or not isinstance(group.get("id"), str):
            raise ValueError("every source group must have a string id")
        group_id = group["id"]
        paths = group.get("paths")
        if not isinstance(paths, list) or not paths:
            raise ValueError(f"source group {group_id} has no paths")
        for relative in paths:
            if not isinstance(relative, str) or relative in paths_seen:
                raise ValueError(f"duplicate or invalid source path: {relative}")
            paths_seen.add(relative)
            target = source_root / relative
            if not target.is_file():
                raise ValueError(f"locked source file is missing: {relative}")
            identifier = overrides.get(relative, stable_id(group_id, relative))
            if not isinstance(identifier, str) or identifier in ids_seen:
                raise ValueError(f"duplicate or invalid source id: {identifier}")
            ids_seen.add(identifier)
            entries.append({
                "id": identifier,
                "group": group_id,
                "path": relative,
                "sha256": sha256_file(target),
            })

    absent = catalog.get("absent", [])
    if not isinstance(absent, list):
        raise ValueError("absent must be an array")
    normalized_absent = []
    for item in absent:
        if not isinstance(item, dict) or not isinstance(item.get("path"), str):
            raise ValueError("every absent entry must contain a path")
        if (source_root / item["path"]).exists():
            raise ValueError(f"source marked absent now exists: {item['path']}")
        normalized_absent.append({
            "path": item["path"],
            "reason": str(item.get("reason", "")),
        })

    return {
        "schema_version": 1,
        "baseline": {
            "id": catalog["baseline_id"],
            "version": "7.71.8",
            "description": "Decoded Feishu Android source and resources used as the UI behavior authority.",
            "catalog_sha256": sha256_file(catalog_path),
        },
        "files": sorted(entries, key=lambda item: (item["group"], item["path"])),
        "absent": sorted(normalized_absent, key=lambda item: item["path"]),
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=("check", "write"))
    parser.add_argument("--repo-root", type=Path, default=Path(__file__).resolve().parents[1])
    parser.add_argument("--source-root", type=Path)
    parser.add_argument("--catalog", type=Path, default=Path("evidence/feishu/source-catalog.json"))
    parser.add_argument("--output", type=Path, default=Path("evidence/feishu/source-lock.json"))
    args = parser.parse_args()

    repo_root = args.repo_root.resolve()
    catalog = args.catalog if args.catalog.is_absolute() else repo_root / args.catalog
    output = args.output if args.output.is_absolute() else repo_root / args.output
    try:
        value = build_lock(catalog, resolve_source_root(args.source_root))
    except (OSError, ValueError, json.JSONDecodeError) as error:
        print(f"ERROR FEISHU_SOURCE_CATALOG_INVALID: {error}", file=sys.stderr)
        return 1
    rendered = json.dumps(value, indent=2, ensure_ascii=True) + "\n"
    if args.command == "write":
        output.parent.mkdir(parents=True, exist_ok=True)
        output.write_text(rendered, encoding="utf-8")
        print(f"Wrote {len(value['files'])} source locks to {output}")
        return 0
    if not output.is_file() or output.read_text(encoding="utf-8") != rendered:
        print("ERROR FEISHU_SOURCE_LOCK_STALE: run update_feishu_source_lock.py write", file=sys.stderr)
        return 1
    print(f"Feishu source lock is current ({len(value['files'])} files, {len(value['absent'])} absent resources).")
    return 0


if __name__ == "__main__":
    sys.exit(main())
