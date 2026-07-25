import { Ionicons } from '@expo/vector-icons';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Animated,
  Modal,
  Pressable,
  StyleSheet,
  Text,
  useWindowDimensions,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { MeetingMediaClipDraft } from '../domain/meeting';
import { getFeishuTokens } from '../theme/feishuTokens';

const MOTION_MS = 300;

function timeLabel(milliseconds: number): string {
  const tenths = Math.max(0, Math.round(milliseconds / 100));
  const minutes = Math.floor(tenths / 600);
  const seconds = Math.floor((tenths % 600) / 10);
  const remainder = tenths % 10;
  const base = `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
  return remainder > 0 ? `${base}.${remainder}` : base;
}

function durationLabel(milliseconds: number): string {
  const seconds = Math.round(milliseconds / 100) / 10;
  return `${seconds.toLocaleString('zh-CN', { maximumFractionDigits: 1 })} 秒`;
}

export function MeetingMediaClipEditorSheet({
  visible,
  draft,
  saving,
  error,
  onClose,
  onSubmit,
}: {
  visible: boolean;
  draft: MeetingMediaClipDraft | null;
  saving: boolean;
  error: string;
  onClose: () => void;
  onSubmit: (draft: MeetingMediaClipDraft) => void;
}) {
  const { colors } = getFeishuTokens();
  const insets = useSafeAreaInsets();
  const { height } = useWindowDimensions();
  const progress = useRef(new Animated.Value(0)).current;
  const mountedRef = useRef(visible);
  const closingRef = useRef(false);
  const closeRef = useRef(onClose);
  const submitRef = useRef(onSubmit);
  const [mounted, setMounted] = useState(visible);
  const [closing, setClosing] = useState(false);
  const [value, setValue] = useState<MeetingMediaClipDraft | null>(draft);
  closeRef.current = onClose;
  submitRef.current = onSubmit;

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
      if (notify) closeRef.current();
    });
  }, [progress]);

  useEffect(() => {
    if (visible) {
      setValue(draft);
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
  }, [draft, finishClose, progress, visible]);

  useEffect(() => () => progress.stopAnimation(), [progress]);

  if (!mounted || !value) return null;
  const duration = value.endMs - value.startMs;
  const canSubmit = !saving
    && !closing
    && duration >= value.limits.minimumDurationMs
    && duration <= value.limits.maximumDurationMs;
  const step = value.limits.adjustmentStepMs;
  const updateRange = (edge: 'start' | 'end', delta: number) => {
    if (saving || closing) return;
    setValue(current => {
      if (!current) return current;
      if (edge === 'start') {
        const startMs = Math.max(0, Math.min(
          current.startMs + delta,
          current.endMs - current.limits.minimumDurationMs,
        ));
        return { ...current, startMs };
      }
      const endMs = Math.min(current.sourceDurationMs, Math.max(
        current.endMs + delta,
        current.startMs + current.limits.minimumDurationMs,
      ));
      return { ...current, endMs };
    });
  };
  const toggle = (key: 'includeSpeaker' | 'includeText') => {
    if (saving || closing) return;
    if (key === 'includeSpeaker' && !value.speakerText) return;
    if (key === 'includeText' && !value.transcriptText) return;
    setValue(current => current ? { ...current, [key]: !current[key] } : current);
  };
  const requestClose = () => { if (!saving) finishClose(true); };

  return (
    <Modal visible transparent animationType="none" statusBarTranslucent onRequestClose={requestClose}>
      <View style={styles.root} accessibilityViewIsModal>
        <Animated.View style={[styles.backdrop, { backgroundColor: colors.backgroundMask, opacity: progress }]}>
          <Pressable
            style={StyleSheet.absoluteFill}
            onPress={requestClose}
            accessibilityRole="button"
            accessibilityLabel="取消生成音频片段"
          />
        </Animated.View>
        <Animated.View
          pointerEvents={closing ? 'none' : 'auto'}
          style={[
            styles.sheet,
            {
              maxHeight: Math.min(height * 0.82, 680),
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
              style={({ pressed }) => [styles.titleAction, pressed && !saving && { backgroundColor: colors.pressedFill }]}
              onPress={requestClose}
              disabled={saving}
              accessibilityRole="button"
              accessibilityLabel="取消生成音频片段"
            >
              <Text style={[styles.titleActionText, { color: saving ? colors.textDisabled : colors.textTitle }]}>取消</Text>
            </Pressable>
            <Text style={[styles.title, { color: colors.textTitle }]}>生成音频片段</Text>
            <View style={styles.titleAction} />
          </View>

          <View style={styles.content}>
            <View style={[styles.rangePreview, { backgroundColor: colors.backgroundBase }]}>
              <Text style={[styles.rangeText, { color: colors.textTitle }]}>
                {timeLabel(value.startMs)}–{timeLabel(value.endMs)}
              </Text>
              <Text style={[styles.durationText, { color: colors.textCaption }]}>{durationLabel(duration)}</Text>
            </View>

            {(['start', 'end'] as const).map(edge => {
              const label = edge === 'start' ? '开始' : '结束';
              const current = edge === 'start' ? value.startMs : value.endMs;
              const decrementDisabled = edge === 'start'
                ? value.startMs <= 0
                : duration <= value.limits.minimumDurationMs;
              const incrementDisabled = edge === 'start'
                ? duration <= value.limits.minimumDurationMs
                : value.endMs >= value.sourceDurationMs;
              return (
                <View key={edge} style={[styles.rangeRow, { borderBottomColor: colors.divider }]}>
                  <Text style={[styles.rangeLabel, { color: colors.textCaption }]}>{label}</Text>
                  <Pressable
                    style={({ pressed }) => [
                      styles.stepButton,
                      { borderColor: colors.divider },
                      pressed && !decrementDisabled && { backgroundColor: colors.pressedFill },
                    ]}
                    onPress={() => updateRange(edge, -step)}
                    disabled={decrementDisabled || saving}
                    accessibilityRole="button"
                    accessibilityLabel={`${label}时间减少一秒`}
                    accessibilityState={{ disabled: decrementDisabled || saving }}
                  >
                    <Ionicons name="remove" size={20} color={decrementDisabled ? colors.iconDisabled : colors.iconPrimary} />
                  </Pressable>
                  <Text style={[styles.timeValue, { color: colors.textTitle }]}>{timeLabel(current)}</Text>
                  <Pressable
                    style={({ pressed }) => [
                      styles.stepButton,
                      { borderColor: colors.divider },
                      pressed && !incrementDisabled && { backgroundColor: colors.pressedFill },
                    ]}
                    onPress={() => updateRange(edge, step)}
                    disabled={incrementDisabled || saving}
                    accessibilityRole="button"
                    accessibilityLabel={`${label}时间增加一秒`}
                    accessibilityState={{ disabled: incrementDisabled || saving }}
                  >
                    <Ionicons name="add" size={20} color={incrementDisabled ? colors.iconDisabled : colors.iconPrimary} />
                  </Pressable>
                </View>
              );
            })}

            {([
              { key: 'includeSpeaker' as const, label: '包含讲话人', enabled: Boolean(value.speakerText) },
              { key: 'includeText' as const, label: '包含文字', enabled: Boolean(value.transcriptText) },
            ]).map(item => {
              const checked = value[item.key] && item.enabled;
              return (
                <Pressable
                  key={item.key}
                  style={({ pressed }) => [styles.optionRow, pressed && item.enabled && { backgroundColor: colors.pressedFill }]}
                  onPress={() => toggle(item.key)}
                  disabled={!item.enabled || saving}
                  accessibilityRole="checkbox"
                  accessibilityLabel={item.label}
                  accessibilityState={{ checked, disabled: !item.enabled || saving }}
                >
                  <Text style={[styles.optionText, { color: item.enabled ? colors.textTitle : colors.textDisabled }]}>
                    {item.label}
                  </Text>
                  <View
                    style={[
                      styles.checkbox,
                      {
                        borderColor: checked ? colors.primary : item.enabled ? colors.iconTertiary : colors.iconDisabled,
                        backgroundColor: checked ? colors.primary : colors.backgroundFloat,
                      },
                    ]}
                  >
                    {checked ? <Ionicons name="checkmark" size={16} color={colors.onPrimary} /> : null}
                  </View>
                </Pressable>
              );
            })}
          </View>

          <View style={styles.errorSlot}>
            <Text style={[styles.errorText, { color: colors.danger }]} numberOfLines={2}>{error || ' '}</Text>
          </View>
          <View style={[styles.footer, { borderTopColor: colors.divider }]}>
            <Pressable
              style={({ pressed }) => [
                styles.submit,
                { backgroundColor: canSubmit ? pressed ? colors.primaryPressed : colors.primary : colors.backgroundBase },
              ]}
              onPress={() => { if (canSubmit) submitRef.current(value); }}
              disabled={!canSubmit}
              accessibilityRole="button"
              accessibilityLabel="生成音频片段"
              accessibilityState={{ disabled: !canSubmit, busy: saving }}
            >
              {saving ? <ActivityIndicator size="small" color={colors.onPrimary} /> : (
                <Text style={[styles.submitText, { color: canSubmit ? colors.onPrimary : colors.textDisabled }]}>生成</Text>
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
  content: { paddingHorizontal: 16, paddingTop: 16 },
  rangePreview: { height: 64, borderRadius: 6, alignItems: 'center', justifyContent: 'center', marginBottom: 8 },
  rangeText: { fontSize: 20, lineHeight: 28, fontWeight: '400', fontVariant: ['tabular-nums'] },
  durationText: { marginTop: 2, fontSize: 12, lineHeight: 18 },
  rangeRow: { height: 56, flexDirection: 'row', alignItems: 'center', borderBottomWidth: StyleSheet.hairlineWidth },
  rangeLabel: { width: 48, fontSize: 14, lineHeight: 22 },
  stepButton: { width: 44, height: 36, borderWidth: StyleSheet.hairlineWidth, borderRadius: 6, alignItems: 'center', justifyContent: 'center' },
  timeValue: { flex: 1, textAlign: 'center', fontSize: 16, lineHeight: 24, fontVariant: ['tabular-nums'] },
  optionRow: { height: 52, flexDirection: 'row', alignItems: 'center' },
  optionText: { flex: 1, fontSize: 16, lineHeight: 24, fontWeight: '400' },
  checkbox: { width: 22, height: 22, borderWidth: 1.5, borderRadius: 4, alignItems: 'center', justifyContent: 'center' },
  errorSlot: { minHeight: 34, paddingHorizontal: 16, justifyContent: 'center' },
  errorText: { fontSize: 12, lineHeight: 18 },
  footer: { borderTopWidth: StyleSheet.hairlineWidth, paddingHorizontal: 16, paddingTop: 12 },
  submit: { height: 48, borderRadius: 6, alignItems: 'center', justifyContent: 'center' },
  submitText: { fontSize: 17, lineHeight: 24, fontWeight: '400' },
});
