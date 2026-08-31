#!/usr/bin/env node

/*
 * Deterministic checks for previously observed continuity regressions.
 *
 * This is deliberately not a semantic-copy oracle. The information-ownership
 * audit and rendered review decide whether two differently worded messages
 * repeat one meaning. These checks only pin the shared mechanisms that must
 * remain true once that review has found a concrete structural defect.
 */

const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const read = relative => fs.readFileSync(path.join(root, relative), 'utf8');
const failures = [];

function requireText(source, value, rule) {
  if (!source.includes(value)) failures.push(`missing:${rule}`);
}

function forbidText(source, value, rule) {
  if (source.includes(value)) failures.push(`forbidden:${rule}`);
}

function forbidPath(relative, rule) {
  if (fs.existsSync(path.join(root, relative))) failures.push(`forbidden-path:${rule}`);
}

function requireOrder(source, values, rule) {
  let cursor = -1;
  for (const value of values) {
    const next = source.indexOf(value, cursor + 1);
    if (next < 0 || next <= cursor) {
      failures.push(`order:${rule}`);
      return;
    }
    cursor = next;
  }
}

const projectionHook = read('src/native/useNativeProjection.ts');
const projectionEnvelope = read('src/native/projectionEnvelope.ts');
const detailScreen = read('src/screens/TranscriptionScreen.android.tsx');
const sessionCache = read('src/services/meetingDetailSessionCache.ts');
const titleBar = read(
  'modules/laoji-native-platform/android/src/main/java/com/laoji/nativeplatform/minutes/MinutesUiKit.kt',
);
const meetingCards = read(
  'modules/laoji-native-platform/android/src/main/java/com/laoji/nativeplatform/minutes/MinutesAdapters.kt',
);
const summaryPage = read(
  'modules/laoji-native-platform/android/src/main/java/com/laoji/nativeplatform/minutes/MinutesDetailPages.kt',
);
const minutesView = read(
  'modules/laoji-native-platform/android/src/main/java/com/laoji/nativeplatform/minutes/LaojiMinutesView.kt',
);
const minutesState = read(
  'modules/laoji-native-platform/android/src/main/java/com/laoji/nativeplatform/minutes/MinutesState.kt',
);
const detailPager = read(
  'modules/laoji-native-platform/android/src/main/java/com/laoji/nativeplatform/minutes/MinutesDetailPager.kt',
);
const detailSurface = read(
  'modules/laoji-native-platform/android/src/main/java/com/laoji/nativeplatform/minutes/MinutesDetailSurface.kt',
);
const meetingsStore = read('src/store/MeetingsStore.tsx');
const meetingListScreen = read('src/screens/MeetingListScreen.android.tsx');
const meetingListProjection = read('src/services/meetingListProjection.ts');
const meetingRepository = read('src/data/repositories/sqliteMeetingNoteRepository.ts');
const deviceV2Api = read('src/services/deviceV2Api.ts');
const deviceAuthModule = read(
  'modules/laoji-native-platform/android/src/main/java/com/laoji/nativeplatform/LaojiDeviceAuthModule.kt',
);
const startupProjectionStart = meetingsStore.indexOf('async function loadForScope()');
const startupProjectionEnd = meetingsStore.indexOf('const createMeeting = useCallback', startupProjectionStart);
const startupProjection = startupProjectionStart >= 0 && startupProjectionEnd > startupProjectionStart
  ? meetingsStore.slice(startupProjectionStart, startupProjectionEnd)
  : '';
const deviceSessionStart = deviceV2Api.indexOf('export async function ensureDeviceV2Session()');
const deviceSessionEnd = deviceV2Api.indexOf('export async function deviceV2Request', deviceSessionStart);
const deviceSession = deviceSessionStart >= 0 && deviceSessionEnd > deviceSessionStart
  ? deviceV2Api.slice(deviceSessionStart, deviceSessionEnd)
  : '';

// Shared native projections must not serialize a full screen snapshot during
// render or hash the same immutable payload twice.
requireText(projectionHook, 'InteractionManager.runAfterInteractions', 'projection-after-interaction');
requireText(projectionHook, 'projectionPayloadSha256(payloadSnapshot)', 'projection-single-hash-owner');
requireText(projectionHook, 'setProjection({ source: payloadSnapshot, envelope })', 'projection-source-identity');
forbidText(projectionHook, 'stableProjectionJson(snapshot)', 'projection-render-path-serialization');
requireText(projectionEnvelope, 'payloadSha256?: string;', 'projection-precomputed-hash-contract');
requireText(
  projectionEnvelope,
  'payloadSha256: input.payloadSha256 ?? await projectionPayloadSha256(payload)',
  'projection-precomputed-hash-reuse',
);

