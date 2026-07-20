import React from 'react';
import { act, render, screen, waitFor } from '@testing-library/react-native';
import { TranscriptionScreen } from '../src/screens/TranscriptionScreen.android';
import { useAuth } from '../src/store/AuthStore';
import { useMeetings } from '../src/store/MeetingsStore';
import {
  fetchMeetingSummary,
  fetchMeetingTranscript,
} from '../src/services/api';
import { generateSummaryForMeeting } from '../src/services/meetingSummary';

jest.mock('../src/components/ScreenContainer', () => ({ ScreenContainer: 'ScreenContainer' }));
jest.mock('../src/components/AppActionSheet', () => ({ AppActionSheet: 'AppActionSheet' }));
jest.mock('../src/components/AppDialog', () => ({
  useAppDialog: () => ({ showDialog: jest.fn() }),
}));
jest.mock('../src/store/AuthStore', () => ({ useAuth: jest.fn() }));
jest.mock('../src/store/MeetingsStore', () => ({
  MeetingDeletionCleanupError: class MeetingDeletionCleanupError extends Error {},
  useMeetings: jest.fn(),
}));
jest.mock('../src/services/api', () => ({
  fetchMeetingAudioInfo: jest.fn(async () => null),
  fetchMeetingSummary: jest.fn(),
  fetchMeetingTranscript: jest.fn(),
  uploadMeetingAudio: jest.fn(async () => null),
}));
jest.mock('../src/services/errors', () => ({ readableErrorMessage: (_: unknown, fallback: string) => fallback }));
jest.mock('../src/services/meetingRecording', () => ({
  canAutomaticallyRetryPendingMeetingAudioUpload: jest.fn(() => false),
  getPendingMeetingAudioUpload: jest.fn(async () => null),
  retryPendingMeetingAudioUpload: jest.fn(async () => false),
}));
jest.mock('../src/services/meetingSummary', () => ({
  generateSummaryForMeeting: jest.fn(),
  meetingDateForSummary: jest.fn(() => '2026-07-17'),
  meetingSummaryProgressLabel: jest.fn(() => '正在生成总结'),
  meetingSummaryToText: jest.fn(value => typeof value === 'string' ? value : value?.full_text ?? ''),
  shouldDiscardPendingMeetingSummaryTask: jest.fn(() => false),
}));
jest.mock('../src/services/meetingSummaryTasks', () => ({
  clearPendingMeetingSummaryTask: jest.fn(async () => undefined),
  getPendingMeetingSummaryTask: jest.fn(async () => null),
  meetingSummaryInputFingerprint: jest.fn(() => 'fingerprint-1'),
  savePendingMeetingSummaryTask: jest.fn(async value => value),
}));
jest.mock('../src/services/meetingShare', () => ({
  meetingShareErrorMessage: jest.fn(() => '分享失败'),
  shareMeetingArtifact: jest.fn(async () => undefined),
}));
jest.mock('../src/navigation/tabTargets', () => ({ openMeetingsTab: jest.fn() }));

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(next => { resolve = next; });
  return { promise, resolve };
}

function nativeSurface() {
  return screen.getByTestId('meeting-detail-native-surface');
}

describe('TranscriptionScreen.android generation ownership', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (useAuth as jest.Mock).mockReturnValue({
      accessToken: 'token-1',
      isGuest: false,
      session: { user: { id: 'owner-1' } },
    });
    (fetchMeetingTranscript as jest.Mock).mockResolvedValue([{
      id: 'line-1',
      text: '需要生成总结的文字记录',
      start_time: 0,
      end_time: 2,
    }]);
    (useMeetings as jest.Mock).mockReturnValue({
      meetings: [{
        id: 'meeting-1',
        title: '发布会议',
        date: '2026年7月17日',
        time: '10:00',
        duration: '02:00',
        tags: [],
        hasSummary: true,
      }],
      deleteMeeting: jest.fn(async () => undefined),
      getCachedTranscript: jest.fn(() => [{ id: 'cached-line', text: '缓存文字记录' }]),
      saveCachedTranscript: jest.fn(async () => undefined),
      getCachedSummary: jest.fn(() => ({ full_text: '缓存总结' })),
      saveCachedSummary: jest.fn(async () => undefined),
      refreshMeetings: jest.fn(async () => undefined),
      updateMeetingTitle: jest.fn(async () => undefined),
    });
  });

  it('does not let initial summary sync overwrite a completed regeneration', async () => {
    const oldSync = deferred<string>();
    (fetchMeetingSummary as jest.Mock).mockReturnValueOnce(oldSync.promise);
    (generateSummaryForMeeting as jest.Mock).mockResolvedValueOnce('重新生成的新总结');
    const navigation = { goBack: jest.fn(), navigate: jest.fn() } as any;
    const route = {
      key: 'meeting-generation',
      name: 'Transcription' as const,
      params: { meetingId: 'meeting-1' },
    } as any;

    await render(<TranscriptionScreen navigation={navigation} route={route} />);
    await waitFor(() => expect(fetchMeetingSummary).toHaveBeenCalledTimes(1));

    await act(async () => {
      nativeSurface().props.onMinutesAction({
        nativeEvent: { type: 'generateSummary', surface: 'detail', meetingId: 'meeting-1' },
      });
    });
    await waitFor(() => expect(nativeSurface().props.snapshot.detail.summary).toEqual([
      expect.objectContaining({ text: '重新生成的新总结' }),
    ]));
    const acceptedGeneration = nativeSurface().props.snapshot.detail.pageStates.summary.generation;

    await act(async () => {
      oldSync.resolve('过期的初始同步总结');
      await oldSync.promise;
    });

    expect(nativeSurface().props.snapshot.detail.summary).toEqual([
      expect.objectContaining({ text: '重新生成的新总结' }),
    ]);
    expect(nativeSurface().props.snapshot.detail.pageStates.summary.generation).toBe(acceptedGeneration);
  });

  it('rejects a stale selectDetailTab event delivered out of Expo queue order', async () => {
    (fetchMeetingSummary as jest.Mock).mockResolvedValue('服务端总结');
    const navigation = { goBack: jest.fn(), navigate: jest.fn() } as any;
    const route = {
      key: 'tab-generation',
      name: 'Transcription' as const,
      params: { meetingId: 'meeting-1' },
    } as any;
    await render(<TranscriptionScreen navigation={navigation} route={route} />);

    await act(async () => {
      nativeSurface().props.onMinutesAction({
        nativeEvent: {
          type: 'selectDetailTab',
          surface: 'detail',
          meetingId: 'meeting-1',
          tab: 'summary',
          selectionGeneration: 12,
        },
      });
    });
    await act(async () => {
      nativeSurface().props.onMinutesAction({
        nativeEvent: {
          type: 'selectDetailTab',
          surface: 'detail',
          meetingId: 'meeting-1',
          tab: 'transcript',
          selectionGeneration: 11,
        },
      });
    });

    expect(nativeSurface().props.snapshot.detail.activeTab).toBe('summary');
    expect(nativeSurface().props.snapshot.detail.tabGeneration).toBe(12);
  });
});
