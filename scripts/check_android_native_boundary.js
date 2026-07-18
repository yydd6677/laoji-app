#!/usr/bin/env node

const fs = require('fs');
const path = require('path');

const REQUIRED_ANDROID_SURFACES = [
  'src/components/VoiceInputModal.android.tsx',
  'src/navigation/MainTabs.android.tsx',
  'src/screens/ScheduleScreen.android.tsx',
  'src/screens/AddEventScreen.android.tsx',
  'src/screens/EventDetailScreen.android.tsx',
  'src/screens/MeetingListScreen.android.tsx',
  'src/screens/MeetingLiveScreen.android.tsx',
  'src/screens/TranscriptionScreen.android.tsx',
  'src/screens/SpeakerManagerScreen.android.tsx',
  'src/screens/SpeakerEnrollmentScreen.android.tsx',
];

const REQUIRED_NATIVE_SURFACE_CONTAINERS = [
  'src/screens/AddEventScreen.android.tsx',
  'src/screens/EventDetailScreen.android.tsx',
  'src/screens/MeetingLiveScreen.android.tsx',
  'src/screens/TranscriptionScreen.android.tsx',
  'src/screens/SpeakerManagerScreen.android.tsx',
  'src/screens/SpeakerEnrollmentScreen.android.tsx',
];

const REQUIRED_NATIVE_MODULES = [
  'com.laoji.nativeplatform.LaojiNativePlatformModule',
  'com.laoji.nativeplatform.LaojiTransferModule',
  'com.laoji.nativeplatform.LaojiCalendarModule',
  'com.laoji.nativeplatform.calendarpages.LaojiCalendarDetailModule',
  'com.laoji.nativeplatform.calendarpages.LaojiCalendarEditModule',
  'com.laoji.nativeplatform.LaojiMinutesModule',
  'com.laoji.nativeplatform.LaojiRecorderModule',
  'com.laoji.nativeplatform.LaojiSpeakerModule',
  'com.laoji.nativeplatform.ui.LaojiUiModule',
];

