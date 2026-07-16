import React from 'react';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react-native';
import { Animated, StyleSheet } from 'react-native';
import {
  DayTimelineView,
  formatTimelineHourLabel,
  formatTimelineTime,
  layoutTimelineEvents,
  sortAllDayEvents,
  systemUses24HourClock,
} from '../src/components/DayTimelineView';
import { MonthCalendarView } from '../src/components/MonthCalendarView';
import type { CalEvent } from '../src/types';

jest.mock('@expo/vector-icons', () => ({ Ionicons: 'Ionicons' }));
jest.mock('../assets/calendar-day-empty.png', () => 'calendar-day-empty.png');

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
    global.requestAnimationFrame = jest.fn(callback => {
      callback(0);
      return 1;
    });
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

  it('uses the 400ms programmatic month path after closing an expanded row', async () => {
    function StatefulMonth() {
      const [month, setMonth] = React.useState(new Date(2026, 6, 1));
      return (
        <MonthCalendarView
          month={month}
          selectedDate={new Date(2026, 6, 13)}
          events={events}
          onSelectDate={jest.fn()}
          onMonthChange={setMonth}
          onOpenEvent={jest.fn()}
          onCreate={jest.fn()}
        />
      );
    }

    await render(<StatefulMonth />);
    await fireEvent.press(screen.getByLabelText(/2026年7月13日.*4条日程/));
    await screen.findByTestId('calendar-expanded-day-panel');
    (Animated.timing as jest.Mock).mockClear();

    await fireEvent(screen.getByTestId('calendar-month-pager'), 'accessibilityAction', {
      nativeEvent: { actionName: 'increment' },
    });

    await waitFor(() => expect((Animated.timing as jest.Mock).mock.calls.some(([, config]) => (
      config.duration === 400 && config.toValue === 1
    ))).toBe(true));
    const durations = (Animated.timing as jest.Mock).mock.calls.map(([, config]) => config.duration);
    expect(durations.indexOf(400)).toBeGreaterThan(durations.lastIndexOf(350));
    expect(screen.getByTestId('calendar-month-pager').props.accessibilityLabel).toBe('2026年8月');
  });

  it('keeps native swipe paging from also running the programmatic 400ms path', async () => {
    function StatefulMonth() {
      const [month, setMonth] = React.useState(new Date(2026, 6, 1));
      return (
        <MonthCalendarView
          month={month}
          selectedDate={new Date(2026, 6, 13)}
          events={events}
          onSelectDate={jest.fn()}
          onMonthChange={setMonth}
          onOpenEvent={jest.fn()}
          onCreate={jest.fn()}
        />
      );
    }

    await render(<StatefulMonth />);
    (Animated.timing as jest.Mock).mockClear();
    const pager = screen.getByTestId('calendar-month-pager');
    await fireEvent(pager, 'scrollBeginDrag');
    await fireEvent(pager, 'momentumScrollEnd', {
      nativeEvent: { contentOffset: { x: 780, y: 0 } },
    });

    await waitFor(() => expect(screen.getByTestId('calendar-month-pager').props.accessibilityLabel)
      .toBe('2026年8月'));
    expect((Animated.timing as jest.Mock).mock.calls.some(([, config]) => config.duration === 400))
      .toBe(false);
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

  it('uses the formal calendar artwork for an expanded empty day', async () => {
    await render(
      <MonthCalendarView
        month={new Date(2026, 6, 1)}
        selectedDate={new Date(2026, 6, 13)}
        events={[]}
        onSelectDate={jest.fn()}
        onMonthChange={jest.fn()}
        onOpenEvent={jest.fn()}
        onCreate={jest.fn()}
      />,
    );

    await fireEvent.press(screen.getByLabelText(/2026年7月13日.*无日程/));
    const asset = await screen.findByTestId('calendar-expanded-empty-asset-2026-07-13');
    expect(asset.props).toEqual(expect.objectContaining({
      source: 'calendar-day-empty.png',
      resizeMode: 'contain',
      accessible: false,
    }));
    expect(StyleSheet.flatten(asset.props.style)).toEqual({ width: 125, height: 94 });
  });

  it('lays out overlapping and cross-day events without collisions', () => {
    const firstDay = layoutTimelineEvents(events, '2026-07-13');
    expect(firstDay.find(item => item.event.id === 'morning-meeting'))
      .toEqual(expect.objectContaining({ start: 540, end: 600, column: 0, columns: 2 }));
    expect(firstDay.find(item => item.event.id === 'overlap-review'))
      .toEqual(expect.objectContaining({ start: 570, end: 660, column: 1, columns: 2 }));

    expect(layoutTimelineEvents(events, '2026-07-14')).toEqual([
      expect.objectContaining({ event: expect.objectContaining({ id: 'span-course' }), start: 0, end: 1440 }),
    ]);
    expect(layoutTimelineEvents(events, '2026-07-15')).toEqual([
      expect.objectContaining({ event: expect.objectContaining({ id: 'span-course' }), start: 0, end: 720 }),
    ]);

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

  it('preserves all-day expansion across dates and clamps its inner scroll', async () => {
    const allDayEvents = Array.from({ length: 10 }, (_, index): CalEvent => ({
      id: `spanning-all-day-${index}`,
      title: `跨日全天${index + 1}`,
      startDate: '2026-07-13',
      endDate: index < 4 ? '2026-07-14' : '2026-07-13',
      isAllDay: true,
      color: '#1456F0',
    }));
    const props = {
      events: allDayEvents,
      onDateChange: jest.fn(),
      onOpenEvent: jest.fn(),
      onCreate: jest.fn(),
    };
    const view = await render(<DayTimelineView date={new Date(2026, 6, 13)} {...props} />);
    await fireEvent.press(screen.getByTestId('all-day-expand-toggle'));
    expect(screen.getByLabelText('收起全天日程')).toBeTruthy();
    await fireEvent.scroll(screen.getByTestId('all-day-scroll'), {
      nativeEvent: { contentOffset: { y: 50 } },
    });
    expect(screen.getByTestId('all-day-scroll').props.contentOffset.y).toBe(50);

    await view.rerender(<DayTimelineView date={new Date(2026, 6, 14)} {...props} />);

    expect(screen.getByLabelText('收起全天日程')).toBeTruthy();
    await waitFor(() => expect(screen.getByTestId('all-day-scroll').props.contentOffset.y).toBe(0));
  });

  it('uses strict all-day semantics and stable date-title-source ordering', async () => {
    const allDayCandidates: CalEvent[] = [
      {
        id: 'tie-first-in-source',
        title: 'A',
        startDate: '2026-07-12',
        endDate: '2026-07-14',
        color: '#1456F0',
      },
      {
        id: 'title-b',
        title: 'B',
        startDate: '2026-07-12',
        endDate: '2026-07-14',
        color: '#1456F0',
      },
      {
        id: 'earliest-start',
        title: 'Z',
        startDate: '2026-07-11',
        endDate: '2026-07-13',
        startTime: '09:00',
        endTime: '10:00',
        isAllDay: true,
        color: '#1456F0',
      },
      {
        id: 'shorter-end',
        title: 'Z',
        startDate: '2026-07-12',
        endDate: '2026-07-13',
        color: '#1456F0',
      },
      {
        id: 'tie-second-in-source',
        title: 'A',
        startDate: '2026-07-12',
        endDate: '2026-07-14',
        color: '#1456F0',
      },
    ];
    const oneSidedTimes: CalEvent[] = [
      {
        id: 'missing-start',
        title: '只有结束时间',
        startDate: '2026-07-13',
        endTime: '10:00',
        color: '#1456F0',
      },
      {
        id: 'missing-end',
        title: '只有开始时间',
        startDate: '2026-07-13',
        startTime: '09:00',
        color: '#1456F0',
      },
    ];

    expect(sortAllDayEvents([...allDayCandidates].reverse(), allDayCandidates).map(event => event.id))
      .toEqual([
        'earliest-start',
        'shorter-end',
        'tie-first-in-source',
        'tie-second-in-source',
        'title-b',
      ]);
    expect(layoutTimelineEvents(oneSidedTimes, '2026-07-13')).toEqual([]);

    await render(
      <DayTimelineView
        date={new Date(2026, 6, 13)}
        events={[...allDayCandidates, ...oneSidedTimes]}
        onDateChange={jest.fn()}
        onOpenEvent={jest.fn()}
        onCreate={jest.fn()}
      />,
    );
    await fireEvent.press(screen.getByTestId('all-day-expand-toggle'));
    expect(screen.getAllByLabelText(/，全天$/).map(node => node.props.accessibilityLabel))
      .toEqual(['Z，全天', 'Z，全天', 'A，全天', 'A，全天', 'B，全天']);
    expect(screen.queryByText('只有开始时间')).toBeNull();
    expect(screen.queryByText('只有结束时间')).toBeNull();
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
    const uses24HourClock = systemUses24HourClock();
    const hour00 = screen.getByTestId('day-hour-00', { includeHiddenElements: true });
    const hour12 = screen.getByTestId('day-hour-12', { includeHiddenElements: true });
    const hour24 = screen.getByTestId('day-hour-24', { includeHiddenElements: true });
    expect(hour00.props.children).toBe(formatTimelineHourLabel(0, uses24HourClock));
    expect(hour24.props.children).toBe(formatTimelineHourLabel(24, uses24HourClock));
    expect(hour00.props.accessible).toBe(false);
    expect(hour00.props.accessibilityElementsHidden).toBe(true);
    expect(hour12.props.style[1].top - hour00.props.style[1].top).toBe(600);
    expect(hour24.props.style[1].top - hour00.props.style[1].top).toBe(1200);

    await fireEvent.press(screen.getByTestId('day-slot-09:30'));
    const quickCreate = screen.getByTestId('day-quick-create');
    expect(quickCreate.props.accessibilityLabel).toBe(
      `${formatTimelineTime(570, uses24HourClock)}至${formatTimelineTime(630, uses24HourClock)}，新建日程`,
    );
    await fireEvent.press(quickCreate);
    expect(onCreate).toHaveBeenCalledWith(
      new Date(2026, 6, 13),
      '09:30',
      new Date(2026, 6, 13),
      '10:30',
    );

    await fireEvent.press(screen.getByTestId('day-slot-23:30'));
    await fireEvent.press(screen.getByTestId('day-quick-create'));
    expect(onCreate).toHaveBeenLastCalledWith(
      new Date(2026, 6, 13),
      '23:30',
      new Date(2026, 6, 14),
      '00:30',
    );

    await fireEvent(activeDay, 'accessibilityAction', {
      nativeEvent: { actionName: 'increment' },
    });
    expect(onDateChange).toHaveBeenCalledWith(new Date(2026, 6, 14));
  });

  it('preserves a positioned date across data refreshes and repositions a new date once', async () => {
    const animationFrame = global.requestAnimationFrame as jest.Mock;
    animationFrame.mockClear();
    const baseEvents = events.filter(event => !event.isAllDay && event.id !== 'span-course');
    const props = {
      events: baseEvents,
      onDateChange: jest.fn(),
      onOpenEvent: jest.fn(),
      onCreate: jest.fn(),
    };
    const view = await render(<DayTimelineView date={new Date(2026, 6, 13)} {...props} />);

    const originalTimeline = screen.getByTestId('day-timeline-scroll');
    await fireEvent(originalTimeline, 'layout', { nativeEvent: { layout: { height: 500 } } });
    expect(animationFrame).toHaveBeenCalledTimes(1);

    await view.rerender(
      <DayTimelineView
        date={new Date(2026, 6, 13)}
        {...props}
        events={[...baseEvents, events.find(event => event.id === 'all-day-meeting')!]}
      />,
    );
    expect(screen.getByTestId('day-timeline-scroll')).toBe(originalTimeline);
    expect(animationFrame).toHaveBeenCalledTimes(1);

    await view.rerender(<DayTimelineView date={new Date(2026, 6, 14)} {...props} />);
    await fireEvent(screen.getByTestId('day-timeline-scroll'), 'layout', {
      nativeEvent: { layout: { height: 500 } },
    });
    expect(animationFrame).toHaveBeenCalledTimes(2);

    await view.rerender(<DayTimelineView date={new Date(2026, 6, 13)} {...props} />);
    expect(animationFrame).toHaveBeenCalledTimes(2);
  });

  it('clears quick drafts on interaction changes and rejects rapid duplicate creation', async () => {
    const onCreate = jest.fn();
    const onOpenEvent = jest.fn();
    await render(
      <DayTimelineView
        date={new Date(2026, 6, 13)}
        events={events}
        onDateChange={jest.fn()}
        onOpenEvent={onOpenEvent}
        onCreate={onCreate}
      />,
    );

    await fireEvent.press(screen.getByTestId('day-slot-09:30'));
    const coveredSlot = screen.getByTestId('day-slot-09:30', { includeHiddenElements: true });
    expect(coveredSlot.props.accessible).toBe(false);
    expect(coveredSlot.props.accessibilityElementsHidden).toBe(true);
    const quickCreate = screen.getByTestId('day-quick-create');
    await act(() => {
      quickCreate.props.onPress();
      quickCreate.props.onPress();
    });
    expect(onCreate).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId('day-quick-create')).toBeNull();

    await fireEvent.press(screen.getByTestId('day-slot-10:00'));
    expect(screen.getByTestId('day-quick-create')).toBeTruthy();
    await fireEvent(screen.getByTestId('day-timeline-scroll'), 'scrollBeginDrag');
    expect(screen.queryByTestId('day-quick-create')).toBeNull();

    await fireEvent.press(screen.getByTestId('day-slot-10:30'));
    await fireEvent(screen.getByTestId('day-view-pager'), 'scrollBeginDrag');
    expect(screen.queryByTestId('day-quick-create')).toBeNull();

    const timeline = screen.getByTestId('day-timeline-scroll');
    await fireEvent(timeline, 'layout', { nativeEvent: { layout: { height: 600 } } });
    await fireEvent.press(screen.getByTestId('day-slot-11:00'));
    await fireEvent(timeline, 'layout', { nativeEvent: { layout: { height: 520 } } });
    expect(screen.queryByTestId('day-quick-create')).toBeNull();

    const timelineEvent = screen.getByTestId('timeline-event-morning-meeting');
    await act(() => {
      timelineEvent.props.onPress();
      timelineEvent.props.onPress();
    });
    expect(onOpenEvent).toHaveBeenCalledTimes(1);
  });

  it('exposes one actionable TalkBack node per visible slot or event', async () => {
    await render(
      <DayTimelineView
        date={new Date(2026, 6, 13)}
        events={events}
        onDateChange={jest.fn()}
        onOpenEvent={jest.fn()}
        onCreate={jest.fn()}
      />,
    );

    const uses24HourClock = systemUses24HourClock();
    const slot = screen.getByTestId('day-slot-13:30');
    expect(slot.props.accessible).toBe(true);
    expect(slot.props.accessibilityLabel).toBe(
      `${formatTimelineTime(810, uses24HourClock)}至${formatTimelineTime(870, uses24HourClock)}，空白时段`,
    );
    expect(slot.props.accessibilityHint).toBe('双击新建一小时日程');

    const event = screen.getByTestId('timeline-event-morning-meeting');
    expect(event.props.accessible).toBe(true);
    expect(event.props.accessibilityHint).toBe('双击查看日程详情');
    expect(within(event).getByText('上午会议').props.accessible).toBe(false);

    expect(screen.getAllByLabelText(slot.props.accessibilityLabel)).toHaveLength(1);
  });

  it('moves and resizes a timed event in 15-minute TalkBack steps before saving', async () => {
    const onChangeEventTime = jest.fn(async () => true);
    await render(
      <DayTimelineView
        date={new Date(2026, 6, 13)}
        events={[events[0]]}
        onDateChange={jest.fn()}
        onOpenEvent={jest.fn()}
        onCreate={jest.fn()}
        onChangeEventTime={onChangeEventTime}
      />,
    );

    await fireEvent(screen.getByTestId('timeline-event-morning-meeting'), 'accessibilityAction', {
      nativeEvent: { actionName: 'edit' },
    });
    expect(screen.getByTestId('timeline-resize-start-morning-meeting')).toBeTruthy();
    expect(screen.getByTestId('timeline-resize-end-morning-meeting')).toBeTruthy();

    await fireEvent(screen.getByTestId('timeline-event-morning-meeting'), 'accessibilityAction', {
      nativeEvent: { actionName: 'increment' },
    });
    await fireEvent(screen.getByTestId('timeline-resize-end-morning-meeting'), 'accessibilityAction', {
      nativeEvent: { actionName: 'increment' },
    });
    const edited = screen.getByTestId('timeline-event-morning-meeting');
    expect(edited.props.accessibilityLabel).toContain('09:15');
    expect(edited.props.accessibilityLabel).toContain('10:30');

    await act(async () => {
      edited.props.onAccessibilityAction({ nativeEvent: { actionName: 'activate' } });
      await Promise.resolve();
    });

    expect(onChangeEventTime).toHaveBeenCalledWith(events[0], {
      startDate: '2026-07-13',
      endDate: undefined,
      startTime: '09:15',
      endTime: '10:30',
    });
    await waitFor(() => expect(screen.queryByTestId('timeline-resize-start-morning-meeting')).toBeNull());
  });

  it('rolls a rejected timeline edit back to the source geometry', async () => {
    const onChangeEventTime = jest.fn(async () => false);
    await render(
      <DayTimelineView
        date={new Date(2026, 6, 13)}
        events={[events[0]]}
        onDateChange={jest.fn()}
        onOpenEvent={jest.fn()}
        onCreate={jest.fn()}
        onChangeEventTime={onChangeEventTime}
      />,
    );
    const originalTop = StyleSheet.flatten(
      screen.getByTestId('timeline-event-morning-meeting').props.style,
    ).top;
    await fireEvent(screen.getByTestId('timeline-event-morning-meeting'), 'accessibilityAction', {
      nativeEvent: { actionName: 'edit' },
    });
    await fireEvent(screen.getByTestId('timeline-event-morning-meeting'), 'accessibilityAction', {
      nativeEvent: { actionName: 'increment' },
    });
    expect(StyleSheet.flatten(screen.getByTestId('timeline-event-morning-meeting').props.style).top)
      .toBeGreaterThan(originalTop);

    await act(async () => {
      screen.getByTestId('timeline-event-morning-meeting').props.onAccessibilityAction({
        nativeEvent: { actionName: 'activate' },
      });
      await Promise.resolve();
    });

    await waitFor(() => expect(
      StyleSheet.flatten(screen.getByTestId('timeline-event-morning-meeting').props.style).top,
    ).toBe(originalTop));
  });

  it('formats hour labels and cross-midnight ranges for both system clock modes', () => {
    expect(formatTimelineHourLabel(13, true)).toBe('13:00');
    expect(formatTimelineTime(570, true)).toBe('09:30');
    expect(formatTimelineTime(1470, true)).toBe('次日00:30');

    expect(formatTimelineHourLabel(13, false)).toBe('下午1');
    expect(formatTimelineTime(570, false)).toBe('上午9:30');
    expect(formatTimelineTime(1470, false)).toBe('次日上午12:30');

    const baseOptions = new Intl.DateTimeFormat(undefined, { hour: 'numeric' }).resolvedOptions();
    const resolvedOptions = jest.spyOn(Intl.DateTimeFormat.prototype, 'resolvedOptions');
    try {
      resolvedOptions.mockReturnValue({
        ...baseOptions,
        hour12: false,
        hourCycle: 'h23',
      });
      expect(systemUses24HourClock(null)).toBe(true);
      resolvedOptions.mockReturnValue({
        ...baseOptions,
        hour12: true,
        hourCycle: 'h12',
      });
      expect(systemUses24HourClock(null)).toBe(false);
    } finally {
      resolvedOptions.mockRestore();
    }
  });
});
