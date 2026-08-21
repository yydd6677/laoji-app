#!/usr/bin/env python3
"""Inject a PCM WAV into an Android Emulator microphone over its local gRPC API.

The emulator must be started with ``-grpc <port>``.  This helper is intentionally
kept outside product runtime code; it makes schedule-voice and realtime-ASR
replays deterministic without granting the emulator access to the host's real
microphone.
"""

from __future__ import annotations

import argparse
import importlib
import os
from pathlib import Path
import sys
import tempfile
import time
import wave


def _load_stubs(sdk_root: Path):
    try:
        import grpc  # type: ignore
        from grpc_tools import protoc  # type: ignore
        import grpc_tools  # type: ignore
    except ImportError as error:
        raise SystemExit("grpcio and grpcio-tools are required") from error

    proto_dir = sdk_root / "emulator" / "lib"
    proto_file = proto_dir / "emulator_controller.proto"
    if not proto_file.is_file():
        raise SystemExit(f"Android emulator proto not found: {proto_file}")
    google_proto_dir = Path(grpc_tools.__file__).resolve().parent / "_proto"
    generated = tempfile.TemporaryDirectory(prefix="laoji-emulator-grpc-")
    result = protoc.main([
        "grpc_tools.protoc",
        f"-I{proto_dir}",
        f"-I{google_proto_dir}",
        f"--python_out={generated.name}",
        f"--grpc_python_out={generated.name}",
        str(proto_file),
    ])
    if result != 0:
        generated.cleanup()
        raise SystemExit(f"protoc failed with exit code {result}")
    sys.path.insert(0, generated.name)
    pb2 = importlib.import_module("emulator_controller_pb2")
    pb2_grpc = importlib.import_module("emulator_controller_pb2_grpc")
    return grpc, pb2, pb2_grpc, generated


def _packets(pb2, wav_path: Path, chunk_ms: int, realtime: bool):
    with wave.open(str(wav_path), "rb") as source:
        channels = source.getnchannels()
        sample_width = source.getsampwidth()
        sample_rate = source.getframerate()
        if channels not in (1, 2) or sample_width not in (1, 2) or sample_rate > 48_000:
            raise SystemExit(
                "WAV must be mono/stereo, unsigned 8-bit or signed 16-bit PCM, <=48 kHz",
            )
        frames_per_chunk = max(1, sample_rate * chunk_ms // 1_000)
        audio_format = pb2.AudioFormat(
            samplingRate=sample_rate,
            channels=pb2.AudioFormat.Mono if channels == 1 else pb2.AudioFormat.Stereo,
            format=(
                pb2.AudioFormat.AUD_FMT_U8
                if sample_width == 1
                else pb2.AudioFormat.AUD_FMT_S16
            ),
            mode=(
                pb2.AudioFormat.MODE_REAL_TIME
                if realtime
                else pb2.AudioFormat.MODE_UNSPECIFIED
            ),
        )
        started = time.monotonic()
        packet_index = 0
        while True:
            audio = source.readframes(frames_per_chunk)
            if not audio:
                break
            if realtime:
                due = started + packet_index * chunk_ms / 1_000
                remaining = due - time.monotonic()
                if remaining > 0:
                    time.sleep(remaining)
            yield pb2.AudioPacket(
                format=audio_format,
                timestamp=int(time.time() * 1_000_000),
                audio=audio,
            )
            packet_index += 1


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("wav", type=Path)
    parser.add_argument("--endpoint", default="127.0.0.1:8554")
    parser.add_argument("--android-sdk", type=Path, default=None)
    parser.add_argument("--chunk-ms", type=int, default=20)
    parser.add_argument("--real-time", action="store_true")
    args = parser.parse_args()
    sdk_root = args.android_sdk or Path(
        os.environ.get("ANDROID_SDK_ROOT") or os.environ.get("ANDROID_HOME") or "~/Android/Sdk",
    ).expanduser()
    if not args.wav.is_file():
        raise SystemExit(f"WAV not found: {args.wav}")
    if not 5 <= args.chunk_ms <= 100:
        raise SystemExit("--chunk-ms must be between 5 and 100")

    grpc, pb2, pb2_grpc, generated = _load_stubs(sdk_root)
    try:
        from google.protobuf import empty_pb2  # type: ignore

        with grpc.insecure_channel(args.endpoint) as channel:
            grpc.channel_ready_future(channel).result(timeout=10)
            stub = pb2_grpc.EmulatorControllerStub(channel)
            microphone = stub.getMicrophoneState(empty_pb2.Empty(), timeout=10)
            if microphone.realAudioEnabled:
                stub.setMicrophoneState(
                    pb2.MicrophoneState(realAudioEnabled=False),
                    timeout=10,
                )
            stub.injectAudio(
                _packets(pb2, args.wav, args.chunk_ms, args.real_time),
                timeout=max(30, int(args.wav.stat().st_size / 16_000) + 30),
            )
    finally:
        generated.cleanup()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
