"""Actual 5562 GATT callback timeout/reconnect/source recovery.

Run against the explicit one-shot capture.pause ATT-delay fixture. Never
operates a physical board or microphone; preserves the same failed source.
"""
import argparse
import hashlib
import io
import json
import subprocess
import time
import uuid
import wave
from urllib.parse import urlparse
from pathlib import Path

from verify_live_repair import runtime, wait_control
from verify_phone_transfer import Phone

LOCATOR = 'ble:C0:DE:C0:DE:13:13'
DEVICE = 'virtual-board13@C0:DE:C0:DE:13:13'


def read_received_wave(phone, received):
    """Follow the pending→canonical handoff without hiding corruption.

    exec-out does not reliably carry a remote cat failure's exit status. Use
    shell-v2 with PTY explicitly disabled, and validate the actual bytes. Only
    a vanished pending path may be re-resolved; an existing corrupt canonical
    file never falls back to an older copy or a new source.
    """
    meeting=received['captureMeetingId'];recording=received['recordingId']
    assert str(uuid.UUID(meeting))==meeting and str(uuid.UUID(recording))==recording
    for attempt in range(3):
        asset=runtime('m=>m.sqliteMeetingNoteRepository.findByNativeSessionId('+json.dumps(meeting)+',"guest")'
                      '.then(a=>a&&a.recordingAssets.filter(x=>x.id==='+json.dumps(recording)+')'
                      '.map(x=>({localUri:x.localUri,localState:x.localState,byteSize:x.byteSize,checksumSha256:x.checksumSha256})))',
                      'src/data/repositories/sqliteMeetingNoteRepository.ts')
        assert asset is None or len(asset)<=1
        canonical=bool(asset and asset[0]['localState']=='local_ready')
        selected=asset[0] if canonical else received
        if canonical:
            assert selected['byteSize']==received['byteSize'] and selected['checksumSha256']==received['checksumSha256']
        uri=urlparse(selected['localUri'])
        suffix=('/hardware-pending/'+recording+'.wav' if not canonical
                else '/imports/'+meeting+'/'+recording+'.wav')
        assert uri.scheme=='file' and uri.path.endswith(suffix)
        try:
            data=phone.cmd('shell','-T','run-as','com.laoji.app','cat',uri.path)
        except subprocess.CalledProcessError:
            if canonical or attempt==2:raise
            time.sleep(.2);continue  # The app may have durably adopted it.
        assert len(data)==received['byteSize'] and data[:4]==b'RIFF'
        assert 'sha256:'+hashlib.sha256(data).hexdigest()==received['checksumSha256']
        return data
    raise AssertionError('Same-source media is unavailable; do not restart or replace it')


def wait_state(predicate, seconds=12):
    deadline = time.monotonic()+seconds
    while True:
        state = runtime('m=>m.getHardwareState()')
        if predicate(state): return state
        if time.monotonic() >= deadline: raise AssertionError('Same source state did not converge; do not restart the probe')
        time.sleep(.2)


