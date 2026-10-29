"""5562 native receiver + explicit virtual-source fault + real ASR replay.

Never operates a phone/real microphone, deletes old data, fabricates a transcript,
or restarts a service. A timeout leaves the owned final job for inspection.
"""
import argparse
import hashlib
import json
import re
import subprocess
import time
import wave
from pathlib import Path

from verify_phone_transfer import Phone, has_text

MODULE = 'modules/laoji-native-platform/src/hardware.ts'


def latest_capture_gaps(log):
    rows = [json.loads(line) for line in log.splitlines() if line.startswith('{')]
    starts = [index for index, row in enumerate(rows) if row.get('event') == 'capture.started']
    if not starts:
        raise AssertionError('Fixture evidence has no capture boundary')
    return [row for row in rows[starts[-1]+1:] if row.get('event') == 'injected_live_gap']


def runtime(expression, module=MODULE, wait_ms=12000):
    return json.loads(subprocess.check_output(
        ['node', 'tools/hardware/emulator_runtime.cjs', module, expression, str(wait_ms)],
        text=True, timeout=max(18, wait_ms/1000+12)))


def wait_control(phone, predicate, seconds=8):
    """A busy accessibility snapshot is not evidence that a control vanished."""
    deadline = time.monotonic() + seconds
    while True:
        matches = [node for node in phone.nodes() if predicate(node) and node.get('enabled') == 'true']
        if len(matches) == 1:
            return matches[0]
        if len(matches) > 1:
            raise AssertionError('Ambiguous live control; never select arbitrary coordinates')
        if time.monotonic() >= deadline:
            raise AssertionError('No enabled live control observed within the bounded wait')
        time.sleep(.2)


