import { Ionicons } from '@expo/vector-icons';
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
import type { MeetingSeriesMemoryProjection } from '../services/meetingSeriesMemory';
import { getFeishuTokens } from '../theme/feishuTokens';

const MOTION_MS = 300;

export interface MeetingSeriesSelection {
  decisionIds: readonly string[];
  actionIds: readonly string[];
}

function itemKey(kind: 'decision' | 'action', id: string): string {
  return `${kind}:${id}`;
}

function sourceLabel(date: string, title: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  const dateLabel = match ? `${Number(match[2])}月${Number(match[3])}日` : date;
  return [dateLabel, title.trim()].filter(Boolean).join(' · ');
}

export function MeetingSeriesSelectionSheet<Result>({
  visible,
  memory,
  title,
  cancelAccessibilityLabel,
  skipLabel,
  submitLabel,
  submitAccessibilityLabel,
  onClose,
  onSkip,
  onSubmit,
  onCompleted,
  errorMessage,
}: {
  visible: boolean;
  memory: MeetingSeriesMemoryProjection | null;
  title: string;
  cancelAccessibilityLabel: string;
  skipLabel?: string;
  submitLabel: (selectedCount: number) => string;
  submitAccessibilityLabel: (selectedCount: number) => string;
  onClose: () => void;
  onSkip?: () => void;
  onSubmit: (selection: MeetingSeriesSelection) => Promise<Result>;
  onCompleted: (result: Result) => void;
  errorMessage: (error: unknown) => string;
}) {
  const { colors } = getFeishuTokens();
  const insets = useSafeAreaInsets();
  const { height } = useWindowDimensions();
  const progress = useRef(new Animated.Value(0)).current;
  const mountedRef = useRef(visible);
  const closingRef = useRef(false);
  const closeRef = useRef(onClose);
  const skipRef = useRef(onSkip);
  const submitRef = useRef(onSubmit);
  const completedRef = useRef(onCompleted);
  const errorMessageRef = useRef(errorMessage);
  const memoryRef = useRef(memory);
  const [mounted, setMounted] = useState(visible);
  const [closing, setClosing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [selection, setSelection] = useState<ReadonlySet<string>>(() => new Set());
  closeRef.current = onClose;
  skipRef.current = onSkip;
  submitRef.current = onSubmit;
  completedRef.current = onCompleted;
  errorMessageRef.current = errorMessage;
  if (visible && !closingRef.current) memoryRef.current = memory;

  const finishClose = useCallback((notify: boolean, afterExit?: () => void) => {
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
      if (notify) closeRef.current();
      afterExit?.();
    });
  }, [progress]);

  useEffect(() => {
    if (visible) {
      if (!mountedRef.current) {
        setSelection(new Set());
        setError('');
        setSaving(false);
      }
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

  if (!mounted || !memoryRef.current) return null;
  const presented = memoryRef.current;
  const selectedDecisionIds = presented.decisions
    .filter(item => selection.has(itemKey('decision', item.id)))
    .map(item => item.id);
  const selectedActionIds = presented.pendingActions
    .filter(item => selection.has(itemKey('action', item.id)))
    .map(item => item.id);
  const selectedCount = selectedDecisionIds.length + selectedActionIds.length;
  const hasSelection = selectedCount > 0;
  const canSubmit = hasSelection && !saving && !closing;
  const requestClose = () => {
    if (!saving) finishClose(true);
  };
  const requestSkip = () => {
    const skip = skipRef.current;
    if (!saving && skip) finishClose(true, skip);
  };
  const toggle = (key: string) => {
    if (saving || closing) return;
    setError('');
    setSelection(current => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };
  const submit = async () => {
    if (!canSubmit) return;
    setSaving(true);
    setError('');
    try {
      const result = await submitRef.current({
        decisionIds: selectedDecisionIds,
        actionIds: selectedActionIds,
      });
      const completed = completedRef.current;
      setSaving(false);
      finishClose(true, () => completed(result));
    } catch (reason) {
      setSaving(false);
      setError(errorMessageRef.current(reason));
    }
  };

  const row = (
    kind: 'decision' | 'action',
    item: MeetingSeriesMemoryProjection['decisions'][number]
      | MeetingSeriesMemoryProjection['pendingActions'][number],
  ) => {
    const key = itemKey(kind, item.id);
    const checked = selection.has(key);
    return (
      <Pressable
        key={key}
        style={({ pressed }) => [
          styles.row,
          { borderBottomColor: colors.divider },
          pressed && !saving && { backgroundColor: colors.pressedFill },
        ]}
        onPress={() => toggle(key)}
        disabled={saving || closing}
        accessibilityRole="checkbox"
        accessibilityLabel={`${kind === 'decision' ? '决定' : '未完成事项'}，${item.content}`}
        accessibilityState={{ checked, disabled: saving || closing }}
      >
        <View style={styles.rowBody}>
          <Text style={[styles.rowText, { color: colors.textTitle }]} numberOfLines={3}>
            {item.content}
          </Text>
          <Text style={[styles.rowMeta, { color: colors.textCaption }]} numberOfLines={1}>
            {sourceLabel(item.occurrenceDate, item.sourceMeetingTitle)}
          </Text>
        </View>
        <View
          style={[
            styles.checkbox,
            {
              borderColor: checked ? colors.primary : colors.iconTertiary,
              backgroundColor: checked ? colors.primary : colors.backgroundFloat,
            },
          ]}
        >
          {checked ? <Ionicons name="checkmark" size={16} color={colors.onPrimary} /> : null}
        </View>
      </Pressable>
    );
  };

  return (
    <Modal visible transparent animationType="none" statusBarTranslucent onRequestClose={requestClose}>
      <View style={styles.root} accessibilityViewIsModal>
        <Animated.View
          style={[styles.backdrop, { backgroundColor: colors.backgroundMask, opacity: progress }]}
        >
          <Pressable
            style={StyleSheet.absoluteFill}
            onPress={requestClose}
            accessibilityRole="button"
            accessibilityLabel={cancelAccessibilityLabel}
          />
        </Animated.View>
        <Animated.View
          pointerEvents={closing ? 'none' : 'auto'}
          style={[
            styles.sheet,
            {
              maxHeight: Math.min(height * 0.8, 680),
              paddingBottom: Math.max(12, insets.bottom),
              backgroundColor: colors.backgroundFloat,
              transform: [{
                translateY: progress.interpolate({ inputRange: [0, 1], outputRange: [height, 0] }),
              }],
            },
          ]}
        >
          <View style={[styles.titleBar, { borderBottomColor: colors.divider }]}>
            <Pressable
              style={({ pressed }) => [
                styles.titleAction,
                pressed && !saving && { backgroundColor: colors.pressedFill },
              ]}
              onPress={requestClose}
              disabled={saving}
              accessibilityRole="button"
              accessibilityLabel={cancelAccessibilityLabel}
              accessibilityState={{ disabled: saving }}
            >
              <Text style={[styles.titleActionText, { color: saving ? colors.textDisabled : colors.textTitle }]}>取消</Text>
            </Pressable>
            <Text style={[styles.title, { color: colors.textTitle }]}>{title}</Text>
            {skipLabel && onSkip ? (
              <Pressable
                style={({ pressed }) => [
                  styles.titleAction,
                  pressed && !saving && { backgroundColor: colors.pressedFill },
                ]}
                onPress={requestSkip}
                disabled={saving}
                accessibilityRole="button"
                accessibilityLabel={skipLabel}
                accessibilityState={{ disabled: saving }}
              >
                <Text style={[styles.titleActionText, { color: saving ? colors.textDisabled : colors.primary }]}>
                  {skipLabel}
                </Text>
              </Pressable>
            ) : <View style={styles.titleAction} />}
          </View>

          <ScrollView style={styles.list} showsVerticalScrollIndicator={false} bounces={false}>
            {presented.decisions.length > 0 ? (
              <View>
                <Text style={[styles.sectionTitle, { color: colors.textCaption }]}>决定</Text>
                {presented.decisions.map(item => row('decision', item))}
              </View>
            ) : null}
            {presented.pendingActions.length > 0 ? (
              <View>
                <Text style={[styles.sectionTitle, { color: colors.textCaption }]}>未完成事项</Text>
                {presented.pendingActions.map(item => row('action', item))}
              </View>
            ) : null}
          </ScrollView>

          <View style={styles.errorSlot}>
            <Text style={[styles.errorText, { color: colors.danger }]} numberOfLines={1}>
              {error || ' '}
            </Text>
          </View>
          <View style={[styles.footer, { borderTopColor: colors.divider }]}>
            <Pressable
              style={({ pressed }) => [
                styles.submit,
                {
                  backgroundColor: canSubmit
                    ? pressed ? colors.primaryPressed : colors.primary
                    : hasSelection ? colors.primary : colors.backgroundBase,
                },
              ]}
              onPress={() => { void submit(); }}
              disabled={!canSubmit}
              accessibilityRole="button"
              accessibilityLabel={submitAccessibilityLabel(selectedCount)}
              accessibilityState={{ disabled: !canSubmit, busy: saving }}
            >
              {saving ? (
                <ActivityIndicator size="small" color={colors.onPrimary} />
              ) : (
                <Text style={[styles.submitText, { color: canSubmit ? colors.onPrimary : colors.textDisabled }]}>
                  {submitLabel(selectedCount)}
                </Text>
              )}
            </Pressable>
          </View>
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
  titleAction: { width: 72, height: 44, alignItems: 'center', justifyContent: 'center' },
  titleActionText: { fontSize: 16, lineHeight: 24, fontWeight: '400' },
  title: { flex: 1, textAlign: 'center', fontSize: 17, lineHeight: 24, fontWeight: '400' },
  list: { flexGrow: 0, flexShrink: 1 },
  sectionTitle: { height: 36, paddingHorizontal: 16, paddingTop: 12, fontSize: 13, lineHeight: 20 },
  row: { minHeight: 64, paddingLeft: 16, paddingRight: 14, flexDirection: 'row', alignItems: 'center', borderBottomWidth: StyleSheet.hairlineWidth },
  rowBody: { flex: 1, paddingVertical: 8, paddingRight: 12 },
  rowText: { fontSize: 15, lineHeight: 22, fontWeight: '400' },
  rowMeta: { marginTop: 2, fontSize: 12, lineHeight: 18 },
  checkbox: { width: 22, height: 22, borderWidth: 1.5, borderRadius: 4, alignItems: 'center', justifyContent: 'center' },
  errorSlot: { height: 30, paddingHorizontal: 16, justifyContent: 'center' },
  errorText: { fontSize: 12, lineHeight: 18 },
  footer: { borderTopWidth: StyleSheet.hairlineWidth, paddingHorizontal: 16, paddingTop: 12 },
  submit: { height: 48, borderRadius: 6, alignItems: 'center', justifyContent: 'center' },
  submitText: { fontSize: 17, lineHeight: 24, fontWeight: '400' },
});
