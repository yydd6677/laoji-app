import React from 'react';
import { act, fireEvent, render, waitFor } from '@testing-library/react-native';
import { RecordingScreen } from '../src/screens/RecordingScreen';
import { useAuth } from '../src/store/AuthStore';
import { useMeetings } from '../src/store/MeetingsStore';
import { fetchMeetingAudioInfo, fetchMeetingTranscript } from '../src/services/api';
import { MeetingAudioUrlError } from '../src/services/meetingAudioSecurity';

const showDialog = jest.fn();

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

jest.mock('@expo/vector-icons', () => ({ Ionicons: 'Ionicons' }));
jest.mock('expo-av', () => ({
  Audio: {
    setAudioModeAsync: jest.fn(),
    Sound: { createAsync: jest.fn() },
  },
}));
jest.mock('../src/components/ScreenContainer', () => ({ ScreenContainer: 'ScreenContainer' }));
jest.mock('../src/components/Common', () => ({
  BackHeader: ({ right }: { right?: React.ReactNode }) => <>{right}</>,
  Tag: 'Tag',
  Waveform: 'Waveform',
}));
jest.mock('../src/components/BottomTabBar', () => ({
  BottomTabBar: 'BottomTabBar',
  BOTTOM_TAB_BAR_GEOMETRY: { scrollContentClearance: 100 },
}));
jest.mock('../src/store/AuthStore', () => ({ useAuth: jest.fn() }));
jest.mock('../src/store/MeetingsStore', () => ({ useMeetings: jest.fn() }));
jest.mock('../src/components/AppDialog', () => ({
  useAppDialog: () => ({ showDialog }),
}));
jest.mock('../src/services/api', () => ({
  fetchMeetingAudioInfo: jest.fn(),
  fetchMeetingSummary: jest.fn(),
  fetchMeetingTranscript: jest.fn(),
}));
jest.mock('../src/services/meetingSummary', () => ({
  meetingSummaryToText: jest.fn(() => ''),
}));
jest.mock('../src/services/meetingShare', () => ({
  meetingShareErrorMessage: jest.fn(),
  shareMeetingArtifact: jest.fn(),
}));

describe('RecordingScreen accessibility', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (useAuth as jest.Mock).mockReturnValue({ accessToken: null, isGuest: true });
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
      getCachedTranscript: jest.fn(() => []),
      saveCachedTranscript: jest.fn(),
      getCachedSummary: jest.fn(() => null),
      saveCachedSummary: jest.fn(),
    });
  });

  it('labels recording actions and opens the share menu', async () => {
    const navigation = {
      goBack: jest.fn(),
      navigate: jest.fn(),
    } as unknown as React.ComponentProps<typeof RecordingScreen>['navigation'];
    const route = {
      key: 'recording-1',
      name: 'Recording' as const,
      params: { meetingId: 'guest-meeting-1' },
    } as React.ComponentProps<typeof RecordingScreen>['route'];

    const view = await render(<RecordingScreen navigation={navigation} route={route} />);

    expect(await view.findByLabelText('播放会议录音')).toBeTruthy();
    expect(view.getByLabelText('编辑会议标题')).toBeTruthy();
    expect(view.getByLabelText('播放速度 1 倍，点击切换')).toBeTruthy();
    expect(view.getByLabelText('录音播放进度')).toBeTruthy();
    expect(view.getByLabelText('查看会议转写')).toBeTruthy();
    expect(view.getByLabelText('查看会议总结')).toBeTruthy();
    expect(view.getByLabelText('删除会议')).toBeTruthy();

    await fireEvent.press(view.getByLabelText('编辑会议标题'));
    expect(navigation.navigate).toHaveBeenCalledWith('Transcription', {
      meetingId: 'guest-meeting-1',
      focus: 'title',
    });

    await fireEvent.press(view.getByLabelText('分享会议资料'));
    expect(showDialog).toHaveBeenCalledWith(expect.objectContaining({
      title: '分享会议文件',
    }));
  });

  it('shows the specific safe failure when a cloud recording URL is rejected', async () => {
    (useAuth as jest.Mock).mockReturnValue({ accessToken: 'token', isGuest: false });
    (useMeetings as jest.Mock).mockReturnValue({
      meetings: [{
        id: 'meeting-unsafe',
        title: '云端会议',
        date: '2026年7月11日',
        time: '16:00',
        duration: '10 分钟',
        tags: [],
        audioAvailable: true,
      }],
      deleteMeeting: jest.fn(),
      getCachedTranscript: jest.fn(() => []),
      saveCachedTranscript: jest.fn(),
      getCachedSummary: jest.fn(() => null),
      saveCachedSummary: jest.fn(),
    });
    (fetchMeetingAudioInfo as jest.Mock).mockRejectedValueOnce(new MeetingAudioUrlError(
      'AUTH_ORIGIN_MISMATCH',
      'unsafe origin',
    ));
    (fetchMeetingTranscript as jest.Mock).mockResolvedValueOnce([]);
    const navigation = { goBack: jest.fn(), navigate: jest.fn() } as unknown as React.ComponentProps<typeof RecordingScreen>['navigation'];
    const route = {
      key: 'recording-unsafe',
      name: 'Recording' as const,
      params: { meetingId: 'meeting-unsafe' },
    } as React.ComponentProps<typeof RecordingScreen>['route'];

    const view = await render(<RecordingScreen navigation={navigation} route={route} />);
    expect(await view.findByText('录音地址未通过安全校验，已停止发送登录凭据。')).toBeTruthy();
    expect(view.getByLabelText('重试获取会议录音')).toBeTruthy();

    (fetchMeetingAudioInfo as jest.Mock).mockResolvedValueOnce({
      url: 'https://meeting.example.test/audio.wav',
      mime_type: 'audio/wav',
      duration_sec: 12,
    });
    await act(async () => {
      await view.getByLabelText('重试获取会议录音').props.onPress();
      await Promise.resolve();
      await Promise.resolve();
    });

    await waitFor(() => expect(fetchMeetingAudioInfo).toHaveBeenCalledTimes(2));
    expect(await view.findByLabelText('播放会议录音')).toBeTruthy();
  });
});
