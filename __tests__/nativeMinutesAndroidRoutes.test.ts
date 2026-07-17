import fs from 'fs';
import path from 'path';

const root = path.resolve(__dirname, '..');

function source(file: string): string {
  return fs.readFileSync(path.join(root, file), 'utf8');
}

describe('Android native Minutes route boundary', () => {
  it('keeps both route bodies on LaojiMinutesView and the public package root', () => {
    const recording = source('src/screens/MeetingLiveScreen.android.tsx');
    const detail = source('src/screens/TranscriptionScreen.android.tsx');
    for (const value of [recording, detail]) {
      expect(value).toContain('LaojiMinutesView');
      expect(value).toContain("from 'laoji-native-platform'");
      expect(value).not.toMatch(/from ['"]laoji-native-platform\/src\//);
      expect(value).not.toMatch(/\bModal\b|\bKeyboardAvoidingView\b|\bTextInput\b/);
    }
  });

  it('does not stop a native recorder from route removal or component cleanup', () => {
    const recording = source('src/screens/MeetingLiveScreen.android.tsx');
    expect(recording).not.toContain('beforeRemove');
    expect(recording).not.toContain('AppState');
    expect(recording).not.toMatch(/return \(\) => \{[^}]*activeRef\.current/s);
  });

  it('keeps continuous meeting levels out of React state and native snapshots [MIN-REC-BRIDGE-001]', () => {
    const recording = source('src/screens/MeetingLiveScreen.android.tsx');
    const snapshots = source('src/native/nativeMinutesSnapshots.ts');
    const nativeTypes = source('modules/laoji-native-platform/src/minutes.ts');
    expect(recording).not.toContain('addNativeRecorderLevelListener');
    expect(recording).not.toMatch(/levelSamples(?:Ref)?/);
    expect(snapshots).not.toContain('audioSamplesToBars');
    expect(snapshots).not.toContain('waveform:');
    expect(nativeTypes).not.toContain('waveform?: readonly number[]');
    expect(recording).toContain('getAudioBars: () => nativeAudioBarsRef.current');
  });

  it('syncs authenticated and guest transcripts before guest session deletion', () => {
    const recording = source('src/screens/MeetingLiveScreen.android.tsx');
    expect(recording).toContain('fetchMeetingTranscript');
    expect(recording).toContain('fetchGuestMeetingTranscript');
    expect(recording).toContain('mergePersistedMinutesTranscript');
    expect(recording).toContain('saveCachedTranscript');
    expect(recording.indexOf('fetchGuestMeetingTranscript')).toBeLessThan(
      recording.indexOf('deleteGuestRealtimeSession(guestSession.meeting_id'),
    );
  });

  it('keeps the native detail surface wired to summary, sharing, player, and speaker actions', () => {
    const detail = source('src/screens/TranscriptionScreen.android.tsx');
    for (const contract of [
      'runSummaryTask',
      "runShare('document')",
      "runShare('bundle')",
      'playerSource',
      'manageSpeaker',
      'deleteMeeting',
    ]) {
      expect(detail).toContain(contract);
    }
    expect(detail).not.toContain("case 'toggleSummaryTask'");
    expect(detail).not.toContain('总结为只读');
    expect(detail).not.toContain("case 'chapters'");
  });

  it('exposes one native list recording entry and routes it to MeetingLive', () => {
    const listSurface = source(
      'modules/laoji-native-platform/android/src/main/java/com/laoji/nativeplatform/minutes/MinutesListSurface.kt',
    );
    const adapter = source(
      'modules/laoji-native-platform/android/src/main/java/com/laoji/nativeplatform/minutes/MinutesAdapters.kt',
    );
    const listRoute = source('src/screens/MeetingListScreen.android.tsx');
    expect(listSurface.match(/"type" to "startRecording"/g)).toHaveLength(1);
    expect(listSurface).toContain('context.iconButton(android.R.drawable.ic_btn_speak_now, "开始录音")');
    expect(listRoute).toContain("case 'startRecording'");
    expect(listRoute).toContain("case 'openRecording'");
    expect(adapter).toContain('if (meeting.canResume) "openRecording" else "openMeeting"');
    expect(listRoute).toContain("navigation.navigate('MeetingLive')");
    expect(listRoute).not.toContain("label: '查看详情'");
    expect(listSurface).toContain('showNoSearchResults');
    expect(listSurface).toContain('未找到相关会议记录');
    expect(listSurface).toContain('recordButton.visibility = if (state.searching) View.GONE else View.VISIBLE');
  });

  it('returns an active foreground recording to an app-owned recovery path', () => {
    const service = source(
      'modules/laoji-native-platform/android/src/main/java/com/laoji/nativeplatform/audio/RecorderForegroundService.kt',
    );
    expect(service).toContain('packageManager.getLaunchIntentForPackage(packageName)');
    expect(service).toContain('.setContentIntent(contentIntent)');
  });

  it('makes a resolved MeetingLive session recoverable before native recording starts', () => {
    const recording = source('src/screens/MeetingLiveScreen.android.tsx');
    const meetingResolved = recording.indexOf('const meeting = reusable ?? await createMeeting');
    const routeIdentified = recording.indexOf('navigation.setParams({ meetingId: meeting.id });');
    const nativeRecorderStarted = recording.indexOf('const snapshot = await startNativeRecorder');
    expect(meetingResolved).toBeGreaterThan(-1);
    expect(routeIdentified).toBeGreaterThan(meetingResolved);
    expect(nativeRecorderStarted).toBeGreaterThan(routeIdentified);
  });

  it('keeps recording snapshot refreshes from rebuilding the title actions', () => {
    const kit = source(
      'modules/laoji-native-platform/android/src/main/java/com/laoji/nativeplatform/minutes/MinutesUiKit.kt',
    );
    expect(kit).toContain('if (nextConfiguration == actionConfiguration) return');
    expect(kit).toContain('actionHandler = onAction');
    expect(kit).toContain('R.drawable.laoji_ic_arrow_back');
    expect(kit).not.toContain('ic_media_previous');
  });

  it('replaces the legacy recording presentation with the source-mapped Record V3 surface', () => {
    const surface = source(
      'modules/laoji-native-platform/android/src/main/java/com/laoji/nativeplatform/minutes/MinutesRecordingSurface.kt',
    );
    const waveform = source(
      'modules/laoji-native-platform/android/src/main/java/com/laoji/nativeplatform/minutes/MinutesRecordingWaveformView.kt',
    );
    const transcript = source(
      'modules/laoji-native-platform/android/src/main/java/com/laoji/nativeplatform/minutes/MinutesRecordingTranscriptAdapter.kt',
    );
    expect(surface).toContain('ConstraintLayout(context)');
    expect(surface).toContain('MinutesRecordingV3Contract.BOTTOM_PANEL_HEIGHT_DP');
    expect(surface).toContain('MinutesRecordingTranscriptAdapter()');
    expect(surface).not.toContain('MinutesTitleBar');
    expect(surface).not.toContain('MinutesContentAdapter');
    expect(surface).not.toContain('"录制"');
    expect(surface).not.toContain('正在聆听');
    expect(surface).toContain('radiusDp = 100');
    expect(surface).toContain('FrameLayout.LayoutParams(context.dp(45), context.dp(2)');
    expect(waveform).toContain('private const val BAR_WIDTH_DP = 3');
    expect(waveform).toContain('private const val BAR_GAP_DP = 3');
    expect(waveform).toContain('private const val EDGE_FADE_DP = 50');
    expect(transcript).toContain('MinutesRecordingTranscriptAdapter');
    expect(transcript).toContain('parent.context.dp(20)');
  });
});
