import React from 'react';
import { act, render, waitFor } from '@testing-library/react-native';
import { PermissionsAndroid } from 'react-native';
import * as FileSystem from 'expo-file-system/legacy';
import { VoiceInputModal, VOICE_INPUT_GEOMETRY } from '../src/components/VoiceInputModal.android';
import {
  addNativeRecorderTranscriptListener,
  startNativeRecorder,
  stopNativeRecorder,
  type NativeRecorderTranscriptEvent,
  type NativeWindowOverlayEvent,
} from 'laoji-native-platform';
import {
  createGuestRealtimeSession,
  deleteGuestRealtimeSession,
  parseText,
} from '../src/services/api';
import { useEvents } from '../src/store/EventsStore';

const mockNavigate = jest.fn();
const mockShowDialog = jest.fn();
let mockTranscriptListener: ((event: NativeRecorderTranscriptEvent) => void) | null = null;
let mockOverlayActionListener: ((event: NativeWindowOverlayEvent) => void) | null = null;
const mockPresentNativeWindowOverlay = jest.fn(async (
  _ownerId: string,
  _kind: string,
  _snapshot: any,
) => undefined);
const mockDismissNativeWindowOverlay = jest.fn(async (
  _ownerId: string,
  _kind: string,
  _reason: string,
) => undefined);

jest.mock('@react-navigation/native', () => ({
  useNavigation: () => ({ navigate: mockNavigate }),
  useIsFocused: () => true,
}));
jest.mock('../src/components/AppDialog', () => ({
  useAppDialog: () => ({ showDialog: mockShowDialog }),
}));
jest.mock('../src/store/EventsStore', () => ({ useEvents: jest.fn() }));
jest.mock('../src/services/api', () => ({
  createGuestRealtimeSession: jest.fn(),
  deleteGuestRealtimeSession: jest.fn(async () => undefined),
  parseAudio: jest.fn(),
  parseText: jest.fn(),
}));
jest.mock('../src/services/config', () => ({
  getApiConfig: () => ({
    appEnv: 'development',
    isProduction: false,
    realtimeAsrHost: '203.0.113.10',
    realtimeAsrPort: 18020,
    realtimeAsrSecure: false,
    realtimeAsrProvider: 'qwen',
  }),
}));
jest.mock('../src/services/realtimeAsr', () => ({
  buildRealtimeAsrUrl: () => 'ws://203.0.113.10:18020/ws/laoji/schedule/guest-session-1/qwen',
}));
jest.mock('laoji-native-platform', () => {
  return {
    SCHEDULE_VOICE_SNAPSHOT_SCHEMA_VERSION: 1,
    createNativeOverlayOwnerId: jest.fn(() => 'schedule-voice-test'),
    presentNativeWindowOverlay: (ownerId: string, kind: string, snapshot: any) => (
      mockPresentNativeWindowOverlay(ownerId, kind, snapshot)
    ),
    dismissNativeWindowOverlay: (ownerId: string, kind: string, reason: string) => (
      mockDismissNativeWindowOverlay(ownerId, kind, reason)
    ),
    addNativeWindowOverlayActionListener: jest.fn((listener: (event: NativeWindowOverlayEvent) => void) => {
      mockOverlayActionListener = listener;
      return { remove: jest.fn() };
    }),
    addNativeWindowOverlayDismissListener: jest.fn(() => ({ remove: jest.fn() })),
    hasNativeRecorder: jest.fn(() => true),
    resolveNativeRecorderInsecureDevelopment: jest.fn(() => true),
    assertNativeRecorderDeploymentPolicy: jest.fn(),
    startNativeRecorder: jest.fn(),
    stopNativeRecorder: jest.fn(),
    addNativeRecorderStateListener: jest.fn(() => ({ remove: jest.fn() })),
    addNativeRecorderErrorListener: jest.fn(() => ({ remove: jest.fn() })),
    addNativeRecorderTranscriptListener: jest.fn((listener: (event: NativeRecorderTranscriptEvent) => void) => {
      mockTranscriptListener = listener;
      return { remove: jest.fn() };
    }),
  };
});

const parsed = {
  title: '项目评审',
  event_type: 'once' as const,
  start_date: '2026-07-17',
  end_date: null,
  start_time: '15:00',
  end_time: '16:00',
  is_all_day: false,
  description: null,
  raw_text: '明天下午三点项目评审',
  parse_source: 'rules' as const,
  confidence: 0,
  needs_clarification: false,
  clarification_question: null,
  category: '工作' as const,
  reminder_minutes: 15,
};

