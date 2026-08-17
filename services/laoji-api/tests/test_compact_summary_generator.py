import json

import pytest

from app.services import app_summary_generator as generator


def test_summary_config_uses_single_compact_provider_without_local_file(monkeypatch):
    monkeypatch.setenv("LAOJI_OLLAMA_BASE_URL", "http://127.0.0.1:21434")
    monkeypatch.setenv("MEETING_SUMMARY_MODEL", "qwen3.5:9b")

    config = generator._load_config()

    assert config.base_url == "http://127.0.0.1:21434"
    assert config.model == "qwen3.5:9b"
    assert config.provider == "ollama"
    assert config.api_key == ""


def test_compact_summary_threshold_is_configurable(monkeypatch):
    monkeypatch.setenv("APP_SUMMARY_COMPACT_MAX_CHARS", "300")

    assert generator.should_use_compact_summary("会议内容") is True
    assert generator.should_use_compact_summary("会" * 301) is False
    assert generator.should_use_compact_summary("   ") is False


def test_compact_summary_default_covers_common_long_app_transcripts(monkeypatch):
    monkeypatch.delenv("APP_SUMMARY_COMPACT_MAX_CHARS", raising=False)

    assert generator.compact_summary_max_chars() == 12000
    assert generator.should_use_compact_summary("会" * 12000) is True
    assert generator.should_use_compact_summary("会" * 12001) is False


def test_long_input_compaction_preserves_signals_and_collapses_repetition():
    transcript = "\n".join([
        "【会议上下文】",
        "会议标题：发布评审",
        "主持人：最终决定 8 月 3 日启用双令牌。",
        "何岚：兼容清单由我负责，截止 7 月 24 日。",
        *[
            f"成员{index}：第{index}轮状态与上周相近，没有新增交付事项或截止日期。"
            for index in range(1, 121)
        ],
        "主持人：收尾确认只有上述决定和行动。",
    ])

    result = generator.prepare_compact_summary_input(transcript, max_chars=1200)

    assert result is not None
    assert len(result) <= 1200
    assert "最终决定 8 月 3 日启用双令牌" in result
    assert "兼容清单由我负责，截止 7 月 24 日" in result
    assert "收尾确认只有上述决定和行动" in result
    assert result.count("状态与上周相近") == 1


def test_long_input_compaction_preserves_correction_and_cancellation():
    transcript = "\n".join([
        "会议标题：审计评审",
        "审计经理：最初草案由孙清负责，截止 7 月 20 日。",
        *(f"成员{index}：第{index}轮只解释材料来源。" for index in range(100)),
        "审计经理：正式更正，孙清安排作废，最终改由高乔负责，截止 7 月 23 日。",
    ])

    result = generator.prepare_compact_summary_input(transcript, max_chars=800)

    assert result is not None
    assert "最初草案由孙清负责" in result
    assert "孙清安排作废" in result
    assert "最终改由高乔负责" in result


def test_long_input_compaction_refuses_to_truncate_dense_priority_evidence():
    transcript = "\n".join(
        f"主持人：最终决定第{index}项方案由负责人{index}在月底前完成。"
        for index in range(100)
    )

    assert generator.prepare_compact_summary_input(transcript, max_chars=300) is None


def test_compact_summary_uses_json_contract_and_configured_12288_context(tmp_path, monkeypatch):
    prompt = tmp_path / "app-summary.txt"
    prompt.write_text("只返回 JSON", encoding="utf-8")
    captured = {}

    def fake_call(config, **kwargs):
        captured.update(kwargs)
        return json.dumps({
            "candidate_contract_version": 2,
            "overview": "确认发布范围。",
            "key_decisions": ["Android 先发布"],
            "action_items": [
                {
                    "content": "修复登录崩溃",
                    "candidate_type": "short_term_task",
                    "calendar_fitness": "high",
                    "time_scope": "short_term",
                    "assignee": "李工",
                    "due_date": "2026-07-15",
                    "source_segment_id": "seg-1",
                    "source_quote": "确认 Android 先发布",
                    "confidence": 0.9,
                    "reason": "具体且有截止日期",
                },
            ],
        }, ensure_ascii=False)

    monkeypatch.setattr(generator, "APP_SUMMARY_PROMPT_PATH", prompt)
    monkeypatch.setattr(generator, "_load_config", lambda: object())
    monkeypatch.setattr(generator, "call_ollama", fake_call)

    result = generator.generate_compact_summary("张敏：确认 Android 先发布。")

    assert result["overview"] == "确认发布范围。"
    assert result["action_items"][0]["assignee"] == "李工"
    assert captured["options"] == {"num_ctx": 12288, "temperature": 0}
    assert captured["max_tokens"] == 1536
    assert captured["response_format"] == "json"


