"""Disk admission policy for permanent cloud recording uploads."""

from __future__ import annotations

from pathlib import Path
import shutil

from fastapi import HTTPException

from app.config import settings


MINIMUM_UPLOAD_FREE_BYTES = 20 * 1024**3
WARNING_FREE_BYTES = 40 * 1024**3


def storage_state(root: str | Path | None = None) -> dict:
    """Return admission state for the filesystem that will hold the asset.

    Uploads can be routed to a different mount in tests or deployments. The
    default remains the configured audio root, while callers with a concrete
    target directory must pass it so an unrelated full mount cannot reject a
    valid upload (or vice versa).
    """
    root = Path(root) if root is not None else Path(settings.audio_storage_abs_path)
    root.mkdir(parents=True, exist_ok=True)
    usage = shutil.disk_usage(root)
    return {
        "free_bytes": usage.free,
        "warning": usage.free < WARNING_FREE_BYTES,
        "accepting_new_audio": usage.free >= MINIMUM_UPLOAD_FREE_BYTES,
    }


def ensure_audio_upload_allowed(root: str | Path | None = None) -> None:
    if storage_state(root)["accepting_new_audio"]:
        return
    raise HTTPException(
        status_code=507,
        detail="云端存储空间不足，录音已保留在本机，稍后会自动重试上传",
    )