// Re-entering a meeting in the same app process starts from the exact document
// and tab that were visible, then reconciles canonical storage in place.
requireText(sessionCache, 'const MAX_SESSIONS = 24;', 'bounded-detail-session-cache');
requireText(detailScreen, 'initialDetailSession?.activeTab', 'detail-restores-active-tab');
requireText(detailScreen, 'initialDetailSession?.summaryDocument', 'detail-restores-visible-document');
requireText(detailScreen, 'rememberMeetingDetailSession(recordingStorageScope, meeting.id', 'detail-remembers-visible-session');
requireText(
  detailScreen,
  'const cachedSummaryDocument = retainedSession?.summaryDocument',
  'detail-loader-preserves-visible-document',
);
requireText(detailScreen, 'InteractionManager.runAfterInteractions', 'detail-defers-inactive-payload');
requireText(detailScreen, 'transcript: snapshotTranscript', 'detail-inactive-transcript-projection');
requireText(detailScreen, 'if (deferInitialDetailHydration) return;', 'detail-defers-inactive-hydration');
requireText(
  detailScreen,
  "initialActiveTab === 'transcript' || initialActiveTab === 'speakers'",
  'detail-keeps-focused-transcript-eager',
);

// A back gesture is navigation. Autosave continues independently and must not
// hold the transition hostage.
requireText(detailScreen, 'void manualNote.flush();\n        navigation.goBack();', 'detail-nonblocking-back');
forbidText(detailScreen, 'manualNote.flush().finally(() => navigation.goBack())', 'detail-blocking-back');

// Permanent actions stay adjacent in permanent slots. Conditional search sits
// at the edge and only changes visibility.
requireOrder(
  titleBar,
  [
    'rightActions.addView(searchButton',
    'rightActions.addView(moreButton',
    'rightActions.addView(shareButton',
  ],
  'detail-action-permanence-order',
);
requireText(titleBar, 'searchButton.visibility = if (showSearch) View.VISIBLE else View.INVISIBLE', 'detail-search-retained-slot');
forbidText(titleBar, 'rightActions.removeAllViews()', 'detail-action-row-remount');
requireText(meetingCards, 'root.foreground = RippleDrawable(', 'meeting-open-immediate-press-feedback');

// Snapshot authentication and tab persistence may update their owners without
// traversing the visible tree. Native user tab selection must not round-trip a
// full transcript/summary snapshot through React, and inactive pages must not
// be reconstructed by a fixed main-thread timer after navigation.
requireText(minutesView, 'sameVisibleSurface(previous, next)', 'native-host-skips-nonvisual-commit');
requireText(minutesState, 'if (!acceptProjection(current, mutation.state)) return current', 'native-state-reject-is-noop');
requireText(minutesState, 'currentProjection.payloadSha256 == incomingProjection.payloadSha256', 'native-state-hash-noop');
requireText(detailPager, 'private val pages = linkedMapOf<MinutesDetailTab, MinutesDetailPage>()', 'detail-pages-lazy-owner');
forbidText(detailPager, 'MinutesDetailTab.NOTES to MinutesNotesPage', 'detail-pages-eager-construction');
requireText(detailPager, 'renderIfNeeded(state.activeTab, page, state)', 'detail-only-active-page-reconciles');
forbidText(detailSurface, 'DETAIL_PAGE_PREWARM_START_MS', 'detail-fixed-delay-prewarm');
forbidText(detailSurface, 'prewarmRunnable', 'detail-main-thread-prewarm-loop');
requireText(
  detailSurface,
  'issueTabCommand(tab, nextTabGeneration(), smoothScroll = false, emit = true)',
  'detail-tab-press-atomic-transition',
);
requireText(detailScreen, 'rememberMeetingDetailActiveTab(recordingStorageScope, action.meetingId, action.tab)', 'detail-native-tab-lightweight-persistence');
forbidText(detailScreen, 'setTabGeneration(action.selectionGeneration);', 'detail-native-tab-react-roundtrip');
forbidText(detailScreen, 'setActiveTab(action.tab);', 'detail-native-tab-react-rerender');

