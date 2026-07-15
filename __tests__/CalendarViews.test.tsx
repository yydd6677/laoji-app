import React from 'react';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react-native';
import { Animated, StyleSheet } from 'react-native';
import { DayTimelineView, layoutTimelineEvents } from '../src/components/DayTimelineView';
import { MonthCalendarView } from '../src/components/MonthCalendarView';
import type { CalEvent } from '../src/types';

jest.mock('@expo/vector-icons', () => ({ Ionicons: 'Ionicons' }));

const events: CalEvent[] = [
  {
    id: 'morning-meeting',
    title: '上午会议',
    startDate: '2026-07-13',
    startTime: '09:00',
    endTime: '10:00',
    color: '#1456F0',
  },
  {
    id: 'overlap-review',
    title: '并行评审',
    startDate: '2026-07-13',
    startTime: '09:30',
    endTime: '11:00',
    color: '#1456F0',
  },
  {
    id: 'all-day-meeting',
    title: '全天会议',
    startDate: '2026-07-13',
    isAllDay: true,
    color: '#1456F0',
  },
  {
    id: 'span-course',
    title: '连续课程',
    startDate: '2026-07-13',
    endDate: '2026-07-15',
    spanning: true,
    startTime: '10:00',
    endTime: '12:00',
    color: '#1456F0',
  },
];

