#!/usr/bin/env python3
"""Verify that a LaoJi APK carries the compact production endpoint contract."""

from __future__ import annotations

import argparse
import json
from pathlib import Path
import sys
import zipfile


EXPECTED_API_BASE = "https://laoji.cloud"
EXPECTED_ENABLED_FLAGS = (
    "localMeetingDbV1",
    "localMeetingDbCanonicalReadV1",
    "localMeetingDbCanonicalWriteV1",
    "mediaUploadV2Candidate",
    "meetingQuestionsQ2Candidate",
    "meetingSummarySourceStreamCandidate",
    "nativeProjectionEnvelopeCandidate",
    "realtimeAsrV2Candidate",
    "scheduleGraphV2Candidate",
)
EXPECTED_DISABLED_FLAGS = (
    "localMeetingDbLegacyProjectionWriteV1",
    "localMeetingDbAccountRootWriteV1",
    "localMeetingDbAccountUploadWriteV1",
    "meetingQuestionsV1",
    "meetingAttachmentSyncV1",
    "meetingMarkerSyncV1",
    "meetingSummarySyncV1",
    "meetingTagSyncV1",
)
LEGACY_MARKERS = (
    "18035",
    "21436",
    "183.36.243.124",
    "laojiApiBase",
    "meetingApiBase",
    "realtimeAsrHost",
    "realtimeAsrPort",
)


def verify(apk: Path) -> list[str]:
    failures: list[str] = []
    try:
        with zipfile.ZipFile(apk) as archive:
            raw = archive.read("assets/app.config")
    except (OSError, KeyError, zipfile.BadZipFile) as exc:
        return [f"无法读取 APK 配置: {exc}"]

    try:
        config = json.loads(raw)
    except json.JSONDecodeError as exc:
        return [f"APK 配置不是有效 JSON: {exc}"]
    extra = config.get("extra") if isinstance(config, dict) else None
    if not isinstance(extra, dict):
        return ["APK 缺少 extra 配置"]

    if config.get("android", {}).get("package") != "com.laoji.app":
        failures.append("Android 包名不是 com.laoji.app")
    if extra.get("appEnv") != "production":
        failures.append(f"appEnv 不是 production: {extra.get('appEnv')!r}")
    if extra.get("apiBase") != EXPECTED_API_BASE:
        failures.append(f"apiBase 不是 {EXPECTED_API_BASE}: {extra.get('apiBase')!r}")
    bootstrap_key = extra.get("deviceBootstrapKey")
    if not isinstance(bootstrap_key, str) or len(bootstrap_key.strip()) < 32:
        failures.append("APK 缺少有效的设备注册引导密钥；新安装设备无法注册")
    for key in ("reverseGeocoderUrl", "privacyPolicyUrl", "termsOfServiceUrl", "accountDeletionUrl"):
        value = extra.get(key)
        if not isinstance(value, str) or not value.startswith(EXPECTED_API_BASE):
            failures.append(f"{key} 不是同域 HTTPS 地址: {value!r}")

    feature_flags = extra.get("featureFlags")
    if not isinstance(feature_flags, dict):
        failures.append("APK 缺少 featureFlags 配置")
    else:
        for name in EXPECTED_ENABLED_FLAGS:
            if feature_flags.get(name) is not True:
                failures.append(f"vNext 生产开关未启用: {name}")
        for name in EXPECTED_DISABLED_FLAGS:
            if feature_flags.get(name) is not False:
                failures.append(f"旧生产写入开关未关闭: {name}")

    serialized = raw.decode("utf-8", errors="replace")
    for marker in LEGACY_MARKERS:
        if marker in serialized:
            failures.append(f"包含旧生产配置标记: {marker}")
    return failures


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("apk", type=Path)
    args = parser.parse_args()
    failures = verify(args.apk)
    if failures:
        for failure in failures:
            print(f"FAIL: {failure}", file=sys.stderr)
        return 1
    print(f"PASS: {args.apk} 使用 {EXPECTED_API_BASE} 的 vNext 生产配置")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
