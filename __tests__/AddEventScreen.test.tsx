import React from 'react';
import { act, fireEvent, render, waitFor, within } from '@testing-library/react-native';
import { Animated, StyleSheet, useWindowDimensions } from 'react-native';
import { AddEventScreen } from '../src/screens/AddEventScreen';
import { useAuth } from '../src/store/AuthStore';
import { useEvents } from '../src/store/EventsStore';
import { Colors as C } from '../src/theme/colors';

const mockShowDialog = jest.fn();

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function expectBottomUpPage(page: { props: Record<string, unknown> }) {
  const style = page.props.style as Array<{ transform?: Array<Record<string, unknown>> }>;
  const transform = style[1].transform ?? [];
  expect(transform[0]).toHaveProperty('translateY');
  expect(transform[0]).not.toHaveProperty('translateX');
}

jest.mock('expo-linear-gradient', () => ({ LinearGradient: 'LinearGradient' }));
jest.mock('@expo/vector-icons', () => ({ Ionicons: 'Ionicons' }));
jest.mock('@react-native-community/datetimepicker', () => 'DateTimePicker');
jest.mock('../src/components/ScreenContainer', () => ({ ScreenContainer: 'ScreenContainer' }));
jest.mock('../src/components/Common', () => ({ BackHeader: 'BackHeader' }));
jest.mock('../src/components/AppDialog', () => ({
  useAppDialog: () => ({ showDialog: mockShowDialog }),
}));
jest.mock('../src/store/AuthStore', () => ({ useAuth: jest.fn() }));
jest.mock('../src/store/EventsStore', () => ({
  useEvents: jest.fn(),
}));
jest.mock('../src/services/notifications', () => ({
  DEFAULT_REMINDER_MINUTES: 15,
  REMINDER_OPTIONS: [
    { value: null, label: '不提醒' },
    { value: 15, label: '提前15分钟' },
  ],
  defaultReminderForEvent: jest.fn(() => 15),
  loadNotificationPrefs: jest.fn(async () => ({ defaultReminderMinutes: 15 })),
  reminderUnavailableMessage: jest.fn(async () => '系统通知已开启，但本机提醒创建失败。请重新打开日程并保存提醒。'),
}));

