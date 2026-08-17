import uuid
import asyncio
import json
import os
import hashlib
from io import BytesIO
from datetime import datetime
from pathlib import Path

from anyio import open_file
from fastapi import APIRouter, Depends, HTTPException, UploadFile, File
from fastapi.responses import FileResponse, StreamingResponse
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import case, delete, select, func

from app.config import settings
from app.database import get_db
from app.models.meeting import Meeting
from app.models.summary import FinalSummary
from app.models.transcript import TranscriptLine
from app.schemas.meeting import MeetingCreate, MeetingUpdate, MeetingResponse, MeetingListResponse
from app.workers.summary_tasks import submit_final_summary
from app.services.storage_admission import ensure_audio_upload_allowed

router = APIRouter()

UPLOAD_DIR = Path(__file__).parent.parent / "audio_files"
UPLOAD_DIR.mkdir(parents=True, exist_ok=True)

# ==================== 会议 CRUD ====================

@router.post("", response_model=MeetingResponse, status_code=201)
async def create_meeting(data: MeetingCreate, db: AsyncSession = Depends(get_db)):
    meeting = Meeting(
        id=str(uuid.uuid4()),
        title=data.title,
        description=data.description,
        participants=json.dumps(data.participants, ensure_ascii=False),
        status="created",
        mode=data.mode or "realtime",
        created_at=datetime.utcnow(),
        updated_at=datetime.utcnow(),
    )
    db.add(meeting)
    await db.flush()
    await db.refresh(meeting)
    return _to_response(meeting)


@router.get("", response_model=MeetingListResponse)
async def list_meetings(page: int = 1, size: int = 20, db: AsyncSession = Depends(get_db)):
    total_q = await db.execute(select(func.count(Meeting.id)))
    total = total_q.scalar() or 0
    result = await db.execute(
        select(Meeting).order_by(Meeting.created_at.desc()).offset((page - 1) * size).limit(size)
    )
    items = [_to_response(m) for m in result.scalars().all()]
    return MeetingListResponse(items=items, total=total, page=page, size=size)


@router.get("/{meeting_id}", response_model=MeetingResponse)
async def get_meeting(meeting_id: str, db: AsyncSession = Depends(get_db)):
    result = await db.execute(select(Meeting).where(Meeting.id == meeting_id))
    meeting = result.scalar_one_or_none()
    if not meeting:
        raise HTTPException(status_code=404, detail="Meeting not found")
    return _to_response(meeting)


@router.patch("/{meeting_id}", response_model=MeetingResponse)
async def update_meeting(meeting_id: str, data: MeetingUpdate, db: AsyncSession = Depends(get_db)):
    result = await db.execute(select(Meeting).where(Meeting.id == meeting_id))
    meeting = result.scalar_one_or_none()
    if not meeting:
        raise HTTPException(status_code=404, detail="Meeting not found")
    if data.title is not None:
        meeting.title = data.title
    if data.description is not None:
        meeting.description = data.description
    if data.status is not None:
        meeting.status = data.status
    if data.participants is not None:
        meeting.participants = json.dumps(data.participants, ensure_ascii=False)
    if data.mode is not None:
        meeting.mode = data.mode
    meeting.updated_at = datetime.utcnow()
    await db.flush()
    await db.refresh(meeting)
    return _to_response(meeting)


@router.delete("/{meeting_id}", status_code=204)
async def delete_meeting(meeting_id: str, db: AsyncSession = Depends(get_db)):
    result = await db.execute(select(Meeting).where(Meeting.id == meeting_id))
    meeting = result.scalar_one_or_none()
    if not meeting:
        raise HTTPException(status_code=404, detail="Meeting not found")
    await db.delete(meeting)


# ==================== 离线处理相关 ====================

