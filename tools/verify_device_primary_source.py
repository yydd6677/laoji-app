#!/usr/bin/env python3
"""Static source gate for LaoJi's accountless, device-primary runtime."""

from __future__ import annotations

from pathlib import Path
import re
import sys


FORBIDDEN_RUNTIME_MARKERS = (
    "/api/auth",
    "/api/laoji",
    "/api/guest",
    "AuthStore",
    "getFeatureFlags",
    "featureFlags",
)

REMOVED_SYNC_PROVIDERS = (
    "MeetingRootSyncProvider",
    "MeetingActionSyncProvider",
    "MeetingManualNoteSyncProvider",
    "MeetingOccurrenceSyncProvider",
    "MeetingSummarySyncProvider",
    "MeetingTranscriptCompletionProvider",
    "MeetingAttachmentSyncProvider",
    "MeetingMarkerSyncProvider",
    "MeetingSpeakerCorrectionSyncProvider",
    "MeetingTagCatalogSyncProvider",
)


def read(path: Path) -> str:
    return path.read_text(encoding="utf-8")


def main() -> int:
    root = Path(__file__).resolve().parents[1]
    required = {
        "app": root / "App.tsx",
        "local_profile": root / "src/store/LocalProfileStore.tsx",
        "events": root / "src/store/EventsStore.tsx",
        "meetings": root / "src/store/MeetingsStore.tsx",
        "device_identity": root / "src/services/deviceIdentity.ts",
        "device_api": root / "src/services/deviceApi.ts",
        "device_v2_api": root / "src/services/deviceV2Api.ts",
        "current_address": root / "src/services/currentAddress.ts",
        "reverse_geocoder": root / "src/services/reverseGeocoder.ts",
        "schedule": root / "src/services/scheduleParsing.ts",
        "speakers": root / "src/services/speakers.ts",
        "summary": root / "src/services/meetingSummary.ts",
        "questions": root / "src/services/meetingQuestions.ts",
        "meeting_repository": root / "src/data/repositories/sqliteMeetingNoteRepository.ts",
        "upload_reconcile": root / "src/application/meeting/reconcileMeetingAudioUpload.ts",
        "navigation": root / "src/navigation/index.tsx",
        "transfer": root / "modules/laoji-native-platform/android/src/main/java/com/laoji/nativeplatform/LaojiTransferModule.kt",
        "worker": root / "modules/laoji-native-platform/android/src/main/java/com/laoji/nativeplatform/transfer/MeetingUploadWorker.kt",
        "uploader": root / "modules/laoji-native-platform/android/src/main/java/com/laoji/nativeplatform/transfer/DeviceV2R2Uploader.kt",
        "media_picker_module": root / "modules/laoji-native-platform/android/src/main/java/com/laoji/nativeplatform/LaojiMediaImportModule.kt",
        "media_picker_bridge": root / "modules/laoji-native-platform/src/mediaImport.ts",
        "media_picker_contract": root / "modules/laoji-native-platform/android/src/main/java/com/laoji/nativeplatform/mediaimport/MeetingMediaPicker.kt",
        "media_import_support": root / "modules/laoji-native-platform/android/src/main/java/com/laoji/nativeplatform/mediaimport/MediaImportSupport.kt",
        "voice_host": root / "modules/laoji-native-platform/android/src/main/java/com/laoji/nativeplatform/schedulevoice/ScheduleVoiceHostView.kt",
    }
    failures: list[str] = []
    for name, path in required.items():
        if not path.is_file():
            failures.append(f"缺少设备主链文件 {name}: {path.relative_to(root)}")
    if failures:
        return report(failures)

    source = {name: read(path) for name, path in required.items()}
    if (root / "src/store/AuthStore.tsx").exists():
        failures.append("账号 AuthStore 仍存在于运行时代码")
    if (root / "src/services/api.ts").exists():
        failures.append("旧账号/guest API 聚合文件仍存在")
    legacy_api_dir = root / "src/data/api/v2"
    if legacy_api_dir.exists() and any(legacy_api_dir.glob("*.ts")):
        failures.append("旧 /api/laoji 客户端目录仍包含 TypeScript 运行文件")

    runtime_files = sorted((root / "src").rglob("*.ts")) + sorted((root / "src").rglob("*.tsx"))
    for path in runtime_files:
        text = read(path)
        for marker in FORBIDDEN_RUNTIME_MARKERS:
            if marker in text:
                failures.append(f"{path.relative_to(root)} 重新引入已退役账号运行标记: {marker}")

    native_runtime_roots = (
        root / "modules/laoji-native-platform/src",
        root / "modules/laoji-native-platform/android/src/main",
    )
    native_runtime_files = sorted(
        path
        for native_root in native_runtime_roots
        for suffix in ("*.ts", "*.tsx", "*.kt", "*.java")
        for path in native_root.rglob(suffix)
    )
    for path in native_runtime_files:
        if "user:" in read(path):
            failures.append(f"{path.relative_to(root)} 重新引入账号 user scope")
    for retired_sync_delete in ("DELETE FROM sync_outbox", "DELETE FROM sync_conflicts"):
        if retired_sync_delete in source["meeting_repository"]:
            failures.append(f"本机会议删除仍清理已退役账号同步表: {retired_sync_delete}")

    if "LocalProfileProvider" not in source["app"] or "LocalProfileStore" not in source["app"]:
        failures.append("App 未由 LocalProfileProvider 持有本机资料")
    if "LOCAL_PROFILE_SCOPE = 'guest'" not in source["local_profile"]:
        failures.append("LocalProfileStore 未固定历史兼容 scope 为 guest")
    for marker in REMOVED_SYNC_PROVIDERS:
        if marker in source["app"]:
            failures.append(f"App 仍挂载账号同步 Provider: {marker}")

    if "const scope = 'guest'" not in source["events"] or "loadLocalScheduleEvents" not in source["events"]:
        failures.append("日程 Store 未固定为本机 guest/SQLite 所有者")
    for marker in (
        "const scope = 'guest'",
        "buildStableCanonicalMeetingProjection(scope, 'roots')",
        "buildStableCanonicalMeetingProjection(scope, 'full')",
    ):
        if marker not in source["meetings"]:
            failures.append(f"会议 Store 缺少 canonical/device 所有权合同: {marker}")

    for marker in ("registerDevice", "ensureDeviceReady", "/api/device/v1"):
        if marker not in source["device_api"]:
            failures.append(f"device-v1 服务合同缺失: {marker}")
    for marker in ("/api/device/v2", "/auth/tokens", "/bootstrap"):
        if marker not in source["device_v2_api"]:
            failures.append(f"device-v2 会话合同缺失: {marker}")
    for marker in ("deviceToken", "dataEpoch"):
        if marker not in source["current_address"]:
            failures.append(f"地址反查缺少设备鉴权快照字段: {marker}")
    for marker in ("authorization: `Bearer ${deviceAuthorization.token}`", "'x-laoji-data-epoch': deviceAuthorization.dataEpoch"):
        if marker not in source["reverse_geocoder"]:
            failures.append(f"地址反查请求缺少设备数据域鉴权头: {marker}")
    for marker in (
        "parseScheduleRemotely(",
        "parseScheduleAudioRemotely(",
        "parseScheduleGraphV2(",
        "clarifyScheduleGraphV2(",
    ):
        if marker not in source["schedule"]:
            failures.append(f"设备日程解析链缺失: {marker}")
    if "@laoji:deviceSpeakerNames:v1" not in source["speakers"]:
        failures.append("讲话人显示名称没有本机映射存储")
    if "generateMeetingSummaryViaSourceStream(" not in source["summary"]:
        failures.append("整理未固定使用 source-stream v3 主链")
    if "askQ2MeetingQuestion(" not in source["questions"]:
        failures.append("会议问答未固定使用 Q2 设备主链")

    for forbidden_route in (
        'name="Login"', 'name="Account"', 'name="Profile"', 'name="ProfileField"',
        'name="ChangePassword"', 'name="AccountDeletion"', 'name="SharedAction"',
        'name="SharedMeetingContent"',
    ):
        if forbidden_route in source["navigation"]:
            failures.append(f"生产导航仍暴露去账号化后禁止的入口: {forbidden_route}")
    if 'initialRouteName="MainTabs"' not in source["navigation"]:
        failures.append("生产导航未以本机主界面作为初始入口")

    for marker in (
        "NetworkType.CONNECTED", "BackoffPolicy.EXPONENTIAL", "ExistingWorkPolicy.KEEP",
        "laoji-device-v2-r2:", "MeetingUploadWorker.KEY_FILE_URI",
        "MeetingUploadWorker.KEY_DEVICE_EPOCH_ID",
    ):
        if marker not in source["transfer"]:
            failures.append(f"device-v2 WorkManager 合同缺失: {marker}")
    if "MeetingUploadWorker.KEY_ACCESS_TOKEN" in source["transfer"]:
        failures.append("WorkManager 输入仍可能持久化 bearer token")
    for marker in ('AsyncFunction("getUploadState") Coroutine', "withContext(Dispatchers.IO)"):
        if marker not in source["transfer"]:
            failures.append(f"WorkManager 完成态读取仍可能阻塞 UI/模块执行队列: {marker}")
    if "canonicalRecordingSourceSha256(checksumText)" not in source["upload_reconcile"]:
        failures.append("上传完成态未同时接受历史裸哈希与 canonical sha256 前缀")
    for marker in ("PROTOCOL_DEVICE_V2_R2", "DeviceV2R2Uploader", "Result.retry()"):
        if marker not in source["worker"]:
            failures.append(f"device-v2 worker 恢复路径缺失: {marker}")
    if "DeviceV2LeaseRefresher" not in source["uploader"]:
        failures.append("device-v2 worker 缺少设备令牌续期路径")

    # File selection is owned by one lifecycle-safe native path. A second JS
    # picker is not a fallback when both depend on Expo's Activity registry.
    for marker in ("OnActivityResult", "appContext.currentActivity", "startActivityForResult", "MEDIA_PICKER_REQUEST_CODE"):
        if marker not in source["media_picker_module"]:
            failures.append(f"会议文件选择缺少 Activity 重建恢复合同: {marker}")
    for marker in ("RegisterActivityContracts", "AppContextActivityResultLauncher"):
        if marker in source["media_picker_module"]:
            failures.append(f"会议文件选择重新依赖 Activity 绑定 launcher: {marker}")
    if "ExpoFileSystemFile.pickFileAsync" in source["media_picker_bridge"]:
        failures.append("会议文件选择重新引入共享同一失效注册表的伪回退")
    if "supportedMeetingMediaMimeTypes" not in source["media_import_support"]:
        failures.append("会议导入能力缺少统一 MIME 类型所有者")
    for marker in ("supportedMeetingMediaMimeTypes", "supportedAudioMeetingMediaMimeTypes"):
        if marker not in source["media_picker_contract"]:
            failures.append(f"会议文件选择未复用真实导入能力白名单: {marker}")

    # Voice input is an authored capture surface, not a demo form. Examples
    # belong in tests and onboarding, never as a prefilled-looking field hint.
    if re.search(r'input\.hint\s*=\s*"[^"\\n]+"', source["voice_host"]):
        failures.append("语音新建输入框重新出现示例句占位")

    return report(failures)


def report(failures: list[str]) -> int:
    if failures:
        for failure in failures:
            print(f"FAIL: {failure}", file=sys.stderr)
        return 1
    print("PASS: 本机资料、canonical SQLite 与 device-v1/v2 服务是唯一移动端运行链")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