describe('AddEventScreen save reliability', () => {
  const addEvent = jest.fn();
  const updateEvent = jest.fn();
  const deleteEvent = jest.fn();
  const refreshEvents = jest.fn();
  const findConflicts = jest.fn();
  let beforeRemoveListener: ((event: {
    preventDefault: () => void;
    data: { action: { type: string } };
  }) => void) | undefined;
  const navigation = {
    goBack: jest.fn(),
    navigate: jest.fn(),
    dispatch: jest.fn(),
    addListener: jest.fn((eventName: string, listener: typeof beforeRemoveListener) => {
      if (eventName === 'beforeRemove') beforeRemoveListener = listener;
      return jest.fn();
    }),
  } as unknown as React.ComponentProps<typeof AddEventScreen>['navigation'];
  const route = {
    key: 'edit-event',
    name: 'AddEvent' as const,
    params: { eventRef: { sourceEventId: 'event-1', occurrenceDate: '2026-07-20' } },
  } as React.ComponentProps<typeof AddEventScreen>['route'];

  beforeEach(() => {
    jest.clearAllMocks();
    (useWindowDimensions as jest.Mock).mockReturnValue({ width: 390, height: 844 });
    beforeRemoveListener = undefined;
    addEvent.mockResolvedValue({ reminderDelivery: 'not-required' });
    updateEvent.mockResolvedValue({ reminderDelivery: 'unconfirmed' });
    deleteEvent.mockResolvedValue(undefined);
    refreshEvents.mockResolvedValue({ dataLoaded: true, reminderSyncConfirmed: true });
    findConflicts.mockResolvedValue({ hasConflict: false, conflicts: [], complete: true });
    (useAuth as jest.Mock).mockReturnValue({
      mode: 'authenticated',
      session: { user: { id: 7 } },
    });
    (useEvents as jest.Mock).mockReturnValue({
      events: [{
        id: 'event-1',
        title: '项目评审',
        startDate: '2026-07-20',
        startTime: '10:00',
        endTime: '11:00',
        category: '工作',
        reminderMinutes: 15,
        color: '#5B8CFF',
      }],
      addEvent,
      updateEvent,
      deleteEvent,
      refreshEvents,
      findConflicts,
    });
  });

  it('leaves immediately when the editor has no unsaved changes', async () => {
    const view = await render(<AddEventScreen navigation={navigation} route={route} />);

    await fireEvent.press(view.getByLabelText('取消编辑'));

    expect(navigation.goBack).toHaveBeenCalledTimes(1);
    expect(mockShowDialog).not.toHaveBeenCalled();
  });

  it('uses the source quit confirmation before discarding edited content', async () => {
    const view = await render(<AddEventScreen navigation={navigation} route={route} />);
    await fireEvent.changeText(view.getByPlaceholderText('添加主题'), '调整后的项目评审');

    await fireEvent.press(view.getByLabelText('取消编辑'));

    expect(navigation.goBack).not.toHaveBeenCalled();
    expect(mockShowDialog).toHaveBeenCalledWith(expect.objectContaining({
      title: '确定退出当前日程编辑吗？',
      message: '退出后，将无法保存当前日程的更改',
      tone: 'warning',
      actions: [
        expect.objectContaining({ text: '退出', role: 'primary' }),
        expect.objectContaining({ text: '继续编辑', role: 'cancel' }),
      ],
    }));

    const dialog = mockShowDialog.mock.calls.at(-1)?.[0];
    await dialog.actions[0].onPress();
    expect(navigation.goBack).toHaveBeenCalledTimes(1);
  });

  it('intercepts the native back action and resumes that exact action after confirmation', async () => {
    const view = await render(<AddEventScreen navigation={navigation} route={route} />);
    await fireEvent.changeText(view.getByPlaceholderText('添加主题'), '调整后的项目评审');
    const preventDefault = jest.fn();
    const action = { type: 'GO_BACK' };

    beforeRemoveListener?.({ preventDefault, data: { action } });

    expect(preventDefault).toHaveBeenCalledTimes(1);
    expect(navigation.dispatch).not.toHaveBeenCalled();
    const dialog = mockShowDialog.mock.calls.at(-1)?.[0];
    await dialog.actions[0].onPress();
    expect(navigation.dispatch).toHaveBeenCalledWith(action);
  });

  it('uses the compact source delete label while retaining a descriptive control name', async () => {
    const view = await render(<AddEventScreen navigation={navigation} route={route} />);

    expect(view.getByText('删除')).toBeTruthy();
    expect(view.getByLabelText('删除日程')).toBeTruthy();
    expect(view.getByTestId('event-delete-icon').props).toEqual(expect.objectContaining({
      size: 18,
      color: C.red,
    }));
  });

  it.each([
    { viewport: { width: 320, height: 568 }, expectedWidth: '100%', expectedMaxWidth: undefined },
    { viewport: { width: 640, height: 360 }, expectedWidth: 608, expectedMaxWidth: 720 },
  ])('keeps editor actions fixed and body controls scroll-reachable at $viewport.width x $viewport.height', async ({
    viewport,
    expectedWidth,
    expectedMaxWidth,
  }) => {
    (useWindowDimensions as jest.Mock).mockReturnValue(viewport);
    const view = await render(<AddEventScreen navigation={navigation} route={route} />);
    const frame = view.getByTestId('event-editor-content-frame');
    const frameStyle = StyleSheet.flatten(frame.props.style);
    const framedContent = within(frame);
    const scroll = framedContent.getByTestId('event-editor-scroll');
    const scrollContent = within(scroll);

    expect(frameStyle).toEqual(expect.objectContaining({
      flex: 1,
      width: expectedWidth,
      alignSelf: 'center',
    }));
    expect(frameStyle.maxWidth).toBe(expectedMaxWidth);
    expect(framedContent.getByLabelText('取消编辑')).toBeTruthy();
    expect(framedContent.getByLabelText('保存日程修改')).toBeTruthy();
    expect(StyleSheet.flatten(scroll.props.style)).toEqual(expect.objectContaining({ flex: 1 }));
    expect(scrollContent.getByPlaceholderText('添加主题')).toBeTruthy();
    expect(scrollContent.getByLabelText('开始日期 2026-07-20')).toBeTruthy();
    expect(scrollContent.getByLabelText('结束日期 2026-07-20')).toBeTruthy();
    expect(scrollContent.getByLabelText('重复 不重复')).toBeTruthy();
    expect(scrollContent.getByLabelText('添加地点')).toBeTruthy();
    expect(scrollContent.getByLabelText('添加描述')).toBeTruthy();
    expect(scrollContent.getByLabelText('选择提醒时间')).toBeTruthy();
    expect(scrollContent.getByLabelText('删除日程')).toBeTruthy();
  });

  it('keeps the source-style save action clickable so an empty title explains the block', async () => {
    (useEvents as jest.Mock).mockReturnValue({
      events: [],
      addEvent,
      updateEvent,
      deleteEvent,
      refreshEvents,
      findConflicts,
    });
    const createRoute = {
      key: 'create-empty-title-event',
      name: 'AddEvent' as const,
      params: { date: '2026-07-20' },
    } as React.ComponentProps<typeof AddEventScreen>['route'];
    const view = await render(<AddEventScreen navigation={navigation} route={createRoute} />);

    expect(view.getByTestId('event-save').props.accessibilityState.disabled).toBe(false);
    await fireEvent.press(view.getByTestId('event-save'));

    expect(addEvent).not.toHaveBeenCalled();
    expect(mockShowDialog).toHaveBeenCalledWith({ title: '请输入事项标题', tone: 'info' });
  });

  it('uses the source 12dp trailing controls in the main form', async () => {
    const view = await render(<AddEventScreen navigation={navigation} route={route} />);

    expect(view.getByTestId('event-repeat-chevron').props.size).toBe(12);
    expect(view.getByTestId('event-reminder-chevron').props.size).toBe(12);
  });

  it('uses the source 8 by 32 range divider instead of a horizontal arrow', async () => {
    const view = await render(<AddEventScreen navigation={navigation} route={route} />);

    expect(StyleSheet.flatten(view.getByTestId('event-main-time-range-arrow').props.style)).toEqual(
      expect.objectContaining({ width: 8, height: 32, overflow: 'hidden' }),
    );
  });

  it('uses the store edit result without issuing a duplicate screen refresh', async () => {
    const view = await render(<AddEventScreen navigation={navigation} route={route} />);

    expect(view.getByTestId('event-save').props.accessibilityLabel).toBe('保存日程修改');
    await fireEvent.press(view.getByTestId('event-save'));

    await waitFor(() => expect(updateEvent).toHaveBeenCalledWith(
      { sourceEventId: 'event-1', occurrenceDate: '2026-07-20' },
      expect.objectContaining({ title: '项目评审', startDate: '2026-07-20' }),
      'series',
    ));
    expect(refreshEvents).not.toHaveBeenCalled();
    expect(navigation.goBack).toHaveBeenCalledTimes(1);
    expect(mockShowDialog).toHaveBeenCalledWith({
      title: '日程已保存',
      message: '本机提醒状态未能确认，可重新打开日程并保存提醒。',
      tone: 'warning',
    });
  });

  it('edits the selected recurrence date and chooses scope before conflict checking', async () => {
    (useEvents as jest.Mock).mockReturnValue({
      events: [{
        id: 'series-1@2026-07-20',
        sourceEventId: 'series-1',
        occurrenceDate: '2026-07-20',
        isExpandedOccurrence: true,
        title: '每周复盘',
        startDate: '2026-07-20',
        seriesStartDate: '2026-07-06',
        startTime: '10:00',
        endTime: '11:00',
        repeat: 'weekly',
        color: '#5B8CFF',
      }],
      searchableEvents: [],
      addEvent,
      updateEvent,
      deleteEvent,
      refreshEvents,
      findConflicts,
    });
    const recurringRoute = {
      ...route,
      params: { eventRef: { sourceEventId: 'series-1', occurrenceDate: '2026-07-20' } },
    } as React.ComponentProps<typeof AddEventScreen>['route'];
    const view = await render(<AddEventScreen navigation={navigation} route={recurringRoute} />);

    expect(view.getByLabelText('开始日期 2026-07-20')).toBeTruthy();
    expect(view.getByText('这是重复日程，保存时可选择修改范围')).toBeTruthy();
    await fireEvent.press(view.getByTestId('event-save'));

    expect(findConflicts).not.toHaveBeenCalled();
    const scopeDialog = mockShowDialog.mock.calls.at(-1)?.[0];
    expect(scopeDialog).toEqual(expect.objectContaining({ title: '修改重复日程' }));
    await act(async () => { await scopeDialog.actions[0].onPress(); });

    await waitFor(() => expect(findConflicts).toHaveBeenCalledWith(
      expect.objectContaining({ startDate: '2026-07-20' }),
      { sourceEventId: 'series-1', occurrenceDate: '2026-07-20' },
      'occurrence',
    ));
    await waitFor(() => expect(updateEvent).toHaveBeenCalledWith(
      { sourceEventId: 'series-1', occurrenceDate: '2026-07-20' },
      expect.objectContaining({ startDate: '2026-07-20' }),
      'occurrence',
    ));
  });

  it('reports a durable pending edit without telling the user to submit it again', async () => {
    updateEvent.mockResolvedValueOnce({ reminderDelivery: 'unconfirmed', syncStatus: 'pending' });
    const view = await render(<AddEventScreen navigation={navigation} route={route} />);

    await fireEvent.press(view.getByTestId('event-save'));

    await waitFor(() => expect(navigation.goBack).toHaveBeenCalledTimes(1));
    expect(mockShowDialog).toHaveBeenCalledWith({
      title: '日程等待同步',
      message: '保存请求已记录，将在网络恢复后自动确认。',
      tone: 'warning',
    });
  });

  it('locks repeated saves, close, and native back through conflict check and write', async () => {
    const conflictRequest = deferred<{ hasConflict: false; conflicts: []; complete: true }>();
    const writeRequest = deferred<{ reminderDelivery: 'not-required' }>();
    findConflicts.mockReturnValueOnce(conflictRequest.promise);
    updateEvent.mockReturnValueOnce(writeRequest.promise);
    const view = await render(<AddEventScreen navigation={navigation} route={route} />);
    const initialSaveAction = view.getByTestId('event-save').props.onPress;

    await act(() => {
      initialSaveAction();
      initialSaveAction();
    });
    expect(findConflicts).toHaveBeenCalledTimes(1);
    expect(view.getByTestId('event-save', { includeHiddenElements: true }).props.accessibilityState.disabled).toBe(true);
    expect(view.getByTestId('event-editor-main-content', { includeHiddenElements: true }).props.pointerEvents).toBe('none');
    expect(view.getByTestId('event-editor-main-content', { includeHiddenElements: true }).props.accessibilityElementsHidden).toBe(true);
    expect(view.getByTestId('event-saving-overlay').props.accessibilityViewIsModal).toBe(true);
    expect(view.getByPlaceholderText('添加主题', { includeHiddenElements: true }).props.editable).toBe(false);

    await fireEvent.press(view.getByLabelText('取消编辑', { includeHiddenElements: true }));
    expect(navigation.goBack).not.toHaveBeenCalled();
    expect(mockShowDialog).not.toHaveBeenCalled();

    const preventDefault = jest.fn();
    await act(() => {
      beforeRemoveListener?.({
        preventDefault,
        data: { action: { type: 'GO_BACK' } },
      });
    });
    expect(preventDefault).toHaveBeenCalledTimes(1);
    expect(navigation.dispatch).not.toHaveBeenCalled();

    await act(async () => {
      conflictRequest.resolve({ hasConflict: false, conflicts: [], complete: true });
      await conflictRequest.promise;
    });
    await waitFor(() => expect(updateEvent).toHaveBeenCalledTimes(1));

    await fireEvent.press(view.getByLabelText('取消编辑', { includeHiddenElements: true }));
    const writePreventDefault = jest.fn();
    await act(() => {
      beforeRemoveListener?.({
        preventDefault: writePreventDefault,
        data: { action: { type: 'GO_BACK' } },
      });
    });
    expect(writePreventDefault).toHaveBeenCalledTimes(1);
    expect(navigation.goBack).not.toHaveBeenCalled();

    await act(() => initialSaveAction());
    expect(findConflicts).toHaveBeenCalledTimes(1);
    expect(updateEvent).toHaveBeenCalledTimes(1);

    await act(async () => {
      writeRequest.resolve({ reminderDelivery: 'not-required' });
      await writeRequest.promise;
    });
    await waitFor(() => expect(navigation.goBack).toHaveBeenCalledTimes(1));
  });

  it('ignores a conflict result that resolves after the editor unmounts', async () => {
    const conflictRequest = deferred<{ hasConflict: false; conflicts: []; complete: true }>();
    findConflicts.mockReturnValueOnce(conflictRequest.promise);
    const view = await render(<AddEventScreen navigation={navigation} route={route} />);

    await fireEvent.press(view.getByTestId('event-save'));
    expect(findConflicts).toHaveBeenCalledTimes(1);
    await view.unmount();
    await act(async () => {
      conflictRequest.resolve({ hasConflict: false, conflicts: [], complete: true });
      await conflictRequest.promise;
    });

    expect(updateEvent).not.toHaveBeenCalled();
    expect(navigation.goBack).not.toHaveBeenCalled();
    expect(mockShowDialog).not.toHaveBeenCalled();
  });

  it('ignores a completed write result after the editor has been forcibly removed', async () => {
    const writeRequest = deferred<{ reminderDelivery: 'not-required' }>();
    updateEvent.mockReturnValueOnce(writeRequest.promise);
    const view = await render(<AddEventScreen navigation={navigation} route={route} />);

    await fireEvent.press(view.getByTestId('event-save'));
    await waitFor(() => expect(updateEvent).toHaveBeenCalledTimes(1));
    await view.unmount();
    await act(async () => {
      writeRequest.resolve({ reminderDelivery: 'not-required' });
      await writeRequest.promise;
    });

    expect(navigation.goBack).not.toHaveBeenCalled();
    expect(mockShowDialog).not.toHaveBeenCalled();
  });

  it('invalidates a conflict confirmation after cancellation before allowing a fresh save', async () => {
    findConflicts.mockResolvedValueOnce({
      hasConflict: true,
      complete: true,
      conflicts: [{
        severity: 'overlap',
        event: {
          id: 'event-2',
          title: '已有安排',
          startDate: '2026-07-20',
          startTime: '10:30',
          endTime: '11:30',
          color: '#1456F0',
        },
      }],
    });
    const view = await render(<AddEventScreen navigation={navigation} route={route} />);

    await fireEvent.press(view.getByTestId('event-save'));
    await waitFor(() => expect(mockShowDialog).toHaveBeenCalledWith(
      expect.objectContaining({ title: '时间冲突' }),
    ));
    const conflictDialog = mockShowDialog.mock.calls.at(-1)?.[0];
    await act(() => conflictDialog.actions[1].onPress());
    await act(() => conflictDialog.actions[0].onPress());
    expect(updateEvent).not.toHaveBeenCalled();

    await fireEvent.press(view.getByTestId('event-save'));
    await waitFor(() => expect(updateEvent).toHaveBeenCalledTimes(1));
  });

  it('uses the store create result without issuing a duplicate screen refresh', async () => {
    (useEvents as jest.Mock).mockReturnValue({
      events: [],
      addEvent,
      updateEvent,
      refreshEvents,
      findConflicts,
    });
    const createRoute = {
      key: 'create-event',
      name: 'AddEvent' as const,
      params: { date: '2026-07-20' },
    } as React.ComponentProps<typeof AddEventScreen>['route'];
    const view = await render(<AddEventScreen navigation={navigation} route={createRoute} />);

    await fireEvent.changeText(view.getByPlaceholderText('添加主题'), '新的日程');
    await fireEvent.press(view.getByTestId('event-save'));

    await waitFor(() => expect(addEvent).toHaveBeenCalledWith(expect.objectContaining({
      title: '新的日程',
      startDate: '2026-07-20',
      clientRequestId: expect.any(String),
    })));
    expect(refreshEvents).not.toHaveBeenCalled();
    expect(navigation.goBack).toHaveBeenCalledTimes(1);
  });

  it('saves a manually created all-day event without requiring clock times', async () => {
    (useEvents as jest.Mock).mockReturnValue({
      events: [],
      addEvent,
      updateEvent,
      refreshEvents,
      findConflicts,
    });
    const createRoute = {
      key: 'create-all-day-event',
      name: 'AddEvent' as const,
      params: { date: '2026-07-20' },
    } as React.ComponentProps<typeof AddEventScreen>['route'];
    const view = await render(<AddEventScreen navigation={navigation} route={createRoute} />);

    await fireEvent.changeText(view.getByPlaceholderText('添加主题'), '提交材料');
    await fireEvent.press(view.getByLabelText('开始日期 2026-07-20'));
    const allDayToggle = await view.findByTestId('event-all-day-toggle');
    expect(allDayToggle.props.accessibilityState.checked).toBe(false);
    await fireEvent.press(allDayToggle);
    expect(view.getByTestId('event-all-day-toggle').props.accessibilityState.checked).toBe(true);
    await fireEvent.press(view.getByTestId('event-time-done'));
    await fireEvent.press(view.getByTestId('event-save'));

    await waitFor(() => expect(addEvent).toHaveBeenCalledWith(expect.objectContaining({
      title: '提交材料',
      startDate: '2026-07-20',
      startTime: undefined,
      endTime: undefined,
      isAllDay: true,
    })));
  });

  it('prefills a half-hour slot selected from the day view', async () => {
    (useEvents as jest.Mock).mockReturnValue({
      events: [],
      addEvent,
      updateEvent,
      deleteEvent,
      refreshEvents,
      findConflicts,
    });
    const createRoute = {
      key: 'create-from-day-slot',
      name: 'AddEvent' as const,
      params: {
        date: '2026-07-20',
        endDate: '2026-07-20',
        startTime: '09:30',
        endTime: '10:00',
      },
    } as React.ComponentProps<typeof AddEventScreen>['route'];

    const view = await render(<AddEventScreen navigation={navigation} route={createRoute} />);
    expect(view.getByText('09:30')).toBeTruthy();
    expect(view.getByText('10:00')).toBeTruthy();
  });

  it('edits a global search result that is outside the loaded month window', async () => {
    (useEvents as jest.Mock).mockReturnValue({
      events: [],
      searchableEvents: [{
        id: 'event-1',
        title: '历史复盘',
        startDate: '2025-03-08',
        startTime: '14:00',
        endTime: '15:00',
        color: '#1456F0',
      }],
      addEvent,
      updateEvent,
      deleteEvent,
      refreshEvents,
      findConflicts,
    });

    const searchRoute = {
      ...route,
      params: { eventRef: { sourceEventId: 'event-1', occurrenceDate: '2025-03-08' } },
    } as React.ComponentProps<typeof AddEventScreen>['route'];
    const view = await render(<AddEventScreen navigation={navigation} route={searchRoute} />);
    expect(view.getByPlaceholderText('添加主题').props.value).toBe('历史复盘');
    expect(view.queryByText('日程不存在')).toBeNull();
  });

  it('prefills the full form from a parsed voice draft and preserves parser metadata', async () => {
    (useEvents as jest.Mock).mockReturnValue({
      events: [],
      addEvent,
      updateEvent,
      refreshEvents,
      findConflicts,
    });
    const draftRoute = {
      key: 'create-from-voice-draft',
      name: 'AddEvent' as const,
      params: {
        draft: {
          title: '跨部门评审',
          startDate: '2026-07-20',
          endDate: '2026-07-21',
          startTime: '15:00',
          endTime: '16:30',
          isAllDay: false,
          repeat: 'weekly' as const,
          description: '核对风险',
          rawText: '下周一到周二下午开跨部门评审',
          location: '三楼会议室',
          category: '工作' as const,
          detail: '携带材料',
          status: '待确认',
          reminderMinutes: 15,
        },
      },
    } as React.ComponentProps<typeof AddEventScreen>['route'];
    const view = await render(<AddEventScreen navigation={navigation} route={draftRoute} />);

    expect(view.getByPlaceholderText('添加主题').props.value).toBe('跨部门评审');
    expect(view.getByLabelText('地点 三楼会议室')).toBeTruthy();
    expect(view.getByLabelText('编辑描述')).toBeTruthy();
    expect(view.getByText('核对风险')).toBeTruthy();
    expect(view.getByLabelText('开始日期 2026-07-20')).toBeTruthy();
    expect(view.getByLabelText('结束日期 2026-07-21')).toBeTruthy();
    await fireEvent.press(view.getByTestId('event-save'));

    await waitFor(() => expect(addEvent).toHaveBeenCalledWith(expect.objectContaining({
      title: '跨部门评审',
      startDate: '2026-07-20',
      endDate: '2026-07-21',
      startTime: '15:00',
      endTime: '16:30',
      repeat: 'weekly',
      description: '核对风险',
      rawText: '下周一到周二下午开跨部门评审',
      location: '三楼会议室',
      category: '工作',
      detail: '携带材料',
      status: '待确认',
      reminderMinutes: 15,
    })));
  });

  it('opens repeat choices as a source-style subpage instead of inline chips', async () => {
    (useEvents as jest.Mock).mockReturnValue({
      events: [],
      addEvent,
      updateEvent,
      refreshEvents,
      findConflicts,
    });
    const createRoute = {
      key: 'create-repeat-event',
      name: 'AddEvent' as const,
      params: { date: '2026-07-20' },
    } as React.ComponentProps<typeof AddEventScreen>['route'];
    const view = await render(<AddEventScreen navigation={navigation} route={createRoute} />);

    await fireEvent.changeText(view.getByPlaceholderText('添加主题'), '月度复盘');
    await fireEvent.press(view.getByLabelText('重复 不重复'));
    const mainContent = view.getByTestId('event-editor-main-content', { includeHiddenElements: true });
    expect(mainContent.props.pointerEvents).toBe('none');
    expect(mainContent.props.accessibilityElementsHidden).toBe(true);
    expect((Animated.timing as jest.Mock).mock.calls.some(([, config]) => (
      config.duration === 800 && config.toValue < 0 && config.useNativeDriver === true
    ))).toBe(true);
    expectBottomUpPage(await view.findByTestId('event-repeat-page'));
    expect(StyleSheet.flatten(view.getByTestId('event-repeat-option-不重复-label').props.style)).toEqual(
      expect.objectContaining({ color: C.primary }),
    );
    const monthly = await view.findByText('每月');
    await fireEvent.press(monthly);
    expect(view.getByLabelText('重复 每月')).toBeTruthy();
    expect(view.getByTestId('event-editor-main-content').props.pointerEvents).toBe('auto');
    expect((Animated.timing as jest.Mock).mock.calls.some(([, config]) => (
      config.duration === 800 && config.toValue === 0 && config.useNativeDriver === true
    ))).toBe(true);

    await fireEvent.press(view.getByTestId('event-save'));
    await waitFor(() => expect(addEvent).toHaveBeenCalledWith(expect.objectContaining({ repeat: 'monthly' })));
  });

  it('commits reminder changes only from the source Done action', async () => {
    (useEvents as jest.Mock).mockReturnValue({
      events: [],
      addEvent,
      updateEvent,
      refreshEvents,
      findConflicts,
    });
    const createRoute = {
      key: 'create-reminder-event',
      name: 'AddEvent' as const,
      params: { date: '2026-07-20' },
    } as React.ComponentProps<typeof AddEventScreen>['route'];
    const view = await render(<AddEventScreen navigation={navigation} route={createRoute} />);
    await fireEvent.changeText(view.getByPlaceholderText('添加主题'), '提醒测试');

    await fireEvent.press(view.getByLabelText('选择提醒时间'));
    expectBottomUpPage(await view.findByTestId('event-reminder-page'));
    expect(view.getByTestId('event-reminder-options')).toBeTruthy();
    expect(StyleSheet.flatten(view.getByTestId('event-reminder-option-15-label').props.style)).toEqual(
      expect.objectContaining({ color: C.primary }),
    );
    await fireEvent.press(await view.findByTestId('event-reminder-switch'));
    expect(view.queryByTestId('event-reminder-options')).toBeNull();
    await fireEvent.press(view.getByLabelText('取消'));
    expect(view.getByText('提前15分钟')).toBeTruthy();

    await fireEvent.press(view.getByLabelText('选择提醒时间'));
    await fireEvent.press(await view.findByTestId('event-reminder-switch'));
    await fireEvent.press(view.getByTestId('event-reminder-done'));
    expect(view.getByText('不提醒')).toBeTruthy();

    await fireEvent.press(view.getByTestId('event-save'));
    await waitFor(() => expect(addEvent).toHaveBeenCalledWith(expect.objectContaining({ reminderMinutes: null })));
  });

  it('protects a modified description with the source unsaved-content dialog', async () => {
    (useEvents as jest.Mock).mockReturnValue({
      events: [],
      addEvent,
      updateEvent,
      refreshEvents,
      findConflicts,
    });
    const createRoute = {
      key: 'create-description-event',
      name: 'AddEvent' as const,
      params: { date: '2026-07-20' },
    } as React.ComponentProps<typeof AddEventScreen>['route'];
    const view = await render(<AddEventScreen navigation={navigation} route={createRoute} />);

    await fireEvent.press(view.getByLabelText('添加描述'));
    await fireEvent.changeText(await view.findByTestId('event-description-input'), '尚未保存的描述');
    await fireEvent.press(view.getByLabelText('取消'));

    expect(view.getByTestId('event-description-page')).toBeTruthy();
    expect(mockShowDialog).toHaveBeenCalledWith(expect.objectContaining({
      title: '提示',
      message: '还有未保存的描述，确认退出吗？',
      tone: 'warning',
      actions: [
        expect.objectContaining({ text: '确定', role: 'primary', onPress: expect.any(Function) }),
        expect.objectContaining({ text: '取消', role: 'cancel' }),
      ],
    }));

    const dialog = mockShowDialog.mock.calls[mockShowDialog.mock.calls.length - 1][0];
    await act(async () => {
      dialog.actions[0].onPress();
    });
    await waitFor(() => expect(view.queryByTestId('event-description-page')).toBeNull());
  });

  it('edits location and description on source-style subpages and commits only from Done', async () => {
    (useEvents as jest.Mock).mockReturnValue({
      events: [],
      addEvent,
      updateEvent,
      refreshEvents,
      findConflicts,
    });
    const createRoute = {
      key: 'create-event-details',
      name: 'AddEvent' as const,
      params: { date: '2026-07-20' },
    } as React.ComponentProps<typeof AddEventScreen>['route'];
    const view = await render(<AddEventScreen navigation={navigation} route={createRoute} />);

    await fireEvent.press(view.getByLabelText('添加地点'));
    expectBottomUpPage(await view.findByTestId('event-location-page'));
    expect(view.getByTestId('event-location-input').props.value).toBe('');
    await fireEvent.changeText(view.getByTestId('event-location-input'), '三楼咖啡厅');
    await fireEvent.press(view.getByLabelText('取消'));
    await waitFor(() => expect(view.queryByTestId('event-location-page')).toBeNull());
    expect(view.getByLabelText('添加地点')).toBeTruthy();

    await fireEvent.press(view.getByLabelText('添加地点'));
    expect((await view.findByTestId('event-location-input')).props.value).toBe('');
    await fireEvent.changeText(view.getByTestId('event-location-input'), '三楼咖啡厅');
    await fireEvent.press(view.getByTestId('event-location-done'));
    await waitFor(() => expect(view.getByLabelText('地点 三楼咖啡厅')).toBeTruthy());

    await fireEvent.press(view.getByLabelText('添加描述'));
    expectBottomUpPage(await view.findByTestId('event-description-page'));
    await fireEvent.changeText(view.getByTestId('event-description-input'), '核对风险和排期');
    await fireEvent.press(view.getByTestId('event-description-done'));
    await waitFor(() => expect(view.getByText('核对风险和排期')).toBeTruthy());

    await fireEvent.changeText(view.getByPlaceholderText('添加主题'), '跨部门评审');
    await fireEvent.press(view.getByTestId('event-save'));
    await waitFor(() => expect(addEvent).toHaveBeenCalledWith(expect.objectContaining({
      title: '跨部门评审',
      location: '三楼咖啡厅',
      description: '核对风险和排期',
    })));
  });
});
