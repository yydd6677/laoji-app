"""Observe the actual 5562 hardware-to-ASR path without retaining speech text.

Uses the existing virtual peripheral and real deployed service. These are
sampled timing upper bounds, not physical-radio or recognition-quality scores.
No production timeout, radio setting, microphone or old meeting is changed.
"""
import argparse
import json
import time
from pathlib import Path

from verify_live_repair import runtime, wait_control
from verify_phone_transfer import Phone

DEVICE = 'virtual-board13@C0:DE:C0:DE:13:13'
MODULE = 'modules/laoji-native-platform/src/hardware.ts'


def observe_expression(before, seconds):
    # Poll inside the app once per 125ms rather than fetching its JS bundle or
    # dumping accessibility for every timing observation. No text is exported.
    return '''m=>new Promise((resolve,reject)=>{
      const before=new Set(%s), samples=[], deadline=Date.now()+%d;
      let own=null;
      const tick=()=>Promise.all([m.listHardwareRealtimeSessions(),m.getHardwareState()]).then(([sessions,state])=>{
        const now=Date.now();
        own=own||sessions.find(s=>!before.has(s.meetingId)&&s.deviceId===%s&&!s.inputEnded);
        const live=own&&sessions.find(s=>s.meetingId===own.meetingId);
        if(live)samples.push({atMs:now,recordedAtMs:live.recordedAtMs,
          capturePhase:live.capturePhase,asrPhase:live.asrPhase,
          previewCharacters:live.preview.length,stableEvents:live.events.length,hasGap:live.hasGap});
        if(Date.now()>=deadline){resolve({meetingId:own&&own.meetingId,samples});return;}
        if(state.deviceId!==%s||!['recording','paused'].includes(state.phase)){
          reject(Error('Owned capture ended during timing observation'));return;
        }
        setTimeout(tick,125);
      },reject);tick();
    })''' % (json.dumps(before), int(seconds*1000), json.dumps(DEVICE), json.dumps(DEVICE))


def main(args):
    phone=Phone('emulator-5562'); capture=None
    report={'boundary':'sampled Android/native virtual GATT + real deployed ASR; not physical radio, quality or p95',
            'observed':False}
    def save():
        args.output.parent.mkdir(parents=True,exist_ok=True)
        args.output.write_text(json.dumps(report,ensure_ascii=False,indent=2)+'\n')
    try:
        state=runtime('m=>m.getHardwareState()')
        assert state['phase']=='ready' and state['deviceId']==DEVICE
        runtime('m=>{m.navigationRef.navigate("HardwareDevices");return true}','src/navigation/notificationNavigation.ts')
        before=runtime('m=>m.listHardwareRealtimeSessions().then(ss=>ss.map(s=>s.meetingId))')
        control=wait_control(phone,lambda n:n.get('resource-id')=='hardware-capture-toggle')
        # Host and emulator clocks may differ by hundreds of milliseconds.
        # Bracket the tap in the app's clock; never subtract the host clock
        # from native recordedAtMs or report an impossible negative latency.
        report['before_tap_app_ms']=runtime('m=>Date.now()')
        phone.tap(control)
        after=runtime('m=>m.getHardwareState().then(state=>({atMs:Date.now(),state}))')
        state=after['state'];capture=state['sessionId']
        report['after_tap_app_ms']=after['atMs']
        assert state['phase']=='recording' and capture
        report['capture_id']=capture;save()
        result=runtime(observe_expression(before,args.seconds),MODULE,wait_ms=min(50000,int(args.seconds*1000)+5000))
        assert result['meetingId'] and result['samples']
        report.update(meeting_id=result['meetingId'],samples=result['samples'])
        origin=result['samples'][0]['recordedAtMs']
        milestones={
            'native_session':lambda s:True,
            'asr_connecting':lambda s:s['asrPhase']=='connecting',
            'asr_streaming':lambda s:s['asrPhase']=='streaming',
            'first_preview':lambda s:s['previewCharacters']>0,
            'first_stable':lambda s:s['stableEvents']>0,
        }
        report['milestone_upper_ms']={key:next((s['atMs']-origin for s in result['samples'] if predicate(s)),None)
                                      for key,predicate in milestones.items()}
        assert report['before_tap_app_ms']<=origin<=report['after_tap_app_ms'], 'Capture timestamp is outside the app-clock tap bracket'
        report['tap_to_capture_upper_ms']=origin-report['before_tap_app_ms']
        report['maximum_poll_gap_ms']=max((right['atMs']-left['atMs']
                                          for left,right in zip(result['samples'],result['samples'][1:])),default=0)
        report['has_gap']=any(s['hasGap'] for s in result['samples']);save()
        runtime('m=>m.stopHardwareCapture().then(()=>m.getHardwareState())')
        end=time.monotonic()+90
        while time.monotonic()<end:
            final=runtime('m=>m.loadActiveMeetingTranscriptState("guest",'+json.dumps(result['meetingId'])+')',
                          'src/services/meetingTranscriptState.ts')
            if final and final['kind']=='final' and not final['completing']:break
            time.sleep(1)
        else:raise AssertionError('Final state remains unverified; retain the same source')
        report.update(final_lines=len(final['lines']),observed=True);save()
        print(json.dumps({key:value for key,value in report.items() if key!='samples'},ensure_ascii=False),flush=True)
    except Exception as error:
        report.update(error_type=type(error).__name__);save();raise
    finally:
        if capture:
            state=runtime('m=>m.getHardwareState()')
            if state['deviceId']==DEVICE and state['sessionId']==capture and state['phase'] in ('recording','paused'):
                try:runtime('m=>m.stopHardwareCapture().then(()=>true)')
                except Exception:pass
        phone.cleanup()


if __name__=='__main__':
    parser=argparse.ArgumentParser();parser.add_argument('--output',type=Path,required=True)
    parser.add_argument('--seconds',type=float,default=18)
    args=parser.parse_args()
    if not 5<=args.seconds<=40:parser.error('observation must be 5..40 seconds')
    main(args)
