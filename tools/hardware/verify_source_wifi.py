"""Real board HTTP acceptance via a temporary Linux NetworkManager profile.

Temporarily leaves the selected Wi-Fi, restores its exact connection UUID in
finally, and also starts an independent 60 s restoration watchdog. Does not
change router settings, log credentials, delete card files or flash firmware.
This host integration probe is Linux-only; firmware/build tools remain portable.
"""
import argparse
import asyncio
import hashlib
import io
import json
import socket
import subprocess
import sys
import time
import threading
import urllib.error
import urllib.parse
import urllib.request
import uuid
import wave
from pathlib import Path

from verify_source_firmware import connect, prepare, files


def nm(*args):
    result = subprocess.run(['nmcli', '--wait', '18', *args], capture_output=True,
                            text=True, timeout=24)
    if result.returncode:
        # nmcli diagnostics can contain SSIDs. Never echo command arguments.
        raise RuntimeError(f'NetworkManager operation failed ({result.returncode})')
    return result.stdout.strip()


def restore(original, scratch):
    nm('connection', 'up', 'uuid', original)
    try:
        nm('connection', 'delete', 'id', scratch)
    except RuntimeError:
        pass  # Profile might not have been created before an interruption.


def request(url, token, method='GET', **extra):
    headers = {'Authorization': 'Bearer ' + token, **extra}
    req = urllib.request.Request(url, method=method, headers=headers)
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    try:
        response = opener.open(req, timeout=10)
    except urllib.error.HTTPError as error:
        response = error
    with response:
        return response.status, dict(response.headers), response.read()


def blocked_download(url, token, ready, released):
    """Fill a small TCP receive window, then inspect revocation without writing audio."""
    target = urllib.parse.urlsplit(url)
    with socket.socket() as client:
        client.settimeout(3); client.setsockopt(socket.SOL_SOCKET, socket.SO_RCVBUF, 16384)
        client.connect((target.hostname, target.port or 80))
        client.sendall((f'GET {target.path} HTTP/1.1\r\nHost: {target.hostname}\r\n'
                        f'Authorization: Bearer {token}\r\nConnection: close\r\n\r\n').encode('ascii'))
        headers = bytearray()
        while not headers.endswith(b'\r\n\r\n'):
            value = client.recv(1)
            if not value or len(headers) >= 4096: raise RuntimeError('Invalid response header')
            headers.extend(value)
        assert headers.startswith(b'HTTP/1.1 200 ')
        ready.set()
        if not released.wait(8): raise RuntimeError('Revocation test did not release its reader')
        count = 0
        while True:
            try: data = client.recv(16384)
            except OSError: break
            if not data: break
            count += len(data)
        return count


