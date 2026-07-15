import React from 'react';
import { fireEvent, render } from '@testing-library/react-native';
import { StyleSheet } from 'react-native';
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
});
