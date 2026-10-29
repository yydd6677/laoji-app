"""Real second-board acceptance for independently built source firmware.

Creates its own diagnostic recordings only. Never deletes pre-existing files,
flashes, changes computer Wi-Fi or substitutes synthetic audio for microphones.
"""
import argparse
import asyncio
import hashlib
import json
import math
import re
import struct
import time
import uuid
import wave

from pathlib import Path
from bleak import BleakScanner
from board13_probe import Board


def source_version():
    firmware = Path(__file__).resolve().parents[2] / 'hardware/esp32s3-voice-memo/firmware'
    version = re.search(r'#define LJ_VERSION "([^"]+)"', (firmware / 'main/lj.h').read_text()).group(1)
    project = re.search(r'project\(laoji_recorder VERSION ([^)]+)\)', (firmware / 'CMakeLists.txt').read_text()).group(1)
    assert version == project, 'Control and SDK application versions differ'
    image = firmware / 'build/laoji_recorder.bin'
    if image.exists():
        data = image.read_bytes()
        assert int.from_bytes(data[0x20:0x24], 'little') == 0xabcd5432
        assert data[0x30:0x50].split(b'\0')[0].decode() == version, 'Rebuild the stale firmware image'
    return version


async def connect(address):
    d = await BleakScanner.find_device_by_address(address, timeout=15)
    if not d:
        raise RuntimeError('Target board not advertising')
    return Board(d)


async def prepare(b):
    h = await b.command('hello', app={'name': 'laoji-source-audit', 'version': '2.0'},
                        supported_protocols=[{'major': 1, 'minor': 3}], transports=['ble'])
    assert h['device']['firmware_revision'] == 'laoji-recorder-' + source_version(), h['device']
    await b.command('time.sync', epoch_ms=int(time.time() * 1000), time_zone='Asia/Shanghai')
    return h


async def files(b):
    out = []
    cursor = None
    for _ in range(128):
        q = {'limit': 32}
        if cursor is not None:
            q['cursor'] = cursor
        r = await b.command('recording.list', **q)
        out += r['recordings']
        cursor = r.get('next_cursor')
        if cursor is None:
            return out
    raise RuntimeError('Unbounded list pagination')