async def main(args):
    args.output.mkdir(parents=True, exist_ok=True)
    report = {'boundary': 'real board / Linux BLE + physical Wi-Fi HTTP, not Android', 'checks': []}

    def check(case, **data):
        report['checks'].append({'case': case, **data})
        (args.output / 'results.json').write_text(json.dumps(report, indent=2) + '\n')
        print(json.dumps(report['checks'][-1]), flush=True)

    original = nm('-g', 'GENERAL.CON-UUID', 'device', 'show', args.interface)
    uuid.UUID(original)  # Refuse an unconnected/unknown restoration target.
    scratch = 'laoji-firmware-http-' + uuid.uuid4().hex[:12]
    watchdog = None
    async with await connect(args.address) as board:
        await prepare(board)
        assert (await board.command('status.get'))['status']['state'] == 'ready'
        before = await files(board)
        meta = (await board.command('recording.get', recording_id=args.recording))['recording']
        previous_offer = None
        if args.rotate_offer:
            previous_offer = (await board.command('transport.wifi.offer'))['wifi_offer']
        offer = (await board.command('transport.wifi.offer'))['wifi_offer']
        if previous_offer:
            assert previous_offer['ssid'] == offer['ssid']
            assert previous_offer['password'] != offer['password']
            assert previous_offer['bearer_token'] != offer['bearer_token']
            check('stable_public_identity_with_rotated_secrets', success=True)
        try:
            # A directed scan avoids relying on a stale 5 GHz scan cache.
            await asyncio.to_thread(nm, 'device', 'wifi', 'rescan', 'ifname', args.interface, 'ssid', offer['ssid'])
            await asyncio.sleep(2)
            visible = await asyncio.to_thread(nm, '-t', '-f', 'SSID', 'device', 'wifi', 'list', 'ifname', args.interface, '--rescan', 'no')
            check('board_ap_visible', visible=offer['ssid'] in visible.splitlines())
            ip_config = ('ipv4.method', 'manual', 'ipv4.addresses', '192.168.4.2/24') if args.static_ip else ('ipv4.method', 'auto')
            await asyncio.to_thread(nm, 'connection', 'add', 'type', 'wifi',
                'con-name', scratch, 'ifname', args.interface, 'ssid', offer['ssid'],
                'connection.autoconnect', 'no', 'ipv4.never-default', 'yes',
                *ip_config, 'ipv6.method', 'disabled', 'wifi-sec.key-mgmt', 'wpa-psk',
                'wifi-sec.psk', offer['password'])
            watchdog = subprocess.Popen([sys.executable, str(Path(__file__).resolve()),
                '--restore-watchdog', original, scratch], stdin=subprocess.DEVNULL,
                stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, start_new_session=True)
            await asyncio.to_thread(nm, 'connection', 'up', 'id', scratch)
            host_ip = await asyncio.to_thread(nm, '-g', 'IP4.ADDRESS', 'device', 'show', args.interface)
            active_uuid = await asyncio.to_thread(nm, '-g', 'GENERAL.CON-UUID', 'device', 'show', args.interface)
            scratch_uuid = await asyncio.to_thread(nm, '-g', 'connection.uuid', 'connection', 'show', scratch)
            check('temporary_wifi_connected', board_subnet=host_ip.startswith('192.168.4.'),
                  profile_matches=active_uuid == scratch_uuid, dhcp_tested=not args.static_ip)
            route = subprocess.run(['ip', '-j', 'route', 'get', '192.168.4.1'], capture_output=True, text=True, check=True)
            report['host_route'] = json.loads(route.stdout)
            url = offer['base_url'] + offer['recording_base_path'] + urllib.parse.quote(meta['recording_id'], safe='')
            auth = offer['bearer_token']

            async def http(method='GET', token=auth, url=url, **headers):
                return await asyncio.to_thread(request, url, token, method, **headers)

            status, headers, data = await http('HEAD')
            assert status == 200 and not data
            assert int(headers['Content-Length']) == meta['file_bytes']
            assert headers['X-Checksum-SHA256'] == meta['checksum_sha256']
            assert headers['X-Checksum-Scope'] == 'audio_payload'
            etag = headers['ETag']
            check('head_exact_length_and_generation', file_bytes=meta['file_bytes'])

            started = time.monotonic()
            status, headers, data = await http(**{'If-Match': etag})
            elapsed = time.monotonic() - started
            assert status == 200 and len(data) == meta['file_bytes']
            assert 'Transfer-Encoding' not in headers
            with wave.open(io.BytesIO(data), 'rb') as wav:
                assert (wav.getnchannels(), wav.getsampwidth(), wav.getframerate()) == (1, 2, 16000)
                pcm = wav.readframes(wav.getnframes())
            assert len(pcm) == meta['audio_bytes']
            assert 'sha256:' + hashlib.sha256(pcm).hexdigest() == meta['checksum_sha256']
            check('full_http_wav_and_pcm_sha', file_bytes=len(data), pcm_bytes=len(pcm),
                  seconds=round(elapsed, 3), mib_per_second=round(len(data) / elapsed / 1048576, 3))

            status, headers, part = await http(**{'Range': 'bytes=1024-5119', 'If-Match': etag})
            assert status == 206 and part == data[1024:5120]
            assert headers['Content-Range'] == f'bytes 1024-5119/{len(data)}'
            status, headers, part = await http(**{'Range': 'bytes=-512'})
            assert status == 206 and part == data[-512:]
            check('range_resume_and_suffix')

            status, headers, part = await http(**{'Range': f'bytes={len(data)}-'})
            assert status == 416 and headers['Content-Range'] == f'bytes */{len(data)}'
            status, _, _ = await http(**{'If-Match': '"wrong-generation"'})
            assert status == 412
            status, auth_headers, _ = await http(token='invalid-token')
            assert status == 401 and auth_headers['WWW-Authenticate'] == 'Bearer'
            if previous_offer:
                status, _, _ = await http(token=previous_offer['bearer_token'])
                assert status == 401
                check('previous_offer_token_revoked')
            status, _, part = await http(url=offer['base_url'] + '/recording/%2e%2e%2fprivate.wav')
            assert status == 400
            check('range_generation_auth_and_traversal_rejected')
            if args.revoke_active:
                ready = threading.Event(); released = threading.Event()
                blocked = asyncio.create_task(asyncio.to_thread(blocked_download, url, auth, ready, released))
                try:
                    assert await asyncio.to_thread(ready.wait, 5), 'No admitted response'
                    await asyncio.sleep(.3)  # response cannot fit its bounded TCP window
                    began = time.monotonic()
                    await board.command('transport.wifi.close')
                    close_seconds = time.monotonic() - began
                    assert close_seconds < 3, close_seconds
                    assert (await board.command('transport.wifi.status'))['wifi']['state'] == 'off'
                    released.set(); received = await blocked
                    assert 0 < received < meta['file_bytes']
                    check('explicit_close_interrupts_blocked_download', seconds=round(close_seconds, 3),
                          partial_bytes=received, partial_not_accepted_as_recording=True)
                finally:
                    released.set()
                    if not blocked.done():
                        try: await asyncio.wait_for(blocked, 5)
                        except (Exception, asyncio.CancelledError): pass
        finally:
            # Restoration precedes closing the AP; never strand this host on it.
            await asyncio.to_thread(restore, original, scratch)
            if watchdog:
                watchdog.terminate()
                watchdog.wait(timeout=3)
            restored = nm('-g', 'GENERAL.CON-UUID', 'device', 'show', args.interface) == original
            check('original_wifi_restored', uuid_matches=restored)
            assert restored
            if board.client.is_connected:
                await board.command('transport.wifi.close')
        while True:
            event = await board.event('transport.wifi.state_changed')
            if event.get('state') == 'off':
                assert event.get('reason') == 'app'
                break
        assert (await board.command('transport.wifi.status'))['wifi']['state'] == 'off'
        assert set(before).issubset(await files(board))
        check('wifi_off_event_and_card_files_preserved')
    check('complete', success=True)


if __name__ == '__main__':
    if len(sys.argv) == 4 and sys.argv[1] == '--restore-watchdog':
        time.sleep(60)
        restore(sys.argv[2], sys.argv[3])
    else:
        parser = argparse.ArgumentParser()
        parser.add_argument('--address', default='7C:4F:AD:BB:38:B2')
        parser.add_argument('--interface', required=True)
        parser.add_argument('--recording', default='20261015_093115.wav')
        parser.add_argument('--static-ip', action='store_true', help='Diagnostic only: does not validate DHCP')
        parser.add_argument('--rotate-offer', action='store_true', help='Verify stable AP identity without reusing credentials')
        parser.add_argument('--revoke-active', action='store_true', help='Close an admitted blocked download; no recording commit')
        parser.add_argument('--output', type=Path, required=True)
        asyncio.run(main(parser.parse_args()))
