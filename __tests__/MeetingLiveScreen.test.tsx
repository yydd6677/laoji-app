import React from 'react';
import { AppState } from 'react-native';
import { act, render, waitFor } from '@testing-library/react-native';
import { MeetingLiveScreen } from '../src/screens/MeetingLiveScreen';
import { useAuth } from '../src/store/AuthStore';
import { useMeetings } from '../src/store/MeetingsStore';
import { startRealtimeAsr } from '../src/services/realtimeAsr';
import { Audio } from 'expo-av';

const showDialog = jest.fn();

jest.mock('@expo/vector-icons', () => ({ Ionicons: 'Ionicons' }));
jest.mock('expo-av', () => ({
  Audio: {
    requestPermissionsAsync: jest.fn(async () => ({ granted: true })),
    setAudioModeAsync: jest.fn(async () => undefined),
  },
}));
jest.mock('../src/components/ScreenContainer', () => ({ ScreenContainer: 'ScreenContainer' }));
jest.mock('../src/components/Common', () => ({ BackHeader: 'BackHeader' }));
jest.mock('../src/components/BottomTabBar', () => ({
  BottomTabBar: ({ onMic }: { onMic: () => void }) => {
    const ReactNative = require('react-native');
    return <ReactNative.TouchableOpacity testID="meeting-live-mic" onPress={onMic} />;
  },
  BOTTOM_TAB_BAR_GEOMETRY: { scrollContentClearance: 100 },
}));
jest.mock('../src/components/AppDialog', () => ({
  useAppDialog: () => ({ showDialog }),
}));
jest.mock('../src/store/AuthStore', () => ({ useAuth: jest.fn() }));
jest.mock('../src/store/MeetingsStore', () => ({ useMeetings: jest.fn() }));
jest.mock('../src/services/api', () => ({
  createGuestRealtimeSession: jest.fn(),
  deleteGuestRealtimeSession: jest.fn(async () => undefined),
  uploadMeetingAudio: jest.fn(),
}));
jest.mock('../src/services/realtimeAsr', () => ({
  startRealtimeAsr: jest.fn(),
}));

const navigation = {
  addListener: jest.fn(() => jest.fn()),
  dispatch: jest.fn(),
  goBack: jest.fn(),
  navigate: jest.fn(),
  replace: jest.fn(),
} as unknown as React.ComponentProps<typeof MeetingLiveScreen>['navigation'];

function meetingStore(overrides: Record<string, unknown> = {}) {
  return {
    meetings: [],
    createMeeting: jest.fn(),
    deleteMeeting: jest.fn(async () => undefined),
    updateMeetingStatus: jest.fn(async () => true),
    getCachedTranscript: jest.fn(() => []),
    saveCachedTranscript: jest.fn(async () => undefined),
    refreshMeetings: jest.fn(async () => undefined),
    ...overrides,
  };
}

