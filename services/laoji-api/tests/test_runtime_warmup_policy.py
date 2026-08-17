from app import runtime_policy


def test_model_warmup_flag_uses_supplied_default(monkeypatch):
    monkeypatch.delenv("MEETING_ASR_WARMUP_ENABLED", raising=False)

    assert runtime_policy.env_enabled(
        "MEETING_ASR_WARMUP_ENABLED",
        False,
    ) is False


def test_model_warmup_can_be_enabled_explicitly(monkeypatch):
    monkeypatch.setenv("MEETING_ASR_WARMUP_ENABLED", "1")

    assert runtime_policy.env_enabled(
        "MEETING_ASR_WARMUP_ENABLED",
        False,
    ) is True
