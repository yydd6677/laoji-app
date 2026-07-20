import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { AppState, StyleSheet } from 'react-native';
import { SpeakerManagerScreen } from '../src/screens/SpeakerManagerScreen';
import { SpeakerEnrollmentScreen } from '../src/screens/SpeakerEnrollmentScreen';
import { useAuth } from '../src/store/AuthStore';
import { fetchSpeakers, registerSpeaker } from '../src/services/speakers';
import { deleteLocalWavRecording, startLocalWavRecording } from '../src/services/realtimeAsr';
import { requestRecordingPermissionsAsync, setAudioModeAsync } from 'expo-audio';

jest.mock('@expo/vector-icons', () => ({ Ionicons: 'Ionicons' }));
jest.mock('@react-navigation/native', () => ({
  useFocusEffect: (callback: () => void) => {
    const ReactModule = require('react');
    ReactModule.useEffect(callback, [callback]);
  },
}));
jest.mock('../src/components/ScreenContainer', () => ({ ScreenContainer: 'ScreenContainer' }));
jest.mock('../src/components/Common', () => ({
  Avatar: 'Avatar',
  BackHeader: ({ title, right }: { title: string; right?: React.ReactNode }) => {
    const ReactNative = require('react-native');
    return <><ReactNative.Text>{title}</ReactNative.Text>{right}</>;
  },
}));
jest.mock('../src/components/AppDialog', () => ({
  useAppDialog: () => ({ showDialog: jest.fn() }),
}));
jest.mock('../src/store/AuthStore', () => ({ useAuth: jest.fn() }));
jest.mock('../src/services/speakers', () => ({
  fetchSpeakers: jest.fn(),
  registerSpeaker: jest.fn(),
  supplementSpeaker: jest.fn(),
  renameSpeaker: jest.fn(),
  deleteSpeaker: jest.fn(),
}));
jest.mock('../src/services/realtimeAsr', () => ({
  deleteLocalWavRecording: jest.fn(async () => undefined),
  startLocalWavRecording: jest.fn(),
}));
jest.mock('expo-audio', () => ({
  requestRecordingPermissionsAsync: jest.fn(async () => ({ granted: true })),
  setAudioModeAsync: jest.fn(async () => undefined),
}));

