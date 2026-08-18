from __future__ import annotations

from pathlib import Path


PROJECT_ROOT = Path(__file__).resolve().parents[3]
APP_ROOT = PROJECT_ROOT / "services" / "laoji-api" / "app"


def _python_sources(root: Path):
    return sorted(path for path in root.rglob("*.py") if path.is_file())


def test_business_code_has_one_ollama_and_asr_route():
    source = "\n".join(path.read_text(encoding="utf-8") for path in _python_sources(APP_ROOT))
    assert "127.0.0.1:21435" not in source
    assert "127.0.0.1:21436" not in source
    assert "127.0.0.1:8002" not in source
    assert "127.0.0.1:18035" not in source
    # Candidate runtime endpoints are supplied by deployment environment, not
    # embedded in business code. The source must not hard-code a deprecated
    # endpoint or bypass the provider adapter.


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
            bypasses.append((str(path.relative_to(PROJECT_ROOT)), hits))
    assert bypasses == []


def test_systemd_units_bind_only_the_compact_internal_ports():
    deploy = PROJECT_ROOT / "deploy" / "linux"
    units = "\n".join(
        (deploy / name).read_text(encoding="utf-8")
        for name in ("laoji-api-vnext.service.example", "laoji-asr-vnext.service.example")
    )
    assert "--port 18021" in units
    assert "QWEN_ASR_PORT=8031" in units
    assert "LAOJI_INTERNAL_ASR_PORT=8031" in units
    assert "QWEN_ASR_DEVICE=cpu" in units
    for old_port in ("18035", "8002", "21435", "21436"):
        assert old_port not in units
    env = (deploy / "api.env.example").read_text(encoding="utf-8")
    asr_env = (deploy / "asr.env.example").read_text(encoding="utf-8")
    assert "LAOJI_INTERNAL_ASR_PORT=8031" in env
    assert "QWEN_ASR_MODEL=/opt/laoji-vnext/models/qwen3-asr/Qwen3-ASR-1.7B" in asr_env
