import fs from 'fs';
import os from 'os';
import path from 'path';

const {
  REQUIRED_ANDROID_SURFACES,
  REQUIRED_EXPO_VIEW_HOSTS,
  REQUIRED_NATIVE_SURFACE_CONTAINERS,
  REQUIRED_NATIVE_FRAME_ROOTS,
  REQUIRED_NATIVE_MODULES,
  REQUIRED_NATIVE_CALENDAR_CONTRACTS,
  REQUIRED_NATIVE_MINUTES_DETAIL_CONTRACTS,
  REQUIRED_NATIVE_RECORDER_BRIDGE_CONTRACTS,
  REQUIRED_PLAYER_RECOVERY_CONTRACTS,
  REQUIRED_CAL_EDIT_TIME_CONTRACTS,
  REQUIRED_RUNTIME_SMOKE_CONTRACTS,
  auditAndroidNativeBoundary,
} = require('../scripts/check_android_native_boundary.js') as {
  REQUIRED_ANDROID_SURFACES: string[];
  REQUIRED_EXPO_VIEW_HOSTS: string[];
  REQUIRED_NATIVE_SURFACE_CONTAINERS: string[];
  REQUIRED_NATIVE_FRAME_ROOTS: Array<{ path: string }>;
  REQUIRED_NATIVE_MODULES: string[];
  REQUIRED_NATIVE_CALENDAR_CONTRACTS: Array<{ path: string; fixture: string }>;
  REQUIRED_NATIVE_MINUTES_DETAIL_CONTRACTS: Array<{ path: string; fixture: string }>;
  REQUIRED_NATIVE_RECORDER_BRIDGE_CONTRACTS: Array<{ path: string; fixture: string }>;
  REQUIRED_PLAYER_RECOVERY_CONTRACTS: Array<{ path: string; fixture: string }>;
  REQUIRED_CAL_EDIT_TIME_CONTRACTS: Array<{ path: string; fixture: string }>;
  REQUIRED_RUNTIME_SMOKE_CONTRACTS: Array<{ path: string; patterns: RegExp[] }>;
  auditAndroidNativeBoundary: (root: string) => { ok: boolean; failures: string[] };
};

function write(root: string, relativePath: string, value: string): void {
  const target = path.join(root, relativePath);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, value);
}

function append(root: string, relativePath: string, value: string): void {
  const target = path.join(root, relativePath);
  const existing = fs.existsSync(target) ? fs.readFileSync(target, 'utf8') : '';
  write(root, relativePath, `${existing}${existing ? '\n' : ''}${value}`);
}

