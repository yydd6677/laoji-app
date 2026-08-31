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
        for name in (
            "laoji-api.service.example",
            "laoji-asr.service.example",
            "laoji-ollama.service.example",
        )
    )
    assert "--port 18020" in units
    assert "OLLAMA_HOST=127.0.0.1:21434" in units
    assert "%h/laoji-service-platform/current" in units
    assert "%h/.config/laoji/laoji.env" in units
    for old_port in ("18021", "8031", "18035", "8002", "21435", "21436"):
        assert old_port not in units
    env = (deploy / "api.env.example").read_text(encoding="utf-8")
    asr_env = (deploy / "asr.env.example").read_text(encoding="utf-8")
    assert "LAOJI_INTERNAL_ASR_PORT=8030" in env
    assert "QWEN_ASR_MODEL=/home/LAOJI_USER/laoji-service-platform/models/qwen3-asr/Qwen3-ASR-1.7B" in asr_env
    assert "R2_ACCESS_KEY_ID=" not in env
    assert "R2_SECRET_ACCESS_KEY=" not in env


def test_api_container_uses_the_same_python_and_port_boundary():
    dockerfile = (PROJECT_ROOT / "services" / "laoji-api" / "Dockerfile").read_text(
        encoding="utf-8",
    )
    assert "ubuntu24.04" in dockerfile
    assert "python3 -m venv" in dockerfile
    assert "requirements-compact.txt" in dockerfile
    assert "EXPOSE 18020" in dockerfile
    assert '"--port", "18020"' in dockerfile
    for retired in ("python3.11", "docker-wheels", "EXPOSE 8000", '"--port", "8000"'):
        assert retired not in dockerfile
