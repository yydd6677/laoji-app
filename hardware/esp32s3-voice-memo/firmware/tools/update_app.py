"""Guarded updates after migration to source firmware (Linux/Windows).

Requires an idle board and the exact currently deployed SDK application image.
Reads its own fresh partition/app backup, never accepts an old readback as proof
of current state. Only the authorized prototype's factory app can be erased.
The first migration from donor firmware remains owned by flash_app.py.
"""
import argparse
import hashlib
import json
import lzma
import os
import struct
import subprocess
import sys
import tempfile
import time
from pathlib import Path

MAC = '7c:4f:ad:bb:38:b0'
OFFSET = 0x10000
SIZE = 0x3e8000


def sha(data):
    return hashlib.sha256(data).hexdigest()


def validate(head, app, baseline, candidate):
    if len(head) != OFFSET or len(app) != SIZE:
        raise ValueError('Incomplete current readback')
    factory = []
    for at in range(0x8000, 0x8c00, 32):
        magic, kind, subtype, offset, size = struct.unpack_from('<HBBII', head, at)
        if magic in (0xffff, 0xebeb):
            break
        if magic != 0x50aa:
            raise ValueError('Invalid current partition table')
        if kind == 0 and subtype == 0:
            factory.append((offset, size))
    if factory != [(OFFSET, SIZE)]:
        raise ValueError('Factory layout differs from authorized prototype')
    for image in (baseline, candidate):
        if len(image) < 80 or len(image) > SIZE or image[0] != 0xe9 or struct.unpack_from('<H', image, 12)[0] != 9 or struct.unpack_from('<I', image, 0x20)[0] != 0xabcd5432:
            raise ValueError('Expected a bounded ESP-IDF source application image')
    if app[:len(baseline)] != baseline or any(byte != 255 for byte in app[len(baseline):]):
        raise ValueError('Current factory contents do not match exact supplied baseline')


def main():
    p = argparse.ArgumentParser()
    p.add_argument('--port', required=True)
    p.add_argument('--baseline-image', type=Path, required=True)
    p.add_argument('--image', type=Path, required=True)
    p.add_argument('--evidence', type=Path, required=True)
    p.add_argument('--write', action='store_true')
    a = p.parse_args()
    candidate, baseline = a.image.read_bytes(), a.baseline_image.read_bytes()
    a.evidence.mkdir(parents=True, exist_ok=True)
    private = Path.home() / '.local/state/laoji-hardware/updates' / time.strftime('%Y%m%d-%H%M%S')
    private.mkdir(parents=True, exist_ok=False)
    if os.name != 'nt':
        private.chmod(0o700)
    manifest = {'candidate_sha256': sha(candidate), 'baseline_sha256': sha(baseline),
                'offset': OFFSET, 'size': SIZE, 'written': False, 'rolled_back': False,
                'never_written_or_erased': ['bootloader', 'partition-table', 'NVS', 'PHY', 'storage', 'eFuse', 'SD-card']}
    base = [sys.executable, '-m', 'esptool', '--chip', 'esp32s3', '--port', a.port, '--baud', '921600']

    def run(*args, reset=False):
        result = subprocess.run(base + ['--after', 'hard_reset' if reset else 'no_reset', *args],
                                capture_output=True, text=True, timeout=150)
        if result.returncode:
            # SDK errors contain paths, not application credentials or SD data.
            raise RuntimeError(result.stdout[-1500:] + result.stderr[-1500:])
        return result.stdout

    def save():
        (a.evidence / 'update-manifest.json').write_text(json.dumps(manifest, indent=2) + '\n')

    print('Checking authorized board and fresh factory readback', flush=True)
    identity = run('read_mac')
    if MAC not in identity.lower():
        run('read_mac', reset=True)
        raise SystemExit('Unexpected hardware MAC; no write performed')
    with tempfile.TemporaryDirectory(prefix='laoji-source-update-') as temp:
        root = Path(temp); head_file = root / 'head.bin'; app_file = root / 'factory.bin'; image_file = root / 'candidate.bin'
        image_file.write_bytes(candidate)
        erase_started = False
        try:
            run('read_flash', '0', hex(OFFSET), str(head_file))
            run('read_flash', hex(OFFSET), hex(SIZE), str(app_file))
            head, app = head_file.read_bytes(), app_file.read_bytes()
            validate(head, app, baseline, candidate)
            backup = private / 'factory.bin.xz'
            backup.write_bytes(lzma.compress(app))
            assert lzma.decompress(backup.read_bytes()) == app
            manifest.update(factory_sha256=sha(app), backup=str(backup),
                            boot_table_sha256=sha(head[:0x9000]), phy_sha256=sha(head[0xf000:OFFSET]))
            save()
            print('Fresh baseline and compressed rollback verified', flush=True)
            if a.write:
                erase_started = True
                run('erase_region', hex(OFFSET), hex(SIZE))
                run('write_flash', hex(OFFSET), str(image_file))
                run('verify_flash', hex(OFFSET), str(image_file))
                run('read_flash', '0', hex(OFFSET), str(head_file))
                after = head_file.read_bytes()
                if after[:0x9000] != head[:0x9000] or after[0xf000:OFFSET] != head[0xf000:OFFSET]:
                    raise RuntimeError('Preserved boot/table/PHY readback differs')
                manifest.update(written=True, preserved_head_verified=True)
                save(); print('Factory app written and verified; boot/table/PHY unchanged', flush=True)
        except BaseException:
            if erase_started:
                print('Update failed; restoring exact pre-update factory app', flush=True)
                run('erase_region', hex(OFFSET), hex(SIZE))
                run('write_flash', hex(OFFSET), str(app_file))
                run('verify_flash', hex(OFFSET), str(app_file))
                manifest.update(written=False, rolled_back=True); save()
            raise
        finally:
            run('read_mac', reset=True)
    print(json.dumps(manifest, indent=2), flush=True)


if __name__ == '__main__':
    main()
