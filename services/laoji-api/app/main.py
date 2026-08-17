"""
智能会议记录平台 - FastAPI 后端入口

本地开发启动方式：
    cd backend
    ENV=local CORS_ORIGINS='["http://localhost","http://localhost:5179"]' \
        python3 -m uvicorn app.main:app --host 0.0.0.0 --port 8020 --access-log
"""

import ast
import asyncio
import logging
import os
import sys
from pathlib import Path
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.responses import FileResponse
from fastapi.middleware.cors import CORSMiddleware

from app.config import settings
from app.runtime_policy import env_enabled as _env_enabled
from app.security_headers import SensitiveApiHeadersMiddleware
from app.service_telemetry import ServiceTelemetryMiddleware
from logging_config import setup_file_logging, setup_logging

# 启动 Uvicorn 时加上 --access-log 才显示访问日志（默认静默）
#   python3 -m uvicorn app.main:app --host 0.0.0.0 --port 8020 --access-log
_access_log = "--access-log" in sys.argv

if not _access_log:
    # 静默 Uvicorn 访问日志（不打印 "INFO: GET /api/... 200 OK"）
    logging.getLogger("uvicorn.access").disabled = True

# 保留 uvicorn.error 和 uvicorn.asgi 的 INFO 日志（有用）
logging.getLogger("uvicorn.error").setLevel(logging.INFO)


# 静默第三方库的冗余 INFO 日志。
for _lib in [
    "transformers",
    "onnxruntime",
]:
    _lg = logging.getLogger(_lib)
    _lg.setLevel(logging.WARNING)

# ── GPU 显存配置：禁用 PyTorch CUDA 内存池 ─────────────────────
os.environ["PYTORCH_CUDA_ALLOC_CONF"] = "expandable_segments:False"
import torch
if torch.cuda.is_available():
    torch.cuda.empty_cache()
    torch.cuda.set_device(0)
    print(f"[GPU] {torch.cuda.get_device_name(0)}, "
          f"free: {torch.cuda.mem_get_info()[0]/1024**3:.1f} GB")


@asynccontextmanager
async def lifespan(app: FastAPI):
    # 初始化文件日志系统（对齐 InsightEye）
    log_path = setup_file_logging()
    setup_logging()
    print(f"[启动] 日志同步写入: {log_path}", flush=True)
    print(f"[启动] 所有运行日志请查看 backend/logs 文件夹", flush=True)

    # The compact topology is SQLite-only in both local and production modes.
    from app.database import engine
    from app.models import Base
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    from app.services.app_meeting_schema import ensure_app_meeting_schema
    from app.services import schedule_db_service
    from app.services.device_identity import ensure_device_schema, purge_expired_device_data
    from app.services.laoji_auth_service import init_auth_db
    from app.services.speaker_db_service import get_speaker_db

    await asyncio.to_thread(ensure_app_meeting_schema)
    await asyncio.to_thread(init_auth_db)
    await asyncio.to_thread(schedule_db_service.ensure_schedule_database)
    await asyncio.to_thread(ensure_device_schema)
    await asyncio.to_thread(purge_expired_device_data)
    await asyncio.to_thread(get_speaker_db)
    from app.services.summary_v3_store import purge_expired_source_payloads
    expired_summary_payloads = await asyncio.to_thread(purge_expired_source_payloads)
    if expired_summary_payloads:
        print(
            f"[启动] 已清理 {expired_summary_payloads} 个过期整理临时载荷",
            flush=True,
        )
    from app.services.database_migrations import archive_orphan_final_summaries
    archived_orphans = await asyncio.to_thread(archive_orphan_final_summaries)
    if archived_orphans:
        print(
            f"[启动] 已保全并移出 {archived_orphans} 条缺少原会议的历史整理记录",
            flush=True,
        )
    os.makedirs(settings.audio_storage_abs_path, exist_ok=True)
    print("✓ SQLite 数据库已就绪", flush=True)

    # 清理残留的 processing 状态（防止上次崩溃导致的状态卡住）
    try:
        from sqlalchemy import text
        async with engine.connect() as conn:
            result = await conn.execute(
                text("SELECT id, title FROM meetings WHERE status = 'processing'")
            )
            stuck_meetings = result.fetchall()
            if stuck_meetings:
                print(f"[启动] 发现 {len(stuck_meetings)} 个卡在 processing 状态的会议，正在清理...")
                await conn.execute(
                    text("UPDATE meetings SET status = 'ended' WHERE status = 'processing'")
                )
                await conn.commit()
                for m in stuck_meetings:
                    meeting_id, title = m[0], m[1]
                    print(f"  - {meeting_id[:20]}... ({title})")
                    print("    已标记为 ended；总结将在用户进入总结页或手动触发时生成", flush=True)
    except Exception as e:
        print(f"[启动] 清理残留状态失败: {e}")

    try:
        from app.services.meeting_recording_asset_service import (
            cleanup_completed_transcription_checkpoints,
            cleanup_interrupted_upload_parts,
            recover_interrupted_transcription_jobs,
        )
        removed_upload_parts = cleanup_interrupted_upload_parts()
        if removed_upload_parts:
            print(
                f"[启动] 已清理 {removed_upload_parts} 个中断的上传分片",
                flush=True,
            )
        removed_checkpoints = await cleanup_completed_transcription_checkpoints()
        if removed_checkpoints:
            print(
                f"[启动] 已清理 {removed_checkpoints} 个已完成或孤儿的转写检查点目录",
                flush=True,
            )
        recovered_jobs = await recover_interrupted_transcription_jobs()
        if recovered_jobs:
            print(
                f"[启动] 已恢复 {recovered_jobs} 个中断的逐录音转写任务",
                flush=True,
            )
    except Exception as e:
        print(f"[启动] 恢复逐录音转写任务失败: {e}", flush=True)

    # Qwen3-ASR 支持模型预热：Silero VAD + CAM++。
    # 在 lifespan 中同步预热，确保 WebSocket 连接时模型已就绪。
    # 工作区可用 MEETING_ASR_WARMUP_ENABLED=0 做轻量健康检查，默认保持原行为。
    if _env_enabled("MEETING_ASR_WARMUP_ENABLED", True):
        try:
            from app.asr.model_manager import get_model_manager
            mm = get_model_manager()
            if not mm.is_initialized():
                print("[启动] 正在预热 Qwen3-ASR 支持模型（VAD + CAM++）...", flush=True)
                await mm.initialize()
                print("[启动] 实时转录模型预热完成", flush=True)
            else:
                print("[启动] 实时转录模型已就绪", flush=True)
        except Exception as e:
            print(f"[启动] 转录支持模型预热失败，服务将保持未就绪: {e}", flush=True)
    else:
        print("[启动] 已按 MEETING_ASR_WARMUP_ENABLED=0 跳过实时转录模型预热", flush=True)


    try:
        from app.workers.summary_tasks import recover_persistent_summary_jobs

        recovered_summaries = recover_persistent_summary_jobs()
        if recovered_summaries:
            print(
                f"[启动] 已恢复 {recovered_summaries} 个中断的整理任务",
                flush=True,
            )
    except Exception as error:
        print(
            f"[启动] 恢复整理任务失败: {type(error).__name__}",
            flush=True,
        )

    from app.services.meeting_retention_service import start_meeting_retention_cleanup
    start_meeting_retention_cleanup()

    try:
        yield
    finally:
        from app.services.meeting_recording_asset_service import stop_recording_worker
        from app.services.meeting_retention_service import stop_meeting_retention_cleanup
        await stop_recording_worker()
        await stop_meeting_retention_cleanup()


