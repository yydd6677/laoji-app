import React from 'react';
import {
  StyleSheet,
  useWindowDimensions,
  View,
  ViewProps,
} from 'react-native';

export const RESPONSIVE_CONTENT_MAX_WIDTH = 720;
export const RESPONSIVE_CONTENT_HORIZONTAL_GUTTER = 16;
export const RESPONSIVE_CONTENT_WIDE_MIN_WIDTH = 600;

export type ResponsiveContentLayout = {
  constrained: boolean;
  contentWidth: number;
};

export function resolveResponsiveContentLayout(
  viewportWidth: number,
  viewportHeight: number,
  maxWidth = RESPONSIVE_CONTENT_MAX_WIDTH,
  horizontalGutter = RESPONSIVE_CONTENT_HORIZONTAL_GUTTER,
): ResponsiveContentLayout {
  const constrained = viewportWidth >= RESPONSIVE_CONTENT_WIDE_MIN_WIDTH
    || viewportWidth > viewportHeight;
  const availableWidth = Math.max(0, viewportWidth - horizontalGutter * 2);

  return {
    constrained,
    contentWidth: constrained ? Math.min(maxWidth, availableWidth) : viewportWidth,
  };
}

type Props = ViewProps & {
  maxWidth?: number;
  horizontalGutter?: number;
};

export function ResponsiveContentFrame({
  maxWidth = RESPONSIVE_CONTENT_MAX_WIDTH,
  horizontalGutter = RESPONSIVE_CONTENT_HORIZONTAL_GUTTER,
  style,
  ...props
}: Props) {
  const { width, height } = useWindowDimensions();
  const layout = resolveResponsiveContentLayout(width, height, maxWidth, horizontalGutter);

  return (
    <View
      {...props}
      style={[
        s.frame,
        layout.constrained ? { width: layout.contentWidth, maxWidth } : null,
        style,
      ]}
    />
  );
}

const s = StyleSheet.create({
  frame: {
    flex: 1,
    width: '100%',
    alignSelf: 'center',
  },
});
