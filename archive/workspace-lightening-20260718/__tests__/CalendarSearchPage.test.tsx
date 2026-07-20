import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react-native';
import { Animated, Keyboard, StyleSheet } from 'react-native';
import {
  buildCalendarSearchGroups,
  CalendarSearchPage,
} from '../src/components/CalendarSearchPage';
import type { CalEvent } from '../src/types';

jest.mock('@expo/vector-icons', () => ({ Ionicons: 'Ionicons' }));
jest.mock('../assets/calendar-search-empty.png', () => 'calendar-search-empty.png');

const events: CalEvent[] = [
  {
    id: 'past',
    title: '过去会议',
    startDate: '2026-07-12',
    startTime: '18:00',
    color: '#1456F0',
  },
  {
    id: 'future',
    title: '未来会议',
    startDate: '2026-07-15',
    startTime: '09:00',
    location: '三号会议室',
    color: '#1456F0',
  },
  {
    id: 'today-late',
    title: '今日晚会',
    startDate: '2026-07-14',
    startTime: '16:00',
    description: '同步项目结论',
    color: '#1456F0',
  },
  {
    id: 'today-early',
    title: '今日晨会',
    startDate: '2026-07-14',
    startTime: '08:30',
    color: '#1456F0',
  },
];

describe('Feishu-style calendar search page', () => {
  beforeAll(() => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date(2026, 6, 14, 10, 0));
  });

  afterAll(() => {
    jest.useRealTimers();
  });

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('groups one date once while preserving today, future, and past ordering', () => {
    const groups = buildCalendarSearchGroups(events, '会', new Date(2026, 6, 14, 10));

    expect(groups.map(group => group.key)).toEqual([
      '2026-07-14',
      '2026-07-15',
      '2026-07-12',
    ]);
    expect(groups[0].events.map(event => event.id)).toEqual(['today-early', 'today-late']);
    expect(buildCalendarSearchGroups(events, '7月15日', new Date(2026, 6, 14)))
      .toEqual([expect.objectContaining({ key: '2026-07-15' })]);
  });

  it('materializes a far recurring occurrence before matching its actual date', () => {
    const recurring: CalEvent = {
      id: 'monthly-series',
      sourceEventId: 'monthly-series',
      occurrenceDate: '2026-07-09',
      title: '每月复盘',
      startDate: '2026-07-09',
      startTime: '10:00',
      endTime: '11:00',
      repeat: 'monthly',
      color: '#1456F0',
    };

    const groups = buildCalendarSearchGroups(
      [recurring],
      '2027年8月9日',
      new Date(2026, 6, 14),
    );

    expect(groups).toHaveLength(1);
    expect(groups[0].events[0]).toMatchObject({
      sourceEventId: 'monthly-series',
      occurrenceDate: '2027-08-09',
      startDate: '2027-08-09',
      isExpandedOccurrence: true,
    });
  });

  it('uses date occupancy instead of the stored midnight end date for date search', () => {
    const overnight: CalEvent = {
      id: 'overnight',
      title: '夜间发布',
      startDate: '2026-07-14',
      endDate: '2026-07-15',
      startTime: '23:00',
      endTime: '00:00',
      spanning: true,
      color: '#1456F0',
    };
    const throughMorning: CalEvent = {
      ...overnight,
      id: 'through-morning',
      title: '凌晨值守',
      endTime: '00:30',
    };

    const groups = buildCalendarSearchGroups(
      [overnight, throughMorning],
      '7月15日',
      new Date(2026, 6, 14),
    );

    expect(groups).toHaveLength(1);
    expect(groups[0].key).toBe('2026-07-15');
    expect(groups[0].events.map(event => event.id)).toEqual(['through-morning']);
  });

  it('finds a spanning recurring occurrence on a date after its recurrence start', () => {
    const recurring: CalEvent = {
      id: 'weekly-night',
      sourceEventId: 'weekly-night',
      occurrenceDate: '2026-07-12',
      title: '周末值守',
      startDate: '2026-07-12',
      endDate: '2026-07-13',
      startTime: '23:00',
      endTime: '01:00',
      repeat: 'weekly',
      spanning: true,
      color: '#1456F0',
    };

    const groups = buildCalendarSearchGroups(
      [recurring],
      '2026年7月20日 值守',
      new Date(2026, 6, 14),
    );

    expect(groups[0]).toEqual(expect.objectContaining({ key: '2026-07-20' }));
    expect(groups[0].events[0]).toMatchObject({
      sourceEventId: 'weekly-night',
      occurrenceDate: '2026-07-19',
      startDate: '2026-07-19',
      endDate: '2026-07-20',
    });
  });

  it('uses the source search geometry and a full-page 180ms transition', async () => {
    await render(
      <CalendarSearchPage
        visible
        events={events}
        onOpenEvent={jest.fn()}
        onClose={jest.fn()}
      />,
    );

    expect(StyleSheet.flatten(screen.getByTestId('calendar-search-header').props.style))
      .toEqual(expect.objectContaining({ height: 56 }));
    expect(StyleSheet.flatten(screen.getByTestId('calendar-search-bar').props.style).backgroundColor)
      .toBeUndefined();
    expect(StyleSheet.flatten(screen.getByTestId('calendar-search-input').props.style))
      .toEqual(expect.objectContaining({ fontSize: 22, height: 56 }));
    expect((Animated.timing as jest.Mock).mock.calls.some(([, config]) => (
      config.duration === 180 && config.toValue === 1
    ))).toBe(true);
  });

  it('renders source-sized date lanes and event chips grouped by day', async () => {
    const onOpenEvent = jest.fn();
    await render(
      <CalendarSearchPage
        visible
        events={events}
        onOpenEvent={onOpenEvent}
        onClose={jest.fn()}
      />,
    );

    await fireEvent.changeText(screen.getByTestId('calendar-search-input'), '会');

    expect(screen.getAllByTestId(/calendar-search-group-/)).toHaveLength(3);
    expect(screen.getAllByTestId(/calendar-search-month-/)).toHaveLength(1);
    expect(screen.getAllByText('周二')).toHaveLength(1);
    expect(screen.getAllByText('14')).toHaveLength(1);
    expect(screen.getAllByTestId(/calendar-search-event-/).map(node => node.props.testID)).toEqual([
      'calendar-search-event-today-early',
      'calendar-search-event-today-late',
      'calendar-search-event-future',
      'calendar-search-event-past',
    ]);
    expect(StyleSheet.flatten(screen.getByTestId('calendar-search-chip-today-early').props.style))
      .toEqual(expect.objectContaining({ height: 50, borderRadius: 2 }));
    expect(StyleSheet.flatten(screen.getByTestId('calendar-search-chip-today-late').props.style))
      .toEqual(expect.objectContaining({ height: 68 }));
    expect(StyleSheet.flatten(screen.getByTestId('calendar-search-event-today-late').props.style))
      .toEqual(expect.objectContaining({ minHeight: 78 }));
    expect(screen.getByText('描述: 同步项目结论')).toBeTruthy();
    expect(screen.getByText('09:00 三号会议室')).toBeTruthy();
    expect(StyleSheet.flatten(screen.getByTestId('calendar-search-strip-today-early').props.style))
      .toEqual(expect.objectContaining({ position: 'absolute', width: 2 }));
    expect(StyleSheet.flatten(screen.getByTestId('calendar-search-copy-today-early').props.style))
      .toEqual(expect.objectContaining({ paddingLeft: 8, paddingRight: 6, paddingTop: 4 }));
    expect(StyleSheet.flatten(screen.getByTestId('calendar-search-day-gap-2026-07-14').props.style))
      .toEqual(expect.objectContaining({ height: 12 }));
    expect(StyleSheet.flatten(screen.getByTestId('calendar-search-month-2026-07').props.style))
      .toEqual(expect.objectContaining({ marginTop: 5, marginBottom: 17 }));

    await fireEvent.press(screen.getByTestId('calendar-search-chip-future'));
    expect(onOpenEvent).toHaveBeenCalledWith(expect.objectContaining({ id: 'future' }));
  });

  it('highlights every Chinese keyword match without changing title or description text', async () => {
    const keywordEvent: CalEvent = {
      id: 'keyword',
      title: '项目复盘项目',
      startDate: '2026-07-14',
      startTime: '14:00',
      description: '同步项目结论',
      color: '#1456F0',
    };
    await render(
      <CalendarSearchPage
        visible
        events={[keywordEvent]}
        onOpenEvent={jest.fn()}
        onClose={jest.fn()}
      />,
    );

    await fireEvent.changeText(screen.getByTestId('calendar-search-input'), '项目');

    expect(screen.getByTestId('calendar-search-title-keyword').props.accessibilityLabel)
      .toBe('项目复盘项目');
    expect(screen.getByTestId('calendar-search-description-keyword').props.accessibilityLabel)
      .toBe('描述: 同步项目结论');
    expect(screen.getAllByTestId(/calendar-search-title-keyword-highlight-/)
      .map(node => node.props.children)).toEqual(['项目', '项目']);
    expect(screen.getAllByTestId(/calendar-search-description-keyword-highlight-/)
      .map(node => node.props.children)).toEqual(['项目']);
    expect(StyleSheet.flatten(
      screen.getByTestId('calendar-search-description-keyword-highlight-0').props.style,
    )).toEqual(expect.objectContaining({
      color: '#1456F0',
      backgroundColor: '#DDE8FF',
    }));
  });

  it('uses a fixed neutral overlay for result press feedback', async () => {
    await render(
      <CalendarSearchPage
        visible
        events={events}
        onOpenEvent={jest.fn()}
        onClose={jest.fn()}
      />,
    );
    await fireEvent.changeText(screen.getByTestId('calendar-search-input'), '会议');

    const chip = screen.getByTestId('calendar-search-chip-future');
    const restingStyle = StyleSheet.flatten(chip.props.style);
    expect(screen.queryByTestId('calendar-search-pressed-future')).toBeNull();

    await fireEvent(chip, 'pressIn');

    expect(StyleSheet.flatten(
      screen.getByTestId('calendar-search-chip-future').props.style,
    )).toEqual(restingStyle);
    expect(StyleSheet.flatten(
      screen.getByTestId('calendar-search-pressed-future').props.style,
    )).toEqual(expect.objectContaining({
      position: 'absolute',
      top: 0,
      right: 0,
      bottom: 0,
      left: 0,
      backgroundColor: 'rgba(31,35,41,0.12)',
    }));

    await fireEvent(screen.getByTestId('calendar-search-chip-future'), 'pressOut');
    expect(screen.queryByTestId('calendar-search-pressed-future')).toBeNull();
  });

  it('shows the source no-result copy and supports clear, scroll dismiss, and close', async () => {
    const onClose = jest.fn();
    await render(
      <CalendarSearchPage
        visible
        events={events}
        onOpenEvent={jest.fn()}
        onClose={onClose}
      />,
    );

    const input = screen.getByTestId('calendar-search-input');
    await fireEvent.changeText(input, '不存在的日程');
    expect(screen.getByText('无相关结果')).toBeTruthy();
    expect(screen.getByTestId('calendar-search-empty-asset')).toEqual(expect.objectContaining({
      type: 'Image',
      props: expect.objectContaining({
        source: 'calendar-search-empty.png',
        accessible: false,
        resizeMode: 'contain',
      }),
    }));
    expect(StyleSheet.flatten(screen.getByTestId('calendar-search-empty-asset').props.style))
      .toEqual(expect.objectContaining({ width: 160, height: 120 }));

    await fireEvent.press(screen.getByLabelText('清空搜索内容'));
    expect(screen.getByTestId('calendar-search-input').props.value).toBe('');

    await fireEvent.changeText(screen.getByTestId('calendar-search-input'), '会议');
    await fireEvent(screen.getByTestId('calendar-search-results'), 'scrollBeginDrag');
    expect(Keyboard.dismiss).toHaveBeenCalled();

    await fireEvent.press(screen.getByLabelText('退出搜索'));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId('calendar-search-input').props.value).toBe('');
  });
});
