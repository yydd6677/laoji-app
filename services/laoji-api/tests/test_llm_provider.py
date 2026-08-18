from __future__ import annotations

from collections import namedtuple
from pathlib import Path
import threading
import time

import pytest

from app.services import llm_provider


Config = namedtuple("Config", "base_url model provider api_key chat_path")


def test_chat_forces_single_21434_provider_and_generation_model(monkeypatch):
    captured = {}

    def transport(config, system_prompt, transcript, **options):
        captured.update(
            config=config,
            system_prompt=system_prompt,
            transcript=transcript,
            options=options,
        )
        return "ok"

    monkeypatch.setattr(llm_provider, "_call_ollama_transport", transport)
    result = llm_provider.call_llm(
        Config("http://127.0.0.1:11434", "wrong", "openai_compatible", "secret", "/chat"),
        "system",
        "input",
        priority="interactive",
        telemetry_operation="test.chat",
    )

    assert result == "ok"
    assert captured["config"].base_url == "http://127.0.0.1:21434"
    assert captured["config"].model == "qwen3.5:9b"
    assert captured["config"].provider == "ollama"
    assert captured["config"].api_key == ""


def test_direct_ollama_transport_uses_chat_contract(monkeypatch):
    captured = {}

    class Response:
        def raise_for_status(self):
            return None

        def json(self):
            return {"message": {"content": "模型结果"}}

    def post(url, **kwargs):
        captured.update(url=url, **kwargs)
        return Response()

    monkeypatch.setattr(llm_provider._SESSION, "post", post)
    result = llm_provider._call_ollama_transport(
        Config("http://127.0.0.1:21434", "qwen3.5:9b", "ollama", "", "/api/chat"),
        "系统约束",
        "用户内容",
        max_tokens=321,
        response_format="json",
        priority="background",
        telemetry_operation="test.direct.chat",
    )

    assert result == "模型结果"
    assert captured["url"] == "http://127.0.0.1:21434/api/chat"
    assert captured["json"]["messages"][0]["content"].startswith("/no_think\n")
    assert captured["json"]["options"]["num_predict"] == 321
    assert captured["json"]["format"] == "json"
    assert captured["headers"]["X-Laoji-Priority"] == "background"


def test_invalid_ollama_fallback_port_is_rejected(monkeypatch):
    monkeypatch.setenv("LAOJI_OLLAMA_BASE_URL", "http://127.0.0.1:21436")
    with pytest.raises(llm_provider.LlmProviderError, match="ollama_base_url_invalid"):
        llm_provider.canonical_ollama_base_url()


def test_pending_interactive_llm_job_precedes_pending_background_job():
    coordinator = llm_provider._ProviderCoordinator()
    first_started = threading.Event()
    release_first = threading.Event()
    order: list[str] = []
    results: dict[str, str] = {}

    def work(name: str):
        def invoke():
            order.append(name)
            if name == "first":
                first_started.set()
                assert release_first.wait(5)
            return name

        results[name] = coordinator.submit(
            priority="interactive" if name == "live" else "background",
            operation=name,
            call=invoke,
            wait_seconds=5,
        )

    first = threading.Thread(target=work, args=("first",))
    later = threading.Thread(target=work, args=("later",))
    live = threading.Thread(target=work, args=("live",))
    first.start()
    assert first_started.wait(5)
    later.start()
    live.start()
    deadline = time.monotonic() + 5
    while time.monotonic() < deadline and coordinator.snapshot()["depth"] < 2:
        time.sleep(0.01)
    release_first.set()
    for thread in (first, later, live):
        thread.join(5)
        assert not thread.is_alive()

    assert order == ["first", "live", "later"]
    assert results == {"first": "first", "live": "live", "later": "later"}
    assert set(coordinator.snapshot()["last_by_operation"]) == {
        "first",
        "live",
        "later",
    }


def test_embedding_uses_same_21434_and_keeps_model_loaded(monkeypatch):
    captured = {}

    class Response:
        def raise_for_status(self):
            return None

        def json(self):
            return {"embeddings": [[3.0, 4.0]]}

    def post(url, **kwargs):
        captured.update(url=url, **kwargs)
        return Response()

    monkeypatch.setattr(llm_provider._SESSION, "post", post)
    result = llm_provider.embed_texts(["会议问题"])

    assert result == [(0.6, 0.8)]
    assert captured["url"] == "http://127.0.0.1:21434/api/embed"
    assert captured["json"]["model"] == "qwen3-embedding:0.6b"
    assert captured["json"]["keep_alive"] == -1
    assert captured["json"]["options"] == {"num_ctx": 8192}


def test_embedding_timeout_is_normalized_to_provider_error(monkeypatch):
    def timeout(*_args, **_kwargs):
        raise llm_provider.requests.ReadTimeout("embedding timed out")

    monkeypatch.setattr(llm_provider._SESSION, "post", timeout)
    with pytest.raises(llm_provider.LlmProviderError, match="ollama_embedding_timeout"):
        llm_provider.embed_texts(["长会议内容"])


def test_business_services_cannot_bypass_the_provider_or_old_ports():
    app_root = Path(__file__).resolve().parents[1] / "app"
    provider = app_root / "services" / "llm_provider.py"
    offenders = []
    forbidden = (
        "127.0.0.1:11434",
        "127.0.0.1:21435",
        "127.0.0.1:21436",
        '"/api/chat"',
        '"/api/embed"',
        "from meetingsummary.ollama_client import call_ollama",
    )
    for path in app_root.rglob("*.py"):
        if path == provider:
            continue
        text = path.read_text(encoding="utf-8")
        hits = [needle for needle in forbidden if needle in text]
        if hits:
            offenders.append((path.relative_to(app_root).as_posix(), hits))
    assert offenders == []
