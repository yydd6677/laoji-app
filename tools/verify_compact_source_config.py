#!/usr/bin/env python3
"""Static gate for the compact LaoJi mobile endpoint contract.

This deliberately inspects only build inputs and application source. Historical
reports and archived quality fixtures may still mention retired endpoints and
are not part of the APK runtime contract.
"""

from __future__ import annotations

import argparse
from pathlib import Path
import re
import sys


EXPECTED_BASE = "https://laoji.cloud"
EXPECTED_WSS = "wss://laoji.cloud"
LEGACY_MARKERS = (
    "18035",
    "183.36.243.124",
    "21436",
    "8002",
    "11434",
    "21435",
    "EXPO_PUBLIC_MEETING_API_BASE",
    "EXPO_PUBLIC_REALTIME_ASR_HOST",
    "EXPO_PUBLIC_REALTIME_ASR_PORT",
)


def _read(path: Path) -> str:
    return path.read_text(encoding="utf-8")


def verify(root: Path) -> list[str]:
    failures: list[str] = []
    app_config = root / "app.config.js"
    eas = root / "eas.json"
    env_example = root / ".env.example"
    config_ts = root / "src/services/config.ts"

    required = (app_config, eas, env_example, config_ts)
    for path in required:
        if not path.is_file():
            failures.append(f"缺少统一入口文件: {path.relative_to(root)}")
    if failures:
        return failures

    app_text = _read(app_config)
    eas_text = _read(eas)
    env_text = _read(env_example)
    config_text = _read(config_ts)

    if EXPECTED_BASE not in app_text:
        failures.append("app.config.js 未声明 laoji.cloud 默认入口")
    if EXPECTED_BASE not in config_text:
        failures.append("src/services/config.ts 未声明 laoji.cloud 默认入口")
    if env_text.count("EXPO_PUBLIC_API_BASE=") != 1:
        failures.append(".env.example 必须只有一个 EXPO_PUBLIC_API_BASE")
    elif "EXPO_PUBLIC_API_BASE=" + EXPECTED_BASE not in env_text:
        failures.append(".env.example 的 API 基址不是 laoji.cloud")

    # Every EAS profile must inject the same base; no profile may silently
    # rebuild an APK against a historical loopback or server-IP endpoint.
    profile_count = len(re.findall(r'"EXPO_PUBLIC_API_BASE"\s*:\s*"([^"]+)"', eas_text))
    if profile_count != 3:
        failures.append(f"eas.json 应为 3 个 profile 注入统一 API 基址，实际 {profile_count} 个")
    elif eas_text.count('"EXPO_PUBLIC_API_BASE": "' + EXPECTED_BASE + '"') != 3:
        failures.append("eas.json 存在未指向 laoji.cloud 的构建 profile")

    if "apiBase}/api/location/reverse" not in app_text:
        failures.append("app.config.js 未由统一 API 基址派生逆地理编码地址")
    if "parsed.protocol = 'wss:'" not in config_text or "parsed.protocol = 'ws:'" not in config_text:
        failures.append("实时 ASR 地址未从统一 API 基址派生 WS/WSS")
    if "reverseGeocoderUrl: apiBase ? `${apiBase}/api/location/reverse` : ''" not in config_text:
        failures.append("运行时配置未由统一 API 基址派生 reverseGeocoderUrl")

    # Only build/runtime inputs are scanned. Exclude generated/cache paths and
    # documentation, where retired endpoints are intentionally retained as
    # migration evidence.
    scan_files = [app_config, eas, env_example, config_ts]
    scan_files.extend((root / "src").rglob("*.ts"))
    scan_files.extend((root / "src").rglob("*.tsx"))
    for path in sorted(set(scan_files)):
        if any(part in {"node_modules", ".expo", "__tests__", "__mocks__"} for part in path.parts):
            continue
        text = _read(path)
        for marker in LEGACY_MARKERS:
            if marker in text:
                failures.append(f"{path.relative_to(root)} 包含已退役入口标记: {marker}")

    # Config source must not contain a second hard-coded production base.
    base_literals = re.findall(r"https?://[^'\"`\s)]+", config_text)
    unexpected = sorted({value.rstrip(".,") for value in base_literals if value.rstrip(".,") != EXPECTED_BASE})
    if unexpected:
        failures.append("运行时配置包含额外硬编码服务地址: " + ", ".join(unexpected))

    return failures


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("root", nargs="?", type=Path, default=Path(__file__).resolve().parents[1])
    args = parser.parse_args()
    root = args.root.resolve()
    failures = verify(root)
    if failures:
        for failure in failures:
            print(f"FAIL: {failure}", file=sys.stderr)
        return 1
    print(f"PASS: 移动端源码统一使用 {EXPECTED_BASE}，实时入口派生为 {EXPECTED_WSS}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
