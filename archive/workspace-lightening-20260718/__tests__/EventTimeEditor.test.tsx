import React from 'react';
import { fireEvent, render, within } from '@testing-library/react-native';
import { StyleSheet, useWindowDimensions } from 'react-native';
import { EventTimeEditor, EventTimeValue } from '../src/components/EventTimeEditor';
import { Colors as C } from '../src/theme/colors';

jest.mock('@expo/vector-icons', () => ({ Ionicons: 'Ionicons' }));

function time(hour: number, minute: number): Date {
  const value = new Date(2026, 6, 20);
  value.setHours(hour, minute, 0, 0);
  return value;
}

describe('EventTimeEditor', () => {
  const value: EventTimeValue = {
    startDate: new Date(2026, 6, 20),
    endDate: new Date(2026, 6, 20),
    startTime: time(10, 0),
    endTime: time(11, 0),
    isAllDay: false,
  };

  beforeEach(() => {
    (useWindowDimensions as jest.Mock).mockReturnValue({ width: 390, height: 844 });
  });

  it('uses the source seven-row date/hour/minute wheels and commits from Done', async () => {
    const onDone = jest.fn();
    const view = await render(
      <EventTimeEditor
        visible
        value={value}
        initialTarget="start"
        onCancel={jest.fn()}
        onDone={onDone}
        onInvalid={jest.fn()}
      />,
    );

    expect(view.getByText('时间')).toBeTruthy();
    const pageTransform = view.getByTestId('event-time-page').props.style[1].transform;
    expect(pageTransform[0]).toHaveProperty('translateY');
    expect(pageTransform[0]).not.toHaveProperty('translateX');
    expect(view.getByText('10:00')).toBeTruthy();
    expect(view.getByText('11:00')).toBeTruthy();
    const rangeArrow = view.getByTestId('event-time-range-arrow');
    expect(StyleSheet.flatten(rangeArrow.props.style)).toEqual(
      expect.objectContaining({ width: 8, height: 32, overflow: 'hidden' }),
    );
    const [upperStroke, lowerStroke] = rangeArrow.props.children;
    expect(StyleSheet.flatten(upperStroke.props.style)).toEqual(expect.objectContaining({
      width: 1,
      height: 18,
      transform: [{ rotate: '-26.565deg' }],
    }));
    expect(StyleSheet.flatten(lowerStroke.props.style)).toEqual(expect.objectContaining({
      width: 1,
      height: 18,
      transform: [{ rotate: '26.565deg' }],
    }));
    expect(view.getByTestId('event-time-date-wheel')).toBeTruthy();
    expect(view.getByTestId('event-time-hour-wheel').props.accessibilityValue.text).toBe('10');
    expect(view.getByTestId('event-time-minute-wheel').props.accessibilityValue.text).toBe('00');
    expect(StyleSheet.flatten(view.getByTestId('event-time-all-day-row').props.style)).toEqual(
      expect.objectContaining({ minHeight: 22, marginVertical: 14 }),
    );
    expect(StyleSheet.flatten(view.getByTestId('event-all-day-toggle').props.style)).toEqual(
      expect.objectContaining({ width: 36, height: 20 }),
    );
    expect(StyleSheet.flatten(view.getByTestId('event-all-day-toggle-track').props.style)).toEqual(
      expect.objectContaining({ top: 3, height: 14 }),
    );
    expect(StyleSheet.flatten(view.getByTestId('event-time-hour-wheel-divider-top').props.style)).toEqual(
      expect.objectContaining({ backgroundColor: C.divider }),
    );
    const selectedTen = view.getAllByText('10').find(node => (
      StyleSheet.flatten(node.props.style).fontSize === 20
    ));
    expect(StyleSheet.flatten(selectedTen?.props.style)).toEqual(expect.objectContaining({
      fontSize: 20,
      lineHeight: 28,
      color: '#1F2329',
    }));

    await fireEvent(view.getByTestId('event-time-hour-wheel'), 'accessibilityAction', {
      nativeEvent: { actionName: 'increment' },
    });
    expect(view.getByText('11:00')).toBeTruthy();
    await fireEvent.press(view.getByTestId('event-time-done'));
    expect(onDone).toHaveBeenCalledWith(expect.objectContaining({
      startTime: expect.any(Date),
      endTime: expect.any(Date),
      isAllDay: false,
    }));
    expect(onDone.mock.calls[0][0].startTime.getHours()).toBe(11);
    expect(onDone.mock.calls[0][0].endTime.getHours()).toBe(12);
  });

  it('switches to year/month/day wheels for an all-day event', async () => {
    const onDone = jest.fn();
    const view = await render(
      <EventTimeEditor
        visible
        value={value}
        initialTarget="start"
        onCancel={jest.fn()}
        onDone={onDone}
        onInvalid={jest.fn()}
      />,
    );

    await fireEvent.press(view.getByTestId('event-all-day-toggle'));
    expect(view.getByTestId('event-time-year-wheel')).toBeTruthy();
    expect(view.getByTestId('event-time-month-wheel')).toBeTruthy();
    expect(view.getByTestId('event-time-day-wheel')).toBeTruthy();
    expect(view.queryByTestId('event-time-hour-wheel')).toBeNull();

    await fireEvent.press(view.getByTestId('event-time-done'));
    expect(onDone).toHaveBeenCalledWith(expect.objectContaining({ isAllDay: true }));
  });

  it('normalizes minute values before rendering, announcing, and confirming them', async () => {
    const onDone = jest.fn();
    const nonStepValue: EventTimeValue = {
      ...value,
      startTime: time(10, 3),
      endTime: time(11, 8),
    };
    const view = await render(
      <EventTimeEditor
        visible
        value={nonStepValue}
        initialTarget="start"
        onCancel={jest.fn()}
        onDone={onDone}
        onInvalid={jest.fn()}
      />,
    );

    expect(view.getByText('10:05')).toBeTruthy();
    expect(view.getByText('11:10')).toBeTruthy();
    expect(view.getByTestId('event-time-minute-wheel').props.accessibilityValue.text).toBe('05');
    expect(view.getByLabelText('编辑开始时间').props.accessibilityValue.text).toContain('10:05');

    await fireEvent.press(view.getByTestId('event-time-done'));
    expect(onDone).toHaveBeenCalledTimes(1);
    expect(onDone.mock.calls[0][0].startTime.getMinutes()).toBe(5);
    expect(onDone.mock.calls[0][0].endTime.getMinutes()).toBe(10);
  });

  it('commits the centered value when a slow drag ends without momentum', async () => {
    const onDone = jest.fn();
    const view = await render(
      <EventTimeEditor
        visible
        value={value}
        initialTarget="start"
        onCancel={jest.fn()}
        onDone={onDone}
        onInvalid={jest.fn()}
      />,
    );

    await fireEvent(view.getByTestId('event-time-minute-wheel-list'), 'scrollEndDrag', {
      nativeEvent: { contentOffset: { x: 0, y: 72 } },
    });
    expect(view.getByTestId('event-time-minute-wheel').props.accessibilityValue.text).toBe('10');
    expect(view.getByText('10:10')).toBeTruthy();
    expect(view.getByLabelText('编辑开始时间').props.accessibilityValue.text).toContain('10:10');

    await fireEvent.press(view.getByTestId('event-time-done'));
    expect(onDone.mock.calls[0][0].startTime.getMinutes()).toBe(10);
    expect(onDone.mock.calls[0][0].endTime.getMinutes()).toBe(10);
  });

  it('uses the same bounded date range for timed and all-day wheels', async () => {
    const onDone = jest.fn();
    const outOfRangeValue: EventTimeValue = {
      ...value,
      startDate: new Date(1800, 0, 1),
      endDate: new Date(2200, 0, 1),
    };
    const view = await render(
      <EventTimeEditor
        visible
        value={outOfRangeValue}
        initialTarget="start"
        onCancel={jest.fn()}
        onDone={onDone}
        onInvalid={jest.fn()}
      />,
    );

    expect(view.getByTestId('event-time-date-wheel').props.accessibilityValue.text).toContain('1900年1月1日');
    expect(view.getByLabelText('编辑开始时间').props.accessibilityValue.text).toContain('1900年1月1日');
    await fireEvent.press(view.getByLabelText('编辑结束时间'));
    expect(view.getByTestId('event-time-date-wheel').props.accessibilityValue.text).toContain('2100年12月31日');

    await fireEvent.press(view.getByTestId('event-all-day-toggle'));
    expect(view.getByTestId('event-time-year-wheel').props.accessibilityValue.text).toBe('2100年');
    expect(view.getByText('2100年12月31日')).toBeTruthy();
    await fireEvent.press(view.getByTestId('event-time-done'));
    expect(onDone.mock.calls[0][0].startDate.getFullYear()).toBe(1900);
    expect(onDone.mock.calls[0][0].endDate.getFullYear()).toBe(2100);
  });

  it('clamps the day wheel when changing a leap day to a non-leap year', async () => {
    const onDone = jest.fn();
    const leapDayValue: EventTimeValue = {
      ...value,
      startDate: new Date(2024, 1, 29),
      endDate: new Date(2024, 1, 29),
      isAllDay: true,
    };
    const view = await render(
      <EventTimeEditor
        visible
        value={leapDayValue}
        initialTarget="start"
        onCancel={jest.fn()}
        onDone={onDone}
        onInvalid={jest.fn()}
      />,
    );

    await fireEvent(view.getByTestId('event-time-year-wheel'), 'accessibilityAction', {
      nativeEvent: { actionName: 'increment' },
    });
    expect(view.getByTestId('event-time-year-wheel').props.accessibilityValue.text).toBe('2025年');
    expect(view.getByTestId('event-time-day-wheel').props.accessibilityValue.text).toBe('28日');
    expect(view.getByLabelText('编辑开始日期').props.accessibilityValue.text).toContain('2025年2月28日');

    await fireEvent.press(view.getByTestId('event-time-done'));
    expect(onDone.mock.calls[0][0].startDate.getFullYear()).toBe(2025);
    expect(onDone.mock.calls[0][0].startDate.getMonth()).toBe(1);
    expect(onDone.mock.calls[0][0].startDate.getDate()).toBe(28);
  });

  it.each([
    { width: 320, height: 568 },
    { width: 640, height: 360 },
  ])('keeps all body controls in a reachable scroll container at $width x $height', async viewport => {
    (useWindowDimensions as jest.Mock).mockReturnValue(viewport);
    const view = await render(
      <EventTimeEditor
        visible
        value={value}
        initialTarget="start"
        onCancel={jest.fn()}
        onDone={jest.fn()}
        onInvalid={jest.fn()}
      />,
    );
    const scroll = view.getByTestId('event-time-scroll');
    const scrollContent = within(scroll);

    expect(scroll.props.nestedScrollEnabled).toBe(true);
    expect(scrollContent.getByTestId('event-all-day-toggle')).toBeTruthy();
    expect(scrollContent.getByLabelText('编辑开始时间')).toBeTruthy();
    expect(scrollContent.getByLabelText('编辑结束时间')).toBeTruthy();
    expect(scrollContent.getByTestId('event-time-date-wheel')).toBeTruthy();
    expect(scrollContent.getByTestId('event-time-hour-wheel')).toBeTruthy();
    expect(scrollContent.getByTestId('event-time-minute-wheel')).toBeTruthy();
    expect(scrollContent.getByTestId('event-time-minute-wheel-list').props.nestedScrollEnabled).toBe(true);
    expect(view.getByLabelText('取消')).toBeTruthy();
    expect(view.getByTestId('event-time-done')).toBeTruthy();
  });
});
