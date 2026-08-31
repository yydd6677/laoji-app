import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  Animated,
  BackHandler,
  Easing,
  Pressable,
  StyleSheet,
  Text,
  useWindowDimensions,
  View,
} from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { getColorsForTheme, getThemeAppearance, Motion } from '../theme/colors';
import { useTheme } from '../theme/ThemeProvider';
import { THEME_IDS, THEME_LABELS, type ThemeId } from '../theme/themeIds';
import { getThemeFontFamily } from '../theme/typography';
import { MotionPressable } from './MotionPressable';

const EDGE = 16;
const GAP = 12;
const MAX_WIDTH = 460;

export function ThemePickerSheet({
  visible,
  selected,
  onSelect,
  onClose,
}: {
  visible: boolean;
  selected: ThemeId;
  onSelect: (themeId: ThemeId) => void;
  onClose: () => void;
}) {
  const insets = useSafeAreaInsets();
  const { width } = useWindowDimensions();
  const { colors, appearance, reduceMotion } = useTheme();
  const progress = useRef(new Animated.Value(visible ? 1 : 0)).current;
  const [mounted, setMounted] = useState(visible);
  const cardWidth = useMemo(
    () => Math.floor((Math.min(width, MAX_WIDTH) - EDGE * 2 - GAP) / 2),
    [width],
  );

  useEffect(() => {
    progress.stopAnimation();
    if (visible) {
      setMounted(true);
      progress.setValue(0);
      Animated.timing(progress, {
        toValue: 1,
        duration: reduceMotion ? Motion.fast : Math.round(Motion.panel * appearance.motionScale),
        easing: Easing.out(Easing.cubic),
        useNativeDriver: true,
      }).start();
      return;
    }
    Animated.timing(progress, {
      toValue: 0,
      duration: reduceMotion ? Motion.fast : Math.round(Motion.standard * appearance.motionScale),
      easing: Easing.in(Easing.quad),
      useNativeDriver: true,
    }).start(({ finished }) => {
      if (finished) setMounted(false);
    });
  }, [appearance.motionScale, progress, reduceMotion, visible]);

  useEffect(() => {
    if (!mounted) return undefined;
    const subscription = BackHandler.addEventListener('hardwareBackPress', () => {
      onClose();
      return true;
    });
    return () => subscription.remove();
  }, [mounted, onClose]);

  if (!mounted) return null;

  return (
      <View style={s.root} accessibilityViewIsModal>
        <Animated.View style={[s.backdrop, { backgroundColor: colors.overlay, opacity: progress }]}>
          <Pressable
            style={StyleSheet.absoluteFill}
            onPress={onClose}
            accessibilityRole="button"
            accessibilityLabel="关闭主题选择"
          />
        </Animated.View>
        <Animated.View
          style={[
            s.panel,
            {
              width: Math.min(width, MAX_WIDTH),
              paddingBottom: Math.max(insets.bottom, 12) + 4,
              backgroundColor: colors.body,
              borderColor: colors.border,
              opacity: progress,
              transform: [{
                translateY: reduceMotion
                  ? 0
                  : progress.interpolate({ inputRange: [0, 1], outputRange: [28, 0] }),
              }],
            },
          ]}
          testID="theme-picker-sheet"
        >
          <View style={s.header}>
            <Text style={[s.title, { color: colors.text }]}>主题</Text>
            <MotionPressable
              style={s.close}
              pressedStyle={{ backgroundColor: colors.pressed }}
              onPress={onClose}
              accessibilityRole="button"
              accessibilityLabel="关闭"
              feedback="quiet"
              testID="theme-picker-close"
            >
              <Ionicons name="close" size={22} color={colors.sub} />
            </MotionPressable>
          </View>
          <View style={s.grid}>
            {THEME_IDS.map(themeId => (
              <ThemeOption
                key={themeId}
                themeId={themeId}
                selected={selected === themeId}
                width={cardWidth}
                onPress={() => onSelect(themeId)}
              />
            ))}
          </View>
        </Animated.View>
      </View>
  );
}

