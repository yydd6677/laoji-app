import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { VoiceInputModal } from '../src/components/VoiceInputModal';
import {
  createGuestRealtimeSession,
  deleteGuestRealtimeSession,
  parseText,
} from '../src/services/api';
import { startRealtimeAsr } from '../src/services/realtimeAsr';
import { useEvents } from '../src/store/EventsStore';
import { Audio } from 'expo-av';
import * as FileSystem from 'expo-file-system/legacy';
import { StyleSheet } from 'react-native';

jest.mock('expo-linear-gradient', () => ({ LinearGradient: 'LinearGradient' }));
jest.mock('@expo/vector-icons', () => {
  const ReactModule = require('react');
  const Ionicons = (props: object) => ReactModule.createElement('Ionicons', props);
  Ionicons.glyphMap = {};
  return { Ionicons };
});
jest.mock('expo-av', () => ({
  Audio: {
    requestPermissionsAsync: jest.fn(),
    setAudioModeAsync: jest.fn(),
    Recording: { createAsync: jest.fn() },
    RecordingOptionsPresets: { HIGH_QUALITY: {} },
  },
}));
jest.mock('expo-file-system/legacy');
jest.mock('../src/services/api', () => ({
  parseText: jest.fn(),
  parseAudio: jest.fn(),
  clarifyText: jest.fn(),
  createGuestRealtimeSession: jest.fn(),
  deleteGuestRealtimeSession: jest.fn(),
}));
jest.mock('../src/services/realtimeAsr', () => ({ startRealtimeAsr: jest.fn() }));
jest.mock('../src/store/EventsStore', () => ({ useEvents: jest.fn() }));
jest.mock('../src/components/AppDialog', () => ({
  useAppDialog: () => ({ showDialog: jest.fn() }),
}));

const parsed = {
  title: '项目评审',
  event_type: 'once' as const,
  start_date: '2026-07-11',
  end_date: null,
  start_time: '15:00',
  end_time: '16:00',
  is_all_day: false,
  description: null,
  raw_text: '明天下午三点项目评审',
  parse_source: 'rules' as const,
  confidence: 1,
  needs_clarification: false,
  clarification_question: null,
  category: '工作' as const,
  reminder_minutes: 15,
};

