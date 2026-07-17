import React from 'react';
import { act, fireEvent, render, waitFor } from '@testing-library/react-native';
import { createAudioPlayer } from 'expo-audio';
import {
  MEETING_AUDIO_PLAYER_GEOMETRY,
  MeetingAudioPlayerDock,
} from '../src/components/MeetingAudioPlayerDock';
import { fetchMeetingAudioInfo } from '../src/services/api';
import { MeetingAudioUrlError } from '../src/services/meetingAudioSecurity';

const showDialog = jest.fn();
const player = {
  pause: jest.fn(),
  play: jest.fn(),
  seekTo: jest.fn(async () => {}),
  setPlaybackRate: jest.fn(),
  addListener: jest.fn(() => ({ remove: jest.fn() })),
  remove: jest.fn(),
};

jest.mock('@expo/vector-icons', () => ({ Ionicons: 'Ionicons' }));
jest.mock('expo-audio', () => ({
  createAudioPlayer: jest.fn(),
  setAudioModeAsync: jest.fn(async () => {}),
}));
jest.mock('../src/components/AppDialog', () => ({
  useAppDialog: () => ({ showDialog }),
}));
jest.mock('../src/services/api', () => ({
  fetchMeetingAudioInfo: jest.fn(),
}));

const guestMeeting = {
  id: 'guest-meeting-1',
  title: '现场会议',
  date: '2026年7月15日',
  time: '10:00',
  duration: '02:35',
  tags: [],
  audioAvailable: true,
  audioLocalUri: 'file:///data/meeting.wav',
  audioDurationSec: 155,
};

describe('MeetingAudioPlayerDock', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (createAudioPlayer as jest.Mock).mockReturnValue(player);
  });

  it('uses the Feishu detail-player geometry and exposes real playback controls', async () => {
    const view = await render(
      <MeetingAudioPlayerDock
        meeting={guestMeeting}
        accessToken={null}
        isGuest
      />,
    );

    expect(view.getByTestId('meeting-audio-player-dock')).toHaveStyle({ backgroundColor: '#FFFFFF' });
    expect(view.getByLabelText('播放会议录音')).toHaveStyle({
      width: MEETING_AUDIO_PLAYER_GEOMETRY.playButtonWidth,
      height: MEETING_AUDIO_PLAYER_GEOMETRY.playButtonHeight,
      borderRadius: 6,
    });
    expect(view.getByLabelText('播放速度 1 倍，点击切换')).toBeTruthy();
    expect(view.getByLabelText('录音播放进度')).toBeTruthy();
    expect(view.getByLabelText('后退 15 秒')).toBeTruthy();
    expect(view.getByLabelText('前进 15 秒')).toBeTruthy();

    await act(async () => {
      fireEvent.press(view.getByLabelText('播放会议录音'));
    });
    expect(createAudioPlayer).toHaveBeenCalledWith(
      { uri: 'file:///data/meeting.wav' },
      expect.objectContaining({ updateInterval: 200 }),
    );
    expect(player.play).toHaveBeenCalledTimes(1);

    await act(async () => {
      fireEvent.press(view.getByLabelText('前进 15 秒'));
    });
    expect(player.seekTo).toHaveBeenCalledWith(15);
  });

  it('shows a specific safe failure and can request the recording again', async () => {
    (fetchMeetingAudioInfo as jest.Mock).mockRejectedValueOnce(new MeetingAudioUrlError(
      'AUTH_ORIGIN_MISMATCH',
      'unsafe origin',
    ));
    const cloudMeeting = {
      ...guestMeeting,
      id: 'meeting-unsafe',
      audioLocalUri: null,
      source: 'cloud' as const,
    };
    const view = await render(
      <MeetingAudioPlayerDock
        meeting={cloudMeeting}
        accessToken="token"
        isGuest={false}
      />,
    );

    expect(await view.findByText('录音地址未通过安全校验，已停止发送登录凭据。')).toBeTruthy();
    (fetchMeetingAudioInfo as jest.Mock).mockResolvedValueOnce({
      url: 'https://meeting.example.test/audio.wav',
      mime_type: 'audio/wav',
      duration_sec: 12,
    });

    await act(async () => {
      fireEvent.press(view.getByLabelText('重试获取会议录音'));
    });

    await waitFor(() => expect(fetchMeetingAudioInfo).toHaveBeenCalledTimes(2));
    expect(await view.findByLabelText('播放会议录音')).toBeTruthy();
    expect(showDialog).not.toHaveBeenCalled();
  });
});
