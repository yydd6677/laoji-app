import React from 'react';
import { Animated, Easing, StyleSheet, Text, View } from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';
import { LinearGradient } from 'expo-linear-gradient';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Appearance, Colors as C, Motion } from '../theme/colors';
import { MotionPressable } from './MotionPressable';

const BAR_H = 65;
const ACTION_D = 48;
const ACTION_R = ACTION_D / 2;
const MIN_BOTTOM_FILL = 8;
const ACTION_BOTTOM_GAP = 12;
const FLOATING_OVERLAY_GAP = 12;
const TAB_ICON_SIZE = 22;
const TAB_ICON_CONTAINER_W = TAB_ICON_SIZE + 16;
const TAB_ICON_CONTAINER_H = TAB_ICON_SIZE + 8;
const TAB_ICON_TOP = 9;
const TAB_LABEL_GAP = 5;
const TAB_LABEL_SIZE = 12;
const TAB_LABEL_LINE_HEIGHT = 17;
const TAB_PRESS_SCALE = Appearance.pressScale;
const TAB_PRESS_HALF_DURATION = Motion.pressIn;

export const BOTTOM_TAB_BAR_GEOMETRY = Object.freeze({
  barHeight: BAR_H,
  cornerRadius: 0,
  notchRadius: 0,
  micDiameter: ACTION_D,
  micRadius: ACTION_R,
  minimumBottomFill: MIN_BOTTOM_FILL,
  sceneActionBottom: ACTION_BOTTOM_GAP,
  sceneContentClearance: ACTION_D + ACTION_BOTTOM_GAP + FLOATING_OVERLAY_GAP,
  floatingOverlayGap: FLOATING_OVERLAY_GAP,
  tabIconSize: TAB_ICON_SIZE,
  tabIconContainerWidth: TAB_ICON_CONTAINER_W,
  tabIconContainerHeight: TAB_ICON_CONTAINER_H,
  tabIconTop: TAB_ICON_TOP,
  tabLabelGap: TAB_LABEL_GAP,
  tabLabelSize: TAB_LABEL_SIZE,
  tabLabelLineHeight: TAB_LABEL_LINE_HEIGHT,
  tabPressScale: TAB_PRESS_SCALE,
  tabPressHalfDuration: TAB_PRESS_HALF_DURATION,
});

export function getBottomTabBarFloatingTopInset(safeAreaBottom: number): number {
  return BAR_H + Math.max(safeAreaBottom, MIN_BOTTOM_FILL) + ACTION_BOTTOM_GAP;
}

interface Props {
  active: 'schedule' | 'meetings';
  onSchedule: () => void;
  onMeetings: () => void;
  onMic?: () => void;
  micTone?: 'schedule' | 'meeting' | 'recording';
  micLabel?: string;
  micIcon?: React.ComponentProps<typeof Ionicons>['name'];
}

const ACTION_META = {
  schedule: { label: '新建日程', icon: 'add' as const, color: C.primary },
  meeting: { label: '记录会议', icon: 'mic' as const, color: C.primary },
  recording: { label: '结束录音', icon: 'stop' as const, color: C.red },
};

export function BottomTabBar({
  active,
  onSchedule,
  onMeetings,
  onMic,
  micTone,
  micLabel,
  micIcon,
}: Props) {
  const insets = useSafeAreaInsets();
  const bottomFill = Math.max(insets.bottom, MIN_BOTTOM_FILL);
  const tone = micTone ?? (active === 'meetings' ? 'meeting' : 'schedule');
  const action = ACTION_META[tone];

  return (
    <View
      style={[
        s.outer,
        Appearance.bottomBarRadius > 0 && {
          borderTopLeftRadius: Appearance.bottomBarRadius,
          borderTopRightRadius: Appearance.bottomBarRadius,
          borderLeftWidth: Appearance.borderWidth,
          borderRightWidth: Appearance.borderWidth,
          borderColor: C.border,
        },
        { paddingBottom: bottomFill },
      ]}
      testID="bottom-tab-bar"
    >
      <View testID="bottom-tab-row" style={s.tabRow}>
        <TabButton
          label="日程"
          icon={active === 'schedule' ? 'calendar' : 'calendar-outline'}
          selected={active === 'schedule'}
          onPress={onSchedule}
          testID="bottom-tab-schedule"
        />
        <TabButton
          label="会议"
          icon={active === 'meetings' ? 'people' : 'people-outline'}
          selected={active === 'meetings'}
          onPress={onMeetings}
          testID="bottom-tab-meetings"
        />
      </View>

      {onMic ? (
        <MotionPressable
          style={[
            s.action,
            {
              backgroundColor: action.color,
              borderRadius: Appearance.primaryActionRadius,
              borderColor: C.border,
              borderWidth: Appearance.surfaceMode === 'layered' ? 1 : 0,
            },
          ]}
          pressedStyle={{ backgroundColor: tone === 'recording' ? C.red : C.primaryPressed }}
          onPress={onMic}
          testID={`bottom-microphone-${tone}`}
          accessibilityRole="button"
          accessibilityLabel={micLabel ?? action.label}
        >
          {tone !== 'recording' && (Appearance.surfaceMode === 'soft' || Appearance.surfaceMode === 'layered') ? (
            <LinearGradient
              colors={[C.gradFrom, C.gradTo]}
              start={{ x: 0, y: 0 }}
              end={{ x: 1, y: 1 }}
              style={[StyleSheet.absoluteFill, { borderRadius: Appearance.primaryActionRadius }]}
            />
          ) : null}
          <Ionicons name={micIcon ?? action.icon} size={24} color="#FFFFFF" />
        </MotionPressable>
      ) : null}
    </View>
  );
}