def test_compact_summary_retries_once_with_constrained_object_prompt(tmp_path, monkeypatch):
    prompt = tmp_path / "app-summary.txt"
    prompt.write_text("只返回 JSON", encoding="utf-8")
    calls = []

    def fake_call(_config, **kwargs):
        calls.append(kwargs)
        if len(calls) == 1:
            return "[[]]"
        return json.dumps({
            "candidate_contract_version": 2,
            "overview": "确认发布范围。",
            "key_decisions": [],
            "action_items": [],
        }, ensure_ascii=False)

    monkeypatch.setattr(generator, "APP_SUMMARY_PROMPT_PATH", prompt)
    monkeypatch.setattr(generator, "_compact_model_config", lambda: type("Config", (), {"provider": "ollama"})())
    monkeypatch.setattr(generator, "call_ollama", fake_call)

    result = generator.generate_compact_summary("张敏：确认 Android 先发布。")

    assert result["overview"] == "确认发布范围。"
    assert len(calls) == 2
    assert calls[0]["telemetry_operation"] == "summary.compact"
    assert calls[1]["telemetry_operation"] == "summary.compact.recovery"
    assert "顶层必须是单个 JSON object" in calls[1]["system_prompt"]


def test_compact_summary_fails_after_one_invalid_recovery(tmp_path, monkeypatch):
    prompt = tmp_path / "app-summary.txt"
    prompt.write_text("只返回 JSON", encoding="utf-8")
    calls = []

    def fake_call(_config, **kwargs):
        calls.append(kwargs)
        return "[[]]"

    monkeypatch.setattr(generator, "APP_SUMMARY_PROMPT_PATH", prompt)
    monkeypatch.setattr(generator, "_compact_model_config", lambda: type("Config", (), {"provider": "ollama"})())
    monkeypatch.setattr(generator, "call_ollama", fake_call)

    with pytest.raises(generator.CompactSummaryError, match="constrained retry"):
        generator.generate_compact_summary("张敏：确认 Android 先发布。")

    assert len(calls) == 2


def test_compact_summary_rejects_invalid_array_types():
    with pytest.raises(generator.CompactSummaryError):
        generator._normalize_compact_result({
            "overview": "有内容",
            "key_decisions": "不是数组",
            "action_items": [],
        })


def test_compact_summary_requires_nonempty_overview():
    with pytest.raises(generator.CompactSummaryError):
        generator._normalize_compact_result({
            "overview": "",
            "key_decisions": [],
            "action_items": [],
        })


def test_progressive_summary_resumes_completed_map_blocks(monkeypatch):
    monkeypatch.setattr(generator, "compact_summary_max_chars", lambda: 600)
    calls = []

    def fake_generate(text, **kwargs):
        calls.append((text, kwargs))
        return {
            "overview": f"整理{len(calls)}",
            "key_decisions": [],
            "action_items": [],
        }

    monkeypatch.setattr(generator, "generate_compact_summary", fake_generate)
    transcript = "\n".join(f"发言人：这是第{index}段需要保留的真实会议内容。" for index in range(40))
    saved = {}

    def interrupt_after_first(checkpoint):
        saved.clear()
        saved.update(json.loads(json.dumps(checkpoint, ensure_ascii=False)))
        raise RuntimeError("模拟进程中断")

    with pytest.raises(RuntimeError, match="模拟进程中断"):
        generator.generate_progressive_summary(
            transcript,
            authorized_context_prompt="历史背景",
            meeting_context_prompt="本场附件",
            checkpoint_callback=interrupt_after_first,
        )
    first_block = calls[0][0]
    calls.clear()

    result = generator.generate_progressive_summary(
        transcript,
        authorized_context_prompt="历史背景",
        meeting_context_prompt="本场附件",
        checkpoint=saved,
        checkpoint_callback=lambda checkpoint: saved.update(checkpoint),
    )

    assert result["overview"].startswith("整理")
    assert all(text != first_block for text, _kwargs in calls)
    assert calls[-1][1]["authorized_context_prompt"] == "历史背景"
    assert calls[-1][1]["meeting_context_prompt"] == "本场附件"