@router.post("/{meeting_id}/upload")
async def upload_audio(
    meeting_id: str,
    file: UploadFile = File(...),
    db: AsyncSession = Depends(get_db)
):
    """旧版上传兼容入口；内部投影到 RecordingAsset v2。"""
    ensure_audio_upload_allowed()
    result = await db.execute(select(Meeting).where(Meeting.id == meeting_id))
    meeting = result.scalar_one_or_none()
    if not meeting:
        raise HTTPException(status_code=404, detail="Meeting not found")

    allowed_extensions = [
        '.wav', '.mp3', '.m4a', '.aac', '.ogg', '.webm', '.flac',
        '.mp4', '.mov', '.mkv',
    ]
    file_ext = Path(file.filename).suffix.lower() if file.filename else '.wav'
    if file_ext not in allowed_extensions:
        raise HTTPException(status_code=400, detail=f"不支持的文件格式: {file_ext}")

    file_path = UPLOAD_DIR / f"{meeting_id}_{uuid.uuid4()}{file_ext}"
    temporary = file_path.with_name(f".{file_path.name}.part")
    try:
        file_size = 0
        async with await open_file(temporary, "xb") as output:
            while chunk := await file.read(settings.MEETING_AUDIO_CHUNK_BYTES):
                file_size += len(chunk)
                if file_size > settings.MEETING_AUDIO_MAX_BYTES:
                    raise HTTPException(
                        status_code=413,
                        detail=(
                            "会议文件不能超过 "
                            f"{settings.MEETING_AUDIO_MAX_BYTES // 1024 // 1024} MB"
                        ),
                    )
                await output.write(chunk)
            await output.flush()
        await file.close()
        if file_size < 1:
            raise HTTPException(status_code=400, detail="会议文件为空")
        os.replace(temporary, file_path)
        print(f"[API] 音频文件已保存: {file_path}, 大小: {file_size / 1024 / 1024:.2f} MB")
        from app.api.app_meetings import _probe_duration_sec, _safe_audio_name
        from app.services.meeting_recording_asset_service import (
            project_compat_media_upload,
            submit_transcription_job,
        )

        if meeting.user_id is None:
            meeting.user_id = 0
        duration_sec = await asyncio.to_thread(_probe_duration_sec, file_path)
        safe_name, _safe_extension = _safe_audio_name(file.filename)
        asset, job, should_submit = await project_compat_media_upload(
            db,
            meeting=meeting,
            user_id=int(meeting.user_id),
            source_path=file_path,
            file_name=safe_name,
            mime_type=(file.content_type or "application/octet-stream")[:160],
            duration_ms=round(duration_sec * 1000) if duration_sec is not None else None,
            start_transcription=True,
        )
        await db.commit()
        if should_submit and job is not None:
            submit_transcription_job(job["job_id"])

        return {
            "status": job["status"] if job is not None else "uploaded",
            "message": "会议文件上传成功，正在后台处理",
            "file_size": asset["byte_size"],
            "meeting_id": meeting_id,
            "mode": "offline",
            "recording_asset_id": asset["id"],
            "job_id": job["job_id"] if job is not None else None,
        }
    except HTTPException:
        temporary.unlink(missing_ok=True)
        if file_path.exists():
            file_path.unlink()
        raise
    except Exception:
        temporary.unlink(missing_ok=True)
        if file_path.exists():
            file_path.unlink()
        raise HTTPException(status_code=500, detail="会议文件上传失败，请稍后重试")


@router.get("/{meeting_id}/status")
async def get_processing_status(meeting_id: str, db: AsyncSession = Depends(get_db)):
    """获取离线处理状态"""
    result = await db.execute(select(Meeting).where(Meeting.id == meeting_id))
    meeting = result.scalar_one_or_none()
    if not meeting:
        raise HTTPException(status_code=404, detail="Meeting not found")
    return {
        "meeting_id": meeting_id,
        "status": meeting.status,
        "title": meeting.title,
        "updated_at": meeting.updated_at.isoformat() if meeting.updated_at else None
    }


@router.post("/{meeting_id}/process")
async def trigger_processing(meeting_id: str, db: AsyncSession = Depends(get_db)):
    """手动触发离线处理"""
    result = await db.execute(select(Meeting).where(Meeting.id == meeting_id))
    meeting = result.scalar_one_or_none()
    if not meeting:
        raise HTTPException(status_code=404, detail="Meeting not found")
    meeting.status = "processing"
    meeting.updated_at = datetime.utcnow()
    await db.flush()
    return {"status": "processing", "message": "处理已触发", "meeting_id": meeting_id}


# ==================== 转写查询 ====================

