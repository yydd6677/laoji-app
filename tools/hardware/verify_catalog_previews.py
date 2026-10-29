"""Read-only real-board catalog timing. Never hashes all files to draw a list."""
import argparse
import asyncio
import json
import time
from pathlib import Path
from bleak import BleakScanner
from board13_probe import Board


async def main(args):
    device = await BleakScanner.find_device_by_address(args.address, timeout=15)
    if not device:
        raise RuntimeError('Board is not advertising; disconnect the phone first')
    async with Board(device) as b:
        hello = await b.command('hello', app={'name': 'catalog-audit', 'version': '1'},
                                supported_protocols=[{'major': 1, 'minor': 3}], transports=['ble'])
        assert hello['device']['firmware_revision'] == args.firmware_revision
        started = time.monotonic()
        cursor = None
        entries = []
        cursors = set()
        while True:
            fields = {'limit': 4, 'include_previews': True}
            if cursor is not None:
                fields['cursor'] = cursor
            r = await b.command('recording.list', **fields)
            previews = {e['recording_id']: e for e in r['previews']}
            assert len(r['recordings']) <= 4
            for name in r['recordings']:
                entry = previews[name]
                assert entry['file_bytes'] >= 44 and entry['duration_ms'] >= 0
                assert 'checksum_sha256' not in entry
                entries.append(entry)
            cursor = r['next_cursor']
            if cursor is None:
                break
            assert cursor not in cursors
            cursors.add(cursor)
        seconds = time.monotonic() - started
        # A selected file still has a full hash contract, unlike list entries.
        original = (await b.command('recording.get', recording_id='20261015_093115.wav'))['recording']
        assert original['checksum_sha256'] == 'sha256:a255d8342d9fd92592472f1299954ebc204ed1666c382b773bfcab8c122dda73'
        assert original['audio_bytes'] == 4002816
        preview = next(e for e in entries if e['recording_id'] == original['recording_id'])
        assert preview['generation'] == original['generation']
        assert preview['file_bytes'] == original['file_bytes']
        assert preview['duration_ms'] == original['duration_ms']
        report = {'boundary': 'real firmware / Linux BLE, not Android latency',
                  'firmware': hello['device']['firmware_revision'], 'file_count': len(entries),
                  'catalog_seconds': round(seconds, 3), 'previews_have_no_checksum': True,
                  'selected_original_pcm_sha_unchanged': True, 'entries': entries}
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(json.dumps(report, ensure_ascii=False, indent=2))
        print(json.dumps({k: v for k, v in report.items() if k != 'entries'}, ensure_ascii=False))


if __name__ == '__main__':
    p = argparse.ArgumentParser()
    p.add_argument('--address', default='7C:4F:AD:BB:38:B2')
    p.add_argument('--firmware-revision', default='laoji-recorder-2.0.2')
    p.add_argument('--output', type=Path, required=True)
    asyncio.run(main(p.parse_args()))
