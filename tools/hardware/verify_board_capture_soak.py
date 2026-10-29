"""Bounded physical capture/pause soak; no microphone-quality assertion.

Stops on the first interrupted source, preserving that source for inspection.
Only this run's successfully verified file may be deleted, never old content.
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
    args.output.parent.mkdir(parents=True, exist_ok=True)
    report = {'boundary': 'physical board/Linux BLE; not Android or speech quality', 'checks': []}
    def save(case, **fields):
        report['checks'].append({'case': case, **fields})
        args.output.write_text(json.dumps(report, indent=2)+'\n')
        print(json.dumps(report['checks'][-1]), flush=True)
    target = await BleakScanner.find_device_by_address('7C:4F:AD:BB:38:B2', timeout=15)
    assert target, 'Authorized board not advertising'
    async with Board(target) as board:
        hello = await board.command('hello', supported_protocols=[{'major':1,'minor':3}],transports=['ble'])
        report['firmware'] = hello['device']['firmware_revision']
        assert (await board.command('status.get'))['status']['state']=='ready'
        before=await board.list_recordings()
        report['files_before']=before
        await board.command('time.sync',epoch_ms=int(time.time()*1000),time_zone='Asia/Shanghai')
        for cycle in range(args.cycles):
            session='source-soak-'+uuid.uuid4().hex; owned=True; meta=None
            board.live.clear()
            await board.command('capture.start',session_id=session,audio={
                'codec':'pcm_s16le','sample_rate_hz':16000,'channels':1,'live_stream':True})
            event=await board.event('capture.started'); report['last_source_recording_id']=event['recording_id']
            save('started',cycle=cycle)
            began=time.monotonic(); paused=False
            try:
                while time.monotonic()-began<args.seconds:
                    if not paused and time.monotonic()-began>=6:
                        await board.command('capture.pause',session_id=session); await board.event('capture.paused')
                        await asyncio.sleep(.8)
                        await board.command('capture.resume',session_id=session); await board.event('capture.resumed')
                        paused=True; save('resumed',cycle=cycle)
                    status=(await board.command('status.get'))['status']
                    if status['state'] not in ('recording','paused'):
                        events=[]
                        while not board.events.empty(): events.append(board.events.get_nowait())
                        interrupted=next((e for e in events if e.get('op')=='capture.interrupted' and e.get('session_id')==session),None)
                        save('source_stopped_unexpectedly',cycle=cycle,status=status['state'],
                             bytes=status['recorded_audio_bytes'],reason=interrupted.get('reason') if interrupted else 'event_not_yet_received')
                        owned=False; raise AssertionError('Source failed; keep partial recording and inspect this run')
                    await asyncio.sleep(.5)
                await board.command('capture.stop',session_id=session); owned=False
                finished=await board.event('capture.finished')
                meta=(await board.command('recording.get',recording_id=finished['recording_id']))['recording']
                data=await board.read(meta)
                sha='sha256:'+hashlib.sha256(data).hexdigest()
                assert sha==meta['checksum_sha256']==finished['checksum_sha256']
                assert all(data[offset:offset+len(pcm)]==pcm for _,offset,pcm in board.live)
                save('full_source_verified',cycle=cycle,bytes=len(data),sha256=sha)
                assert meta['recording_id'] not in before
                await board.command('recording.delete',recording_id=meta['recording_id'],expected_generation=meta['generation'])
            finally:
                if owned:
                    status=(await board.command('status.get'))['status']
                    if status['session_id']==session:await board.command('capture.stop',session_id=session)
        after=await board.list_recordings(); assert set(after)==set(before)
        save('original_files_preserved',count=len(before)); report['result']='pass_for_stated_boundary'
        args.output.write_text(json.dumps(report,indent=2)+'\n')


if __name__=='__main__':
    parser=argparse.ArgumentParser(); parser.add_argument('--output',type=Path,required=True)
    parser.add_argument('--seconds',type=float,default=30); parser.add_argument('--cycles',type=int,default=2)
    args=parser.parse_args(); assert 10<=args.seconds<=180 and 1<=args.cycles<=5
    asyncio.run(main(args))