function validFixture(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'laoji-native-boundary-'));
  write(root, 'package.json', JSON.stringify({ dependencies: {} }));
  write(root, 'app.config.js', 'module.exports = {};');
  write(root, 'src/navigation/index.tsx', '<Stack.Screen name="MainTabs" />');
  REQUIRED_ANDROID_SURFACES.forEach(file => write(
    root,
    file,
    file === 'src/navigation/MainTabs.android.tsx'
      ? '// UI-ANDROID-COMPOSITION-001 / UI-SHELL-BOTTOM-MAIN-001 / UI-SHELL-RESELECT-001\nstate.selectedTab === \'Schedule\' ? (<ScheduleScreen navigation={navigation} onTabPress={handleTabPress} bottomBarSelectionCommand={state.bottomBarSelectionCommand} />) : (<MeetingListScreen navigation={navigation} onTabPress={handleTabPress} bottomBarSelectionCommand={state.bottomBarSelectionCommand} />)\n'
      : '// native semantic adapter\n',
  ));
  REQUIRED_NATIVE_SURFACE_CONTAINERS.forEach(file => {
    const target = path.join(root, file);
    const existing = fs.readFileSync(target, 'utf8');
    write(root, file, `${existing}\n<View collapsable={false} collapsableChildren={false} />\n`);
  });
  write(root, 'modules/laoji-native-platform/expo-module.config.json', JSON.stringify({
    android: { modules: REQUIRED_NATIVE_MODULES },
  }));
  write(
    root,
    'modules/laoji-native-platform/src/ui.ts',
    [
      "requireOptionalNativeModule<NativeUiModule>('LaojiUi')",
      'presentNativeWindowOverlay',
      'dismissNativeWindowOverlay',
      'onOverlayAction',
      'onOverlayDismiss',
      'compactNativeOverlaySnapshot(snapshot)',
    ].join('\n'),
  );
  write(
    root,
    'modules/laoji-native-platform/src/nativeValues.ts',
    [
      'function compactNativeBridgeValue(value) {',
      '  if (value === undefined) return undefined;',
      '  if (Array.isArray(value)) return value.map(compactNativeBridgeValue);',
      '  return Object.entries(value);',
      '}',
    ].join('\n'),
  );
  write(root, 'modules/laoji-native-platform/src/scheduleVoice.ts', '// UI-OVERLAY-WINDOW-001\n');
  write(root, 'modules/laoji-native-platform/src/calendarPages.ts', '// CAL-SEARCH-001\n');
  write(root, 'src/components/AppDialog.android.tsx', '// UI-OVERLAY-WINDOW-001\n');
  write(root, 'src/components/AppActionSheet.android.tsx', '// UI-OVERLAY-WINDOW-001\n');
  write(root, 'src/components/AppToast.tsx', '// UI-OVERLAY-WINDOW-001\n');
  write(root, 'src/components/AppToast.android.tsx', '// UI-OVERLAY-WINDOW-001\n');
  write(
    root,
    'modules/laoji-native-platform/android/src/main/java/com/laoji/nativeplatform/ui/WindowOverlayController.kt',
    [
      '// UI-OVERLAY-WINDOW-001',
      'root.addView(pageSlot, params)',
      'root.addView(sheetSlot, params)',
      'root.addView(dialogSlot, params)',
      'root.addView(toastSlot, params)',
      'activity.findViewById<ViewGroup>(android.R.id.content).addView(root, params)',
      'LaojiNativeDialogHostView(currentActivity, appContext)',
      'LaojiNativeActionSheetHostView(currentActivity, appContext)',
      'ScheduleVoiceHostView(currentActivity, appContext)',
      'CalendarSearchPageView(currentActivity, appContext)',
      'NativeToastHostView(currentActivity, appContext)',
      'canPresent(currentActivity)',
      'Lifecycle.State.RESUMED',
      'candidate.isFinishing',
      'candidate.isDestroyed',
      'WindowOverlayEntryRegistry',
      'currentForOwner',
      'removeIfCurrent',
      'updateEntry(entry, entry.snapshot)',
      'entry.view.requestInsetsWhenAttached()',
      'obscuredActivityChildren',
      'IMPORTANT_FOR_ACCESSIBILITY_NO_HIDE_DESCENDANTS',
      'topModalEntry()',
      'restoreActivityAccessibility()',
    ].join('\n'),
  );
  write(
    root,
    'modules/laoji-native-platform/android/src/main/java/com/laoji/nativeplatform/ui/LaojiUiModule.kt',
    '// UI-OVERLAY-WINDOW-001\nWindowOverlayController()\nOnActivityEntersBackground\nclearKind(WindowOverlayKind.TOAST, "background")\nAsyncFunction("presentOverlay")\nAsyncFunction("dismissOverlay")\n',
  );
  write(
    root,
    'modules/laoji-native-platform/android/src/main/java/com/laoji/nativeplatform/ui/NativeToastHostView.kt',
    [
      '// UI-OVERLAY-WINDOW-001',
      'class NativeToastHostView',
      'TOAST_MAX_WIDTH_DP',
      'WindowInsetsCompat.Type.navigationBars()',
      'WindowInsetsCompat.Type.ime()',
      'WindowInsetsAnimationCompat.Callback',
      'max(navigationInsetPx, imeInsetPx)',
      'postDelayed(timeout, duration)',
      'dismissListener?.invoke(payload)',
      'accessibilityLiveRegion = ACCESSIBILITY_LIVE_REGION_POLITE',
      'textSize = 14f',
      'maxLines = 12',
      'val radius = if (multiline) 8f else 20f',
      'TOAST_DURATION_MS',
      'val duration = configured ?: 4000L',
      '@Keep',
      'SystemClock.elapsedRealtime()',
      'TouchConsumingLinearLayout',
      'override fun onTouchEvent(event: MotionEvent): Boolean = true',
      'isClickable = false',
      'importantForAccessibility = IMPORTANT_FOR_ACCESSIBILITY_NO',
      'NativeUiTokens.dp(context, 20f).toInt(), NativeUiTokens.dp(context, 10f).toInt(), NativeUiTokens.dp(context, 20f).toInt(),',
      'LaojiWindowToast',
      'dismiss-start sequence=',
      'dismiss-end sequence=',
    ].join('\n'),
  );
  write(
    root,
    'modules/laoji-native-platform/android/src/test/java/com/laoji/nativeplatform/ui/WindowOverlayEntryRegistryTest.kt',
    [
      '// UI-TOAST-WINDOW-001',
      'assertSame(first, registry.put(second))',
      'assertFalse(registry.removeIfCurrent(first))',
      'assertSame(second, registry[WindowOverlayKind.TOAST])',
    ].join('\n'),
  );
  REQUIRED_NATIVE_FRAME_ROOTS.forEach(contract => {
    const source = contract.path.endsWith('NativeOverlayHosts.kt')
      ? [
        '// UI-OVERLAY-001',
        'protected val overlayRoot = FrameLayout(context)',
        'overlayRoot.addView(mask, params)',
        'overlayRoot.addView(card, cardParams)',
        'overlayRoot.addView(outer, frameParams)',
        'requestInsetsWhenAttached()',
        'if (closing) {}',
        'override fun onNavigationInsetChanged() {}',
      ].join('\n')
      : [
        '// UI-OVERLAY-001',
        'private val overlayRoot = FrameLayout(context)',
        'overlayRoot.addView(backdrop, params)',
        'overlayRoot.addView(\n  sheet, params)',
      ].join('\n');
    write(root, contract.path, source);
  });
  REQUIRED_RUNTIME_SMOKE_CONTRACTS.forEach(contract => {
    write(root, contract.path, contract.patterns.map(pattern => pattern.source.replace(/\\/g, '')).join('\n'));
  });
  REQUIRED_NATIVE_RECORDER_BRIDGE_CONTRACTS.forEach(contract => {
    append(root, contract.path, contract.fixture);
  });
  REQUIRED_NATIVE_CALENDAR_CONTRACTS.forEach(contract => {
    append(root, contract.path, contract.fixture);
  });
  REQUIRED_NATIVE_MINUTES_DETAIL_CONTRACTS.forEach(contract => {
    append(root, contract.path, contract.fixture);
  });
  REQUIRED_PLAYER_RECOVERY_CONTRACTS.forEach(contract => {
    append(root, contract.path, contract.fixture);
  });
  REQUIRED_CAL_EDIT_TIME_CONTRACTS.forEach(contract => {
    append(root, contract.path, contract.fixture);
  });
  REQUIRED_EXPO_VIEW_HOSTS.forEach(file => {
    const target = path.join(root, file);
    const existing = fs.existsSync(target) ? fs.readFileSync(target, 'utf8') : '// UI-ROOT-001\n';
    write(root, file, `${existing}\nsetWillNotDraw(false)\nclipToPadding = false\n`);
  });
  for (const file of [
    'modules/laoji-native-platform/android/src/main/java/com/laoji/nativeplatform/calendar/CalendarHostView.kt',
    'modules/laoji-native-platform/android/src/main/java/com/laoji/nativeplatform/minutes/LaojiMinutesView.kt',
  ]) {
    const existing = fs.readFileSync(path.join(root, file), 'utf8');
    const minutesContract = file.endsWith('LaojiMinutesView.kt')
      ? '\nvisibility = View.GONE\ninstallStatusBarInsetPadding { surfaceName == MinutesSurface.LIST.wireName }\nbottomBar.visibility = if (value == MinutesSurface.LIST.wireName) View.VISIBLE else View.GONE\n'
      : '\ninstallStatusBarInsetPadding()\n';
    write(root, file, `${existing}\nLaojiNativeBottomBarView(context, appContext)\nsetBridgeEventsEnabled(false)\nsetTabPressListener {}\n${minutesContract}addView(bottomBar)\n`);
  }
  write(
    root,
    'modules/laoji-native-platform/android/src/main/java/com/laoji/nativeplatform/ui/NativeSystemInsets.kt',
    '// UI-MOTION-001\nWeakHashMap<View, View.OnAttachStateChangeListener>()\nif (isAttachedToWindow) requestApplyInsets()\naddOnAttachStateChangeListener(listener)\nview.requestApplyInsets()\n',
  );
  write(
    root,
    'modules/laoji-native-platform/android/src/main/java/com/laoji/nativeplatform/ui/NativeBottomBarView.kt',
    '// UI-ANDROID-COMPOSITION-001\nsetWillNotDraw(false)\nclipToPadding = false\nrequestInsetsWhenAttached()\n',
  );
  write(
    root,
    'modules/laoji-native-platform/android/src/main/java/com/laoji/nativeplatform/LaojiNativePlatformModule.kt',
    '// CAL-ROOT-001 / MIN-ROOT-001\n"calendarSurface" to true\n"minutesSurface" to true\n"nativeAudioRuntime" to true\n"mediaPlayer" to true\n',
  );
  write(
    root,
    'modules/laoji-native-platform/android/build.gradle',
    [
      "implementation 'androidx.media3:media3-exoplayer:1.10.1'",
      "implementation 'androidx.media3:media3-session:1.10.1'",
      "implementation 'org.jetbrains.kotlinx:kotlinx-coroutines-core:1.7.3'",
      "implementation 'org.jetbrains.kotlinx:kotlinx-coroutines-android:1.7.3'",
      'coreLibraryDesugaringEnabled true',
      "coreLibraryDesugaring 'com.android.tools:desugar_jdk_libs:2.1.5'",
    ].join('\n'),
  );
  write(
    root,
    'modules/laoji-native-platform/android/src/main/java/com/laoji/nativeplatform/media/Player.kt',
    '// MIN-PLAYER-001\nfun create() = ExoPlayer.Builder(context)\n',
  );
  write(
    root,
    'modules/laoji-native-platform/android/src/main/java/com/laoji/nativeplatform/audio/Recorder.kt',
    '// MIN-AUDIO-001: AudioRecord sends binary frames directly\n',
  );
  write(
    root,
    'src/screens/MeetingLiveScreen.android.tsx',
    `${fs.readFileSync(path.join(root, 'src/screens/MeetingLiveScreen.android.tsx'), 'utf8')}\n` +
      '// MIN-REC-BRIDGE-001\nconst nativeAudioBarsRef = useRef([]);\ngetAudioBars: () => nativeAudioBarsRef.current\n',
  );
  append(root, 'src/native/nativeMinutesSnapshots.ts', '// MIN-REC-BRIDGE-001');
  append(root, 'modules/laoji-native-platform/src/minutes.ts', '// MIN-REC-BRIDGE-001');
  return root;
}

