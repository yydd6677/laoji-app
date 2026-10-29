"""Coherent model windows and lossless attribution to immutable source spans.

No semantic/keyword guessing, fuzzy quote recovery or lookup in another source.
The model sees one readable window; the public API still cites original rows.
"""
from __future__ import annotations

from typing import Any

WINDOW_CHARS = 420


def pack_sources(sources: list[dict[str, Any]]) -> list[dict[str, Any]]:
    # The mobile quote contract is <=600 UTF-16 code units. Split a long
    # parent losslessly, preserving its hash and absolute UTF-8 offsets; a
    # model must not force the client to accept an overlong/rewritten quote.
    expanded = []
    for index, parent in enumerate(sources):
        offset = int(parent.get("source_start_utf8") or 0)
        for start in range(0, len(parent["text"]), 256):
            text = parent["text"][start:start + 256]
            end = offset + len(text.encode("utf-8"))
            expanded.append({**parent, "text": text, "_original_index": int(parent.get("_original_index", index)),
                             "source_start_utf8": offset, "source_end_utf8": end})
            offset = end
    windows: list[dict[str, Any]] = []
    for index, source in enumerate(expanded):
        previous = windows[-1]["_members"][-1][2] if windows else None
        previous_index = windows[-1]["_members"][-1][3] if windows else -2
        contiguous = (previous is not None and source["source_type"] == "transcript"
            and previous["source_type"] == "transcript"
            and source["source_revision_id"] == previous["source_revision_id"]
            and int(source.get("_original_index", index)) == previous_index + 1
            and (previous.get("end_ms") is None or source.get("start_ms") is None
                 or int(source["start_ms"]) - int(previous["end_ms"]) <= 2000)
            and len(windows[-1]["text"]) + len(source["text"]) <= WINDOW_CHARS)
        if not contiguous:
            windows.append({"source_type": source["source_type"], "text": "",
                            "_model_alias": f"w{len(windows)}", "_members": []})
        window = windows[-1]
        # A newline is visible to the model and explicitly excluded from the
        # canonical member spans. It never changes a source's text or hash.
        if window["text"]:
            window["text"] += "\n"
        start = len(window["text"])
        window["text"] += source["text"]
        window["_members"].append((start, len(window["text"]), source, int(source.get("_original_index", index))))
    return windows




def ground_parts(window: dict[str, Any], first: int, last: int, citation_id: str) -> dict[str, Any]:
    """Model selects immutable part IDs, never regenerates the quoted text."""
    if (type(first) is not int or type(last) is not int
        or not 0 <= first <= last < len(window["_members"]) or last - first >= 8):
        raise ValueError("source_part_range_invalid")
    citations = []
    for _left, _right, source, _index in window["_members"][first:last + 1]:
        start = int(source.get("source_start_utf8") or 0)
        citations.append({"citation_id": f"{citation_id}-{len(citations) + 1}",
            **{key: source[key] for key in ("source_type", "source_id", "source_revision_id", "content_sha256")},
            "source_start_utf8": start, "source_end_utf8": start + len(source["text"].encode("utf-8")),
            "quote": source["text"]})
    return {"source_type": window["source_type"], "quote": "\n".join(cite["quote"] for cite in citations),
            "_members": citations}
