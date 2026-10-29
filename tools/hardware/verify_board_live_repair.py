"""Real-board range snapshots during capture, compared with sealed SD source.

No sound stimulus or speech-quality claim. Deletes only this run's exact new
recording after checking generation, bytes and SHA; never modifies old files.
"""
import argparse
import asyncio
import hashlib
import json
import time
import uuid
from pathlib import Path

from board13_probe import Board
from bleak import BleakScanner


async def main(args):
    report = {'boundary': 'physical board/Linux BLE; not Android or speech accuracy', 'checks': []}
    args.output.parent.mkdir(parents=True, exist_ok=True)
    def check(name, **fields):
        report['checks'].append({'case': name, **fields})
        args.output.write_text(json.dumps(report, indent=2) + '\n')
        print(json.dumps(report['checks'][-1]), flush=True)
    target = await BleakScanner.find_device_by_address('7C:4F:AD:BB:38:B2', timeout=15)
    assert target, 'Authorized board unavailable'
    async with Board(target) as board:
        hello = await board.command('hello', supported_protocols=[{'major': 1, 'minor': 3}], transports=['ble'])
        assert hello['device']['firmware_revision'] == args.firmware
        capability = hello['capabilities']['capture']['live_range_repair']
        assert capability == {'max_bytes': 32768, 'retention_bytes': 262144}
        status = (await board.command('status.get'))['status']; assert status['state'] == 'ready'
        before = await board.list_recordings()
        await board.command('time.sync', epoch_ms=int(time.time()*1000), time_zone='Asia/Shanghai')
        session = 'live-repair-audit-' + uuid.uuid4().hex
        owned = None; captures = []; started = time.monotonic()
        await board.command('capture.start', session_id=session, audio={
            'codec': 'pcm_s16le', 'sample_rate_hz': 16000, 'channels': 1, 'live_stream': True})
        event = await board.event('capture.started'); stream = event['stream_id']
        check('capture_started', milliseconds=round((time.monotonic()-started)*1000, 1))
        try:
            await asyncio.sleep(2)
            for length in (532, 32768, 4096):
                status = (await board.command('status.get'))['status']
                offset = max(0, status['recorded_audio_bytes'] - length - 4096) // 2 * 2
                began = time.monotonic()
                data = await board.read_capture(session, stream, offset, length)
                captures.append((offset, data))
                check('active_snapshot', bytes=length, offset=offset, milliseconds=round((time.monotonic()-began)*1000, 1))
            for fields in [dict(session_id='obsolete', stream_id=stream, offset=0, length=2),
                           dict(session_id=session, stream_id=stream, offset=1, length=2),
                           dict(session_id=session, stream_id=stream, offset=0, length=32770)]:
                try: await board.command('capture.audio.read', **fields)
                except RuntimeError as error:
                    code = json.loads(str(error))['error']['code']
                    assert code in ('invalid_state', 'invalid_argument', 'source_range_unavailable')
                else: raise AssertionError('Invalid source request accepted')
            check('invalid_source_requests_rejected')
            await board.command('capture.pause', session_id=session); await board.event('capture.paused')
            paused = (await board.command('status.get'))['status']['recorded_audio_bytes']
            offset = max(0, paused-8192)
            data = await board.read_capture(session, stream, offset, 4096); captures.append((offset, data))
            await asyncio.sleep(.4)
            assert (await board.command('status.get'))['status']['recorded_audio_bytes'] == paused
            await board.command('capture.resume', session_id=session); await board.event('capture.resumed')
            check('pause_snapshot_resume', source_did_not_advance=True)
            deadline = time.monotonic() + 20
            while (await board.command('status.get'))['status']['recorded_audio_bytes'] < 300000:
                assert time.monotonic() < deadline, 'Capture source stopped progressing'
                await asyncio.sleep(.5)
            try: await board.command('capture.audio.read', session_id=session, stream_id=stream, offset=0, length=2)
            except RuntimeError as error: assert json.loads(str(error))['error']['code'] == 'source_range_unavailable'
            else: raise AssertionError('Overwritten prefix should not be fabricated')
            check('overwritten_prefix_rejected')
        finally:
            await board.command('capture.stop', session_id=session)
            owned = await board.event('capture.finished')
        meta = (await board.command('recording.get', recording_id=owned['recording_id']))['recording']
        data = await board.read(meta)
        sha = 'sha256:' + hashlib.sha256(data).hexdigest()
        assert meta['generation'] == owned['generation'] and sha == meta['checksum_sha256'] == owned['checksum_sha256']
        assert all(data[offset:offset+len(chunk)] == chunk for offset, chunk in captures)
        assert all(data[offset:offset+len(chunk)] == chunk for _, offset, chunk in board.live)
        check('snapshots_and_live_match_final_source', snapshots=len(captures), source_bytes=len(data), sha256=sha)
        fresh = (await board.command('recording.get', recording_id=meta['recording_id']))['recording']
        assert all(fresh[k] == meta[k] for k in ('generation', 'audio_bytes', 'checksum_sha256'))
        assert meta['recording_id'] not in before
        await board.command('recording.delete', recording_id=meta['recording_id'], expected_generation=meta['generation'])
        after = await board.list_recordings()
        assert set(before) == set(after)
        check('only_owned_fixture_removed', original_count=len(after))
        report['result'] = 'pass_for_stated_boundary'; args.output.write_text(json.dumps(report, indent=2)+'\n')


if __name__ == '__main__':
    parser = argparse.ArgumentParser(); parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--firmware', required=True)
    asyncio.run(main(parser.parse_args()))
