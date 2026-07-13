import React, { useState } from 'react';
import { View, Text, TouchableOpacity, StyleSheet, useWindowDimensions } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import Svg, { Path, Rect } from 'react-native-svg';
import { Colors as C } from '../theme/colors';
import { VoiceInputModal } from './VoiceInputModal';

const BAR_H  = 76;   // flat section height
const CR     = 24;   // top corner radius
const NR     = 46;   // notch radius — wider notch makes the concave shape visible
const MIC_D  = 70;   // mic button diameter
const MIC_R  = MIC_D / 2;
const MIC_ICON = 29;
const MIN_BOTTOM_FILL = 20;
const CONTENT_GAP = 16;
const FLOATING_OVERLAY_GAP = 12;
const TOP_CLEARANCE = MIC_R + CONTENT_GAP;

export const BOTTOM_TAB_BAR_GEOMETRY = Object.freeze({
  barHeight: BAR_H,
  cornerRadius: CR,
  notchRadius: NR,
  micDiameter: MIC_D,
  micRadius: MIC_R,
  minimumBottomFill: MIN_BOTTOM_FILL,
  scrollContentClearance: TOP_CLEARANCE,
  floatingOverlayGap: FLOATING_OVERLAY_GAP,
});

export function getBottomTabBarFloatingTopInset(safeAreaBottom: number): number {
  return BAR_H + Math.max(safeAreaBottom, MIN_BOTTOM_FILL) + MIC_R;
}

/**
 * SVG path that draws the "凹" (concave) bar shape:
 * flat left section → curved down notch in center → flat right section
 * Coordinate origin is top-left; y increases downward.
 */
function makePath(w: number): string {
  const h  = BAR_H;
  const r  = CR;
  const nr = NR;
  const centerX = w / 2;
  return [
    `M 0 ${h}`,
    `L 0 ${r}`,
    `Q 0 0 ${r} 0`,
    `L ${centerX - nr} 0`,
    // Counter-clockwise arc → curves DOWNWARD creating the concave notch
    `A ${nr} ${nr} 0 0 0 ${centerX + nr} 0`,
    `L ${w - r} 0`,
    `Q ${w} 0 ${w} ${r}`,
    `L ${w} ${h}`,
    `Z`,
  ].join(' ');
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

const MIC_META = {
  schedule: {
    colors: [C.gradFrom, C.gradTo] as const,
    shadowColor: '#6A38B2',
    label: '说出日程',
    icon: 'mic' as const,
  },
  meeting: {
    colors: [C.teal, C.blue] as const,
    shadowColor: '#278DBF',
    label: '记录会议',
    icon: 'mic' as const,
  },
  recording: {
    colors: ['#FF6B6D', '#D9363E'] as const,
    shadowColor: '#D9363E',
    label: '结束录音',
    icon: 'stop' as const,
  },
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
  const { width } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const [voiceVisible, setVoiceVisible] = useState(false);
  const bottomFill = Math.max(insets.bottom, MIN_BOTTOM_FILL);
  const centerX = width / 2;
  const path = makePath(width);
  const openMic = onMic ?? (() => setVoiceVisible(true));
  const resolvedTone = micTone ?? (active === 'meetings' ? 'meeting' : 'schedule');
  const micMeta = MIC_META[resolvedTone];
  const resolvedLabel = micLabel ?? micMeta.label;
  const resolvedIcon = micIcon ?? micMeta.icon;

  return (
    <View style={s.outer} testID="bottom-tab-bar">
      {/* SVG bar + white safe-area fill */}
      <View
        style={{
          shadowColor: '#6432B4',
          shadowOffset: { width: 0, height: -4 },
          shadowOpacity: 0.10,
          shadowRadius: 16,
          elevation: 12,
          backgroundColor: 'transparent',
        }}
      >
        <Svg width={width} height={BAR_H} style={{ display: 'flex' }}>
          {/* App background fill — makes the concave notch show the correct bg color */}
          <Rect x="0" y="0" width={width} height={BAR_H} fill={C.appBg} />
          <Path d={path} fill="#FFFFFF" />
        </Svg>
        <View style={{ height: bottomFill, backgroundColor: '#FFFFFF', width }} />
      </View>

      {/* Tab row — sits over the flat sections of the bar */}
      <View
        testID="bottom-tab-row"
        style={[s.tabRow, { height: BAR_H, top: TOP_CLEARANCE }]}
      >
        <TouchableOpacity
          style={s.tab}
          onPress={onSchedule}
          activeOpacity={0.7}
          testID="bottom-tab-schedule"
          accessibilityRole="tab"
          accessibilityLabel="日程"
          accessibilityState={{ selected: active === 'schedule' }}
        >
          <Ionicons
            name="calendar-outline" size={22}
            color={active === 'schedule' ? C.purple : C.faint}
          />
          <Text style={[s.label, { color: active === 'schedule' ? C.purple : C.faint }]}>
            日程
          </Text>
        </TouchableOpacity>

        {/* Gap matches the notch width */}
        <View style={{ width: NR * 2 }} />

        <TouchableOpacity
          style={s.tab}
          onPress={onMeetings}
          activeOpacity={0.7}
          testID="bottom-tab-meetings"
          accessibilityRole="tab"
          accessibilityLabel="会议"
          accessibilityState={{ selected: active === 'meetings' }}
        >
          <Ionicons
            name="people-outline" size={22}
            color={active === 'meetings' ? C.purple : C.faint}
          />
          <Text style={[s.label, { color: active === 'meetings' ? C.purple : C.faint }]}>
            会议
          </Text>
        </TouchableOpacity>
      </View>

      {/* Mic button — centered, half above / half in the notch */}
      <View
        testID="bottom-microphone-wrap"
        style={[s.micWrap, { left: centerX - MIC_R, top: CONTENT_GAP }]}
      >
        <TouchableOpacity
          onPress={openMic}
          activeOpacity={0.85}
          testID={`bottom-microphone-${resolvedTone}`}
          accessibilityRole="button"
          accessibilityLabel={resolvedLabel}
        >
          <LinearGradient
            colors={micMeta.colors}
            start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }}
            style={[s.mic, { shadowColor: micMeta.shadowColor }]}
          >
            <Ionicons name={resolvedIcon} size={MIC_ICON} color="#fff" />
            <Text style={s.micLabel} numberOfLines={1}>{resolvedLabel}</Text>
          </LinearGradient>
        </TouchableOpacity>
      </View>

      {!onMic && (
        <VoiceInputModal
          visible={voiceVisible}
          onClose={() => setVoiceVisible(false)}
          onSaved={() => setVoiceVisible(false)}
        />
      )}
    </View>
  );
}

const s = StyleSheet.create({
  // Reserve the microphone's protruding footprint in layout so scrollable
  // controls cannot render underneath it on short screens.
  outer: { position: 'relative', paddingTop: TOP_CLEARANCE },
  tabRow: {
    position: 'absolute', left: 0, right: 0,
    flexDirection: 'row', alignItems: 'center',
  },
  tab: { flex: 1, alignItems: 'center', gap: 4 },
  label: { fontSize: 11, fontWeight: '500' },
  micWrap: {
    position: 'absolute',
    zIndex: 10,
  },
  mic: {
    width: MIC_D, height: MIC_D, borderRadius: MIC_R,
    alignItems: 'center', justifyContent: 'center',
    gap: 1,
    shadowOffset: { width: 0, height: 6 },
    shadowOpacity: 0.55, shadowRadius: 12, elevation: 12,
  },
  micLabel: { color: '#fff', fontSize: 9, lineHeight: 11, fontWeight: '700', letterSpacing: 0 },
});