const navigation = {
  navigate: jest.fn(),
  goBack: jest.fn(),
} as unknown as React.ComponentProps<typeof SpeakerManagerScreen>['navigation'];

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(resolvePromise => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

describe('speaker management screens', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    AppState.currentState = 'active';
  });

  it('keeps voiceprints unavailable to guest mode and offers an account route', async () => {
    const signOut = jest.fn(async () => undefined);
    (useAuth as jest.Mock).mockReturnValue({ isGuest: true, accessToken: null, signOut });
    await render(<SpeakerManagerScreen navigation={navigation} />);

    expect(screen.getByText('请先登录账号')).toBeTruthy();
    fireEvent.press(screen.getByLabelText('退出访客模式并登录'));
    expect(signOut).toHaveBeenCalledTimes(1);
    expect(navigation.navigate).not.toHaveBeenCalled();
    expect(fetchSpeakers).not.toHaveBeenCalled();
  });

  it('keeps existing-speaker actions hidden after a load failure and offers retry', async () => {
    (useAuth as jest.Mock).mockReturnValue({ isGuest: false, accessToken: 'token-7' });
    (fetchSpeakers as jest.Mock)
      .mockRejectedValueOnce(new Error('network offline'))
      .mockResolvedValueOnce([{ speaker_id: 'u7_a', name: '张老师', sample_count: 2, quality: 0.83 }]);
    const route = {
      key: 'speaker-existing',
      name: 'SpeakerEnrollment' as const,
      params: { speakerId: 'u7_a' },
    } as React.ComponentProps<typeof SpeakerEnrollmentScreen>['route'];
    const enrollmentNavigation = navigation as unknown as React.ComponentProps<typeof SpeakerEnrollmentScreen>['navigation'];
    await render(<SpeakerEnrollmentScreen navigation={enrollmentNavigation} route={route} />);

    expect(await screen.findByText('讲话人未能加载')).toBeTruthy();
    expect(screen.queryByLabelText('删除讲话人')).toBeNull();
    expect(screen.queryByLabelText('开始录制音色')).toBeNull();
    await fireEvent.press(screen.getByLabelText('重试加载讲话人详情'));

    expect(await screen.findByDisplayValue('张老师')).toBeTruthy();
    expect(screen.getByLabelText('删除讲话人')).toBeTruthy();
    expect(screen.getByTestId('speaker-delete-icon').props.size).toBe(24);
    expect(StyleSheet.flatten(screen.getByLabelText('删除讲话人').props.style)).toEqual(
      expect.objectContaining({ width: 48, height: 44 }),
    );
    expect(screen.getByLabelText('开始录制音色')).toBeTruthy();
  });

  it('shows an explicit management entry and account-owned speaker rows', async () => {
    (useAuth as jest.Mock).mockReturnValue({ isGuest: false, accessToken: 'token-7' });
    (fetchSpeakers as jest.Mock).mockResolvedValueOnce([
      { speaker_id: 'u7_a', name: '张老师', sample_count: 2, quality: 0.83 },
    ]);
    await render(<SpeakerManagerScreen navigation={navigation} />);

    expect(await screen.findByLabelText('管理讲话人张老师')).toBeTruthy();
    expect(screen.getByLabelText('新建讲话人')).toBeTruthy();
    expect(StyleSheet.flatten(screen.getByLabelText('新建讲话人').props.style).height).toBe(64);
    expect(StyleSheet.flatten(screen.getByLabelText('管理讲话人张老师').props.style).height).toBe(66);
    expect(screen.queryByText('2 段音色 · 质量优秀')).toBeNull();
    expect(screen.queryByText('会议只会使用当前账号保存的声纹识别讲话人。')).toBeNull();
    await fireEvent.press(screen.getByLabelText('管理讲话人张老师'));
    expect(navigation.navigate).toHaveBeenCalledWith('SpeakerEnrollment', { speakerId: 'u7_a' });
  });

  it('discards a delayed speaker list after switching accounts', async () => {
    let auth = { isGuest: false, accessToken: 'token-A' };
    (useAuth as jest.Mock).mockImplementation(() => auth);
    const accountA = deferred<Array<Record<string, unknown>>>();
    const accountB = deferred<Array<Record<string, unknown>>>();
    (fetchSpeakers as jest.Mock).mockImplementation((token: string) => (
      token === 'token-A' ? accountA.promise : accountB.promise
    ));
    const view = await render(<SpeakerManagerScreen navigation={navigation} />);
    await waitFor(() => expect(fetchSpeakers).toHaveBeenCalledWith('token-A'));

    auth = { isGuest: false, accessToken: 'token-B' };
    await view.rerender(<SpeakerManagerScreen navigation={navigation} />);
    expect(screen.queryByText('A 账号讲话人')).toBeNull();
    await waitFor(() => expect(fetchSpeakers).toHaveBeenCalledWith('token-B'));

    accountB.resolve([{ speaker_id: 'B-1', name: 'B 账号讲话人', sample_count: 1, quality: 0.8 }]);
    expect(await screen.findByText('B 账号讲话人')).toBeTruthy();
    accountA.resolve([{ speaker_id: 'A-1', name: 'A 账号讲话人', sample_count: 1, quality: 0.8 }]);
    await Promise.resolve();
    await Promise.resolve();

    expect(screen.getByText('B 账号讲话人')).toBeTruthy();
    expect(screen.queryByText('A 账号讲话人')).toBeNull();
  });

  it('keeps the source-aligned bottom recording action fixed when an error appears', async () => {
    (useAuth as jest.Mock).mockReturnValue({ isGuest: false, accessToken: 'token-7' });
    (startLocalWavRecording as jest.Mock).mockRejectedValueOnce(new Error('native recorder unavailable'));
    const route = { key: 'speaker', name: 'SpeakerEnrollment', params: undefined } as unknown as React.ComponentProps<typeof SpeakerEnrollmentScreen>['route'];
    const enrollmentNavigation = navigation as unknown as React.ComponentProps<typeof SpeakerEnrollmentScreen>['navigation'];
    await render(<SpeakerEnrollmentScreen navigation={enrollmentNavigation} route={route} />);

    expect(screen.getByText('声纹采集')).toBeTruthy();
    expect(screen.getByPlaceholderText('输入人名')).toBeTruthy();
    expect(screen.getByText('请在安静环境下，点击“开始”后朗读下方文字')).toBeTruthy();
    expect(screen.getByText('今天的会议将围绕项目进展展开，请大家依次说明完成情况和下一步安排。')).toBeTruthy();
    const action = screen.getByLabelText('开始录制音色');
    expect(StyleSheet.flatten(action.props.style)).toEqual(expect.objectContaining({ height: 48 }));
    expect(screen.getAllByTestId('speaker-volume-segment')).toHaveLength(10);
    await fireEvent.press(action);
    expect(await screen.findByText('native recorder unavailable')).toBeTruthy();
    expect(StyleSheet.flatten(screen.getByLabelText('开始录制音色').props.style))
      .toEqual(expect.objectContaining({ height: 48 }));
    expect(screen.getByTestId('speaker-recording-bottom-bar')).toBeTruthy();
  });

  it('surfaces microphone permission request failures without starting native recording', async () => {
    (useAuth as jest.Mock).mockReturnValue({ isGuest: false, accessToken: 'token-7' });
    (requestRecordingPermissionsAsync as jest.Mock).mockRejectedValueOnce(new Error('permission service unavailable'));
    const route = { key: 'speaker', name: 'SpeakerEnrollment', params: undefined } as unknown as React.ComponentProps<typeof SpeakerEnrollmentScreen>['route'];
    const enrollmentNavigation = navigation as unknown as React.ComponentProps<typeof SpeakerEnrollmentScreen>['navigation'];
    await render(<SpeakerEnrollmentScreen navigation={enrollmentNavigation} route={route} />);

    await fireEvent.press(screen.getByLabelText('开始录制音色'));

    expect(await screen.findByText('permission service unavailable')).toBeTruthy();
    expect(startLocalWavRecording).not.toHaveBeenCalled();
  });

  it('does not acquire the microphone while the app is no longer active', async () => {
    (useAuth as jest.Mock).mockReturnValue({ isGuest: false, accessToken: 'token-7' });
    const previousState = AppState.currentState;
    AppState.currentState = 'background';
    const route = { key: 'speaker', name: 'SpeakerEnrollment', params: undefined } as unknown as React.ComponentProps<typeof SpeakerEnrollmentScreen>['route'];
    const enrollmentNavigation = navigation as unknown as React.ComponentProps<typeof SpeakerEnrollmentScreen>['navigation'];
    await render(<SpeakerEnrollmentScreen navigation={enrollmentNavigation} route={route} />);

    await fireEvent.press(screen.getByLabelText('开始录制音色'));

    expect(startLocalWavRecording).not.toHaveBeenCalled();
    AppState.currentState = previousState;
  });

  it('stops and removes an active temporary recording when the screen unmounts', async () => {
    (useAuth as jest.Mock).mockReturnValue({ isGuest: false, accessToken: 'token-7' });
    const stop = jest.fn(async () => '/data/user/0/com.laoji.app/files/unmounted.wav');
    (startLocalWavRecording as jest.Mock).mockResolvedValueOnce({ fileName: 'unmounted.wav', stop });
    const route = { key: 'speaker', name: 'SpeakerEnrollment', params: undefined } as unknown as React.ComponentProps<typeof SpeakerEnrollmentScreen>['route'];
    const enrollmentNavigation = navigation as unknown as React.ComponentProps<typeof SpeakerEnrollmentScreen>['navigation'];
    const rendered = await render(<SpeakerEnrollmentScreen navigation={enrollmentNavigation} route={route} />);

    await fireEvent.press(screen.getByLabelText('开始录制音色'));
    expect(await screen.findByLabelText('停止录制音色')).toBeTruthy();
    await rendered.unmount();

    await waitFor(() => expect(stop).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(deleteLocalWavRecording).toHaveBeenCalledWith(
      '/data/user/0/com.laoji.app/files/unmounted.wav',
    ));
  });

  it('locks destructive speaker actions while a voiceprint is being recorded', async () => {
    (useAuth as jest.Mock).mockReturnValue({ isGuest: false, accessToken: 'token-7' });
    (fetchSpeakers as jest.Mock).mockResolvedValueOnce([
      { speaker_id: 'u7_a', name: '张老师', sample_count: 2, quality: 0.83 },
    ]);
    (startLocalWavRecording as jest.Mock).mockResolvedValueOnce({
      fileName: 'locked.wav',
      stop: jest.fn(async () => '/data/user/0/com.laoji.app/files/locked.wav'),
    });
    const route = {
      key: 'speaker-locked',
      name: 'SpeakerEnrollment' as const,
      params: { speakerId: 'u7_a' },
    } as React.ComponentProps<typeof SpeakerEnrollmentScreen>['route'];
    const enrollmentNavigation = navigation as unknown as React.ComponentProps<typeof SpeakerEnrollmentScreen>['navigation'];
    const view = await render(<SpeakerEnrollmentScreen navigation={enrollmentNavigation} route={route} />);

    expect(await screen.findByDisplayValue('张老师')).toBeTruthy();
    expect(screen.getByLabelText('删除讲话人').props.accessibilityState).toEqual({ disabled: false });
    await fireEvent.press(screen.getByLabelText('开始录制音色'));
    expect((await screen.findByLabelText('删除讲话人')).props.accessibilityState).toEqual({ disabled: true });

    await view.unmount();
  });

  it('removes a temporary WAV after a new speaker is uploaded successfully', async () => {
    (useAuth as jest.Mock).mockReturnValue({ isGuest: false, accessToken: 'token-7' });
    const stop = jest.fn(async () => '/data/user/0/com.laoji.app/files/speaker-ui.wav');
    (startLocalWavRecording as jest.Mock).mockResolvedValueOnce({ fileName: 'speaker-ui.wav', stop });
    (registerSpeaker as jest.Mock).mockResolvedValueOnce({
      success: true,
      speaker: { speaker_id: 'u7_new', name: '王老师', sample_count: 1, quality: 0.8 },
    });
    const now = jest.spyOn(Date, 'now').mockReturnValue(1_000);
    const route = { key: 'speaker', name: 'SpeakerEnrollment', params: undefined } as unknown as React.ComponentProps<typeof SpeakerEnrollmentScreen>['route'];
    const enrollmentNavigation = navigation as unknown as React.ComponentProps<typeof SpeakerEnrollmentScreen>['navigation'];
    const rendered = await render(<SpeakerEnrollmentScreen navigation={enrollmentNavigation} route={route} />);

    try {
      await fireEvent.changeText(screen.getByLabelText('讲话人名称'), '王老师');
      await fireEvent.press(screen.getByLabelText('开始录制音色'));
      const stopAction = await screen.findByLabelText('停止录制音色');
      expect(StyleSheet.flatten(stopAction.props.style)).toEqual(expect.objectContaining({
        height: 48,
        borderWidth: 1,
      }));
      now.mockReturnValue(4_000);
      await fireEvent.press(screen.getByLabelText('停止录制音色'));
      expect(await screen.findByText('录音已就绪')).toBeTruthy();
      expect(screen.getByLabelText('重新录制音色')).toBeTruthy();
      expect(setAudioModeAsync).toHaveBeenLastCalledWith({
        allowsRecording: false,
        playsInSilentMode: true,
      });
      await fireEvent.press(screen.getByLabelText('保存新讲话人音色'));

      await waitFor(() => expect(registerSpeaker).toHaveBeenCalledWith(
        '王老师',
        '/data/user/0/com.laoji.app/files/speaker-ui.wav',
        'speaker-ui.wav',
        'token-7',
      ));
      await waitFor(() => expect(deleteLocalWavRecording).toHaveBeenCalledWith(
        '/data/user/0/com.laoji.app/files/speaker-ui.wav',
      ));
    } finally {
      now.mockRestore();
      await rendered.unmount();
    }
  });

  it('submits a recorded voiceprint only once when the save action is tapped repeatedly', async () => {
    (useAuth as jest.Mock).mockReturnValue({ isGuest: false, accessToken: 'token-7' });
    const stop = jest.fn(async () => '/data/user/0/com.laoji.app/files/speaker-once.wav');
    (startLocalWavRecording as jest.Mock).mockResolvedValueOnce({ fileName: 'speaker-once.wav', stop });
    const upload = deferred<Record<string, unknown>>();
    (registerSpeaker as jest.Mock).mockReturnValue(upload.promise);
    const now = jest.spyOn(Date, 'now').mockReturnValue(1_000);
    const route = { key: 'speaker-once', name: 'SpeakerEnrollment', params: undefined } as unknown as React.ComponentProps<typeof SpeakerEnrollmentScreen>['route'];
    const enrollmentNavigation = navigation as unknown as React.ComponentProps<typeof SpeakerEnrollmentScreen>['navigation'];
    const view = await render(<SpeakerEnrollmentScreen navigation={enrollmentNavigation} route={route} />);

    try {
      await fireEvent.changeText(screen.getByLabelText('讲话人名称'), '李老师');
      await fireEvent.press(screen.getByLabelText('开始录制音色'));
      now.mockReturnValue(4_000);
      await fireEvent.press(await screen.findByLabelText('停止录制音色'));
      const save = await screen.findByLabelText('保存新讲话人音色');
      await act(async () => {
        save.props.onPress();
        save.props.onPress();
        await Promise.resolve();
      });

      expect(registerSpeaker).toHaveBeenCalledTimes(1);
      upload.resolve({
        success: true,
        speaker: { speaker_id: 'u7_once', name: '李老师', sample_count: 1, quality: 0.8 },
      });
      await waitFor(() => expect(deleteLocalWavRecording).toHaveBeenCalledWith(
        '/data/user/0/com.laoji.app/files/speaker-once.wav',
      ));
    } finally {
      now.mockRestore();
      await view.unmount();
    }
  });
});
