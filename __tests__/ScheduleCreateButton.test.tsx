import React from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react-native';
import { StyleSheet } from 'react-native';
import {
  SCHEDULE_CREATE_GEOMETRY,
  ScheduleCreateButton,
  scheduleCreateTargetAt,
} from '../src/components/ScheduleCreateButton';

jest.mock('@expo/vector-icons', () => ({ Ionicons: 'Ionicons' }));

const gesture = (pageX: number, pageY: number, locationX = 24, locationY = 24) => ({
  nativeEvent: { pageX, pageY, locationX, locationY },
});

describe('ScheduleCreateButton', () => {
  it('keeps a tap on the existing create-choice flow', async () => {
    const onPress = jest.fn();
    await render(
      <ScheduleCreateButton
        bottom={85}
        onPress={onPress}
        onVoice={jest.fn()}
        onManual={jest.fn()}
      />,
    );

    expect(screen.queryByTestId('calendar-create-radial')).toBeNull();
    await fireEvent.press(screen.getByLabelText('新建日程'));
    expect(onPress).toHaveBeenCalledTimes(1);
    expect(StyleSheet.flatten(screen.getByTestId('calendar-create-cluster').props.style))
      .toEqual(expect.objectContaining({ bottom: 85 }));
  });

  it('opens around the button and selects voice by dragging and releasing', async () => {
    const onPress = jest.fn();
    const onVoice = jest.fn();
    await render(
      <ScheduleCreateButton
        bottom={85}
        onPress={onPress}
        onVoice={onVoice}
        onManual={jest.fn()}
      />,
    );

    const button = screen.getByTestId('calendar-create-button');
    await act(() => button.props.onLongPress(gesture(300, 700)));
    expect(screen.getByTestId('calendar-create-radial')).toBeTruthy();
    expect(screen.getByText('语音')).toBeTruthy();
    expect(screen.getByText('手动')).toBeTruthy();

    const voice = SCHEDULE_CREATE_GEOMETRY.targetOffsets.voice;
    await act(() => button.props.onTouchMove(gesture(300 + voice.x, 700 + voice.y)));
    await act(() => button.props.onPressOut(gesture(300 + voice.x, 700 + voice.y)));

    expect(onVoice).toHaveBeenCalledTimes(1);
    expect(onPress).not.toHaveBeenCalled();
  });

  it('selects manual creation and cancels when released outside both targets', async () => {
    const onManual = jest.fn();
    await render(
      <ScheduleCreateButton
        bottom={85}
        onPress={jest.fn()}
        onVoice={jest.fn()}
        onManual={onManual}
      />,
    );

    const button = screen.getByTestId('calendar-create-button');
    const manual = SCHEDULE_CREATE_GEOMETRY.targetOffsets.manual;
    await act(() => button.props.onLongPress(gesture(300, 700)));
    await act(() => button.props.onPressOut(gesture(300 + manual.x, 700 + manual.y)));
    expect(onManual).toHaveBeenCalledTimes(1);

    await act(() => button.props.onLongPress(gesture(300, 700)));
    await act(() => button.props.onPressOut(gesture(300, 700)));
    expect(onManual).toHaveBeenCalledTimes(1);
  });

  it('uses bounded target hit areas instead of selecting by direction alone', () => {
    const center = { x: 300, y: 700 };
    const voice = SCHEDULE_CREATE_GEOMETRY.targetOffsets.voice;
    const manual = SCHEDULE_CREATE_GEOMETRY.targetOffsets.manual;
    expect(scheduleCreateTargetAt(center, { x: center.x + voice.x, y: center.y + voice.y })).toBe('voice');
    expect(scheduleCreateTargetAt(center, { x: center.x + manual.x, y: center.y + manual.y })).toBe('manual');
    expect(scheduleCreateTargetAt(center, center)).toBeNull();
  });
});
