import React, { useCallback, useRef, useState } from 'react';
import {
  Animated,
  Easing,
  Pressable,
  type PressableProps,
  type StyleProp,
  type ViewStyle,
} from 'react-native';
import { useTheme } from '../theme/ThemeProvider';

const AnimatedPressable = Animated.createAnimatedComponent(Pressable);

export type MotionPressableProps = Omit<PressableProps, 'style'> & Readonly<{
  style?: StyleProp<ViewStyle>;
  pressedStyle?: StyleProp<ViewStyle>;
  children: React.ReactNode;
  feedback?: 'press' | 'quiet' | 'none';
}>;

/**
 * Shared interruptible press feedback. It only animates compositor-safe
 * properties and keeps hit targets/layout owned by the caller.
 */
export function MotionPressable({
  style,
  pressedStyle,
  children,
  feedback = 'press',
  disabled,
  onPressIn,
  onPressOut,
  ...rest
}: MotionPressableProps) {
  const { appearance, reduceMotion } = useTheme();
  const progress = useRef(new Animated.Value(0)).current;
  const [pressed, setPressed] = useState(false);

  const animateTo = useCallback((value: 0 | 1) => {
    progress.stopAnimation();
    if (feedback === 'none' || reduceMotion) {
      progress.setValue(value);
      return;
    }
    if (appearance.motionStyle === 'spring' && value === 0) {
      Animated.spring(progress, {
        toValue: 0,
        mass: 0.58,
        stiffness: 250,
        damping: 15,
        restDisplacementThreshold: 0.001,
        restSpeedThreshold: 0.001,
        overshootClamping: false,
        useNativeDriver: true,
      }).start();
      return;
    }
    const base = value === 1 ? appearance.pressInMs : appearance.pressOutMs;
    Animated.timing(progress, {
      toValue: value,
      duration: Math.round(base),
      easing: value === 1
        ? Easing.out(appearance.motionStyle === 'luminous' ? Easing.cubic : Easing.quad)
        : Easing.out(Easing.cubic),
      useNativeDriver: true,
    }).start();
  }, [appearance, feedback, progress, reduceMotion]);

  const pressedOpacity = feedback === 'quiet'
    ? Math.max(0.9, appearance.pressOpacity)
    : appearance.pressOpacity;
  const pressScale = appearance.motionStyle === 'spring'
    ? progress.interpolate({
      inputRange: [-0.08, 0, 1],
      outputRange: [1.025, 1, appearance.pressScale],
      extrapolate: 'clamp',
    })
    : progress.interpolate({
      inputRange: [0, 1],
      outputRange: [1, appearance.pressScale],
      extrapolate: 'clamp',
    });
  const pressOffset = appearance.motionStyle === 'lift'
    ? progress.interpolate({ inputRange: [0, 1], outputRange: [0, 1.5] })
    : appearance.motionStyle === 'luminous'
      ? progress.interpolate({ inputRange: [0, 1], outputRange: [0, 0.5] })
      : 0;

  return (
    <AnimatedPressable
      {...rest}
      disabled={disabled}
      onPressIn={event => {
        setPressed(true);
        animateTo(1);
        onPressIn?.(event);
      }}
      onPressOut={event => {
        setPressed(false);
        animateTo(0);
        onPressOut?.(event);
      }}
      style={[
        style,
        pressed && pressedStyle,
        feedback !== 'none' && {
          opacity: progress.interpolate({
            inputRange: [0, 1],
            outputRange: [1, pressedOpacity],
            extrapolate: 'clamp',
          }),
          transform: reduceMotion || feedback === 'quiet'
            ? undefined
            : [
              { scale: pressScale },
              { translateY: pressOffset },
            ],
        },
        disabled && { opacity: 0.45 },
      ]}
    >
      {children}
    </AnimatedPressable>
  );
}
