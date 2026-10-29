"""Portable, app-only flashing. Requires a complete pre-rewrite flash backup.

Never call idf.py flash for this board: that also writes bootloader/partitions.
Use this with the Python environment installed by ESP-IDF 5.5.1.
"""
import argparse
import hashlib
import json
from pathlib import Path
import struct
import subprocess
import sys


def digest(data):
    return hashlib.sha256(data).hexdigest()


def main():
    p = argparse.ArgumentParser()
    p.add_argument('--port', required=True)
    p.add_argument('--backup', required=True, type=Path)
    p.add_argument('--image', type=Path, default=Path(__file__).resolve().parents[1] / 'build/laoji_recorder.bin')
    p.add_argument('--evidence', type=Path, required=True)
    p.add_argument('--write', action='store_true', help='Without this flag only validate files and partition bounds')
    p.add_argument('--erase-application', action='store_true', help='With --write, clear the entire factory app range before replacement; never erase_chip')
    a = p.parse_args()
    backup, image = a.backup.read_bytes(), a.image.read_bytes()
    if len(backup) != 8 * 1024 * 1024 or not image or image[0] != 0xE9:
        raise SystemExit('Require 8 MiB backup and valid ESP image')
    factory = None
    parts = []
    for at in range(0x8000, 0x8C00, 32):
        magic, kind, subtype, offset, size, label, flags = struct.unpack_from('<HBBII16sI', backup, at)
        if magic == 0xFFFF or magic == 0xEBEB:
            break
        if magic != 0x50AA:
            raise SystemExit('Invalid existing partition table')
        part = dict(type=kind, subtype=subtype, offset=offset, size=size, label=label.rstrip(b'\0').decode(), flags=flags)
        parts.append(part)
        if kind == 0 and subtype == 0:
            factory = part
    if not factory or factory['offset'] != 0x10000 or len(image) > factory['size']:
        raise SystemExit('Existing factory partition does not fit image')
    # Current readback must identify the tested board baseline, not another board.
    old = backup[0x10000:0x10000 + 2044864]
    if digest(old) != '91ffc6cb224556b9a48bdd323541295f0516d14a6620719d0484eebe7a2aaefb':
        raise SystemExit('Backup application differs from the verified hw5 baseline; review before writing')
    a.evidence.mkdir(parents=True, exist_ok=True)
    manifest = dict(backup_sha256=digest(backup), backup_bytes=len(backup), image_sha256=digest(image),
                    image_bytes=len(image), application_offset=0x10000, partitions=parts,
                    preserved=['bootloader', 'partition-table', 'phy_init', 'storage'],
                    never_addressed=['eFuse', 'SD-card'], nvs_explicit_erase_or_write=False)
    (a.evidence / 'flash-manifest.json').write_text(json.dumps(manifest, indent=2) + '\n')
    print(json.dumps(manifest, indent=2))
    if not a.write:
        return
    base = [sys.executable, '-m', 'esptool', '--chip', 'esp32s3', '--port', a.port, '--baud', '921600']
    identity = subprocess.run(base + ['--after', 'no_reset', 'read_mac'], capture_output=True, text=True, check=True)
    if '7c:4f:ad:bb:38:b0' not in identity.stdout.lower():
        raise SystemExit('Connected board MAC differs from the authorized prototype')
    if a.erase_application:
        subprocess.run(base + ['--after', 'no_reset', 'erase_region', hex(factory['offset']), hex(factory['size'])], check=True)
    manifest['entire_factory_replaced'] = a.erase_application
    # Image data copied from SDK build output, no instruction patching or donor image.
    subprocess.run(base + ['--after', 'no_reset', 'write_flash', '0x10000', str(a.image)], check=True)
    subprocess.run(base + ['--after', 'no_reset', 'verify_flash', '0x10000', str(a.image)], check=True)
    head = a.evidence / 'preserved-head-readback.bin'
    subprocess.run(base + ['--after', 'hard_reset', 'read_flash', '0', '0x10000', str(head)], check=True)
    after = head.read_bytes()
    if after[:0x9000] != backup[:0x9000] or after[0xF000:0x10000] != backup[0xF000:0x10000]:
        raise SystemExit('Bootloader/partition/PHY partition differs; STOP and inspect, do not erase')
    # SDK startup between ROM invocations may legitimately refresh NVS RF cal_data.
    # Keep both snapshots and report it; do not restore NVS over a running new SDK.
    manifest['runtime_nvs_changed'] = after[0x9000:0xF000] != backup[0x9000:0xF000]
    (a.evidence / 'flash-manifest.json').write_text(json.dumps(manifest, indent=2) + '\n')
    print('Application verified; original bootloader/table/PHY unchanged; SD/eFuse never addressed; NVS erase never issued')


if __name__ == '__main__':
    main()
