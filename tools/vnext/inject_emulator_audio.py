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
import queue
import sys
import tempfile
import threading
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


def inject_audio(
    endpoint: str,
    wav_path: Path,
    *,
    stubs,
    chunk_ms: int = 20,
    realtime: bool = False,
) -> None:
    """Inject one WAV while reusing already-generated emulator gRPC stubs."""
    if not wav_path.is_file():
        raise SystemExit(f"WAV not found: {wav_path}")
    if not 5 <= chunk_ms <= 100:
        raise SystemExit("--chunk-ms must be between 5 and 100")
    with EmulatorMicrophoneInjector(endpoint, stubs) as injector:
        injector.prepare()
        injector.inject(wav_path, chunk_ms=chunk_ms, realtime=realtime)


class EmulatorMicrophoneInjector:
    """Keep one emulator microphone stream alive across replay runs."""

    def __init__(self, endpoint: str, stubs):
        self.grpc, self.pb2, pb2_grpc, _generated = stubs
        self.channel = self.grpc.insecure_channel(endpoint)
        self.grpc.channel_ready_future(self.channel).result(timeout=10)
        self.stub = pb2_grpc.EmulatorControllerStub(self.channel)
        self.jobs = queue.Queue()
        self.prepared = False
        self.stream_failure = None
        self.stream_thread = None

    def __enter__(self):
        return self

    def __exit__(self, _exc_type, _exc, _traceback):
        self.close()

    def prepare(self) -> None:
        """Register virtual input before Android starts measuring capture."""
        if self.prepared:
            if self.stream_failure is not None:
                raise self.stream_failure
            return
        from google.protobuf import empty_pb2  # type: ignore

        self.stub.getMicrophoneState(empty_pb2.Empty(), timeout=10)
        self.stub.setMicrophoneState(
            self.pb2.MicrophoneState(realAudioEnabled=False),
            timeout=10,
        )
        self.prepared = True
        self.stream_thread = threading.Thread(
            target=self._run_stream,
            name="laoji-emulator-microphone",
            daemon=True,
        )
        self.stream_thread.start()

    def _packet_stream(self):
        while True:
            job = self.jobs.get()
            if job is None:
                return
            wav_path, chunk_ms, realtime, done, errors = job
            try:
                yield from _packets(self.pb2, wav_path, chunk_ms, realtime)
            except BaseException as error:
                errors.append(error)
                raise
            finally:
                done.set()

    def _run_stream(self) -> None:
        try:
            self.stub.injectAudio(self._packet_stream())
        except BaseException as error:
            self.stream_failure = error
            while True:
                try:
                    job = self.jobs.get_nowait()
                except queue.Empty:
                    break
                if job is not None:
                    job[4].append(error)
                    job[3].set()

    def inject(self, wav_path: Path, *, chunk_ms: int = 20, realtime: bool = False) -> None:
        if not wav_path.is_file():
            raise SystemExit(f"WAV not found: {wav_path}")
        if not self.prepared:
            self.prepare()
        if self.stream_failure is not None:
            raise self.stream_failure
        done = threading.Event()
        errors = []
        self.jobs.put((wav_path, chunk_ms, realtime, done, errors))
        timeout = max(30, int(wav_path.stat().st_size / 16_000) + 30)
        if not done.wait(timeout):
            raise TimeoutError("emulator microphone injection timed out")
        if errors:
            raise errors[0]
        if self.stream_failure is not None:
            raise self.stream_failure

    def close(self) -> None:
        if self.prepared and self.stream_thread is not None:
            self.jobs.put(None)
            self.stream_thread.join(timeout=10)
        self.channel.close()


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
    stubs = _load_stubs(sdk_root)
    try:
        inject_audio(
            args.endpoint,
            args.wav,
            stubs=stubs,
            chunk_ms=args.chunk_ms,
            realtime=args.real_time,
        )
    finally:
        stubs[3].cleanup()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
