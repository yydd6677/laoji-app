"""Fresh accessibility inspection/actions; phone requires an explicit serial."""
import argparse
import json
import re
import subprocess
import time
from xml.etree import ElementTree as ET

serial = 'emulator-5562'


def adb(*args):
    return subprocess.run(["adb", "-s", serial, *args], check=True,
                          capture_output=True, timeout=22)


def nodes():
    path = f"/sdcard/laoji-hw-test-{time.monotonic_ns()}.xml"
    try:
        result = adb("shell", "uiautomator", "dump", path)
        if b"ERROR:" in result.stdout + result.stderr:
            raise RuntimeError("fresh UI unavailable")
        return list(ET.fromstring(adb("exec-out", "cat", path).stdout).iter("node"))
    finally:
        adb("shell", "rm", "-f", path)


if __name__ == "__main__":
    p = argparse.ArgumentParser()
    p.add_argument("--text")
    p.add_argument("--desc")
    p.add_argument("--id")
    p.add_argument("--serial", default='emulator-5562')
    p.add_argument("--wait-ms", type=int, default=0)
    a = p.parse_args()
    serial = a.serial
    if serial == 'emulator-5560':
        raise ValueError('5560 belongs to another project')
    if not 0 <= a.wait_ms <= 15000:
        raise ValueError('wait must be 0..15000 milliseconds')
    deadline = time.monotonic() + a.wait_ms / 1000
    all_nodes = []
    if a.text or a.desc or a.id:
        while True:
            try:
                all_nodes = nodes()
            except RuntimeError:
                if time.monotonic() >= deadline:
                    raise
                continue
            matches = [n for n in all_nodes if n.get("enabled") == "true" and (
                (a.text and n.get("text") == a.text) or (a.desc and n.get("content-desc") == a.desc)
                or (a.id and n.get("resource-id") == a.id))]
            if matches or time.monotonic() >= deadline:
                break
            time.sleep(0.1)
        if len(matches) != 1:
            raise ValueError(f"need unique enabled target, found {len(matches)}")
        n = matches[0]
        x1, y1, x2, y2 = map(int, re.findall(r"\d+", n.get("bounds")))
        adb("shell", "input", "tap", str((x1+x2)//2), str((y1+y2)//2))
        print(json.dumps({"tapped": n.attrib}, ensure_ascii=False))
    else:
        all_nodes = nodes()
        for n in all_nodes:
            if n.get("text") or n.get("content-desc") or n.get("clickable") == "true":
                print(json.dumps({k: n.get(k) for k in ("text", "content-desc", "resource-id", "bounds", "enabled")}, ensure_ascii=False))