describe('MeetingLiveScreen reliability', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (useAuth as jest.Mock).mockReturnValue({
      accessToken: 'token-7',
      isGuest: false,
      session: { user: { id: 7 } },
    });
  });

  it('renders only the latest 40 live lines while retaining the full count', async () => {
    const transcript = Array.from({ length: 75 }, (_, index) => ({
      id: `line-${index + 1}`,
      meeting_id: 'meeting-long',
      text: `第 ${index + 1} 句`,
      start_time: index,
    }));
    const meeting = {
      id: 'meeting-long',
      title: '长会议',
      date: '2026年7月13日',
      duration: '—',
      tags: [],
      participants: [],
      status: 'ended',
    };
    (useMeetings as jest.Mock).mockReturnValue(meetingStore({
      meetings: [meeting],
      getCachedTranscript: jest.fn(() => transcript),
    }));
    const route = {
      key: 'meeting-live-long',
      name: 'MeetingLive' as const,
      params: { meetingId: 'meeting-long' },
    } as React.ComponentProps<typeof MeetingLiveScreen>['route'];

    const view = await render(<MeetingLiveScreen navigation={navigation} route={route} />);

    expect(view.getByText('75 句')).toBeTruthy();
    expect(view.getByText('较早的 35 句已收纳')).toBeTruthy();
    expect(view.getAllByTestId('meeting-live-transcript-line')).toHaveLength(40);
    expect(view.queryByText('第 35 句')).toBeNull();
    expect(view.getByText('第 36 句')).toBeTruthy();
    expect(view.getByText('第 75 句')).toBeTruthy();
  });

  it('deletes a newly created empty meeting when the screen closes during startup', async () => {
    let resolveMeeting = (_meeting: Record<string, unknown>) => {};
    const createMeeting = jest.fn(() => new Promise(resolve => {
      resolveMeeting = resolve;
    }));
    const deleteMeeting = jest.fn(async () => undefined);
    (useMeetings as jest.Mock).mockReturnValue(meetingStore({ createMeeting, deleteMeeting }));
    const route = {
      key: 'meeting-live-new',
      name: 'MeetingLive' as const,
      params: undefined,
    } as React.ComponentProps<typeof MeetingLiveScreen>['route'];
    const view = await render(<MeetingLiveScreen navigation={navigation} route={route} />);

    await act(async () => {
      view.getByTestId('meeting-live-mic').props.onPress();
      await Promise.resolve();
    });
    await waitFor(() => expect(createMeeting).toHaveBeenCalledTimes(1));
    await view.unmount();
    await act(async () => {
      resolveMeeting({
        id: 'meeting-cancelled',
        title: '取消中的会议',
        date: '2026年7月13日',
        duration: '—',
        tags: [],
        participants: [],
        status: 'created',
      });
      await Promise.resolve();
    });

    await waitFor(() => expect(deleteMeeting).toHaveBeenCalledWith('meeting-cancelled'));
    expect(startRealtimeAsr).not.toHaveBeenCalled();
    expect(showDialog).not.toHaveBeenCalled();
  });

  it('ends and saves an active meeting when the app enters the background', async () => {
    let appStateListener = (_state: string) => {};
    (AppState.addEventListener as jest.Mock).mockImplementation((_event, listener) => {
      appStateListener = listener;
      return { remove: jest.fn() };
    });
    const createMeeting = jest.fn(async () => ({
      id: 'meeting-background',
      title: '后台保护会议',
      date: '2026年7月13日',
      duration: '—',
      tags: [],
      participants: [],
      status: 'created',
    }));
    const updateMeetingStatus = jest.fn(async () => true);
    const stop = jest.fn(async () => '/data/user/0/meeting-background.wav');
    (startRealtimeAsr as jest.Mock).mockResolvedValue({
      meetingId: 'meeting-background',
      url: 'ws://asr.example.test',
      stop,
      completion: new Promise(() => {}),
    });
    (useMeetings as jest.Mock).mockReturnValue(meetingStore({ createMeeting, updateMeetingStatus }));
    const route = {
      key: 'meeting-live-background',
      name: 'MeetingLive' as const,
      params: undefined,
    } as React.ComponentProps<typeof MeetingLiveScreen>['route'];
    const view = await render(<MeetingLiveScreen navigation={navigation} route={route} />);

    await act(async () => {
      view.getByTestId('meeting-live-mic').props.onPress();
      await Promise.resolve();
    });
    await waitFor(() => expect(startRealtimeAsr).toHaveBeenCalledTimes(1));

    await act(async () => {
      appStateListener('background');
      await Promise.resolve();
    });

    await waitFor(() => expect(stop).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(navigation.replace).toHaveBeenCalledWith('Transcription', {
      meetingId: 'meeting-background',
    }));
    expect(Audio.setAudioModeAsync).toHaveBeenLastCalledWith({
      allowsRecordingIOS: false,
      playsInSilentModeIOS: true,
    });
    expect(updateMeetingStatus).toHaveBeenNthCalledWith(1, 'meeting-background', 'recording');
    expect(updateMeetingStatus).toHaveBeenNthCalledWith(
      2,
      'meeting-background',
      'ended',
      expect.objectContaining({ audioAvailable: true }),
    );
  });
});
