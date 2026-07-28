import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
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
import type { MeetingSummarySyncConflictView } from '../services/meetingSummaryConflicts';
import { getFeishuTokens } from '../theme/feishuTokens';

export type MeetingSummaryConflictChoice = 'keep_local' | 'use_remote';

const MOTION_MS = 300;

function timeLabel(value: number | null): string {
  if (value === null) return '更新时间未知';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '更新时间未知';
  return `${date.getMonth() + 1}月${date.getDate()}日 ${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}

function VersionChoice({
  label,
  preview,
  updatedAtMs,
  selected,
  disabled,
  onPress,
}: {
  label: string;
  preview: string;
  updatedAtMs: number | null;
  selected: boolean;
  disabled: boolean;
  onPress: () => void;
}) {
  const { colors } = getFeishuTokens();
  return (
    <Pressable
      style={({ pressed }) => [
        styles.version,
        {
          backgroundColor: pressed && !disabled ? colors.pressedFill : colors.backgroundFloat,
          borderColor: selected ? colors.primary : colors.divider,
        },
      ]}
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="radio"
      accessibilityLabel={label}
      accessibilityState={{ selected, disabled }}
    >
      <View style={styles.versionHeader}>
        <Text style={[styles.versionLabel, { color: disabled ? colors.textDisabled : colors.textTitle }]}>
          {label}
        </Text>
        <View style={[
          styles.radio,
          { borderColor: selected ? colors.primary : disabled ? colors.iconDisabled : colors.iconTertiary },
        ]}>
          {selected ? <View style={[styles.radioDot, { backgroundColor: colors.primary }]} /> : null}
        </View>
      </View>
      <Text
        style={[styles.preview, { color: disabled ? colors.textDisabled : colors.textTitle }]}
        numberOfLines={5}
      >
        {preview}
      </Text>
      <Text style={[styles.metadata, { color: disabled ? colors.textDisabled : colors.textCaption }]}>
        {timeLabel(updatedAtMs)}
      </Text>
    </Pressable>
  );
}

/** [PRODUCT] explicit local/cloud choice; [INFERENCE] existing LaoJi Minutes sheet geometry. */
export function MeetingSummaryConflictSheet({
  visible,
  conflict,
  saving,
  error,
  onClose,
  onResolve,
}: {
  visible: boolean;
  conflict: MeetingSummarySyncConflictView | null;
  saving: boolean;
  error: string;
  onClose: () => void;
  onResolve: (choice: MeetingSummaryConflictChoice) => void;
}) {
  const { colors } = getFeishuTokens();
  const insets = useSafeAreaInsets();
  const { height } = useWindowDimensions();
  const progress = useRef(new Animated.Value(0)).current;
  const mountedRef = useRef(visible);
  const closingRef = useRef(false);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  const [mounted, setMounted] = useState(visible);
  const [closing, setClosing] = useState(false);
  const [selected, setSelected] = useState<MeetingSummaryConflictChoice | null>(null);

  useEffect(() => {
    if (visible && conflict) setSelected(null);
  }, [conflict?.id, visible]);

  const finishClose = useCallback((notify: boolean) => {
    if (!mountedRef.current || closingRef.current) return;
    closingRef.current = true;
    setClosing(true);
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
      setClosing(false);
      setSelected(null);
      if (notify) closeRef.current();
    });
  }, [progress]);

  useEffect(() => {
    if (visible) {
      mountedRef.current = true;
      closingRef.current = false;
      setMounted(true);
      setClosing(false);
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
  const requestClose = () => {
    if (!saving) finishClose(true);
  };
  const canCommit = selected === 'keep_local'
    ? conflict?.canKeepLocal === true
    : selected === 'use_remote'
      ? conflict?.canUseRemote === true
      : false;
  const commitLabel = selected === 'use_remote' ? '使用云端版本' : '使用本机版本';

  return (
    <Modal visible transparent animationType="none" statusBarTranslucent onRequestClose={requestClose}>
      <View style={styles.root} accessibilityViewIsModal>
        <Animated.View style={[styles.backdrop, { backgroundColor: colors.backgroundMask, opacity: progress }]}>
          <Pressable
            style={StyleSheet.absoluteFill}
            onPress={requestClose}
            accessibilityLabel="关闭整理结果版本选择"
          />
        </Animated.View>
        <Animated.View
          pointerEvents={closing ? 'none' : 'auto'}
          style={[
            styles.sheet,
            {
              backgroundColor: colors.backgroundFloat,
              paddingBottom: Math.max(16, insets.bottom),
              maxHeight: height - Math.max(insets.top, 16),
              transform: [{
                translateY: progress.interpolate({ inputRange: [0, 1], outputRange: [height, 0] }),
              }],
            },
          ]}
        >
          <View style={styles.titleBar}>
            <Pressable
              style={({ pressed }) => [styles.titleAction, pressed && { backgroundColor: colors.pressedFill }]}
              onPress={requestClose}
              disabled={saving}
              accessibilityRole="button"
              accessibilityLabel="取消整理结果版本选择"
            >
              <Text style={[styles.titleActionText, { color: saving ? colors.textDisabled : colors.textCaption }]}>取消</Text>
            </Pressable>
            <Text style={[styles.title, { color: colors.textTitle }]} numberOfLines={1}>
              {conflict?.title ?? '选择整理结果版本'}
            </Text>
            <View style={styles.titleAction} />
          </View>
          <ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false} bounces={false}>
            <VersionChoice
              label="本机版本"
              preview={conflict?.localPreview ?? '版本无法读取'}
              updatedAtMs={conflict?.localUpdatedAtMs ?? null}
              selected={selected === 'keep_local'}
              disabled={saving || !conflict?.canKeepLocal}
              onPress={() => setSelected('keep_local')}
            />
            <VersionChoice
              label="云端版本"
              preview={conflict?.remotePreview ?? '版本无法读取'}
              updatedAtMs={conflict?.remoteUpdatedAtMs ?? null}
              selected={selected === 'use_remote'}
              disabled={saving || !conflict?.canUseRemote}
              onPress={() => setSelected('use_remote')}
            />
            <View style={styles.errorSlot}>
              <Text style={[styles.error, { color: colors.danger }]} accessibilityLiveRegion="polite">
                {error}
              </Text>
            </View>
            <Pressable
              style={({ pressed }) => [
                styles.commit,
                {
                  backgroundColor: !canCommit || saving
                    ? colors.primaryLoading
                    : pressed ? colors.primaryPressed : colors.primary,
                },
              ]}
              disabled={!canCommit || saving || closing}
              onPress={() => selected && onResolve(selected)}
              accessibilityRole="button"
              accessibilityLabel={commitLabel}
              accessibilityState={{ disabled: !canCommit || saving || closing, busy: saving }}
            >
              {saving
                ? <ActivityIndicator color={colors.onPrimary} />
                : <Text style={[styles.commitText, { color: colors.onPrimary }]}>{commitLabel}</Text>}
            </Pressable>
          </ScrollView>
        </Animated.View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, justifyContent: 'flex-end' },
  backdrop: { ...StyleSheet.absoluteFillObject },
  sheet: { borderTopLeftRadius: 12, borderTopRightRadius: 12, overflow: 'hidden' },
  titleBar: { height: 52, flexDirection: 'row', alignItems: 'center', paddingHorizontal: 4 },
  titleAction: { width: 64, height: 44, borderRadius: 6, alignItems: 'center', justifyContent: 'center' },
  titleActionText: { fontSize: 16, lineHeight: 24, fontWeight: '400' },
  title: { flex: 1, textAlign: 'center', fontSize: 17, lineHeight: 24, fontWeight: '500' },
  content: { paddingHorizontal: 16, paddingTop: 4, paddingBottom: 4, gap: 12 },
  version: { borderWidth: 1, borderRadius: 6, padding: 16, minHeight: 112 },
  versionHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  versionLabel: { fontSize: 16, lineHeight: 24, fontWeight: '500' },
  radio: { width: 20, height: 20, borderRadius: 10, borderWidth: 1, alignItems: 'center', justifyContent: 'center' },
  radioDot: { width: 10, height: 10, borderRadius: 5 },
  preview: { marginTop: 10, fontSize: 16, lineHeight: 24, fontWeight: '400' },
  metadata: { marginTop: 6, fontSize: 13, lineHeight: 20, fontWeight: '400' },
  errorSlot: { minHeight: 40, justifyContent: 'center' },
  error: { fontSize: 13, lineHeight: 20, fontWeight: '400' },
  commit: { height: 48, borderRadius: 6, alignItems: 'center', justifyContent: 'center' },
  commitText: { fontSize: 17, lineHeight: 24, fontWeight: '400' },
});
