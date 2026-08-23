import { Ionicons } from '@expo/vector-icons';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  Animated,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  useWindowDimensions,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { getFeishuTokens } from '../theme/feishuTokens';

export interface MeetingSummaryBlockOption {
  stableKey: string;
  title: string;
  visible: boolean;
  fixed: boolean;
}

const MOTION_MS = 240;

export function MeetingSummaryBlocksSheet({
  visible,
  options,
  customized,
  onClose,
  onToggle,
  onReset,
}: {
  visible: boolean;
  options: readonly MeetingSummaryBlockOption[];
  customized: boolean;
  onClose: () => void;
  onToggle: (stableKey: string) => void;
  onReset: () => void;
}) {
  const { colors } = getFeishuTokens();
  const insets = useSafeAreaInsets();
  const { height } = useWindowDimensions();
  const progress = useRef(new Animated.Value(0)).current;
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  const mountedRef = useRef(visible);
  const closingRef = useRef(false);
  const [mounted, setMounted] = useState(visible);

  const finishClose = useCallback((notify: boolean) => {
    if (!mountedRef.current || closingRef.current) return;
    closingRef.current = true;
    progress.stopAnimation();
    Animated.timing(progress, {
      toValue: 0,
      duration: MOTION_MS,
      useNativeDriver: true,
    }).start(({ finished }) => {
      if (!finished) return;
      mountedRef.current = false;
      closingRef.current = false;
      setMounted(false);
      if (notify) closeRef.current();
    });
  }, [progress]);

  useEffect(() => {
    if (visible) {
      mountedRef.current = true;
      closingRef.current = false;
      setMounted(true);
      progress.stopAnimation();
      progress.setValue(0);
      Animated.timing(progress, {
        toValue: 1,
        duration: MOTION_MS,
        useNativeDriver: true,
      }).start();
      return;
    }
    finishClose(false);
  }, [finishClose, progress, visible]);

  useEffect(() => () => progress.stopAnimation(), [progress]);

  if (!mounted) return null;
  const requestClose = () => finishClose(true);

  return (
    <Modal visible transparent animationType="none" statusBarTranslucent onRequestClose={requestClose}>
      <View style={styles.root} accessibilityViewIsModal>
        <Animated.View style={[styles.backdrop, { backgroundColor: colors.backgroundMask, opacity: progress }]}>
          <Pressable style={StyleSheet.absoluteFill} onPress={requestClose} accessibilityLabel="关闭板块设置" />
        </Animated.View>
        <Animated.View
          style={[
            styles.sheet,
            {
              maxHeight: Math.min(height * 0.72, 620),
              paddingBottom: Math.max(12, insets.bottom),
              backgroundColor: colors.backgroundFloat,
              transform: [{
                translateY: progress.interpolate({ inputRange: [0, 1], outputRange: [height, 0] }),
              }],
            },
          ]}
        >
          <View style={[styles.titleBar, { borderBottomColor: colors.divider }]}>
            <View style={styles.titleAction} />
            <Text style={[styles.title, { color: colors.textTitle }]}>整理板块</Text>
            <Pressable
              style={({ pressed }) => [styles.titleAction, pressed && { backgroundColor: colors.pressedFill }]}
              onPress={requestClose}
              accessibilityRole="button"
              accessibilityLabel="关闭板块设置"
            >
              <Ionicons name="close" size={24} color={colors.iconPrimary} />
            </Pressable>
          </View>
          <Text style={[styles.intro, { color: colors.textCaption }]}>只调整当前会议的显示，不会重新整理或联网。</Text>
          <ScrollView showsVerticalScrollIndicator={false} bounces={false}>
            {options.map((option, index) => (
              <Pressable
                key={option.stableKey}
                style={({ pressed }) => [
                  styles.row,
                  index < options.length - 1 && {
                    borderBottomColor: colors.divider,
                    borderBottomWidth: StyleSheet.hairlineWidth,
                  },
                  pressed && !option.fixed && { backgroundColor: colors.pressedFill },
                ]}
                disabled={option.fixed}
                onPress={() => onToggle(option.stableKey)}
                accessibilityRole="checkbox"
                accessibilityLabel={`${option.title}${option.fixed ? '，始终显示' : ''}`}
                accessibilityState={{ checked: option.visible, disabled: option.fixed }}
              >
                <View style={styles.rowBody}>
                  <Text style={[styles.rowTitle, { color: colors.textTitle }]} numberOfLines={1}>{option.title}</Text>
                  <Text style={[styles.rowMeta, { color: colors.textCaption }]} numberOfLines={1}>
                    {option.fixed ? '始终显示' : option.visible ? '已显示' : '已隐藏'}
                  </Text>
                </View>
                <View
                  style={[
                    styles.check,
                    {
                      borderColor: option.visible ? colors.primary : colors.iconDisabled,
                      backgroundColor: option.visible ? colors.primary : 'transparent',
                    },
                  ]}
                >
                  {option.visible ? <Ionicons name="checkmark" size={16} color={colors.onPrimary} /> : null}
                </View>
              </Pressable>
            ))}
          </ScrollView>
          <Pressable
            style={({ pressed }) => [styles.reset, pressed && customized && { backgroundColor: colors.pressedFill }]}
            disabled={!customized}
            onPress={onReset}
            accessibilityRole="button"
            accessibilityLabel="恢复自动板块显示"
            accessibilityState={{ disabled: !customized }}
          >
            <Text style={[styles.resetText, { color: customized ? colors.primary : colors.iconDisabled }]}>恢复自动</Text>
          </Pressable>
        </Animated.View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, justifyContent: 'flex-end' },
  backdrop: { ...StyleSheet.absoluteFillObject },
  sheet: { borderTopLeftRadius: 12, borderTopRightRadius: 12, overflow: 'hidden' },
  titleBar: { height: 52, flexDirection: 'row', alignItems: 'center', borderBottomWidth: StyleSheet.hairlineWidth },
  titleAction: { width: 60, height: 44, alignItems: 'center', justifyContent: 'center' },
  title: { flex: 1, textAlign: 'center', fontSize: 17, lineHeight: 24, fontWeight: '500' },
  intro: { paddingHorizontal: 16, paddingTop: 12, paddingBottom: 6, fontSize: 13, lineHeight: 20 },
  row: { minHeight: 66, paddingLeft: 16, paddingRight: 18, flexDirection: 'row', alignItems: 'center' },
  rowBody: { flex: 1, paddingVertical: 9 },
  rowTitle: { fontSize: 16, lineHeight: 23, fontWeight: '400' },
  rowMeta: { marginTop: 1, fontSize: 13, lineHeight: 19 },
  check: { width: 24, height: 24, borderRadius: 6, borderWidth: 1.5, alignItems: 'center', justifyContent: 'center' },
  reset: { height: 48, marginHorizontal: 12, marginTop: 8, borderRadius: 8, alignItems: 'center', justifyContent: 'center' },
  resetText: { fontSize: 15, lineHeight: 22, fontWeight: '500' },
});
