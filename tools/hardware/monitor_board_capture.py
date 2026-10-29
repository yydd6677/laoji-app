"""Passive finite USB-console capture; no bytes, reset or flash commands sent.

Run before a BLE probe, after a verified idle app-only update. The raw console
is private evidence. Only aggregate recording diagnostics are echoed.
"""
import argparse
import time
from pathlib import Path

import serial


def main(args):
    args.output.parent.mkdir(parents=True, exist_ok=True)
    stream = serial.Serial(port=None, baudrate=115200, timeout=.25)
    stream.dtr = False
    stream.rts = False
    stream.port = args.port
    stream.open()
    pending = b''
    try:
        with args.output.open('wb') as output:
            deadline = time.monotonic() + args.seconds
            print('Passive console open', flush=True)
            while time.monotonic() < deadline:
                data = stream.read(4096)
                if not data:
                    continue
                output.write(data); output.flush(); pending += data
                while b'\n' in pending:
                    line, pending = pending.split(b'\n', 1)
                    if any(tag in line for tag in (b'input_failure', b'capture: finalized', b'capture: io_summary')):
                        print(line.decode(errors='replace').strip(), flush=True)
                pending = pending[-8192:]
    finally:
        stream.close()


if __name__ == '__main__':
    parser = argparse.ArgumentParser(); parser.add_argument('--port', required=True)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--seconds', type=float, default=240)
    args = parser.parse_args(); assert 1 <= args.seconds <= 1200
    main(args)
