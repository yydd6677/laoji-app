#!/usr/bin/env python3
"""Static guard for the Stage 3 mobile source-stream wire contract.

This does not claim Android or server execution. It catches drift between the
server's received-count response, the mobile normalizer, and the bounded
resume/backpressure path before a device run is available.
"""

from __future__ import annotations

from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]


def require(path: Path, *needles: str) -> str:
    source = path.read_text(encoding="utf-8")
    missing = [needle for needle in needles if needle not in source]
    if missing:
        raise AssertionError(f"{path}: missing {missing}")
    return source


def main() -> None:
    client = ROOT / "src/services/deviceV2SourceStream.ts"
    summary = ROOT / "src/services/meetingSummaryV3SourceStream.ts"
    server = ROOT / "services/laoji-api/app/services/vnext_source_stream_store.py"

    client_source = require(
        client,
        "received_bundle_count: number",
        "received_item_count: number",
        "Number(group.received_bundle_count)",
        "Number(group.received_item_count)",
    )
    if "Number(group.bundle_count)" in client_source or "Number(group.item_count)" in client_source:
        raise AssertionError("mobile source-group normalizer still reads legacy count names")
    require(
        summary,
        "getDeviceV2SourceStream",
        "waitForSourceChapterSlot",
        "SOURCE_ADMISSION_LIMIT",
        "resumedTask.task.source_stream_id",
        "resumedTask.task.input_sha256",
        "appendSummaryManifestPages",
        "MANIFEST_PAGE_DESCRIPTORS",
        "current.next_manifest_chapter",
        "MANIFEST_CAPACITY",
    )
    require(server, "MAX_GROUPS_DEVICE = 2", '"received_bundle_count"', '"received_item_count"')
    print("stage3_source_stream_contract=passed")


if __name__ == "__main__":
    main()
