#!/usr/bin/env python3
"""Fail closed when LaoJi's theme or restrained-motion contract regresses."""

from __future__ import annotations

import re
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
THEMES = ("neutral", "vivid", "paper", "midnight")


def read(relative: str) -> str:
    return (ROOT / relative).read_text(encoding="utf-8")


def require(text: str, needle: str, label: str, failures: list[str]) -> None:
    if needle not in text:
        failures.append(f"missing:{label}")


def forbid(text: str, needle: str, label: str, failures: list[str]) -> None:
    if needle in text:
        failures.append(f"forbidden:{label}")


def appearance_block(source: str, theme: str) -> str:
    match = re.search(
        rf"\b{re.escape(theme)}:\s*Object\.freeze\(\{{(?P<body>.*?)\n\s*\}}\),",
        source,
        re.DOTALL,
    )
    return match.group("body") if match else ""


def main() -> int:
    failures: list[str] = []
    theme_ids = read("src/theme/themeIds.ts")
    colors = read("src/theme/colors.ts")
    provider = read("src/theme/ThemeProvider.tsx")
    picker = read("src/components/ThemePickerSheet.tsx")
    pressable = read("src/components/MotionPressable.tsx")
    tabs = read("src/navigation/MainTabs.tsx")
    stack = read("src/navigation/index.tsx")
    summary_content = read("src/components/MeetingSummaryContent.tsx")
    schedule_voice = read(
        "modules/laoji-native-platform/android/src/main/java/com/laoji/nativeplatform/"
        "schedulevoice/ScheduleVoiceHostView.kt"
    )
    minutes_detail_pages = read(
        "modules/laoji-native-platform/android/src/main/java/com/laoji/nativeplatform/minutes/"
        "MinutesDetailPages.kt"
    )
    native_module = read(
        "modules/laoji-native-platform/android/src/main/java/com/laoji/nativeplatform/"
        "LaojiNativePlatformModule.kt"
    )
    system_bars = read(
        "modules/laoji-native-platform/android/src/main/java/com/laoji/nativeplatform/ui/"
        "LaojiSystemBars.kt"
    )
    native_plugin = read("plugins/withLaojiNativePlatform.js")
    generated_main_activity = ROOT / "android/app/src/main/java/com/laoji/app/MainActivity.kt"
    main_activity = (
        generated_main_activity.read_text(encoding="utf-8")
        if generated_main_activity.exists()
        else native_plugin
    )
    calendar_chrome = read(
        "modules/laoji-native-platform/android/src/main/java/com/laoji/nativeplatform/calendar/"
        "CalendarChromeViews.kt"
    )
    settings_group = read("src/components/SettingsGroup.tsx")
    privacy_screen = read("src/screens/PrivacyScreen.tsx")
    app_shell = read("src/components/AppShell.tsx")
    app_overlay = read("src/components/AppOverlay.tsx")
    ui_tokens = read("src/theme/uiTokens.ts")
    minutes_ui = read(
        "modules/laoji-native-platform/android/src/main/java/com/laoji/nativeplatform/minutes/"
        "MinutesUiKit.kt"
    )
    calendar_host = read(
        "modules/laoji-native-platform/android/src/main/java/com/laoji/nativeplatform/calendar/"
        "CalendarHostView.kt"
    )
    month_calendar = read(
        "modules/laoji-native-platform/android/src/main/java/com/laoji/nativeplatform/calendar/"
        "MonthCalendarViews.kt"
    )

    visible_sources = "\n".join(
        path.read_text(encoding="utf-8")
        for base in (ROOT / "src" / "screens", ROOT / "src" / "components")
        for path in base.rglob("*")
        if path.suffix.lower() in {".ts", ".tsx"}
    )

    runtime_ui_sources = "\n".join(
        path.read_text(encoding="utf-8")
        for base in (ROOT / "src", ROOT / "modules" / "laoji-native-platform")
        for path in base.rglob("*")
        if path.is_file()
        and path.suffix.lower() in {".ts", ".tsx", ".kt", ".java"}
        and not any(part in {"build", "node_modules", ".gradle", ".cxx"} for part in path.parts)
    )

    # Historical product references may remain in explicit source-provenance
    # comments, but the active UI owners and symbols belong to LaoJi.
    for old_owner in (
        "src/theme/feishuTokens.ts",
        "src/components/FeishuShell.tsx",
        "src/components/FeishuOverlay.tsx",
    ):
        if (ROOT / old_owner).exists():
            failures.append(f"forbidden:legacy-ui-owner:{old_owner}")
    for old_identifier in (
        "getFeishuTokens",
        "FEISHU_",
        "type Feishu",
        "function Feishu",
        "applyFeishuStyle",
        "/feishuTokens",
    ):
        forbid(
            runtime_ui_sources,
            old_identifier,
            f"legacy-ui-identifier:{old_identifier}",
            failures,
        )
    require(ui_tokens, "export function getUiTokens(", "ui-token-owner", failures)
    require(app_shell, "export function AppTitleBar(", "app-shell-owner", failures)
    require(app_overlay, "export function AppOverlayToast(", "app-overlay-owner", failures)

    require(
        theme_ids,
        "['neutral', 'vivid', 'paper', 'midnight']",
        "four-theme-id-order",
        failures,
    )
    for theme, label in zip(THEMES, ("标准", "绚彩", "纸境", "夜航"), strict=True):
        require(theme_ids, f"{theme}: '{label}'", f"theme-label-{theme}", failures)
        require(native_module, f'"{theme}"', f"native-theme-{theme}", failures)
        block = appearance_block(colors, theme)
        if not block:
            failures.append(f"missing:appearance-{theme}")
            continue
        for stable_geometry in (
            "bottomBarInset: 0",
            "surfaceInset: 0",
            "surfaceRadius: 0",
        ):
            require(block, stable_geometry, f"{theme}-{stable_geometry}", failures)

    for theme, motion_style in zip(
        THEMES,
        ("direct", "spring", "lift", "luminous"),
        strict=True,
    ):
        require(
            appearance_block(colors, theme),
            f"motionStyle: '{motion_style}'",
            f"{theme}-distinct-motion-style",
            failures,
        )

    require(picker, "THEME_IDS.map", "picker-shares-theme-registry", failures)
    require(picker, "testID={`theme-option-${themeId}`}", "picker-stable-test-id", failures)
    require(picker, "previewFontWeight = themeId === 'paper' ? '400' : '600'", "picker-cjk-weight-compatibility", failures)
    require(picker, "previewMonth: { fontSize: 14, lineHeight: 24", "picker-cjk-preview-line-height", failures)
    require(picker, "optionLabel: { fontSize: 14, lineHeight: 26", "picker-cjk-label-line-height", failures)
    require(provider, "AccessibilityInfo.isReduceMotionEnabled()", "reduced-motion-initial-state", failures)
    require(provider, "'reduceMotionChanged'", "reduced-motion-live-state", failures)
    require(tabs, "reduceMotion ? 'none' : appearance.tabAnimation", "tab-reduced-motion", failures)
    require(stack, "reduceMotion ? 'none' : appearance.stackAnimation", "stack-theme-motion", failures)
    require(stack, "reduceMotion ? 'none' : appearance.modalAnimation", "modal-theme-motion", failures)
    require(pressable, "useNativeDriver: true", "compositor-driver", failures)
    require(pressable, "Animated.spring", "vivid-single-spring-release", failures)
    require(pressable, "appearance.motionStyle === 'spring'", "theme-owned-press-motion", failures)
    require(pressable, "transform:", "press-transform", failures)
    require(pressable, "translateY:", "paper-lift-feedback", failures)
    require(pressable, "opacity:", "press-opacity", failures)
    forbid(pressable, "height:", "press-layout-height-animation", failures)
    forbid(pressable, "width:", "press-layout-width-animation", failures)

    # Original LaoJi surfaces must share one stable stage owner and visibly
    # differ by theme structure, not only by color or font. Connection detail
    # is transport telemetry and must not leak into the voice composer.
    for expression in ("DIRECT", "SOFT", "EDITORIAL", "LAYERED"):
        require(schedule_voice, f"VoiceThemeExpression.{expression}", f"voice-expression-{expression.lower()}", failures)
    require(schedule_voice, "private val stageHost = FrameLayout(context)", "voice-stable-stage-host", failures)
    require(schedule_voice, "renderStage(if (inputPhase) inputPanel else confirmPanel)", "voice-monotonic-stage-owner", failures)
    require(schedule_voice, 'it.contains("正在连接")', "voice-hide-connection-copy", failures)
    forbid(schedule_voice, "private val busyPanel", "voice-layout-swapping-busy-panel", failures)

    # Compatibility text may contain lightweight syntax, but the product
    # surface renders authored sections and never exposes Markdown furniture.
    require(summary_content, "parseSummaryText", "summary-authored-parser", failures)
    require(summary_content, "sectionsFromDocument", "summary-structured-document-owner", failures)
    require(summary_content, "原始依据（", "summary-collapsed-evidence-copy", failures)
    forbid(summary_content, "parseMeetingSummaryMarkdown", "summary-markdown-render-owner", failures)
    forbid(summary_content, "markdown:", "summary-markdown-prop", failures)
    forbid(minutes_detail_pages, 'context.textView("•"', "summary-dot-marker", failures)
    forbid(minutes_detail_pages, '"${index + 1}."', "summary-period-number-marker", failures)
    forbid(calendar_chrome, "NativeThemePreference.isVivid", "theme-specific-calendar-root-geometry", failures)
    require(system_bars, "window.statusBarColor = palette.body", "themed-status-surface", failures)
    require(system_bars, "window.navigationBarColor = palette.surface", "themed-navigation-surface", failures)
    require(system_bars, '"laoji:system-bar:status"', "status-bar-backdrop", failures)
    require(system_bars, '"laoji:system-bar:navigation"', "navigation-bar-backdrop", failures)
    require(system_bars, "WindowInsetsCompat.Type.statusBars()", "status-bar-inset-owner", failures)
    require(system_bars, "WindowInsetsCompat.Type.navigationBars()", "navigation-bar-inset-owner", failures)
    require(system_bars, "isAppearanceLightStatusBars = !darkStatusSurface", "status-icon-contrast", failures)
    require(system_bars, "isAppearanceLightNavigationBars = !darkNavigationSurface", "navigation-icon-contrast", failures)
    require(system_bars, "window.isNavigationBarContrastEnforced = false", "three-button-navigation-scrim", failures)
    require(main_activity, "LaojiSystemBars.apply(this)", "activity-system-bar-owner", failures)
    require(main_activity, "override fun onResume()", "activity-system-bar-resume", failures)
    require(native_module, "LaojiSystemBars.apply(activity)", "theme-switch-system-bars", failures)
    require(native_plugin, "laoji-themed-system-bars", "prebuild-system-bar-owner", failures)

    # Version name and Android build number are separate facts. The Settings
    # row and About hero own only the semantic version; the dedicated build row
    # is the sole build-number owner.
    forbid(privacy_screen, "APP_VERSION_LABEL", "settings-combined-version-build", failures)
    forbid(privacy_screen, "currentVersionCode", "settings-build-number-duplicate", failures)
    require(privacy_screen, "value={appUpdate.status === 'available'", "settings-version-state", failures)
    require(privacy_screen, 'testID="privacy-version-row"', "settings-version-stable-test-id", failures)
    legal_document = read("src/screens/LegalDocumentScreen.tsx")
    forbid(legal_document, "APP_VERSION_LABEL", "about-combined-version-build", failures)
    require(
        legal_document,
        '{`老记 ${APP_VERSION}`}',
        "about-version-single-owner",
        failures,
    )
    forbid(legal_document, 'style={s.aboutName}', "about-version-nested-name", failures)
    forbid(legal_document, 'style={s.aboutVersion}', "about-version-nested-value", failures)
    require(legal_document, 'label="构建编号" value={String(APP_BUILD_NUMBER', "single-build-row-owner", failures)
    require(settings_group, "value: {\n    flex: 1,\n    minWidth: 0,", "settings-value-flex-lane", failures)
    require(settings_group, "textAlign: 'right'", "settings-value-right-align", failures)

    # Shared shells and settings must resolve semantic colors from the live
    # provider. Module-level token snapshots survive activity reloads and can
    # leave one screen painted with the previously selected theme.
    for source, label in (
        (settings_group, "settings-group"),
        (privacy_screen, "privacy-screen"),
        (app_shell, "app-shell"),
    ):
        require(source, "useTheme", f"{label}-runtime-theme-owner", failures)
        forbid(
            source,
            "const { colors: F } = getUiTokens()",
            f"{label}-module-theme-snapshot",
            failures,
        )

    # Theme selection is a visual preference. The sheet must not grow tutorial
    # paragraphs that explain personalities instead of showing them.
    for tutorial in (
        "适合喜欢",
        "推荐用于",
        "为你提供",
        "这个主题",
    ):
        forbid(picker, tutorial, f"theme-picker-tutorial:{tutorial}", failures)

    # These phrases duplicate controls that are already visible next to the
    # state. Keep the reason, action control and accessibility label, but do
    # not add a second tutorial sentence to ordinary product copy.
    for redundant in (
        "上次会议总结暂时无法恢复，点击重试",
        "无法读取上次总结任务，点击重试",
        "再次点击保存可重试关联",
    ):
        forbid(visible_sources, redundant, f"redundant-visible-copy:{redundant}", failures)

    # Detail title actions are retained slots. Rebuilding the row when the
    # transcript-only search action appears produces a visible one-frame flash
    # and makes the remaining icons shift sideways.
    require(minutes_ui, "private val searchButton", "minutes-stable-search-slot", failures)
    require(minutes_ui, "LayoutParams(context.dp(132), context.dp(44))", "minutes-fixed-action-lane", failures)
    require(minutes_ui, "searchButton.visibility = if (showSearch) View.VISIBLE else View.INVISIBLE", "minutes-search-slot-visibility", failures)
    forbid(minutes_ui, "leftActions.removeAllViews()", "minutes-title-left-remount", failures)
    forbid(minutes_ui, "rightActions.removeAllViews()", "minutes-title-right-remount", failures)

    # The selected empty-day action must navigate directly. Re-selecting the
    # same date rebinds and briefly conceals the expanded-day pager.
    require(calendar_host, "if (selectedEpochDay != epochDay)", "empty-create-no-reselect", failures)
    require(month_calendar, "val concealPreviousPage = !smoothColumn && selectionChanged", "calendar-conceal-only-on-selection-change", failures)

    summary_copy_sources = "\n".join((
        read("src/screens/TranscriptionScreen.android.tsx"),
        read("src/screens/TranscriptionScreen.tsx"),
        read("src/services/meetingSummary.ts"),
        read("src/services/meetingSummaryV3SourceStream.ts"),
    ))
    for internal_stage_copy in (
        "整理任务仍在后台进行",
        "再次打开会议可继续获取",
        "整理仍在进行",
        "已转入后台",
        "正在检查上次整理任务",
        "正在恢复上次整理任务",
        "正在提交整理任务",
        "正在准备整理",
        "正在核对整理结果",
        "正在保存整理结果",
        "整理任务正在排队",
        "原整理任务已失效，正在重新提交",
    ):
        forbid(
            summary_copy_sources,
            internal_stage_copy,
            f"summary-internal-stage-copy:{internal_stage_copy}",
            failures,
        )

    if failures:
        for failure in failures:
            print(f"FAIL {failure}")
        return 1
    print("PASS LaoJi theme and motion contract")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