describe('UI-LEGACY-001 Android native boundary gate', () => {
  it('keeps the checked-in Android route family on the native boundary', () => {
    const root = path.resolve(__dirname, '..');
    expect(auditAndroidNativeBoundary(root)).toMatchObject({ ok: true, failures: [] });
  });

  it('accepts one native route family, one player owner, and one Media3 version', () => {
    const root = validFixture();
    try {
      expect(auditAndroidNativeBoundary(root)).toMatchObject({ ok: true, failures: [] });
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('rejects legacy dependencies, high-frequency RN UI, and duplicate players', () => {
    const root = validFixture();
    try {
      write(root, 'package.json', JSON.stringify({ dependencies: { 'expo-av': '1', 'react-native-live-audio-stream': '1' } }));
      write(root, REQUIRED_ANDROID_SURFACES[0], 'import { Modal, PanResponder } from "react-native";');
      write(
        root,
        'modules/laoji-native-platform/android/src/main/java/com/laoji/nativeplatform/media/Second.kt',
        'fun createSecond() = ExoPlayer.Builder(context)\n',
      );

      const report = auditAndroidNativeBoundary(root);
      expect(report.ok).toBe(false);
      expect(report.failures.join('\n')).toContain('legacy dependency remains: expo-av');
      expect(report.failures.join('\n')).toContain('PanResponder');
      expect(report.failures.join('\n')).toContain('expected one ExoPlayer owner, found 2');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  // CAL-REPEAT-RRULE-001: the edit host allows only the two source-mapped child routes.
  it('rejects an unregistered third native edit child page', () => {
    const root = validFixture();
    try {
      append(
        root,
        'modules/laoji-native-platform/android/src/main/java/com/laoji/nativeplatform/calendarpages/CalendarEditPageView.kt',
        'private var inventedPage: InventedPageView? = null',
      );

      const report = auditAndroidNativeBoundary(root);
      expect(report.ok).toBe(false);
      expect(report.failures.join('\n')).toContain('unexpected native edit child pages');
      expect(report.failures.join('\n')).toContain('inventedPage:InventedPageView');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('rejects an app build that drops API 24 java.time desugaring', () => {
    const root = validFixture();
    try {
      write(root, 'android/app/build.gradle', '// CAL-EDIT-TIME-001 without desugaring\n');

      const report = auditAndroidNativeBoundary(root);
      expect(report.ok).toBe(false);
      expect(report.failures.join('\n')).toContain('android/app/build.gradle violates CAL-EDIT-TIME-001');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('rejects a recorder level path that regresses from native Flow to JS snapshots', () => {
    const root = validFixture();
    try {
      write(
        root,
        'modules/laoji-native-platform/android/src/main/java/com/laoji/nativeplatform/audio/RecorderLevelHub.kt',
        '// MIN-REC-BRIDGE-001\nRecorderEventBus.emit(RecorderEvents.LEVEL)\n',
      );
      const report = auditAndroidNativeBoundary(root);
      expect(report.ok).toBe(false);
      expect(report.failures.join('\n')).toContain('violates the native recorder level-flow contract');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('rejects the obsolete one-Canvas day calendar owner', () => {
    const root = validFixture();
    try {
      write(
        root,
        'modules/laoji-native-platform/android/src/main/java/com/laoji/nativeplatform/calendar/DayGestureOverlayView.kt',
        '// CAL-DAY-001\nclass DayGestureOverlayView\n',
      );
      const report = auditAndroidNativeBoundary(root);
      expect(report.ok).toBe(false);
      expect(report.failures.join('\n')).toContain('obsolete single-owner calendar surface remains');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('rejects the obsolete single-list Minutes detail owner', () => {
    const root = validFixture();
    try {
      write(
        root,
        'modules/laoji-native-platform/android/src/main/java/com/laoji/nativeplatform/minutes/LegacyMinutesDetail.kt',
        '// MIN-DETAIL-PAGER-001\nclass MinutesContentAdapter\n',
      );
      const report = auditAndroidNativeBoundary(root);
      expect(report.ok).toBe(false);
      expect(report.failures.join('\n')).toContain('obsolete single-list Minutes detail owner remains');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('rejects an exported overlay view that bypasses the Activity window owner', () => {
    const root = validFixture();
    try {
      write(
        root,
        'modules/laoji-native-platform/src/ui.ts',
        "requireNativeViewManager('LaojiNativeDialogHost')\n",
      );
      const report = auditAndroidNativeBoundary(root);
      expect(report.ok).toBe(false);
      expect(report.failures.join('\n')).toContain('mounts obsolete exported overlay LaojiNativeDialogHost');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('rejects a packaged route smoke that loses its semantic and artifact identity gate', () => {
    const root = validFixture();
    try {
      write(
        root,
        'scripts/android-emulator-route-smoke.sh',
        '# UI-ROUTES-001\nMAIN_ACTIVITY="$PACKAGE_NAME/.MainActivity"\nshell input tap 100 200\n',
      );
      const report = auditAndroidNativeBoundary(root);
      expect(report.ok).toBe(false);
      expect(report.failures.join('\n')).toContain(
        'scripts/android-emulator-route-smoke.sh does not retain the runtime rendering contract',
      );
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('rejects full-screen siblings attached directly to ExpoView linear roots', () => {
    const root = validFixture();
    try {
      write(
        root,
        REQUIRED_NATIVE_FRAME_ROOTS[0].path,
        'addView(mask, FrameLayout.LayoutParams(MATCH_PARENT, MATCH_PARENT))\naddView(card, cardParams)\n',
      );
      const report = auditAndroidNativeBoundary(root);
      expect(report.ok).toBe(false);
      expect(report.failures.join('\n')).toContain('does not keep full-screen siblings inside its FrameLayout owner');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('rejects ExpoView hosts that can skip or clip Android-managed child rendering', () => {
    const root = validFixture();
    try {
      write(
        root,
        REQUIRED_EXPO_VIEW_HOSTS[0],
        '// CAL-ROOT-001\nclass Host : ExpoView(context, appContext)\n',
      );
      const report = auditAndroidNativeBoundary(root);
      expect(report.ok).toBe(false);
      expect(report.failures.join('\n')).toContain('can skip or clip Android-managed child rendering inside ExpoView');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('rejects Fabric-flattenable native surface containers', () => {
    const root = validFixture();
    try {
      write(root, REQUIRED_NATIVE_SURFACE_CONTAINERS[0], '<View><NativeSurface /></View>\n');
      const report = auditAndroidNativeBoundary(root);
      expect(report.ok).toBe(false);
      expect(report.failures.join('\n')).toContain('allows Fabric to flatten its native surface container');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
