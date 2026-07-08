import React from 'react';
import { StyleSheet, ViewStyle } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Colors as C } from '../theme/colors';

interface Props {
  children: React.ReactNode;
  style?: ViewStyle;
  bg?: string;
  /** Which edges to apply safe-area insets to. Defaults to top + bottom. */
  edges?: ('top' | 'bottom' | 'left' | 'right')[];
}

/**
 * Root wrapper for every screen.
 * SafeAreaView from react-native-safe-area-context is the most reliable
 * way to respect status-bar and bottom-navigation-bar insets in Expo Go.
 */
export function ScreenContainer({
  children,
  style,
  bg,
  edges = ['top', 'bottom'],
}: Props) {
  return (
    <SafeAreaView
      style={[s.root, { backgroundColor: bg ?? C.appBg }, style]}
      edges={edges}
    >
      {children}
    </SafeAreaView>
  );
}

const s = StyleSheet.create({
  root: { flex: 1 },
});
