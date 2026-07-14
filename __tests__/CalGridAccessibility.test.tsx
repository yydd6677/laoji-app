import React from 'react';
import { fireEvent, render, screen, within } from '@testing-library/react-native';
import { StyleSheet } from 'react-native';
import { CalGrid, calendarPopoverColumnCount } from '../src/components/CalGrid';
import type { CalEvent } from '../src/types';

jest.mock('@expo/vector-icons', () => ({ Ionicons: 'Ionicons' }));

const events: CalEvent[] = [
  {
    id: 'timed-meeting',
    title: '晚间会议',
    startDate: '2026-07-13',
    startTime: '21:00',
    color: '#5B8CFF',
  },
  {
    id: 'all-day-meeting',
    title: '全天会议',
    startDate: '2026-07-13',
    isAllDay: true,
    color: '#7B5CB8',
  },
  {
    id: 'span-course',
    title: '连续课程',
    startDate: '2026-07-13',
    endDate: '2026-07-15',
    spanning: true,
    startTime: '10:00',
    color: '#26C6DA',
  },
  {
    id: 'next-day',
    title: '整理材料',
    startDate: '2026-07-14',
    startTime: '09:00',
    color: '#52C41A',
  },
];

function CalendarHarness({
  onDay = jest.fn(),
  onPrev = jest.fn(),
  onNext = jest.fn(),
  onEvent,
}: {
  onDay?: jest.Mock;
  onPrev?: jest.Mock;
  onNext?: jest.Mock;
  onEvent?: (event: CalEvent) => void;
}) {
  return (
    <CalGrid
      year={2026}
      month={7}
      selDay={13}
      onDay={onDay}
      onPrev={onPrev}
      onNext={onNext}
      onTitle={jest.fn()}
      onEvent={onEvent}
      events={events}
    />
  );
}