def main(args):
    phone = Phone('emulator-5562'); started = False
    args.output.parent.mkdir(parents=True, exist_ok=True)
    report = {'boundary': 'actual Android native over virtual GATT; actual deployed ASR; not physical radio or speech accuracy',
              'expected_repair': args.expect, 'snapshots': []}
    def save(): args.output.write_text(json.dumps(report, ensure_ascii=False, indent=2) + '\n')
    try:
        package = phone.cmd('shell', 'dumpsys', 'package', 'com.laoji.app').decode()
        report['version'] = re.search(r'versionName=(\S+)', package).group(1)
        for _ in range(10):
            nodes = phone.nodes()
            if has_text(nodes, '设备已就绪'): break
            if has_text(nodes, '正在录音') or has_text(nodes, '录音已暂停'):
                raise RuntimeError('Refusing to stop a pre-existing capture')
            buttons = [n for n in nodes if n.get('content-desc') == '连接' and n.get('enabled') == 'true']
            if len(buttons) == 1: phone.tap(buttons[0])
            elif len(buttons) > 1: raise RuntimeError('Ambiguous peripheral')
        else: raise RuntimeError('No ready virtual peripheral')
        state = runtime('m => m.getHardwareState()')
        assert state['deviceId'].startswith('virtual-board13@'), 'This probe is not for a real board'
        before = runtime('m => m.listHardwareRealtimeSessions().then(ss=>ss.map(s=>s.meetingId))')
        nodes = phone.nodes()
        phone.tap(wait_control(phone, lambda n: n.get('resource-id') == 'hardware-capture-toggle'))
        started = True; began = time.monotonic()
        report['board_session_id'] = runtime('m => m.getHardwareState().then(s=>s.sessionId)')
        while time.monotonic() - began < args.seconds:
            sessions = runtime('m => m.listHardwareRealtimeSessions()')
            own = [s for s in sessions if s['meetingId'] not in before and not s['inputEnded']]
            if own: report['snapshots'].append({'after_seconds': round(time.monotonic()-began, 3), **own[0]})
            time.sleep(.65)
        snapshots = report['snapshots']; assert snapshots
        meeting = snapshots[-1]['meetingId']; report['meeting_id'] = meeting
        report['has_gap'] = any(s['hasGap'] for s in snapshots)
        native = phone.cmd('exec-out', 'run-as', 'com.laoji.app', 'cat', f'files/meeting-audio/hardware-realtime/{meeting}.pcm')
        with wave.open(str(args.speech_wav)) as source:
            assert (source.getnchannels(), source.getsampwidth(), source.getframerate()) == (1, 2, 16000)
            pcm = source.readframes(source.getnframes())
        report['prefix_bytes'] = len(native)
        report['prefix_sha256'] = hashlib.sha256(native).hexdigest()
        report['exact_source_prefix'] = native == pcm[:len(native)].ljust(len(native), b'\0')
        report['phase_before_stop'] = runtime('m => m.getHardwareState().then(s=>s.phase)')
        draft = runtime('m => m.loadActiveMeetingTranscriptState("guest",'+json.dumps(meeting)+')', 'src/services/meetingTranscriptState.ts')
        report['draft_lines'] = len(draft['lines']) if draft else 0
        report['injected_gaps'] = latest_capture_gaps(args.fixture_log.read_text())
        log = phone.cmd('logcat', '-d', '-v', 'epoch', '-s', 'LaojiHardware').decode(errors='replace')
        report['aggregate_logs'] = [l for l in log.splitlines() if re.match(r'^\s*\d+\.\d+', l)
            and float(l.strip().split()[0])*1000 >= snapshots[0]['recordedAtMs']-1000
            and any(k in l for k in ('live_prefix_repaired', 'live_prefix_sealed', 'pcm_integrity', 'finalize_failed'))]
        if args.screenshot:
            screen = args.output.with_suffix('.png')
            screen.write_bytes(phone.cmd('exec-out', 'screencap', '-p'))
            report['screenshot'] = str(screen)
        save()
        phone.tap(wait_control(phone, lambda n: n.get('content-desc') == '结束'))
        # A tap is an intent, not proof that the board accepted stop.
        for _ in range(20):
            stopped = runtime('m => m.getHardwareState()')
            if stopped.get('phase') in ('ready', 'finalizing'):
                started = False; break
            if stopped.get('phase') not in ('recording', 'paused'):
                raise RuntimeError('Stop did not produce a completed source; preserve this capture')
            time.sleep(.2)
        else:
            raise RuntimeError('Stop intent not acknowledged; cleanup must inspect this same capture')
        for _ in range(45):
            final = runtime('m => m.loadActiveMeetingTranscriptState("guest",'+json.dumps(meeting)+')', 'src/services/meetingTranscriptState.ts')
            if final and final['kind'] == 'final' and not final.get('completing'): break
            time.sleep(2)
        else: raise RuntimeError('Final job remains unverified; inspect this same meeting, do not duplicate/restart')
        report['same_root_final'] = True; report['final_lines'] = len(final['lines']); save()
        assert report['phase_before_stop'] == 'recording' and report['exact_source_prefix']
        assert len(report['injected_gaps']) == args.drops and report['draft_lines'] >= args.minimum_draft_lines
        assert report['has_gap'] == (args.expect == 'sealed')
        if args.expect == 'recovered':
            assert len(native) >= len(pcm) and any('live_prefix_repaired' in l for l in report['aggregate_logs'])
        else:
            assert len(native) == min(r['source_offset'] for r in report['injected_gaps'])
        report['result'] = 'pass_for_stated_boundary'; save()
        print(json.dumps({k: v for k, v in report.items() if k != 'snapshots'}, ensure_ascii=False))
    except Exception as error:
        report['error_type'] = type(error).__name__; report['result'] = 'not_passed'; save(); raise
    finally:
        if started:
            # Cleanup is not UI acceptance. If accessibility/transport failed,
            # end only this exact virtual source, never an unrelated capture.
            state = runtime('m => m.getHardwareState()')
            if state.get('deviceId', '').startswith('virtual-board13@') and state.get('sessionId') == report.get('board_session_id') and state.get('phase') in ('recording', 'paused'):
                try:
                    runtime('m => m.stopHardwareCapture().then(()=>true)')
                    report['cleanup_via_native'] = True; save()
                except Exception:
                    report['cleanup_requires_fixture_inspection'] = True; save()
        phone.cleanup()


if __name__ == '__main__':
    p = argparse.ArgumentParser()
    p.add_argument('--speech-wav', type=Path, required=True)
    p.add_argument('--fixture-log', type=Path, required=True)
    p.add_argument('--expect', choices=('recovered', 'sealed'), required=True)
    p.add_argument('--drops', type=int, required=True)
    p.add_argument('--seconds', type=float, default=19)
    p.add_argument('--minimum-draft-lines', type=int, default=1)
    p.add_argument('--output', type=Path, required=True)
    p.add_argument('--screenshot', action='store_true', help='Save the actual pre-stop Android screen')
    main(p.parse_args())
