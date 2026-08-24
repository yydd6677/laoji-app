#!/usr/bin/env python3
"""Verify that a LaoJi APK carries the compact production endpoint contract."""

from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import zipfile


EXPECTED_API_BASE = "https://laoji.cloud"
# Direct APK updates can only preserve on-device data when Android accepts the
# new package as the same signer. This is the certificate used by every public
# LaoJi APK through 1.1.61; changing it requires an explicit signing-lineage or
# store migration, never an incidental local build setting.
EXPECTED_SIGNER_SHA256 = "fac61745dc0903786fb9ede62a962b399f7348f0bb6f899b8332667591033b9c"
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


def _apksigner() -> Path | None:
    direct = shutil.which("apksigner")
    if direct:
        return Path(direct)
    for name in ("ANDROID_HOME", "ANDROID_SDK_ROOT"):
        root = os.environ.get(name, "").strip()
        if not root:
            continue
        candidates = sorted((Path(root) / "build-tools").glob("*/apksigner"), reverse=True)
        if candidates:
            return candidates[0]
    return None


def _verify_signer(apk: Path) -> list[str]:
    signer = _apksigner()
    if signer is None:
        return ["找不到 apksigner，无法验证 APK 更新签名连续性"]
    result = subprocess.run(
        [str(signer), "verify", "--print-certs", str(apk)],
        check=False,
        capture_output=True,
        text=True,
    )
    if result.returncode != 0:
        return [f"APK 签名验证失败: {(result.stderr or result.stdout).strip()}"]
    match = re.search(r"Signer #1 certificate SHA-256 digest:\s*([0-9a-fA-F]+)", result.stdout)
    if match is None:
        return ["APK 签名输出缺少 SHA-256 证书摘要"]
    digest = match.group(1).lower()
    if digest != EXPECTED_SIGNER_SHA256:
        return [
            "APK 签名与已发布更新链不一致；覆盖安装会失败或要求清空本机数据: "
            f"{digest}"
        ]
    return []


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
    failures.extend(_verify_signer(apk))
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
