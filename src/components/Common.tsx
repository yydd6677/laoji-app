import React from 'react';
import { Image, View, Text, StyleSheet, TouchableOpacity } from 'react-native';
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
export function Waveform({ bars, color, height = 28, splitAt }: {
  bars: number[]; color: string; height?: number; splitAt?: number;
}) {
  const max = Math.max(...bars);
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 2, height }}>
      {bars.map((v, i) => (
        <View key={i} style={{
          width: 3, borderRadius: 2,
          height: Math.max(2, (v / max) * height),
          backgroundColor: splitAt !== undefined && i < splitAt ? '#4A90D9' : color,
          opacity: 0.85,
        }} />
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
  if (imageUri) {
    return (
      <Image
        source={{ uri: imageUri }}
        style={[styles.avatarImage, { width: size, height: size, borderRadius: size / 2 }]}
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
      <TouchableOpacity onPress={onBack} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
        <Ionicons name="chevron-back" size={22} color={C.sub} />
      </TouchableOpacity>
      <Text style={styles.backTitle}>{title}</Text>
      <View style={styles.backRight}>{right}</View>
    </View>
  );
}

const styles = StyleSheet.create({
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
  backChevron: { fontSize: 28, color: C.sub, fontWeight: '200', lineHeight: 34 },
  backTitle: { fontSize: 16, fontWeight: '700', color: C.text },
  backRight: { minWidth: 36, alignItems: 'flex-end' },
});
