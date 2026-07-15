import React from 'react';
import { AppState, StyleSheet } from 'react-native';
import { act, fireEvent, render, waitFor } from '@testing-library/react-native';
import { MeetingLiveScreen, MEETING_RECORDING_GEOMETRY } from '../src/screens/MeetingLiveScreen';
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
jest.mock('../src/components/Common', () => ({ Waveform: 'Waveform' }));
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
    updateMeetingTitle: jest.fn(async () => undefined),
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

  it('renders the latest 40 live lines in the source-aligned recording layout', async () => {
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

    expect(view.getByText('较早的 35 句已收纳')).toBeTruthy();
    expect(view.getAllByTestId('meeting-live-transcript-line')).toHaveLength(40);
    expect(view.queryByText('第 35 句')).toBeNull();
    expect(view.getByText('第 36 句')).toBeTruthy();
    expect(view.getByText('第 75 句')).toBeTruthy();
    expect(StyleSheet.flatten(view.getByTestId('meeting-live-title').props.style)).toMatchObject({
      fontSize: 24,
      lineHeight: 36,
    });
    expect(view.queryByText('文字记录')).toBeNull();
    expect(StyleSheet.flatten(view.getByTestId('meeting-live-single-tab-divider').props.style))
      .toEqual(expect.objectContaining({
        height: MEETING_RECORDING_GEOMETRY.singleTabDividerHeight,
        marginHorizontal: 20,
      }));
    expect(StyleSheet.flatten(view.getByTestId('meeting-live-recording-toolbar').props.style).height)
      .toBe(MEETING_RECORDING_GEOMETRY.toolbarHeight);
    expect(StyleSheet.flatten(view.getByTestId('meeting-live-waveform-slot').props.style)).toEqual(
      expect.objectContaining({
        height: MEETING_RECORDING_GEOMETRY.waveformHeight,
        marginTop: 12,
      }),
    );
    expect(StyleSheet.flatten(view.getByTestId('meeting-live-control-row').props.style).height)
      .toBe(MEETING_RECORDING_GEOMETRY.controlRowHeight);
    expect(StyleSheet.flatten(view.getAllByTestId('meeting-live-speaker-avatar')[0].props.style))
      .toEqual(expect.objectContaining({
        width: MEETING_RECORDING_GEOMETRY.transcriptAvatarSize,
        height: MEETING_RECORDING_GEOMETRY.transcriptAvatarSize,
      }));
    expect(StyleSheet.flatten(view.getAllByTestId('meeting-live-transcript-item')[0].props.style))
      .not.toEqual(expect.objectContaining({ flexDirection: 'row' }));
    expect(StyleSheet.flatten(view.getAllByTestId('meeting-live-transcript-line')[0].props.style))
      .toEqual(expect.objectContaining({ marginTop: 8, marginLeft: 2 }));
    expect(view.queryByText('音频输入')).toBeNull();
    expect(view.queryByText('开始录音')).toBeNull();
  });

  it('reveals the source-style title editor only after the title is pressed', async () => {
    const meeting = {
      id: 'meeting-title',
      title: '原会议标题',
      date: '2026年7月15日',
      duration: '—',
      tags: [],
      participants: [],
      status: 'ended',
    };
    const updateMeetingTitle = jest.fn(async () => undefined);
    (useMeetings as jest.Mock).mockReturnValue(meetingStore({
      meetings: [meeting],
      updateMeetingTitle,
    }));
    const route = {
      key: 'meeting-live-title',
      name: 'MeetingLive' as const,
      params: { meetingId: meeting.id },
    } as React.ComponentProps<typeof MeetingLiveScreen>['route'];

    const view = await render(<MeetingLiveScreen navigation={navigation} route={route} />);

    expect(view.queryByLabelText('会议标题')).toBeNull();
    await fireEvent.press(view.getByLabelText('编辑会议标题'));
    const editor = view.getByLabelText('会议标题');
    expect(editor.props.selectTextOnFocus).toBe(true);

    await fireEvent.changeText(editor, '新的会议标题');
    await fireEvent(editor, 'blur');

    await waitFor(() => expect(updateMeetingTitle).toHaveBeenCalledWith(meeting.id, '新的会议标题'));
    expect(view.queryByLabelText('会议标题')).toBeNull();
    expect(view.getByText('新的会议标题')).toBeTruthy();

    await fireEvent.press(view.getByLabelText('编辑会议标题'));
    await fireEvent.changeText(view.getByLabelText('会议标题'), '   ');
    await fireEvent(view.getByLabelText('会议标题'), 'blur');

    expect(updateMeetingTitle).toHaveBeenCalledTimes(1);
    expect(view.getByText('新的会议标题')).toBeTruthy();
    expect(showDialog).not.toHaveBeenCalled();
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

  it('starts automatically and confirms before a user ends the recording', async () => {
    const createMeeting = jest.fn(async (title: string) => ({
      id: 'meeting-manual-stop',
      title,
      date: '2026年7月14日',
      duration: '—',
      tags: [],
      participants: [],
      status: 'created',
    }));
    const stop = jest.fn(async () => '/data/user/0/meeting-manual-stop.wav');
    const pause = jest.fn(async () => undefined);
    const resume = jest.fn(async () => undefined);
    (startRealtimeAsr as jest.Mock).mockResolvedValue({
      meetingId: 'meeting-manual-stop',
      url: 'ws://asr.example.test',
      pause,
      resume,
      stop,
      completion: new Promise(() => {}),
    });
    (useMeetings as jest.Mock).mockReturnValue(meetingStore({ createMeeting }));
    const route = {
      key: 'meeting-live-manual-stop',
      name: 'MeetingLive' as const,
      params: undefined,
    } as React.ComponentProps<typeof MeetingLiveScreen>['route'];

    const view = await render(<MeetingLiveScreen navigation={navigation} route={route} />);
    await waitFor(() => expect(startRealtimeAsr).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(view.getByLabelText('结束并保存会议录音')).toBeTruthy());

    const pauseButton = view.getByLabelText('暂停录音');
    expect(StyleSheet.flatten(pauseButton.props.style)).toEqual(expect.objectContaining({
      width: MEETING_RECORDING_GEOMETRY.resumePauseWidth,
      height: MEETING_RECORDING_GEOMETRY.durationHeight,
    }));
    await fireEvent.press(pauseButton);
    await waitFor(() => expect(pause).toHaveBeenCalledTimes(1));
    expect(view.getByText('录音已暂停')).toBeTruthy();
    await fireEvent.press(view.getByLabelText('继续录音'));
    await waitFor(() => expect(resume).toHaveBeenCalledTimes(1));

    await fireEvent.press(view.getByLabelText('结束并保存会议录音'));
    expect(showDialog).toHaveBeenCalledWith(expect.objectContaining({
      title: '结束录音？',
      actions: expect.arrayContaining([expect.objectContaining({ text: '结束录音' })]),
    }));

    const dialog = showDialog.mock.calls.at(-1)?.[0];
    const endAction = dialog?.actions?.find((action: { text?: string }) => action.text === '结束录音');
    await act(async () => {
      await endAction?.onPress?.();
      await Promise.resolve();
    });

    await waitFor(() => expect(stop).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(navigation.replace).toHaveBeenCalledWith('Transcription', {
      meetingId: 'meeting-manual-stop',
    }));
  });
});
