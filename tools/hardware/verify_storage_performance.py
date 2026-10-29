"""Real-board storage regression: no firmware writes or host Wi-Fi changes.

Run cold, reset externally, run persisted, run capture, reset externally, then
run capture-persisted. Only the script's own recording is renamed/deleted.
Private state/evidence stays in the supplied output directory.
"""
import argparse
import asyncio
import hashlib
import json
import time
import uuid
from pathlib import Path
from bleak import BleakScanner
from board13_probe import Board
from verify_source_firmware import source_version


class TimedBoard(Board):
    def control(self, sender, packet):
        super().control(sender, packet)
        if any(f.done() for f in self.pending.values()):
            self.reply_at = time.perf_counter()


async def catalog(board):
    names, previews, cursor = [], [], None
    while True:
        args = dict(limit=4, include_previews=True)
        if cursor:
            args['cursor'] = cursor
        page = await board.command('recording.list', **args)
        names += page['recordings']
        previews += page.get('previews', [])
        cursor = page.get('next_cursor')
        if not cursor:
            return names, previews


async def main(args):
    args.output.mkdir(parents=True, exist_ok=True)
    state_path = args.output / 'storage-state-private.json'
    state = json.loads(state_path.read_text()) if state_path.exists() else {'checks': []}

    def save():
        state_path.write_text(json.dumps(state, ensure_ascii=False, indent=2))

    def check(case, **data):
        row = dict(case=case, **data)
        state['checks'].append(row)
        save()
        print(json.dumps(row, ensure_ascii=False), flush=True)

    device = await BleakScanner.find_device_by_address(args.address, timeout=15)
    if not device:
        raise RuntimeError('Target board is not advertising')
    async with TimedBoard(device) as b:
        hello = await b.command('hello', app={'name': 'storage-acceptance', 'version': '2.0.3'},
            supported_protocols=[{'major': 1, 'minor': 3}], transports=['ble'])
        assert hello['device']['device_id'] == 'esp32s3-7c4fadbb38b0'
        assert hello['device']['firmware_revision'] == 'laoji-recorder-' + source_version()
        assert (await b.command('status.get'))['status']['state'] == 'ready'
        names, previews = await catalog(b)

        async def get(name):
            begin = time.perf_counter()
            value = (await b.command('recording.get', recording_id=name))['recording']
            return value, (b.reply_at - begin) * 1000

        if args.phase == 'cold':
            state['original_names'] = names
            state['selected'] = []
            for target in [.25, 1.3, 3.8, 6.8]:
                item = min(previews, key=lambda p: abs(p['file_bytes'] - target * 1048576))
                value, elapsed = await get(item['recording_id'])
                warm, warm_elapsed = await get(item['recording_id'])
                assert value['checksum_sha256'] == warm['checksum_sha256']
                state['selected'].append(value)
                check('first_lookup_and_memory_cache', file_bytes=value['file_bytes'],
                    cold_ms=round(elapsed, 3), warm_ms=round(warm_elapsed, 3))
        elif args.phase == 'persisted':
            assert set(names) == set(state['original_names'])
            for saved in state['selected']:
                value, elapsed = await get(saved['recording_id'])
                assert value['generation'] == saved['generation']
                assert value['checksum_sha256'] == saved['checksum_sha256']
                assert elapsed < 1000, 'Persistent metadata did not avoid the bulk scan'
                check('post_reset_persistent_metadata', file_bytes=value['file_bytes'], elapsed_ms=round(elapsed, 3))
        elif args.phase == 'capture':
            assert set(names) == set(state['original_names'])
            await b.command('time.sync', epoch_ms=int(time.time() * 1000), time_zone='Asia/Shanghai')
            session = 'storage-audit-' + uuid.uuid4().hex
            await b.command('capture.start', session_id=session,
                audio={'codec': 'pcm_s16le', 'sample_rate_hz': 16000, 'channels': 1, 'live_stream': False})
            await b.event('capture.started')
            try:
                await asyncio.sleep(1.2)
            finally:
                await b.command('capture.stop', session_id=session)
            finished = await b.event('capture.finished')
            assert finished['file_bytes'] > 44
            state['scratch'] = finished
            check('new_capture_committed_without_metadata_lookup', audio_bytes=finished['audio_bytes'])
        else:
            scratch = state['scratch']
            assert scratch['recording_id'] in names
            value, elapsed = await get(scratch['recording_id'])
            assert value['checksum_sha256'] == scratch['checksum_sha256'] and elapsed < 1000
            check('new_capture_index_survived_reset', elapsed_ms=round(elapsed, 3))
            new_name = '存储验证-' + uuid.uuid4().hex[:8] + '.wav'
            await b.command('recording.rename', recording_id=value['recording_id'],
                expected_generation=value['generation'], new_recording_id=new_name)
            state['scratch']['recording_id'] = new_name
            save()
            renamed, _ = await get(new_name)
            assert renamed['checksum_sha256'] == value['checksum_sha256']
            pcm = await b.read(renamed)
            assert 'sha256:' + hashlib.sha256(pcm).hexdigest() == renamed['checksum_sha256']
            offset = min(1024, len(pcm) - 2)
            resumed = await b.read(renamed, offset=offset)
            assert resumed == pcm[offset:]
            await b.command('recording.delete', recording_id=new_name, expected_generation=renamed['generation'])
            after, _ = await catalog(b)
            assert set(after) == set(state['original_names'])
            check('rename_full_sha_range_delete_and_original_catalog_preserved', original_count=len(after))


if __name__ == '__main__':
    p = argparse.ArgumentParser()
    p.add_argument('--address', default='7C:4F:AD:BB:38:B2')
    p.add_argument('--phase', required=True, choices=['cold', 'persisted', 'capture', 'capture-persisted'])
    p.add_argument('--output', required=True, type=Path)
    asyncio.run(main(p.parse_args()))