function TabButton({
  label,
  icon,
  selected,
  onPress,
  testID,
}: {
  label: string;
  icon: React.ComponentProps<typeof Ionicons>['name'];
  selected: boolean;
  onPress: () => void;
  testID: string;
}) {
  const selection = React.useRef(new Animated.Value(selected ? 1 : 0)).current;
  React.useEffect(() => {
    selection.stopAnimation();
    Animated.timing(selection, {
      toValue: selected ? 1 : 0,
      duration: Math.round(Motion.select * Appearance.motionScale),
      easing: Easing.out(Easing.cubic),
      useNativeDriver: true,
    }).start();
  }, [selected, selection]);

  return (
    <MotionPressable
      style={s.tab}
      onPress={onPress}
      feedback="quiet"
      testID={testID}
      accessibilityRole="tab"
      accessibilityLabel={label}
      accessibilityState={{ selected }}
    >
      <Animated.View
        testID={`${testID}-icon-box`}
        style={[
          s.iconBox,
          {
            borderRadius: Appearance.iconRadius,
            backgroundColor: C.primaryLight,
            opacity: selection.interpolate({ inputRange: [0, 1], outputRange: [0, 1] }),
            transform: [{
              scaleX: selection.interpolate({ inputRange: [0, 1], outputRange: [0.72, 1] }),
            }],
          },
        ]}
      >
      </Animated.View>
      <View style={s.iconGlyph} pointerEvents="none">
        <Ionicons name={icon} size={TAB_ICON_SIZE} color={selected ? C.primary : C.faint} />
      </View>
      <Text testID={`${testID}-label`} style={[s.label, selected && s.labelSelected]}>{label}</Text>
    </MotionPressable>
  );
}

const s = StyleSheet.create({
  outer: {
    position: 'relative',
    backgroundColor: C.card,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: C.border,
  },
  tabRow: {
    height: BAR_H,
    flexDirection: 'row',
    alignItems: 'center',
  },
  tab: {
    flex: 1,
    height: BAR_H,
    alignItems: 'center',
    justifyContent: 'flex-start',
  },
  iconBox: {
    position: 'absolute',
    width: 44,
    height: 30,
    marginTop: TAB_ICON_TOP,
    alignItems: 'center',
    justifyContent: 'flex-end',
  },
  iconGlyph: {
    width: TAB_ICON_CONTAINER_W,
    height: TAB_ICON_CONTAINER_H,
    marginTop: TAB_ICON_TOP,
    alignItems: 'center',
    justifyContent: 'flex-end',
  },
  label: {
    marginTop: TAB_LABEL_GAP,
    fontSize: TAB_LABEL_SIZE,
    lineHeight: TAB_LABEL_LINE_HEIGHT,
    fontWeight: '400',
    color: C.faint,
  },
  labelSelected: {
    color: C.primary,
    fontWeight: '600',
  },
  action: {
    position: 'absolute',
    right: 16,
    top: -(ACTION_D + ACTION_BOTTOM_GAP),
    width: ACTION_D,
    height: ACTION_D,
    alignItems: 'center',
    justifyContent: 'center',
    shadowColor: '#000000',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: Appearance.shadowOpacity,
    shadowRadius: 8,
    elevation: 6,
    overflow: 'hidden',
  },
});
