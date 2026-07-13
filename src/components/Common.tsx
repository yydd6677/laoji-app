import React from 'react';
import { Image, View, Text, StyleSheet, TouchableOpacity, type LayoutChangeEvent } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import Svg, { Circle, Path } from 'react-native-svg';
import { Colors as C } from '../theme/colors';
import { UserProfile } from '../services/profile';

// ─── Sparkle ─────────────────────────────────────────────────────────────────
export function Sparkle({ size, color }: { size: number; color: string }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 20 20">
      <Path d="M10 0 L11.8 8.2 L20 10 L11.8 11.8 L10 20 L8.2 11.8 L0 10 L8.2 8.2 Z" fill={color} />
    </Svg>
  );
}

// ─── Waveform ─────────────────────────────────────────────────────────────────
const WAVEFORM_BAR_WIDTH = 3;
const WAVEFORM_BAR_GAP = 2;

export function waveformBarCapacity(availableWidth: number): number {
  if (availableWidth <= 0) return 0;
  return Math.max(1, Math.floor(
    (availableWidth + WAVEFORM_BAR_GAP) / (WAVEFORM_BAR_WIDTH + WAVEFORM_BAR_GAP),
  ));
}

export function resampleWaveformBars(bars: number[], targetCount: number): number[] {
  if (targetCount <= 0 || bars.length === 0) return [];
  if (bars.length <= targetCount) return bars;

  return Array.from({ length: targetCount }, (_, index) => {
    const start = Math.floor((index * bars.length) / targetCount);
    const end = Math.max(start + 1, Math.floor(((index + 1) * bars.length) / targetCount));
    let peak = bars[start] ?? 0;
    for (let sourceIndex = start + 1; sourceIndex < end; sourceIndex += 1) {
      peak = Math.max(peak, bars[sourceIndex] ?? 0);
    }
    return peak;
  });
}

export function Waveform({ bars, color, height = 28, splitAt }: {
  bars: number[]; color: string; height?: number; splitAt?: number;
}) {
  const [availableWidth, setAvailableWidth] = React.useState<number | null>(null);
  const visibleBars = React.useMemo(() => {
    if (availableWidth === null) return bars;
    return resampleWaveformBars(bars, waveformBarCapacity(availableWidth));
  }, [availableWidth, bars]);
  const visibleSplitAt = React.useMemo(() => {
    if (splitAt === undefined || bars.length === 0) return undefined;
    const ratio = Math.min(1, Math.max(0, splitAt / bars.length));
    return Math.round(ratio * visibleBars.length);
  }, [bars.length, splitAt, visibleBars.length]);
  const max = visibleBars.reduce((peak, value) => Math.max(peak, value), 0.0001);
  const handleLayout = (event: LayoutChangeEvent) => {
    const nextWidth = Math.max(0, Math.floor(event.nativeEvent.layout.width));
    setAvailableWidth(currentWidth => currentWidth === nextWidth ? currentWidth : nextWidth);
  };

  return (
    <View
      style={[styles.waveform, { height }]}
      onLayout={handleLayout}
      testID="waveform"
    >
      {visibleBars.map((value, index) => (
        <View
          key={index}
          testID="waveform-bar"
          style={[
            styles.waveformBar,
            {
              height: Math.max(2, (value / max) * height),
              backgroundColor: visibleSplitAt !== undefined && index < visibleSplitAt ? '#4A90D9' : color,
            },
          ]}
        />
      ))}
    </View>
  );
}

// ─── Avatar ──────────────────────────────────────────────────────────────────
export function Avatar({ size = 36, profile, initial, colors }: {
  size?: number;
  profile?: UserProfile;
  initial?: string;
  colors?: [string, string];
}) {
  void initial;
  void colors;
  const imageUri = profile?.avatarUrl || profile?.avatarLocalUri;
  const [failedUri, setFailedUri] = React.useState<string | null>(null);
  React.useEffect(() => setFailedUri(null), [imageUri]);
  if (imageUri && failedUri !== imageUri) {
    return (
      <Image
        source={{ uri: imageUri }}
        style={[styles.avatarImage, { width: size, height: size, borderRadius: size / 2 }]}
        onError={() => setFailedUri(imageUri)}
      />
    );
  }
  return <NeutralAvatar size={size} />;
}

function NeutralAvatar({ size }: { size: number }) {
  return (
    <View style={[styles.neutralAvatar, { width: size, height: size, borderRadius: size / 2 }]}>
      <Svg width={size * 0.72} height={size * 0.72} viewBox="0 0 100 100">
        <Circle cx="50" cy="36" r="18" fill="#B8B4D4" />
        <Path
          d="M20 86c4-22 18-34 30-34s26 12 30 34c-8 6-18 9-30 9s-22-3-30-9z"
          fill="#B8B4D4"
        />
      </Svg>
    </View>
  );
}

// ─── Tag ──────────────────────────────────────────────────────────────────────
export function Tag({ label, color }: { label: string; color: string }) {
  return (
    <View style={[styles.tag, { backgroundColor: color + '1A' }]}>
      <Text style={[styles.tagText, { color }]}>{label}</Text>
    </View>
  );
}

// ─── BackHeader ──────────────────────────────────────────────────────────────
export function BackHeader({ title, onBack, right }: {
  title: string; onBack: () => void; right?: React.ReactNode;
}) {
  return (
    <View style={styles.backHeader}>
      <TouchableOpacity
        style={styles.backSide}
        onPress={onBack}
        hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
        accessibilityRole="button"
        accessibilityLabel="返回"
      >
        <Ionicons name="chevron-back" size={22} color={C.sub} />
      </TouchableOpacity>
      <Text style={styles.backTitle} numberOfLines={1}>{title}</Text>
      <View style={[styles.backSide, styles.backRight]}>{right}</View>
    </View>
  );
}

const styles = StyleSheet.create({
  waveform: {
    width: '100%',
    maxWidth: '100%',
    minWidth: 0,
    flexDirection: 'row',
    alignItems: 'center',
    gap: WAVEFORM_BAR_GAP,
    overflow: 'hidden',
  },
  waveformBar: {
    width: WAVEFORM_BAR_WIDTH,
    borderRadius: 2,
    opacity: 0.85,
  },
  neutralAvatar: {
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 2,
    borderColor: '#fff',
    backgroundColor: '#ECE8F4',
    shadowColor: 'rgba(180,100,220,0.18)',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 1,
    shadowRadius: 10,
    elevation: 4,
  },
  avatarImage: {
    borderWidth: 2,
    borderColor: '#fff',
    backgroundColor: C.purpleLight,
    shadowColor: 'rgba(180,100,220,0.25)',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 1,
    shadowRadius: 10,
    elevation: 4,
  },
  tag: { borderRadius: 6, paddingHorizontal: 9, paddingVertical: 3 },
  tagText: { fontSize: 12, fontWeight: '600' },
  backHeader: {
    height: 52, flexDirection: 'row', alignItems: 'center',
    justifyContent: 'space-between', paddingHorizontal: 16,
    backgroundColor: C.card, borderBottomWidth: 1, borderBottomColor: C.border,
  },
  backSide: { width: 64, minHeight: 40, justifyContent: 'center' },
  backChevron: { fontSize: 28, color: C.sub, fontWeight: '200', lineHeight: 34 },
  backTitle: { flex: 1, fontSize: 16, fontWeight: '700', color: C.text, textAlign: 'center' },
  backRight: { alignItems: 'flex-end' },
});