def main(args):
    phone = Phone('emulator-5562'); board_session = None; own_meeting = None
    movie = None; remote_movie = None
    report = {'boundary':'actual Android native/GATT with virtual ATT-delay; not physical radio or speech quality', 'checks':[]}
    args.output.parent.mkdir(parents=True,exist_ok=True)
    def check(case, **fields):
        report['checks'].append({'case':case,**fields})
        args.output.write_text(json.dumps(report,ensure_ascii=False,indent=2)+'\n')
        print(json.dumps(report['checks'][-1],ensure_ascii=False),flush=True)
    try:
        faults=[json.loads(line) for line in args.fixture_log.read_text().splitlines() if line.startswith('{')]
        assert not any(row.get('event')=='injected_control_write_delay' for row in faults), 'Fault is one-shot; inspect the existing run'
        state = runtime('m=>m.getHardwareState()')
        assert state['phase'] not in ('recording','paused','finalizing','transferring')
        assert not state['deviceId'] or state['deviceId']==DEVICE
        runtime('m=>{m.navigationRef.navigate("HardwareDevices");return true}', 'src/navigation/notificationNavigation.ts')
        if state['phase']!='ready': runtime('m=>m.connectHardwareBle('+json.dumps(LOCATOR)+')')
        before=runtime('m=>m.listHardwareRealtimeSessions().then(ss=>ss.map(s=>s.meetingId))')
        source_before=runtime('m=>m.listHardwareDeviceRecordings().then(rows=>rows.map(r=>r.recordingId))')
        phone.tap(wait_control(phone,lambda n:n.get('resource-id')=='hardware-capture-toggle'))
        state=wait_state(lambda s:s['phase']=='recording' and bool(s['sessionId']),8)
        assert state['deviceId']==DEVICE;board_session=state['sessionId'];report['board_session_id']=board_session
        time.sleep(6)
        sessions=runtime('m=>m.listHardwareRealtimeSessions()')
        own=[s for s in sessions if s['meetingId'] not in before and not s['inputEnded']]
        assert len(own)==1;own_meeting=own[0]['meetingId'];report['meeting_id']=own_meeting
        check('owned_source_started',phase=state['phase'])
        if args.record_ui:
            remote_movie='/sdcard/laoji-gatt-'+uuid.uuid4().hex+'.mp4'
            movie=subprocess.Popen(phone.adb+['shell','screenrecord','--bit-rate','2000000','--time-limit','16',remote_movie],
                                   stdout=subprocess.DEVNULL,stderr=subprocess.PIPE)
        phone.tap(wait_control(phone,lambda n:n.get('resource-id')=='hardware-capture-toggle'))
        began=time.monotonic()
        failed=wait_state(lambda s:s['phase']=='retryable_error',10)
        check('timeout_retired_connection',observed_seconds=round(time.monotonic()-began,3),error_code=failed['errorCode'])
        assert failed['sessionId'] is None and failed['streamId'] is None
        own=[s for s in runtime('m=>m.listHardwareRealtimeSessions()') if s['meetingId']==own_meeting]
        assert len(own)==1 and own[0]['inputEnded'] and own[0]['capturePhase']=='interrupted' and own[0]['hasGap']
        fault_rows=[json.loads(line) for line in args.fixture_log.read_text().splitlines() if line.startswith('{')]
        injected=[row for row in fault_rows if row.get('event')=='injected_control_write_delay']
        assert len(injected)==1 and injected[0]['op']=='capture.pause' and injected[0]['delay_ms']==args.delay_ms
        nodes=phone.nodes()
        copies=sum(node.get('text')=='连接超时，请重试。' for node in nodes)
        assert copies==args.expect_error_copies, 'The same error must have the expected number of visible owners'
        if args.expect_error_copies==1:
            assert not any(node.get('text')=='操作未完成' for node in nodes), 'A persistent connection failure must not open a duplicate modal'
        check('visible_error_ownership',copies=copies)
        screen=args.output.with_suffix('.png');screen.write_bytes(phone.cmd('exec-out','screencap','-p'))
        report['error_screenshot']=str(screen)
        # Prove the overlap, do not infer it merely from a configured delay.
        report['reconnect_started_epoch_ms']=int(time.time()*1000)
        assert report['reconnect_started_epoch_ms'] < injected[0]['started_epoch_ms']+args.delay_ms, 'Old response already returned; this run cannot prove overlap'
        recovered=runtime('m=>m.connectHardwareBle('+json.dumps(LOCATOR)+')')
        report['reconnected_epoch_ms']=int(time.time()*1000)
        assert recovered['phase']=='paused' and recovered['sessionId']==board_session
        time.sleep(2)
        recovered=runtime('m=>m.getHardwareState()')
        assert recovered['phase']=='paused' and recovered['sessionId']==board_session
        callbacks=[json.loads(line) for line in args.fixture_log.read_text().splitlines() if line.startswith('{')]
        returned=[row for row in callbacks if row.get('event')=='delayed_control_response_returned']
        assert len(returned)==1 and report['reconnected_epoch_ms'] < returned[0]['returned_epoch_ms'], 'New connection was not active before the old delayed response'
        check('late_old_response_did_not_change_reconnected_source',phase=recovered['phase'],
              old_response_after_new_connection_ms=returned[0]['returned_epoch_ms']-report['reconnected_epoch_ms'])
        runtime('m=>m.resumeHardwareCapture().then(s=>s.phase)')
        time.sleep(1)
        runtime('m=>m.pauseHardwareCapture().then(s=>s.phase)')
        runtime('m=>m.stopHardwareCapture().then(()=>true)')
        wait_state(lambda s:s['phase']=='ready',10)
        check('new_control_connection_handles_resume_pause_stop')
        after=runtime('m=>m.listHardwareDeviceRecordings()')
        new=[row for row in after if row['recordingId'] not in source_before]
        assert len(new)==1
        report['source_recording']=new[0]
        args.output.write_text(json.dumps(report,ensure_ascii=False,indent=2)+'\n')
        received=runtime('m=>m.receiveHardwareDeviceRecording('+json.dumps(new[0]['recordingId'])+','+json.dumps(new[0]['generation'])+')',wait_ms=35000)
        assert received['captureMeetingId']==own_meeting
        check('verified_source_keeps_original_meeting',bytes=received['byteSize'],sha256=received['checksumSha256'])
        deadline=time.monotonic()+90
        while time.monotonic()<deadline:
            final=runtime('m=>m.loadActiveMeetingTranscriptState("guest",'+json.dumps(own_meeting)+')','src/services/meetingTranscriptState.ts')
            if final and final['kind']=='final' and not final['completing']:break
            time.sleep(2)
        else:raise AssertionError('Same meeting final remains unverified; retain and inspect it')
        check('same_root_final_readable',lines=len(final['lines']))
        report['result']='pass_for_stated_boundary'
        args.output.write_text(json.dumps(report,ensure_ascii=False,indent=2)+'\n')
    except Exception as error:
        report.update(result='not_passed',error_type=type(error).__name__)
        args.output.write_text(json.dumps(report,ensure_ascii=False,indent=2)+'\n');raise
    finally:
        # A physical peer would continue independent SD capture. Never guess
        # that an intent stopped it, or create a replacement microphone source.
        if board_session:
            state=runtime('m=>m.getHardwareState()')
            if state['deviceId']==DEVICE and state['sessionId']==board_session and state['phase'] in ('recording','paused'):
                try:runtime('m=>m.stopHardwareCapture().then(()=>true)')
                except Exception:pass  # report retains exact source for recovery
        if movie:
            try:
                movie.wait(timeout=22)
                if movie.returncode==0:
                    local_movie=args.output.with_suffix('.mp4')
                    phone.cmd('pull',remote_movie,str(local_movie))
                    report['ui_recording']=str(local_movie)
                    args.output.write_text(json.dumps(report,ensure_ascii=False,indent=2)+'\n')
            finally:
                if movie.poll() is not None:phone.cmd('shell','rm',remote_movie)
        phone.cleanup()


