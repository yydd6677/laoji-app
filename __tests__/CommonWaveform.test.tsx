import React from 'react';
import { act, render, screen } from '@testing-library/react-native';
import { StyleSheet } from 'react-native';
import {
  Waveform,
  resampleWaveformBars,
  waveformBarCapacity,
} from '../src/components/Common';

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
    expect(colors.filter(color => color === '#4A90D9')).toHaveLength(18);
    expect(colors.slice(18).every(color => color === '#7C3AED')).toBe(true);
  });
});