@router.get("/{meeting_id}/transcripts")
async def get_transcripts(
    meeting_id: str,
    limit: int = 1000,
    offset: int = 0,
    db: AsyncSession = Depends(get_db)
):
    """获取会议转写结果"""
    from app.models.meeting_recording_asset import (
        MeetingRecordingAssetV2,
        MeetingRecordingTranscriptionJobV2,
    )
    from app.models.transcript import TranscriptLine

    asset_order = case(
        (TranscriptLine.recording_asset_id.is_(None), 0),
        (MeetingRecordingAssetV2.role == "primary", 1),
        else_=2,
    )
    total = int(
        (
            await db.execute(
                select(func.count(TranscriptLine.id)).where(
                    TranscriptLine.meeting_id == meeting_id
                )
            )
        ).scalar()
        or 0
    )
    result = await db.execute(
        select(TranscriptLine)
        .outerjoin(
            MeetingRecordingAssetV2,
            MeetingRecordingAssetV2.id == TranscriptLine.recording_asset_id,
        )
        .where(TranscriptLine.meeting_id == meeting_id)
        .order_by(
            asset_order,
            MeetingRecordingAssetV2.created_at,
            MeetingRecordingAssetV2.id,
            TranscriptLine.start_time,
            TranscriptLine.id,
        )
        .offset(offset)
        .limit(limit)
    )
    items = [_transcript_to_dict(t) for t in result.scalars().all()]
    jobs = list(
        (
            await db.execute(
                select(MeetingRecordingTranscriptionJobV2)
                .where(MeetingRecordingTranscriptionJobV2.meeting_id == meeting_id)
                .order_by(
                    MeetingRecordingTranscriptionJobV2.created_at,
                    MeetingRecordingTranscriptionJobV2.id,
                )
            )
        ).scalars().all()
    )
    latest_job_by_asset = {}
    for job in jobs:
        latest_job_by_asset[job.asset_id] = job
    latest_jobs = list(latest_job_by_asset.values())
    active = any(job.status in ("queued", "running") for job in latest_jobs)
    failed_without_stable_content = total == 0 and any(
        job.status == "failed" for job in latest_jobs
    )
    transcript_status = (
        "incomplete" if active else "failed" if failed_without_stable_content
        else "complete" if total > 0 else "unknown"
    )
    is_complete = transcript_status == "complete"
    transcript_revision_id = None
    if is_complete:
        revision_material = "|".join(
            [meeting_id, str(total)]
            + sorted(
                f"{job.asset_id}:{job.result_revision_id or ''}"
                for job in latest_jobs
                if job.status == "completed"
            )
        )
        transcript_revision_id = (
            "meeting-transcript:"
            f"{hashlib.sha256(revision_material.encode()).hexdigest()}"
        )
    return {
        "items": items,
        "total": total,
        "transcript_status": transcript_status,
        "is_complete": is_complete,
        "transcript_revision_id": transcript_revision_id,
    }


@router.get("/{meeting_id}/downloads/transcript")
async def download_transcript(meeting_id: str, db: AsyncSession = Depends(get_db)):
    result = await db.execute(select(Meeting).where(Meeting.id == meeting_id))
    meeting = result.scalar_one_or_none()
    if not meeting:
        raise HTTPException(status_code=404, detail="Meeting not found")

    transcript_result = await db.execute(
        select(TranscriptLine)
        .where(TranscriptLine.meeting_id == meeting_id)
        .order_by(TranscriptLine.start_time)
    )
    transcript_lines = transcript_result.scalars().all()
    if not transcript_lines:
        raise HTTPException(status_code=404, detail="暂无转写可下载")

    lines = [f"# {meeting.title} - 转写文档", ""]
    if meeting.description:
        lines.extend([f"说明：{meeting.description}", ""])
    lines.extend([
        f"会议ID：{meeting.id}",
        f"状态：{meeting.status}",
        f"创建时间：{meeting.created_at.isoformat() if meeting.created_at else 'N/A'}",
        "",
        "## 转写内容",
        "",
    ])
    for line in transcript_lines:
        start = f"{line.start_time:.2f}s" if line.start_time is not None else "N/A"
        end = f"{line.end_time:.2f}s" if line.end_time is not None else "N/A"
        speaker = line.speaker_label or line.speaker_id or "未知"
        lines.append(f"- [{start} - {end}] {speaker}：{line.text}")

    content = "\n".join(lines)
    filename = f"{meeting.title or meeting_id}-transcript.md".replace("/", "-")
    return StreamingResponse(
        BytesIO(content.encode("utf-8")),
        media_type="text/markdown; charset=utf-8",
        headers={"Content-Disposition": f"attachment; filename*=UTF-8''{filename}"},
    )


@router.get("/{meeting_id}/downloads/summary")
async def download_summary(meeting_id: str, db: AsyncSession = Depends(get_db)):
    result = await db.execute(select(Meeting).where(Meeting.id == meeting_id))
    meeting = result.scalar_one_or_none()
    if not meeting:
        raise HTTPException(status_code=404, detail="Meeting not found")

    fs = await _ensure_final_summary(db, meeting_id)
    if not fs:
        raise HTTPException(status_code=404, detail="暂无总结可下载")

    content = (fs.markdown_text or fs.full_text or fs.overview or "").strip()
    if not content:
        raise HTTPException(status_code=404, detail="暂无总结可下载")

    filename = f"{meeting.title or meeting_id}-summary.md".replace("/", "-")
    return StreamingResponse(
        BytesIO(content.encode("utf-8")),
        media_type="text/markdown; charset=utf-8",
        headers={"Content-Disposition": f"attachment; filename*=UTF-8''{filename}"},
    )


def _transcript_to_dict(t) -> dict:
    return {
        "id": t.id,
        "meeting_id": t.meeting_id,
        "recording_asset_id": t.recording_asset_id,
        "transcription_job_id": t.transcription_job_id,
        "speaker_id": t.speaker_id,
        "speaker_label": t.speaker_label,
        "text": t.text,
        "start_time": t.start_time,
        "end_time": t.end_time,
        "confidence": t.confidence,
        "created_at": t.created_at.isoformat() if t.created_at else None,
    }


