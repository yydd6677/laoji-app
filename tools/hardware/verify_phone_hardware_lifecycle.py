"""Physical Android/board lifecycle without asking for human speech.

Requires the idle hardware page. Starts/stops only this probe's new capture;
ambient audio is link evidence, not ASR quality. Never deletes existing data.
"""
import argparse
import json
import re
import time
from pathlib import Path

from verify_phone_transfer import Phone, has_text


def main(args):
    phone = Phone(args.serial); started = False
    report = {'boundary': 'physical Android and board; ambient source, not speech accuracy', 'checks': []}
    args.output.parent.mkdir(parents=True, exist_ok=True)
    def check(case, **fields):
        report['checks'].append({'case': case, **fields})
        args.output.write_text(json.dumps(report, ensure_ascii=False, indent=2)+'\n')
        print(json.dumps(report['checks'][-1], ensure_ascii=False), flush=True)
    def button(nodes):
        return next(n for n in nodes if n.get('resource-id') == 'hardware-capture-toggle' and n.get('enabled') == 'true')
    def end(nodes):
        return next(n for n in nodes if n.get('content-desc') == '结束' and n.get('enabled') == 'true')
    try:
        version = re.search(r'versionName=(\S+)', phone.cmd('shell','dumpsys','package','com.laoji.app').decode()).group(1)
        assert version == args.version
        nodes = phone.nodes(); assert has_text(nodes, '设备已就绪')
        assert not has_text(nodes, '正在录音') and not has_text(nodes, '录音已暂停')
        report['version'] = version; report['start_epoch_ms'] = int(time.time()*1000)
        began = time.monotonic(); phone.tap(button(nodes)); started = True
        nodes = phone.nodes(); assert has_text(nodes, '正在录音')
        check('recording_visible_upper_bound', seconds=round(time.monotonic()-began,3))
        time.sleep(3)
        nodes = phone.nodes(); phone.tap(button(nodes)); nodes = phone.nodes()
        assert has_text(nodes, '录音已暂停'); check('paused')
        phone.tap(button(nodes)); nodes = phone.nodes()
        assert has_text(nodes, '正在录音'); check('resumed')
        time.sleep(2)
        nodes = phone.nodes(); stopped = time.monotonic(); phone.tap(end(nodes)); started = False
        deadline = time.monotonic()+45
        while time.monotonic()<deadline:
            nodes = phone.nodes()
            assert not has_text(nodes,'操作未完成'), 'Native failure must not be counted as pass'
            if has_text(nodes,'设备已就绪'):break
        else: raise AssertionError('Capture did not return to ready')
        check('ready_after_stop_upper_bound', seconds=round(time.monotonic()-stopped,3))
        log = phone.cmd('logcat','-d','-v','epoch','-s','LaojiHardware').decode(errors='replace')
        report['aggregate_logs'] = [line for line in log.splitlines()
            if re.match(r'^\s*\d+\.\d+',line) and float(line.strip().split()[0])*1000>=report['start_epoch_ms']
            and any(word in line for word in ('live_prefix_', 'pcm_integrity', 'finalize_failed', 'ble_download_verified'))]
        assert not any('pcm_integrity_failed' in line or 'finalize_failed' in line for line in report['aggregate_logs'])
        report['result']='pass_for_stated_boundary'
        args.output.write_text(json.dumps(report, ensure_ascii=False,indent=2)+'\n')
    finally:
        if started:
            nodes=phone.nodes()
            if has_text(nodes,'正在录音') or has_text(nodes,'录音已暂停'):phone.tap(end(nodes))
        phone.cleanup()


if __name__=='__main__':
    parser=argparse.ArgumentParser(); parser.add_argument('--serial',required=True)
    parser.add_argument('--version',required=True); parser.add_argument('--output',type=Path,required=True)
    main(parser.parse_args())
