#!/usr/bin/env python3
"""Verify that a LaoJi APK carries the compact production endpoint contract."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import zipfile


EXPECTED_API_BASE = "https://laoji.cloud"
EXPECTED_RELEASE_ABIS = ("arm64-v8a",)
# Ionicons, the tiny Material date/time number font, and one common-Chinese
# subset for each of LaoJi's four themes. Android resource shrinking renames
# packaged font files, so the release contract verifies the exact count while
# the source-side font manifest verifies identity and hashes.
EXPECTED_BUNDLED_FONT_COUNT = 6
EXPECTED_THEME_FONTS = {
    "neutral": "LaojiThemeNeutral",
    "vivid": "LaojiThemeVivid",
    "paper": "LaojiThemePaper",
    "midnight": "LaojiThemeMidnight",
}
# Direct APK updates can only preserve on-device data when Android accepts the
# new package as the same signer. This is the certificate used by every public
# LaoJi APK through 1.1.61; changing it requires an explicit signing-lineage or
# store migration, never an incidental local build setting.
EXPECTED_SIGNER_SHA256 = "fac61745dc0903786fb9ede62a962b399f7348f0bb6f899b8332667591033b9c"
LEGACY_MARKERS = (
    "18035",
    "21436",
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


def _aapt() -> Path | None:
    direct = shutil.which("aapt")
    if direct:
        return Path(direct)
    for name in ("ANDROID_HOME", "ANDROID_SDK_ROOT"):
        root = os.environ.get(name, "").strip()
        if not root:
            continue
        candidates = sorted((Path(root) / "build-tools").glob("*/aapt"), reverse=True)
        if candidates:
            return candidates[0]
    return None


def _verify_native_version(apk: Path, config: dict[str, object]) -> list[str]:
    aapt = _aapt()
    if aapt is None:
        return ["找不到 aapt，无法验证 APK 原生版本"]
    result = subprocess.run(
        [str(aapt), "dump", "badging", str(apk)],
        check=False,
        capture_output=True,
        text=True,
    )
    if result.returncode != 0:
        return [f"APK 版本读取失败: {(result.stderr or result.stdout).strip()}"]
    package = re.search(
        r"^package: name='([^']+)' versionCode='([^']+)' versionName='([^']+)'",
        result.stdout,
        re.MULTILINE,
    )
    if package is None:
        return ["APK 原生清单缺少版本信息"]
    failures: list[str] = []
    native_package, native_code, native_name = package.groups()
    android = config.get("android")
    config_code = android.get("versionCode") if isinstance(android, dict) else None
    config_name = config.get("version")
    if native_package != "com.laoji.app":
        failures.append(f"APK 原生包名不正确: {native_package!r}")
    if str(config_code) != native_code:
        failures.append(
            f"APK 原生 versionCode {native_code!r} 与 Expo 配置 {config_code!r} 不一致"
        )
    if str(config_name) != native_name:
        failures.append(
            f"APK 原生 versionName {native_name!r} 与 Expo 配置 {config_name!r} 不一致"
        )
    return failures


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


def _verify_packaged_resources(archive: zipfile.ZipFile) -> list[str]:
    """Keep public APKs phone-specific and free of unused icon families."""

    failures: list[str] = []
    native_abis = sorted(
        {
            name.split("/", 2)[1]
            for name in archive.namelist()
            if name.startswith("lib/") and name.count("/") >= 2
        }
    )
    if tuple(native_abis) != EXPECTED_RELEASE_ABIS:
        failures.append(
            "正式 APK 只能包含 arm64-v8a，实际 ABI 为: "
            + (", ".join(native_abis) if native_abis else "无")
        )

    font_files = sorted(
        name for name in archive.namelist() if name.lower().endswith((".ttf", ".otf"))
    )
    if len(font_files) != EXPECTED_BUNDLED_FONT_COUNT:
        failures.append(
            "正式 APK 应只打包图标/日期字体和四套主题中文子集，实际字体数为 "
            f"{len(font_files)}: {', '.join(font_files)}"
        )
    return failures


def _file_sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _verify_theme_font_sources() -> list[str]:
    """Verify the source-side identities hidden by Android resource shrinking."""

    theme_root = Path(__file__).resolve().parents[1] / "assets" / "fonts" / "theme"
    manifest_path = theme_root / "manifest.json"
    try:
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        return [f"四套主题字体清单不可用: {exc}"]
    records = manifest.get("fonts") if isinstance(manifest, dict) else None
    if not isinstance(records, list):
        return ["四套主题字体清单缺少 fonts 数组"]

    failures: list[str] = []
    seen: set[str] = set()
    for record in records:
        if not isinstance(record, dict):
            failures.append("主题字体清单包含无效记录")
            continue
        theme_id = record.get("theme_id")
        family = record.get("family")
        if not isinstance(theme_id, str) or theme_id not in EXPECTED_THEME_FONTS:
            failures.append(f"主题字体清单包含未知主题: {theme_id!r}")
            continue
        seen.add(theme_id)
        if family != EXPECTED_THEME_FONTS[theme_id]:
            failures.append(f"{theme_id} 的字体族不正确: {family!r}")
        output_file = record.get("output_file")
        if not isinstance(output_file, str):
            failures.append(f"{theme_id} 缺少字体文件名")
            continue
        font_path = theme_root / output_file
        if not font_path.is_file():
            failures.append(f"{theme_id} 字体文件不存在: {output_file}")
            continue
        if record.get("byte_size") != font_path.stat().st_size:
            failures.append(f"{theme_id} 字体大小与清单不一致")
        if record.get("output_sha256") != _file_sha256(font_path):
            failures.append(f"{theme_id} 字体哈希与清单不一致")
    missing = sorted(set(EXPECTED_THEME_FONTS) - seen)
    if missing:
        failures.append("主题字体清单缺失: " + ", ".join(missing))
    if len(records) != len(EXPECTED_THEME_FONTS):
        failures.append(f"主题字体清单应为 4 项，实际为 {len(records)} 项")
    return failures


def verify(apk: Path) -> list[str]:
    failures: list[str] = _verify_theme_font_sources()
    try:
        with zipfile.ZipFile(apk) as archive:
            raw = archive.read("assets/app.config")
            failures.extend(_verify_packaged_resources(archive))
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
    for key in ("reverseGeocoderUrl", "privacyPolicyUrl", "termsOfServiceUrl"):
        value = extra.get(key)
        if not isinstance(value, str) or not value.startswith(EXPECTED_API_BASE):
            failures.append(f"{key} 不是同域 HTTPS 地址: {value!r}")

    if "featureFlags" in extra:
        failures.append("APK 仍包含已退役的过渡功能开关")

    serialized = raw.decode("utf-8", errors="replace")
    for marker in LEGACY_MARKERS:
        if marker in serialized:
            failures.append(f"包含旧生产配置标记: {marker}")
    failures.extend(_verify_native_version(apk, config))
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
    print(f"PASS: {args.apk} 使用 {EXPECTED_API_BASE} 的现行生产配置")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
