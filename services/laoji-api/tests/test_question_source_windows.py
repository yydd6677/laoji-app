import pytest

from app.services.question_source_windows import pack_sources, ground_parts


def sources():
    return [{"source_type": "transcript", "source_id": f"native-{i}", "source_revision_id": "revision",
             "content_sha256": f"hash-{i}", "source_start_utf8": 100 + i * 30,
             "text": text, "start_ms": i * 4000, "end_ms": (i + 1) * 4000}
            for i, text in enumerate(["张敏先评审接口，", "然后提交清单。", "其他话题稍后再说。"])]


def test_part_selection_returns_only_original_current_source_bytes():
    rows = sources()
    result = ground_parts(pack_sources(rows)[0], 0, 1, "e")
    assert [c["source_id"] for c in result["_members"]] == ["native-0", "native-1"]
    assert result["quote"] == "\n".join(row["text"] for row in rows[:2])
    for actual, original in zip(result["_members"], rows[:2]):
        assert actual["content_sha256"] == original["content_sha256"]
        assert actual["quote"] == original["text"]
        assert actual["source_start_utf8"] == original["source_start_utf8"]
        assert actual["source_end_utf8"] == original["source_start_utf8"] + len(original["text"].encode())


@pytest.mark.parametrize("change", ["revision", "type", "retrieval_gap", "audio_gap"])
def test_windows_never_cross_real_source_boundaries(change):
    rows = sources()
    if change == "revision": rows[1]["source_revision_id"] = "other"
    if change == "type": rows[1]["source_type"] = "manual_note"
    if change == "retrieval_gap": rows[1]["_original_index"] = 30
    if change == "audio_gap": rows[1]["start_ms"] = 100000
    assert len(pack_sources(rows)[0]["_members"]) == 1


@pytest.mark.parametrize("first,last", [(-1, 0), (0, 10), (1, 0), (True, 1), (0.0, 1)])
def test_invalid_coordinates_fail_without_quote_recovery(first, last):
    with pytest.raises(ValueError):
        ground_parts(pack_sources(sources())[0], first, last, "e")


def test_long_unicode_parent_is_losslessly_split_under_mobile_quote_limit():
    text = "😀第一行\n next step 20元。 " * 100 + "末尾依据。"
    source = {**sources()[0], "source_type": "manual_note", "text": text, "source_start_utf8": 300}
    windows = pack_sources([source])
    members = [m for w in windows for m in w["_members"]]
    assert "".join(m[2]["text"] for m in members) == text
    offset = 300
    for window in windows:
        cite = ground_parts(window, 0, 0, "e")["_members"][0]
        assert len(cite["quote"].encode("utf-16-le")) // 2 <= 600
        assert cite["source_start_utf8"] == offset
        offset = cite["source_end_utf8"]
        assert cite["content_sha256"] == source["content_sha256"]
    assert offset == 300 + len(text.encode())


def test_source_body_whitespace_is_never_normalized_by_display_packing():
    rows = sources()
    rows[0]["text"] = " 第一行\n\t第二行😀 "
    quote = ground_parts(pack_sources(rows)[0], 0, 0, "e")["_members"][0]["quote"]
    assert quote == rows[0]["text"]
