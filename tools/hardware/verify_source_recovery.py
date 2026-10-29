"""Abrupt-reset recovery using a recording created by this diagnostic only."""
import argparse
import asyncio
import hashlib
import json
import time
import uuid
from pathlib import Path
from verify_source_firmware import connect, prepare, files


async def main(a):
    a.output.mkdir(parents=True, exist_ok=True)
    async with await connect(a.address) as b:
        await prepare(b)
        initial = await files(b)
        assert (await b.command('status.get'))['status']['state'] == 'ready'
        sid = 'source-reset-' + uuid.uuid4().hex
        await b.command('capture.start', session_id=sid, audio={'codec': 'pcm_s16le', 'sample_rate_hz': 16000, 'channels': 1, 'live_stream': False})
        started = await b.event('capture.started')
        await asyncio.sleep(2.5)
    # Enter ROM and read the public MAC, then reset. No flash writes/erases.
    p = await asyncio.create_subprocess_exec(a.esptool_python, '-m', 'esptool', '--chip', 'esp32s3', '--port', a.port,
                                            '--after', 'hard_reset', 'read_mac', stdout=asyncio.subprocess.PIPE,
                                            stderr=asyncio.subprocess.STDOUT)
    out, _ = await p.communicate()
    (a.output / 'reset-read-mac.log').write_bytes(out)
    assert p.returncode == 0
    await asyncio.sleep(2)
    async with await connect(a.address) as b:
        await prepare(b)
        state = (await b.command('status.get'))['status']
        assert state['state'] == 'ready', state
        after = await files(b)
        recovered = 'RECOVERED_' + started['recording_id']
        assert recovered in after, (recovered, after)
        m = (await b.command('recording.get', recording_id=recovered))['recording']
        assert m['recovered'] and m['audio_bytes'] >= 32000
        pcm = await b.read(m)
        assert 'sha256:' + hashlib.sha256(pcm).hexdigest() == m['checksum_sha256']
        await b.command('recording.delete', recording_id=recovered, expected_generation=m['generation'])
        assert set(initial).issubset(await files(b))
        result = {'case': 'abrupt_reset_during_own_recording', 'success': True, 'recovered_audio_bytes': len(pcm),
                  'original_files_preserved': len(initial), 'scope': 'real board reset, not power-cut or Android'}
        (a.output / 'results.json').write_text(json.dumps(result, indent=2) + '\n')
        print(json.dumps(result), flush=True)
        if a.expiry:
            offer = (await b.command('transport.wifi.offer'))['wifi_offer']
            print(json.dumps({'case': 'waiting_actual_wifi_expiry', 'seconds': offer['expires_in_ms'] / 1000 + 2}), flush=True)
            await asyncio.sleep(offer['expires_in_ms'] / 1000 + 2)
            assert (await b.command('transport.wifi.status'))['wifi']['state'] == 'off'
            newer = (await b.command('transport.wifi.offer'))['wifi_offer']
            assert newer['bearer_token'] != offer['bearer_token'] and newer['password'] != offer['password']
            await b.command('transport.wifi.close')
            result['wifi_expiry_and_credential_rotation'] = True
            (a.output / 'results.json').write_text(json.dumps(result, indent=2) + '\n')
            print(json.dumps({'case': 'actual_wifi_expiry_and_credential_rotation', 'success': True}), flush=True)


if __name__ == '__main__':
    p = argparse.ArgumentParser()
    p.add_argument('--address', default='7C:4F:AD:BB:38:B2')
    p.add_argument('--port', required=True)
    p.add_argument('--esptool-python', required=True)
    p.add_argument('--output', type=Path, required=True)
    p.add_argument('--expiry', action='store_true')
    asyncio.run(main(p.parse_args()))
