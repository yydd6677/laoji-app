"""Test-only Android netsim <-> real BLE board relay; no mocked firmware replies.

uv run --with 'bumble[android]' --with bleak --python /usr/bin/python3 \
  tools/hardware/emulator_board_relay.py --audit /private/path/relay.jsonl

Only reframes JSON for each link's MTU. PCM packets and JSON bodies stay intact.
An explicit bounded-queue overflow terminates the connection, never drops silently.
"""
import argparse
import asyncio
import hashlib
import json
import struct
import time
from pathlib import Path

from bleak import BleakClient, BleakScanner
from bumble import hci
from bumble.core import AdvertisingData
from bumble.device import Device
from bumble.gatt import Characteristic, CharacteristicValue, Service
from bumble.transport import open_transport

ROOT = "9f7a0001-6d6f-4a6f-8a4b-6c616f6a6901"
RX, TX, AUDIO = (ROOT.replace("0001-", f"{n:04x}-") for n in (2, 3, 4))


class Fragments:
    def __init__(self):
        self.parts = {}

    def add(self, packet):
        fid, index, count, size = struct.unpack_from("<HBBH", packet)
        if size != len(packet) - 6 or not 0 <= index < count or len(self.parts) > 16:
            raise ValueError("invalid fragmentation")
        parts = self.parts.setdefault(fid, {})
        parts[index] = packet[6:]
        if len(parts) != count:
            return None
        raw = b"".join(parts[i] for i in range(count))
        del self.parts[fid]
        major, minor, flags, reserved, length = struct.unpack_from("<BBBBI", raw)
        if (major, minor, flags, reserved) != (1, 3, 0, 0) or len(raw) != length + 8:
            raise ValueError("invalid envelope")
        return raw


def split(raw, fid, capacity):
    count = (len(raw) + capacity - 1) // capacity
    if not 0 < count <= 255:
        raise ValueError("fragment count exceeded")
    for i in range(count):
        chunk = raw[i * capacity:(i + 1) * capacity]
        yield struct.pack("<HBBH", fid, i, count, len(chunk)) + chunk


