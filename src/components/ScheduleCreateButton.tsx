import React, { useEffect, useRef, useState } from 'react';
import {
  Animated,
  GestureResponderEvent,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';
import { Colors as C, Motion, withAlpha } from '../theme/colors';

type CreateTarget = 'voice' | 'manual';

const BUTTON_SIZE = 48;
const OPTION_SIZE = 64;
const ARC_RADIUS = 132;
const CLUSTER_SIZE = 268;
const LONG_PRESS_DELAY = 350;
const TARGET_HIT_RADIUS = 42;
const PRESSED_TRANSLATE_Y = 1;
const REST_ELEVATION = 6;
const PRESSED_ELEVATION = 3;
const OPEN_ROTATION = 45;
const HOVER_SCALE = 1.12;

const TARGET_OFFSETS: Record<CreateTarget, { x: number; y: number }> = {
  voice: { x: -110, y: -72 },
  manual: { x: -44, y: -126 },
};

export const SCHEDULE_CREATE_GEOMETRY = Object.freeze({
  buttonSize: BUTTON_SIZE,
  optionSize: OPTION_SIZE,
  arcRadius: ARC_RADIUS,
  clusterSize: CLUSTER_SIZE,
  longPressDelay: LONG_PRESS_DELAY,
  targetHitRadius: TARGET_HIT_RADIUS,
  pressedTranslateY: PRESSED_TRANSLATE_Y,
  restElevation: REST_ELEVATION,
  pressedElevation: PRESSED_ELEVATION,
  openRotation: OPEN_ROTATION,
  hoverScale: HOVER_SCALE,
  targetOffsets: TARGET_OFFSETS,
});

export function scheduleCreateTargetAt(
  center: { x: number; y: number },
  point: { x: number; y: number },
): CreateTarget | null {
  const targets = (Object.keys(TARGET_OFFSETS) as CreateTarget[]).map(target => {
    const offset = TARGET_OFFSETS[target];
    return {
      target,
      distance: Math.hypot(
        point.x - (center.x + offset.x),
        point.y - (center.y + offset.y),
      ),
    };
  });
  const nearest = targets.sort((a, b) => a.distance - b.distance)[0];
  return nearest && nearest.distance <= TARGET_HIT_RADIUS ? nearest.target : null;
}

function touchPoint(event: GestureResponderEvent) {
  return { x: event.nativeEvent.pageX, y: event.nativeEvent.pageY };
}

function buttonCenter(event: GestureResponderEvent) {
  const { pageX, pageY, locationX, locationY } = event.nativeEvent;
  return {
    x: pageX + BUTTON_SIZE / 2 - locationX,
    y: pageY + BUTTON_SIZE / 2 - locationY,
  };
}

export function ScheduleCreateButton({
  bottom,
  onPress,
  onVoice,
  onManual,
}: {
  bottom: number;
  onPress: () => void;
  onVoice: () => void;
  onManual: () => void;
}) {
  const progress = useRef(new Animated.Value(0)).current;
  const centerRef = useRef({ x: 0, y: 0 });
  const radialActiveRef = useRef(false);
  const consumedLongPressRef = useRef(false);
  const transitionRef = useRef(0);
  const [mounted, setMounted] = useState(false);
  const [radialOpen, setRadialOpen] = useState(false);
  const [hovered, setHovered] = useState<CreateTarget | null>(null);

  useEffect(() => () => {
    transitionRef.current += 1;
    progress.stopAnimation();
  }, [progress]);

  const openRadial = (event: GestureResponderEvent) => {
    if (radialActiveRef.current) return;
    centerRef.current = buttonCenter(event);
    radialActiveRef.current = true;
    consumedLongPressRef.current = true;
    transitionRef.current += 1;
    setHovered(null);
    setMounted(true);
    setRadialOpen(true);
    progress.stopAnimation();
    progress.setValue(0);
    Animated.timing(progress, {
      toValue: 1,
      duration: Motion.standard,
      useNativeDriver: true,
    }).start();
  };

  const closeRadial = (afterExit?: () => void, preserveSelection = false) => {
    radialActiveRef.current = false;
    setRadialOpen(false);
    if (!preserveSelection) setHovered(null);
    const transition = transitionRef.current + 1;
    transitionRef.current = transition;
    progress.stopAnimation();
    Animated.timing(progress, {
      toValue: 0,
      duration: Motion.fast,
      useNativeDriver: true,
    }).start(({ finished }) => {
      if (!finished || transitionRef.current !== transition) return;
      setHovered(null);
      setMounted(false);
      afterExit?.();
    });
  };

  const moveRadial = (event: GestureResponderEvent) => {
    if (!radialActiveRef.current) return;
    const target = scheduleCreateTargetAt(centerRef.current, touchPoint(event));
    setHovered(current => current === target ? current : target);
  };

  const releaseRadial = (event: GestureResponderEvent) => {
    if (!radialActiveRef.current) return;
    const target = scheduleCreateTargetAt(centerRef.current, touchPoint(event));
    closeRadial(() => {
      if (target === 'voice') onVoice();
      if (target === 'manual') onManual();
    }, Boolean(target));
    setTimeout(() => { consumedLongPressRef.current = false; }, 0);
  };

  const handlePress = () => {
    if (consumedLongPressRef.current) {
      consumedLongPressRef.current = false;
      return;
    }
    onPress();
  };

  const optionScale = (target: CreateTarget) => (
    hovered === target
      ? HOVER_SCALE
      : progress.interpolate({ inputRange: [0, 1], outputRange: [0.72, 1] })
  );

  return (
    <View pointerEvents="box-none" style={[s.cluster, { bottom }]} testID="calendar-create-cluster">
      {mounted ? (
        <Animated.View
          pointerEvents="none"
          style={[s.radialLayer, { opacity: progress }]}
          testID="calendar-create-radial"
        >
          <View style={[s.arc, hovered && s.arcActive]} testID="calendar-create-arc" />
          <Animated.View
            style={[
              s.option,
              s.voiceOption,
              hovered === 'voice' && s.optionHovered,
              { transform: [{ scale: optionScale('voice') }] },
            ]}
            testID="calendar-create-target-voice"
          >
            <Ionicons name="mic-outline" size={26} color={hovered === 'voice' ? '#FFFFFF' : C.primary} />
            <Text style={[s.optionLabel, hovered === 'voice' && s.optionLabelHovered]}>语音</Text>
          </Animated.View>
          <Animated.View
            style={[
              s.option,
              s.manualOption,
              hovered === 'manual' && s.optionHovered,
              { transform: [{ scale: optionScale('manual') }] },
            ]}
            testID="calendar-create-target-manual"
          >
            <Ionicons name="pencil-outline" size={26} color={hovered === 'manual' ? '#FFFFFF' : C.primary} />
            <Text style={[s.optionLabel, hovered === 'manual' && s.optionLabelHovered]}>手动</Text>
          </Animated.View>
        </Animated.View>
      ) : null}

      <Pressable
        style={({ pressed }) => [s.button, (pressed || radialOpen) && s.buttonPressed]}
        onPress={handlePress}
        onLongPress={openRadial}
        onTouchMove={moveRadial}
        onPressOut={releaseRadial}
        delayLongPress={LONG_PRESS_DELAY}
        pressRetentionOffset={ARC_RADIUS + OPTION_SIZE}
        accessibilityRole="button"
        accessibilityLabel="新建日程"
        accessibilityHint="轻点选择创建方式，长按并拖动可快速选择语音或手动创建"
        accessibilityState={{ expanded: radialOpen }}
        testID="calendar-create-button"
      >
        <Animated.View style={{ transform: [{
          rotate: progress.interpolate({ inputRange: [0, 1], outputRange: ['0deg', `${OPEN_ROTATION}deg`] }),
        }] }} testID="calendar-create-icon-motion">
          <Ionicons name="add" size={28} color="#FFFFFF" />
        </Animated.View>
      </Pressable>
    </View>
  );
}

const optionPosition = (target: CreateTarget) => ({
  right: BUTTON_SIZE / 2 - OPTION_SIZE / 2 - TARGET_OFFSETS[target].x,
  bottom: BUTTON_SIZE / 2 - OPTION_SIZE / 2 - TARGET_OFFSETS[target].y,
});

const s = StyleSheet.create({
  cluster: {
    position: 'absolute',
    right: 16,
    width: CLUSTER_SIZE,
    height: CLUSTER_SIZE,
    zIndex: 30,
    elevation: 8,
  },
  radialLayer: { ...StyleSheet.absoluteFillObject },
  arc: {
    position: 'absolute',
    right: BUTTON_SIZE / 2,
    bottom: BUTTON_SIZE / 2,
    width: ARC_RADIUS,
    height: ARC_RADIUS,
    borderTopWidth: 1,
    borderLeftWidth: 1,
    borderTopLeftRadius: ARC_RADIUS,
    borderColor: withAlpha(C.primary, 0.30),
  },
  arcActive: { borderColor: C.primary },
  option: {
    position: 'absolute',
    width: OPTION_SIZE,
    height: OPTION_SIZE,
    borderRadius: OPTION_SIZE / 2,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 1,
    borderWidth: 1,
    borderColor: C.border,
    backgroundColor: C.body,
    shadowColor: '#000000',
    shadowOffset: { width: 0, height: 3 },
    shadowOpacity: 0.14,
    shadowRadius: 7,
    elevation: 5,
  },
  voiceOption: optionPosition('voice'),
  manualOption: optionPosition('manual'),
  optionHovered: {
    backgroundColor: C.primary,
    borderColor: C.primary,
    shadowOpacity: 0.18,
    shadowRadius: 8,
    elevation: 7,
  },
  optionLabel: { fontSize: 11, lineHeight: 15, fontWeight: '500', color: C.text },
  optionLabelHovered: { color: '#FFFFFF' },
  button: {
    position: 'absolute',
    right: 0,
    bottom: 0,
    width: BUTTON_SIZE,
    height: BUTTON_SIZE,
    borderRadius: BUTTON_SIZE / 2,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: C.primary,
    shadowColor: '#000000',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.18,
    shadowRadius: 8,
    elevation: REST_ELEVATION,
  },
  buttonPressed: {
    backgroundColor: C.primaryPressed,
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.14,
    shadowRadius: 4,
    elevation: PRESSED_ELEVATION,
    transform: [{ translateY: PRESSED_TRANSLATE_Y }],
  },
});
