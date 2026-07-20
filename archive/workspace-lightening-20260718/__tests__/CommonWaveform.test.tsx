import React from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react-native';
import { StyleSheet } from 'react-native';
import {
  BACK_HEADER_GEOMETRY,
  BackHeader,
  Waveform,
  resampleWaveformBars,
  waveformBarCapacity,
} from '../src/components/Common';
import { Colors as C } from '../src/theme/colors';

jest.mock('@expo/vector-icons', () => ({ Ionicons: 'Ionicons' }));
jest.mock('react-native-svg', () => ({
  __esModule: true,
  default: 'Svg',
  Circle: 'Circle',
  Path: 'Path',
}));

describe('Waveform responsive layout', () => {
  it('preserves peaks while resampling to the measured bar capacity', () => {
    expect(waveformBarCapacity(98)).toBe(20);
    expect(resampleWaveformBars([1, 9, 2, 8], 2)).toEqual([9, 8]);
  });

  it('clips its first frame and resamples long data without entering adjacent duration text', async () => {
    const bars = Array.from({ length: 100 }, (_, index) => (index % 10) + 1);
    await render(<Waveform bars={bars} color="#7C3AED" height={28} splitAt={50} />);

    const waveform = screen.getByTestId('waveform');
    expect(StyleSheet.flatten(waveform.props.style)).toEqual(expect.objectContaining({
      width: '100%',
      maxWidth: '100%',
      overflow: 'hidden',
    }));

    await act(() => {
      waveform.props.onLayout({ nativeEvent: { layout: { width: 178 } } });
    });

    const renderedBars = screen.getAllByTestId('waveform-bar');
    expect(renderedBars).toHaveLength(waveformBarCapacity(178));

    const colors = renderedBars.map(bar => StyleSheet.flatten(bar.props.style).backgroundColor);
    expect(colors.filter(color => color === C.primaryHover)).toHaveLength(18);
    expect(colors.slice(18).every(color => color === '#7C3AED')).toBe(true);
  });
});

describe('BackHeader source geometry', () => {
  it('uses the full-screen CommonTitleBar geometry', async () => {
    const onBack = jest.fn();
    await render(<BackHeader title="讲话人管理" onBack={onBack} />);

    expect(BACK_HEADER_GEOMETRY).toEqual({
      height: 44,
      backTargetWidth: 54,
      backIconSize: 24,
      titleInset: 62,
      titleSize: 18,
      rightTargetWidth: 48,
    });
    expect(StyleSheet.flatten(screen.getByLabelText('返回').props.style)).toMatchObject({
      width: 54,
      height: 44,
    });
    expect(screen.getByTestId('app-back-icon').props.size).toBe(24);
    expect(StyleSheet.flatten(screen.getByTestId('app-back-title').props.style)).toMatchObject({
      left: 62,
      right: 62,
      fontSize: 18,
      fontWeight: '400',
    });
    expect(StyleSheet.flatten(screen.getByTestId('app-back-right').props.style)).toMatchObject({
      width: 48,
      height: 44,
    });
    fireEvent.press(screen.getByLabelText('返回'));
    expect(onBack).toHaveBeenCalledTimes(1);
  });
});
