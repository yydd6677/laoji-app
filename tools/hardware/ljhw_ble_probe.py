#!/usr/bin/env python3
"""Portable BLE probe for the LJHW/1 control and live-audio profile.

This script deliberately uses the same complete LJHW frames as the USB probe.
BLE adds only the bounded six-byte fragment envelope defined by LJHW/1.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import struct
import sys
import time
import uuid
import wave
from dataclasses import dataclass
from pathlib import Path

try:
    from bleak import BleakClient, BleakScanner
except ImportError as error:  # pragma: no cover - exercised by the CLI environment
    raise RuntimeError("需要安装 bleak：python3 -m pip install bleak") from error

from ljhw_protocol import (
    FLAG_FINAL,
    KIND_CONTROL_REQUEST,
    KIND_CONTROL_RESPONSE,
    KIND_EVENT,
    KIND_LIVE_AUDIO,
    Frame,
    FrameDecoder,
    ProtocolError,
    control_payload,
)


SERVICE_UUID = "9f7a0001-6d6f-4a6f-8a4b-6c616f6a6901"
CONTROL_RX_UUID = "9f7a0002-6d6f-4a6f-8a4b-6c616f6a6901"
CONTROL_TX_UUID = "9f7a0003-6d6f-4a6f-8a4b-6c616f6a6901"
AUDIO_TX_UUID = "9f7a0004-6d6f-4a6f-8a4b-6c616f6a6901"
FRAGMENT_HEADER = struct.Struct("<HBBH")
MAX_FRAME_BYTES = 48 * 1024


class Fragmenter:
    def __init__(self) -> None:
        self._frame_id = 1

    def encode(self, frame: bytes, packet_bytes: int) -> list[bytes]:
        if not frame or len(frame) > MAX_FRAME_BYTES:
            raise ProtocolError("BLE LJHW frame length is invalid")
        capacity = packet_bytes - FRAGMENT_HEADER.size
        if capacity <= 0:
            raise ProtocolError("BLE MTU is too small")
        count = (len(frame) + capacity - 1) // capacity
        if count > 255:
            raise ProtocolError("BLE LJHW frame requires too many fragments")
        frame_id = self._frame_id
        self._frame_id = 1 if frame_id == 0xFFFF else frame_id + 1
        packets: list[bytes] = []
        for index in range(count):
            body = frame[index * capacity : (index + 1) * capacity]
            packets.append(FRAGMENT_HEADER.pack(frame_id, index, count, len(body)) + body)
        return packets


class Reassembler:
    def __init__(self) -> None:
        self._frame_id = 0
        self._count = 0
        self._parts: list[bytes | None] = []
        self._received = 0

    def feed(self, packet: bytes) -> bytes | None:
        if len(packet) < FRAGMENT_HEADER.size:
            raise ProtocolError("BLE LJHW fragment is truncated")
        frame_id, index, count, body_length = FRAGMENT_HEADER.unpack_from(packet)
        body = packet[FRAGMENT_HEADER.size :]
        if frame_id == 0 or count == 0 or index >= count or body_length != len(body):
            self.clear()
            raise ProtocolError("BLE LJHW fragment header is invalid")
        if frame_id != self._frame_id:
            self._frame_id = frame_id
            self._count = count
            self._parts = [None] * count
            self._received = 0
        elif count != self._count:
            self.clear()
            raise ProtocolError("BLE LJHW fragment count changed")
        previous = self._parts[index]
        if previous is not None:
            if previous != body:
                self.clear()
                raise ProtocolError("BLE LJHW duplicate fragment changed")
            return None
        if self._received + len(body) > MAX_FRAME_BYTES:
            self.clear()
            raise ProtocolError("BLE LJHW frame exceeds maximum")
        self._parts[index] = body
        self._received += len(body)
        if any(part is None for part in self._parts):
            return None
        frame = b"".join(part for part in self._parts if part is not None)
        self.clear()
        return frame

    def clear(self) -> None:
        self._frame_id = 0
        self._count = 0
        self._parts = []
        self._received = 0


@dataclass
class SequenceStats:
    frames: int = 0
    gaps: int = 0


class BlePeer:
    def __init__(self, client: BleakClient) -> None:
        self._client = client
        self._fragmenter = Fragmenter()
        self._reassemblers = {
            CONTROL_TX_UUID: Reassembler(),
            AUDIO_TX_UUID: Reassembler(),
        }
        self._queue: asyncio.Queue[Frame] = asyncio.Queue()
        self._tx_sequence = 1
        self._correlation = 1
        self._last_sequence: dict[int, int] = {}
        self.sequence = SequenceStats()

    async def open(self) -> None:
        await self._client.start_notify(CONTROL_TX_UUID, self._notification)
        await self._client.start_notify(AUDIO_TX_UUID, self._notification)

    async def close(self) -> None:
        for characteristic in (AUDIO_TX_UUID, CONTROL_TX_UUID):
            try:
                await self._client.stop_notify(characteristic)
            except Exception:
                pass

    def _notification(self, characteristic, packet: bytearray) -> None:  # noqa: ANN001
        characteristic_uuid = str(characteristic.uuid).lower()
        reassembler = self._reassemblers.get(characteristic_uuid)
        if reassembler is None:
            return
        try:
            raw = reassembler.feed(bytes(packet))
            if raw is None:
                return
            decoded = FrameDecoder().feed(raw)
            if len(decoded) != 1:
                raise ProtocolError("BLE notification did not contain one LJHW frame")
            frame = decoded[0]
            previous = self._last_sequence.get(frame.stream_id)
            if previous is not None and frame.sequence > previous + 1:
                self.sequence.gaps += frame.sequence - previous - 1
            if previous is None or frame.sequence > previous:
                self._last_sequence[frame.stream_id] = frame.sequence
            self.sequence.frames += 1
            self._queue.put_nowait(frame)
        except Exception as error:
            self._queue.put_nowait(error)  # type: ignore[arg-type]

    async def next_frame(self, timeout: float) -> Frame:
        item = await asyncio.wait_for(self._queue.get(), timeout)
        if isinstance(item, Exception):
            raise item
        return item

    async def request(
        self,
        operation: str,
        timeout: float = 5.0,
        **values: object,
    ) -> tuple[dict[str, object], list[Frame]]:
        correlation = self._correlation
        self._correlation += 1
        command_id = str(values.pop("command_id", uuid.uuid4()))
        frame = Frame(
            kind=KIND_CONTROL_REQUEST,
            flags=0,
            stream_id=0,
            sequence=self._tx_sequence,
            correlation_id=correlation,
            payload=control_payload(operation, command_id=command_id, **values),
        )
        self._tx_sequence += 1
        mtu = max(23, int(getattr(self._client, "mtu_size", 23)))
        for packet in self._fragmenter.encode(frame.encode(), min(514, mtu - 3)):
            await self._client.write_gatt_char(CONTROL_RX_UUID, packet, response=True)
        deadline = time.monotonic() + timeout
        side_frames: list[Frame] = []
        while True:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise TimeoutError(f"device did not answer {operation}")
            received = await self.next_frame(remaining)
            if received.kind == KIND_CONTROL_RESPONSE and received.correlation_id == correlation:
                response = received.json()
                if response.get("ok") is not True:
                    raise ProtocolError(f"device rejected {operation}: {response.get('error')}")
                return response, side_frames
            side_frames.append(received)

    async def hello(self) -> dict[str, object]:
        response, _ = await self.request(
            "hello",
            app={"name": "laoji-hardware-ble-probe", "version": "1"},
            supported_protocols=[{"major": 1, "minor": 1}],
            transports=["ble"],
        )
        return response


async def find_device(address: str | None):
    normalized = address.upper() if address else None

    def matches(device, advertisement) -> bool:  # noqa: ANN001
        if normalized and device.address.upper() == normalized:
            return True
        services = {value.lower() for value in (advertisement.service_uuids or [])}
        return SERVICE_UUID in services

    device = await BleakScanner.find_device_by_filter(matches, timeout=12.0)
    if device is None:
        raise RuntimeError("未发现广播 LJHW/1 服务的外接录音设备")
    return device


async def record(peer: BlePeer, seconds: float, output: Path) -> dict[str, object]:
    session_id = str(uuid.uuid4())
    _, initial = await peer.request(
        "capture.start",
        session_id=session_id,
        audio={"codec": "pcm_s16le", "sample_rate_hz": 16_000, "channels": 1},
    )
    output.parent.mkdir(parents=True, exist_ok=True)
    temporary = output.with_name(f".{output.name}.part")
    stream_id: int | None = None
    audio_frames = 0
    pcm_bytes = 0
    wall_started = time.monotonic()
    finished = False

    with wave.open(str(temporary), "wb") as wav:
        wav.setnchannels(1)
        wav.setsampwidth(2)
        wav.setframerate(16_000)

        def accept(frame: Frame) -> None:
            nonlocal stream_id, audio_frames, pcm_bytes, finished
            if frame.kind == KIND_EVENT:
                event = frame.json()
                if event.get("op") == "capture.started":
                    audio = event.get("audio")
                    if not isinstance(audio, dict) or audio.get("codec") != "pcm_s16le":
                        raise ProtocolError("device selected an unsupported audio profile")
                    stream_id = int(event.get("stream_id", 0))
                elif event.get("op") == "capture.finished":
                    finished = True
            elif frame.kind == KIND_LIVE_AUDIO:
                if frame.flags & FLAG_FINAL:
                    return
                if len(frame.payload) % 2:
                    raise ProtocolError("PCM frame is not sample-aligned")
                if stream_id is not None and frame.stream_id != stream_id:
                    raise ProtocolError("audio stream identity changed")
                stream_id = frame.stream_id
                wav.writeframesraw(frame.payload)
                audio_frames += 1
                pcm_bytes += len(frame.payload)

        for frame in initial:
            accept(frame)
        deadline = wall_started + seconds
        while time.monotonic() < deadline:
            try:
                accept(await peer.next_frame(min(0.5, deadline - time.monotonic())))
            except asyncio.TimeoutError:
                pass
        _, final_side = await peer.request("capture.stop", session_id=session_id, timeout=8.0)
        for frame in final_side:
            accept(frame)
        drain_deadline = time.monotonic() + 1.5
        while not finished and time.monotonic() < drain_deadline:
            try:
                accept(await peer.next_frame(drain_deadline - time.monotonic()))
            except asyncio.TimeoutError:
                break

    if pcm_bytes <= 0:
        temporary.unlink(missing_ok=True)
        raise ProtocolError("device returned no audio samples")
    os.replace(temporary, output)
    wall_seconds = time.monotonic() - wall_started
    media_seconds = pcm_bytes / (16_000 * 2)
    return {
        "session_id": session_id,
        "stream_id": stream_id,
        "audio_frames": audio_frames,
        "pcm_bytes": pcm_bytes,
        "media_seconds": round(media_seconds, 3),
        "wall_seconds": round(wall_seconds, 3),
        "realtime_ratio": round(media_seconds / wall_seconds, 3),
        "sequence_gaps": peer.sequence.gaps,
        "finished_event": finished,
        "output": str(output.resolve()),
    }


async def run(args: argparse.Namespace) -> dict[str, object]:
    device = await find_device(args.address)
    client = BleakClient(device, timeout=20.0)
    await client.connect()
    try:
        # BlueZ exposes the negotiated ATT MTU through AcquireWrite/Notify;
        # Bleak keeps that operation backend-private. Calling it when present
        # prevents the default-MTU fallback from fragmenting one hello into
        # more packets than a small embedded receive queue can hold.
        acquire_mtu = getattr(getattr(client, "_backend", None), "_acquire_mtu", None)
        if acquire_mtu is not None:
            await acquire_mtu()
        peer = BlePeer(client)
        await peer.open()
        try:
            hello = await peer.hello()
            if args.command == "hello":
                result: object = hello
            elif args.command == "status":
                result, _ = await peer.request("status.get")
            else:
                result = {"hello": hello, "recording": await record(peer, args.seconds, args.output)}
            return {
                "address": device.address,
                "name": device.name,
                "mtu": int(getattr(client, "mtu_size", 23)),
                "result": result,
            }
        finally:
            await peer.close()
    finally:
        try:
            await client.disconnect()
        except Exception:
            pass


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="老记 LJHW/1 蓝牙探针")
    parser.add_argument("--address", help="可选 BLE 地址；默认按 LJHW/1 service UUID 搜索")
    commands = parser.add_subparsers(dest="command", required=True)
    commands.add_parser("hello", help="读取协议、设备身份和能力")
    commands.add_parser("status", help="读取设备状态")
    record_parser = commands.add_parser("record", help="通过 BLE 实时流录制 WAV")
    record_parser.add_argument("--seconds", type=float, default=5.0)
    record_parser.add_argument("--output", type=Path, required=True)
    return parser


def main() -> int:
    args = build_parser().parse_args()
    if getattr(args, "seconds", 1.0) <= 0 or getattr(args, "seconds", 1.0) > 3600:
        raise ValueError("--seconds 必须在 0 到 3600 秒之间")
    result = asyncio.run(run(args))
    print(json.dumps(result, ensure_ascii=False, indent=2, sort_keys=True))
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (OSError, RuntimeError, TimeoutError, ValueError) as error:
        print(f"BLE 硬件探针失败：{error}", file=sys.stderr)
        raise SystemExit(1)
