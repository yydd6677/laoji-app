import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { StyleSheet } from 'react-native';
import { TranscriptionScreen } from '../src/screens/TranscriptionScreen';
import { useAuth } from '../src/store/AuthStore';
import { useMeetings } from '../src/store/MeetingsStore';
import { generateSummaryForMeeting } from '../src/services/meetingSummary';
import { fetchMeetingTranscript, uploadMeetingAudio } from '../src/services/api';
import {
  canAutomaticallyRetryPendingMeetingAudioUpload,
  getPendingMeetingAudioUpload,
  retryPendingMeetingAudioUpload,
} from '../src/services/meetingRecording';
import {
  clearPendingMeetingSummaryTask,
  getPendingMeetingSummaryTask,
  savePendingMeetingSummaryTask,
} from '../src/services/meetingSummaryTasks';

const showDialog = jest.fn();

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

jest.mock('@expo/vector-icons', () => ({ Ionicons: 'Ionicons' }));
jest.mock('../src/components/ScreenContainer', () => ({ ScreenContainer: 'ScreenContainer' }));
jest.mock('../src/components/Common', () => ({
  BackHeader: ({ right }: { right?: React.ReactNode }) => <>{right}</>,
  Waveform: 'Waveform',
}));
jest.mock('../src/components/BottomTabBar', () => ({
  BottomTabBar: 'BottomTabBar',
  BOTTOM_TAB_BAR_GEOMETRY: { scrollContentClearance: 100 },
}));
jest.mock('../src/store/AuthStore', () => ({ useAuth: jest.fn() }));
jest.mock('../src/store/MeetingsStore', () => ({
  MeetingDeletionCleanupError: class MeetingDeletionCleanupError extends Error {},
  useMeetings: jest.fn(),
}));
jest.mock('../src/components/MeetingAudioPlayerDock', () => ({
  MeetingAudioPlayerDock: 'MeetingAudioPlayerDock',
}));
jest.mock('../src/components/AppDialog', () => ({
  useAppDialog: () => ({ showDialog }),
}));
jest.mock('../src/services/api', () => ({
  fetchMeetingTranscript: jest.fn(),
  fetchMeetingSummary: jest.fn(),
  uploadMeetingAudio: jest.fn(),
}));
jest.mock('../src/services/meetingRecording', () => ({
  canAutomaticallyRetryPendingMeetingAudioUpload: jest.fn(() => true),
  getPendingMeetingAudioUpload: jest.fn(async () => null),
  retryPendingMeetingAudioUpload: jest.fn(),
}));
jest.mock('../src/services/meetingSummary', () => ({
  generateSummaryForMeeting: jest.fn(),
  meetingDateForSummary: jest.fn(),
  meetingSummaryProgressLabel: jest.fn(() => '正在生成总结'),
  meetingSummaryToText: jest.fn(() => ''),
  shouldDiscardPendingMeetingSummaryTask: jest.fn(() => false),
}));
jest.mock('../src/services/meetingSummaryTasks', () => ({
  clearPendingMeetingSummaryTask: jest.fn(async () => {}),
  getPendingMeetingSummaryTask: jest.fn(async () => null),
  meetingSummaryInputFingerprint: jest.fn(() => 'fingerprint-1'),
  savePendingMeetingSummaryTask: jest.fn(async task => task),
}));
jest.mock('../src/services/meetingShare', () => ({
  meetingShareErrorMessage: jest.fn(),
  shareMeetingArtifact: jest.fn(),
}));

