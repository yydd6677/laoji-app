from pathlib import Path

from probe_stage3_vertical import build_items


def _write_srt(path: Path, bodies: list[str], *, step_seconds: int = 10) -> None:
    def timestamp(total_seconds: int) -> str:
        hours, remainder = divmod(total_seconds, 3600)
        minutes, seconds = divmod(remainder, 60)
        return f"{hours:02d}:{minutes:02d}:{seconds:02d}"

    blocks = []
    for index, body in enumerate(bodies, start=1):
        start = (index - 1) * step_seconds
        end = start + 1
        blocks.append(
            f"{index}\n{timestamp(start)},000 --> {timestamp(end)},000\n{body}"
        )
    path.write_text("\n\n".join(blocks) + "\n", encoding="utf-8")


def test_build_items_matches_android_byte_packing(tmp_path: Path) -> None:
    source = tmp_path / "sample.srt"
    _write_srt(source, ["甲" * 10, "乙" * 10, "丙" * 10])

    chapters, _digest = build_items(source, chapter_bytes=61)

    assert [len(chapter) for chapter in chapters] == [2, 1]
    assert [item["content"] for chapter in chapters for item in chapter] == [
        "甲" * 10,
        "乙" * 10,
        "丙" * 10,
    ]


def test_optional_time_boundary_is_diagnostic_only(tmp_path: Path) -> None:
    source = tmp_path / "sample.srt"
    _write_srt(source, ["第一段", "第二段", "第三段"], step_seconds=40)

    byte_only, _digest = build_items(source, chapter_seconds=0, chapter_bytes=4096)
    time_split, _digest = build_items(source, chapter_seconds=60, chapter_bytes=4096)

    assert len(byte_only) == 1
    assert len(time_split) == 2
