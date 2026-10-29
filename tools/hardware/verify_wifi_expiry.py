"""Physical-board regression: an admitted slow download outlives offer expiry.

Reads one explicit existing recording only; no flashing/deletion/recording.
Linux NetworkManager integration, exact connection restoration + watchdog.
No passwords, tokens, SSIDs, file names or audio are written to the report.
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
import urllib.parse
import uuid
import wave
from pathlib import Path

from verify_source_firmware import connect, prepare, files
from verify_source_wifi import nm, restore, request


def slow_download(url, token):
    target = urllib.parse.urlsplit(url)
    with socket.socket() as connection:
        # A bounded receive window ensures this is not just a slow consumer of
        # a response that already finished in the kernel before token expiry.
        connection.setsockopt(socket.SOL_SOCKET, socket.SO_RCVBUF, 16384)
        connection.settimeout(20)
        connection.connect((target.hostname, target.port or 80))
        wire = (f'GET {target.path} HTTP/1.1\r\nHost: {target.hostname}\r\n'
                f'Authorization: Bearer {token}\r\nConnection: close\r\n\r\n')
        began = time.monotonic()
        connection.sendall(wire.encode('ascii'))
        headers = bytearray()
        while not headers.endswith(b'\r\n\r\n'):
            part = connection.recv(1)
            if not part or len(headers) >= 4096:
                raise RuntimeError('Incomplete or oversized response headers')
            headers.extend(part)
        # Header field names/control values are ASCII; recording identifiers
        # are emitted as UTF-8 by the current wire contract. No file-name log.
        rows = headers.decode('utf-8').split('\r\n')
        assert rows[0].split()[1] == '200'
        values = dict(row.split(': ', 1) for row in rows[1:] if ': ' in row)
        length = int(values['Content-Length'])
        if not 256 * 1024 <= length <= 16 * 1024 * 1024:
            raise RuntimeError('Choose a bounded fixture large enough to cross expiry')
        body = bytearray()
        while len(body) < length:
            try:
                part = connection.recv(min(4096, length - len(body)))
            except OSError as error:
                raise RuntimeError(f'Slow download stopped: bytes={len(body)} elapsed_ms={int((time.monotonic()-began)*1000)} type={type(error).__name__}') from None
            if not part:
                raise RuntimeError('Admitted response was truncated')
            body.extend(part)
            time.sleep(.05)
        return bytes(body), time.monotonic() - began


async def main(args):
    report = {'boundary': 'physical board / Linux BLE + throttled Wi-Fi HTTP', 'checks': []}
    args.output.parent.mkdir(parents=True, exist_ok=True)

    def check(case, **fields):
        row = {'case': case, **fields}
        report['checks'].append(row)
        args.output.write_text(json.dumps(report, indent=2) + '\n')
        print(json.dumps(row), flush=True)

    original = nm('-g', 'GENERAL.CON-UUID', 'device', 'show', args.interface)
    uuid.UUID(original)
    scratch = 'laoji-expiry-' + uuid.uuid4().hex[:12]
    watchdog = None
    async with await connect(args.address) as board:
        hello = await prepare(board)
        assert (await board.command('status.get'))['status']['state'] == 'ready'
        before = await files(board)
        meta = (await board.command('recording.get', recording_id=args.recording))['recording']
        offer = (await board.command('transport.wifi.offer'))['wifi_offer']
        check('offer_started', firmware=hello['device']['firmware_revision'],
              duration_ms=offer['expires_in_ms'], file_bytes=meta['file_bytes'])
        try:
            # Keep the ordinary network until close to expiry. This wait is
            # asynchronous so BLE indications continue being acknowledged.
            # Leave enough room for the host's DHCP/association, rather than
            # accidentally testing an expired AP before a request was admitted.
            await asyncio.sleep(max(0, offer['expires_in_ms'] / 1000 - 40))
            await asyncio.to_thread(nm, 'device', 'wifi', 'rescan', 'ifname', args.interface, 'ssid', offer['ssid'])
            await asyncio.to_thread(nm, 'connection', 'add', 'type', 'wifi',
                'con-name', scratch, 'ifname', args.interface, 'ssid', offer['ssid'],
                'connection.autoconnect', 'no', 'ipv4.never-default', 'yes',
                'ipv4.method', 'auto', 'ipv6.method', 'disabled',
                'wifi-sec.key-mgmt', 'wpa-psk', 'wifi-sec.psk', offer['password'])
            watchdog = subprocess.Popen([sys.executable, str(Path(__file__).resolve()),
                '--restore-watchdog', original, scratch], stdin=subprocess.DEVNULL,
                stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, start_new_session=True)
            await asyncio.to_thread(nm, 'connection', 'up', 'id', scratch)
            left = (await board.command('transport.wifi.status'))['wifi']['expires_in_ms']
            if left < 2500:
                raise RuntimeError('Network admission missed; do not count this test')
            await asyncio.sleep((left - 2000) / 1000)
            left = (await board.command('transport.wifi.status'))['wifi']['expires_in_ms']
            assert 500 < left < 2500, left
            url = offer['base_url'] + offer['recording_base_path'] + urllib.parse.quote(meta['recording_id'], safe='')
            pending = asyncio.create_task(asyncio.to_thread(slow_download, url, offer['bearer_token']))
            while not pending.done():
                await asyncio.wait({pending}, timeout=2)
                if not pending.done():
                    status = (await board.command('transport.wifi.status'))['wifi']
                    check('during_slow_download', state=status['state'], expires_in_ms=status['expires_in_ms'])
            body, elapsed = await pending
            assert elapsed > left / 1000 + 3, (elapsed, left)
            assert len(body) == meta['file_bytes']
            with wave.open(io.BytesIO(body), 'rb') as wav:
                assert (wav.getnchannels(), wav.getsampwidth(), wav.getframerate()) == (1, 2, 16000)
                pcm = wav.readframes(wav.getnframes())
            assert len(pcm) == meta['audio_bytes']
            assert 'sha256:' + hashlib.sha256(pcm).hexdigest() == meta['checksum_sha256']
            check('admitted_download_survives_expiry', left_at_start_ms=left,
                  seconds=round(elapsed, 3), bytes=len(body), pcm_sha_match=True)
            # The old token can no longer admit another request, whether the AP
            # has already closed or its periodic expiry is about to run.
            try:
                status, _, _ = await asyncio.to_thread(request, url, offer['bearer_token'], 'HEAD')
                assert status == 401, status
                rejected = 'unauthorized'
            except (OSError, TimeoutError):
                rejected = 'connection_closed'
            check('expired_token_cannot_start_new_request', outcome=rejected)
            for _ in range(5):
                state = (await board.command('transport.wifi.status'))['wifi']['state']
                if state == 'off':
                    break
                await asyncio.sleep(.5)
            assert state == 'off'
            check('idle_ap_closed_after_request')
        finally:
            await asyncio.to_thread(restore, original, scratch)
            if watchdog:
                watchdog.terminate(); watchdog.wait(timeout=3)
            restored = nm('-g', 'GENERAL.CON-UUID', 'device', 'show', args.interface) == original
            check('original_wifi_restored', matches=restored)
            assert restored
            if board.client.is_connected:
                await board.command('transport.wifi.close')
        assert set(before).issubset(await files(board))
        check('original_card_files_preserved', count=len(before))
    check('complete', success=True)


if __name__ == '__main__':
    if len(sys.argv) == 4 and sys.argv[1] == '--restore-watchdog':
        time.sleep(75)
        restore(sys.argv[2], sys.argv[3])
    else:
        p = argparse.ArgumentParser()
        p.add_argument('--address', default='7C:4F:AD:BB:38:B2')
        p.add_argument('--interface', required=True)
        p.add_argument('--recording', required=True)
        p.add_argument('--output', type=Path, required=True)
        asyncio.run(main(p.parse_args()))
