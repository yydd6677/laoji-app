"""Device-owned voiceprint audio validation and CAM++ feature extraction."""

from __future__ import annotations

import asyncio
import io
import os
import subprocess
import tempfile
from pathlib import Path

from fastapi import HTTPException, UploadFile, status
import numpy as np
import soundfile as sf
from scipy import signal


MAX_AUDIO_BYTES = 10 * 1024 * 1024
MIN_SAMPLE_DURATION_SECONDS = 2.0
MAX_SAMPLE_DURATION_SECONDS = 15.0
MIN_QUALITY_SCORE = 0.2


def voiceprint_cosine(left: np.ndarray, right: np.ndarray) -> float:
    return float(
        np.dot(left, right)
        / (np.linalg.norm(left) * np.linalg.norm(right) + 1e-8)
    )


def _quality_level(score: float) -> tuple[str, str]:
    for threshold, level, description in (
        (0.8, "优秀", "声纹特征明显，识别准确率高"),
        (0.6, "良好", "声纹特征较明显，识别效果良好"),
        (0.4, "一般", "声纹特征一般，建议重新录制"),
        (0.0, "较差", "声纹特征不明显，请改善录音环境后重新录制"),
    ):
        if score >= threshold:
            return level, description
    raise AssertionError("unreachable")


def _quality_issues(audio_data: np.ndarray) -> list[str]:
    issues: list[str] = []
    duration_seconds = len(audio_data) / 16_000.0
    energy = float(np.sqrt(np.mean(audio_data ** 2)))
    if duration_seconds < MIN_SAMPLE_DURATION_SECONDS:
        issues.append("录音时长过短")
    elif duration_seconds > MAX_SAMPLE_DURATION_SECONDS:
        issues.append("录音时长过长")
    if energy < 0.02:
        issues.append("录音音量过小")
    elif energy > 0.8:
        issues.append("录音音量过大")
    if 20 * np.log10(energy + 1e-8) < -40:
        issues.append("录音信噪比较低")
    return issues


def _resample_to_16k_mono(audio_data: np.ndarray, sample_rate: int) -> np.ndarray:
    if sample_rate <= 0:
        raise ValueError("audio_sample_rate_invalid")
    if audio_data.dtype in (np.float32, np.float64):
        normalized = np.clip(audio_data, -1.0, 1.0).astype(np.float32)
    else:
        normalized = audio_data.astype(np.float32) / 32768.0
    if normalized.ndim > 1:
        normalized = np.mean(normalized, axis=1).astype(np.float32)
    if sample_rate == 16_000:
        return normalized
    return signal.resample_poly(normalized, 16_000, sample_rate).astype(np.float32)


def _decode_audio(content: bytes, file_name: str) -> np.ndarray:
    try:
        samples, sample_rate = sf.read(io.BytesIO(content))
        return _resample_to_16k_mono(samples, int(sample_rate))
    except Exception:
        pass

    suffix = Path(file_name).suffix.lower()
    if not suffix or len(suffix) > 12 or not suffix[1:].isalnum():
        suffix = ".audio"
    input_name = output_name = ""
    try:
        with tempfile.NamedTemporaryFile(suffix=suffix, delete=False) as source:
            source.write(content)
            input_name = source.name
        with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as target:
            output_name = target.name
        result = subprocess.run(
            [
                "ffmpeg", "-y", "-hide_banner", "-loglevel", "error",
                "-i", input_name, "-ar", "16000", "-ac", "1",
                "-acodec", "pcm_s16le", output_name,
            ],
            capture_output=True,
            check=False,
            timeout=60,
        )
        if result.returncode != 0:
            raise ValueError("audio_decode_failed")
        samples, sample_rate = sf.read(output_name)
        return _resample_to_16k_mono(samples, int(sample_rate))
    finally:
        for value in (input_name, output_name):
            if value:
                try:
                    os.unlink(value)
                except FileNotFoundError:
                    pass


async def read_device_speaker_audio(audio: UploadFile) -> np.ndarray:
    content = await audio.read(MAX_AUDIO_BYTES + 1)
    file_name = audio.filename or "voice.wav"
    await audio.close()
    if not content:
        raise HTTPException(status_code=400, detail="录音文件为空")
    if len(content) > MAX_AUDIO_BYTES:
        raise HTTPException(status_code=413, detail="录音文件过大")
    try:
        samples = await asyncio.to_thread(_decode_audio, content, file_name)
    except Exception as error:
        raise HTTPException(status_code=400, detail="无法读取录音文件") from error
    duration_seconds = len(samples) / 16_000.0
    if duration_seconds < MIN_SAMPLE_DURATION_SECONDS:
        raise HTTPException(status_code=400, detail="录音时间太短")
    if duration_seconds > MAX_SAMPLE_DURATION_SECONDS:
        raise HTTPException(status_code=400, detail="录音时间太长")
    rms = float(np.sqrt(np.mean(np.square(samples, dtype=np.float64))))
    if rms < 0.01:
        raise HTTPException(status_code=400, detail="没有检测到清晰人声")
    if float(np.mean(np.abs(samples) >= 0.99)) > 0.08:
        raise HTTPException(status_code=400, detail="录音音量过大并出现失真")
    return samples


async def extract_device_voiceprint_features(
    audio_data: np.ndarray,
) -> tuple[np.ndarray, float, str, str, list[str], list[str]]:
    try:
        from app.asr.model_manager import SpeakerEmbeddingExtractor, get_model_manager

        manager = get_model_manager()
        if not manager.is_initialized():
            await manager.initialize()
        model = manager.get_camp_model()
        if model is None:
            raise RuntimeError("campplus_unavailable")
        extractor = SpeakerEmbeddingExtractor(model, device=manager.device)
        embedding = await asyncio.to_thread(extractor.extract, audio_data)
        if embedding is None or np.linalg.norm(embedding) < 1e-7:
            raise RuntimeError("voiceprint_embedding_empty")
        embedding = embedding.astype(np.float32)
    except Exception as error:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="声纹服务暂时不可用，请稍后重试",
        ) from error

    energy = float(np.sqrt(np.mean(audio_data ** 2)))
    embedding_norm = float(np.linalg.norm(embedding))
    duration_seconds = len(audio_data) / 16_000.0
    if energy < 0.001:
        energy_score = 0.0
    elif energy < 0.02:
        energy_score = 0.2
    elif energy < 0.05:
        energy_score = 0.5
    elif energy < 0.15:
        energy_score = 0.8
    elif energy < 0.3:
        energy_score = 1.0
    else:
        energy_score = max(0.5, 1.0 - (energy - 0.3) / 0.5)
    embedding_score = (
        1.0
        if 0.9 <= embedding_norm <= 1.1
        else max(0.3, 1.0 - abs(embedding_norm - 1.0) * 2)
    )
    duration_score = 1.0 if duration_seconds <= MAX_SAMPLE_DURATION_SECONDS else 0.8
    quality = max(
        0.05,
        min(0.99, energy_score * 0.35 + embedding_score * 0.35 + duration_score * 0.2 + 0.07),
    )
    level, description = _quality_level(quality)
    issues = _quality_issues(audio_data)
    suggestions = ["请在安静环境中重新录制"] if quality < MIN_QUALITY_SCORE else []
    if quality < MIN_QUALITY_SCORE:
        raise HTTPException(
            status_code=400,
            detail={
                "message": "这段录音暂时不能建立可靠声纹",
                "quality": round(quality, 3),
                "quality_level": level,
                "quality_issues": issues,
                "suggestions": suggestions,
            },
        )
    return embedding, quality, level, description, issues, suggestions