const REQUIRED_WINDOW_OVERLAY_CONTRACTS = [
  {
    path: 'modules/laoji-native-platform/src/ui.ts',
    patterns: [
      /requireOptionalNativeModule<NativeUiModule>\(['"]LaojiUi['"]\)/,
      /presentNativeWindowOverlay/,
      /dismissNativeWindowOverlay/,
      /onOverlayAction/,
      /onOverlayDismiss/,
      /compactNativeOverlaySnapshot\(snapshot\)/,
    ],
  },
  {
    path: 'modules/laoji-native-platform/src/nativeValues.ts',
    patterns: [
      /compactNativeBridgeValue/,
      /if \(value === undefined\) return undefined/,
      /if \(Array\.isArray\(value\)\)/,
      /Object\.entries\(value\)/,
    ],
  },
  {
    path: 'modules/laoji-native-platform/android/src/main/java/com/laoji/nativeplatform/ui/WindowOverlayController.kt',
    patterns: [
      /findViewById<ViewGroup>\(android\.R\.id\.content\)\.addView\(root/,
      /root\.addView\(pageSlot/,
      /root\.addView\(sheetSlot/,
      /root\.addView\(dialogSlot/,
      /root\.addView\(toastSlot/,
      /LaojiNativeDialogHostView\(currentActivity, appContext\)/,
      /LaojiNativeActionSheetHostView\(currentActivity, appContext\)/,
      /ScheduleVoiceHostView\(currentActivity, appContext\)/,
      /CalendarSearchPageView\(currentActivity, appContext\)/,
      /NativeToastHostView\(currentActivity, appContext\)/,
      /canPresent\(currentActivity\)/,
      /Lifecycle\.State\.RESUMED/,
      /candidate\.isFinishing/,
      /candidate\.isDestroyed/,
      /WindowOverlayEntryRegistry/,
      /currentForOwner/,
      /removeIfCurrent/,
      /updateEntry\(entry, entry\.snapshot\)/,
      /entry\.view\.requestInsetsWhenAttached\(\)/,
      /obscuredActivityChildren/,
      /IMPORTANT_FOR_ACCESSIBILITY_NO_HIDE_DESCENDANTS/,
      /topModalEntry\(\)/,
      /restoreActivityAccessibility\(\)/,
    ],
  },
  {
    path: 'modules/laoji-native-platform/android/src/main/java/com/laoji/nativeplatform/ui/LaojiUiModule.kt',
    patterns: [
      /AsyncFunction\("presentOverlay"/,
      /AsyncFunction\("dismissOverlay"/,
      /WindowOverlayController/,
      /OnActivityEntersBackground/,
      /clearKind\(WindowOverlayKind\.TOAST, "background"\)/,
    ],
  },
  {
    path: 'modules/laoji-native-platform/android/src/main/java/com/laoji/nativeplatform/ui/NativeToastHostView.kt',
    patterns: [
      /class NativeToastHostView/,
      /TOAST_MAX_WIDTH_DP/,
      /WindowInsetsCompat\.Type\.navigationBars\(\)/,
      /WindowInsetsCompat\.Type\.ime\(\)/,
      /WindowInsetsAnimationCompat\.Callback/,
      /max\(navigationInsetPx, imeInsetPx\)/,
      /postDelayed\(timeout, duration\)/,
      /dismissListener\?\.invoke/,
      /accessibilityLiveRegion/,
      /textSize = 14f/,
      /maxLines = 12/,
      /radius = if .* 8f else 20f/,
      /TOAST_DURATION_MS/,
      /\?: 4000L/,
      /@Keep/,
      /SystemClock\.elapsedRealtime\(\)/,
      /TouchConsumingLinearLayout/,
      /override fun onTouchEvent\(event: MotionEvent\): Boolean = true/,
      /isClickable = false/,
      /importantForAccessibility = IMPORTANT_FOR_ACCESSIBILITY_NO/,
      /NativeUiTokens\.dp\(context, 20f\)\.toInt\(\),\s*NativeUiTokens\.dp\(context, 10f\)\.toInt\(\),\s*NativeUiTokens\.dp\(context, 20f\)\.toInt\(\),/s,
      /LaojiWindowToast/,
      /dismiss-start sequence=/,
      /dismiss-end sequence=/,
    ],
  },
  {
    path: 'modules/laoji-native-platform/android/src/test/java/com/laoji/nativeplatform/ui/WindowOverlayEntryRegistryTest.kt',
    patterns: [
      /UI-TOAST-WINDOW-001/,
      /assertSame\(first, registry\.put\(second\)\)/,
      /assertFalse\(registry\.removeIfCurrent\(first\)\)/,
      /assertSame\(second, registry\[WindowOverlayKind\.TOAST\]\)/,
    ],
  },
];

const REQUIRED_RUNTIME_SMOKE_CONTRACTS = [
  {
    path: 'scripts/android-emulator-route-smoke.sh',
    patterns: [
      /UI-ROUTES-001/,
      /MAIN_ACTIVITY="\$PACKAGE_NAME\/\.MainActivity"/,
      /xml_node_center/,
      /expected one node/,
      /assert_apk_fresh/,
      /device_apk_hash/,
      /run_route/,
      /run_lifecycle_route/,
      /scan_current_logcat/,
      /force-stop-cold-start/,
      /RUN_COMPOSITION_SMOKE/,
    ],
  },
  {
    path: 'scripts/android-emulator-composition-smoke.sh',
    patterns: [
      /assert_frame_differs/,
      /assert_frame_matches/,
      /assert_installed_apk_matches/,
      /install --no-streaming -r/,
      /meetings-\$cycle\.png/,
      /schedule-force-stop-restart\.png/,
      /schedule-home-restore\.png/,
    ],
  },
  {
    path: 'scripts/android-emulator-overlay-smoke.sh',
    patterns: [
      /assert_single_overlay/,
      /assert_frame_differs/,
      /assert_frame_matches/,
      /assert_installed_apk_matches/,
      /install --no-streaming -r/,
      /mInputShown=true/,
      /mInputShown=false/,
      /shell input text test123/,
      /shell input keyevent 3/,
      /meeting-sheet-restored/,
      /clear-dialog-reopened/,
      /NativeToastHostView/,
      /event-toast-timeout-finished/,
      /assert_toast_frame_differs/,
      /assert_label_not_clickable/,
      /assert_label_moves_down/,
      /assert_toast_timing_log/,
      /toast-reentry-alive/,
      /LaojiWindowOverlay\.\*present failed/,
    ],
  },
];

const REQUIRED_NATIVE_RECORDER_BRIDGE_CONTRACTS = [
  {
    path: 'modules/laoji-native-platform/android/src/main/java/com/laoji/nativeplatform/audio/AudioContracts.kt',
    patterns: [
      /data class RecorderLevelFrame/,
      /val sequence: Long/,
      /interface RecorderLevelSource/,
      /fun observe\(sessionId: String\): StateFlow<RecorderLevelFrame\?>/,
      /val audioBars: List<Float>/,
    ],
    fixture: [
      '// MIN-REC-BRIDGE-001',
      'data class RecorderLevelFrame(val sequence: Long)',
      'interface RecorderLevelSource { fun observe(sessionId: String): StateFlow<RecorderLevelFrame?> }',
      'data class RecorderStopResult(val audioBars: List<Float>)',
    ].join('\n'),
  },
  {
    path: 'modules/laoji-native-platform/android/src/main/java/com/laoji/nativeplatform/audio/RecorderLevelHub.kt',
    patterns: [
      /object RecorderLevelHub : RecorderLevelSource/,
      /MAX_SAMPLES = 160/,
      /MutableStateFlow<RecorderLevelFrame\?>\(null\)/,
      /state\.sequence \+= 1L/,
      /captureSummaryAndClear/,
      /samplesToBars/,
    ],
    fixture: [
      '// MIN-REC-BRIDGE-001',
      'object RecorderLevelHub : RecorderLevelSource',
      'MAX_SAMPLES = 160',
      'MutableStateFlow<RecorderLevelFrame?>(null)',
      'state.sequence += 1L',
      'fun captureSummaryAndClear() = samplesToBars()',
    ].join('\n'),
  },
  {
    path: 'modules/laoji-native-platform/android/src/main/java/com/laoji/nativeplatform/audio/RecorderEngine.kt',
    patterns: [
      /RecorderLevelHub\.reset\(config\.sessionId\)/,
      /RecorderLevelHub\.publish\(/,
      /config\.purpose != AudioPurpose\.MEETING/,
      /audioBars = captureAudioBars\(\)/,
      /RecorderLevelHub\.captureSummaryAndClear\(config\.sessionId\)/,
    ],
    fixture: [
      '// MIN-REC-BRIDGE-001',
      'RecorderLevelHub.reset(config.sessionId)',
      'RecorderLevelHub.publish(',
      'if (config.purpose != AudioPurpose.MEETING) {}',
      'audioBars = captureAudioBars()',
      'RecorderLevelHub.captureSummaryAndClear(config.sessionId)',
    ].join('\n'),
  },
  {
    path: 'modules/laoji-native-platform/android/src/main/java/com/laoji/nativeplatform/minutes/MinutesRecordingSurface.kt',
    patterns: [
      /RecorderLevelHub\.observe\(sessionId\)/,
      /filterNotNull\(\)/,
      /renderedState\.phase == MinutesRecordingPhase\.RECORDING/,
      /levelCollectionJob\?\.cancel\(\)/,
      /frame\.sessionId != renderedState\.meetingId/,
      /nativeElapsedMs = maxOf\(nativeElapsedMs, frame\.durationMs\)/,
    ],
    fixture: [
      '// MIN-REC-BRIDGE-001',
      'RecorderLevelHub.observe(sessionId)',
      '.filterNotNull()',
      'renderedState.phase == MinutesRecordingPhase.RECORDING',
      'levelCollectionJob?.cancel()',
      'frame.sessionId != renderedState.meetingId',
      'nativeElapsedMs = maxOf(nativeElapsedMs, frame.durationMs)',
    ].join('\n'),
  },
  {
    path: 'modules/laoji-native-platform/android/src/main/java/com/laoji/nativeplatform/minutes/MinutesRecordingWaveformView.kt',
    patterns: [
      /maxPending: Int = 10/,
      /attack: Float = 0\.2f/,
      /decay: Float = 0\.08f/,
      /cosineInterpolate/,
      /frameScheduled/,
      /NORMAL_FRAME_MS = 1_000L \/ 30L/,
      /LOW_MEMORY_FRAME_MS = 1_000L \/ 15L/,
    ],
    fixture: [
      '// MIN-REC-WAVE-001',
      'maxPending: Int = 10',
      'attack: Float = 0.2f',
      'decay: Float = 0.08f',
      'cosineInterpolate()',
      'frameScheduled',
      'NORMAL_FRAME_MS = 1_000L / 30L',
      'LOW_MEMORY_FRAME_MS = 1_000L / 15L',
    ].join('\n'),
  },
  {
    path: 'modules/laoji-native-platform/android/src/androidTest/java/com/laoji/nativeplatform/minutes/MinutesRecordingSurfaceInstrumentedTest.kt',
    patterns: [
      /MIN-REC-BRIDGE-001/,
      /publish\("other-session"/,
      /MinutesRecordingPhase\.PAUSED/,
      /sessionId = NEXT_SESSION/,
      /activity\.root\.removeView/,
      /assertEquals\("00:01"/,
    ],
    fixture: [
      '// MIN-REC-BRIDGE-001',
      'publish("other-session")',
      'MinutesRecordingPhase.PAUSED',
      'sessionId = NEXT_SESSION',
      'activity.root.removeView(surface)',
      'assertEquals("00:01", timer)',
    ].join('\n'),
  },
];

const REQUIRED_NATIVE_CALENDAR_CONTRACTS = [
  {
    path: 'modules/laoji-native-platform/android/src/main/java/com/laoji/nativeplatform/calendar/CalendarHostView.kt',
    patterns: [
      /private val monthPager = ThreePageMonthPager\(context\)/,
      /private val dayView = SingleDayCalendarView\(context\)/,
      /dayView\.setSnapshot/,
      /dayView\.clearDraft/,
    ],
    fixture: [
      '// CAL-DAY-PAGER-001 / CAL-MONTH-EXPAND-001',
      'private val monthPager = ThreePageMonthPager(context)',
      'private val dayView = SingleDayCalendarView(context)',
      'dayView.setSnapshot(snapshot)',
      'dayView.clearDraft("dispose", false)',
    ].join('\n'),
  },
  {
    path: 'modules/laoji-native-platform/android/src/main/java/com/laoji/nativeplatform/calendar/SingleDayCalendarView.kt',
    patterns: [
      /class SingleDayCalendarView/,
      /DayWeekHeaderView\(context\)/,
      /DayAllDaySectionView\(context\)/,
      /ThreePageDayPager\(context\)/,
      /PROGRAMMATIC_DAY_SWITCH_DURATION_MS/,
    ],
    fixture: [
      '// CAL-DAY-PAGER-001',
      'class SingleDayCalendarView',
      'DayWeekHeaderView(context)',
      'DayAllDaySectionView(context)',
      'ThreePageDayPager(context)',
      'PROGRAMMATIC_DAY_SWITCH_DURATION_MS',
    ].join('\n'),
  },
  {
    path: 'modules/laoji-native-platform/android/src/main/java/com/laoji/nativeplatform/calendar/DayTimelineViews.kt',
    patterns: [
      /class DayTimelineCanvasView/,
      /class DayTimelineGestureLayer/,
      /AccessibilityNodeProvider/,
      /TIMELINE_TOTAL_HEIGHT_DP/,
      /HOUR_HEIGHT_DP/,
      /formatTimeRange/,
    ],
    fixture: [
      '// CAL-DAY-PAGER-001 / CAL-DAY-DRAG-001',
      'class DayTimelineCanvasView',
      'class DayTimelineGestureLayer',
      'AccessibilityNodeProvider',
      'TIMELINE_TOTAL_HEIGHT_DP',
      'HOUR_HEIGHT_DP',
      'formatTimeRange',
    ].join('\n'),
  },
  {
    path: 'modules/laoji-native-platform/android/src/main/java/com/laoji/nativeplatform/calendar/DayAllDaySectionView.kt',
    patterns: [
      /class DayAllDaySectionView/,
      /fun collapsedContent/,
      /COLLAPSED_MAX_ROWS - 1/,
      /还有 \$remainingCount 项/,
      /HEIGHT_ANIMATION_DURATION_MS/,
      /class DayAllDayScrollView.*ScrollView/s,
    ],
    fixture: [
      '// CAL-ALLDAY-EXPAND-001',
      'class DayAllDaySectionView',
      'fun collapsedContent() = COLLAPSED_MAX_ROWS - 1',
      'text = "还有 $remainingCount 项"',
      'HEIGHT_ANIMATION_DURATION_MS',
      'class DayAllDayScrollView : ScrollView',
    ].join('\n'),
  },
  {
    path: 'modules/laoji-native-platform/android/src/main/java/com/laoji/nativeplatform/calendar/MonthCalendarViews.kt',
    patterns: [
      /class MonthWeekRowView/,
      /class SelectedDayEventsOwner/,
      /ViewPager2\(context\)/,
      /DAY_PAGE_COUNT/,
      /CLOSE_THEN_OPEN/,
      /ROW_ANIMATION_DURATION_MS/,
    ],
    fixture: [
      '// CAL-MONTH-EXPAND-001',
      'class MonthWeekRowView',
      'class SelectedDayEventsOwner',
      'ViewPager2(context)',
      'DAY_PAGE_COUNT',
      'CLOSE_THEN_OPEN',
      'ROW_ANIMATION_DURATION_MS',
    ].join('\n'),
  },
];

const FORBIDDEN_NATIVE_CALENDAR_FILES = [
  'modules/laoji-native-platform/android/src/main/java/com/laoji/nativeplatform/calendar/DayGestureOverlayView.kt',
];

const REQUIRED_NATIVE_MINUTES_DETAIL_CONTRACTS = [
  {
    path: 'modules/laoji-native-platform/android/src/main/java/com/laoji/nativeplatform/minutes/MinutesDetailSurface.kt',
    patterns: [
      /MinutesDetailStickyLayout\(context\)/,
      /ViewPager2\(context\)/,
      /MinutesDetailPagerAdapter\(context/,
      /stickyLayout\.setOwners\(audioHeader, tabBar, detailPager\)/,
      /addView\(stickyLayout, LayoutParams\(ViewGroup\.LayoutParams\.MATCH_PARENT, 0, 1f\)\)/,
      /addView\(player, LayoutParams\(ViewGroup\.LayoutParams\.MATCH_PARENT, ViewGroup\.LayoutParams\.WRAP_CONTENT\)\)/,
    ],
    fixture: [
      '// MIN-DETAIL-PAGER-001 / MIN-DETAIL-STICKY-001',
      'MinutesDetailStickyLayout(context)',
      'ViewPager2(context)',
      'MinutesDetailPagerAdapter(context, onAction)',
      'stickyLayout.setOwners(audioHeader, tabBar, detailPager)',
      'addView(stickyLayout, LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 0, 1f))',
      'addView(player, LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT))',
    ].join('\n'),
  },
  {
    path: 'modules/laoji-native-platform/android/src/main/java/com/laoji/nativeplatform/minutes/MinutesDetailStickyLayout.kt',
    patterns: [
      /NestedScrollingParent2/,
      /fun setOwners\(header: View, tabs: View, pager: View\)/,
      /header\.measuredHeight/,
      /MinutesDetailLayoutContract\.consumePreScroll/,
      /target\.canScrollVertically\(-1\)/,
      /requestLayout\(\)/,
    ],
    fixture: [
      '// MIN-DETAIL-STICKY-001',
      'class MinutesDetailStickyLayout : NestedScrollingParent2',
      'fun setOwners(header: View, tabs: View, pager: View)',
      'header.measuredHeight',
      'MinutesDetailLayoutContract.consumePreScroll()',
      'target.canScrollVertically(-1)',
      'requestLayout()',
    ].join('\n'),
  },
  {
    path: 'modules/laoji-native-platform/android/src/main/java/com/laoji/nativeplatform/minutes/MinutesDetailPager.kt',
    patterns: [
      /MinutesDetailTab\.TRANSCRIPT to MinutesTranscriptPage/,
      /MinutesDetailTab\.SUMMARY to MinutesSummaryPage/,
      /MinutesDetailTab\.SPEAKERS to MinutesSpeakersPage/,
      /setHasStableIds\(true\)/,
      /offscreenPageLimit = MinutesDetailLayoutContract\.PAGE_COUNT/,
    ],
    fixture: [
      '// MIN-DETAIL-PAGER-001',
      'MinutesDetailTab.TRANSCRIPT to MinutesTranscriptPage',
      'MinutesDetailTab.SUMMARY to MinutesSummaryPage',
      'MinutesDetailTab.SPEAKERS to MinutesSpeakersPage',
      'setHasStableIds(true)',
      'offscreenPageLimit = MinutesDetailLayoutContract.PAGE_COUNT',
    ].join('\n'),
  },
  {
    path: 'modules/laoji-native-platform/android/src/main/java/com/laoji/nativeplatform/minutes/MinutesDetailPages.kt',
    patterns: [
      /class MinutesTranscriptPage/,
      /internal val list = RecyclerView\(context\)/,
      /class MinutesSummaryPage/,
      /internal val scroll = NestedScrollView\(context\)/,
      /class MinutesSpeakersPage/,
      /state\.pageState\(tab\)/,
    ],
    fixture: [
      '// MIN-DETAIL-PAGER-001',
      'class MinutesTranscriptPage { internal val list = RecyclerView(context) }',
      'class MinutesSummaryPage { internal val scroll = NestedScrollView(context) }',
      'class MinutesSpeakersPage { internal val list = RecyclerView(context) }',
      'state.pageState(tab)',
    ].join('\n'),
  },
  {
    path: 'modules/laoji-native-platform/android/src/main/java/com/laoji/nativeplatform/minutes/MinutesState.kt',
    patterns: [
      /data class MinutesDetailPageStates/,
      /val pageStates: MinutesDetailPageStates/,
      /fun pageState\(tab: MinutesDetailTab\)/,
      /pageStates\[tab\]/,
    ],
    fixture: [
      '// MIN-DETAIL-PAGER-001',
      'data class MinutesDetailPageStates(val transcript: Any)',
      'val pageStates: MinutesDetailPageStates',
      'fun pageState(tab: MinutesDetailTab) = pageStates[tab]',
    ].join('\n'),
  },
  {
    path: 'modules/laoji-native-platform/android/src/androidTest/java/com/laoji/nativeplatform/minutes/MinutesDetailSurfaceInstrumentedTest.kt',
    patterns: [
      /MIN-DETAIL-PAGER-001/,
      /assertEquals\(3, requireNotNull\(surface\.detailPager\.adapter\)\.itemCount\)/,
      /assertSame\(surface\.stickyLayout, surface\.getChildAt\(1\)\)/,
      /assertEquals\(ViewGroup\.LayoutParams\.WRAP_CONTENT, surface\.player\.layoutParams\.height\)/,
      /pagerKeepsPageInstancesScrollAndIndependentStateAcrossSwitchAndRender/,
      /stickyConsumesHeaderBeforePageAndOnlyExpandsForPageAtTop/,
    ],
    fixture: [
      '// MIN-DETAIL-PAGER-001 / MIN-DETAIL-STICKY-001',
      'assertEquals(3, requireNotNull(surface.detailPager.adapter).itemCount)',
      'assertSame(surface.stickyLayout, surface.getChildAt(1))',
      'assertEquals(ViewGroup.LayoutParams.WRAP_CONTENT, surface.player.layoutParams.height)',
      'fun pagerKeepsPageInstancesScrollAndIndependentStateAcrossSwitchAndRender() {}',
      'fun stickyConsumesHeaderBeforePageAndOnlyExpandsForPageAtTop() {}',
    ].join('\n'),
  },
];

const FORBIDDEN_NATIVE_MINUTES_DETAIL_PATTERNS = [
  /class\s+MinutesContentAdapter\b/,
  /class\s+MinutesContentRow\b/,
];

const REQUIRED_PLAYER_RECOVERY_CONTRACTS = [
  {
    path: 'modules/laoji-native-platform/android/src/main/java/com/laoji/nativeplatform/media/MinutesPlaybackRecovery.kt',
    patterns: [
      /data class MinutesPlaybackRecoveryRecord[\s\S]*val positionMs: Long[\s\S]*val rate: Float[\s\S]*val wasPlaying: Boolean/,
      /interface MinutesPlaybackRecoveryStore[\s\S]*fun load\(activeStorageScope: String\)[\s\S]*fun save\(record: MinutesPlaybackRecoveryRecord\)/,
      /class MinutesPlaybackRecoveryPolicy[\s\S]*"file", "content"[\s\S]*"https"/,
      /class MinutesPlaybackProgressThrottle/,
    ],
    fixture: [
      '// MIN-PLAYER-RECOVERY-001',
      'data class MinutesPlaybackRecoveryRecord(val positionMs: Long, val rate: Float, val wasPlaying: Boolean)',
      'interface MinutesPlaybackRecoveryStore { fun load(activeStorageScope: String): Any; fun save(record: MinutesPlaybackRecoveryRecord): Boolean }',
      'class MinutesPlaybackRecoveryPolicy { fun schemes() = listOf("file", "content", "https") }',
      'class MinutesPlaybackProgressThrottle',
    ].join('\n'),
  },
  {
    path: 'modules/laoji-native-platform/android/src/main/java/com/laoji/nativeplatform/media/EncryptedMinutesPlaybackStore.kt',
    patterns: [
      /AtomicFile\(/,
      /Cipher\.getInstance\(CIPHER_TRANSFORMATION\)/,
      /CIPHER_TRANSFORMATION\s*=\s*"AES\/GCM\/NoPadding"/,
      /KeyStore\.getInstance\(ANDROID_KEY_STORE\)/,
      /encrypt\(MinutesPlaybackRecoveryCodec\.encode\(record\)\)/,
      /MinutesPlaybackRecoveryCodec\.decode\(decrypt\(encrypted\)\)/,
    ],
    fixture: [
      '// MIN-PLAYER-RECOVERY-001',
      'AtomicFile(file)',
      'Cipher.getInstance(CIPHER_TRANSFORMATION)',
      'const val CIPHER_TRANSFORMATION = "AES/GCM/NoPadding"',
      'KeyStore.getInstance(ANDROID_KEY_STORE)',
      'encrypt(MinutesPlaybackRecoveryCodec.encode(record))',
      'MinutesPlaybackRecoveryCodec.decode(decrypt(encrypted))',
    ].join('\n'),
  },
  {
    path: 'modules/laoji-native-platform/android/src/main/java/com/laoji/nativeplatform/media/Media3MinutesPlayerAdapter.kt',
    patterns: [
      /recoveryStore\.load\(activeStorageScope\)/,
      /player\.playWhenReady\s*=\s*false/,
      /MinutesPlaybackProgressThrottle\(\)/,
      /persist\(force = false\)/,
      /override fun onPositionDiscontinuity/,
      /override fun activateStorageScope/,
    ],
    fixture: [
      '// MIN-PLAYER-RECOVERY-001',
      'recoveryStore.load(activeStorageScope)',
      'player.playWhenReady = false',
      'MinutesPlaybackProgressThrottle()',
      'persist(force = false)',
      'override fun onPositionDiscontinuity() {}',
      'override fun activateStorageScope(storageScope: String) {}',
    ].join('\n'),
  },
  {
    path: 'modules/laoji-native-platform/android/src/main/java/com/laoji/nativeplatform/media/LaojiMinutesPlaybackService.kt',
    patterns: [
      /Media3MinutesPlayerAdapter\([\s\S]*initialStorageScope = scopeStore\.activeScope\(\)/,
      /MINUTES_ACTIVATE_STORAGE_SCOPE_COMMAND/,
      /scopeStore\.activate\(scope\)[\s\S]*adapter\.activateStorageScope\(scope\)/,
      /adapter\.setSourceChecked\(source\)/,
    ],
    fixture: [
      '// MIN-PLAYER-RECOVERY-001',
      'Media3MinutesPlayerAdapter(initialStorageScope = scopeStore.activeScope())',
      'MINUTES_ACTIVATE_STORAGE_SCOPE_COMMAND',
      'scopeStore.activate(scope); adapter.activateStorageScope(scope)',
      'adapter.setSourceChecked(source)',
    ].join('\n'),
  },
  {
    path: 'modules/laoji-native-platform/android/src/main/java/com/laoji/nativeplatform/LaojiMinutesModule.kt',
    patterns: [
      /AsyncFunction\("activatePlaybackStorageScope"\)/,
      /MinutesPlaybackScopeStore\(context\)\.activate\(normalized\)/,
      /activateStorageScope\(normalized\)/,
    ],
    fixture: [
      '// MIN-PLAYER-RECOVERY-001',
      'AsyncFunction("activatePlaybackStorageScope")',
      'MinutesPlaybackScopeStore(context).activate(normalized)',
      'activateStorageScope(normalized)',
    ].join('\n'),
  },
  {
    path: 'modules/laoji-native-platform/android/src/main/java/com/laoji/nativeplatform/minutes/MinutesState.kt',
    patterns: [
      /data class MinutesPlayerSource[\s\S]*val storageScope: String[\s\S]*val expiresAt: Long\? = null/,
    ],
    fixture: 'data class MinutesPlayerSource(val storageScope: String, val expiresAt: Long? = null)',
  },
  {
    path: 'modules/laoji-native-platform/src/minutes.ts',
    patterns: [
      /storageScope: 'guest' \| `user:\$\{string\}`/,
      /expiresAt\?: number/,
      /activateMinutesPlaybackStorageScope/,
    ],
    fixture: [
      "storageScope: 'guest' | `user:${string}`;",
      'expiresAt?: number;',
      'activateMinutesPlaybackStorageScope',
    ].join('\n'),
  },
  {
    path: 'src/components/NativePlatformCoordinator.tsx',
    patterns: [
      /if \(initializing\) return/,
      /activateMinutesPlaybackStorageScope\(playbackScope\)/,
      /'signed_out' as const/,
    ],
    fixture: [
      'if (initializing) return;',
      'activateMinutesPlaybackStorageScope(playbackScope)',
      "const playbackScope = 'signed_out' as const",
    ].join('\n'),
  },
  {
    path: 'src/screens/TranscriptionScreen.android.tsx',
    patterns: [
      /sourceId:\s*`local:\$\{meetingId\}`/,
      /sourceId:\s*`cloud:\$\{meeting\.id\}`/,
      /storageScope:\s*playbackStorageScope/,
      /expiresAt:\s*Number\.isFinite\(parsedExpiry\)/,
    ],
    fixture: [
      'sourceId: `local:${meetingId}`',
      'sourceId: `cloud:${meeting.id}`',
      'storageScope: playbackStorageScope',
      'expiresAt: Number.isFinite(parsedExpiry)',
    ].join('\n'),
  },
];

const REQUIRED_CAL_EDIT_TIME_CONTRACTS = [
  {
    path: 'modules/laoji-native-platform/android/src/main/java/com/laoji/nativeplatform/calendarpages/CalendarEditPageView.kt',
    patterns: [
      /CalendarEditTimePageView\(/,
      /CalendarRepeatEndPageView\(/,
      /onCancel = ::cancelTimePage/,
      /onComplete = ::completeTimePage/,
      /onCancel = ::cancelRepeatEndPage/,
      /onComplete = ::completeRepeatEndPage/,
      /OnBackPressedCallback\(false\)[\s\S]*cancelRepeatEndPage\(\)[\s\S]*cancelTimePage\(\)/,
      /onSaveInstanceState\(\)[\s\S]*timePage\?\.currentState\(\)\?\.toStateBundle\(\)[\s\S]*repeatEndPage\?\.currentState\(\)\?\.toStateBundle\(\)/,
      /onRestoreInstanceState[\s\S]*showRepeatEndPage\(restoredRepeatEnd\)[\s\S]*showTimePage\(restoredTime\)/,
      /cancelTimePage\(\)[\s\S]*val entryDraft = page\.currentState\(\)\.baseDraft[\s\S]*draft = entryDraft/,
      /cancelRepeatEndPage\(\)[\s\S]*val entryDraft = page\.currentState\(\)\.baseDraft[\s\S]*draft = entryDraft/,
    ],
    fixture: [
      '// CAL-EDIT-TIME-001',
      'private var timePage: CalendarEditTimePageView? = null',
      'private var repeatEndPage: CalendarRepeatEndPageView? = null',
      'showTimePage(CalendarEditEndpoint.START)',
      'showTimePage(CalendarEditEndpoint.START)',
      'showTimePage(CalendarEditEndpoint.END)',
      'showTimePage(CalendarEditEndpoint.END)',
      'CalendarEditTimePageView(',
      'CalendarRepeatEndPageView(',
      'onCancel = ::cancelTimePage',
      'onComplete = ::completeTimePage',
      'onCancel = ::cancelRepeatEndPage',
      'onComplete = ::completeRepeatEndPage',
      'OnBackPressedCallback(false) { cancelRepeatEndPage(); cancelTimePage() }',
      'override fun onSaveInstanceState() { timePage?.currentState()?.toStateBundle(); repeatEndPage?.currentState()?.toStateBundle() }',
      'override fun onRestoreInstanceState(value: Any) { showRepeatEndPage(restoredRepeatEnd); showTimePage(restoredTime) }',
      'fun cancelTimePage() { val entryDraft = page.currentState().baseDraft; draft = entryDraft }',
      'fun cancelRepeatEndPage() { val entryDraft = page.currentState().baseDraft; draft = entryDraft }',
    ].join('\n'),
  },
  {
    path: 'modules/laoji-native-platform/android/src/main/java/com/laoji/nativeplatform/calendarpages/CalendarEditWheelView.kt',
    patterns: [
      /class CalendarEditWheelView\(context: Context\)\s*:\s*View\(context\)/,
      /override fun onDraw\(canvas: Canvas\)/,
      /private val scroller = OverScroller\(context\)/,
      /scroller\.fling\(/,
      /override fun computeScroll\(\)/,
    ],
    fixture: [
      '// CAL-EDIT-TIME-001',
      'class CalendarEditWheelView(context: Context) : View(context)',
      'override fun onDraw(canvas: Canvas) {}',
      'private val scroller = OverScroller(context)',
      'fun fling() { scroller.fling(',
      'override fun computeScroll() {}',
    ].join('\n'),
  },
  {
    path: 'modules/laoji-native-platform/android/build.gradle',
    patterns: [
      /coreLibraryDesugaringEnabled true/,
      /coreLibraryDesugaring 'com\.android\.tools:desugar_jdk_libs:2\.1\.5'/,
    ],
    fixture: [
      '// CAL-EDIT-TIME-001 / CAL-REPEAT-RRULE-001',
      'coreLibraryDesugaringEnabled true',
      "coreLibraryDesugaring 'com.android.tools:desugar_jdk_libs:2.1.5'",
    ].join('\n'),
  },
  {
    path: 'android/app/build.gradle',
    patterns: [
      /coreLibraryDesugaringEnabled true/,
      /coreLibraryDesugaring 'com\.android\.tools:desugar_jdk_libs:2\.1\.5'/,
    ],
    fixture: [
      '// @generated-by-laoji-java-time-desugaring',
      '// CAL-EDIT-TIME-001 / CAL-REPEAT-RRULE-001',
      'coreLibraryDesugaringEnabled true',
      "coreLibraryDesugaring 'com.android.tools:desugar_jdk_libs:2.1.5'",
    ].join('\n'),
  },
  {
    path: 'plugins/withLaojiNativePlatform.js',
    patterns: [
      /coreLibraryDesugaringEnabled true/,
      /coreLibraryDesugaring 'com\.android\.tools:desugar_jdk_libs:2\.1\.5'/,
    ],
    fixture: [
      '// CAL-EDIT-TIME-001 / CAL-REPEAT-RRULE-001',
      "const desugarMarker = '// @generated-by-laoji-java-time-desugaring'",
      'coreLibraryDesugaringEnabled true',
      "coreLibraryDesugaring 'com.android.tools:desugar_jdk_libs:2.1.5'",
    ].join('\n'),
  },
];

const FORBIDDEN_CALENDAR_SYSTEM_PICKER_PATTERNS = [
  /\bDatePickerDialog\b/,
  /\bTimePickerDialog\b/,
  /android\.widget\.DatePicker\b/,
  /android\.widget\.TimePicker\b/,
  /android\.widget\.NumberPicker\b/,
  /import\s+android\.widget\.(?:DatePicker|TimePicker|NumberPicker)\b/,
  /\b(?:DatePicker|TimePicker|NumberPicker)\s*\(/,
];

const FORBIDDEN_EXPORTED_OVERLAY_TOKENS = [
  'LaojiNativeDialogHost',
  'LaojiNativeActionSheetHost',
  'LaojiScheduleVoiceView',
  'LaojiCalendarSearchView',
];

const REQUIRED_NATIVE_FRAME_ROOTS = [
  {
    path: 'modules/laoji-native-platform/android/src/main/java/com/laoji/nativeplatform/ui/NativeOverlayHosts.kt',
    patterns: [
      /protected val overlayRoot = FrameLayout\(context\)/,
      /overlayRoot\.addView\(mask,/,
      /overlayRoot\.addView\(card, cardParams\)/,
      /overlayRoot\.addView\(outer, frameParams\)/,
      /requestInsetsWhenAttached\(\)/,
      /if \(closing\)/,
      /override fun onNavigationInsetChanged\(\)/,
    ],
  },
  {
    path: 'modules/laoji-native-platform/android/src/main/java/com/laoji/nativeplatform/schedulevoice/ScheduleVoiceHostView.kt',
    patterns: [
      /private val overlayRoot = FrameLayout\(context\)/,
      /overlayRoot\.addView\(backdrop,/,
      /overlayRoot\.addView\(\s*sheet,/,
    ],
  },
];

const REQUIRED_EXPO_VIEW_HOSTS = [
  'modules/laoji-native-platform/android/src/main/java/com/laoji/nativeplatform/calendar/CalendarHostView.kt',
  'modules/laoji-native-platform/android/src/main/java/com/laoji/nativeplatform/minutes/LaojiMinutesView.kt',
  'modules/laoji-native-platform/android/src/main/java/com/laoji/nativeplatform/LaojiSpeakerModule.kt',
  'modules/laoji-native-platform/android/src/main/java/com/laoji/nativeplatform/schedulevoice/ScheduleVoiceHostView.kt',
  'modules/laoji-native-platform/android/src/main/java/com/laoji/nativeplatform/ui/NativeOverlayHosts.kt',
  'modules/laoji-native-platform/android/src/main/java/com/laoji/nativeplatform/ui/NativeBottomBarView.kt',
  'modules/laoji-native-platform/android/src/main/java/com/laoji/nativeplatform/calendarpages/CalendarDetailPageView.kt',
  'modules/laoji-native-platform/android/src/main/java/com/laoji/nativeplatform/calendarpages/CalendarEditPageView.kt',
  'modules/laoji-native-platform/android/src/main/java/com/laoji/nativeplatform/calendarpages/CalendarSearchPageView.kt',
];

const BANNED_ANDROID_PATTERNS = [
  [/\bPanResponder\b/, 'PanResponder'],
  [/\bModal\b/, 'React Native Modal'],
  [/\bKeyboardAvoidingView\b/, 'React Native overlay layout'],
  [/from\s+['"][^'"]*\/components\/CalendarSearchPage['"]/, 'legacy calendar search'],
  [/DayTimelineView/, 'legacy day timeline'],
  [/MeetingAudioPlayerDock/, 'legacy meeting player'],
  [/MinutesDetailTitleBar/, 'legacy Minutes title bar'],
  [/QuickDatePanel/, 'legacy quick date panel'],
  [/ScheduleCreateButton/, 'legacy schedule create button'],
  [/react-native-live-audio-stream/, 'legacy PCM bridge'],
  [/expo-av/, 'legacy Expo AV runtime'],
];

const BANNED_TOAST_ACTION_PATTERNS = [
  /NativeToastActionSnapshot/,
  /toastAction/,
  /actionLabel/,
  /onToastAction/,
];

const BANNED_TOAST_COMPONENT_ACTION_PATTERNS = [
  /\baction\s*\??\s*:/,
  /\bonAction\b/,
  /setActionListener/,
];

function read(root, relativePath) {
  return fs.readFileSync(path.join(root, relativePath), 'utf8');
}

function walk(directory, predicate = () => true) {
  if (!fs.existsSync(directory)) return [];
  const files = [];
  const pending = [directory];
  while (pending.length > 0) {
    const current = pending.pop();
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) pending.push(fullPath);
      else if (predicate(fullPath)) files.push(fullPath);
    }
  }
  return files.sort();
}

function withoutComments(source) {
  let result = '';
  let quote = null;
  let escaped = false;
  for (let index = 0; index < source.length; index += 1) {
    const current = source[index];
    const next = source[index + 1];
    if (quote) {
      result += current;
      if (escaped) escaped = false;
      else if (current === '\\') escaped = true;
      else if (current === quote) quote = null;
      continue;
    }
    if (current === '"' || current === "'" || current === '`') {
      quote = current;
      result += current;
      continue;
    }
    if (current === '/' && next === '/') {
      while (index < source.length && source[index] !== '\n') index += 1;
      result += '\n';
      continue;
    }
    if (current === '/' && next === '*') {
      index += 2;
      while (index < source.length - 1 && !(source[index] === '*' && source[index + 1] === '/')) index += 1;
      index += 1;
      result += ' ';
      continue;
    }
    result += current;
  }
  return result;
}

function auditAndroidNativeBoundary(root) {
  const failures = [];
  const packageJson = JSON.parse(read(root, 'package.json'));
  const dependencies = { ...packageJson.dependencies, ...packageJson.devDependencies };
  for (const dependency of ['expo-av', 'react-native-live-audio-stream']) {
    if (dependencies[dependency]) failures.push(`legacy dependency remains: ${dependency}`);
  }

  const appConfig = read(root, 'app.config.js');
  if (/['"]expo-av['"]/.test(appConfig)) failures.push('app config still registers expo-av');

  for (const relativePath of REQUIRED_ANDROID_SURFACES) {
    const absolutePath = path.join(root, relativePath);
    if (!fs.existsSync(absolutePath)) {
      failures.push(`missing Android-native surface: ${relativePath}`);
      continue;
    }
    const source = fs.readFileSync(absolutePath, 'utf8');
    for (const [pattern, label] of BANNED_ANDROID_PATTERNS) {
      if (pattern.test(source)) failures.push(`${relativePath} references ${label}`);
    }
  }

  for (const relativePath of REQUIRED_NATIVE_SURFACE_CONTAINERS) {
    const source = read(root, relativePath);
    if (!/collapsable=\{false\}/.test(source) || !/collapsableChildren=\{false\}/.test(source)) {
      failures.push(`${relativePath} allows Fabric to flatten its native surface container`);
    }
  }

  const moduleConfig = JSON.parse(read(root, 'modules/laoji-native-platform/expo-module.config.json'));
  const registeredModules = new Set(moduleConfig.android?.modules ?? []);
  for (const moduleName of REQUIRED_NATIVE_MODULES) {
    if (!registeredModules.has(moduleName)) failures.push(`native module is not registered: ${moduleName}`);
  }
  const unexpectedModules = [...registeredModules].filter(moduleName => !REQUIRED_NATIVE_MODULES.includes(moduleName));
  if (unexpectedModules.length > 0) {
    failures.push(`unexpected native modules bypass the reviewed boundary: ${unexpectedModules.join(', ')}`);
  }

  for (const contract of REQUIRED_WINDOW_OVERLAY_CONTRACTS) {
    const source = read(root, contract.path);
    for (const pattern of contract.patterns) {
      if (!pattern.test(source)) {
        failures.push(`${contract.path} does not implement the Activity window overlay contract`);
        break;
      }
    }
  }

  for (const contract of REQUIRED_RUNTIME_SMOKE_CONTRACTS) {
    const source = read(root, contract.path);
    for (const pattern of contract.patterns) {
      if (!pattern.test(source)) {
        failures.push(`${contract.path} does not retain the runtime rendering contract`);
        break;
      }
    }
  }

  const overlayBridgeSources = [
    'modules/laoji-native-platform/src/ui.ts',
    'modules/laoji-native-platform/src/scheduleVoice.ts',
    'modules/laoji-native-platform/src/calendarPages.ts',
    'src/components/AppDialog.android.tsx',
    'src/components/AppActionSheet.android.tsx',
    'src/components/AppToast.android.tsx',
    'src/components/VoiceInputModal.android.tsx',
    'src/screens/ScheduleScreen.android.tsx',
  ].map(relativePath => [relativePath, read(root, relativePath)]);
  for (const [relativePath, source] of overlayBridgeSources) {
    for (const token of FORBIDDEN_EXPORTED_OVERLAY_TOKENS) {
      if (source.includes(token)) failures.push(`${relativePath} mounts obsolete exported overlay ${token}`);
    }
  }
  for (const relativePath of [
    'modules/laoji-native-platform/src/ui.ts',
    'src/components/AppToast.android.tsx',
    'modules/laoji-native-platform/android/src/main/java/com/laoji/nativeplatform/ui/NativeToastHostView.kt',
  ]) {
    const source = read(root, relativePath);
    for (const pattern of BANNED_TOAST_ACTION_PATTERNS) {
      if (pattern.test(source)) {
        failures.push(`${relativePath} retains unsupported Android toast action API`);
      }
    }
  }
  for (const relativePath of [
    'src/components/AppToast.tsx',
    'src/components/AppToast.android.tsx',
    'modules/laoji-native-platform/android/src/main/java/com/laoji/nativeplatform/ui/NativeToastHostView.kt',
  ]) {
    const source = read(root, relativePath);
    for (const pattern of BANNED_TOAST_COMPONENT_ACTION_PATTERNS) {
      if (pattern.test(source)) {
        failures.push(`${relativePath} exposes an unsupported toast action contract`);
      }
    }
  }
  const nativeViewManagerSources = [
    ...walk(path.join(root, 'modules/laoji-native-platform/src'), file => file.endsWith('.ts') || file.endsWith('.tsx')),
    ...walk(path.join(root, 'src'), file => file.endsWith('.android.tsx') || file.endsWith('.android.ts')),
  ];
  for (const file of nativeViewManagerSources) {
    const source = fs.readFileSync(file, 'utf8');
    for (const match of source.matchAll(/requireNativeViewManager(?:<[^>]+>)?\s*\(\s*['"]([^'"]+)['"]/g)) {
      if (/(Dialog|Sheet|Overlay|ScheduleVoice|CalendarSearch|Toast)/i.test(match[1])) {
        failures.push(`${path.relative(root, file)} exports window overlay view manager: ${match[1]}`);
      }
    }
  }
  const uiModuleSource = read(
    root,
    'modules/laoji-native-platform/android/src/main/java/com/laoji/nativeplatform/ui/LaojiUiModule.kt',
  );
  if (/\bView\s*\(/.test(uiModuleSource)) {
    failures.push('LaojiUiModule still exports a Fabric overlay view manager');
  }
  const nativeModuleFiles = walk(
    path.join(root, 'modules/laoji-native-platform/android/src/main/java'),
    file => file.endsWith('Module.kt'),
  );
  for (const file of nativeModuleFiles) {
    const source = fs.readFileSync(file, 'utf8');
    if (/\bView\s*\(/.test(source) && /(DialogHost|ActionSheet|ScheduleVoiceHost|CalendarSearchPage|ToastHost)/.test(source)) {
      failures.push(`${path.relative(root, file)} exports a window-owned overlay as a View Manager`);
    }
  }

  const nativeKotlinFiles = walk(
    path.join(root, 'modules/laoji-native-platform/android/src/main/java'),
    file => file.endsWith('.kt'),
  );
  for (const file of nativeKotlinFiles) {
    const source = fs.readFileSync(file, 'utf8');
    if (/android\.widget\.Toast|\bToast\.makeText\b/.test(source)) {
      failures.push(`${path.relative(root, file)} bypasses the Activity-owned toast host`);
    }
  }

  for (const contract of REQUIRED_NATIVE_FRAME_ROOTS) {
    const source = read(root, contract.path);
    for (const pattern of contract.patterns) {
      if (!pattern.test(source)) {
        failures.push(`${contract.path} does not keep full-screen siblings inside its FrameLayout owner`);
        break;
      }
    }
  }

  for (const relativePath of REQUIRED_EXPO_VIEW_HOSTS) {
    const source = read(root, relativePath);
    if (!/setWillNotDraw\(false\)/.test(source) || !/clipToPadding\s*=\s*false/.test(source)) {
      failures.push(`${relativePath} can skip or clip Android-managed child rendering inside ExpoView`);
    }
  }

  const capabilitySource = read(
    root,
    'modules/laoji-native-platform/android/src/main/java/com/laoji/nativeplatform/LaojiNativePlatformModule.kt',
  );
  for (const capability of ['calendarSurface', 'minutesSurface', 'nativeAudioRuntime', 'mediaPlayer']) {
    const enabled = new RegExp(`"${capability}"\\s+to\\s+true`).test(capabilitySource);
    if (!enabled) failures.push(`native runtime capability is not enabled: ${capability}`);
  }

  const navigationSource = read(root, 'src/navigation/index.tsx');
  if (/name=["']Recording["']/.test(navigationSource)) {
    failures.push('orphan Recording route remains registered');
  }

  const meetingRecordingRoute = read(root, 'src/screens/MeetingLiveScreen.android.tsx');
  if (/addNativeRecorderLevelListener|levelSamples(?:Ref)?/.test(meetingRecordingRoute)) {
    failures.push('meeting recording still sends high-frequency native levels through React state');
  }
  if (!/nativeAudioBarsRef/.test(meetingRecordingRoute) || !/getAudioBars: \(\) => nativeAudioBarsRef\.current/.test(meetingRecordingRoute)) {
    failures.push('meeting recording does not consume the one-shot native audioBars stop result');
  }
  const minutesSnapshotSource = read(root, 'src/native/nativeMinutesSnapshots.ts');
  const nativeMinutesTypes = read(root, 'modules/laoji-native-platform/src/minutes.ts');
  if (/audioSamplesToBars|waveform\s*:/.test(minutesSnapshotSource) || /waveform\?: readonly number\[\]/.test(nativeMinutesTypes)) {
    failures.push('meeting waveform still travels through the low-frequency JS snapshot boundary');
  }

  for (const contract of REQUIRED_NATIVE_RECORDER_BRIDGE_CONTRACTS) {
    const source = read(root, contract.path);
    for (const pattern of contract.patterns) {
      if (!pattern.test(source)) {
        failures.push(`${contract.path} violates the native recorder level-flow contract`);
        break;
      }
    }
  }

  for (const relativePath of FORBIDDEN_NATIVE_CALENDAR_FILES) {
    if (fs.existsSync(path.join(root, relativePath))) {
      failures.push(`obsolete single-owner calendar surface remains: ${relativePath}`);
    }
  }
  for (const contract of REQUIRED_NATIVE_CALENDAR_CONTRACTS) {
    const source = read(root, contract.path);
    for (const pattern of contract.patterns) {
      if (!pattern.test(source)) {
        failures.push(`${contract.path} violates the source-derived native calendar composition contract`);
        break;
      }
    }
  }

  for (const contract of REQUIRED_NATIVE_MINUTES_DETAIL_CONTRACTS) {
    const source = read(root, contract.path);
    for (const pattern of contract.patterns) {
      if (!pattern.test(source)) {
        failures.push(`${contract.path} violates the source-derived Minutes detail ownership contract`);
        break;
      }
    }
  }

  for (const contract of REQUIRED_PLAYER_RECOVERY_CONTRACTS) {
    const source = withoutComments(read(root, contract.path));
    for (const pattern of contract.patterns) {
      if (!pattern.test(source)) {
        failures.push(`${contract.path} violates MIN-PLAYER-RECOVERY-001`);
        break;
      }
    }
  }
  const encryptedRecoverySource = withoutComments(read(
    root,
    'modules/laoji-native-platform/android/src/main/java/com/laoji/nativeplatform/media/EncryptedMinutesPlaybackStore.kt',
  ));
  if (/SharedPreferences|getSharedPreferences\s*\(/.test(encryptedRecoverySource)) {
    failures.push('MIN-PLAYER-RECOVERY-001 stores source recovery through SharedPreferences');
  }
  if (/AES\/(?:CBC|ECB)|DESede|RSA\/ECB/.test(encryptedRecoverySource)) {
    failures.push('MIN-PLAYER-RECOVERY-001 recovery encryption is not authenticated AES/GCM');
  }
  const mediaRoot = path.join(
    root,
    'modules/laoji-native-platform/android/src/main/java/com/laoji/nativeplatform/media',
  );
  for (const file of walk(mediaRoot, value => value.endsWith('.kt'))) {
    if (file.endsWith('MinutesPlaybackScopeStore.kt')) continue;
    const source = withoutComments(fs.readFileSync(file, 'utf8'));
    if (
      /getSharedPreferences\s*\(|\bSharedPreferences\b/.test(source) &&
      /\b(?:uri|headers?|authorization|bearer|token|sourceId)\b/i.test(source)
    ) {
      failures.push(`${path.relative(root, file)} can persist plaintext player source data in SharedPreferences`);
    }
  }
  const transcriptionRecoverySource = withoutComments(read(root, 'src/screens/TranscriptionScreen.android.tsx'));
  if (/sourceId\s*:\s*`cloud:[^`]*(?:info\.url|uri)/.test(transcriptionRecoverySource)) {
    failures.push('MIN-PLAYER-RECOVERY-001 cloud sourceId includes an unstable signed URL');
  }

  for (const contract of REQUIRED_CAL_EDIT_TIME_CONTRACTS) {
    const source = withoutComments(read(root, contract.path));
    for (const pattern of contract.patterns) {
      if (!pattern.test(source)) {
        failures.push(`${contract.path} violates CAL-EDIT-TIME-001`);
        break;
      }
    }
  }
  const calendarEditSource = withoutComments(read(
    root,
    'modules/laoji-native-platform/android/src/main/java/com/laoji/nativeplatform/calendarpages/CalendarEditPageView.kt',
  ));
  const startEntries = calendarEditSource.match(/showTimePage\(CalendarEditEndpoint\.START\)/g) ?? [];
  const endEntries = calendarEditSource.match(/showTimePage\(CalendarEditEndpoint\.END\)/g) ?? [];
  if (startEntries.length !== 2 || endEntries.length !== 2) {
    failures.push(`CAL-EDIT-TIME-001 expected four edit-time entries, found ${startEntries.length + endEntries.length}`);
  }
  const childPageFields = [...calendarEditSource.matchAll(
    /private var (\w+Page): ([A-Za-z0-9_]+PageView)\? = null/g,
  )].map(match => `${match[1]}:${match[2]}`).sort();
  const expectedChildPageFields = [
    'repeatEndPage:CalendarRepeatEndPageView',
    'timePage:CalendarEditTimePageView',
  ];
  if (JSON.stringify(childPageFields) !== JSON.stringify(expectedChildPageFields)) {
    failures.push(
      `CAL-EDIT-TIME-001/CAL-REPEAT-RRULE-001 unexpected native edit child pages: ${childPageFields.join(', ')}`,
    );
  }
  const calendarPagesRoot = path.join(
    root,
    'modules/laoji-native-platform/android/src/main/java/com/laoji/nativeplatform/calendarpages',
  );
  for (const file of walk(calendarPagesRoot, value => value.endsWith('.kt'))) {
    const source = withoutComments(fs.readFileSync(file, 'utf8'));
    if (FORBIDDEN_CALENDAR_SYSTEM_PICKER_PATTERNS.some(pattern => pattern.test(source))) {
      failures.push(`${path.relative(root, file)} uses a forbidden system Picker under CAL-EDIT-TIME-001`);
    }
  }
  const minutesDetailRoot = path.join(
    root,
    'modules/laoji-native-platform/android/src/main/java/com/laoji/nativeplatform/minutes',
  );
  for (const file of walk(minutesDetailRoot, value => value.endsWith('.kt'))) {
    const source = fs.readFileSync(file, 'utf8');
    if (FORBIDDEN_NATIVE_MINUTES_DETAIL_PATTERNS.some(pattern => pattern.test(source))) {
      failures.push(`obsolete single-list Minutes detail owner remains: ${path.relative(root, file)}`);
    }
  }

  const androidTabsSource = read(root, 'src/navigation/MainTabs.android.tsx');
  if (
    /createBottomTabNavigator/.test(androidTabsSource) ||
    /LaojiNativeMainContainer|LaojiNativeBottomBar/.test(androidTabsSource) ||
    !/<ScheduleScreen\s+navigation=\{navigation\}\s+onTabPress=\{handleTabPress\}/.test(androidTabsSource) ||
    !/<MeetingListScreen\s+navigation=\{navigation\}\s+onTabPress=\{handleTabPress\}/.test(androidTabsSource) ||
    /<View\b/.test(androidTabsSource)
  ) {
    failures.push('Android tabs can enter a multi-root Fabric blank-surface path');
  }

  for (const relativePath of [
    'modules/laoji-native-platform/android/src/main/java/com/laoji/nativeplatform/calendar/CalendarHostView.kt',
    'modules/laoji-native-platform/android/src/main/java/com/laoji/nativeplatform/minutes/LaojiMinutesView.kt',
  ]) {
    const tabRootSource = read(root, relativePath);
    for (const pattern of [
      /LaojiNativeBottomBarView\(context, appContext\)/,
      /setBridgeEventsEnabled\(false\)/,
      /setTabPressListener/,
      /installStatusBarInsetPadding(?:\(\)|\s*\{)/,
      /addView\(bottomBar/,
    ]) {
      if (!pattern.test(tabRootSource)) {
        failures.push(`${relativePath} does not own one internal bottom bar and its system inset`);
        break;
      }
    }
  }

  const insetSource = read(
    root,
    'modules/laoji-native-platform/android/src/main/java/com/laoji/nativeplatform/ui/NativeSystemInsets.kt',
  );
  for (const pattern of [
    /WeakHashMap<View, View\.OnAttachStateChangeListener>/,
    /addOnAttachStateChangeListener/,
    /view\.requestApplyInsets\(\)/,
    /if \(isAttachedToWindow\) requestApplyInsets\(\)/,
  ]) {
    if (!pattern.test(insetSource)) {
      failures.push('native tab roots do not request insets when attached after the first window dispatch');
      break;
    }
  }
  const bottomBarSource = read(
    root,
    'modules/laoji-native-platform/android/src/main/java/com/laoji/nativeplatform/ui/NativeBottomBarView.kt',
  );
  if (!/requestInsetsWhenAttached\(\)/.test(bottomBarSource)) {
    failures.push('internal bottom bar does not request navigation insets after tab replacement');
  }

  const minutesRootSource = read(
    root,
    'modules/laoji-native-platform/android/src/main/java/com/laoji/nativeplatform/minutes/LaojiMinutesView.kt',
  );
  for (const pattern of [
    /visibility = View\.GONE/,
    /installStatusBarInsetPadding \{ surfaceName == MinutesSurface\.LIST\.wireName \}/,
    /bottomBar\.visibility = if \(value == MinutesSurface\.LIST\.wireName\)/,
  ]) {
    if (!pattern.test(minutesRootSource)) {
      failures.push('Minutes recording/detail can flash a bottom bar or double-apply status insets');
      break;
    }
  }

  const audioRoot = path.join(
    root,
    'modules/laoji-native-platform/android/src/main/java/com/laoji/nativeplatform/audio',
  );
  for (const file of walk(audioRoot, value => value.endsWith('.kt'))) {
    const source = fs.readFileSync(file, 'utf8');
    if (/android\.util\.Base64|java\.util\.Base64/.test(source)) {
      failures.push(`${path.relative(root, file)} encodes PCM through Base64`);
    }
  }

  const kotlinRoot = path.join(
    root,
    'modules/laoji-native-platform/android/src/main/java/com/laoji/nativeplatform',
  );
  const kotlinTestRoot = path.join(
    root,
    'modules/laoji-native-platform/android/src/test/java/com/laoji/nativeplatform',
  );
  for (const file of [
    ...walk(kotlinRoot, value => value.endsWith('.kt')),
    ...walk(kotlinTestRoot, value => value.endsWith('.kt')),
  ]) {
    const source = fs.readFileSync(file, 'utf8');
    if (!/(?:CAL|MIN|UI)-[A-Z0-9-]+-\d{3}/.test(source)) {
      failures.push(`${path.relative(root, file)} has no source evidence ID`);
    }
    if (/android\.R\.drawable\.ic_media_previous/.test(source)) {
      failures.push(`${path.relative(root, file)} uses a media-previous icon for navigation`);
    }
  }
  const playerOwners = walk(kotlinRoot, value => value.endsWith('.kt'))
    .filter(file => /\bExoPlayer\.Builder\s*\(/.test(fs.readFileSync(file, 'utf8')))
    .map(file => path.relative(root, file));
  if (playerOwners.length !== 1) {
    failures.push(`expected one ExoPlayer owner, found ${playerOwners.length}: ${playerOwners.join(', ')}`);
  }

  const gradle = read(root, 'modules/laoji-native-platform/android/build.gradle');
  const media3Versions = [...gradle.matchAll(/androidx\.media3:[^:'"]+:([0-9.]+)/g)]
    .map(match => match[1]);
  if (media3Versions.length === 0) failures.push('Media3 dependencies are missing');
  if (new Set(media3Versions).size > 1) {
    failures.push(`multiple declared Media3 versions: ${[...new Set(media3Versions)].join(', ')}`);
  }
  for (const dependency of [
    'org.jetbrains.kotlinx:kotlinx-coroutines-core:1.7.3',
    'org.jetbrains.kotlinx:kotlinx-coroutines-android:1.7.3',
  ]) {
    if (!gradle.includes(dependency)) failures.push(`native recorder Flow dependency is not pinned: ${dependency}`);
  }

  return {
    ok: failures.length === 0,
    failures,
    checkedAndroidSurfaces: REQUIRED_ANDROID_SURFACES.length,
    checkedNativeSurfaceContainers: REQUIRED_NATIVE_SURFACE_CONTAINERS.length,
    registeredNativeModules: registeredModules.size,
    checkedWindowOverlayContracts: REQUIRED_WINDOW_OVERLAY_CONTRACTS.length,
    checkedRuntimeSmokeContracts: REQUIRED_RUNTIME_SMOKE_CONTRACTS.length,
    checkedNativeRecorderBridgeContracts: REQUIRED_NATIVE_RECORDER_BRIDGE_CONTRACTS.length,
    checkedNativeCalendarContracts: REQUIRED_NATIVE_CALENDAR_CONTRACTS.length,
    checkedNativeMinutesDetailContracts: REQUIRED_NATIVE_MINUTES_DETAIL_CONTRACTS.length,
    checkedPlayerRecoveryContracts: REQUIRED_PLAYER_RECOVERY_CONTRACTS.length,
    checkedCalendarEditTimeContracts: REQUIRED_CAL_EDIT_TIME_CONTRACTS.length,
    checkedNativeFrameRoots: REQUIRED_NATIVE_FRAME_ROOTS.length,
    checkedExpoViewHosts: REQUIRED_EXPO_VIEW_HOSTS.length,
    exoPlayerOwners: playerOwners,
  };
}

function main() {
  const rootIndex = process.argv.indexOf('--root');
  const root = path.resolve(rootIndex >= 0 ? process.argv[rootIndex + 1] : path.join(__dirname, '..'));
  const report = auditAndroidNativeBoundary(root);
  console.log(JSON.stringify(report, null, 2));
  if (!report.ok) process.exitCode = 1;
}

module.exports = {
  BANNED_ANDROID_PATTERNS,
  REQUIRED_ANDROID_SURFACES,
  REQUIRED_NATIVE_SURFACE_CONTAINERS,
  REQUIRED_NATIVE_MODULES,
  REQUIRED_NATIVE_FRAME_ROOTS,
  REQUIRED_EXPO_VIEW_HOSTS,
  REQUIRED_WINDOW_OVERLAY_CONTRACTS,
  REQUIRED_RUNTIME_SMOKE_CONTRACTS,
  REQUIRED_NATIVE_RECORDER_BRIDGE_CONTRACTS,
  REQUIRED_NATIVE_CALENDAR_CONTRACTS,
  FORBIDDEN_NATIVE_CALENDAR_FILES,
  REQUIRED_NATIVE_MINUTES_DETAIL_CONTRACTS,
  FORBIDDEN_NATIVE_MINUTES_DETAIL_PATTERNS,
  REQUIRED_PLAYER_RECOVERY_CONTRACTS,
  REQUIRED_CAL_EDIT_TIME_CONTRACTS,
  FORBIDDEN_CALENDAR_SYSTEM_PICKER_PATTERNS,
  FORBIDDEN_EXPORTED_OVERLAY_TOKENS,
  auditAndroidNativeBoundary,
};

if (require.main === module) main();