app = FastAPI(
    title="智能会议记录平台 API",
    description="会议音频处理与总结系统后端网关",
    version="0.1.0",
    lifespan=lifespan,
)

# Public Android update artifacts. The manifest contains only release
# metadata; the APK is served as a static file and is not tied to a device.
ANDROID_RELEASE_DIR = Path(__file__).resolve().parents[2] / "releases" / "android"


@app.get("/downloads/android/latest.json", include_in_schema=False)
async def latest_android_manifest():
    manifest = ANDROID_RELEASE_DIR / "latest.json"
    if not manifest.is_file():
        from fastapi import HTTPException
        raise HTTPException(status_code=404, detail="版本清单暂不可用")
    return FileResponse(manifest, media_type="application/json", headers={"Cache-Control": "no-cache"})


@app.get("/downloads/android/{file_name}", include_in_schema=False)
async def download_android_release(file_name: str):
    if not file_name.startswith("laoji-") or not file_name.endswith(".apk") or "/" in file_name or "\\" in file_name:
        from fastapi import HTTPException
        raise HTTPException(status_code=404, detail="安装包不存在")
    artifact = (ANDROID_RELEASE_DIR / file_name).resolve()
    if ANDROID_RELEASE_DIR.resolve() not in artifact.parents or not artifact.is_file():
        from fastapi import HTTPException
        raise HTTPException(status_code=404, detail="安装包不存在")
    return FileResponse(
        artifact,
        media_type="application/vnd.android.package-archive",
        filename=file_name,
        headers={"Cache-Control": "public, max-age=300"},
    )
app.add_middleware(ServiceTelemetryMiddleware, service_name="meeting")
app.add_middleware(SensitiveApiHeadersMiddleware)

# CORS
origins = ast.literal_eval(settings.CORS_ORIGINS)
if origins == ["*"]:
    # 开发环境允许所有来源（不能与 credentials 同时为 True）
    app.add_middleware(
        CORSMiddleware,
        allow_origins=["*"],
        allow_credentials=False,
        allow_methods=["*"],
        allow_headers=["*"],
        expose_headers=["X-Trace-ID", "Server-Timing"],
    )
else:
    app.add_middleware(
        CORSMiddleware,
        allow_origins=origins,
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
        expose_headers=["X-Trace-ID", "Server-Timing"],
    )

# REST 路由（/api/*）
from app.api.router import api_router  # noqa: E402
app.include_router(api_router, prefix="/api")

from app.api.qwen_ws import router as qwen_router
app.include_router(qwen_router)

@app.get("/")
async def root():
    return {
        "message": "智能会议记录平台 API",
        "docs": "/docs",
        "health": "/health",
        "api": "/api"
    }


@app.get("/health")
async def health_check():
    return {
        "status": "ok",
        "env": settings.ENV,
    }


@app.get("/api/health")
async def api_health_check():
    from app.asr.model_manager import get_model_manager
    mm = get_model_manager()
    return {
        "status": "ok",
        "env": settings.ENV,
        "asr_provider": "qwen3-asr",
        "models_ready": mm.required_models_ready(),
        "models": {
            "vad": mm.get_vad_model() is not None,
            "campplus": mm.get_camp_model() is not None,
        },
    }


@app.get("/api/ready")
async def api_ready_check():
    from app.services.readiness_service import readiness_snapshot

    return await readiness_snapshot()
