"""Real BLE 1.3 board probe. Default reads files only; --live records a short diagnostic.

Run with uv run --with bleak --python /usr/bin/python3 tools/hardware/board13_probe.py --address ...
No firmware writes, Wi-Fi changes, or deletion of existing recordings.
"""
import argparse
import asyncio
import hashlib
import json
import struct
import time
import uuid
import wave
from pathlib import Path

from bleak import BleakClient, BleakScanner

RX = "9f7a0002-6d6f-4a6f-8a4b-6c616f6a6901"
TX = "9f7a0003-6d6f-4a6f-8a4b-6c616f6a6901"
AUDIO = "9f7a0004-6d6f-4a6f-8a4b-6c616f6a6901"


class Board:
    def __init__(self, device):
        self.disconnected_at = None
        self.client = BleakClient(device, timeout=15, disconnected_callback=self.disconnected)
        self.pending = {}
        self.fragments = {}
        self.frame_id = 0
        self.events = asyncio.Queue()
        self.reading = None
        self.early_audio = []
        self.live = []
        self.packet_count = 0
        self.audit_path = None
        self.audio_started_at = self.audio_last_at = None

    def disconnected(self,_):
        self.disconnected_at=time.monotonic()

    async def __aenter__(self):
        await self.client.connect()
        self.rx = self.client.services.get_characteristic(RX)
        await self.client.start_notify(TX, self.control)
        await self.client.start_notify(AUDIO, self.audio)
        for _ in range(20):
            if self.rx.max_write_without_response_size > 20:
                break
            await asyncio.sleep(.1)
        self.capacity = min(512, self.rx.max_write_without_response_size) - 6
        return self

    async def __aexit__(self, *error):
        if self.audit_path:
            report={"exception":error[0].__name__ if error[0] else None,
                "live_packets":len(self.live),"live_bytes":sum(len(p[2]) for p in self.live),
                "audio_span_seconds":(self.audio_last_at-self.audio_started_at) if self.audio_started_at else 0,
                "connected_before_cleanup":self.client.is_connected,
                "disconnected_before_cleanup":self.disconnected_at is not None}
            self.audit_path.write_text(json.dumps(report,indent=2));print(json.dumps(report),flush=True)
        await self.client.disconnect()

    def control(self, _, packet):
        fid, index, count, size = struct.unpack_from("<HBBH", packet)
        assert size == len(packet) - 6 and 0 <= index < count
        parts = self.fragments.setdefault(fid, {})
        parts[index] = packet[6:]
        if len(parts) != count:
            return
        raw = b"".join(parts[i] for i in range(count))
        del self.fragments[fid]
        major, minor, flags, reserved, size = struct.unpack_from("<BBBBI", raw)
        assert (major, minor, reserved) == (1, 3, 0) and len(raw) == size + 8
        message = json.loads(raw[8:])
        cid = message.get("command_id")
        if cid in self.pending:
            if message.get("op") in ("recording.audio.read", "capture.audio.read") and message.get("ok") and self.reading:
                self.reading["stream"] = message["transfer"]["stream_id"]
                # Drain the pre-reply prefix in this callback. Deferring until
                # command() resumes lets later notifications overtake it.
                early,self.early_audio=self.early_audio,[]
                for value in early:
                    self.audio(None,value)
            future = self.pending[cid]
            if not future.done():
                future.set_result(message)
        else:
            self.events.put_nowait(message)

    def audio(self, _, packet):
        try:
            if self.reading and self.reading["stream"] is None and len(packet)>=20 and packet[2]==0x11:
                if len(self.early_audio)>=512: raise ValueError("early audio bound exceeded")
                self.early_audio.append(bytes(packet))
                return
            self.packet_count += 1
            now=time.monotonic()
            if self.audio_started_at is None: self.audio_started_at=now
            self.audio_last_at=now
            if self.packet_count <= 3:
                print(json.dumps({"audio_packet": self.packet_count, "length": len(packet), "header": bytes(packet[:20]).hex()}), flush=True)
            major, minor, kind, flags, stream, sequence, offset = struct.unpack_from("<BBBBIIQ", packet)
            assert (major, minor) == (1, 3) and len(packet) >= 20 and (len(packet) - 20) % 2 == 0
            pcm = bytes(packet[20:])
            if kind == 0x10:
                self.live.append((sequence, offset, pcm))
            elif kind == 0x11 and self.reading and stream == self.reading["stream"]:
                read = self.reading
                assert sequence == read["sequence"] + 1 and offset == read["offset"] + len(read["bytes"])
                read["sequence"] = sequence
                read["bytes"].extend(pcm)
                read["last_data"] = time.monotonic()
                if flags & 1 and not read["done"].done():
                    read["done"].set_result(None)
        except Exception as exc:
            if self.reading and not self.reading["done"].done():
                self.reading["done"].set_exception(exc)

    async def command(self, op, **fields):
        cid = uuid.uuid4().hex
        body = json.dumps({"schema_version": 1, "op": op, "command_id": cid, **fields}, ensure_ascii=False, separators=(",", ":")).encode()
        raw = struct.pack("<BBBBI", 1, 3, 0, 0, len(body)) + body
        self.frame_id = self.frame_id % 65535 + 1
        count = (len(raw) + self.capacity - 1) // self.capacity
        future = asyncio.get_running_loop().create_future()
        self.pending[cid] = future
        try:
            for i in range(count):
                part = raw[i * self.capacity:(i + 1) * self.capacity]
                await self.client.write_gatt_char(self.rx, struct.pack("<HBBH", self.frame_id, i, count, len(part)) + part, response=False)
            timeout=45 if op in ("status.get","recording.list","recording.get","recording.audio.read") else 12
            result = await asyncio.wait_for(future, timeout)
            if not result.get("ok"):
                raise RuntimeError(json.dumps(result, ensure_ascii=False))
            await asyncio.sleep(.1)  # allow BlueZ indication confirmation to leave the host
            return result
        finally:
            self.pending.pop(cid, None)

    async def event(self, op):
        async def wait():
            while True:
                item = await self.events.get()
                if item.get("op") == op:
                    return item
        return await asyncio.wait_for(wait(), 15)

    async def list_recordings(self):
        """Audit the complete directory, not only the first protocol page."""
        result, cursor, seen = [], None, set()
        for _ in range(1024):
            page = await self.command('recording.list', limit=32, **({'cursor': cursor} if cursor else {}))
            names = page['recordings']
            if any(name in seen for name in names):
                raise AssertionError('Repeated source identity across catalog pages')
            result.extend(names); seen.update(names)
            next_cursor = page.get('next_cursor')
            if not next_cursor:
                return result
            if next_cursor == cursor or not names:
                raise AssertionError('Catalog cursor did not advance')
            cursor = next_cursor
        raise AssertionError('Catalog exceeds bounded audit; do not claim file preservation')

    async def read(self, recording, offset=0, length=None):
        self.early_audio.clear()
        self.reading = {"stream": None, "sequence": 0, "offset": offset, "bytes": bytearray(), "done": asyncio.get_running_loop().create_future(), "last_data": time.monotonic()}
        fields = {"recording_id": recording["recording_id"], "expected_generation": recording["generation"], "offset": offset}
        if length is not None:
            fields["length"] = length
        try:
            response = await self.command("recording.audio.read", **fields)
            print(json.dumps({"read_transfer": response["transfer"]}, ensure_ascii=False), flush=True)
            while not self.reading["done"].done():
                if time.monotonic() - self.reading["last_data"] > 12:
                    raise TimeoutError(f"PCM idle; received={len(self.reading['bytes'])}, packets={self.packet_count}")
                await asyncio.sleep(.1)
            await self.reading["done"]
            data = bytes(self.reading["bytes"])
            expected = min(length or recording["audio_bytes"], recording["audio_bytes"] - offset)
            assert len(data) == expected
            return data
        finally:
            stream = self.reading["stream"]
            self.reading = None
            if stream:
                # A disconnected peer must not mask the original transfer failure.
                try:
                    await self.command("recording.audio.read.cancel", stream_id=stream)
                except Exception:
                    pass

    async def read_capture(self, session, source_stream, offset, length):
        """Read a bounded active-source snapshot; never treat a live gap as silence."""
        assert self.reading is None, 'One range read owns this probe'
        assert 0 <= offset and offset % 2 == 0 and 0 < length <= 32768 and length % 2 == 0
        self.early_audio.clear()
        self.reading = {"stream": None, "sequence": 0, "offset": offset, "bytes": bytearray(),
                        "done": asyncio.get_running_loop().create_future(), "last_data": time.monotonic()}
        try:
            reply = await self.command('capture.audio.read', session_id=session, stream_id=source_stream,
                                       offset=offset, length=length)
            transfer = reply['transfer']
            assert transfer['session_id'] == session and transfer['source_stream_id'] == source_stream
            assert transfer['stream_id'] != source_stream and transfer['offset'] == offset and transfer['length'] == length
            assert transfer['offset_scope'] == 'audio_payload'
            await asyncio.wait_for(self.reading['done'], 3)
            data = bytes(self.reading['bytes'])
            assert len(data) == length, 'Incomplete active-source snapshot'
            return data
        finally:
            stream = self.reading['stream']
            self.reading = None
            if stream:
                await self.command('capture.audio.read.cancel', stream_id=stream)