describe('TranscriptionScreen accessibility', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (useAuth as jest.Mock).mockReturnValue({ accessToken: null, isGuest: true, session: null });
    (fetchMeetingTranscript as jest.Mock).mockResolvedValue([]);
    (uploadMeetingAudio as jest.Mock).mockResolvedValue(null);
    (getPendingMeetingAudioUpload as jest.Mock).mockResolvedValue(null);
    (retryPendingMeetingAudioUpload as jest.Mock).mockResolvedValue(false);
    (canAutomaticallyRetryPendingMeetingAudioUpload as jest.Mock).mockReturnValue(true);
    (getPendingMeetingSummaryTask as jest.Mock).mockResolvedValue(null);
    (useMeetings as jest.Mock).mockReturnValue({
      meetings: [{
        id: 'guest-meeting-1',
        title: '现场会议',
        date: '2026年7月11日',
        time: '15:40',
        duration: '02:35',
        tags: [],
        audioAvailable: true,
        audioLocalUri: 'file:///data/meeting.wav',
        audioDurationSec: 155,
        audioBars: [1, 2, 3],
      }],
      deleteMeeting: jest.fn(),
      updateMeetingTitle: jest.fn(),
      getCachedTranscript: jest.fn(() => []),
      saveCachedTranscript: jest.fn(),
      getCachedSummary: jest.fn(() => null),
      saveCachedSummary: jest.fn(),
      refreshMeetings: jest.fn(),
    });
  });

  it('automatically resumes a pending authenticated audio upload without a dialog', async () => {
    const pending = {
      meetingId: 'guest-meeting-1',
      audioUri: 'file:///data/pending.wav',
      fileName: 'pending.wav',
      mimeType: 'audio/wav',
      createdAt: '2026-07-14T00:00:00.000Z',
      lastAttemptAt: '2026-07-14T00:00:00.000Z',
      attemptCount: 1,
      uploadState: 'pending',
    };
    (useAuth as jest.Mock).mockReturnValue({
      accessToken: 'token-1',
      isGuest: false,
      session: { user: { id: 'account-1' } },
    });
    (getPendingMeetingAudioUpload as jest.Mock).mockResolvedValueOnce(pending);
    (retryPendingMeetingAudioUpload as jest.Mock).mockResolvedValueOnce(true);
    const refreshMeetings = jest.fn(async () => {});
    (useMeetings as jest.Mock).mockReturnValue({
      ...(useMeetings as jest.Mock).mock.results.at(-1)?.value,
      meetings: [{ id: 'guest-meeting-1', title: '现场会议', date: '2026年7月11日', duration: '02:35', tags: [] }],
      updateMeetingTitle: jest.fn(),
      getCachedTranscript: jest.fn(() => []),
      saveCachedTranscript: jest.fn(),
      getCachedSummary: jest.fn(() => null),
      saveCachedSummary: jest.fn(),
      refreshMeetings,
    });
    const navigation = { goBack: jest.fn(), navigate: jest.fn() } as unknown as React.ComponentProps<typeof TranscriptionScreen>['navigation'];
    const route = {
      key: 'transcription-auto-audio-upload',
      name: 'Transcription' as const,
      params: { meetingId: 'guest-meeting-1' },
    } as React.ComponentProps<typeof TranscriptionScreen>['route'];

    await render(<TranscriptionScreen navigation={navigation} route={route} />);

    await waitFor(() => expect(retryPendingMeetingAudioUpload).toHaveBeenCalledWith(
      'user:account-1',
      'guest-meeting-1',
      'token-1',
      expect.any(Function),
      { automatic: true },
    ));
    await waitFor(() => expect(refreshMeetings).toHaveBeenCalledTimes(1));
    expect(showDialog).not.toHaveBeenCalled();
  });

  it('keeps a failed automatic audio upload visible for manual retry', async () => {
    const pending = {
      meetingId: 'guest-meeting-1',
      audioUri: 'file:///data/pending.wav',
      fileName: 'pending.wav',
      mimeType: 'audio/wav',
      createdAt: '2026-07-14T00:00:00.000Z',
      lastAttemptAt: '2026-07-14T00:00:00.000Z',
      attemptCount: 2,
      uploadState: 'pending',
      failureMessage: '自动同步未完成，录音仍保存在本机',
    };
    (useAuth as jest.Mock).mockReturnValue({
      accessToken: 'token-1',
      isGuest: false,
      session: { user: { id: 'account-1' } },
    });
    (getPendingMeetingAudioUpload as jest.Mock).mockResolvedValue(pending);
    (retryPendingMeetingAudioUpload as jest.Mock).mockRejectedValueOnce(new Error('offline'));
    (useMeetings as jest.Mock).mockReturnValue({
      meetings: [{ id: 'guest-meeting-1', title: '现场会议', date: '2026年7月11日', duration: '02:35', tags: [] }],
      updateMeetingTitle: jest.fn(),
      getCachedTranscript: jest.fn(() => []),
      saveCachedTranscript: jest.fn(),
      getCachedSummary: jest.fn(() => null),
      saveCachedSummary: jest.fn(),
      refreshMeetings: jest.fn(),
    });
    const navigation = { goBack: jest.fn(), navigate: jest.fn() } as unknown as React.ComponentProps<typeof TranscriptionScreen>['navigation'];
    const route = {
      key: 'transcription-auto-audio-failure',
      name: 'Transcription' as const,
      params: { meetingId: 'guest-meeting-1' },
    } as React.ComponentProps<typeof TranscriptionScreen>['route'];

    await render(<TranscriptionScreen navigation={navigation} route={route} />);

    await waitFor(() => expect(screen.getByText('自动同步未完成，录音仍保存在本机')).toBeTruthy());
    expect(screen.getByLabelText('重试上传会议录音')).toBeTruthy();
    expect(showDialog).not.toHaveBeenCalled();
  });

  it('shows a blocked recording reason without automatically resending the file', async () => {
    const pending = {
      meetingId: 'guest-meeting-1',
      audioUri: 'file:///data/too-large.wav',
      fileName: 'too-large.wav',
      mimeType: 'audio/wav',
      createdAt: '2026-07-14T00:00:00.000Z',
      lastAttemptAt: '2026-07-14T00:00:00.000Z',
      attemptCount: 3,
      uploadState: 'blocked',
      failureCode: 'file_too_large',
      failureMessage: '录音文件超过云端上传上限，仍保存在本机。',
    };
    (useAuth as jest.Mock).mockReturnValue({
      accessToken: 'token-1',
      isGuest: false,
      session: { user: { id: 'account-1' } },
    });
    (canAutomaticallyRetryPendingMeetingAudioUpload as jest.Mock).mockReturnValue(false);
    (getPendingMeetingAudioUpload as jest.Mock).mockResolvedValue(pending);
    (useMeetings as jest.Mock).mockReturnValue({
      meetings: [{ id: 'guest-meeting-1', title: '现场会议', date: '2026年7月11日', duration: '02:35', tags: [] }],
      updateMeetingTitle: jest.fn(),
      getCachedTranscript: jest.fn(() => []),
      saveCachedTranscript: jest.fn(),
      getCachedSummary: jest.fn(() => null),
      saveCachedSummary: jest.fn(),
      refreshMeetings: jest.fn(),
    });
    const navigation = { goBack: jest.fn(), navigate: jest.fn() } as unknown as React.ComponentProps<typeof TranscriptionScreen>['navigation'];
    const route = {
      key: 'transcription-blocked-audio',
      name: 'Transcription' as const,
      params: { meetingId: 'guest-meeting-1' },
    } as React.ComponentProps<typeof TranscriptionScreen>['route'];

    await render(<TranscriptionScreen navigation={navigation} route={route} />);

    await waitFor(() => expect(screen.getByText('录音文件超过云端上传上限，仍保存在本机。')).toBeTruthy());
    const retryButton = screen.getByLabelText('重试上传会议录音');
    expect(retryPendingMeetingAudioUpload).not.toHaveBeenCalled();

    (retryPendingMeetingAudioUpload as jest.Mock).mockResolvedValueOnce(true);
    await act(async () => {
      fireEvent.press(retryButton);
      await Promise.resolve();
      await Promise.resolve();
    });
    await waitFor(() => expect(retryPendingMeetingAudioUpload).toHaveBeenCalledWith(
      'user:account-1',
      'guest-meeting-1',
      'token-1',
      expect.any(Function),
      { automatic: false },
    ));
    await waitFor(() => expect(showDialog).toHaveBeenCalledWith(expect.objectContaining({
      title: '上传完成',
      tone: 'success',
    })));
  });

  it('automatically resumes a persisted summary task and clears it after caching', async () => {
    (getPendingMeetingSummaryTask as jest.Mock).mockResolvedValueOnce({
      meetingId: 'guest-meeting-1',
      taskId: 'task-persisted',
      mode: 'guest',
      inputFingerprint: 'fingerprint-1',
      createdAt: '2026-07-13T00:00:00.000Z',
      updatedAt: '2026-07-13T00:00:00.000Z',
    });
    (generateSummaryForMeeting as jest.Mock).mockResolvedValueOnce({
      meeting_id: 'guest-meeting-1',
      overview: '恢复后的总结',
      generated_at: '2026-07-13T00:00:01.000Z',
    });
    const saveCachedSummary = jest.fn(async () => {});
    (useMeetings as jest.Mock).mockReturnValue({
      meetings: [{
        id: 'guest-meeting-1', title: '现场会议', date: '2026年7月11日', duration: '02:35', tags: [],
      }],
      updateMeetingTitle: jest.fn(),
      getCachedTranscript: jest.fn(() => [{ id: '1', text: '等待恢复的转写' }]),
      saveCachedTranscript: jest.fn(),
      getCachedSummary: jest.fn(() => null),
      saveCachedSummary,
      refreshMeetings: jest.fn(),
    });
    const navigation = { goBack: jest.fn(), navigate: jest.fn() } as unknown as React.ComponentProps<typeof TranscriptionScreen>['navigation'];
    const route = {
      key: 'transcription-resume-summary',
      name: 'Transcription' as const,
      params: { meetingId: 'guest-meeting-1' },
    } as React.ComponentProps<typeof TranscriptionScreen>['route'];

    await act(async () => {
      render(<TranscriptionScreen navigation={navigation} route={route} />);
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(generateSummaryForMeeting).toHaveBeenCalledWith(expect.objectContaining({
        meetingId: 'guest-meeting-1',
        resumeTaskId: 'task-persisted',
      }));
    });
    expect(saveCachedSummary).toHaveBeenCalledWith('guest-meeting-1', expect.objectContaining({
      overview: '恢复后的总结',
    }));
    expect(clearPendingMeetingSummaryTask).toHaveBeenCalledWith('guest', 'guest-meeting-1');
  });

  it('keeps a persisted task after automatic recovery hits a network error', async () => {
    (getPendingMeetingSummaryTask as jest.Mock).mockResolvedValue({
      meetingId: 'guest-meeting-1',
      taskId: 'task-offline',
      mode: 'guest',
      inputFingerprint: 'fingerprint-1',
      createdAt: '2026-07-13T00:00:00.000Z',
      updatedAt: '2026-07-13T00:00:00.000Z',
    });
    (generateSummaryForMeeting as jest.Mock).mockRejectedValue(new Error('network unavailable'));
    (useMeetings as jest.Mock).mockReturnValue({
      meetings: [{ id: 'guest-meeting-1', title: '现场会议', date: '2026年7月11日', duration: '02:35', tags: [] }],
      updateMeetingTitle: jest.fn(),
      getCachedTranscript: jest.fn(() => [{ id: '1', text: '断网后等待恢复的转写' }]),
      saveCachedTranscript: jest.fn(),
      getCachedSummary: jest.fn(() => null),
      saveCachedSummary: jest.fn(),
      refreshMeetings: jest.fn(),
    });
    const navigation = { goBack: jest.fn(), navigate: jest.fn() } as unknown as React.ComponentProps<typeof TranscriptionScreen>['navigation'];
    const route = {
      key: 'transcription-offline-recovery',
      name: 'Transcription' as const,
      params: { meetingId: 'guest-meeting-1', focus: 'summary' },
    } as React.ComponentProps<typeof TranscriptionScreen>['route'];

    await render(<TranscriptionScreen navigation={navigation} route={route} />);

    await waitFor(() => expect(generateSummaryForMeeting).toHaveBeenCalledWith(expect.objectContaining({
      resumeTaskId: 'task-offline',
    })));
    await waitFor(() => expect(screen.getByText('network unavailable')).toBeTruthy());
    expect(clearPendingMeetingSummaryTask).not.toHaveBeenCalled();
    expect(showDialog).not.toHaveBeenCalled();
  });

  it('discards mismatched recovery state without submitting a duplicate task', async () => {
    (getPendingMeetingSummaryTask as jest.Mock).mockResolvedValue({
      meetingId: 'guest-meeting-1',
      taskId: 'task-old-input',
      mode: 'guest',
      inputFingerprint: 'fingerprint-for-old-transcript',
      createdAt: '2026-07-13T00:00:00.000Z',
      updatedAt: '2026-07-13T00:00:00.000Z',
    });
    (useMeetings as jest.Mock).mockReturnValue({
      meetings: [{ id: 'guest-meeting-1', title: '现场会议', date: '2026年7月11日', duration: '02:35', tags: [] }],
      updateMeetingTitle: jest.fn(),
      getCachedTranscript: jest.fn(() => [{ id: '1', text: '已经修改过的转写' }]),
      saveCachedTranscript: jest.fn(),
      getCachedSummary: jest.fn(() => null),
      saveCachedSummary: jest.fn(),
      refreshMeetings: jest.fn(),
    });
    const navigation = { goBack: jest.fn(), navigate: jest.fn() } as unknown as React.ComponentProps<typeof TranscriptionScreen>['navigation'];
    const route = {
      key: 'transcription-mismatched-recovery',
      name: 'Transcription' as const,
      params: { meetingId: 'guest-meeting-1' },
    } as React.ComponentProps<typeof TranscriptionScreen>['route'];

    await render(<TranscriptionScreen navigation={navigation} route={route} />);

    await waitFor(() => expect(clearPendingMeetingSummaryTask).toHaveBeenCalledWith('guest', 'guest-meeting-1'));
    expect(generateSummaryForMeeting).not.toHaveBeenCalled();
  });

  it('does not submit when the pending-task registry cannot be read', async () => {
    (getPendingMeetingSummaryTask as jest.Mock).mockRejectedValue(new Error('storage unavailable'));
    (useMeetings as jest.Mock).mockReturnValue({
      meetings: [{ id: 'guest-meeting-1', title: '现场会议', date: '2026年7月11日', duration: '02:35', tags: [] }],
      updateMeetingTitle: jest.fn(),
      getCachedTranscript: jest.fn(() => [{ id: '1', text: '不可重复提交的转写' }]),
      saveCachedTranscript: jest.fn(),
      getCachedSummary: jest.fn(() => null),
      saveCachedSummary: jest.fn(),
      refreshMeetings: jest.fn(),
    });
    const navigation = { goBack: jest.fn(), navigate: jest.fn() } as unknown as React.ComponentProps<typeof TranscriptionScreen>['navigation'];
    const route = {
      key: 'transcription-storage-unavailable',
      name: 'Transcription' as const,
      params: { meetingId: 'guest-meeting-1', focus: 'summary' },
    } as React.ComponentProps<typeof TranscriptionScreen>['route'];

    await render(<TranscriptionScreen navigation={navigation} route={route} />);
    await waitFor(() => expect(screen.getByText('无法读取上次总结任务，点击重试可重新生成。')).toBeTruthy());
    await act(async () => {
      void screen.getByLabelText('生成会议总结').props.onPress();
      await Promise.resolve();
    });

    await waitFor(() => expect(showDialog).toHaveBeenCalledWith(expect.objectContaining({
      title: '生成失败',
      message: '无法读取上次总结任务，未提交新任务。请检查本机存储后重试。',
    })));
    expect(generateSummaryForMeeting).not.toHaveBeenCalled();
  });

  it('stops polling without clearing the submitted server task', async () => {
    (useMeetings as jest.Mock).mockReturnValue({
      meetings: [{ id: 'guest-meeting-1', title: '现场会议', date: '2026年7月11日', duration: '02:35', tags: [] }],
      updateMeetingTitle: jest.fn(),
      getCachedTranscript: jest.fn(() => [{ id: '1', text: '需要稍后恢复的转写' }]),
      saveCachedTranscript: jest.fn(),
      getCachedSummary: jest.fn(() => null),
      saveCachedSummary: jest.fn(),
      refreshMeetings: jest.fn(),
    });
    (generateSummaryForMeeting as jest.Mock).mockImplementation(async options => {
      await options.onTaskSubmitted?.('task-still-running');
      return await new Promise((_resolve, reject) => {
        options.signal?.addEventListener('abort', () => {
          const error = new Error('cancelled');
          error.name = 'AbortError';
          reject(error);
        }, { once: true });
      });
    });
    const navigation = { goBack: jest.fn(), navigate: jest.fn() } as unknown as React.ComponentProps<typeof TranscriptionScreen>['navigation'];
    const route = {
      key: 'transcription-stop-polling',
      name: 'Transcription' as const,
      params: { meetingId: 'guest-meeting-1', focus: 'summary' },
    } as React.ComponentProps<typeof TranscriptionScreen>['route'];

    await render(<TranscriptionScreen navigation={navigation} route={route} />);
    await act(async () => {
      void screen.getByLabelText('生成会议总结').props.onPress();
      await Promise.resolve();
    });
    await waitFor(() => expect(savePendingMeetingSummaryTask).toHaveBeenCalledWith('guest', expect.objectContaining({
      taskId: 'task-still-running',
    })));

    await fireEvent.press(screen.getByText('停止等待'));

    await waitFor(() => expect(showDialog).toHaveBeenCalledWith(expect.objectContaining({ title: '已停止等待' })));
    expect(clearPendingMeetingSummaryTask).not.toHaveBeenCalled();
  });

  it('keeps the previous recovery task when forced regeneration fails before submission', async () => {
    const meetingSummaryToText = jest.requireMock('../src/services/meetingSummary').meetingSummaryToText as jest.Mock;
    meetingSummaryToText.mockReturnValueOnce('旧会议总结');
    (useMeetings as jest.Mock).mockReturnValue({
      meetings: [{ id: 'guest-meeting-1', title: '现场会议', date: '2026年7月11日', duration: '02:35', tags: [] }],
      updateMeetingTitle: jest.fn(),
      getCachedTranscript: jest.fn(() => [{ id: '1', text: '需要重新总结的转写' }]),
      saveCachedTranscript: jest.fn(),
      getCachedSummary: jest.fn(() => ({ overview: '旧会议总结' })),
      saveCachedSummary: jest.fn(),
      refreshMeetings: jest.fn(),
    });
    (generateSummaryForMeeting as jest.Mock).mockRejectedValueOnce(new Error('network unavailable'));
    const navigation = { goBack: jest.fn(), navigate: jest.fn() } as unknown as React.ComponentProps<typeof TranscriptionScreen>['navigation'];
    const route = {
      key: 'transcription-force-submit-failure',
      name: 'Transcription' as const,
      params: { meetingId: 'guest-meeting-1', focus: 'summary' },
    } as React.ComponentProps<typeof TranscriptionScreen>['route'];

    await render(<TranscriptionScreen navigation={navigation} route={route} />);
    await fireEvent.press(await screen.findByLabelText('重新生成会议总结'));

    await waitFor(() => expect(generateSummaryForMeeting).toHaveBeenCalledWith(expect.objectContaining({
      forceRegenerate: true,
    })));
    expect(clearPendingMeetingSummaryTask).not.toHaveBeenCalled();
  });

  it('silently stops the old account poll when the account scope changes', async () => {
    (useAuth as jest.Mock).mockReturnValue({
      accessToken: 'token-a',
      isGuest: false,
      session: { user: { id: 'account-a' } },
    });
    (useMeetings as jest.Mock).mockReturnValue({
      meetings: [{ id: 'guest-meeting-1', title: '现场会议', date: '2026年7月11日', duration: '02:35', tags: [] }],
      updateMeetingTitle: jest.fn(),
      getCachedTranscript: jest.fn(() => [{ id: '1', text: '账号切换前的转写' }]),
      saveCachedTranscript: jest.fn(),
      getCachedSummary: jest.fn(() => null),
      saveCachedSummary: jest.fn(),
      refreshMeetings: jest.fn(),
    });
    (generateSummaryForMeeting as jest.Mock).mockImplementation(async options => {
      await options.onTaskSubmitted?.('task-account-a');
      return await new Promise((_resolve, reject) => {
        options.signal?.addEventListener('abort', () => {
          const error = new Error('cancelled');
          error.name = 'AbortError';
          reject(error);
        }, { once: true });
      });
    });
    const navigation = { goBack: jest.fn(), navigate: jest.fn() } as unknown as React.ComponentProps<typeof TranscriptionScreen>['navigation'];
    const route = {
      key: 'transcription-account-switch',
      name: 'Transcription' as const,
      params: { meetingId: 'guest-meeting-1', focus: 'summary' },
    } as React.ComponentProps<typeof TranscriptionScreen>['route'];
    const view = await render(<TranscriptionScreen navigation={navigation} route={route} />);
    await waitFor(() => expect(screen.getByLabelText('生成会议总结')).toBeTruthy());
    await act(async () => {
      void screen.getByLabelText('生成会议总结').props.onPress();
      await Promise.resolve();
    });
    await waitFor(() => expect(savePendingMeetingSummaryTask).toHaveBeenCalledWith('user:account-a', expect.objectContaining({
      taskId: 'task-account-a',
    })));

    (useAuth as jest.Mock).mockReturnValue({
      accessToken: 'token-b',
      isGuest: false,
      session: { user: { id: 'account-b' } },
    });
    await view.rerender(<TranscriptionScreen navigation={navigation} route={route} />);

    await waitFor(() => expect(getPendingMeetingSummaryTask).toHaveBeenCalledWith('user:account-b', 'guest-meeting-1'));
    expect(showDialog).not.toHaveBeenCalled();
    expect(clearPendingMeetingSummaryTask).not.toHaveBeenCalledWith('user:account-a', 'guest-meeting-1');
  });

  it('announces and opens the meeting share menu', async () => {
    const navigation = {
      goBack: jest.fn(),
      navigate: jest.fn(),
    } as unknown as React.ComponentProps<typeof TranscriptionScreen>['navigation'];
    const route = {
      key: 'transcription-1',
      name: 'Transcription' as const,
      params: { meetingId: 'guest-meeting-1' },
    } as React.ComponentProps<typeof TranscriptionScreen>['route'];

    await render(<TranscriptionScreen navigation={navigation} route={route} />);
    await fireEvent.press(screen.getByLabelText('分享会议资料'));

    expect(showDialog).toHaveBeenCalledWith(expect.objectContaining({
      title: '分享会议文件',
    }));
    expect(screen.getByTestId('meeting-detail-tabs')).toHaveStyle({
      height: 41,
      backgroundColor: '#FFFFFF',
    });
  });

  it('uses the source title display and explicit title edit mode', async () => {
    const updateMeetingTitle = jest.fn(async () => undefined);
    (useMeetings as jest.Mock).mockReturnValue({
      meetings: [{
        id: 'guest-meeting-1',
        title: '现场会议',
        date: '2026年7月11日',
        time: '15:40',
        duration: '02:35',
        tags: [],
      }],
      deleteMeeting: jest.fn(),
      updateMeetingTitle,
      getCachedTranscript: jest.fn(() => []),
      saveCachedTranscript: jest.fn(),
      getCachedSummary: jest.fn(() => null),
      saveCachedSummary: jest.fn(),
      refreshMeetings: jest.fn(),
    });
    const navigation = {
      goBack: jest.fn(),
      navigate: jest.fn(),
    } as unknown as React.ComponentProps<typeof TranscriptionScreen>['navigation'];
    const route = {
      key: 'transcription-title-edit',
      name: 'Transcription' as const,
      params: { meetingId: 'guest-meeting-1' },
    } as React.ComponentProps<typeof TranscriptionScreen>['route'];

    await render(<TranscriptionScreen navigation={navigation} route={route} />);
    expect(screen.getByTestId('meeting-title-display')).toBeTruthy();
    expect(screen.queryByTestId('meeting-title-input')).toBeNull();

    await fireEvent.press(screen.getByLabelText('编辑会议标题'));
    expect(screen.getByLabelText('分享会议资料')).toBeTruthy();
    expect(screen.getByLabelText('更多会议操作')).toBeTruthy();

    const input = screen.getByTestId('meeting-title-input');
    await fireEvent.changeText(input, '新版会议标题');
    await fireEvent(input, 'blur');
    await waitFor(() => expect(updateMeetingTitle).toHaveBeenCalledWith('guest-meeting-1', '新版会议标题'));
    await waitFor(() => expect(screen.getByTestId('meeting-title-display')).toBeTruthy());
  });

  it('uses the source compact tabs and meeting-notes wording', async () => {
    const navigation = {
      goBack: jest.fn(),
      navigate: jest.fn(),
    } as unknown as React.ComponentProps<typeof TranscriptionScreen>['navigation'];
    const route = {
      key: 'transcription-tab-geometry',
      name: 'Transcription' as const,
      params: { meetingId: 'guest-meeting-1' },
    } as React.ComponentProps<typeof TranscriptionScreen>['route'];

    await render(<TranscriptionScreen navigation={navigation} route={route} />);
    expect(StyleSheet.flatten(screen.getByTestId('meeting-detail-tabs').props.style))
      .toEqual(expect.objectContaining({ height: 41, paddingLeft: 10 }));
    expect(StyleSheet.flatten(screen.getByLabelText('查看会议转写').props.style))
      .toEqual(expect.objectContaining({ width: 76 }));
    expect(StyleSheet.flatten(screen.getByLabelText('查看会议纪要').props.style))
      .toEqual(expect.objectContaining({ width: 60 }));
    expect(screen.getByText('纪要')).toBeTruthy();
    expect(screen.queryByText('智能总结')).toBeNull();
  });

  it('switches transcript and summary with the source horizontal pager gesture', async () => {
    const navigation = {
      goBack: jest.fn(),
      navigate: jest.fn(),
    } as unknown as React.ComponentProps<typeof TranscriptionScreen>['navigation'];
    const route = {
      key: 'transcription-pager',
      name: 'Transcription' as const,
      params: { meetingId: 'guest-meeting-1' },
    } as React.ComponentProps<typeof TranscriptionScreen>['route'];

    await render(<TranscriptionScreen navigation={navigation} route={route} />);
    const page = screen.getByTestId('meeting-detail-tab-page');

    expect(screen.getByTestId('meeting-transcript-list')).toBeTruthy();
    await act(async () => {
      page.props.onResponderRelease?.({}, { dx: -72, dy: 3 });
    });
    expect(screen.getByTestId('meeting-summary-content')).toBeTruthy();
    expect(screen.getByLabelText('查看会议纪要').props.accessibilityState).toEqual({ selected: true });

    await act(async () => {
      screen.getByTestId('meeting-detail-tab-page').props.onResponderRelease?.({}, { dx: 72, dy: 2 });
    });
    expect(screen.getByTestId('meeting-transcript-list')).toBeTruthy();
    expect(screen.getByLabelText('查看会议转写').props.accessibilityState).toEqual({ selected: true });
  });

  it('keeps destructive meeting actions in the unified detail menu', async () => {
    const navigation = {
      goBack: jest.fn(),
      navigate: jest.fn(),
    } as unknown as React.ComponentProps<typeof TranscriptionScreen>['navigation'];
    const route = {
      key: 'transcription-more',
      name: 'Transcription' as const,
      params: { meetingId: 'guest-meeting-1' },
    } as React.ComponentProps<typeof TranscriptionScreen>['route'];

    await render(<TranscriptionScreen navigation={navigation} route={route} />);
    await fireEvent.press(screen.getByLabelText('更多会议操作'));
    await fireEvent.press(screen.getByLabelText('删除会议'));

    expect(showDialog).toHaveBeenCalledWith(expect.objectContaining({
      title: '确认删除',
      tone: 'danger',
    }));
  });

  it('renders every transcript segment without a legacy expand control', async () => {
    (useMeetings as jest.Mock).mockReturnValue({
      ...(useMeetings as jest.Mock).mock.results.at(-1)?.value,
      meetings: [{
        id: 'guest-meeting-1',
        title: '现场会议',
        date: '2026年7月11日',
        time: '15:40',
        duration: '02:35',
        tags: [],
      }],
      updateMeetingTitle: jest.fn(),
      getCachedTranscript: jest.fn(() => [
        { id: '1', text: '第一段转写' },
        { id: '2', text: '第二段转写' },
      ]),
      saveCachedTranscript: jest.fn(),
      getCachedSummary: jest.fn(() => null),
      saveCachedSummary: jest.fn(),
      refreshMeetings: jest.fn(),
    });
    const navigation = { goBack: jest.fn(), navigate: jest.fn() } as unknown as React.ComponentProps<typeof TranscriptionScreen>['navigation'];
    const route = {
      key: 'transcription-1',
      name: 'Transcription' as const,
      params: { meetingId: 'guest-meeting-1' },
    } as React.ComponentProps<typeof TranscriptionScreen>['route'];

    await render(<TranscriptionScreen navigation={navigation} route={route} />);
    expect(screen.getByTestId('meeting-transcript-line-1')).toBeTruthy();
    expect(screen.getByTestId('meeting-transcript-line-2')).toBeTruthy();
    expect(screen.getByText('第一段转写')).toBeTruthy();
    expect(screen.getByText('第二段转写')).toBeTruthy();
    expect(StyleSheet.flatten(screen.getByTestId('meeting-transcript-line-1').props.style))
      .toEqual(expect.objectContaining({ paddingTop: 20, paddingBottom: 12 }));
    expect(StyleSheet.flatten(screen.getByTestId('meeting-transcript-meta-1').props.style))
      .toEqual(expect.objectContaining({ minHeight: 24, paddingHorizontal: 20 }));
    expect(StyleSheet.flatten(screen.getByTestId('meeting-transcript-text-1').props.style))
      .toEqual(expect.objectContaining({ marginTop: 10, marginHorizontal: 20, lineHeight: 28 }));
    expect(screen.queryByLabelText('展开完整转写')).toBeNull();
    expect(screen.queryByLabelText('收起完整转写')).toBeNull();
  });

  it('does not show a cancellation dialog after leaving a pending summary', async () => {
    let rejectSummary = (_error: Error) => {};
    (generateSummaryForMeeting as jest.Mock).mockImplementation(() => new Promise((_resolve, reject) => {
      rejectSummary = reject;
    }));
    (useMeetings as jest.Mock).mockReturnValue({
      meetings: [{
        id: 'guest-meeting-1',
        title: '现场会议',
        date: '2026年7月11日',
        duration: '02:35',
        tags: [],
      }],
      updateMeetingTitle: jest.fn(),
      getCachedTranscript: jest.fn(() => [{ id: '1', text: '等待生成总结的转写' }]),
      saveCachedTranscript: jest.fn(),
      getCachedSummary: jest.fn(() => null),
      saveCachedSummary: jest.fn(),
      refreshMeetings: jest.fn(),
    });
    const navigation = { goBack: jest.fn(), navigate: jest.fn() } as unknown as React.ComponentProps<typeof TranscriptionScreen>['navigation'];
    const route = {
      key: 'transcription-pending-summary',
      name: 'Transcription' as const,
      params: { meetingId: 'guest-meeting-1', focus: 'summary' },
    } as React.ComponentProps<typeof TranscriptionScreen>['route'];
    const view = await render(<TranscriptionScreen navigation={navigation} route={route} />);
    await act(async () => {
      void view.getByLabelText('生成会议总结').props.onPress();
      await Promise.resolve();
    });
    await view.unmount();
    const aborted = new Error('cancelled');
    aborted.name = 'AbortError';
    rejectSummary(aborted);
    await Promise.resolve();
    await Promise.resolve();

    expect(showDialog).not.toHaveBeenCalled();
  });
});