describe('VoiceInputModal Android native boundary', () => {
  const addEvent = jest.fn();
  const findConflicts = jest.fn();

  beforeEach(() => {
    jest.clearAllMocks();
    mockTranscriptListener = null;
    mockOverlayActionListener = null;
    (PermissionsAndroid.request as jest.Mock).mockResolvedValue(PermissionsAndroid.RESULTS.GRANTED);
    (FileSystem.deleteAsync as jest.Mock).mockResolvedValue(undefined);
    (useEvents as jest.Mock).mockReturnValue({ addEvent, findConflicts });
    addEvent.mockResolvedValue({ reminderDelivery: 'not-required' });
    findConflicts.mockResolvedValue({ hasConflict: false, conflicts: [], complete: true });
    (parseText as jest.Mock).mockResolvedValue(parsed);
    (createGuestRealtimeSession as jest.Mock).mockResolvedValue({
      meeting_id: 'guest-session-1',
      guest_token: 'guest-token-1',
      expires_at: '2026-07-17T00:00:00Z',
      transient: true,
    });
    (startNativeRecorder as jest.Mock).mockResolvedValue({
      sessionId: 'guest-session-1',
      state: 'recording',
    });
    (stopNativeRecorder as jest.Mock).mockResolvedValue({
      status: 'completed',
      localSaved: true,
      readyToStop: true,
      localUri: 'file:///data/schedule.wav',
      errorCode: null,
      errorMessage: null,
      snapshot: { sessionId: 'guest-session-1', state: 'localSaved', asrRequired: true },
    });
  });

  it('keeps the source-derived microphone and error slots fixed in the native surface', async () => {
    const view = await render(<VoiceInputModal visible onClose={jest.fn()} onSaved={jest.fn()} />);
    await waitFor(() => expect(mockPresentNativeWindowOverlay).toHaveBeenCalled());
    const snapshot = mockPresentNativeWindowOverlay.mock.calls.at(-1)?.[2];

    expect(snapshot).toMatchObject({ phase: 'input', text: '', canParse: false });
    expect(VOICE_INPUT_GEOMETRY).toMatchObject({
      microphoneSize: 64,
      microphoneTouchSize: 88,
      errorSlotHeight: 38,
      holdToTalkDelay: 320,
    });
    expect(view.container.queryAll(instance => instance.type === 'Modal', { includeSelf: true })).toHaveLength(0);
  });

  it('parses manual text and persists the confirmed normalized event', async () => {
    const onSaved = jest.fn();
    const onClose = jest.fn();
    await render(<VoiceInputModal visible onClose={onClose} onSaved={onSaved} />);
    const action = (event: object) => mockOverlayActionListener?.({
      kind: 'schedule-voice', ownerId: 'schedule-voice-test', ...event,
    } as NativeWindowOverlayEvent);

    await act(() => action({ type: 'text-change', text: '明天下午三点项目评审' }));
    await act(() => action({ type: 'parse' }));
    await waitFor(() => expect(mockPresentNativeWindowOverlay.mock.calls.at(-1)?.[2]).toMatchObject({ phase: 'confirm' }));
    await act(() => action({ type: 'save' }));

    await waitFor(() => expect(addEvent).toHaveBeenCalledWith(expect.objectContaining({
      title: '项目评审',
      startDate: '2026-07-17',
      startTime: '15:00',
      reminderMinutes: 15,
    })));
    expect(onSaved).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('records through the native runtime, parses final transcript, then revokes the guest session', async () => {
    await render(<VoiceInputModal visible onClose={jest.fn()} onSaved={jest.fn()} />);
    const action = (event: object) => mockOverlayActionListener?.({
      kind: 'schedule-voice', ownerId: 'schedule-voice-test', ...event,
    } as NativeWindowOverlayEvent);
    expect(addNativeRecorderTranscriptListener).toHaveBeenCalledTimes(1);

    await act(() => action({ type: 'record-start' }));
    await waitFor(() => expect(startNativeRecorder).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 'guest-session-1',
      purpose: 'schedule',
      guestToken: 'guest-token-1',
      allowInsecureDevelopment: true,
    })));
    await act(() => mockTranscriptListener?.({
      sessionId: 'guest-session-1',
      segmentId: 'segment-1',
      kind: 'final',
      isFinal: true,
      text: '明天下午三点项目评审',
      speakerId: null,
      speakerName: null,
      startMs: 0,
      endMs: 2_000,
      source: 'qwen3-asr',
      purpose: 'schedule',
      receivedAtMs: 1,
    }));
    await act(() => action({ type: 'record-stop' }));

    await waitFor(() => expect(parseText).toHaveBeenCalledWith('明天下午三点项目评审'));
    expect(FileSystem.deleteAsync).toHaveBeenCalledWith('file:///data/schedule.wav', { idempotent: true });
    expect(deleteGuestRealtimeSession).toHaveBeenCalledWith('guest-session-1', 'guest-token-1');
  });
});