describe('VoiceInputModal manual schedule path', () => {
  const addEvent = jest.fn();
  const refreshEvents = jest.fn();

  beforeEach(() => {
    jest.clearAllMocks();
    addEvent.mockResolvedValue(undefined);
    refreshEvents.mockResolvedValue(undefined);
    (useEvents as jest.Mock).mockReturnValue({ addEvent, refreshEvents });
    (parseText as jest.Mock).mockResolvedValue(parsed);
    (Audio.requestPermissionsAsync as jest.Mock).mockResolvedValue({ granted: true });
    (Audio.setAudioModeAsync as jest.Mock).mockResolvedValue(undefined);
    (FileSystem.deleteAsync as jest.Mock).mockResolvedValue(undefined);
    (createGuestRealtimeSession as jest.Mock).mockResolvedValue({
      meeting_id: 'guest-session-schedule-1',
      guest_token: 'schedule-token-1',
      expires_at: '2026-07-12T08:00:00Z',
      transient: true,
    });
    (deleteGuestRealtimeSession as jest.Mock).mockResolvedValue(undefined);
  });

  it('parses text and saves the confirmed structured schedule', async () => {
    const onSaved = jest.fn();
    await render(<VoiceInputModal visible onClose={jest.fn()} onSaved={onSaved} />);

    await fireEvent.changeText(screen.getByTestId('schedule-voice-input'), '明天下午三点项目评审');
    await fireEvent.press(screen.getByText('解析'));
    await waitFor(() => expect(screen.getByText('项目评审')).toBeTruthy());
    await fireEvent.press(screen.getByText('保存日程'));

    await waitFor(() => expect(addEvent).toHaveBeenCalledWith(expect.objectContaining({
      title: '项目评审',
      startDate: '2026-07-11',
      startTime: '15:00',
      endTime: '16:00',
      category: '工作',
      reminderMinutes: 15,
    })));
    expect(refreshEvents).toHaveBeenCalledWith(2026, 7);
    expect(onSaved).toHaveBeenCalledTimes(1);
  });

  it('preserves the original text when the user chooses to re-enter it', async () => {
    await render(<VoiceInputModal visible onClose={jest.fn()} onSaved={jest.fn()} />);
    const input = screen.getByTestId('schedule-voice-input');
    await fireEvent.changeText(input, '明天下午三点项目评审');
    await fireEvent.press(screen.getByText('解析'));
    await waitFor(() => expect(screen.getByText('重新输入')).toBeTruthy());
    await fireEvent.press(screen.getByText('重新输入'));

    expect(screen.getByTestId('schedule-voice-input').props.value).toBe('明天下午三点项目评审');
  });

  it('keeps the bottom-sheet actions above the system navigation inset', async () => {
    await render(<VoiceInputModal visible onClose={jest.fn()} onSaved={jest.fn()} />);

    expect(screen.getByTestId('schedule-voice-sheet').props.edges).toEqual(['bottom']);
    expect(screen.getByLabelText('开始语音输入')).toBeTruthy();
    expect(screen.getByLabelText('关闭语音输入')).toBeTruthy();
  });

  it('keeps the microphone fixed and starts only once while realtime audio is connecting', async () => {
    let resolvePermission: ((value: { granted: boolean }) => void) | undefined;
    const pendingPermission = new Promise<{ granted: boolean }>(resolve => {
      resolvePermission = resolve;
    });
    (Audio.requestPermissionsAsync as jest.Mock).mockReturnValue(pendingPermission);
    (startRealtimeAsr as jest.Mock).mockResolvedValue({
      stop: jest.fn(),
      meetingId: 'voice-1',
      url: 'ws://example.test',
      completion: new Promise(() => {}),
    });

    await render(<VoiceInputModal visible onClose={jest.fn()} onSaved={jest.fn()} />);
    await act(() => {
      void screen.getByTestId('schedule-voice-start').props.onPress();
    });
    await waitFor(() => expect(screen.getByTestId('schedule-voice-connecting')).toBeTruthy());
    await act(() => {
      void screen.getByTestId('schedule-voice-connecting').props.onPress();
    });

    expect(Audio.requestPermissionsAsync).toHaveBeenCalledTimes(1);
    expect(startRealtimeAsr).not.toHaveBeenCalled();
    expect(screen.getByText('正在连接语音服务')).toBeTruthy();

    await act(async () => {
      resolvePermission?.({ granted: true });
      await pendingPermission;
    });
    await waitFor(() => expect(screen.getByTestId('schedule-voice-stop')).toBeTruthy());
    expect(createGuestRealtimeSession).toHaveBeenCalledWith('日程语音输入');
    expect(startRealtimeAsr).toHaveBeenCalledTimes(1);
    expect(startRealtimeAsr).toHaveBeenCalledWith(expect.objectContaining({
      meetingId: 'guest-session-schedule-1',
      guestToken: 'schedule-token-1',
      purpose: 'schedule',
    }));
    expect(screen.getByLabelText('停止语音输入')).toBeTruthy();
  });

  it('revokes the transient realtime authorization after recording stops', async () => {
    const stop = jest.fn(async () => 'file:///data/schedule.wav');
    (startRealtimeAsr as jest.Mock).mockImplementationOnce(async options => {
      options.onTranscript?.({ text: '明天下午三点开会', raw: {} });
      return {
        stop,
        completion: new Promise(() => {}),
        meetingId: 'guest-session-schedule-1',
        url: 'ws://example.test',
      };
    });

    await render(<VoiceInputModal visible onClose={jest.fn()} onSaved={jest.fn()} />);
    await fireEvent.press(screen.getByTestId('schedule-voice-start'));
    await waitFor(() => expect(screen.getByTestId('schedule-voice-stop')).toBeTruthy());
    await fireEvent.press(screen.getByTestId('schedule-voice-stop'));

    await waitFor(() => expect(screen.getByText('项目评审')).toBeTruthy());
    expect(stop).toHaveBeenCalledTimes(1);
    expect(FileSystem.deleteAsync).toHaveBeenCalledWith(
      'file:///data/schedule.wav',
      { idempotent: true },
    );
    expect(deleteGuestRealtimeSession).toHaveBeenCalledWith(
      'guest-session-schedule-1',
      'schedule-token-1',
    );
  });

  it('keeps completed realtime segments visible while parsing a cleaned transcript', async () => {
    let emitTranscript: ((item: { text: string; startTime?: number; endTime?: number; raw: object }) => void) | undefined;
    const stop = jest.fn(async () => 'file:///data/schedule.wav');
    (startRealtimeAsr as jest.Mock).mockImplementationOnce(async options => {
      emitTranscript = options.onTranscript;
      return {
        stop,
        completion: new Promise(() => {}),
        meetingId: 'guest-session-schedule-1',
        url: 'ws://example.test',
      };
    });

    await render(<VoiceInputModal visible onClose={jest.fn()} onSaved={jest.fn()} />);
    await fireEvent.press(screen.getByTestId('schedule-voice-start'));
    await waitFor(() => expect(screen.getByTestId('schedule-voice-stop')).toBeTruthy());

    await act(() => {
      emitTranscript?.({ text: '下午三点开会', startTime: 1, endTime: 2, raw: {} });
      emitTranscript?.({ text: '你的你你的你的', startTime: 2.2, endTime: 2.8, raw: {} });
      emitTranscript?.({ text: '明天下午三点开会', startTime: 3, endTime: 4, raw: {} });
      emitTranscript?.({ text: '地点在东门', startTime: 5, endTime: 6, raw: {} });
    });

    expect(screen.getByTestId('schedule-voice-input').props.value).toBe(
      '下午三点开会\n你的你你的你的\n明天下午三点开会\n地点在东门',
    );
    await fireEvent.press(screen.getByTestId('schedule-voice-stop'));
    await waitFor(() => expect(parseText).toHaveBeenCalledWith(
      '下午三点开会\n明天下午三点开会\n地点在东门',
    ));
  });

  it('returns to input and preserves partial text after an established realtime connection drops', async () => {
    let resolveCompletion: ((value: { reason: 'connection-closed' }) => void) | undefined;
    const completion = new Promise<{ reason: 'connection-closed' }>(resolve => {
      resolveCompletion = resolve;
    });
    const stop = jest.fn(async () => 'file:///data/disconnected.wav');
    (startRealtimeAsr as jest.Mock).mockImplementationOnce(async options => {
      options.onTranscript?.({ text: '明天下午三点开会', raw: {} });
      return {
        stop,
        completion,
        meetingId: 'voice-disconnected',
        url: 'ws://example.test',
      };
    });

    await render(<VoiceInputModal visible onClose={jest.fn()} onSaved={jest.fn()} />);
    await fireEvent.press(screen.getByTestId('schedule-voice-start'));
    await waitFor(() => expect(screen.getByTestId('schedule-voice-stop')).toBeTruthy());

    await act(async () => {
      resolveCompletion?.({ reason: 'connection-closed' });
      await completion;
      await Promise.resolve();
    });

    await waitFor(() => expect(screen.getByTestId('schedule-voice-start')).toBeTruthy());
    expect(stop).toHaveBeenCalledTimes(1);
    expect(FileSystem.deleteAsync).toHaveBeenCalledWith(
      'file:///data/disconnected.wav',
      { idempotent: true },
    );
    expect(screen.getByTestId('schedule-voice-input').props.value).toBe('明天下午三点开会');
    expect(screen.getByText('实时连接已断开，已保留识别内容，可直接解析或重新录音')).toBeTruthy();
  });

  it('scrolls long confirmation content while keeping the error slot and actions fixed', async () => {
    (parseText as jest.Mock).mockResolvedValue({
      ...parsed,
      title: '跨部门季度项目评审与后续行动安排'.repeat(4),
      description: '需要核对全部项目风险、责任人和交付时间。'.repeat(8),
      detail: '补充材料与会议背景。'.repeat(10),
      location: '一个需要在窄屏中自动换行且不能挤出卡片边界的超长会议地点',
      status: '等待多个协作方共同确认',
    });
    addEvent.mockRejectedValueOnce(new Error('save failed'));

    await render(<VoiceInputModal visible onClose={jest.fn()} onSaved={jest.fn()} />);
    const inputErrorHeight = StyleSheet.flatten(
      screen.getByTestId('schedule-voice-error-slot').props.style,
    ).height;

    await fireEvent.changeText(screen.getByTestId('schedule-voice-input'), '长内容日程');
    await fireEvent.press(screen.getByText('解析'));
    await waitFor(() => expect(screen.getByTestId('schedule-voice-confirm-scroll')).toBeTruthy());

    const confirmScroll = screen.getByTestId('schedule-voice-confirm-scroll');
    const confirmActions = screen.getByTestId('schedule-voice-confirm-actions');
    expect(confirmActions.parent).toBe(confirmScroll.parent);
    expect(confirmActions.parent).not.toBe(confirmScroll);
    expect(StyleSheet.flatten(screen.getByTestId('schedule-voice-sheet').props.style).maxHeight).toBe('92%');
    expect(StyleSheet.flatten(screen.getByTestId('schedule-voice-error-slot').props.style).height)
      .toBe(inputErrorHeight);
    expect(StyleSheet.flatten(screen.getByTestId('schedule-voice-draft-title').props.style))
      .toEqual(expect.objectContaining({ flexShrink: 1, minWidth: 0 }));

    await fireEvent.press(screen.getByText('保存日程'));
    await waitFor(() => expect(screen.getByText('保存失败，请重试')).toBeTruthy());
    expect(screen.getByText('保存失败，请重试').props.numberOfLines).toBe(2);
    const firstRequestId = addEvent.mock.calls[0][0].clientRequestId;
    await fireEvent.press(screen.getByText('保存日程'));
    await waitFor(() => expect(addEvent).toHaveBeenCalledTimes(2));
    expect(addEvent.mock.calls[1][0].clientRequestId).toBe(firstRequestId);
  });
});
