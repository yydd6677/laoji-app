"""Disk admission policy for permanent cloud recording uploads."""

from __future__ import annotations

from pathlib import Path
import shutil

from fastapi import HTTPException

from app.config import settings


MINIMUM_UPLOAD_FREE_BYTES = 20 * 1024**3
WARNING_FREE_BYTES = 40 * 1024**3


def storage_state() -> dict:
    root = Path(settings.audio_storage_abs_path)
    root.mkdir(parents=True, exist_ok=True)
    usage = shutil.disk_usage(root)
    return {
        "free_bytes": usage.free,
        "warning": usage.free < WARNING_FREE_BYTES,
        "accepting_new_audio": usage.free >= MINIMUM_UPLOAD_FREE_BYTES,
    }


def ensure_audio_upload_allowed() -> None:
    if storage_state()["accepting_new_audio"]:
        return
    raise HTTPException(
        status_code=507,
        detail="云端存储空间不足，录音已保留在本机，稍后会自动重试上传",
    )
