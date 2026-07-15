import React from 'react';
import { Animated, BackHandler, Easing, StyleSheet, useWindowDimensions } from 'react-native';
import { Colors as C } from '../theme/colors';

const HIGH_LEVEL_DECELERATE = (value: number) => 1 - Math.pow(1 - value, 10);
const MEDIUM_LEVEL_DECELERATE = (value: number) => 1 - Math.pow(1 - value, 6);

export function CalendarSlidePage({
  visible,
  children,
  testID,
  onRequestClose,
  direction = 'horizontal',
  duration,
  enterDuration,
  exitDuration,
}: {
  visible: boolean;
  children: React.ReactNode;
  testID?: string;
  onRequestClose: () => void;
  direction?: 'horizontal' | 'vertical';
  duration?: number;
  enterDuration?: number;
  exitDuration?: number;
}) {
  const { width, height } = useWindowDimensions();
  const [mounted, setMounted] = React.useState(visible);
  const progress = React.useRef(new Animated.Value(visible ? 1 : 0)).current;
  const resolvedEnterDuration = enterDuration ?? duration ?? (direction === 'vertical' ? 800 : 180);
  const resolvedExitDuration = exitDuration ?? duration ?? (direction === 'vertical' ? 300 : 180);
  const enterEasing = direction === 'vertical'
    ? HIGH_LEVEL_DECELERATE
    : Easing.out(Easing.ease);
  const exitEasing = direction === 'vertical'
    ? MEDIUM_LEVEL_DECELERATE
    : Easing.in(Easing.ease);

  React.useEffect(() => {
    if (visible) {
      setMounted(true);
      progress.stopAnimation();
      Animated.timing(progress, {
        toValue: 1,
        duration: resolvedEnterDuration,
        easing: enterEasing,
        useNativeDriver: true,
      }).start();
      return;
    }
    if (!mounted) return;
    progress.stopAnimation();
    Animated.timing(progress, {
      toValue: 0,
      duration: resolvedExitDuration,
      easing: exitEasing,
      useNativeDriver: true,
    }).start(({ finished }) => {
      if (finished) setMounted(false);
    });
  }, [direction, mounted, progress, resolvedEnterDuration, resolvedExitDuration, visible]);

  React.useEffect(() => {
    if (!visible) return undefined;
    const subscription = BackHandler.addEventListener('hardwareBackPress', () => {
      onRequestClose();
      return true;
    });
    return () => subscription.remove();
  }, [onRequestClose, visible]);

  if (!mounted) return null;

  const travel = direction === 'vertical' ? height : width;
  const translate = progress.interpolate({ inputRange: [0, 1], outputRange: [travel, 0] });
  const transform = direction === 'vertical'
    ? [{ translateY: translate }]
    : [{ translateX: translate }];

  return (
    <Animated.View
      style={[
        s.root,
        { transform },
      ]}
      accessibilityViewIsModal
      testID={testID}
    >
      {children}
    </Animated.View>
  );
}

const s = StyleSheet.create({
  root: { ...StyleSheet.absoluteFillObject, zIndex: 100, backgroundColor: C.body },
});
