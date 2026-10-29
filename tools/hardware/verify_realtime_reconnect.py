"""Own 5562 hardware capture -> one transparent WSS fault -> real ASR.

No fake result, service restart, radio toggle or phone interaction. Restore the
temporary dev-runtime wrapper and only this probe's reverse port afterward.
If native work is still live, retain its proxy instead of inventing a failure.
"""
import argparse
import hashlib
import io
import json
import select
import subprocess
import time
import uuid
import wave
from pathlib import Path

from verify_live_repair import runtime, wait_control
from verify_hardware_latency import observe_expression
from verify_phone_transfer import Phone
from verify_gatt_timeout_recovery import read_received_wave

ROOT=Path(__file__).resolve().parents[2]
MODULE='modules/laoji-native-platform/src/hardware.ts'
DEVICE='virtual-board13@C0:DE:C0:DE:13:13'
REALTIME='src/services/deviceV2Realtime.ts'


def inspect_existing(args):
    """Independent sub-boundary evidence; never relabel a failed full run."""
    previous=json.loads(args.inspect_existing.read_text());own=previous['meeting_id']
    assert str(uuid.UUID(own))==own and args.output.resolve()!=args.inspect_existing.resolve()
    rows=[json.loads(line) for line in args.inspect_existing.with_suffix('.proxy.jsonl').read_text().splitlines()]
    opens=[r for r in rows if r['event']=='session_open'];ready=[r for r in rows if r['event']=='ready']
    assert len(opens)>=2 and len(ready)>=2 and sum(r['event']=='injected_disconnect' for r in rows)==1
    assert ready[1]['last_chunk_ack']>=ready[0]['last_chunk_ack'] and ready[1]['last_event_seq']>=1
    assert any(r['event']=='stable' and r['connection']>=2 for r in rows)
    fingerprints={};duplicates=0;audio_bytes=0
    for row in rows:
        if row['event']!='audio':continue
        value=(row['sha256'],row['audio_bytes'],row['start_ms'],row['end_ms'])
        if row['sequence'] in fingerprints:duplicates+=1;assert fingerprints[row['sequence']]==value
        else:fingerprints[row['sequence']]=value;audio_bytes+=row['audio_bytes']
    assert sorted(fingerprints)==list(range(len(fingerprints)))
    source=runtime('m=>m.sqliteMeetingNoteRepository.findByNativeSessionId('+json.dumps(own)+',"guest")'
                   '.then(a=>({assets:a.recordingAssets.filter(x=>x.localState==="local_ready")'
                   '.map(x=>({recordingId:x.id,byteSize:x.byteSize,checksumSha256:x.checksumSha256,localUri:x.localUri,'
                   'operationId:x.uploadOperationId,remoteAssetId:x.remoteAssetId,objectRevision:x.remoteObjectRevision})), '
                   'upload:a.processingStages.filter(s=>s.stage==="upload").map(s=>({status:s.status,errorCode:s.errorCode}))}))',
                   'src/data/repositories/sqliteMeetingNoteRepository.ts')
    assert len(source['assets'])==1
    received={**source['assets'][0],'captureMeetingId':own};wav=read_received_wave(Phone('emulator-5562'),received)
    with wave.open(io.BytesIO(wav)) as audio:pcm=audio.readframes(audio.getnframes())
    with wave.open(str(args.speech_wav)) as audio:expected=audio.readframes(audio.getnframes())
    assert pcm==expected[:len(pcm)].ljust(len(pcm),b'\0') and len(pcm)==audio_bytes
    transcript=runtime('m=>m.loadActiveMeetingTranscriptState("guest",'+json.dumps(own)+')','src/services/meetingTranscriptState.ts')
    assert transcript and transcript['lines'] and len({line['id'] for line in transcript['lines']})==len(transcript['lines'])
    report=dict(boundary='real ASR reconnect and exact same-source local media only; cloud upload/final activation NOT accepted',
                original_report=str(args.inspect_existing),meeting_id=own,result='pass_for_realtime_and_local_media_only',
                connection_count=len(opens),fault_count=1,first_after_event=opens[0]['after_event_seq'],
                second_after_event=opens[1]['after_event_seq'],second_ready_chunk_ack=ready[1]['last_chunk_ack'],
                second_ready_event_seq=ready[1]['last_event_seq'],distinct_audio_frames=len(fingerprints),
                duplicate_audio_frames=duplicates,audio_bytes=audio_bytes,exact_source_pcm=True,
                full_sha256=received['checksumSha256'],pcm_sha256=hashlib.sha256(pcm).hexdigest(),
                server_complete_observed=any(r['event']=='complete' for r in rows),
                transcript_kind=transcript['kind'],transcript_lines=len(transcript['lines']),upload=source['upload'])
    if args.require_cloud_final:
        assert transcript['kind']=='final' and not transcript['completing']
        assert source['upload']==[{'status':'uploaded','errorCode':None}]
        asset=source['assets'][0]
        assert asset['remoteAssetId'].startswith('asset-revision:v2-upload-') and asset['objectRevision']>=1
        executor=runtime('m=>m.getDeviceOperation('+json.dumps(asset['operationId'])+').then(o=>o&&o.executorId)',
                         'src/data/repositories/vnext/deviceOperationsRepository.ts')
        worker=runtime('m=>m.nativeTransfer.getUploadState('+json.dumps(executor)+')',
                       'modules/laoji-native-platform/src/transfer.ts')
        assert worker['state']=='succeeded' and worker['result']=='uploaded' and worker['remoteAssetId']==asset['remoteAssetId']
        session_id=asset['remoteAssetId'].removeprefix('asset-revision:')
        remote=runtime('m=>m.deviceV2Request('+json.dumps('/uploads/'+session_id)+').then(x=>({' 
                       'state:x.session.state,bytes:x.session.expected_size,sha256:x.session.expected_sha256,'
                       'assetId:x.session.asset_id,generation:x.session.asset_generation,'
                       'verifiedAssetId:x.session.verified_asset_id,taskId:x.session.transcription_task_id}))','src/services/deviceV2Api.ts')
        # A phone-acknowledged transcript moves its verified staging object to
        # cleanup_pending/consumed. Those states alone are not acceptance:
        # require the immutable verified asset, task identity and source hash.
        assert remote['state'] in ('verified','cleanup_pending','consumed')
        assert remote['bytes']==len(wav) and remote['sha256']==received['checksumSha256']
        assert remote['assetId']==received['recordingId']
        assert remote['verifiedAssetId']==asset['remoteAssetId'] and remote['taskId']==worker['transcriptionTaskId']
        task=runtime('m=>m.deviceV2Request('+json.dumps('/tasks/'+remote['taskId'])+')'
                     '.then(x=>({state:x.task.state,sha256:x.task.input_sha256,capability:x.task.capability}))','src/services/deviceV2Api.ts')
        assert task['state']=='success' and task['capability']=='transcript' and task['sha256']==received['checksumSha256']
        report.update(boundary='same original recording after laboratory DNS repair: real reconnect, exact local PCM, verified R2 upload and same-root final; not physical radio or speech quality',
                      result='pass_for_resumed_full_boundary',work_id=executor,worker_attempts=worker['runAttemptCount'],
                      remote_upload_verified=True,object_revision=asset['objectRevision'],
                      remote_session_state=remote['state'],remote_task_state=task['state'])
    args.output.write_text(json.dumps(report,ensure_ascii=False,indent=2)+'\n');print(json.dumps(report,ensure_ascii=False),flush=True)


