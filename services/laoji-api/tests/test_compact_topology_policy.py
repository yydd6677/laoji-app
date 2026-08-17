from __future__ import annotations

from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[2]
APP_ROOT = REPO_ROOT / "backend" / "app"


def _python_sources(root: Path):
    return sorted(path for path in root.rglob("*.py") if path.is_file())


def test_business_code_has_one_ollama_and_asr_route():
    source = "\n".join(path.read_text(encoding="utf-8") for path in _python_sources(APP_ROOT))
    assert "127.0.0.1:21435" not in source
    assert "127.0.0.1:21436" not in source
    assert "127.0.0.1:8002" not in source
    assert "127.0.0.1:18035" not in source
    assert "127.0.0.1:21434" in source
    assert "127.0.0.1:8030" in source


def test_generation_services_route_through_provider():
    provider = (APP_ROOT / "services" / "llm_provider.py").resolve()
    forbidden_imports = ("from meetingsummary", "import meetingsummary")
    bypasses = []
    for path in _python_sources(APP_ROOT):
        if path.resolve() == provider:
            continue
        text = path.read_text(encoding="utf-8")
        hits = [marker for marker in forbidden_imports if marker in text]
        if hits or "http://127.0.0.1:21434/api/generate" in text:
            bypasses.append((str(path.relative_to(REPO_ROOT)), hits))
    assert bypasses == []


def test_systemd_units_bind_only_the_compact_internal_ports():
    units = "\n".join(
        (REPO_ROOT / "deploy" / "systemd" / name).read_text(encoding="utf-8")
        for name in ("laoji-api.service", "laoji-asr.service", "laoji-ollama.service")
    )
    assert "--port 18020" in units
    assert "EnvironmentFile=/etc/laoji/laoji.env" in units
    assert "OLLAMA_HOST=127.0.0.1:21434" in units
    assert "PartOf=laoji-asr.service laoji-ollama.service" in units
    for old_port in ("18035", "8002", "21435", "21436"):
        assert old_port not in units
    env = (REPO_ROOT / "deploy" / "systemd" / "laoji.env.example").read_text(encoding="utf-8")
    assert "QWEN_ASR_PORT=8030" in env
    assert "QWEN_ASR_MODEL=/home/zhong/laoji-service-platform/models/qwen3-asr/Qwen3-ASR-1.7B" in env
    assert "LAOJI_INTERNAL_ASR_PORT=8030" in env
    assert "LAOJI_OLLAMA_BASE_URL=http://127.0.0.1:21434" in env