describe('Feishu-style calendar views', () => {
  beforeAll(() => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date(2026, 6, 14, 10, 30));
    global.requestAnimationFrame = callback => {
      callback(0);
      return 1;
    };
    global.cancelAnimationFrame = jest.fn();
  });

  afterAll(() => {
    jest.useRealTimers();
  });

  it('uses Sunday first and pages months without arrow buttons', async () => {
    const onMonthChange = jest.fn();
    await render(
      <MonthCalendarView
        month={new Date(2026, 6, 1)}
        selectedDate={new Date(2026, 6, 13)}
        events={events}
        onSelectDate={jest.fn()}
        onMonthChange={onMonthChange}
        onOpenEvent={jest.fn()}
        onCreate={jest.fn()}
      />,
    );

    expect(Array.from({ length: 7 }, (_, index) => screen.getByTestId(`calendar-weekday-${index}`).props.children))
      .toEqual(['日', '一', '二', '三', '四', '五', '六']);
    const pager = screen.getByTestId('calendar-month-pager');
    expect(pager.props.horizontal).toBe(true);
    expect(pager.props.pagingEnabled).toBe(true);
    expect(pager.props.accessibilityActions).toEqual([
      { name: 'decrement', label: '上一个月' },
      { name: 'increment', label: '下一个月' },
    ]);
    expect(screen.queryByLabelText('上一个月')).toBeNull();
    expect(screen.queryByLabelText('下一个月')).toBeNull();

    await fireEvent(pager, 'scrollBeginDrag');
    await fireEvent(pager, 'momentumScrollEnd', {
      nativeEvent: { contentOffset: { x: 780, y: 0 } },
    });
    await fireEvent(pager, 'momentumScrollEnd', {
      nativeEvent: { contentOffset: { x: 780, y: 0 } },
    });
    expect(onMonthChange).toHaveBeenCalledTimes(1);
    expect(onMonthChange).toHaveBeenLastCalledWith(new Date(2026, 7, 1));

    await fireEvent(pager, 'accessibilityAction', { nativeEvent: { actionName: 'increment' } });
    expect(onMonthChange).toHaveBeenCalledTimes(2);
    expect(onMonthChange).toHaveBeenLastCalledWith(new Date(2026, 7, 1));
  });

  it('fills a dynamic month grid with in-cell events and expands a selected day', async () => {
    const onSelectDate = jest.fn();
    await render(
      <MonthCalendarView
        month={new Date(2026, 6, 1)}
        selectedDate={new Date(2026, 6, 13)}
        events={events}
        onSelectDate={onSelectDate}
        onMonthChange={jest.fn()}
        onOpenEvent={jest.fn()}
        onCreate={jest.fn()}
      />,
    );

    expect(screen.getByTestId('calendar-event-chip-morning-meeting-2026-07-13')).toBeTruthy();
    const spanningChip = screen.getByTestId('calendar-event-chip-span-course-2026-07-13');
    const spanningGeometry = spanningChip.props.style[1];
    expect(spanningGeometry.width).toBeGreaterThan(spanningGeometry.left * 2);
    expect(screen.getAllByText('连续课程')).toHaveLength(1);
    expect(screen.getAllByTestId(/calendar-week-row-/)).toHaveLength(5);

    const target = screen.getByLabelText(/2026年7月13日.*4条日程/);
    await fireEvent.press(target);
    expect(onSelectDate).toHaveBeenCalledWith(new Date(2026, 6, 13));
    expect(await screen.findByTestId('calendar-expanded-day-panel')).toBeTruthy();
    expect((Animated.timing as jest.Mock).mock.calls.some(([, config]) => config.duration === 350)).toBe(true);

    const panel = screen.getByTestId('calendar-expanded-day-panel');
    expect(StyleSheet.flatten(panel.props.style).opacity).toBeUndefined();

    await fireEvent.press(screen.getByLabelText(/2026年7月14日.*今天/));
    expect(screen.getByLabelText(/2026年7月14日.*今天.*已展开/)).toBeTruthy();
    expect(screen.getByTestId('calendar-expanded-day-panel')).toBeTruthy();

    await fireEvent.press(screen.getByLabelText(/2026年7月14日.*今天.*已展开/));
    await waitFor(() => expect(screen.queryByTestId('calendar-expanded-day-panel')).toBeNull());
    expect(onSelectDate).toHaveBeenLastCalledWith(new Date(2026, 6, 14));
  });

  it('lists the expanded day in time order and opens the chosen event', async () => {
    const onOpenEvent = jest.fn();
    await render(
      <MonthCalendarView
        month={new Date(2026, 6, 1)}
        selectedDate={new Date(2026, 6, 13)}
        events={events}
        onSelectDate={jest.fn()}
        onMonthChange={jest.fn()}
        onOpenEvent={onOpenEvent}
        onCreate={jest.fn()}
      />,
    );

    await fireEvent.press(screen.getByLabelText(/2026年7月13日.*4条日程/));

    await screen.findByTestId('calendar-expanded-day-panel');
    const selectedPage = screen.getByTestId('calendar-expanded-day-2026-07-13');
    const labels = within(selectedPage).getAllByLabelText(/^(上午会议|并行评审|连续课程|全天会议)，/)
      .map(item => item.props.accessibilityLabel);
    expect(labels).toEqual([
      '上午会议，09:00 - 10:00',
      '并行评审，09:30 - 11:00',
      '连续课程，10:00 - 12:00',
      '全天会议，全天',
    ]);

    await fireEvent.press(within(selectedPage).getByLabelText('连续课程，10:00 - 12:00'));
    expect(onOpenEvent).toHaveBeenCalledWith(expect.objectContaining({ id: 'span-course' }));
  });

  it('lays out overlapping and cross-day events without collisions', () => {
    const firstDay = layoutTimelineEvents(events, '2026-07-13');
    expect(firstDay.find(item => item.event.id === 'morning-meeting'))
      .toEqual(expect.objectContaining({ start: 540, end: 600, column: 0, columns: 2 }));
    expect(firstDay.find(item => item.event.id === 'overlap-review'))
      .toEqual(expect.objectContaining({ start: 570, end: 660, column: 1, columns: 2 }));

    expect(layoutTimelineEvents(events, '2026-07-14')).toEqual([]);
    expect(layoutTimelineEvents(events, '2026-07-15')).toEqual([]);

    const overnight: CalEvent = {
      id: 'overnight',
      title: '夜间交接',
      startDate: '2026-07-13',
      endDate: '2026-07-14',
      startTime: '23:00',
      endTime: '01:00',
      spanning: true,
      color: '#1456F0',
    };
    expect(layoutTimelineEvents([overnight], '2026-07-13')[0])
      .toEqual(expect.objectContaining({ start: 1380, end: 1440 }));
    expect(layoutTimelineEvents([overnight], '2026-07-14')[0])
      .toEqual(expect.objectContaining({ start: 0, end: 60 }));

    const endingAtMidnight = { ...overnight, id: 'midnight-end', endTime: '00:00' };
    expect(layoutTimelineEvents([endingAtMidnight], '2026-07-14')).toEqual([]);
  });

  it('collapses and expands the source-style all-day area', async () => {
    const allDayEvents = Array.from({ length: 5 }, (_, index): CalEvent => ({
      id: `all-day-${index}`,
      title: `全天事项${index + 1}`,
      startDate: '2026-07-13',
      isAllDay: true,
      color: '#1456F0',
    }));
    await render(
      <DayTimelineView
        date={new Date(2026, 6, 13)}
        events={allDayEvents}
        onDateChange={jest.fn()}
        onOpenEvent={jest.fn()}
        onCreate={jest.fn()}
      />,
    );

    expect(screen.getByText('还有 3 项')).toBeTruthy();
    expect(screen.queryByText('全天事项5')).toBeNull();
    await fireEvent.press(screen.getByTestId('all-day-expand-toggle'));
    expect(screen.getByText('全天事项5')).toBeTruthy();
    expect((Animated.timing as jest.Mock).mock.calls.some(([, config]) => (
      config.duration === 100 && config.toValue === 125
    ))).toBe(true);
  });

  it('renders a Sunday-first day strip and exposes day navigation actions', async () => {
    const onDateChange = jest.fn();
    const onCreate = jest.fn();
    await render(
      <DayTimelineView
        date={new Date(2026, 6, 13)}
        events={events}
        onDateChange={onDateChange}
        onOpenEvent={jest.fn()}
        onCreate={onCreate}
      />,
    );

    expect(screen.getByTestId('day-header-2026-07-12')).toBeTruthy();
    const activeDay = screen.getByTestId('day-header-2026-07-13');
    expect(activeDay?.props.accessibilityState).toEqual({ selected: true, disabled: false });
    expect(screen.getByTestId('timeline-event-morning-meeting')).toBeTruthy();
    expect(screen.getByText('全天会议')).toBeTruthy();
    expect(screen.getByTestId('day-hour-00').props.children).toBe('00:00');
    expect(screen.getByTestId('day-hour-24').props.children).toBe('24:00');
    expect(screen.getByTestId('day-hour-12').props.style[1].top
      - screen.getByTestId('day-hour-00').props.style[1].top).toBe(600);
    expect(screen.getByTestId('day-hour-24').props.style[1].top
      - screen.getByTestId('day-hour-00').props.style[1].top).toBe(1200);

    await fireEvent.press(screen.getByTestId('day-slot-09:30'));
    const quickCreate = screen.getByTestId('day-quick-create');
    expect(quickCreate.props.accessibilityLabel).toBe('09:30至10:00，新建日程');
    await fireEvent.press(quickCreate);
    expect(onCreate).toHaveBeenCalledWith(
      new Date(2026, 6, 13),
      '09:30',
      new Date(2026, 6, 13),
      '10:00',
    );

    await fireEvent.press(screen.getByTestId('day-slot-23:30'));
    await fireEvent.press(screen.getByTestId('day-quick-create'));
    expect(onCreate).toHaveBeenLastCalledWith(
      new Date(2026, 6, 13),
      '23:30',
      new Date(2026, 6, 14),
      '00:00',
    );

    await fireEvent(screen.getByLabelText(/单日视图，2026年7月13日/), 'accessibilityAction', {
      nativeEvent: { actionName: 'increment' },
    });
    expect(onDateChange).toHaveBeenCalledWith(new Date(2026, 6, 14));
  });
});