class Relay:
    def __init__(self, device, address, audit, drop_live_sequence=None):
        self.device, self.address, self.audit_path = device, address, audit
        self.started = time.monotonic()
        self.drop_live_sequence = drop_live_sequence
        self.outbound, self.inbound = asyncio.Queue(2048), asyncio.Queue(2048)
        self.app_fragments, self.board_fragments = Fragments(), Fragments()
        self.frame_id = 0
        self.client = None
        self.connection = None
        self.fatal = asyncio.get_running_loop().create_future()
        self.live_bytes = self.stored_bytes = 0
        self.tx = Characteristic(TX, Characteristic.INDICATE, Characteristic.READABLE, b"")
        self.audio = Characteristic(AUDIO, Characteristic.NOTIFY, Characteristic.READABLE, b"")
        self.rx = Characteristic(RX, Characteristic.WRITE | Characteristic.WRITE_WITHOUT_RESPONSE,
                                 Characteristic.WRITEABLE, CharacteristicValue(write=self.receive))
        device.add_service(Service(ROOT, [self.rx, self.tx, self.audio]))
        device.on("connection", self.connected)

    def log(self, event, **fields):
        row = {"t": round(time.monotonic() - self.started, 3), "event": event, **fields}
        with self.audit_path.open("a", encoding="utf-8") as f:
            f.write(json.dumps(row, ensure_ascii=False) + "\n")
        print(json.dumps(row, ensure_ascii=False), flush=True)

    def fail(self, error):
        if not self.fatal.done():
            self.fatal.set_exception(error)

    def enqueue(self, queue, item):
        try:
            queue.put_nowait(item)
        except asyncio.QueueFull:
            self.fail(RuntimeError("relay queue overflow"))

    def receive(self, connection, packet):
        try:
            raw = self.app_fragments.add(bytes(packet))
            if raw:
                self.enqueue(self.outbound, raw)
        except Exception as exc:
            self.fail(exc)

    def control(self, _, packet):
        try:
            raw = self.board_fragments.add(bytes(packet))
            if raw:
                self.enqueue(self.inbound, (False, raw))
        except Exception as exc:
            self.fail(exc)

    def pcm(self, _, packet):
        packet = bytes(packet)
        if len(packet) < 20:
            self.fail(ValueError("short PCM header"))
            return
        if packet[2] == 0x10 and struct.unpack_from("<I", packet, 8)[0] == self.drop_live_sequence:
            self.log("injected_live_gap", sequence=self.drop_live_sequence,
                     source_offset=struct.unpack_from("<Q", packet, 12)[0], bytes=len(packet)-20)
            return
        self.enqueue(self.inbound, (True, packet))

    def connected(self, connection):
        self.connection = connection
        connection.on("disconnection", lambda *_: asyncio.create_task(self.disconnected()))
        asyncio.create_task(connection.set_data_length(251, 2120))
        self.log("android_connected")

    async def disconnected(self):
        self.log("android_disconnected", live_bytes=self.live_bytes, stored_bytes=self.stored_bytes)
        self.connection = None
        if not self.fatal.done():
            self.fatal.set_result(None)  # Expected lifecycle boundary, not an audio failure.

    async def open_board(self):
        found = await BleakScanner.find_device_by_address(self.address, timeout=15)
        if not found:
            raise RuntimeError("physical board not advertising")
        self.client = BleakClient(found, timeout=15)
        await self.client.connect()
        # BlueZ can retain a cached 23-byte MTU after reconnect. Bleak's Linux
        # backend exposes this explicit acquisition because its public MTU is
        # otherwise only the cached default. No production Android code uses it.
        acquire_mtu = getattr(self.client._backend, "_acquire_mtu", None)
        if acquire_mtu is not None:
            await acquire_mtu()
        self.board_rx = self.client.services.get_characteristic(RX)
        await self.client.start_notify(TX, self.control)
        await self.client.start_notify(AUDIO, self.pcm)
        for _ in range(20):
            if self.board_rx.max_write_without_response_size > 20:
                break
            await asyncio.sleep(.1)
        # BlueZ's cached characteristic property can remain 20 even after
        # AcquireWrite negotiated 517. Use the acquired MTU, not that stale cache.
        negotiated_mtu = self.client.mtu_size
        self.capacity = min(512, negotiated_mtu - 3) - 6
        if self.capacity < 16:
            raise RuntimeError("host BLE MTU not negotiated for PCM; relay is not ready")
        self.log("physical_connected", capacity=self.capacity)

    def audit_control(self, direction, raw):
        obj = json.loads(raw[8:])
        fields = {"op": obj.get("op"), "command_id": obj.get("command_id"), "bytes": len(raw)}
        if "ok" in obj:
            fields["ok"] = obj["ok"]
        if obj.get("device"):
            fields["firmware"] = obj["device"].get("firmware_revision")
        meta = obj.get("recording") or (obj if obj.get("op") == "capture.finished" else None)
        if meta:
            for key in ("audio_bytes", "file_bytes", "generation", "checksum_sha256"):
                fields[key] = meta.get(key)
            fields["recording_id_sha256"] = hashlib.sha256(meta.get("recording_id", "").encode()).hexdigest()
        if obj.get("transfer"):
            fields["transfer"] = {k: obj["transfer"].get(k) for k in ("stream_id", "offset", "length", "total_audio_bytes")}
        self.log(direction, **fields)

    async def to_board(self):
        while True:
            raw = await self.outbound.get()
            self.audit_control("app_command", raw)
            self.frame_id = self.frame_id % 65535 + 1
            for packet in split(raw, self.frame_id, self.capacity):
                await self.client.write_gatt_char(self.board_rx, packet, response=False)

    async def to_android(self):
        fid = 0
        while True:
            is_pcm, raw = await self.inbound.get()
            if not self.connection:
                if self.fatal.done():
                    return
                raise ConnectionError("no Android subscriber")
            if is_pcm:
                if raw[2] == 0x10:
                    self.live_bytes += len(raw) - 20
                else:
                    self.stored_bytes += len(raw) - 20
                await self.device.notify_subscribers(self.audio, raw)
            else:
                self.audit_control("board_message", raw)
                fid = fid % 65535 + 1
                capacity = min(512, self.connection.att_mtu - 3) - 6
                for packet in split(raw, fid, capacity):
                    await self.device.indicate_subscribers(self.tx, packet)

    async def run(self):
        try:
            await self.run_connected()
        finally:
            if self.client and self.client.is_connected:
                await self.client.disconnect()

    async def run_connected(self):
        await self.open_board()
        await self.device.power_on()
        await self.device.start_advertising(auto_restart=True, advertising_data=bytes(AdvertisingData([
            (AdvertisingData.FLAGS, b"\x06"),
            (AdvertisingData.COMPLETE_LOCAL_NAME, b"LaoJi Test Board"),
        ])))
        self.log("relay_ready", boundary="Android netsim to physical firmware; not physical Android radio")
        jobs = [asyncio.create_task(self.to_board()), asyncio.create_task(self.to_android())]
        try:
            done, _ = await asyncio.wait([*jobs, self.fatal], return_when=asyncio.FIRST_COMPLETED)
            for item in done:
                item.result()
        finally:
            for job in jobs:
                job.cancel()
            await asyncio.gather(*jobs, return_exceptions=True)
            await self.client.disconnect()
            self.log("relay_closed", live_bytes=self.live_bytes, stored_bytes=self.stored_bytes)


async def main(args):
    args.audit.parent.mkdir(parents=True, exist_ok=True)
    async with await open_transport(args.transport) as transport:
        device = Device.with_hci("LaoJi Test Board", hci.Address("C0:DE:C0:DE:20:20"), transport.source, transport.sink)
        await Relay(device, args.address, args.audit, args.drop_live_sequence).run()


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--transport", default="android-netsim:name=laoji-real-firmware2-relay")
    parser.add_argument("--address", default="7C:4F:AD:BB:38:B2")
    parser.add_argument("--audit", type=Path, required=True)
    parser.add_argument("--drop-live-sequence", type=int, help="test-only gap; source PCM remains unchanged")
    asyncio.run(main(parser.parse_args()))
