import React from 'react';
import { render } from '@testing-library/react-native';
import { StyleSheet, useWindowDimensions } from 'react-native';
import {
  RESPONSIVE_CONTENT_MAX_WIDTH,
  ResponsiveContentFrame,
  resolveResponsiveContentLayout,
} from '../src/components/ResponsiveContentFrame';

describe('ResponsiveContentFrame', () => {
  beforeEach(() => {
    (useWindowDimensions as jest.Mock).mockReturnValue({ width: 390, height: 844 });
  });

  it('keeps compact portrait content full width and constrains landscape or wide content', () => {
    expect(resolveResponsiveContentLayout(320, 568)).toEqual({
      constrained: false,
      contentWidth: 320,
    });
    expect(resolveResponsiveContentLayout(640, 360)).toEqual({
      constrained: true,
      contentWidth: 608,
    });
    expect(resolveResponsiveContentLayout(1280, 800)).toEqual({
      constrained: true,
      contentWidth: RESPONSIVE_CONTENT_MAX_WIDTH,
    });
  });

  it.each([
    { viewport: { width: 320, height: 568 }, expectedWidth: '100%', expectedMaxWidth: undefined },
    { viewport: { width: 640, height: 360 }, expectedWidth: 608, expectedMaxWidth: RESPONSIVE_CONTENT_MAX_WIDTH },
  ])('centers its frame at $viewport.width x $viewport.height', async ({
    viewport,
    expectedWidth,
    expectedMaxWidth,
  }) => {
    (useWindowDimensions as jest.Mock).mockReturnValue(viewport);
    const view = await render(
      <ResponsiveContentFrame testID="responsive-content-frame" />,
    );
    const style = StyleSheet.flatten(view.getByTestId('responsive-content-frame').props.style);

    expect(style).toEqual(expect.objectContaining({
      flex: 1,
      width: expectedWidth,
      alignSelf: 'center',
    }));
    expect(style.maxWidth).toBe(expectedMaxWidth);
  });
});
