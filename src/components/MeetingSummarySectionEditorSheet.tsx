import { Ionicons } from '@expo/vector-icons';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Animated,
  KeyboardAvoidingView,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  useWindowDimensions,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { getFeishuTokens } from '../theme/feishuTokens';

const MOTION_MS = 300;

export interface MeetingSummarySectionEditorValue {
  id: string;
  title: string | null;
  content: string;
  userEdited: boolean;
  citationsLocked?: boolean;
  citations: readonly {
    id: string;
    startMs: number;
  }[];
}

export interface MeetingSummarySectionEditorSaveValue {
  content: string;
  visibleCitationIds: readonly string[];
}

function formatClock(valueMs: number): string {
  const seconds = Math.max(0, Math.floor(valueMs / 1000));
  const minutes = Math.floor(seconds / 60);
  return `${String(minutes).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
}

function sameIds(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

export function MeetingSummarySectionEditorSheet({
  visible,
  value,
  saving,
  error,
  onClose,
  onSave,
  onRestore,
}: {
  visible: boolean;
  value: MeetingSummarySectionEditorValue | null;
  saving: boolean;
  error: string;
  onClose: () => void;
  onSave: (value: MeetingSummarySectionEditorSaveValue) => void;
  onRestore: () => void;
}) {
  const { colors } = getFeishuTokens();
  const insets = useSafeAreaInsets();
  const { height } = useWindowDimensions();
  const progress = useRef(new Animated.Value(0)).current;
  const inputRef = useRef<TextInput>(null);
  const mountedRef = useRef(visible);
  const closingRef = useRef(false);
  const closeRef = useRef(onClose);
  const [mounted, setMounted] = useState(visible);
  const [closing, setClosing] = useState(false);
  const [content, setContent] = useState(value?.content ?? '');
  const [visibleCitationIds, setVisibleCitationIds] = useState<readonly string[]>(
    value?.citations.map(citation => citation.id) ?? [],
  );
  closeRef.current = onClose;

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
      mountedRef.current = true;
      closingRef.current = false;
      setMounted(true);
      setClosing(false);
      setContent(value?.content ?? '');
      setVisibleCitationIds(value?.citations.map(citation => citation.id) ?? []);
      progress.stopAnimation();
      progress.setValue(0);
      Animated.timing(progress, {
        toValue: 1,
        duration: MOTION_MS,
        useNativeDriver: true,
      }).start();
      const focusTimer = setTimeout(() => inputRef.current?.focus(), MOTION_MS + 20);
      return () => clearTimeout(focusTimer);
    }
    finishClose(false);
    return undefined;
  }, [finishClose, progress, value?.id, visible]);

  useEffect(() => () => progress.stopAnimation(), [progress]);

  if (!mounted) return null;
  const normalizedContent = content.replace(/\r\n?/g, '\n').trim();
  const initialContent = value?.content.replace(/\r\n?/g, '\n').trim() ?? '';
  const initialCitationIds = value?.citations.map(citation => citation.id) ?? [];
  const contentChanged = normalizedContent !== initialContent;
  const citationsChanged = !value?.citationsLocked && !sameIds(visibleCitationIds, initialCitationIds);
  const canSave = Boolean(normalizedContent)
    && (contentChanged || citationsChanged)
    && !saving
    && !closing;
  const requestClose = () => {
    if (!saving) finishClose(true);
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
            accessibilityLabel="关闭整理内容编辑"
          />
        </Animated.View>
        <KeyboardAvoidingView
          style={styles.keyboardHost}
          behavior="padding"
          pointerEvents={closing ? 'none' : 'auto'}
        >
          <Animated.View
            style={[
              styles.sheet,
              {
                backgroundColor: colors.backgroundFloat,
                maxHeight: height - Math.max(insets.top, 16),
                paddingBottom: Math.max(16, insets.bottom),
                transform: [{
                  translateY: progress.interpolate({ inputRange: [0, 1], outputRange: [height, 0] }),
                }],
              },
            ]}
          >
            <View style={[styles.titleBar, { borderBottomColor: colors.divider }]}>
              <Pressable
                style={({ pressed }) => [styles.titleAction, pressed && { backgroundColor: colors.pressedFill }]}
                onPress={requestClose}
                disabled={saving}
                accessibilityRole="button"
                accessibilityLabel="取消编辑整理内容"
                accessibilityState={{ disabled: saving }}
              >
                <Ionicons name="close" size={24} color={saving ? colors.iconDisabled : colors.iconPrimary} />
              </Pressable>
              <Text style={[styles.title, { color: colors.textTitle }]}>编辑整理内容</Text>
              <View style={styles.titleAction} />
            </View>
            <ScrollView
              style={styles.formScroll}
              contentContainerStyle={styles.form}
              keyboardDismissMode="on-drag"
              keyboardShouldPersistTaps="handled"
              showsVerticalScrollIndicator={false}
              bounces={false}
            >
              <TextInput
                ref={inputRef}
                value={content}
                onChangeText={setContent}
                editable={!saving}
                multiline
                maxLength={20_000}
                textAlignVertical="top"
                selectionColor={colors.primary}
                style={[
                  styles.input,
                  {
                    color: colors.textTitle,
                    backgroundColor: colors.backgroundFloatOverlay,
                    borderColor: error ? colors.danger : colors.divider,
                  },
                ]}
                accessibilityLabel={value?.title ? `编辑${value.title}` : '编辑整理内容'}
              />
              {value && value.citations.length > 0 ? (
                <View style={styles.citationBlock}>
                  <Text style={[styles.citationLabel, { color: colors.textCaption }]}>
                    {value.citationsLocked ? '原始依据' : '引用'}
                  </Text>
                  <ScrollView
                    horizontal
                    showsHorizontalScrollIndicator={false}
                    keyboardShouldPersistTaps="handled"
                    contentContainerStyle={styles.citationRow}
                  >
                    {value.citations
                      .filter(citation => visibleCitationIds.includes(citation.id))
                      .map(citation => (
                        <Pressable
                          key={citation.id}
                          style={styles.citationTarget}
                          onPress={() => {
                            if (value.citationsLocked) return;
                            if (saving || closing) return;
                            setVisibleCitationIds(current => current.filter(id => id !== citation.id));
                          }}
                          disabled={saving || closing || value.citationsLocked}
                          accessibilityRole="button"
                          accessibilityLabel={value.citationsLocked
                            ? `原始依据 ${formatClock(citation.startMs)}`
                            : `移除引用 ${formatClock(citation.startMs)}`}
                          accessibilityState={{ disabled: saving || closing || value.citationsLocked }}
                        >
                          {({ pressed }) => (
                            <View style={[
                              styles.citationChip,
                              { backgroundColor: pressed ? colors.primaryPressed : colors.primarySoft },
                            ]}>
                              <Text style={[styles.citationText, { color: pressed ? colors.onPrimary : colors.primary }]}>{formatClock(citation.startMs)}</Text>
                              {!value.citationsLocked ? (
                                <Ionicons
                                  name="close"
                                  size={14}
                                  color={pressed ? colors.onPrimary : colors.primary}
                                />
                              ) : null}
                            </View>
                          )}
                        </Pressable>
                      ))}
                  </ScrollView>
                </View>
              ) : null}
              <View style={styles.restoreSlot}>
                {value?.userEdited ? (
                  <Pressable
                    style={({ pressed }) => [styles.restoreAction, pressed && { backgroundColor: colors.primarySoft }]}
                    onPress={onRestore}
                    disabled={saving || closing}
                    accessibilityRole="button"
                    accessibilityLabel="恢复生成内容"
                    accessibilityState={{ disabled: saving || closing, busy: saving }}
                  >
                    <Text style={[styles.restoreText, { color: saving ? colors.textDisabled : colors.primary }]}>恢复生成内容</Text>
                  </Pressable>
                ) : null}
              </View>
              <View style={styles.errorSlot}>
                {error ? <Text style={[styles.error, { color: colors.danger }]}>{error}</Text> : null}
              </View>
              <Pressable
                style={({ pressed }) => [
                  styles.save,
                  {
                    backgroundColor: canSave
                      ? pressed ? colors.primaryPressed : colors.primary
                      : colors.backgroundBase,
                  },
                ]}
                onPress={() => onSave({ content: normalizedContent, visibleCitationIds })}
                disabled={!canSave}
                accessibilityRole="button"
                accessibilityLabel="保存整理内容"
                accessibilityState={{ disabled: !canSave, busy: saving }}
              >
                {saving ? (
                  <ActivityIndicator color={colors.onPrimary} />
                ) : (
                  <Text style={[styles.saveText, { color: canSave ? colors.onPrimary : colors.textDisabled }]}>保存</Text>
                )}
              </Pressable>
            </ScrollView>
          </Animated.View>
        </KeyboardAvoidingView>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, justifyContent: 'flex-end' },
  backdrop: { ...StyleSheet.absoluteFillObject },
  keyboardHost: { flex: 1, justifyContent: 'flex-end' },
  sheet: { flexShrink: 1, borderTopLeftRadius: 12, borderTopRightRadius: 12, overflow: 'hidden' },
  titleBar: { height: 52, flexDirection: 'row', alignItems: 'center', borderBottomWidth: StyleSheet.hairlineWidth },
  titleAction: { width: 52, height: 44, alignItems: 'center', justifyContent: 'center' },
  title: { flex: 1, textAlign: 'center', fontSize: 17, lineHeight: 24, fontWeight: '500' },
  formScroll: { flexShrink: 1 },
  form: { paddingHorizontal: 16, paddingTop: 16, paddingBottom: 4 },
  input: { minHeight: 180, maxHeight: 320, borderWidth: 1, borderRadius: 6, paddingHorizontal: 12, paddingVertical: 10, fontSize: 16, lineHeight: 24 },
  citationBlock: { paddingTop: 6 },
  citationLabel: { height: 22, fontSize: 14, lineHeight: 20 },
  citationRow: { minHeight: 44, alignItems: 'center' },
  citationTarget: { height: 44, justifyContent: 'center', marginRight: 4 },
  citationChip: { height: 32, borderRadius: 6, paddingHorizontal: 10, flexDirection: 'row', alignItems: 'center' },
  citationText: { fontSize: 14, lineHeight: 20, marginRight: 4 },
  restoreSlot: { height: 44, justifyContent: 'center', alignItems: 'flex-start' },
  restoreAction: { minWidth: 120, height: 40, paddingHorizontal: 8, borderRadius: 6, alignItems: 'center', justifyContent: 'center' },
  restoreText: { fontSize: 16, lineHeight: 24, fontWeight: '400' },
  errorSlot: { height: 36, justifyContent: 'center' },
  error: { fontSize: 13, lineHeight: 18 },
  save: { height: 48, borderRadius: 6, alignItems: 'center', justifyContent: 'center' },
  saveText: { fontSize: 17, lineHeight: 24, fontWeight: '400' },
});