async def main(args):
    args.output.mkdir(parents=True, exist_ok=True)
    report = {'boundary': 'real board / Linux BLE, not Android or human ASR quality', 'checks': []}

    def check(case, **data):
        row = {'case': case, **data}
        report['checks'].append(row)
        (args.output / 'results.json').write_text(json.dumps(report, ensure_ascii=False, indent=2))
        print(json.dumps(row, ensure_ascii=False), flush=True)

    async with await connect(args.address) as b:
        hello = await prepare(b)
        initial = await files(b)
        report['files_before'] = initial
        assert (await b.command('status.get'))['status']['state'] == 'ready'
        check('hello_status_list', firmware=hello['device']['firmware_revision'], files=len(initial))
        # Re-read an unchanged pre-rewrite source to detect container/metadata regressions.
        if '20261015_093115.wav' in initial:
            old = (await b.command('recording.get', recording_id='20261015_093115.wav'))['recording']
            assert old['audio_bytes'] == 4002816
            assert old['checksum_sha256'] == 'sha256:a255d8342d9fd92592472f1299954ebc204ed1666c382b773bfcab8c122dda73'
            check('original_source_preserved', bytes=old['audio_bytes'], sha_match=True)
        session = 'source-audit-' + uuid.uuid4().hex
        started = time.monotonic()
        await b.command('capture.start', session_id=session, audio={'codec': 'pcm_s16le', 'sample_rate_hz': 16000, 'channels': 1, 'live_stream': True})
        await b.event('capture.started')
        check('capture_started', seconds=round(time.monotonic() - started, 3))
        try:
            await asyncio.sleep(args.seconds)
            assert b.live, 'No real live microphone frames'
            await b.command('capture.pause', session_id=session)
            await b.event('capture.paused')
            await asyncio.sleep(.4)
            before = (await b.command('status.get'))['status']['recorded_audio_bytes']
            await asyncio.sleep(1.2)
            assert (await b.command('status.get'))['status']['recorded_audio_bytes'] == before, 'PCM source advanced during pause'
            await b.command('capture.resume', session_id=session)
            await b.event('capture.resumed')
            await asyncio.sleep(2)
        finally:
            await b.command('capture.stop', session_id=session)
        finished = await b.event('capture.finished')
        meta = (await b.command('recording.get', recording_id=finished['recording_id']))['recording']
        source = await b.read(meta)
        assert 'sha256:' + hashlib.sha256(source).hexdigest() == meta['checksum_sha256'] == finished['checksum_sha256']
        assert all(source[offset:offset + len(pcm)] == pcm for _, offset, pcm in b.live), 'Live bytes do not match source offsets'
        nonempty = [(seq, offset, pcm) for seq, offset, pcm in b.live if pcm]
        assert nonempty[0][1] == 0, 'Missing initial live prefix'
        contiguous = 0
        for seq, offset, pcm in nonempty:
            if offset != contiguous:
                break
            contiguous += len(pcm)
        values = struct.unpack('<' + 'h' * (len(source) // 2), source)
        rms = math.sqrt(sum(x * x for x in values) / len(values)) if values else 0
        assert rms > 0, 'Codec returned all-zero PCM'
        check('live_vs_sd', source_bytes=len(source), live_bytes=sum(len(p[2]) for p in b.live),
              contiguous_prefix=contiguous, full_live_match=contiguous == len(source), mismatch_frames=0,
              microphone_rms=round(rms, 2), frames=len(nonempty))
        with wave.open(str(args.output / 'microphone-capture.wav'), 'wb') as wav:
            wav.setnchannels(1); wav.setsampwidth(2); wav.setframerate(16000); wav.writeframes(source)
        (args.output / 'live-frame-index.json').write_text(json.dumps([{'sequence': q, 'offset': o, 'bytes': len(p)} for q, o, p in b.live]))
        offset = min(2048, len(source) - 2)
        part = await b.read(meta, offset=offset, length=4096)
        assert part == source[offset:offset + len(part)]
        check('range_repair', offset=offset, bytes=len(part))
        try:
            await b.command('recording.rename', recording_id=meta['recording_id'], expected_generation='wrong-generation', new_recording_id='must-not-exist.wav')
        except RuntimeError as exc:
            assert 'resume_mismatch' in str(exc)
        else:
            raise AssertionError('Wrong generation accepted')
        renamed = '源码录音验证-' + time.strftime('%m%d-%H%M%S') + '.wav'
        await b.command('recording.rename', recording_id=meta['recording_id'], expected_generation=meta['generation'], new_recording_id=renamed)
        meta2 = (await b.command('recording.get', recording_id=renamed))['recording']
        assert meta2['generation'] == meta['generation'] and meta2['checksum_sha256'] == meta['checksum_sha256']
        check('chinese_rename_generation', generation_preserved=True)
        for _ in range(3):
            offer = (await b.command('transport.wifi.offer'))['wifi_offer']
            assert offer['bearer_token'] and offer['password'] and offer['base_url'] == 'http://192.168.4.1'
            assert (await b.command('transport.wifi.status'))['wifi']['state'] in ('ready', 'client_connected')
            await b.command('transport.wifi.close')
            assert (await b.command('transport.wifi.status'))['wifi']['state'] == 'off'
        check('wifi_three_cycles_control_only', http_download_tested=False)
        # Pause then stop without resuming: final must still be emitted.
        session2 = 'source-paused-stop-' + uuid.uuid4().hex
        await b.command('capture.start', session_id=session2, audio={'codec': 'pcm_s16le', 'sample_rate_hz': 16000, 'channels': 1, 'live_stream': False})
        await b.event('capture.started'); await asyncio.sleep(1)
        await b.command('capture.pause', session_id=session2); await b.event('capture.paused')
        await b.command('capture.stop', session_id=session2)
        ended = await b.event('capture.finished')
        # Delete only the recording created by this exact diagnostic session.
        await b.command('recording.delete', recording_id=ended['recording_id'], expected_generation=ended['generation'])
        check('stop_from_pause_and_delete_own_scratch', success=True)
        # Leave this new local recording running across BLE disconnect, then stop it.
        session3 = 'source-disconnect-' + uuid.uuid4().hex
        await b.command('capture.start', session_id=session3, audio={'codec': 'pcm_s16le', 'sample_rate_hz': 16000, 'channels': 1, 'live_stream': False})
        await b.event('capture.started'); await asyncio.sleep(1)
    await asyncio.sleep(1)
    async with await connect(args.address) as b:
        await prepare(b)
        status = (await b.command('status.get'))['status']
        assert status['state'] == 'recording' and status['session_id'] == session3
        await b.command('capture.stop', session_id=session3)
        ended = await b.event('capture.finished')
        assert ended['audio_bytes'] >= 64000
        await b.command('recording.delete', recording_id=ended['recording_id'], expected_generation=ended['generation'])
        check('local_recording_survives_ble_disconnect', audio_bytes=ended['audio_bytes'])
        after = await files(b)
        assert set(initial).issubset(after)
        assert renamed in after
        check('original_files_retained', count=len(initial))
        report['new_recording_for_phone'] = renamed
    check('complete', success=True)


if __name__ == '__main__':
    p = argparse.ArgumentParser()
    p.add_argument('--address', default='7C:4F:AD:BB:38:B2')
    p.add_argument('--seconds', type=float, default=8)
    p.add_argument('--output', type=Path, required=True)
    asyncio.run(main(p.parse_args()))
