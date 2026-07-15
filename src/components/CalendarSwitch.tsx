import React from 'react';
import { Animated, Easing, StyleSheet, TouchableOpacity, View } from 'react-native';
import { Colors as C } from '../theme/colors';

export const CALENDAR_SWITCH_GEOMETRY = {
  width: 36,
  height: 20,
  trackHeight: 14,
  trackInset: 3,
  thumbSize: 20,
  thumbTravel: 16,
} as const;

export function CalendarSwitch({
  checked,
  onChange,
  accessibilityLabel,
  accessibilityHint,
  disabled = false,
  testID,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  accessibilityLabel: string;
  accessibilityHint?: string;
  disabled?: boolean;
  testID?: string;
}) {
  const progress = React.useRef(new Animated.Value(checked ? 1 : 0)).current;

  React.useEffect(() => {
    Animated.timing(progress, {
      toValue: checked ? 1 : 0,
      duration: 120,
      easing: Easing.inOut(Easing.ease),
      useNativeDriver: true,
    }).start();
  }, [checked, progress]);

  return (
    <TouchableOpacity
      testID={testID}
      style={[
        s.control,
        disabled && s.disabled,
      ]}
      onPress={() => onChange(!checked)}
      disabled={disabled}
      activeOpacity={0.75}
      accessibilityRole="switch"
      accessibilityLabel={accessibilityLabel}
      accessibilityHint={accessibilityHint}
      accessibilityState={{ checked, disabled }}
    >
      <View
        testID={testID ? `${testID}-track` : undefined}
        style={[s.track, { backgroundColor: checked && !disabled ? C.primary : C.disabled }]}
      />
      <Animated.View
        testID={testID ? `${testID}-thumb` : undefined}
        style={[
          s.thumb,
          {
            transform: [{
              translateX: progress.interpolate({
                inputRange: [0, 1],
                outputRange: [0, CALENDAR_SWITCH_GEOMETRY.thumbTravel],
              }),
            }],
          },
        ]}
      />
    </TouchableOpacity>
  );
}

const s = StyleSheet.create({
  control: {
    width: CALENDAR_SWITCH_GEOMETRY.width,
    height: CALENDAR_SWITCH_GEOMETRY.height,
    justifyContent: 'center',
  },
  track: {
    position: 'absolute',
    left: 0,
    right: 0,
    top: CALENDAR_SWITCH_GEOMETRY.trackInset,
    height: CALENDAR_SWITCH_GEOMETRY.trackHeight,
    borderRadius: CALENDAR_SWITCH_GEOMETRY.trackHeight / 2,
  },
  disabled: { opacity: 0.45 },
  thumb: {
    position: 'absolute',
    left: 0,
    top: 0,
    width: CALENDAR_SWITCH_GEOMETRY.thumbSize,
    height: CALENDAR_SWITCH_GEOMETRY.thumbSize,
    borderRadius: CALENDAR_SWITCH_GEOMETRY.thumbSize / 2,
    backgroundColor: '#FFFFFF',
  },
});