def _summary_has_content(summary: FinalSummary | None) -> bool:
    if summary is None:
        return False
    if (summary.overview or "").strip():
        return True
    if summary.key_decisions or summary.action_items:
        return True
    if (summary.markdown_text or "").strip():
        return True
    return bool(summary.raw_summary_json)


async def _ensure_final_summary(db: AsyncSession, meeting_id: str) -> FinalSummary | None:
    existing_result = await db.execute(
        select(FinalSummary)
        .where(FinalSummary.meeting_id == meeting_id)
        .order_by(FinalSummary.generated_at.desc())
    )
    for existing in existing_result.scalars().all():
        if _summary_has_content(existing):
            return existing

    transcript_result = await db.execute(
        select(TranscriptLine)
        .where(TranscriptLine.meeting_id == meeting_id)
        .order_by(TranscriptLine.start_time)
    )
    transcript_models = transcript_result.scalars().all()
    if not transcript_models:
        return None

    transcript_lines = [
        {
            "id": line.id,
            "speaker": line.speaker_label,
            "speaker_id": line.speaker_id,
            "text": line.text,
            "start": line.start_time,
            "end": line.end_time,
            "confidence": line.confidence,
        }
        for line in transcript_models
    ]

    try:
        submit_final_summary(meeting_id, transcript_lines, [])
    except Exception as exc:
        print(f"[Summary] 生成最终总结失败: {exc}", flush=True)
        raise HTTPException(status_code=500, detail=f"总结生成失败: {str(exc)[:240]}") from exc

    refreshed_result = await db.execute(
        select(FinalSummary)
        .where(FinalSummary.meeting_id == meeting_id)
        .order_by(FinalSummary.generated_at.desc())
    )
    for refreshed in refreshed_result.scalars().all():
        if _summary_has_content(refreshed):
            return refreshed
    return None


# ==================== 摘要查询 ====================

@router.get("/{meeting_id}/summaries/final")
async def get_final_summary(meeting_id: str, db: AsyncSession = Depends(get_db)):
    """获取会议最终摘要"""
    result = await db.execute(
        select(Meeting).where(Meeting.id == meeting_id)
    )
    meeting = result.scalar_one_or_none()
    if not meeting:
        raise HTTPException(status_code=404, detail="Meeting not found")

    fs = await _ensure_final_summary(db, meeting_id)
    if not fs:
        if meeting.status in ("ended", "completed"):
            raise HTTPException(status_code=404, detail="摘要生成中或尚未生成，请稍后重试")
        raise HTTPException(status_code=404, detail="摘要不存在，可能还在处理中")

    action_items = []
    for item in fs.action_items:
        action_items.append({
            "id": str(uuid.uuid4()),
            "content": item.get("content", ""),
            "assignee": item.get("assignee"),
            "due_date": item.get("due_date"),
            "status": item.get("status", "pending"),
        })

    return {
        "id": fs.id,
        "meeting_id": fs.meeting_id,
        "overview": fs.overview,
        "full_text": fs.full_text or fs.overview,
        "markdown": fs.markdown_text,
        "raw_json": fs.raw_summary_json,
        "key_decisions": fs.key_decisions,
        "action_items": action_items,
        "generated_at": fs.generated_at.isoformat() if fs.generated_at else None,
    }


@router.get("/{meeting_id}/summaries/periods")
async def get_period_summaries(meeting_id: str, db: AsyncSession = Depends(get_db)):
    """获取会议各阶段摘要"""
    from app.models.summary import PeriodSummary

    result = await db.execute(
        select(PeriodSummary)
        .where(PeriodSummary.meeting_id == meeting_id)
        .order_by(PeriodSummary.period_start)
    )
    items = []
    for ps in result.scalars().all():
        items.append({
            "id": ps.id,
            "meeting_id": ps.meeting_id,
            "period_start": ps.period_start,
            "period_end": ps.period_end,
            "bullet_points": ps.bullet_points,
            "generated_at": ps.generated_at.isoformat() if ps.generated_at else None,
        })
    return {"items": items}


def _to_response(meeting: Meeting) -> MeetingResponse:
    participants = []
    if meeting.participants:
        try:
            participants = json.loads(meeting.participants)
        except (json.JSONDecodeError, TypeError):
            pass
    return MeetingResponse(
        id=meeting.id,
        title=meeting.title,
        description=meeting.description,
        status=meeting.status,
        participants=participants,
        mode=meeting.mode or "realtime",
        created_at=meeting.created_at,
        updated_at=meeting.updated_at,
    )
