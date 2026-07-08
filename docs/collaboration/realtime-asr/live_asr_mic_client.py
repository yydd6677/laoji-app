#!/usr/bin/env python3
"""
Live microphone ASR WebSocket test client.

Opens a local microphone, captures 16kHz mono signed 16-bit PCM, streams it to
the backend WebSocket endpoint, prints realtime transcripts, and gracefully
finishes when Ctrl+C is pressed.

Dependencies:
    pip install websockets sounddevice

Example:
    python live_asr_mic_client.py --host 183.36.243.124 --mode funasr --auto-summary
"""

from __future__ import annotations

import argparse
import asyncio
import json
import signal
import sys
import time
import uuid
from math import sqrt
from typing import Any
from urllib import request

TARGET_RATE = 16000
TARGET_CHANNELS = 1
TARGET_DTYPE = "int16"
DEFAULT_CHUNK_MS = 100


def post_json(url: str, payload: dict[str, Any], timeout: int = 30) -> dict[str, Any]:
    body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    req = request.Request(
        url,
        data=body,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    with request.urlopen(req, timeout=timeout) as resp:
        return json.loads(resp.read().decode("utf-8"))


def get_json(url: str, timeout: int = 30) -> dict[str, Any]:
    with request.urlopen(url, timeout=timeout) as resp:
        return json.loads(resp.read().decode("utf-8"))


def pcm16_level(frame: bytes) -> tuple[float, float]:
    """Return (rms, peak) for little-endian signed int16 PCM, normalized to 0..1."""
    if not frame:
        return 0.0, 0.0
    samples = memoryview(frame).cast("h")
    if not samples:
        return 0.0, 0.0
    total = 0
    peak = 0
    for sample in samples:
        v = int(sample)
        av = abs(v)
        total += v * v
        if av > peak:
            peak = av
    rms = sqrt(total / len(samples)) / 32768.0
    return rms, peak / 32768.0


def create_meeting(api_base_url: str, title: str, mode: str) -> str:
    data = post_json(
        api_base_url.rstrip("/") + "/api/meetings",
        {
            "title": title,
            "description": "Live microphone realtime ASR test",
            "participants": [],
            "mode": "realtime" if mode == "funasr" else mode,
        },
    )
    meeting_id = data.get("id")
    if not meeting_id:
        raise RuntimeError("Create meeting response does not contain id: %r" % data)
    return meeting_id


def trigger_summary(api_base_url: str, meeting_id: str) -> str:
    url = api_base_url.rstrip() + f"/api/meetings/{meeting_id}/summaries/generate?summary_type=final"
    data = post_json(url, {})
    task_id = data.get("task_id")
    if not task_id:
        raise RuntimeError("Generate summary response does not contain task_id: %r" % data)
    print("[summary] submitted task_id=%s transcript_count=%s" % (task_id, data.get("transcript_count")))
    return task_id


async def poll_summary(api_base_url: str, meeting_id: str, task_id: str, interval_sec: int) -> None:
    task_url = api_base_url.rstrip("/") + f"/api/meetings/{meeting_id}/summaries/task/{task_id}"
    final_url = api_base_url.rstrip("/") + f"/api/meetings/{meeting_id}/summaries/final"

    while True:
        status = await asyncio.to_thread(get_json, task_url)
        state = status.get("status")
        print("[summary] status=%s" % state)
        if state == "SUCCESS":
            final_summary = await asyncio.to_thread(get_json, final_url)
            print("[summary] final overview:")
            print(final_summary.get("overview") or "")
            markdown = final_summary.get("markdown")
            if markdown:
                print("[summary] markdown:")
                print(markdown)
            return
        if state == "FAILURE":
            raise RuntimeError("Summary failed: %s" % status.get("result"))
        await asyncio.sleep(interval_sec)


async def stream_microphone(args: argparse.Namespace) -> None:
    try:
        import websockets
    except ImportError as exc:
        raise SystemExit("Missing dependency. Install it with: pip install websockets") from exc

    try:
        import sounddevice as sd
    except ImportError as exc:
        raise SystemExit("Missing dependency. Install it with: pip install sounddevice") from exc

    meeting_id = args.meeting_id
    if args.create_meeting and not meeting_id:
        meeting_id = await asyncio.to_thread(create_meeting, args.api_base_url, args.title, args.mode)
    elif not meeting_id:
        meeting_id = str(uuid.uuid4())
        print(
            "[warn] generated a temporary meeting_id. Use --create-meeting or --meeting-id "
            "if you need transcript persistence and summary."
        )

    ws_url = args.ws_url or (
        "%s://%s:%s/ws/meeting/%s/%s"
        % (args.ws_scheme, args.host, args.port, meeting_id, args.mode)
    )

    print("[meeting_id] %s" % meeting_id)
    print("[websocket] %s" % ws_url)
    print("[audio] input device: %s" % ("default" if args.device is None else args.device))
    print("[audio] capture: 16000 Hz, mono, signed 16-bit PCM")
    print("[control] press Ctrl+C to stop, send end frame, and finish gracefully")

    loop = asyncio.get_running_loop()
    stop_event = asyncio.Event()
    audio_queue: asyncio.Queue[bytes | None] = asyncio.Queue(maxsize=args.queue_size)
    dropped_frames = 0
    transcript_count = 0
    started_at = time.monotonic()
    last_level_print = 0.0

    def request_stop(signum=None, frame=None):
        loop.call_soon_threadsafe(stop_event.set)

    old_sigint = signal.getsignal(signal.SIGINT)
    signal.signal(signal.SIGINT, request_stop)

    def enqueue_audio(data: bytes):
        nonlocal dropped_frames
        try:
            audio_queue.put_nowait(data)
        except asyncio.QueueFull:
            dropped_frames += 1

    def audio_callback(indata, frames, time_info, status):
        if status:
            print("[audio] status: %s" % status, file=sys.stderr)
        data = bytes(indata)
        loop.call_soon_threadsafe(enqueue_audio, data)

    blocksize = max(1, int(TARGET_RATE * args.chunk_ms / 1000))

    try:
        async with websockets.connect(ws_url, max_size=None, ping_interval=20, ping_timeout=60) as ws:
            print("[websocket] connected")

            async def sender():
                nonlocal last_level_print
                sent_frames = 0
                sent_bytes = 0
                gated_frames = 0
                with sd.RawInputStream(
                    samplerate=TARGET_RATE,
                    blocksize=blocksize,
                    channels=TARGET_CHANNELS,
                    dtype=TARGET_DTYPE,
                    device=args.device,
                    callback=audio_callback,
                ):
                    print("[audio] recording started")
                    while not stop_event.is_set():
                        frame = await audio_queue.get()
                        if frame is None:
                            break
                        rms, peak = pcm16_level(frame)
                        if args.level_meter:
                            now = time.monotonic()
                            if now - last_level_print >= 1.0:
                                print("[level] rms=%.4f peak=%.4f gated=%d dropped=%d" % (
                                    rms, peak, gated_frames, dropped_frames
                                ))
                                last_level_print = now
                        if args.noise_gate and rms < args.noise_gate_threshold:
                            frame = b"\x00" * len(frame)
                            gated_frames += 1
                        await ws.send(frame)
                        sent_frames += 1
                        sent_bytes += len(frame)
                        if args.verbose and sent_frames % 50 == 0:
                            seconds = sent_bytes / (TARGET_RATE * 2)
                            print("[send] %.1fs audio sent, dropped=%d" % (seconds, dropped_frames))

                # Drain a small tail, then signal end of audio.
                while not audio_queue.empty():
                    frame = audio_queue.get_nowait()
                    if frame:
                        await ws.send(frame)
                await ws.send(b"")
                print("[send] end frame sent")

            async def receiver():
                nonlocal transcript_count
                async for message in ws:
                    try:
                        data = json.loads(message)
                    except json.JSONDecodeError:
                        print("[recv] non-json message: %r" % message)
                        continue

                    msg_type = data.get("type")
                    if msg_type == "config":
                        print("[recv] config: %s" % json.dumps(data, ensure_ascii=False))
                    elif msg_type == "transcript.completed":
                        transcript_count += 1
                        speaker = data.get("speaker_name") or data.get("speaker_id") or "unknown"
                        start = data.get("start_time", 0) or 0
                        end = data.get("end_time", 0) or 0
                        text = (data.get("text") or "").strip()
                        print("[%7.2fs-%7.2fs] %s: %s" % (start, end, speaker, text))
                        if args.output_jsonl:
                            with open(args.output_jsonl, "a", encoding="utf-8") as f:
                                f.write(json.dumps(data, ensure_ascii=False) + "\n")
                    elif msg_type == "ready_to_stop":
                        print("[recv] ready_to_stop")
                        break
                    elif msg_type == "error":
                        raise RuntimeError(data.get("message", "unknown websocket error"))
                    else:
                        print("[recv] %s: %s" % (msg_type, json.dumps(data, ensure_ascii=False)))

            await asyncio.gather(sender(), receiver())

    finally:
        signal.signal(signal.SIGINT, old_sigint)

    elapsed = time.monotonic() - started_at
    print("[done] transcripts=%d elapsed=%.1fs meeting_id=%s" % (transcript_count, elapsed, meeting_id))
    transcript_url = args.api_base_url.rstrip("/") + f"/api/meetings/{meeting_id}/transcripts?limit=1000&offset=0"
    print("[next] query transcripts: %s" % transcript_url)

    if args.auto_summary:
        task_id = await asyncio.to_thread(trigger_summary, args.api_base_url, meeting_id)
        await poll_summary(args.api_base_url, meeting_id, task_id, args.summary_poll_interval)


def parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Live microphone realtime ASR WebSocket client")
    parser.add_argument("--host", default="183.36.243.124", help="Backend host or IP")
    parser.add_argument("--port", default="8020", help="Backend port")
    parser.add_argument("--mode", default="funasr", choices=["funasr", "whisper", "qwen"], help="ASR mode")
    parser.add_argument("--meeting-id", help="Existing meeting_id. If provided, the script will not create a meeting.")
    parser.add_argument("--create-meeting", dest="create_meeting", action="store_true", help="Create meeting before streaming. Enabled by default.")
    parser.add_argument("--no-create-meeting", dest="create_meeting", action="store_false", help="Do not create meeting; console-only test.")
    parser.add_argument("--title", default="Live microphone ASR test", help="Meeting title when creating meeting")
    parser.add_argument("--api-base-url", default="http://183.36.243.124:8020", help="REST API base URL")
    parser.add_argument("--ws-scheme", default="ws", choices=["ws", "wss"], help="WebSocket scheme")
    parser.add_argument("--ws-url", help="Full WebSocket URL. Overrides host/port/mode/meeting-id URL building.")
    parser.add_argument("--device", help="Input device id/name for sounddevice. Omit for default microphone.")
    parser.add_argument("--chunk-ms", type=int, default=DEFAULT_CHUNK_MS, help="Audio frame size in milliseconds")
    parser.add_argument("--queue-size", type=int, default=200, help="Audio frame queue size")
    parser.add_argument("--noise-gate", dest="noise_gate", action="store_true", help="Replace low-level input frames with silence. Enabled by default.")
    parser.add_argument("--no-noise-gate", dest="noise_gate", action="store_false", help="Disable client-side noise gate.")
    parser.add_argument("--noise-gate-threshold", type=float, default=0.004, help="RMS threshold for client-side noise gate, normalized 0..1")
    parser.add_argument("--level-meter", action="store_true", help="Print microphone RMS/peak once per second")
    parser.add_argument("--output-jsonl", help="Optional file path to save transcript.completed JSON lines")
    parser.add_argument("--auto-summary", action="store_true", help="Trigger and poll final summary after Ctrl+C")
    parser.add_argument("--summary-poll-interval", type=int, default=20, help="Summary polling interval in seconds")
    parser.add_argument("--verbose", action="store_true", help="Print send progress")
    parser.set_defaults(create_meeting=True, noise_gate=True)
    return parser.parse_args(argv)


def main(argv: list[str]) -> int:
    args = parse_args(argv)
    try:
        asyncio.run(stream_microphone(args))
        return 0
    except KeyboardInterrupt:
        # Signal handler should do graceful shutdown. This is only for a second Ctrl+C.
        print("\n[stop] interrupted by user")
        return 130
    except Exception as exc:
        print("[error] %s" % exc, file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