// Cold start owns only the compact meeting root list. Pulling every transcript
// and summary across the native bridge before the first tap made an already
// visible Calendar ignore navigation for several seconds. Detail surfaces own
// their selected meeting body on demand.
requireText(startupProjection, "buildStableCanonicalMeetingProjection(scope, 'roots')", 'startup-meeting-roots-only');
forbidText(startupProjection, "buildStableCanonicalMeetingProjection(scope, 'full')", 'startup-no-all-meeting-bodies');
forbidText(startupProjection, 'loadCanonicalOwnedScope(', 'startup-no-full-projection-helper');
requireText(meetingRepository, 'AS current_summary_preview', 'meeting-list-bounded-summary-preview');
requireText(meetingRepository, 'SUBSTR(TRIM(COALESCE(section.user_text, section.generated_text)), 1, 220)', 'meeting-list-preview-is-bounded');
requireText(meetingListProjection, 'summaryCoverText: item.currentSummaryPreview ?? undefined', 'meeting-list-preview-crosses-compatibility-boundary');
requireText(meetingListScreen, 'meeting.summaryCoverText,', 'meeting-cover-consumes-list-preview');
forbidText(startupProjection, 'getCurrentSummaryContent(', 'startup-no-summary-body-fetch');
requireText(detailScreen, 'loadActiveMeetingTranscriptState(meetingScopeKey, meeting.id)', 'detail-loads-selected-transcript');
requireOrder(
  deviceSession,
  [
    'const cached = await readStoredSessionEnvelope(identity);',
    'const key = await getOrCreateDeviceKey(1);',
  ],
  'startup-reuses-valid-device-session-before-keystore',
);
for (const nativeOperation of ['getOrCreateKey', 'findProofOfWork', 'preparePurgeCapability', 'resumePurgeOnlyJournal']) {
  const operationStart = deviceAuthModule.indexOf(`AsyncFunction("${nativeOperation}")`);
  const operationEnd = deviceAuthModule.indexOf('\n    }', operationStart);
  const operationSource = operationStart >= 0 && operationEnd > operationStart
    ? deviceAuthModule.slice(operationStart, operationEnd)
    : '';
  requireText(operationSource, 'appContext.backgroundCoroutineScope.launch', `startup-native-${nativeOperation}-off-serial-queue`);
}

// Multiple facts are not automatically a Markdown list. Numbering remains
// available when ordering is meaningful; unordered content defaults to an
// editorial paragraph rhythm.
requireText(summaryPage, 'marker: String = ""', 'summary-authored-default-marker');
forbidText(summaryPage, 'marker: String = "•"', 'summary-default-markdown-bullet');
forbidText(summaryPage, 'else "•"', 'summary-generic-list-bullet');

// The unified summary has one adaptive editorial projection. Historical
// template identifiers may still be read at the storage/wire boundary, but
// the active detail surface must not expose a template selector or carry the
// retired native-selection field.
requireText(detailScreen, 'const summaryTemplate = DEFAULT_MEETING_TEMPLATE;', 'summary-single-adaptive-projection');
forbidText(detailScreen, 'canSelectSummaryTemplate', 'summary-template-selection-field');
forbidText(detailScreen, '<MeetingTemplateSheet', 'summary-template-sheet-mounted');
forbidPath('src/components/MeetingTemplateSheet.tsx', 'summary-template-sheet-source');
forbidText(detailScreen, '<MeetingSummaryBlocksSheet', 'summary-block-sheet-mounted');
forbidText(summaryPage, '选择整理板块', 'summary-block-selector');
forbidText(summaryPage, 'private val templateAction', 'summary-block-action-owner');
forbidText(summaryPage, 'renderedSummaryGenerating', 'summary-status-rebuilds-content');
forbidPath('src/components/MeetingSummaryBlocksSheet.tsx', 'summary-block-sheet-source');
forbidPath('src/services/meetingSummaryLayout.ts', 'summary-block-layout-source');

if (failures.length) {
  for (const failure of failures) process.stderr.write(`FAIL ${failure}\n`);
  process.exit(1);
}

process.stdout.write('PASS LaoJi UI continuity contract\n');
