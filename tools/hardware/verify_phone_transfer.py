"""Real Android receiver probe; fresh accessibility state, explicit device/title.

Never deletes recordings or changes phone radios. A successful receive now
automatically creates/updates its meeting through the normal application. The
system network confirmation is handled only when its exact Settings page is
visible. Results are not ASR/microphone quality evidence.
"""
import argparse
import json
import re
import subprocess
import time
import uuid
from pathlib import Path
from xml.etree import ElementTree as ET


class Phone:
    def __init__(self, serial):
        self.adb = ['adb', '-s', serial]
        self.path = '/sdcard/laoji-transfer-' + uuid.uuid4().hex + '.xml'
        self.height = 2400
        self.width = 1080

    def cmd(self, *args, timeout=18):
        return subprocess.run(self.adb + list(args), capture_output=True,
                              check=True, timeout=timeout).stdout

    def nodes(self):
        response = self.cmd('shell', 'uiautomator', 'dump', self.path)
        if b'ERROR' in response:
            return []
        raw = self.cmd('exec-out', 'cat', self.path)
        if not raw:
            raise RuntimeError('Debug connection did not return a fresh UI dump')
        root = ET.fromstring(raw)
        first = root.find('node')
        if first is not None:
            _, _, self.width, self.height = self.bounds(first)
        return list(root.iter('node'))

    @staticmethod
    def bounds(node):
        return tuple(map(int, re.findall(r'\d+', node.get('bounds', ''))))

    def tap(self, node):
        x1, y1, x2, y2 = self.bounds(node)
        if node.get('enabled') != 'true' or x2 <= x1 or y2 <= y1 or not (0 <= y1 < y2 <= self.height):
            raise RuntimeError('Target is disabled or outside the visible viewport')
        self.cmd('shell', 'input', 'tap', str((x1 + x2) // 2), str((y1 + y2) // 2))

    def scroll(self, down):
        high, low = 600, self.height - 450
        start, end = (low, high) if down else (high, low)
        self.cmd('shell', 'input', 'swipe', str(self.width // 2), str(start),
                 str(self.width // 2), str(end), '220')

    def cleanup(self):
        try:
            self.cmd('shell', 'rm', self.path)
        except Exception:
            pass


def has_text(nodes, value):
    return any(n.get('text') == value for n in nodes)


def row_action(phone, nodes, title, label):
    candidates = []
    for node in nodes:
        if node.get('text') != title:
            continue
        _, y1, _, y2 = phone.bounds(node)
        for action in nodes:
            if action.get('content-desc') != label:
                continue
            ax1, ay1, ax2, ay2 = phone.bounds(action)
            if ax1 > phone.width * .6 and y1 <= (ay1 + ay2) // 2 <= y2 + 100 and ay2 > ay1:
                candidates.append(action)
    if len(candidates) > 1:
        raise RuntimeError('Ambiguous recording action; refusing to tap')
    return candidates[0] if candidates else None


def run(args):
    phone = Phone(args.serial)
    report = {'boundary': 'real Android + board; no speech quality claim', 'checks': []}
    args.output.parent.mkdir(parents=True, exist_ok=True)

    def check(case, **fields):
        report['checks'].append({'case': case, **fields})
        args.output.write_text(json.dumps(report, ensure_ascii=False, indent=2) + '\n')
        print(json.dumps(report['checks'][-1], ensure_ascii=False), flush=True)

    try:
        package = phone.cmd('shell', 'dumpsys', 'package', 'com.laoji.app').decode()
        version = re.search(r'versionName=(\S+)', package).group(1)
        if args.version and version != args.version:
            raise RuntimeError('Installed version differs from requested artifact')
        report['version'] = version
        phone.cmd('shell', 'am', 'start', '-n', 'com.laoji.app/.MainActivity')
        nodes = phone.nodes()
        if not has_text(nodes, '外接录音设备'):
            raise RuntimeError('Expected hardware page; no speculative navigation')
        connecting = refreshed = False
        for _ in range(10):
            nodes = phone.nodes()
            if has_text(nodes, '设备已就绪'):
                break
            connect = [n for n in nodes if n.get('content-desc') == '连接' and n.get('enabled') == 'true']
            if connect and not connecting:
                if len(connect) != 1:
                    raise RuntimeError('Multiple device candidates; refusing to choose')
                phone.tap(connect[0]); connecting = True
            elif not connect and not connecting and not refreshed:
                refresh = [n for n in nodes if n.get('resource-id') == 'hardware-refresh']
                if len(refresh) == 1:
                    phone.tap(refresh[0]); refreshed = True
        else:
            raise RuntimeError('Board not ready')

        # Return to the beginning first, then search down. Never tap by a stale
        # coordinate, a clipped row or a similarly named recording.
        for down in (False, True):
            for _ in range(10):
                nodes = phone.nodes()
                button = row_action(phone, nodes, args.title, '接收')
                if button is not None:
                    break
                if row_action(phone, nodes, args.title, '已接收') is not None:
                    raise RuntimeError('Source already received; this is not a fresh-transfer pass')
                phone.scroll(down)
            else:
                continue
            break
        else:
            raise RuntimeError('Recording not found')
        started_epoch = float(phone.cmd('shell', 'date', '+%s').decode().strip())
        started = time.monotonic()
        phone.tap(button)
        confirmed = False
        reused = False

        def fresh_logs():
            logs = phone.cmd('logcat', '-d', '-v', 'epoch', '-s', 'LaojiHardware').decode(errors='replace')
            return [line for line in logs.splitlines() if re.match(r'^\s*\d+\.\d+', line)
                    and float(line.strip().split()[0]) >= started_epoch
                    and any(key in line for key in ('wifi_connected ', 'wifi_response ',
                      'wifi_body_complete ', 'wifi_download_verified '))]

        while time.monotonic() - started < 27:
            nodes = phone.nodes()
            if any(n.get('resource-id') == 'com.android.settings:id/network_request_title_text'
                   and n.get('text') == '连接到设备' for n in nodes):
                key = 'android:id/button3' if args.cancel else 'android:id/button1'
                phone.tap(next(n for n in nodes if n.get('resource-id') == key))
                confirmed = True
                check('system_cancel' if args.cancel else 'system_confirm',
                      seconds=round(time.monotonic() - started, 3))
                break
            if any('wifi_connected ' in line for line in fresh_logs()):
                if args.cancel:
                    raise RuntimeError('System reused approval; no dialog cancellation was exercised')
                reused = True
                check('system_authorization_reused', seconds=round(time.monotonic() - started, 3))
                break
            if has_text(nodes, '操作未完成'):
                raise RuntimeError('Failed before system confirmation')
        if not confirmed and not reused:
            raise RuntimeError('System confirmation not observed in request window')

        until = time.monotonic() + args.timeout
        while time.monotonic() < until:
            nodes = phone.nodes()
            if has_text(nodes, '操作未完成'):
                if not args.cancel:
                    raise RuntimeError('Receiver reported failure')
                if not has_text(nodes, '未能连接录音设备的传输网络。'):
                    raise RuntimeError('Cancellation lost its public error outcome')
                phone.tap(next(n for n in nodes if n.get('text') == '知道了'))
                check('cancel_recovered', correct_message=True)
                return
            if not args.cancel and row_action(phone, nodes, args.title, '已接收') is not None:
                check('received_ui', seconds=round(time.monotonic() - started, 3))
                lines = fresh_logs()
                if not any('wifi_download_verified ' in line and 'sha_match=true' in line for line in lines):
                    raise RuntimeError('No fresh full-file integrity evidence')
                report['aggregate_logs'] = lines
                check('full_file_integrity', sha_match=True)
                return
        raise RuntimeError('No terminal result within probe window')
    except Exception as error:
        check('probe_failed', error_type=type(error).__name__, message=str(error)[:160])
        raise
    finally:
        phone.cleanup()


if __name__ == '__main__':
    p = argparse.ArgumentParser()
    p.add_argument('--serial', required=True)
    p.add_argument('--title', required=True)
    p.add_argument('--version')
    p.add_argument('--cancel', action='store_true')
    p.add_argument('--timeout', type=float, default=100)
    p.add_argument('--output', type=Path, required=True)
    run(p.parse_args())
