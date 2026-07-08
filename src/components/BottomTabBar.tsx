import React, { useState } from 'react';
import { View, Text, TouchableOpacity, StyleSheet, Dimensions } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import Svg, { Path, Rect, Defs, Filter, FeDropShadow } from 'react-native-svg';
import { Colors as C } from '../theme/colors';
import { VoiceInputModal } from './VoiceInputModal';

const { width: W } = Dimensions.get('window');

const BAR_H  = 76;   // flat section height
const CR     = 24;   // top corner radius
const NR     = 46;   // notch radius — wider notch makes the concave shape visible
const MIC_D  = 58;   // mic button diameter
const MIC_R  = MIC_D / 2;
const cx     = W / 2;

/**
 * SVG path that draws the "凹" (concave) bar shape:
 * flat left section → curved down notch in center → flat right section
 * Coordinate origin is top-left; y increases downward.
 */
function makePath(w: number): string {
  const h  = BAR_H;
  const r  = CR;
  const nr = NR;
  return [
    `M 0 ${h}`,
    `L 0 ${r}`,
    `Q 0 0 ${r} 0`,
    `L ${cx - nr} 0`,
    // Counter-clockwise arc → curves DOWNWARD creating the concave notch
    `A ${nr} ${nr} 0 0 0 ${cx + nr} 0`,
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
}

export function BottomTabBar({ active, onSchedule, onMeetings, onMic }: Props) {
  const insets = useSafeAreaInsets();
  const [voiceVisible, setVoiceVisible] = useState(false);
  const bottomFill = Math.max(insets.bottom, 20);
  const path = makePath(W);
  const openMic = onMic ?? (() => setVoiceVisible(true));

  return (
    <View style={s.outer}>
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
        <Svg width={W} height={BAR_H} style={{ display: 'flex' }}>
          {/* App background fill — makes the concave notch show the correct bg color */}
          <Rect x="0" y="0" width={W} height={BAR_H} fill={C.appBg} />
          <Path d={path} fill="#FFFFFF" />
        </Svg>
        <View style={{ height: bottomFill, backgroundColor: '#FFFFFF', width: W }} />
      </View>

      {/* Tab row — sits over the flat sections of the bar */}
      <View style={[s.tabRow, { height: BAR_H }]}>
        <TouchableOpacity style={s.tab} onPress={onSchedule} activeOpacity={0.7}>
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

        <TouchableOpacity style={s.tab} onPress={onMeetings} activeOpacity={0.7}>
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
      <View style={[s.micWrap, { left: cx - MIC_R, top: -(MIC_R) }]}>
        <TouchableOpacity onPress={openMic} activeOpacity={0.85}>
          <LinearGradient
            colors={[C.gradFrom, C.gradTo]}
            start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }}
            style={s.mic}
          >
            <Ionicons name="mic" size={24} color="#fff" />
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
  outer: { position: 'relative' },
  tabRow: {
    position: 'absolute', top: 0, left: 0, right: 0,
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
    shadowColor: '#6A38B2', shadowOffset: { width: 0, height: 6 },
    shadowOpacity: 0.55, shadowRadius: 12, elevation: 12,
  },
});
