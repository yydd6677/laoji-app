import React from 'react';
import { fireEvent, render } from '@testing-library/react-native';
import { StyleSheet } from 'react-native';
import {
  CALENDAR_SWITCH_GEOMETRY,
  CalendarSwitch,
} from '../src/components/CalendarSwitch';
import { Colors as C } from '../src/theme/colors';

describe('CalendarSwitch', () => {
  it('uses the source UDSwitch geometry and toggles from the whole control', async () => {
    const onChange = jest.fn();
    const view = await render(
      <CalendarSwitch
        checked
        onChange={onChange}
        accessibilityLabel="日程提醒"
        testID="source-switch"
      />,
    );

    expect(CALENDAR_SWITCH_GEOMETRY).toEqual({
      width: 36,
      height: 20,
      trackHeight: 14,
      trackInset: 3,
      thumbSize: 20,
      thumbTravel: 16,
    });
    expect(StyleSheet.flatten(view.getByTestId('source-switch').props.style)).toEqual(
      expect.objectContaining({ width: 36, height: 20 }),
    );
    expect(StyleSheet.flatten(view.getByTestId('source-switch-track').props.style)).toEqual(
      expect.objectContaining({ top: 3, height: 14, borderRadius: 7, backgroundColor: C.primary }),
    );
    expect(StyleSheet.flatten(view.getByTestId('source-switch-thumb').props.style)).toEqual(
      expect.objectContaining({ width: 20, height: 20, borderRadius: 10 }),
    );

    fireEvent.press(view.getByTestId('source-switch'));
    expect(onChange).toHaveBeenCalledWith(false);
  });

  it('uses the disabled track color and exposes the disabled state', async () => {
    const view = await render(
      <CalendarSwitch
        checked
        disabled
        onChange={jest.fn()}
        accessibilityLabel="全天日程"
        testID="disabled-switch"
      />,
    );

    expect(view.getByTestId('disabled-switch').props.accessibilityState).toEqual({
      checked: true,
      disabled: true,
    });
    expect(StyleSheet.flatten(view.getByTestId('disabled-switch-track').props.style)).toEqual(
      expect.objectContaining({ backgroundColor: C.disabled }),
    );
  });
});
