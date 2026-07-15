import React from 'react';
import { Image, View, Text, StyleSheet, TouchableOpacity, type LayoutChangeEvent } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import Svg, { Circle, Path } from 'react-native-svg';
import { Colors as C } from '../theme/colors';
import { UserProfile } from '../services/profile';

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
              backgroundColor: visibleSplitAt !== undefined && index < visibleSplitAt ? C.primaryHover : color,
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
        <Circle cx="50" cy="36" r="18" fill="#A6ABB2" />
        <Path
          d="M20 86c4-22 18-34 30-34s26 12 30 34c-8 6-18 9-30 9s-22-3-30-9z"
          fill="#A6ABB2"
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
export const BACK_HEADER_GEOMETRY = {
  height: 44,
  backTargetWidth: 54,
  backIconSize: 24,
  titleInset: 62,
  titleSize: 18,
  rightTargetWidth: 48,
} as const;

export function BackHeader({ title, onBack, right }: {
  title: string; onBack: () => void; right?: React.ReactNode;
}) {
  return (
    <View style={styles.backHeader} testID="app-back-header">
      <TouchableOpacity
        style={styles.backSide}
        onPress={onBack}
        hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
        accessibilityRole="button"
        accessibilityLabel="返回"
      >
        <Ionicons
          name="chevron-back"
          size={BACK_HEADER_GEOMETRY.backIconSize}
          color={C.text}
          testID="app-back-icon"
        />
      </TouchableOpacity>
      <Text style={styles.backTitle} numberOfLines={1} testID="app-back-title">{title}</Text>
      <View style={styles.backRight} testID="app-back-right">{right}</View>
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
    borderWidth: 1,
    borderColor: '#fff',
    backgroundColor: '#E5E6E8',
  },
  avatarImage: {
    borderWidth: 1,
    borderColor: '#fff',
    backgroundColor: C.primaryLight,
  },
  tag: { borderRadius: 6, paddingHorizontal: 9, paddingVertical: 3 },
  tagText: { fontSize: 12, fontWeight: '600' },
  backHeader: {
    height: BACK_HEADER_GEOMETRY.height,
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: C.body,
  },
  backSide: {
    width: BACK_HEADER_GEOMETRY.backTargetWidth,
    height: BACK_HEADER_GEOMETRY.height,
    alignItems: 'center',
    justifyContent: 'center',
  },
  backTitle: {
    position: 'absolute',
    left: BACK_HEADER_GEOMETRY.titleInset,
    right: BACK_HEADER_GEOMETRY.titleInset,
    fontSize: BACK_HEADER_GEOMETRY.titleSize,
    lineHeight: 25,
    fontWeight: '400',
    color: C.text,
    textAlign: 'center',
  },
  backRight: {
    width: BACK_HEADER_GEOMETRY.rightTargetWidth,
    height: BACK_HEADER_GEOMETRY.height,
    marginLeft: 'auto',
    alignItems: 'center',
    justifyContent: 'center',
  },
});
