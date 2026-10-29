"""Real board purpose/time/rename persistence; creates and deletes only its own tiny samples.
Gesture recognition is tested separately with the exact production C helper.
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

async def main(args):
    args.output.mkdir(parents=True, exist_ok=True)
    device = await BleakScanner.find_device_by_address(args.address, timeout=12)
    if not device:
        raise RuntimeError('board not advertising')
    results = []
    async with Board(device) as board:
        hello = await board.command('hello', supported_protocols=[{'major': 1, 'minor': 3}])
        assert hello['device']['firmware_revision'] == 'laoji-recorder-2.2.0'
        assert (await board.command('status.get'))['status']['state'] == 'ready'
        for purpose in ('schedule', 'meeting'):
            await board.command('time.sync', epoch_ms=int(time.time() * 1000), time_zone='Asia/Shanghai')
            capture = 'intent-' + uuid.uuid4().hex
            await board.command('capture.start', session_id=capture, purpose=purpose,
                                audio={'codec':'pcm_s16le','sample_rate_hz':16000,'channels':1,'live_stream':True})
            started = await board.event('capture.started')
            assert started['purpose'] == purpose and started['capture_id'] == capture
            await asyncio.sleep(.8)
            await board.command('capture.pause', session_id=capture); await board.event('capture.paused')
            await board.command('capture.resume', session_id=capture); await board.event('capture.resumed')
            await asyncio.sleep(.3)
            await board.command('capture.stop', session_id=capture)
            finished = await board.event('capture.finished')
            assert finished['purpose'] == purpose and finished['capture_id'] == capture
            assert finished['created_epoch_ms'] == started['created_epoch_ms']
            meta = (await board.command('recording.get', recording_id=finished['recording_id']))['recording']
            assert meta['time_zone'] == 'Asia/Shanghai'
            pcm = await board.read(meta)
            assert 'sha256:' + hashlib.sha256(pcm).hexdigest() == meta['checksum_sha256']
            renamed = 'intent-audit-' + uuid.uuid4().hex[:10] + '.wav'
            await board.command('recording.rename', recording_id=meta['recording_id'], expected_generation=meta['generation'], new_recording_id=renamed)
            renamed_meta = (await board.command('recording.get', recording_id=renamed))['recording']
            for field in ('purpose','capture_id','created_epoch_ms','time_zone','checksum_sha256'):
                assert renamed_meta[field] == meta[field], field
            results.append({'purpose':purpose,'bytes':len(pcm),'sha_verified':True,'rename_context_preserved':True,
                            'paused_resumed':True,'live_packets':len(board.live)})
            await board.command('recording.delete', recording_id=renamed, expected_generation=renamed_meta['generation'])
    report = {'boundary':'physical board / Linux BLE, not phone radio or physical-button actuation', 'checks':results}
    (args.output/'results.json').write_text(json.dumps(report,indent=2)+'\n')
    print(json.dumps(report,indent=2),flush=True)

if __name__ == '__main__':
    p=argparse.ArgumentParser();p.add_argument('--address',default='7C:4F:AD:BB:38:B2');p.add_argument('--output',type=Path,required=True)
    asyncio.run(main(p.parse_args()))
