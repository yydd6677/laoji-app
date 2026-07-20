#!/usr/bin/env python3
"""Generate deterministic meeting ASR fixtures with Edge TTS and ffmpeg."""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import shutil
import subprocess
from pathlib import Path
from typing import Any


ROOT = Path(__file__).resolve().parents[1]
DEFAULT_MANIFEST = ROOT / "test-assets/meeting-asr-voice-samples/manifest.json"


def load_samples(manifest_path: Path) -> list[dict[str, Any]]:
    payload = json.loads(manifest_path.read_text(encoding="utf-8"))
    samples = payload.get("samples")
    if not isinstance(samples, list) or not samples:
        raise ValueError("manifest must contain a non-empty samples array")
    if payload.get("count") != len(samples):
        raise ValueError("manifest count does not match samples")
    for sample in samples:
        required = ("id", "text", "voice", "rate", "files")
        if any(not sample.get(field) for field in required):
            raise ValueError(f"sample is missing required fields: {sample!r}")
        if not sample["files"].get("mp3") or not sample["files"].get("wav"):
            raise ValueError(f"sample {sample['id']} must define mp3 and wav files")
    return samples


def resolve_output(value: str) -> Path:
    path = Path(value)
    return path if path.is_absolute() else ROOT / path


def validate_wav(path: Path) -> None:
    import wave

    with wave.open(str(path), "rb") as audio:
        actual = (audio.getframerate(), audio.getsampwidth(), audio.getnchannels())
    expected = (16000, 2, 1)
    if actual != expected:
        raise RuntimeError(f"unexpected WAV format for {path}: {actual} != {expected}")


async def generate_sample(
    sample: dict[str, Any],
    semaphore: asyncio.Semaphore,
    overwrite: bool,
) -> None:
    try:
        import edge_tts
    except ImportError as error:
        raise RuntimeError("install the test-only dependency with: python3 -m pip install edge-tts") from error

    mp3_path = resolve_output(sample["files"]["mp3"])
    wav_path = resolve_output(sample["files"]["wav"])
    if not overwrite and mp3_path.exists() and wav_path.exists():
        validate_wav(wav_path)
        return

    mp3_path.parent.mkdir(parents=True, exist_ok=True)
    wav_path.parent.mkdir(parents=True, exist_ok=True)
    mp3_part = mp3_path.with_suffix(".part.mp3")
    wav_part = wav_path.with_suffix(".part.wav")
    mp3_part.unlink(missing_ok=True)
    wav_part.unlink(missing_ok=True)

    async with semaphore:
        communicate = edge_tts.Communicate(
            sample["text"],
            sample["voice"],
            rate=sample["rate"],
        )
        await communicate.save(str(mp3_part))
        await asyncio.to_thread(
            subprocess.run,
            [
                "ffmpeg",
                "-hide_banner",
                "-loglevel",
                "error",
                "-y",
                "-i",
                str(mp3_part),
                "-ar",
                "16000",
                "-ac",
                "1",
                "-c:a",
                "pcm_s16le",
                str(wav_part),
            ],
            check=True,
        )
        validate_wav(wav_part)
        os.replace(mp3_part, mp3_path)
        os.replace(wav_part, wav_path)
        print(f"generated {sample['id']}: {wav_path.relative_to(ROOT)}")


async def run(manifest_path: Path, concurrency: int, overwrite: bool) -> None:
    if shutil.which("ffmpeg") is None:
        raise RuntimeError("ffmpeg is required to generate 16 kHz PCM WAV fixtures")
    samples = load_samples(manifest_path)
    semaphore = asyncio.Semaphore(concurrency)
    await asyncio.gather(*(
        generate_sample(sample, semaphore, overwrite)
        for sample in samples
    ))


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--manifest", type=Path, default=DEFAULT_MANIFEST)
    parser.add_argument("--concurrency", type=int, default=6)
    parser.add_argument("--overwrite", action="store_true")
    args = parser.parse_args()
    if args.concurrency < 1:
        parser.error("--concurrency must be at least 1")
    asyncio.run(run(args.manifest.resolve(), args.concurrency, args.overwrite))


if __name__ == "__main__":
    main()
