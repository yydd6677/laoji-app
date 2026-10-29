"""Copy one authorized board recording over BLE; verify before measuring PCM."""
import argparse
import asyncio
import hashlib
import json
import math
import struct
import wave
from pathlib import Path
from bleak import BleakScanner
from board13_probe import Board


async def main(a):
    device = await BleakScanner.find_device_by_address(a.address, timeout=15)
    if not device:
        raise RuntimeError('Disconnect the phone from the board first')
    a.output.mkdir(parents=True, exist_ok=True)
    async with Board(device) as b:
        await b.command('hello', app={'name': 'audio-audit', 'version': '1'},
                        supported_protocols=[{'major': 1, 'minor': 3}], transports=['ble'])
        meta = (await b.command('recording.get', recording_id=a.recording))['recording']
        start = int(a.start * 16000) * 2
        end = meta['audio_bytes'] if a.seconds is None else min(meta['audio_bytes'], start + int(a.seconds * 16000) * 2)
        if start < 0 or end <= start or end > meta['audio_bytes']:
            raise ValueError('Invalid source range')
        pieces = []
        for offset in range(start, end, 256 * 1024):
            pieces.append(await b.read(meta, offset=offset, length=min(256 * 1024, end - offset)))
        data = b''.join(pieces)
        full = start == 0 and end == meta['audio_bytes']
        if full:
            assert 'sha256:' + hashlib.sha256(data).hexdigest() == meta['checksum_sha256']
    with wave.open(str(a.output / ('source.wav' if full else 'source-excerpt.wav')), 'wb') as f:
        f.setnchannels(1); f.setsampwidth(2); f.setframerate(16000); f.writeframes(data)
    windows = []
    for at in range(0, len(data), 32000):
        values = struct.unpack('<' + 'h' * (len(data[at:at+32000]) // 2), data[at:at+32000])
        rms = math.sqrt(sum(v*v for v in values) / max(1, len(values)))
        windows.append({'second': (start + at) / 32000, 'rms': round(rms, 2),
                        'peak': max(map(abs, values), default=0), 'distinct_samples': len(set(values))})
    report = {'boundary': 'real SD recording, copied via Linux BLE', 'source': meta,
              'sha_verified': True if full else None, 'source_range': [start, end], 'windows': windows}
    (a.output / 'audio-audit.json').write_text(json.dumps(report, ensure_ascii=False, indent=2))
    print(json.dumps({'sha_verified': True if full else None, 'audio_bytes': len(data),
                      'loudest_windows': sorted(windows, key=lambda w: w['rms'], reverse=True)[:10]}))


if __name__ == '__main__':
    p = argparse.ArgumentParser()
    p.add_argument('--address', default='7C:4F:AD:BB:38:B2')
    p.add_argument('--recording', required=True)
    p.add_argument('--start', type=float, default=0)
    p.add_argument('--seconds', type=float)
    p.add_argument('--output', required=True, type=Path)
    asyncio.run(main(p.parse_args()))
