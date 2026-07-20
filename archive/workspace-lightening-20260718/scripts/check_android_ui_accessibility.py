#!/usr/bin/env python3
"""Fail when Android UIAutomator dumps expose unlabeled clickable controls."""

from __future__ import annotations

import argparse
from pathlib import Path
import sys
import xml.etree.ElementTree as ET


def has_meaningful_label(value: str) -> bool:
    return any(character.isalnum() for character in value)


def audit_dump(xml_path: Path) -> list[str]:
    failures: list[str] = []
    root = ET.parse(xml_path).getroot()
    for node in root.iter("node"):
        if node.attrib.get("clickable") != "true" or node.attrib.get("enabled") == "false":
            continue
        text = node.attrib.get("text", "").strip()
        description = node.attrib.get("content-desc", "").strip()
        if has_meaningful_label(f"{text} {description}"):
            continue
        resource_id = node.attrib.get("resource-id", "") or "<none>"
        bounds = node.attrib.get("bounds", "") or "<unknown>"
        failures.append(
            f"{xml_path.name}: unlabeled clickable control "
            f"resource-id={resource_id} bounds={bounds}"
        )
    return failures


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("dump_directory", type=Path)
    args = parser.parse_args()

    dump_directory = args.dump_directory.resolve()
    xml_files = sorted(
        path for path in dump_directory.glob("*.xml")
        if not path.name.endswith(".pretty.xml")
    )
    if not xml_files:
        print(f"No UIAutomator XML dumps found in {dump_directory}", file=sys.stderr)
        return 2

    failures = [failure for xml_path in xml_files for failure in audit_dump(xml_path)]
    if failures:
        print("Android UI accessibility audit failed:", file=sys.stderr)
        for failure in failures:
            print(f"- {failure}", file=sys.stderr)
        return 1

    print(f"Android UI accessibility audit passed ({len(xml_files)} dumps).")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