function ThemeOption({
  themeId,
  selected,
  width,
  onPress,
}: {
  themeId: ThemeId;
  selected: boolean;
  width: number;
  onPress: () => void;
}) {
  const palette = getColorsForTheme(themeId);
  const profile = getThemeAppearance(themeId);
  const fontFamily = getThemeFontFamily(themeId);
  // Android vendors do not all synthesize an unbundled CJK semibold face in
  // the same way. WenKai in particular can return an empty compact Text layout
  // on MIUI when a 600 face is requested from our regular-only subset.
  const previewFontWeight = themeId === 'paper' ? '400' : '600';
  const isDark = themeId === 'midnight';
  const isSoft = profile.surfaceMode === 'soft';
  const isEditorial = profile.surfaceMode === 'editorial';
  const isLayered = profile.surfaceMode === 'layered';
  const eventColor = isDark ? '#75A9FF' : '#5B8CFF';
  const eventFill = isDark ? '#233853' : '#EAF0FF';
  const previewSurface = profile.surfaceMode === 'flat' ? palette.body : palette.card;

  return (
    <MotionPressable
      style={[
        s.option,
        {
          width,
          borderColor: selected ? palette.primary : palette.border,
          borderWidth: selected ? 2 : 1,
          borderRadius: profile.cardRadius,
          backgroundColor: palette.appBg,
        },
      ]}
      pressedStyle={{ backgroundColor: palette.inputBg }}
      onPress={onPress}
      accessibilityRole="radio"
      accessibilityLabel={THEME_LABELS[themeId]}
      accessibilityState={{ selected }}
      testID={`theme-option-${themeId}`}
    >
      <View
        style={[
          s.preview,
          {
            backgroundColor: previewSurface,
            borderColor: palette.border,
            borderRadius: Math.max(5, profile.cardRadius - 3),
          },
        ]}
      >
        <View style={[
          s.previewHeader,
          (isSoft || isLayered) && {
            minHeight: 28,
            paddingHorizontal: 6,
            borderRadius: isSoft ? 10 : 7,
            backgroundColor: palette.inputBg,
          },
          isEditorial && {
            borderBottomWidth: StyleSheet.hairlineWidth,
            borderBottomColor: palette.divider,
          },
        ]}>
          <Text
            style={[
              s.previewMonth,
              {
                color: palette.text,
                fontFamily,
                fontWeight: previewFontWeight,
                letterSpacing: profile.titleLetterSpacing,
              },
            ]}
          >
            八月
          </Text>
          {!isEditorial ? <View style={[s.previewDot, { backgroundColor: palette.primary }]} /> : null}
        </View>
        <View style={s.previewWeek}>
          {[18, 19, 20, 21, 22].map((day, index) => (
            <View
              key={day}
              style={[
                s.previewDay,
                index === 2 && { backgroundColor: palette.primaryLight },
              ]}
            >
              <Text style={[s.previewDayText, {
                color: index === 2 ? palette.primary : palette.faint,
                fontFamily,
                fontWeight: previewFontWeight,
              }]}>{day}</Text>
            </View>
          ))}
        </View>
        <View style={[
          s.previewEvent,
          {
            backgroundColor: eventFill,
            borderColor: eventColor,
            borderRadius: isSoft ? 10 : isEditorial ? 2 : isLayered ? 7 : 5,
          },
          isEditorial && { marginTop: 10, borderWidth: StyleSheet.hairlineWidth },
        ]}>
          <View style={[s.previewEventLine, { backgroundColor: eventColor }]} />
          <View style={[s.previewEventText, { backgroundColor: eventColor }]} />
        </View>
        <View style={[
          s.previewAction,
          { backgroundColor: isEditorial ? palette.card : palette.primary },
          isSoft && { width: 26, height: 26, borderRadius: 9 },
          isEditorial && {
            width: 46,
            height: 22,
            borderRadius: 3,
            borderWidth: 1,
            borderColor: palette.primary,
          },
          isLayered && {
            width: 28,
            height: 28,
            borderRadius: 14,
            borderWidth: 1,
            borderColor: palette.primary,
            backgroundColor: palette.primaryLight,
          },
        ]}>
          {isEditorial ? (
            <Text style={{ color: palette.primary, fontFamily, fontSize: 9, lineHeight: 14 }}>新建</Text>
          ) : (
            <Ionicons name="add" size={12} color={isLayered ? palette.primary : '#FFFFFF'} />
          )}
        </View>
      </View>
      <View style={s.optionFooter}>
        <Text style={[s.optionLabel, {
          color: palette.text,
          fontFamily,
          fontWeight: previewFontWeight,
        }]}>{THEME_LABELS[themeId]}</Text>
        <View
          style={[
            s.radio,
            { borderColor: selected ? palette.primary : palette.faint },
            selected && { backgroundColor: palette.primary },
          ]}
        >
          {selected ? <Ionicons name="checkmark" size={12} color="#FFFFFF" /> : null}
        </View>
      </View>
    </MotionPressable>
  );
}

const s = StyleSheet.create({
  root: {
    ...StyleSheet.absoluteFillObject,
    zIndex: 50,
    elevation: 50,
    justifyContent: 'flex-end',
  },
  backdrop: { ...StyleSheet.absoluteFillObject },
  panel: {
    alignSelf: 'center',
    borderTopLeftRadius: 22,
    borderTopRightRadius: 22,
    borderWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: EDGE,
  },
  header: {
    height: 58,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  title: { fontSize: 18, lineHeight: 24, fontWeight: '600' },
  close: { width: 44, height: 44, borderRadius: 12, alignItems: 'center', justifyContent: 'center' },
  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: GAP },
  option: { padding: 8, overflow: 'hidden' },
  preview: { height: 108, borderWidth: StyleSheet.hairlineWidth, padding: 9, overflow: 'hidden' },
  previewHeader: { minHeight: 24, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  // These lines intentionally have more room than the compact system-sans
  // baseline. Theme fonts have different ascender/descender and vendor font
  // padding behavior; a tight 18/20dp box can clip an entire CJK glyph run.
  previewMonth: { fontSize: 14, lineHeight: 24, fontWeight: '600', includeFontPadding: true },
  previewDot: { width: 6, height: 6, borderRadius: 3 },
  previewWeek: { marginTop: 8, flexDirection: 'row', justifyContent: 'space-between' },
  previewDay: { width: 18, height: 18, borderRadius: 9, alignItems: 'center', justifyContent: 'center' },
  previewDayText: { fontSize: 8, fontWeight: '600' },
  previewEvent: {
    height: 22,
    marginTop: 8,
    borderWidth: 1,
    borderRadius: 5,
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 5,
  },
  previewEventLine: { width: 2, height: 12, borderRadius: 1 },
  previewEventText: { width: 36, height: 3, borderRadius: 2, marginLeft: 5, opacity: 0.6 },
  previewAction: {
    position: 'absolute',
    right: 8,
    bottom: 7,
    width: 22,
    height: 22,
    borderRadius: 11,
    alignItems: 'center',
    justifyContent: 'center',
  },
  optionFooter: { minHeight: 34, paddingTop: 8, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  optionLabel: { fontSize: 14, lineHeight: 26, fontWeight: '600', includeFontPadding: true },
  radio: { width: 20, height: 20, borderRadius: 10, borderWidth: 1.5, alignItems: 'center', justifyContent: 'center' },
});