def resume_existing(args):
    """Continue a terminally failed receive of the same recorded source.

    Read its native durable identity, never infer it from title or create a new
    capture. An observation timeout by itself is NOT permission to retry.
    """
    previous=json.loads(args.resume_from.read_text());meeting=previous['meeting_id']
    assert str(uuid.UUID(meeting))==meeting
    phone=Phone('emulator-5562')
    report={'boundary':'same Android/virtual source receive recovery; not a replacement test',
            'previous_report':str(args.resume_from),'meeting_id':meeting}
    def save():args.output.parent.mkdir(parents=True,exist_ok=True);args.output.write_text(json.dumps(report,indent=2)+'\n')
    try:
        state=runtime('m=>m.getHardwareState()')
        assert state['phase']=='retryable_error' and state['deviceId']==DEVICE, 'Receive must be terminal, not merely unobserved'
        owner=json.loads(phone.cmd('exec-out','run-as','com.laoji.app','cat',f'files/meeting-audio/hardware-realtime/{meeting}.json'))
        assert owner['deviceId']==DEVICE and owner['captureSessionId']==previous['board_session_id'] and owner['inputEnded']
        source,generation=owner['sourceRecordingId'],owner['sourceGeneration']
        download_id=str(uuid.UUID(bytes=hashlib.md5((DEVICE+'\0'+source+'\0'+generation).encode()).digest(),version=3))
        prefix=phone.cmd('exec-out','run-as','com.laoji.app','cat',f'files/meeting-audio/hardware-pending/.{download_id}.device.wav.part.pcm')
        assert len(prefix)>0 and len(prefix)%2==0
        report.update(source_recording_id=source,source_generation=generation,
                      retained_prefix_bytes=len(prefix),retained_prefix_sha256=hashlib.sha256(prefix).hexdigest());save()
        recovered=runtime('m=>m.connectHardwareBle('+json.dumps(LOCATOR)+')')
        assert recovered['phase']=='ready' and recovered['sessionId'] is None
        selected=runtime('m=>m.getHardwareDeviceRecording('+json.dumps({'recordingId':source,'generation':generation})+')')
        received=runtime('m=>m.receiveHardwareDeviceRecording('+json.dumps(source)+','+json.dumps(generation)+')',wait_ms=35000)
        assert received['captureMeetingId']==meeting and received['recordingId']==download_id
        wav=read_received_wave(phone,received)
        with wave.open(io.BytesIO(wav)) as audio:
            assert (audio.getnchannels(),audio.getsampwidth(),audio.getframerate())==(1,2,16000)
            pcm=audio.readframes(audio.getnframes())
        assert pcm[:len(prefix)]==prefix
        report.update(final_bytes=len(wav),full_sha256=received['checksumSha256'],retained_prefix_matches_final=True);save()
        deadline=time.monotonic()+90
        while time.monotonic()<deadline:
            final=runtime('m=>m.loadActiveMeetingTranscriptState("guest",'+json.dumps(meeting)+')','src/services/meetingTranscriptState.ts')
            if final and final['kind']=='final' and not final['completing']:break
            time.sleep(2)
        else:raise AssertionError('Same-root final still unverified')
        report.update(final_lines=len(final['lines']),result='pass_for_same_source_recovery');save()
        print(json.dumps(report),flush=True)
    except Exception as error:
        report.update(result='not_passed',error_type=type(error).__name__);save();raise
    finally:phone.cleanup()


if __name__=='__main__':
    parser=argparse.ArgumentParser();parser.add_argument('--fixture-log',type=Path,required=True)
    parser.add_argument('--output',type=Path,required=True)
    parser.add_argument('--expect-error-copies',type=int,choices=(1,2),default=1)
    parser.add_argument('--record-ui',action='store_true')
    parser.add_argument('--delay-ms',type=int,default=8000)
    parser.add_argument('--resume-from',type=Path)
    args=parser.parse_args()
    if args.resume_from:resume_existing(args)
    else:main(args)
