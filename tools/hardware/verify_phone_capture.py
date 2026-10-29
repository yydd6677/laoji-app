"""Physical speaker -> board microphone -> Android capture/live-ASR probe.

Starts/stops its own recording only after an idle-state check. Never deletes
recordings or supplies prewritten transcripts. Optional internal-speaker volume
is restored exactly; the default audio route is never changed. UI timestamps
include accessibility-dump overhead, not precise native capture latency.
"""
import argparse
import json
import subprocess
import time
from pathlib import Path

from verify_phone_transfer import Phone, has_text


def main(args):
    phone = Phone(args.serial)
    report = {'boundary': 'physical speaker / microphone / real Android, not human-corpus quality', 'checks': []}
    started = False
    previous_volume = None
    args.output.parent.mkdir(parents=True, exist_ok=True)

    def check(case, **fields):
        row = {'case': case, **fields}; report['checks'].append(row)
        args.output.write_text(json.dumps(report, ensure_ascii=False, indent=2) + '\n')
        print(json.dumps(row, ensure_ascii=False), flush=True)

    def toggle(nodes):
        return next(n for n in nodes if n.get('resource-id') == 'hardware-capture-toggle'
                    and n.get('enabled') == 'true')

    observed_text = []
    def observe(nodes):
        value = next((n.get('text') for n in nodes if n.get('resource-id') == 'hardware-live-transcript'), '')
        if value and value not in observed_text:
            observed_text.append(value)
            check('live_text_observed', text=value, seconds=round(time.monotonic() - began, 3))

    try:
        phone.cmd('shell', 'am', 'start', '-n', 'com.laoji.app/.MainActivity')
        for _ in range(14):
            nodes = phone.nodes()
            if has_text(nodes, '设备已就绪'): break
            if has_text(nodes, '正在录音') or has_text(nodes, '录音已暂停'):
                raise RuntimeError('A recording already exists; refusing to take ownership')
            buttons = [n for n in nodes if n.get('content-desc') == '连接' and n.get('enabled') == 'true']
            if len(buttons) == 1: phone.tap(buttons[0])
            elif len(buttons) > 1: raise RuntimeError('Ambiguous board selection')
            else: phone.scroll(False)
        else: raise RuntimeError('Idle board not ready')
        # The controls may have been scrolled out while locating an older file.
        for _ in range(12):
            nodes = phone.nodes()
            try: button = toggle(nodes)
            except StopIteration:
                phone.scroll(False)
                continue
            x1, y1, x2, y2 = phone.bounds(button)
            if 0 <= y1 < y2 <= phone.height: break
            phone.scroll(False)
        else: raise RuntimeError('Recording action is not visible')

        report['start_epoch_ms'] = int(time.time() * 1000)
        began = time.monotonic(); started = True; phone.tap(button)
        nodes = phone.nodes(); assert has_text(nodes, '正在录音')
        check('recording_visible_upper_bound', seconds=round(time.monotonic() - began, 3))
        if args.speaker_volume:
            sinks = json.loads(subprocess.check_output(['pactl', '-f', 'json', 'list', 'sinks']))
            target = next(s for s in sinks if s['name'] == args.target)
            if 'Speaker' not in target['name'] or target.get('mute'):
                raise RuntimeError('Volume adjustment is restricted to an unmuted internal speaker')
            previous_volume = [str(v['value']) for v in target['volume'].values()]
            subprocess.run(['pactl', 'set-sink-volume', args.target, '30%'], check=True)
        player = subprocess.Popen(['pw-play', '--target', args.target, '--volume', '1.0', str(args.sample)])
        try:
            end = time.monotonic() + 35
            while player.poll() is None:
                if time.monotonic() >= end: raise RuntimeError('Sample playback did not finish')
                observe(phone.nodes())
            if player.returncode: raise RuntimeError('Sample playback failed')
        finally:
            if player.poll() is None: player.terminate(); player.wait(timeout=3)
        check('physical_sample_played', default_route_unchanged=True)
        for _ in range(5):
            nodes = phone.nodes()
            observe(nodes)
            if observed_text: break
        check('live_text_before_stop', observed=bool(observed_text),
              expected_fragment_present=any(args.expected in s for s in observed_text) if args.expected else None,
              seconds=round(time.monotonic() - began, 3))
        phone.tap(toggle(nodes)); nodes = phone.nodes(); assert has_text(nodes, '录音已暂停'); check('paused')
        phone.tap(toggle(nodes)); nodes = phone.nodes(); assert has_text(nodes, '正在录音'); check('resumed')
    finally:
        if previous_volume is not None:
            try:
                subprocess.run(['pactl', 'set-sink-volume', args.target, *previous_volume], check=True)
                check('original_speaker_volume_restored')
            except Exception as error:
                check('speaker_restore_requires_check', error_type=type(error).__name__)
        if started:
            try:
                nodes = phone.nodes()
                if has_text(nodes, '正在录音') or has_text(nodes, '录音已暂停'):
                    phone.tap(next(n for n in nodes if n.get('content-desc') == '结束' and n.get('enabled') == 'true'))
                    check('own_capture_stop_requested')
            except Exception as error:
                check('stop_requires_runtime_check', error_type=type(error).__name__)
        phone.cleanup()


if __name__ == '__main__':
    p = argparse.ArgumentParser()
    p.add_argument('--serial', required=True)
    p.add_argument('--sample', type=Path, required=True)
    p.add_argument('--target', required=True)
    p.add_argument('--speaker-volume', action='store_true', help='Temporarily use 30 percent internal-speaker volume')
    p.add_argument('--expected', help='Evaluation fragment only; never sent to ASR')
    p.add_argument('--output', type=Path, required=True)
    main(p.parse_args())
