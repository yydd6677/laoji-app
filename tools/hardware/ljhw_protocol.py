#!/usr/bin/env python3
"""LJHW/1 framing and a portable USB probe for LaoJi recorder hardware."""

from __future__ import annotations

import argparse
import json
import os
import struct
import sys
import time
import uuid
import wave
import zlib
from dataclasses import dataclass
from pathlib import Path
from typing import BinaryIO, Iterable


MAGIC = b"LJHW"
PROTOCOL_MAJOR = 1
PROTOCOL_MINOR = 1
HEADER = struct.Struct("<4sBBBBHHIIIII")
HEADER_LENGTH = HEADER.size
MAX_PAYLOAD = 65_536
MAX_CONTROL_PAYLOAD = 8_192

KIND_CONTROL_REQUEST = 0x01
KIND_CONTROL_RESPONSE = 0x02
KIND_EVENT = 0x03
KIND_LIVE_AUDIO = 0x10
KIND_FILE_CHUNK = 0x11
KIND_ACK = 0x12

FLAG_FINAL = 0x01
FLAG_RETRYABLE = 0x02


class ProtocolError(RuntimeError):
    """The peer violated the bounded LJHW/1 wire contract."""


@dataclass(frozen=True)
class Frame:
    kind: int
    flags: int
    stream_id: int
    sequence: int
    correlation_id: int
    payload: bytes
    major: int = PROTOCOL_MAJOR
    minor: int = PROTOCOL_MINOR

    def encode(self) -> bytes:
        if len(self.payload) > MAX_PAYLOAD:
            raise ProtocolError("payload exceeds LJHW/1 maximum")
        if self.kind in (KIND_CONTROL_REQUEST, KIND_CONTROL_RESPONSE, KIND_EVENT, KIND_ACK):
            if len(self.payload) > MAX_CONTROL_PAYLOAD:
                raise ProtocolError("control payload exceeds LJHW/1 maximum")
        if self.flags & ~(FLAG_FINAL | FLAG_RETRYABLE):
            raise ProtocolError("reserved frame flags are set")
        checksum = zlib.crc32(self.payload) & 0xFFFFFFFF if self.payload else 0
        return HEADER.pack(
            MAGIC,
            self.major,
            self.minor,
            self.kind,
            self.flags,
            HEADER_LENGTH,
            0,
            len(self.payload),
            self.stream_id,
            self.sequence,
            self.correlation_id,
            checksum,
        ) + self.payload

    def json(self) -> dict[str, object]:
        if self.kind not in (
            KIND_CONTROL_REQUEST,
            KIND_CONTROL_RESPONSE,
            KIND_EVENT,
            KIND_ACK,
        ):
            raise ProtocolError("frame does not contain control JSON")
        try:
            value = json.loads(self.payload.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError) as error:
            raise ProtocolError("invalid control JSON") from error
        if not isinstance(value, dict):
            raise ProtocolError("control JSON must be an object")
        return value


class FrameDecoder:
    """Incremental decoder that re-synchronizes after USB boot noise."""

    def __init__(self) -> None:
        self._buffer = bytearray()

    def feed(self, data: bytes) -> list[Frame]:
        self._buffer.extend(data)
        frames: list[Frame] = []
        while True:
            magic_at = self._buffer.find(MAGIC)
            if magic_at < 0:
                if len(self._buffer) > len(MAGIC) - 1:
                    del self._buffer[: -(len(MAGIC) - 1)]
                break
            if magic_at:
                del self._buffer[:magic_at]
            if len(self._buffer) < HEADER_LENGTH:
                break
            (
                magic,
                major,
                minor,
                kind,
                flags,
                header_length,
                reserved,
                payload_length,
                stream_id,
                sequence,
                correlation_id,
                checksum,
            ) = HEADER.unpack_from(self._buffer)
            if magic != MAGIC:
                del self._buffer[0]
                continue
            if header_length != HEADER_LENGTH or reserved != 0:
                del self._buffer[0]
                continue
            if payload_length > MAX_PAYLOAD:
                del self._buffer[0]
                continue
            total = HEADER_LENGTH + payload_length
            if len(self._buffer) < total:
                break
            payload = bytes(self._buffer[HEADER_LENGTH:total])
            del self._buffer[:total]
            if major != PROTOCOL_MAJOR:
                raise ProtocolError(f"unsupported LJHW major version {major}")
            if flags & ~(FLAG_FINAL | FLAG_RETRYABLE):
                raise ProtocolError("peer set reserved frame flags")
            expected = zlib.crc32(payload) & 0xFFFFFFFF if payload else 0
            if checksum != expected:
                raise ProtocolError("payload CRC mismatch")
            if kind in (KIND_CONTROL_REQUEST, KIND_CONTROL_RESPONSE, KIND_EVENT, KIND_ACK):
                if payload_length > MAX_CONTROL_PAYLOAD:
                    raise ProtocolError("peer control payload is too large")
            frames.append(
                Frame(
                    major=major,
                    minor=minor,
                    kind=kind,
                    flags=flags,
                    stream_id=stream_id,
                    sequence=sequence,
                    correlation_id=correlation_id,
                    payload=payload,
                )
            )
        return frames


