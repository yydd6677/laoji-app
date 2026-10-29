"""Android/virtual-GATT regression for board capture failure ownership.

This is an injected peripheral error, not evidence of a physical failure cause.
Requires the virtual hardware page, never operates a physical phone or board.
"""
import argparse
import json
import time
from pathlib import Path
from verify_live_repair import runtime
from verify_phone_transfer import Phone, has_text


def main(args):
    phone=Phone('emulator-5562'); started=False
    try:
        state=runtime('m => m.getHardwareState()')
        assert state['phase']=='ready' and state['deviceId'].startswith('virtual-board13@')
        previous=runtime('m => m.listHardwareRealtimeSessions().then(ss=>ss.map(s=>s.meetingId))')
        nodes=phone.nodes(); assert has_text(nodes,'设备已就绪')
        phone.tap(next(n for n in nodes if n.get('resource-id')=='hardware-capture-toggle' and n.get('enabled')=='true'))
        started=True
        deadline=time.monotonic()+25
        while time.monotonic()<deadline:
            state=runtime('m => m.getHardwareState()')
            if state['errorCode'] is not None:break
            time.sleep(.3)
        else:raise AssertionError('Injected capture failure was not projected')
        started=False
        expected={'audio_failed':('device_audio_failed','录音设备录音中断，可重新录制。'),
                  'storage_failed':('device_storage_failed','录音设备未能保存录音，请检查存储卡。'),
                  'unknown':('device_recording_interrupted','录音设备录音中断，可重新录制。')}
        code,text=expected[args.reason]
        assert state['phase']=='ready' and state['sessionId'] is None and state['errorCode']==code
        nodes=phone.nodes(); assert has_text(nodes,text)
        assert not any('本机存储空间' in n.get('text','') for n in nodes)
        sessions=runtime('m => m.listHardwareRealtimeSessions()')
        own=[s for s in sessions if s['meetingId'] not in previous]
        assert len(own)==1 and own[0]['inputEnded'] and own[0]['capturePhase']=='interrupted' and own[0]['hasGap']
        report={'boundary':'real Android/virtual peripheral error; not physical failure cause',
                'reason':args.reason,'state_code':code,'visible_outcome':text,'same_root':own[0]['meetingId'],
                'result':'pass_for_stated_boundary'}
        args.output.parent.mkdir(parents=True,exist_ok=True)
        args.output.write_text(json.dumps(report,ensure_ascii=False,indent=2)+'\n')
        print(json.dumps(report,ensure_ascii=False))
    finally:
        if started:
            state=runtime('m => m.getHardwareState()')
            if state['phase'] in ('recording','paused'):runtime('m => m.stopHardwareCapture()')
        phone.cleanup()


if __name__=='__main__':
    parser=argparse.ArgumentParser(); parser.add_argument('--reason',choices=('audio_failed','storage_failed','unknown'),required=True)
    parser.add_argument('--output',type=Path,required=True);main(parser.parse_args())
