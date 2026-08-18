"""Static safety checks for the Linux-only isolated vNext deployment templates."""

from __future__ import annotations

from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
DEPLOY = ROOT / "deploy" / "linux"


def require(path: Path, needles: list[str]) -> None:
    text = path.read_text(encoding="utf-8")
    for needle in needles:
        if needle not in text:
            raise SystemExit(f"{path.name}: missing {needle!r}")


def main() -> None:
    asr = DEPLOY / "laoji-asr-vnext.service.example"
    api = DEPLOY / "laoji-api-vnext.service.example"
    asr_env = DEPLOY / "asr.env.example"
    api_env = DEPLOY / "api.env.example"
    require(asr, [
        "QWEN_ASR_PORT=8031",
        "QWEN_ASR_DEVICE=cpu",
        "CUDA_VISIBLE_DEVICES=",
        "services/laoji-asr/server.py",
    ])
    require(api, [
        "--host 127.0.0.1 --port 18021",
        "LAOJI_INTERNAL_ASR_PORT=8031",
        "QWEN_ASR_READY_URL=http://127.0.0.1:8031/ready",
        "QWEN_ASR_V2_BATCH_URL=http://127.0.0.1:8031/v2/asr/batch",
        "LAOJI_VNEXT_MEDIA_UPLOAD_BARRIER_ENABLED=0",
    ])
    require(asr_env, [
        "QWEN_ASR_MODEL=",
        "QWEN_ASR_MODEL_REVISION=",
        "QWEN_ASR_MAX_BATCH_SIZE=8",
        "QWEN_ASR_SILENCE_RMS_THRESHOLD=0.0005",
        "QWEN_ASR_SILENCE_PEAK_THRESHOLD=0.002",
    ])
    require(api_env, [
        "R2_ENABLED=0",
        "DATABASE_URL=",
        "AUDIO_STORAGE_PATH=",
        "LOCAL_DEVICE=cpu",
        "CAMPPLUS_MODEL_DIR=",
        "MEETING_ASR_WARMUP_ENABLED=1",
        "QWEN_ASR_READY_URL=http://127.0.0.1:8031/ready",
    ])
    for path in (asr, api, asr_env, api_env):
        text = path.read_text(encoding="utf-8")
        if any(secret in text for secret in ("cfat_", "AWS_SECRET", "access_key_secret")):
            raise SystemExit(f"{path.name}: secret-like material found")
    print("vnext_linux_deployment_templates=verified")


if __name__ == "__main__":
    main()