def control_payload(op: str, **values: object) -> bytes:
    body: dict[str, object] = {"schema_version": 1, "op": op}
    body.update(values)
    encoded = json.dumps(body, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    if len(encoded) > MAX_CONTROL_PAYLOAD:
        raise ProtocolError("control JSON is too large")
    return encoded


def find_test_board_port() -> str:
    try:
        from serial.tools import list_ports
    except ImportError as error:
        raise RuntimeError("需要安装 pyserial：python3 -m pip install pyserial") from error
    matches = [
        info.device
        for info in list_ports.comports()
        if info.vid == 0x303A and info.pid == 0x1001
    ]
    if not matches:
        raise RuntimeError("未发现 USB 连接的 ESP32-S3 测试板")
    if len(matches) > 1:
        raise RuntimeError("发现多块测试板，请使用 --port 明确指定")
    return matches[0]


class SerialPeer:
    def __init__(self, port: str, baudrate: int = 115_200) -> None:
        try:
            import serial
        except ImportError as error:
            raise RuntimeError("需要安装 pyserial：python3 -m pip install pyserial") from error
        self._serial = serial.Serial()
        self._serial.port = port
        self._serial.baudrate = baudrate
        self._serial.timeout = 0.15
        self._serial.write_timeout = 3
        self._serial.dtr = False
        self._serial.rts = False
        self._serial.open()
        self._decoder = FrameDecoder()
        self._tx_sequence = 1
        self._correlation = 1

    def close(self) -> None:
        self._serial.close()

    def frames(self, deadline: float) -> Iterable[Frame]:
        while time.monotonic() < deadline:
            data = self._serial.read(16_384)
            if not data:
                continue
            yield from self._decoder.feed(data)

    def request(self, op: str, timeout: float = 5.0, **values: object) -> tuple[dict[str, object], list[Frame]]:
        correlation = self._correlation
        self._correlation += 1
        command_id = str(values.pop("command_id", uuid.uuid4()))
        frame = Frame(
            kind=KIND_CONTROL_REQUEST,
            flags=0,
            stream_id=0,
            sequence=self._tx_sequence,
            correlation_id=correlation,
            payload=control_payload(op, command_id=command_id, **values),
        )
        self._tx_sequence += 1
        self._serial.write(frame.encode())
        self._serial.flush()
        side_frames: list[Frame] = []
        for received in self.frames(time.monotonic() + timeout):
            if received.kind == KIND_CONTROL_RESPONSE and received.correlation_id == correlation:
                response = received.json()
                if response.get("ok") is not True:
                    error = response.get("error")
                    raise ProtocolError(f"device rejected {op}: {error}")
                return response, side_frames
            side_frames.append(received)
        raise TimeoutError(f"device did not answer {op}")

    def hello(self) -> dict[str, object]:
        # A CDC open may reset the ESP32-S3. Let boot noise arrive, then rely on
        # the decoder's magic re-synchronization.
        time.sleep(1.2)
        response, _ = self.request(
            "hello",
            app={"name": "laoji-hardware-probe", "version": "1"},
            supported_protocols=[{"major": 1, "minor": 1}],
            transports=["usb"],
        )
        return response


def record(peer: SerialPeer, seconds: float, output: Path) -> dict[str, object]:
    session_id = str(uuid.uuid4())
    _, initial = peer.request(
        "capture.start",
        session_id=session_id,
        audio={"codec": "pcm_s16le", "sample_rate_hz": 16_000, "channels": 1},
    )
    output.parent.mkdir(parents=True, exist_ok=True)
    temp = output.with_name(f".{output.name}.part")
    stream_id: int | None = None
    frames = 0
    pcm_bytes = 0
    started = time.monotonic()
    with wave.open(str(temp), "wb") as wav:
        wav.setnchannels(1)
        wav.setsampwidth(2)
        wav.setframerate(16_000)

        def accept(frame: Frame) -> None:
            nonlocal stream_id, frames, pcm_bytes
            if frame.kind == KIND_EVENT:
                event = frame.json()
                if event.get("op") == "capture.started":
                    audio = event.get("audio")
                    if not isinstance(audio, dict) or audio.get("codec") != "pcm_s16le":
                        raise ProtocolError("test board selected an unsupported audio profile")
                    stream_id = int(event.get("stream_id", 0))
            elif frame.kind == KIND_LIVE_AUDIO and frame.payload:
                if stream_id is not None and frame.stream_id != stream_id:
                    raise ProtocolError("audio stream identity changed")
                if len(frame.payload) % 2:
                    raise ProtocolError("PCM frame is not sample-aligned")
                stream_id = frame.stream_id
                wav.writeframesraw(frame.payload)
                frames += 1
                pcm_bytes += len(frame.payload)

        for frame in initial:
            accept(frame)
        deadline = started + seconds
        for frame in peer.frames(deadline):
            accept(frame)
        _, final_side = peer.request("capture.stop", session_id=session_id, timeout=8.0)
        for frame in final_side:
            accept(frame)
        drain_deadline = time.monotonic() + 1.0
        for frame in peer.frames(drain_deadline):
            accept(frame)
            if frame.kind == KIND_EVENT and frame.json().get("op") == "capture.finished":
                break
    if pcm_bytes <= 0:
        temp.unlink(missing_ok=True)
        raise ProtocolError("device returned no audio samples")
    os.replace(temp, output)
    return {
        "session_id": session_id,
        "stream_id": stream_id,
        "frames": frames,
        "pcm_bytes": pcm_bytes,
        "duration_seconds": pcm_bytes / (16_000 * 2),
        "output": str(output.resolve()),
    }


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="老记 LJHW/1 测试板探针")
    parser.add_argument("--port", default="auto", help="串口；默认自动寻找 303a:1001")
    sub = parser.add_subparsers(dest="command", required=True)
    sub.add_parser("hello", help="读取协议、设备身份和能力")
    sub.add_parser("status", help="读取设备状态")
    record_parser = sub.add_parser("record", help="通过 LJHW/1 录制真实 WAV")
    record_parser.add_argument("--seconds", type=float, default=5.0)
    record_parser.add_argument("--output", type=Path, required=True)
    return parser


def main() -> int:
    args = build_parser().parse_args()
    if getattr(args, "seconds", 1.0) <= 0 or getattr(args, "seconds", 1.0) > 300:
        raise ValueError("--seconds 必须在 0 到 300 秒之间")
    port = find_test_board_port() if args.port == "auto" else args.port
    peer = SerialPeer(port)
    try:
        hello = peer.hello()
        if args.command == "hello":
            result: object = hello
        elif args.command == "status":
            result, _ = peer.request("status.get")
        else:
            result = {"hello": hello, "recording": record(peer, args.seconds, args.output)}
    finally:
        peer.close()
    print(json.dumps(result, ensure_ascii=False, indent=2, sort_keys=True))
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (OSError, RuntimeError, TimeoutError, ValueError) as error:
        print(f"硬件探针失败：{error}", file=sys.stderr)
        raise SystemExit(1)
