"""Static safety checks for the compact production deployment templates."""

from __future__ import annotations

from pathlib import Path
import re


ROOT = Path(__file__).resolve().parents[1]
DEPLOY = ROOT / "deploy" / "linux"


def require(path: Path, needles: list[str]) -> None:
    text = path.read_text(encoding="utf-8")
    for needle in needles:
        if needle not in text:
            raise SystemExit(f"{path.name}: missing {needle!r}")


def main() -> None:
    asr = DEPLOY / "laoji-asr.service.example"
    api = DEPLOY / "laoji-api.service.example"
    ollama = DEPLOY / "laoji-ollama.service.example"
    asr_env = DEPLOY / "asr.env.example"
    api_env = DEPLOY / "api.env.example"
    dockerfile = ROOT / "services" / "laoji-api" / "Dockerfile"
    require(asr, [
        "%h/laoji-service-platform/runtime/asr/qwen_asr_service/server.py",
        "%h/laoji-service-platform/compact-production/backend",
        "CUDA_VISIBLE_DEVICES=0",
        "laoji-compact-py312",
    ])
    require(api, [
        "%h/laoji-service-platform/current/services/laoji-api",
        "--host 127.0.0.1 --port 18020",
        "%h/.config/laoji/laoji.env",
    ])
    require(ollama, [
        "OLLAMA_HOST=127.0.0.1:21434",
        "OLLAMA_MAX_LOADED_MODELS=2",
        "OLLAMA_NUM_PARALLEL=1",
    ])
    require(asr_env, [
        "QWEN_ASR_MODEL=",
        "QWEN_ASR_MODEL_REVISION=",
        "QWEN_ASR_MAX_BATCH_SIZE=8",
        "QWEN_ASR_SILENCE_RMS_THRESHOLD=0.0005",
        "QWEN_ASR_SILENCE_PEAK_THRESHOLD=0.002",
    ])
    require(api_env, [
        "R2_ENABLED=true",
        "DATABASE_URL=",
        "AUDIO_STORAGE_PATH=",
        "LOCAL_DEVICE=cuda",
        "CAMPPLUS_MODEL_DIR=",
        "MEETING_ASR_WARMUP_ENABLED=1",
        "QWEN_ASR_READY_URL=http://127.0.0.1:8030/ready",
    ])
    require(dockerfile, [
        "ubuntu24.04",
        "python3 -m venv",
        "requirements-compact.txt",
        "EXPOSE 18020",
        '"--port", "18020"',
    ])
    for path in (asr, api, ollama, asr_env, api_env):
        text = path.read_text(encoding="utf-8")
        if any(secret in text for secret in (
            "cfat_",
            "AWS_SECRET",
            "access_key_secret",
            "R2_ACCESS_KEY_ID=",
            "R2_SECRET_ACCESS_KEY=",
            "LAOJI_DEVICE_BOOTSTRAP_KEY=",
        )):
            raise SystemExit(f"{path.name}: secret-like material found")
        for retired in ("/opt/laoji-vnext", "18021", "8031"):
            if retired in text:
                raise SystemExit(f"{path.name}: retired candidate value found: {retired}")
        unexpected_users = sorted({
            match
            for match in re.findall(r"/home/([^/\s]+)", text)
            if match != "LAOJI_USER"
        })
        if unexpected_users:
            raise SystemExit(f"{path.name}: deployment-specific home path found")
        for retired_flag in (
            "LAOJI_VNEXT_MEDIA_UPLOAD_BARRIER_",
            "LAOJI_VNEXT_REALTIME_V2_ENABLED",
            "LAOJI_VNEXT_SCHEDULE_GRAPH_ENABLED",
            "LAOJI_VNEXT_SOURCE_STREAM_V2_ENABLED",
            "LAOJI_VNEXT_Q2_READER_ENABLED",
            "LAOJI_VNEXT_IMPORT_TRANSCRIPTION_ENABLED",
            "LAOJI_VNEXT_SUMMARY_SOURCE_STREAM_ENABLED",
        ):
            if retired_flag in text:
                raise SystemExit(f"{path.name}: retired capability switch found: {retired_flag}")
    docker_text = dockerfile.read_text(encoding="utf-8")
    for retired in ("python3.11", "docker-wheels", "EXPOSE 8000", '"--port", "8000"'):
        if retired in docker_text:
            raise SystemExit(f"Dockerfile: retired production value found: {retired}")
    print("laoji_linux_production_templates=verified")


if __name__ == "__main__":
    main()
