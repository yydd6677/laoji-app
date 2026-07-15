import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { VoiceInputModal, VOICE_INPUT_GEOMETRY } from '../src/components/VoiceInputModal';
import {
  createGuestRealtimeSession,
  deleteGuestRealtimeSession,
  parseText,
} from '../src/services/api';
import { startRealtimeAsr } from '../src/services/realtimeAsr';
import { useEvents } from '../src/store/EventsStore';
import { checkConflict } from '../src/utils/eventUtils';
import { Audio } from 'expo-av';
import * as FileSystem from 'expo-file-system/legacy';
import { StyleSheet } from 'react-native';

const mockShowDialog = jest.fn();
const mockNavigate = jest.fn();

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
jest.mock('../src/utils/eventUtils', () => ({ checkConflict: jest.fn() }));
jest.mock('@react-navigation/native', () => ({
  useNavigation: () => ({ navigate: mockNavigate }),
}));
jest.mock('../src/components/AppDialog', () => ({
  useAppDialog: () => ({ showDialog: mockShowDialog }),
}));
jest.mock('../src/services/notifications', () => ({
  reminderUnavailableMessage: jest.fn(async () => '系统通知已开启，但本机提醒创建失败。请重新打开日程并保存提醒。'),
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
    addEvent.mockResolvedValue({ reminderDelivery: 'not-required' });
    refreshEvents.mockResolvedValue(undefined);
    (useEvents as jest.Mock).mockReturnValue({ events: [], addEvent, refreshEvents });
    (checkConflict as jest.Mock).mockReturnValue({ hasConflict: false, conflicts: [] });
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
    await fireEvent.press(screen.getByLabelText('保存'));

    await waitFor(() => expect(addEvent).toHaveBeenCalledWith(expect.objectContaining({
      title: '项目评审',
      startDate: '2026-07-11',
      startTime: '15:00',
      endTime: '16:00',
      category: '工作',
      reminderMinutes: 15,
    })));
    expect(refreshEvents).not.toHaveBeenCalled();
    expect(onSaved).toHaveBeenCalledTimes(1);
  });

  it('reports a saved event honestly when the local reminder is unavailable', async () => {
    addEvent.mockResolvedValueOnce({ reminderDelivery: 'unavailable' });
    await render(<VoiceInputModal visible onClose={jest.fn()} onSaved={jest.fn()} />);

    await fireEvent.changeText(screen.getByTestId('schedule-voice-input'), '明天下午三点项目评审');
    await fireEvent.press(screen.getByText('解析'));
    await waitFor(() => expect(screen.getByText('项目评审')).toBeTruthy());
    await fireEvent.press(screen.getByLabelText('保存'));

    await waitFor(() => expect(mockShowDialog).toHaveBeenCalledWith({
      title: '日程已保存',
      message: '系统通知已开启，但本机提醒创建失败。请重新打开日程并保存提醒。',
      tone: 'warning',
    }));
    expect(addEvent).toHaveBeenCalledTimes(1);
  });

  it('saves a dated result without a specific time as an all-day event', async () => {
    (parseText as jest.Mock).mockResolvedValueOnce({
      ...parsed,
      title: '提交材料',
      start_time: null,
      end_time: null,
      is_all_day: true,
      reminder_minutes: null,
      raw_text: '明天提交材料',
    });
    await render(<VoiceInputModal visible onClose={jest.fn()} onSaved={jest.fn()} />);

    await fireEvent.changeText(screen.getByTestId('schedule-voice-input'), '明天提交材料');
    await fireEvent.press(screen.getByText('解析'));
    await waitFor(() => expect(screen.getByText('提交材料')).toBeTruthy());
    expect(screen.getByText('全天')).toBeTruthy();
    await fireEvent.press(screen.getByLabelText('保存'));

    await waitFor(() => expect(addEvent).toHaveBeenCalledWith(expect.objectContaining({
      startTime: undefined,
      endTime: undefined,
      isAllDay: true,
      reminderMinutes: null,
    })));
  });

  it('does not save a malformed parsed date', async () => {
    (parseText as jest.Mock).mockResolvedValueOnce({
      ...parsed,
      start_date: '2026-02-30',
      needs_clarification: false,
      clarification_question: null,
    });
    await render(<VoiceInputModal visible onClose={jest.fn()} onSaved={jest.fn()} />);

    await fireEvent.changeText(screen.getByTestId('schedule-voice-input'), '明天项目评审');
    await fireEvent.press(screen.getByText('解析'));
    await waitFor(() => expect(screen.getByText('项目评审')).toBeTruthy());
    await fireEvent.press(screen.getByLabelText('保存'));

    expect(addEvent).not.toHaveBeenCalled();
    expect(screen.getByText('请先补充有效日期，再保存日程')).toBeTruthy();
  });

  it('allows a valid draft to be saved without answering an optional clarification', async () => {
    (parseText as jest.Mock).mockResolvedValueOnce({
      ...parsed,
      title: '上班',
      start_date: '2026-07-14',
      end_date: '2026-07-15',
      spanning: true,
      start_time: null,
      end_time: null,
      is_all_day: true,
      category: '工作',
      needs_clarification: true,
      clarification_question: '没有听到具体日期，需要补充日期。',
    });
    await render(<VoiceInputModal visible onClose={jest.fn()} onSaved={jest.fn()} />);

    await fireEvent.changeText(screen.getByTestId('schedule-voice-input'), '今明两天上班');
    await fireEvent.press(screen.getByText('解析'));
    await waitFor(() => expect(screen.getByPlaceholderText('补充答案（选填）')).toBeTruthy());
    await fireEvent.press(screen.getByLabelText('保存'));

    await waitFor(() => expect(addEvent).toHaveBeenCalledWith(expect.objectContaining({
      title: '上班',
      startDate: '2026-07-14',
      endDate: '2026-07-15',
      spanning: true,
    })));
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

  it('opens the full event form with every parsed field preserved for editing', async () => {
    const onClose = jest.fn();
    (parseText as jest.Mock).mockResolvedValueOnce({
      ...parsed,
      end_date: '2026-07-12',
      spanning: true,
      description: '核对项目风险',
      raw_text: '明天下午三点到后天四点项目评审',
      location: '三楼会议室',
      detail: '携带评审材料',
      status: '待确认',
    });
    await render(<VoiceInputModal visible onClose={onClose} onSaved={jest.fn()} />);

    await fireEvent.changeText(screen.getByTestId('schedule-voice-input'), '明天下午三点到后天四点项目评审');
    await fireEvent.press(screen.getByText('解析'));
    await waitFor(() => expect(screen.getByLabelText('编辑日程详情')).toBeTruthy());
    await fireEvent.press(screen.getByLabelText('编辑日程详情'));

    expect(onClose).toHaveBeenCalledTimes(1);
    expect(mockNavigate).toHaveBeenCalledWith('AddEvent', {
      date: '2026-07-11',
      draft: expect.objectContaining({
        title: '项目评审',
        startDate: '2026-07-11',
        endDate: '2026-07-12',
        startTime: '15:00',
        endTime: '16:00',
        isAllDay: false,
        description: '核对项目风险',
        rawText: '明天下午三点到后天四点项目评审',
        location: '三楼会议室',
        category: '工作',
        detail: '携带评审材料',
        status: '待确认',
        reminderMinutes: 15,
      }),
    });
    expect(addEvent).not.toHaveBeenCalled();
  });

  it('uses the same conflict confirmation as the manual event form', async () => {
    const conflict = {
      id: 'existing-1',
      title: '已有会议',
      startDate: '2026-07-11',
      startTime: '15:30',
      endTime: '16:30',
      isAllDay: false,
      color: '#5B8CFF',
    };
    (useEvents as jest.Mock).mockReturnValue({ events: [conflict], addEvent, refreshEvents });
    (checkConflict as jest.Mock).mockReturnValue({ hasConflict: true, conflicts: [conflict] });
    await render(<VoiceInputModal visible onClose={jest.fn()} onSaved={jest.fn()} />);

    await fireEvent.changeText(screen.getByTestId('schedule-voice-input'), '明天下午三点项目评审');
    await fireEvent.press(screen.getByText('解析'));
    await waitFor(() => expect(screen.getByText('项目评审')).toBeTruthy());
    await fireEvent.press(screen.getByLabelText('保存'));

    expect(addEvent).not.toHaveBeenCalled();
    expect(mockShowDialog).toHaveBeenCalledWith(expect.objectContaining({
      title: '时间冲突',
      message: expect.stringContaining('已有会议'),
      tone: 'warning',
    }));
    const actions = mockShowDialog.mock.calls.at(-1)?.[0]?.actions;
    await act(async () => { await actions[0].onPress(); });
    await waitFor(() => expect(addEvent).toHaveBeenCalledTimes(1));
  });

  it('keeps the bottom-sheet actions above the system navigation inset', async () => {
    await render(<VoiceInputModal visible onClose={jest.fn()} onSaved={jest.fn()} />);

    expect(screen.getByTestId('schedule-voice-sheet').props.edges).toEqual(['bottom']);
    expect(screen.getByLabelText('开始语音输入')).toBeTruthy();
    expect(screen.getByLabelText('关闭语音输入')).toBeTruthy();
  });

  it('uses fixed, non-overlapping geometry for voice controls and parsed fields', async () => {
    await render(<VoiceInputModal visible onClose={jest.fn()} onSaved={jest.fn()} />);

    const sheetStyle = StyleSheet.flatten(screen.getByTestId('schedule-voice-sheet').props.style);
    const dockStyle = StyleSheet.flatten(screen.getByTestId('schedule-voice-control-dock').props.style);
    const micTouchStyle = StyleSheet.flatten(screen.getByTestId('schedule-voice-start').props.style);
    const micStyle = StyleSheet.flatten(screen.getByTestId('schedule-voice-mic-visual').props.style);
    expect(sheetStyle).toEqual(expect.objectContaining({
      borderTopLeftRadius: VOICE_INPUT_GEOMETRY.sheetRadius,
      borderTopRightRadius: VOICE_INPUT_GEOMETRY.sheetRadius,
    }));
    expect(dockStyle.height).toBe(VOICE_INPUT_GEOMETRY.controlDockHeight);
    expect(micTouchStyle).toEqual(expect.objectContaining({
      width: VOICE_INPUT_GEOMETRY.microphoneTouchSize,
      height: VOICE_INPUT_GEOMETRY.microphoneTouchSize,
    }));
    expect(micStyle).toEqual(expect.objectContaining({
      width: VOICE_INPUT_GEOMETRY.microphoneSize,
      height: VOICE_INPUT_GEOMETRY.microphoneSize,
    }));
    expect(screen.getByText('语音新建日程')).toBeTruthy();
    expect(screen.queryByText('说出你的日常')).toBeNull();
    const titleStyle = StyleSheet.flatten(screen.getByTestId('schedule-voice-input-title-bar-title').props.style);
    const closeSlotStyle = StyleSheet.flatten(screen.getByTestId('schedule-voice-input-title-bar-right-slot').props.style);
    expect(titleStyle).toEqual(expect.objectContaining({ flex: 1, minWidth: 0 }));
    expect(titleStyle.position).toBeUndefined();
    expect(closeSlotStyle).toEqual(expect.objectContaining({ width: 72, flexShrink: 0 }));

    await fireEvent.changeText(screen.getByTestId('schedule-voice-input'), '明天下午三点项目评审');
    await fireEvent.press(screen.getByText('解析'));
    await waitFor(() => expect(screen.getByTestId('schedule-voice-draft-form')).toBeTruthy());

    const titleBarStyle = StyleSheet.flatten(screen.getByTestId('schedule-voice-confirm-actions').props.style);
    const dateRowStyle = StyleSheet.flatten(screen.getByTestId('schedule-voice-field-date').props.style);
    expect(titleBarStyle.height).toBe(VOICE_INPUT_GEOMETRY.titleBarHeight);
    expect(dateRowStyle.minHeight).toBe(VOICE_INPUT_GEOMETRY.fieldRowMinHeight);
    expect(screen.queryByText('规则解析')).toBeNull();
  });

  it('keeps the dimming backdrop fixed while only the sheet moves upward', async () => {
    const view = await render(<VoiceInputModal visible onClose={jest.fn()} onSaved={jest.fn()} />);

    const modal = view.container.queryAll(instance => instance.type === 'Modal', { includeSelf: true })[0];
    const backdropStyle = StyleSheet.flatten(screen.getByTestId('schedule-voice-backdrop').props.style);
    const sheetMotionStyle = StyleSheet.flatten(screen.getByTestId('schedule-voice-sheet-motion').props.style);

    expect(modal.props.animationType).toBe('none');
    expect(backdropStyle).toEqual(expect.objectContaining({
      position: 'absolute',
      top: 0,
      right: 0,
      bottom: 0,
      left: 0,
    }));
    expect(backdropStyle.transform).toBeUndefined();
    expect(sheetMotionStyle.transform).toHaveLength(1);
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

  it('keeps recording after a short tap and stops on the next tap', async () => {
    const stop = jest.fn(async () => 'file:///data/schedule.wav');
    (startRealtimeAsr as jest.Mock).mockImplementationOnce(async options => {
      options.onTranscript?.({ text: '明天下午三点开会', raw: {} });
      return { stop, completion: new Promise(() => {}) };
    });
    const now = jest.spyOn(Date, 'now');
    now.mockReturnValue(1_000);
    await render(<VoiceInputModal visible onClose={jest.fn()} onSaved={jest.fn()} />);

    await act(() => screen.getByTestId('schedule-voice-start').props.onPressIn());
    await waitFor(() => expect(screen.getByTestId('schedule-voice-stop')).toBeTruthy());
    now.mockReturnValue(1_100);
    await act(() => screen.getByTestId('schedule-voice-stop').props.onPressOut());
    await act(() => screen.getByTestId('schedule-voice-stop').props.onPress());
    expect(stop).not.toHaveBeenCalled();
    expect(screen.getByText('实时识别中，轻点结束')).toBeTruthy();

    now.mockReturnValue(1_200);
    await act(() => screen.getByTestId('schedule-voice-stop').props.onPressIn());
    now.mockReturnValue(1_250);
    await act(() => screen.getByTestId('schedule-voice-stop').props.onPressOut());
    await waitFor(() => expect(stop).toHaveBeenCalledTimes(1));
    now.mockRestore();
  });

  it('stops automatically when a hold-to-talk gesture is released', async () => {
    const stop = jest.fn(async () => 'file:///data/schedule.wav');
    (startRealtimeAsr as jest.Mock).mockImplementationOnce(async options => {
      options.onTranscript?.({ text: '明天下午三点开会', raw: {} });
      return { stop, completion: new Promise(() => {}) };
    });
    const now = jest.spyOn(Date, 'now');
    now.mockReturnValue(2_000);
    await render(<VoiceInputModal visible onClose={jest.fn()} onSaved={jest.fn()} />);

    await act(() => screen.getByTestId('schedule-voice-start').props.onPressIn());
    await waitFor(() => expect(screen.getByTestId('schedule-voice-stop')).toBeTruthy());
    now.mockReturnValue(2_000 + VOICE_INPUT_GEOMETRY.holdToTalkDelay + 1);
    await act(() => screen.getByTestId('schedule-voice-stop').props.onPressOut());

    await waitFor(() => expect(stop).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(parseText).toHaveBeenCalledWith('明天下午三点开会'));
    now.mockRestore();
  });

  it('honors a hold release that happens while the voice service is still connecting', async () => {
    let resolvePermission: ((value: { granted: boolean }) => void) | undefined;
    const pendingPermission = new Promise<{ granted: boolean }>(resolve => {
      resolvePermission = resolve;
    });
    const stop = jest.fn(async () => 'file:///data/schedule.wav');
    (Audio.requestPermissionsAsync as jest.Mock).mockReturnValue(pendingPermission);
    (startRealtimeAsr as jest.Mock).mockImplementationOnce(async options => {
      options.onTranscript?.({ text: '明天下午三点开会', raw: {} });
      return { stop, completion: new Promise(() => {}) };
    });
    const now = jest.spyOn(Date, 'now');
    now.mockReturnValue(3_000);
    await render(<VoiceInputModal visible onClose={jest.fn()} onSaved={jest.fn()} />);

    await act(() => screen.getByTestId('schedule-voice-start').props.onPressIn());
    await waitFor(() => expect(screen.getByTestId('schedule-voice-connecting')).toBeTruthy());
    expect(screen.getByTestId('schedule-voice-connecting').props.disabled).toBeUndefined();
    now.mockReturnValue(3_000 + VOICE_INPUT_GEOMETRY.holdToTalkDelay + 1);
    await act(() => screen.getByTestId('schedule-voice-connecting').props.onPressOut());
    await act(async () => {
      resolvePermission?.({ granted: true });
      await pendingPermission;
    });

    await waitFor(() => expect(stop).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(parseText).toHaveBeenCalledWith('明天下午三点开会'));
    now.mockRestore();
  });

  it('does not restore a stale parse result after the sheet has been closed', async () => {
    let resolveParse: ((value: typeof parsed) => void) | undefined;
    const pendingParse = new Promise<typeof parsed>(resolve => { resolveParse = resolve; });
    (parseText as jest.Mock).mockReturnValueOnce(pendingParse);
    const onClose = jest.fn();
    await render(<VoiceInputModal visible onClose={onClose} onSaved={jest.fn()} />);

    await fireEvent.changeText(screen.getByTestId('schedule-voice-input'), '明天下午三点项目评审');
    await act(() => { fireEvent.press(screen.getByText('解析')); });
    await waitFor(() => expect(screen.getByText('正在解析')).toBeTruthy());
    await fireEvent.press(screen.getByLabelText('关闭语音输入'));
    expect(onClose).toHaveBeenCalledTimes(1);

    await act(async () => {
      resolveParse?.(parsed);
      await pendingParse;
    });
    expect(screen.queryByTestId('schedule-voice-draft-form')).toBeNull();
  });

  it('keeps saving non-dismissible until the create request resolves', async () => {
    let resolveSave: ((value: { reminderDelivery: 'not-required' }) => void) | undefined;
    const pendingSave = new Promise<{ reminderDelivery: 'not-required' }>(resolve => {
      resolveSave = resolve;
    });
    addEvent.mockReturnValueOnce(pendingSave);
    const onClose = jest.fn();
    const onSaved = jest.fn();
    const view = await render(<VoiceInputModal visible onClose={onClose} onSaved={onSaved} />);
    await fireEvent.changeText(screen.getByTestId('schedule-voice-input'), '明天下午三点项目评审');
    await fireEvent.press(screen.getByText('解析'));
    await waitFor(() => expect(screen.getByLabelText('保存')).toBeTruthy());
    await act(() => { fireEvent.press(screen.getByLabelText('保存')); });
    await waitFor(() => expect(screen.getByText('正在保存')).toBeTruthy());

    expect(screen.queryByLabelText('关闭语音输入')).toBeNull();
    const modal = view.container.queryAll(instance => instance.type === 'Modal', { includeSelf: true })[0];
    await act(() => modal.props.onRequestClose());
    expect(onClose).not.toHaveBeenCalled();

    await act(async () => {
      resolveSave?.({ reminderDelivery: 'not-required' });
      await pendingSave;
    });
    await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1));
    expect(onClose).toHaveBeenCalledTimes(1);
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

    await fireEvent.press(screen.getByLabelText('保存'));
    await waitFor(() => expect(screen.getByText('保存失败，请重试')).toBeTruthy());
    expect(screen.getByText('保存失败，请重试').props.numberOfLines).toBe(2);
    const firstRequestId = addEvent.mock.calls[0][0].clientRequestId;
    await fireEvent.press(screen.getByLabelText('保存'));
    await waitFor(() => expect(addEvent).toHaveBeenCalledTimes(2));
    expect(addEvent.mock.calls[1][0].clientRequestId).toBe(firstRequestId);
  });
});