async def main(args):
    report = {"started": time.strftime("%Y-%m-%dT%H:%M:%S%z"), "boundary": "real board via Linux BLE; not Android end-to-end", "checks": []}
    args.output.mkdir(parents=True, exist_ok=True)
    device = await BleakScanner.find_device_by_address(args.address, timeout=15)
    if not device:
        raise RuntimeError("Target board not advertising")
    async with Board(device) as board:
        board.audit_path=args.output/"transport-audit.json"
        hello = await board.command("hello", app={"name": "laoji-board-probe", "version": "probe-1.3"}, supported_protocols=[{"major": 1, "minor": 3}], transports=["ble"])
        assert hello["protocol"] == {"major": 1, "minor": 3}
        status = (await board.command("status.get"))["status"]
        assert status["state"] == "ready", "Do not interfere with active recording/transfer"
        await board.command("time.sync", epoch_ms=int(time.time() * 1000), time_zone="Asia/Shanghai")
        files = (await board.command("recording.list", limit=32))["recordings"]
        report["files_before"] = files
        for number, name in enumerate(files[:args.stored_limit]):
            metadata = (await board.command("recording.get", recording_id=name))["recording"]
            print(json.dumps({"metadata": metadata}, ensure_ascii=False), flush=True)
            if args.inspect:
                data = await board.read(metadata, length=args.inspect_length)
                print(json.dumps({"short_read_bytes": len(data), "packets": board.packet_count}), flush=True)
                return
            assert metadata["audio_bytes"] <= 10 * 1024 * 1024
            started = time.monotonic()
            data = await board.read(metadata)
            assert "sha256:" + hashlib.sha256(data).hexdigest() == metadata["checksum_sha256"]
            cut = min(984, len(data) - 2)
            tail = await board.read(metadata, offset=cut)
            assert data[:cut] + tail == data
            report["checks"].append({"case": "stored_full_and_resumed", "recording": name, "audio_bytes": len(data), "seconds": round(time.monotonic() - started, 3), "metadata": metadata})
            with wave.open(str(args.output / f"stored-{number}.wav"), "wb") as wav:
                wav.setnchannels(1); wav.setsampwidth(2); wav.setframerate(16000); wav.writeframes(data)
        if args.live:
            sid = "adapter-probe-" + uuid.uuid4().hex
            await board.command("capture.start", session_id=sid, audio={"codec": "pcm_s16le", "sample_rate_hz": 16000, "channels": 1, "live_stream": True})
            try:
                await board.event("capture.started")
                await asyncio.sleep(args.live_seconds)
                await board.command("capture.pause", session_id=sid)
                await board.event("capture.paused")
                await asyncio.sleep(.5)
                await board.command("capture.resume", session_id=sid)
                await board.event("capture.resumed")
                await asyncio.sleep(1)
            finally:
                await board.command("capture.stop", session_id=sid)
            finished = await board.event("capture.finished")
            metadata = (await board.command("recording.get", recording_id=finished["recording_id"]))["recording"]
            data = await board.read(metadata)
            assert "sha256:" + hashlib.sha256(data).hexdigest() == metadata["checksum_sha256"]
            prefix = bytearray()
            for sequence, offset, pcm in board.live:
                if offset != len(prefix):
                    break
                prefix.extend(pcm)
            (args.output/"live-mirror.pcm").write_bytes(prefix)
            (args.output/"live-source.pcm").write_bytes(data)
            (args.output/"live-packets.json").write_text(json.dumps(
                [{"sequence":s,"offset":o,"bytes":len(p)} for s,o,p in board.live],indent=2))
            (args.output/"live-metadata.json").write_text(json.dumps(metadata,indent=2))
            assert data.startswith(prefix)
            new_name = "适配验证-" + uuid.uuid4().hex[:8] + ".wav"
            await board.command("recording.rename", recording_id=metadata["recording_id"], expected_generation=metadata["generation"], new_recording_id=new_name)
            renamed = (await board.command("recording.get", recording_id=new_name))["recording"]
            assert renamed["generation"] == metadata["generation"] and renamed["checksum_sha256"] == metadata["checksum_sha256"]
            report["checks"].append({"case": "live_pause_resume_stop_and_chinese_rename", "live_packets": len(board.live), "live_prefix_bytes": len(prefix), "final_audio_bytes": len(data), "recording": new_name})
            with wave.open(str(args.output / "live.wav"), "wb") as wav:
                wav.setnchannels(1); wav.setsampwidth(2); wav.setframerate(16000); wav.writeframes(data)
        report["status_after"] = (await board.command("status.get"))["status"]
        assert report["status_after"]["state"] == "ready"
    report["result"] = "pass"
    (args.output / "board-probe.json").write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps(report, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--address", required=True)
    parser.add_argument("--live", action="store_true")
    parser.add_argument("--live-seconds", type=int, choices=range(1,121), default=4)
    parser.add_argument("--stored-limit", type=int, choices=range(0,33), default=2)
    parser.add_argument("--inspect", action="store_true")
    parser.add_argument("--inspect-length", type=int, default=984)
    parser.add_argument("--output", type=Path, required=True)
    asyncio.run(main(parser.parse_args()))
