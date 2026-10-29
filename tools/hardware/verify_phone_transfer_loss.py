"""Owned-fixture Android interruption probe, followed separately by normal retry.

Requires explicit USB + network ADB identities of the SAME phone. Briefly toggles
WLAN with an on-device restore command; never touches the hotspot/router. Requires
a fresh, unreceived owned fixture; never deletes phone meetings or board files.
"""
import argparse
import json
import re
import subprocess
import threading
import time
from pathlib import Path

from verify_phone_transfer import Phone, row_action, has_text


def main(args):
    manifest = json.loads(args.manifest.read_text())
    assert manifest['owned_fixture'] is True
    title = manifest['title']
    assert manifest['recording']['recording_id'] == title + '.wav'
    phone = Phone(args.serial)
    report = {'boundary': 'real Android WLAN loss, owned fixture only', 'checks': []}
    args.output.parent.mkdir(parents=True, exist_ok=True)
    events = {}; done = threading.Event(); start_epoch = 0

    def usb(*params):
        return subprocess.check_output(['adb', '-s', args.usb, *params], timeout=12)

    # Refuse to toggle another phone's radio because both happen to be attached.
    assert usb('shell', 'getprop', 'ro.serialno') == phone.cmd('shell', 'getprop', 'ro.serialno')
    assert usb('shell', 'settings', 'get', 'global', 'wifi_on').strip() == b'1'

    def check(case, **fields):
        row = {'case': case, **fields}; report['checks'].append(row)
        args.output.write_text(json.dumps(report, ensure_ascii=False, indent=2) + '\n')
        print(json.dumps(row, ensure_ascii=False), flush=True)

    def monitor():
        try:
            until = time.monotonic() + 40
            while time.monotonic() < until:
                raw = usb('logcat', '-d', '-v', 'epoch', '-s', 'LaojiHardware').decode(errors='replace')
                fresh = [line for line in raw.splitlines() if re.match(r'^\s*\d+\.\d+', line)
                         and float(line.strip().split()[0]) >= start_epoch]
                if any('wifi_download_verified' in line for line in fresh):
                    events['already_finished'] = True; return
                if any('wifi_response status=200' in line for line in fresh):
                    events['triggered'] = True; events['at'] = time.monotonic()
                    # Radio restoration runs on the phone, independent of the
                    # TCP ADB connection intentionally being broken by this test.
                    usb('shell', 'sh', '-c', "'svc wifi disable; sleep 2; svc wifi enable'")
                    return
                time.sleep(.15)
            events['error'] = 'response_not_observed'
        except Exception as error:
            events['error'] = type(error).__name__
        finally:
            done.set()

    try:
        for _ in range(8):
            nodes = phone.nodes(); assert has_text(nodes, '外接录音设备')
            if has_text(nodes, '正在录音') or has_text(nodes, '录音已暂停'):
                raise RuntimeError('A pre-existing recording cannot be interrupted')
            if has_text(nodes, '设备已就绪') or has_text(nodes, '未连接'):
                break
        else: raise RuntimeError('Initial native state did not settle')
        if has_text(nodes, '设备已就绪'):
            phone.tap(next(n for n in nodes if n.get('content-desc') == '断开' and n.get('enabled') == 'true'))
            for _ in range(5):
                nodes = phone.nodes()
                if has_text(nodes, '未连接'): break
        assert has_text(nodes, '未连接')
        for _ in range(16):
            nodes = phone.nodes()
            if has_text(nodes, '设备已就绪'): break
            buttons = [n for n in nodes if n.get('content-desc') == '连接' and n.get('enabled') == 'true']
            if len(buttons) == 1: phone.tap(buttons[0])
            elif len(buttons) > 1: raise RuntimeError('Ambiguous board selection')
            else: phone.scroll(False)
        else: raise RuntimeError('No idle board')
        for _ in range(14):
            nodes = phone.nodes(); button = row_action(phone, nodes, title, '接收')
            if button is not None: break
            if row_action(phone, nodes, title, '已接收') is not None:
                raise RuntimeError('Use a fresh owned fixture; received meetings are not test cleanup space')
            phone.scroll(True)
        else: raise RuntimeError('Owned source unavailable')
        start_epoch = float(phone.cmd('shell', 'date', '+%s').decode())
        worker = threading.Thread(target=monitor, daemon=True); worker.start(); phone.tap(button)
        for _ in range(18):
            if done.is_set(): break
            try:
                nodes = phone.nodes()
                if any(n.get('resource-id') == 'com.android.settings:id/network_request_title_text' for n in nodes):
                    phone.tap(next(n for n in nodes if n.get('resource-id') == 'android:id/button1'))
            except (subprocess.CalledProcessError, subprocess.TimeoutExpired):
                time.sleep(.5)
        done.wait(15); worker.join(1)
        assert events.get('triggered') and not events.get('already_finished'), events
        usb('shell', 'svc', 'wifi', 'enable')
        for _ in range(10):
            subprocess.run(['adb', 'connect', args.serial], capture_output=True, timeout=8)
            try: nodes = phone.nodes(); break
            except (subprocess.CalledProcessError, subprocess.TimeoutExpired): time.sleep(1)
        else: raise RuntimeError('Debug reconnect not restored')
        for _ in range(6):
            if has_text(nodes, '操作未完成'): break
            nodes = phone.nodes()
        assert has_text(nodes, '操作未完成'), 'No recoverable receiver interruption'
        if args.expected_message:
            assert has_text(nodes, args.expected_message), 'Specific interruption outcome was lost'
        # Record only the tested dialog, never titles from the dimmed background.
        allowed = {'操作未完成', '知道了', args.expected_message}
        texts = [n.get('text') for n in nodes if n.get('text') in allowed]
        check('recoverable_interruption', observed_after_seconds=round(time.monotonic() - events['at'], 3), public_text=texts[-5:])
        raw = phone.cmd('logcat', '-d', '-v', 'epoch', '-s', 'LaojiHardware').decode(errors='replace')
        safe = [line for line in raw.splitlines() if re.match(r'^\s*\d+\.\d+', line)
                and float(line.strip().split()[0]) >= start_epoch
                and any(s in line for s in ['wifi_body_failed ', 'operation_failed code=', 'control_slow op=transport.wifi.close'])]
        report['aggregate_logs'] = safe
        failures = [float(line.strip().split()[0]) for line in safe if 'wifi_body_failed ' in line]
        outcomes = [float(line.strip().split()[0]) for line in safe if any(s in line for s in [
            'operation_failed code=wifi_transfer_interrupted ', 'operation_failed code=transport_lost '])]
        if failures and outcomes:
            check('native_failure_cleanup', milliseconds=round((outcomes[-1] - failures[-1]) * 1000))
        phone.tap(next(n for n in nodes if n.get('text') == '知道了' and n.get('enabled') == 'true'))
        check('ready_for_retry')
    finally:
        if events.get('triggered'):
            try: usb('shell', 'svc', 'wifi', 'enable')
            except Exception: check('radio_restore_requires_check')
        phone.cleanup()


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--serial', required=True)
    parser.add_argument('--usb', required=True)
    parser.add_argument('--manifest', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--expected-message', help='Require the concrete public recovery outcome')
    main(parser.parse_args())