describe('CalGrid interaction and accessibility', () => {
  it('uses a horizontal pager without previous or next month buttons', async () => {
    const onPrev = jest.fn();
    const onNext = jest.fn();
    await render(<CalendarHarness onPrev={onPrev} onNext={onNext} />);

    const pager = screen.getByTestId('calendar-month-pager');
    expect(pager.props.horizontal).toBe(true);
    expect(pager.props.pagingEnabled).toBe(true);
    expect(pager.props.accessibilityRole).toBe('adjustable');
    expect(pager.props.accessibilityActions).toEqual([
      { name: 'decrement', label: '上一个月' },
      { name: 'increment', label: '下一个月' },
    ]);
    expect(screen.queryByLabelText('上一个月')).toBeNull();
    expect(screen.queryByLabelText('下一个月')).toBeNull();
    expect(screen.getByLabelText('打开完整日历，2026年7月')).toBeTruthy();

    await fireEvent(pager, 'momentumScrollEnd', {
      nativeEvent: { contentOffset: { x: 724, y: 0 } },
    });
    expect(onNext).toHaveBeenCalledTimes(1);
    await fireEvent(pager, 'momentumScrollEnd', {
      nativeEvent: { contentOffset: { x: 0, y: 0 } },
    });
    expect(onPrev).toHaveBeenCalledTimes(1);

    await fireEvent(pager, 'accessibilityAction', { nativeEvent: { actionName: 'increment' } });
    await fireEvent(pager, 'accessibilityAction', { nativeEvent: { actionName: 'decrement' } });
    expect(onNext).toHaveBeenCalledTimes(2);
    expect(onPrev).toHaveBeenCalledTimes(2);
  });

  it('shows a stable decorated event count until the selected date is opened', async () => {
    await render(<CalendarHarness />);

    const selectedDate = screen.getByLabelText(/2026年7月13日.*3条日程/);
    const dayNumber = within(selectedDate).getByText('13');
    expect(StyleSheet.flatten(dayNumber.props.style).fontSize).toBe(16);
    expect(StyleSheet.flatten(dayNumber.parent?.props.style).width).toBeGreaterThanOrEqual(40);
    const eventCount = screen.getByTestId('calendar-day-count-2026-07-13');
    expect(StyleSheet.flatten(eventCount.props.style)).toEqual(expect.objectContaining({
      position: 'absolute',
      minWidth: 22,
      height: 16,
      borderWidth: 1,
    }));
    const eventCountText = screen.getByTestId('calendar-day-count-text-2026-07-13');
    expect(eventCountText.props.children).toBe('3');
    expect(StyleSheet.flatten(eventCountText.props.style).fontSize).toBe(11);
    expect(screen.queryByText('晚间会议')).toBeNull();
    expect(screen.queryByTestId('calendar-event-popover')).toBeNull();

    await fireEvent.press(selectedDate);

    const popover = screen.getByTestId('calendar-event-popover');
    expect(StyleSheet.flatten(popover.props.style)).toEqual(expect.objectContaining({
      position: 'absolute',
      width: 255,
    }));
    expect(StyleSheet.flatten(screen.getByText('7月13日 · 3项').props.style).fontSize).toBe(13);
    expect(screen.getByText('7月13日 · 3项')).toBeTruthy();
    expect(screen.getByLabelText('连续课程，10:00')).toBeTruthy();
    expect(screen.getByLabelText('晚间会议，21:00')).toBeTruthy();
    expect(screen.getByLabelText('全天会议，全天')).toBeTruthy();
    expect(screen.getAllByLabelText(/^(连续课程|晚间会议|全天会议)，/)
      .map(node => node.props.accessibilityLabel)).toEqual([
        '连续课程，10:00',
        '晚间会议，21:00',
        '全天会议，全天',
      ]);
    const threeItemSlot = StyleSheet.flatten(
      screen.getByTestId('calendar-popover-slot-span-course').props.style,
    );
    expect(threeItemSlot.width).toBe('50%');
  });

  it('toggles the same date closed and replaces it when another date is selected', async () => {
    const onDay = jest.fn();
    await render(<CalendarHarness onDay={onDay} />);
    const day13 = screen.getByLabelText(/2026年7月13日.*3条日程/);

    await fireEvent.press(day13);
    expect(screen.getByText('7月13日 · 3项')).toBeTruthy();
    await fireEvent.press(day13);
    expect(screen.queryByTestId('calendar-event-popover')).toBeNull();

    await fireEvent.press(day13);
    await fireEvent.press(screen.getByLabelText(/2026年7月14日.*2条日程/));
    expect(screen.queryByText('7月13日 · 3项')).toBeNull();
    expect(screen.getByText('7月14日 · 2项')).toBeTruthy();
    expect(screen.getAllByTestId('calendar-event-popover')).toHaveLength(1);
    expect(onDay).toHaveBeenLastCalledWith(14);
  });

  it('opens an event from the popover and keeps adjacent-month cells disabled', async () => {
    const onEvent = jest.fn();
    await render(<CalendarHarness onEvent={onEvent} />);

    await fireEvent.press(screen.getByLabelText(/2026年7月13日.*3条日程/));
    await fireEvent.press(screen.getByLabelText('连续课程，10:00'));
    expect(onEvent).toHaveBeenCalledWith(expect.objectContaining({ id: 'span-course' }));

    const adjacentDay = screen.getAllByText('29')
      .map(item => item.parent?.parent)
      .find(item => item?.props.disabled && item?.props.accessibilityLabel == null);
    expect(adjacentDay?.props.disabled).toBe(true);
    expect(adjacentDay?.props.accessibilityLabel).toBeUndefined();
  });

  it('chooses near-square row-major grids for three or more events', () => {
    expect(calendarPopoverColumnCount(1)).toBe(1);
    expect(calendarPopoverColumnCount(2)).toBe(2);
    expect(calendarPopoverColumnCount(3)).toBe(2);
    expect(calendarPopoverColumnCount(4)).toBe(2);
    expect(calendarPopoverColumnCount(5)).toBe(3);
    expect(calendarPopoverColumnCount(9)).toBe(3);
  });
});