def main(args):
    phone=Phone('emulator-5562'); proxy=None; capture=None; own=None; hook=None; reverse=False
    nonce=uuid.uuid4().hex;key='__laojiRealtimeProbe_'+nonce
    audit=args.output.with_suffix('.proxy.jsonl')
    assert not audit.exists() and not args.output.exists(), 'Inspect the existing probe instead of replacing evidence'
    args.output.parent.mkdir(parents=True,exist_ok=True)
    report={'boundary':'actual native/virtual GATT and transparent loopback fault; real laoji.cloud ASR; not physical radio or speech quality',
            'result':'in_progress'}
    def save():args.output.write_text(json.dumps(report,ensure_ascii=False,indent=2)+'\n')
    try:
        state=runtime('m=>m.getHardwareState()')
        assert state['phase'] in ('disconnected','ready') and (not state['deviceId'] or state['deviceId']==DEVICE)
        proxy=subprocess.Popen(['node','tools/hardware/realtime_fault_proxy.cjs',str(args.port),nonce,str(audit.resolve())],
            cwd=ROOT,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True)
        if not select.select([proxy.stdout],[],[],5)[0]:raise AssertionError('Probe listener unverified; native capture not started')
        assert json.loads(proxy.stdout.readline())['listening']
        report['proxy_pid']=proxy.pid;save()
        phone.cmd('reverse','tcp:'+str(args.port),'tcp:'+str(args.port));reverse=True
        expression='''m=>{
          const key=%s;if(globalThis[key])throw Error('Probe wrapper already active');
          const original=m.prepareDeviceV2RealtimeRecording;
          let hardware;for(const [id,entry] of __r.getModules())if(entry.verboseName===%s)hardware=__r(id);
          if(!hardware)throw Error('Exact hardware module unavailable');
          const installedAt=Date.now();
          const probe={restore:()=>{m.prepareDeviceV2RealtimeRecording=original;delete globalThis[key]},
            deadline:installedAt+30000,meetingId:null,sessionId:null,captureId:null,overrides:0};
          globalThis[key]=probe;
          m.prepareDeviceV2RealtimeRecording=input=>original(input).then(options=>Promise.all([
            hardware.getHardwareState(),hardware.listHardwareRealtimeSessions()]).then(([state,sessions])=>{
            const own=sessions.find(s=>s.meetingId===input.meetingId&&s.sessionId===input.sessionId
              &&!s.inputEnded&&s.recordedAtMs>=installedAt);
            if(!own||Date.now()>probe.deadline||state.deviceId!==%s
              ||!['recording','paused'].includes(state.phase))return options;
            if(probe.sessionId&&probe.sessionId!==input.sessionId)return options;
            const path='/api/device/v2/realtime/'+encodeURIComponent(input.sessionId);
            if(options.websocketUrl!=='wss://laoji.cloud'+path)throw Error('Unexpected real upstream');
            probe.meetingId=input.meetingId;probe.sessionId=input.sessionId;probe.captureId=state.sessionId;probe.overrides++;
            return {...options,allowInsecureDevelopment:true,websocketUrl:'ws://127.0.0.1:%d/probe/'+%s+path};
          }));return {installed:true};
        }''' % (json.dumps(key),json.dumps(MODULE),json.dumps(DEVICE),args.port,json.dumps(nonce))
        assert runtime(expression,REALTIME)['installed'];hook=key
        runtime('m=>{m.navigationRef.navigate("HardwareDevices");return true}','src/navigation/notificationNavigation.ts')
        if state['phase']!='ready':runtime('m=>m.connectHardwareBle("ble:C0:DE:C0:DE:13:13")')
        before=runtime('m=>m.listHardwareRealtimeSessions().then(xs=>xs.map(s=>s.meetingId))')
        phone.tap(wait_control(phone,lambda n:n.get('resource-id')=='hardware-capture-toggle'))
        state=runtime('m=>m.getHardwareState()');capture=state['sessionId'];assert state['phase']=='recording' and capture
        report['board_session_id']=capture;save()
        observations=runtime(observe_expression(before,18),MODULE,wait_ms=24000)
        own=observations['meetingId'];report.update(meeting_id=own,samples=observations['samples']);save()
        scoped=runtime('m=>{const p=globalThis['+json.dumps(key)+'];return p&&{meetingId:p.meetingId,sessionId:p.sessionId,captureId:p.captureId,overrides:p.overrides}}',REALTIME)
        report['scoped_override']=scoped;save()
        assert scoped['meetingId']==own and scoped['captureId']==capture and scoped['sessionId']=='hwrt-'+own and scoped['overrides']==1
        report['scoped_override_count']=1;save()
        runtime('m=>m.stopHardwareCapture().then(()=>true)')
        deadline=time.monotonic()+155
        while time.monotonic()<deadline:
            sessions=runtime('m=>m.listHardwareRealtimeSessions()')
            native=next((s for s in sessions if s['meetingId']==own),None)
            final=runtime('m=>m.loadActiveMeetingTranscriptState("guest",'+json.dumps(own)+')','src/services/meetingTranscriptState.ts')
            if native is None or native['inputEnded'] and native['asrPhase'] in ('complete','unavailable'):
                report['native_terminal']=native['asrPhase'] if native else 'retired_after_local_adoption';save()
                if final and final['kind']=='final' and not final['completing']:break
            time.sleep(1)
        else:raise AssertionError('Same native job remains live or unverified; retain the proxy and inspect it')
        rows=[json.loads(line) for line in audit.read_text().splitlines()]
        faults=[r for r in rows if r['event']=='injected_disconnect']
        opens=[r for r in rows if r['event']=='session_open'];ready=[r for r in rows if r['event']=='ready']
        assert len(faults)==1 and len(opens)>=2 and len(ready)>=2
        assert native is None or native['asrPhase']=='complete'
        assert any(r['event']=='stable' and r['connection']>=2 for r in rows)
        assert any(s['previewCharacters']>0 for s in observations['samples'])
        assert ready[1]['last_chunk_ack']>=ready[0]['last_chunk_ack']
        assert ready[1]['last_event_seq']>=1
        fingerprints={};duplicates=0;audio_bytes=0
        for row in rows:
            if row['event']!='audio':continue
            fingerprint=(row['sha256'],row['audio_bytes'],row['start_ms'],row['end_ms'])
            if row['sequence'] in fingerprints:
                duplicates+=1;assert fingerprints[row['sequence']]==fingerprint
            else:fingerprints[row['sequence']]=fingerprint;audio_bytes+=row['audio_bytes']
        assert sorted(fingerprints)==list(range(len(fingerprints)))
        assets=runtime('m=>m.sqliteMeetingNoteRepository.findByNativeSessionId('+json.dumps(own)+',"guest")'
                       '.then(a=>a.recordingAssets.filter(x=>x.localState==="local_ready")'
                       '.map(x=>({recordingId:x.id,byteSize:x.byteSize,checksumSha256:x.checksumSha256,localUri:x.localUri})))',
                       'src/data/repositories/sqliteMeetingNoteRepository.ts')
        assert len(assets)==1
        received={**assets[0],'captureMeetingId':own};wav=read_received_wave(phone,received)
        with wave.open(io.BytesIO(wav)) as source:pcm=source.readframes(source.getnframes())
        with wave.open(str(args.speech_wav)) as source:expected=source.readframes(source.getnframes())
        assert pcm==expected[:len(pcm)].ljust(len(pcm),b'\0') and len(pcm)==audio_bytes
        assert len({line['id'] for line in final['lines']})==len(final['lines'])
        report.update(result='pass_for_stated_boundary',connection_count=len(opens),fault_count=1,
                      duplicate_audio_frames=duplicates,distinct_audio_frames=len(fingerprints),audio_bytes=audio_bytes,
                      first_open_after_event=opens[0]['after_event_seq'],second_open_after_event=opens[1]['after_event_seq'],
                      second_ready_chunk_ack=ready[1]['last_chunk_ack'],second_ready_event_seq=ready[1]['last_event_seq'],
                      exact_source_pcm=True,full_wav_sha256=received['checksumSha256'],pcm_sha256=hashlib.sha256(pcm).hexdigest(),
                      final_lines=len(final['lines']));save()
        print(json.dumps({k:v for k,v in report.items() if k!='samples'},ensure_ascii=False),flush=True)
    except Exception as error:
        report.update(result='not_passed',error_type=type(error).__name__);save();raise
    finally:
        if hook:
            try:report['wrapper_restored']=runtime('m=>{const p=globalThis['+json.dumps(key)+'];if(p)p.restore();return true}',REALTIME)
            except Exception:report['wrapper_restoration_unverified']=True
        if capture:
            state=runtime('m=>m.getHardwareState()')
            if state['deviceId']==DEVICE and state['sessionId']==capture and state['phase'] in ('recording','paused'):
                try:runtime('m=>m.stopHardwareCapture().then(()=>true)')
                except Exception:pass
        live=False
        if own:
            try:
                native=next((s for s in runtime('m=>m.listHardwareRealtimeSessions()') if s['meetingId']==own),None)
                live=bool(native and (not native['inputEnded'] or native['asrPhase'] not in ('complete','unavailable')))
            except Exception:live=True
        if proxy and proxy.poll() is None:
            if live:report['proxy_retained_for_same_live_job']=proxy.pid
            else:proxy.terminate();proxy.wait(timeout=8);report['proxy_stopped']=True
        if reverse and not live:phone.cmd('reverse','--remove','tcp:'+str(args.port))
        save();phone.cleanup()


if __name__=='__main__':
    parser=argparse.ArgumentParser();parser.add_argument('--output',type=Path,required=True)
    parser.add_argument('--speech-wav',type=Path,required=True);parser.add_argument('--port',type=int,default=18024)
    parser.add_argument('--inspect-existing',type=Path)
    parser.add_argument('--require-cloud-final',action='store_true')
    args=parser.parse_args()
    if not 1024<=args.port<=65535:parser.error('explicit unprivileged local port required')
    if args.inspect_existing:inspect_existing(args)
    else:main(args)
