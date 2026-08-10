#!/usr/bin/env python3
"""Small source contract check for the device-primary cutover.

This is intentionally a static check, not a claim that all runtime services
have been validated.  It catches accidental reintroduction of account/sync
providers and speaker-name uploads in a candidate APK.
"""

from __future__ import annotations

from pathlib import Path
import sys


def main() -> int:
    root = Path(__file__).resolve().parents[1]
    app = (root / "App.tsx").read_text(encoding="utf-8")
    auth_store = (root / "src/store/AuthStore.tsx").read_text(encoding="utf-8")
    device_api = (root / "src/services/deviceApi.ts").read_text(encoding="utf-8")
    media_import_provider = (root / "src/components/MeetingMediaImportProvider.tsx").read_text(encoding="utf-8")
    schedule_client = (root / "src/services/api.ts").read_text(encoding="utf-8")
    capabilities = (root / "src/data/api/v2/capabilities.ts").read_text(encoding="utf-8")
    speakers = (root / "src/services/speakers.ts").read_text(encoding="utf-8")
    summary = (root / "src/services/meetingSummary.ts").read_text(encoding="utf-8")
    questions = (root / "src/services/meetingQuestions.ts").read_text(encoding="utf-8")
    profile = (root / "src/native/profileEntrySnapshot.ts").read_text(encoding="utf-8")
    meeting_live_android = (root / "src/screens/MeetingLiveScreen.android.tsx").read_text(encoding="utf-8")
    transcription_android = (root / "src/screens/TranscriptionScreen.android.tsx").read_text(encoding="utf-8")
    scope_telemetry = (root / "src/domain/meeting/scopeTelemetry.ts").read_text(encoding="utf-8")
    meetings_store = (root / "src/store/MeetingsStore.tsx").read_text(encoding="utf-8")
    recording_reconciliation = (root / "src/services/meetingRecordingReconciliation.ts").read_text(encoding="utf-8")
    native_finalize = (root / "src/application/meeting/finalizeNativeMeetingRecording.ts").read_text(encoding="utf-8")
    native_finalize_hook = (root / "src/hooks/useNativeMeetingRecordingFinalizer.ts").read_text(encoding="utf-8")
    navigation = (root / "src/navigation/index.tsx").read_text(encoding="utf-8")
    failures: list[str] = []

    removed_providers = (
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
    for marker in removed_providers:
        if marker in app:
            failures.append(f"App.tsx 仍挂载账号同步 Provider: {marker}")
    if "mode: 'guest'" not in auth_store or "session: null" not in auth_store or "accessToken: null" not in auth_store:
        failures.append("AuthStore 未固定为本机 guest/session-null/device-only 模式")
    if "@laoji:deviceSpeakerNames:v1" not in speakers:
        failures.append("讲话人显示名称没有本机映射存储")
    if "name: name.trim()" in device_api or "name: name" in device_api:
        failures.append("设备讲话人请求仍可能上传用户姓名")
    if "parseScheduleRemotely(text" not in schedule_client:
        failures.append("复杂日程解析没有走设备服务接口")
    if "clarifyScheduleRemotely(" not in schedule_client:
        failures.append("日程补充解析没有走设备服务接口")
    if "loadDeviceServiceCapabilities" not in media_import_provider:
        failures.append("文件/视频导入能力探测没有走设备服务接口")
    if "loadMeetingCapabilities" in media_import_provider or "/api/laoji/capabilities" in media_import_provider:
        failures.append("文件/视频导入仍依赖旧账号能力接口")
    if "账号能力接口需要登录" not in capabilities:
        failures.append("旧账号能力接口缺少无令牌 fail-closed 保护")
    if "if (!options.accessToken?.trim()) throw new Error('账号能力接口需要登录')" not in capabilities:
        failures.append("账号能力缓存路径仍可能在无令牌时返回旧能力")
    if "export async function loadDeviceServiceCapabilities" not in device_api:
        failures.append("设备能力探测函数缺失")
    if "request<any>('/capabilities'" not in device_api:
        failures.append("设备能力探测没有调用设备鉴权端点")
    if "parseScheduleAudioRemotely(" not in schedule_client:
        failures.append("日程语音解析没有走设备服务接口")
    for legacy_schedule_call in (
        "fetch(meetingUrl('/api/laoji/parse'",
        "fetch(meetingUrl('/api/laoji/clarify'",
        "fetch(meetingUrl('/api/laoji/parse-audio'",
    ):
        if legacy_schedule_call in schedule_client:
            failures.append(f"移动端日程服务仍直接调用旧接口: {legacy_schedule_call}")
    if "retain_generated_result" not in summary or "retain_generated_result" not in questions:
        failures.append("整理/问答没有携带生成结果保留开关")
    if "generateGuestMeetingSummary" in summary or "fetchGuestMeetingSummaryTask" in summary:
        failures.append("设备整理仍保留旧 guest-summary 回退链路")
    for marker in ("guestSession", "deleteGuestSession", "deleteGuestRealtimeSession"):
        if marker in native_finalize or marker in native_finalize_hook:
            failures.append(f"设备录音收尾仍保留旧 guest 会话路径: {marker}")
    guest_branch_start = questions.find("if (input.scopeKey === 'guest'")
    guest_branch_end = questions.find("  } else {", guest_branch_start)
    if guest_branch_start >= 0 and guest_branch_end > guest_branch_start:
        guest_branch = questions[guest_branch_start:guest_branch_end]
        if "askLegacy" in guest_branch:
            failures.append("设备问答仍可能回退到旧 guest 问答接口并上传本机转写")
    if "打开设置" not in profile or "打开个人资料" in profile:
        failures.append("原生设置入口仍使用个人资料语义")

    # Account/profile screens remain as fail-closed compatibility source, but
    # the device-primary product must never register them in the production
    # navigator. This is a runtime-entry gate, not a claim that the dead
    # compatibility files have been deleted.
    for forbidden_route in (
        'name="Login"',
        'name="Account"',
        'name="Profile"',
        'name="ProfileField"',
        'name="ChangePassword"',
        'name="AccountDeletion"',
        'name="SharedAction"',
        'name="SharedMeetingContent"',
    ):
        if forbidden_route in navigation:
            failures.append(f"生产导航仍暴露去账号化后禁止的入口: {forbidden_route}")
    if 'initialRouteName="MainTabs"' not in navigation:
        failures.append("生产导航未以本机主界面作为初始入口")

    # The historical SQLite scope key is intentionally retained for one-time
    # compatibility, but runtime audit events must identify its real owner and
    # network path.  This prevents a `scope=guest` line from being mistaken for
    # a call to the retired anonymous HTTP endpoints.
    for marker in ("scope_kind", "network_path", "device-local", "device-v1"):
        if marker not in scope_telemetry:
            failures.append(f"设备域审计标记缺失: {marker}")
    if "scopeTelemetry(scope, 'none')" not in meetings_store:
        failures.append("本机会议镜像未明确标记为无网络本地投影")
    if "scopeTelemetry(scopeKey, 'none')" not in recording_reconciliation:
        failures.append("原生录音恢复未明确标记为无网络本地恢复")
    if "scopeTelemetry(scope as ScopeKey, mode === 'guest' ? 'device-v1' : 'account-api')" not in meetings_store:
        failures.append("待上传队列未明确标记设备服务网络路径")

    # Account-compatible functions keep their old optional-token signatures
    # for source compatibility, but no caller is allowed to turn an omitted
    # token into an unauthenticated request. Check each network-facing legacy
    # function has the common fail-closed guard before the first fetch.
    api = schedule_client
    account_functions = (
        "saveEvent",
        "fetchEvents",
        "deleteEvent",
        "updateEvent",
        "fetchMeetings",
        "createMeeting",
        "updateMeeting",
        "fetchMeetingTranscriptSnapshot",
        "fetchMeetingSummaryDetail",
        "generateMeetingSummary",
        "fetchMeetingSummaryTask",
        "fetchMeetingAudioInfo",
        "uploadMeetingAudio",
        "deleteMeeting",
    )
    guard_marker = "requireAccountAccessToken(accessToken"
    for function_name in account_functions:
        start = api.find(f"export async function {function_name}")
        if start < 0:
            failures.append(f"账号兼容函数缺失或改名，未能审计: {function_name}")
            continue
        next_function = api.find("\nexport ", start + 1)
        body = api[start: next_function if next_function >= 0 else len(api)]
        if guard_marker not in body:
            failures.append(f"账号兼容函数未 fail-closed: {function_name}")

    # Android is the production target for the current APK. Its guest path
    # must not retain the transient guest-session protocol or the old summary
    # endpoint. These strings are intentionally absent from the platform
    # files; compatibility helpers may remain in api.ts for old account builds.
    for marker in (
        "createGuestRealtimeSession",
        "deleteGuestRealtimeSession",
        "guest_token",
        "guestToken",
        "fetchGuestMeeting",
        "generateGuestMeetingSummary",
    ):
        if marker in meeting_live_android or marker in transcription_android:
            failures.append(f"Android guest 运行路径仍保留旧会话/兼容接口: {marker}")

    if failures:
        for failure in failures:
            print(f"FAIL: {failure}", file=sys.stderr)
        return 1
    print("PASS: 本机主数据、匿名讲话人、生成保留开关和账号同步入口合同成立")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
