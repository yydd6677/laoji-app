from __future__ import annotations

from evaluate_asr_srt_diagnostic import (
    build_windows,
    chinese_integer,
    levenshtein,
    normalize_text,
    numeric_tokens,
    parse_srt,
    percentile,
)


def test_srt_windows_are_nonempty_and_bounded(tmp_path) -> None:
    source = tmp_path / "sample.srt"
    source.write_text(
        "1\n00:00:00,000 --> 00:00:04,000\n明天下午三点开会\n\n"
        "2\n00:00:04,100 --> 00:00:08,000\n地点在三号会议室\n\n"
        "3\n00:00:12,000 --> 00:00:16,000\n讨论发布计划和分工\n",
        encoding="utf-8",
    )
    cues = parse_srt(source)
    windows = build_windows(cues, target_ms=7000, windows_per_source=3)
    assert len(cues) == 3
    assert windows[0][:2] == (0, 8000)
    assert "明天下午三点" in windows[0][2]


def test_unicode_cer_and_numeric_normalization() -> None:
    reference = normalize_text("明天下午三点，到五点。")
    prediction = normalize_text("明天下午3点到5点")
    assert levenshtein(reference, prediction) == 2
    assert chinese_integer("三") == 3
    assert chinese_integer("十五") == 15
    assert numeric_tokens("三点到十五点，预算20万") == numeric_tokens("3点到15点，预算20万")
    assert numeric_tokens("预算二十万") == numeric_tokens("预算20万")
    assert numeric_tokens("报价百分之四十八") == numeric_tokens("报价48%")
    assert numeric_tokens("十天") != numeric_tokens("10年")


def test_percentile_uses_nearest_rank() -> None:
    assert percentile([0.1, 0.2, 0.3, 0.4, 0.5], 0.5) == 0.3
    assert percentile([0.1, 0.2, 0.3, 0.4, 0.5], 0.95) == 0.5
