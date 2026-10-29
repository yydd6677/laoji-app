"""Capture USB Serial/JTAG boot without flashing or sending application commands."""
import argparse
import time
import serial
from esptool.reset import HardReset

p = argparse.ArgumentParser()
p.add_argument('--port', required=True)
p.add_argument('--seconds', type=float, default=10)
p.add_argument('--reset', action='store_true')
a = p.parse_args()
with serial.Serial(a.port, 115200, timeout=0.2) as s:
    if a.reset:
        HardReset(s, uses_usb=True)()
    end = time.monotonic() + a.seconds
    while time.monotonic() < end:
        data = s.read(8192)
        if data:
            print(data.decode('utf-8', errors='replace'), end='', flush=True)
