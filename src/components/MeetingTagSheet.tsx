import Ionicons from '@expo/vector-icons/Ionicons';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Animated,
  Keyboard,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  useWindowDimensions,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { MeetingTagRecord, RenameMeetingTagResult } from "../data/repositories/meetingNoteRepository";
import { readableErrorMessage } from '../services/errors';
import { getUiTokens } from '../theme/uiTokens';

type Mode = 'assign' | 'manage';

const MOTION_MS = 300;

export function MeetingTagSheet({
  visible,
  mode,
  meetingTitle,
  tags,
  selectedTagIds,
  onClose,
  onCreate,
  onRename,
  onDelete,
  onSave,
}: {
  visible: boolean;
  mode: Mode;
  meetingTitle?: string;
  tags: readonly MeetingTagRecord[];
  selectedTagIds?: readonly string[];
  onClose: () => void;
  onCreate: (name: string) => Promise<MeetingTagRecord>;
  onRename: (tagId: string, name: string) => Promise<RenameMeetingTagResult>;
  onDelete: (tag: MeetingTagRecord) => void;
  onSave?: (tagIds: readonly string[]) => Promise<void>;
}) {
  const { colors } = getUiTokens();
  const insets = useSafeAreaInsets();
  const { height } = useWindowDimensions();
  const progress = useRef(new Animated.Value(0)).current;
  const mountedRef = useRef(visible);
  const closingRef = useRef(false);
  const closeRef = useRef(onClose);
  const selectedTagIdsRef = useRef(selectedTagIds);
  const keyboardVisibleRef = useRef(false);
  const [mounted, setMounted] = useState(visible);
  const [closing, setClosing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [draft, setDraft] = useState('');
  const [editingTagId, setEditingTagId] = useState<string | null>(null);
  const [selection, setSelection] = useState<ReadonlySet<string>>(
    () => new Set(selectedTagIds ?? []),
  );
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [androidKeyboardInset, setAndroidKeyboardInset] = useState(0);
  closeRef.current = onClose;
  selectedTagIdsRef.current = selectedTagIds;

  const finishClose = useCallback((notify: boolean) => {
    if (!mountedRef.current || closingRef.current) return;
    closingRef.current = true;
    setClosing(true);
    Keyboard.dismiss();
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
      if (!mountedRef.current) {
        keyboardVisibleRef.current = false;
        setSelection(new Set(selectedTagIdsRef.current ?? []));
        setDraft('');
        setEditingTagId(null);
        setMessage('');
        setError('');
        setBusy(false);
        setAndroidKeyboardInset(0);
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

  useEffect(() => {
    if (Platform.OS !== 'android') return undefined;
    const shown = Keyboard.addListener('keyboardDidShow', event => {
      keyboardVisibleRef.current = true;
      const inset = Math.max(0, height - event.endCoordinates.screenY);
      setAndroidKeyboardInset(Math.min(height, inset));
    });
    const hidden = Keyboard.addListener('keyboardDidHide', () => {
      keyboardVisibleRef.current = false;
      setAndroidKeyboardInset(0);
    });
    return () => {
      shown.remove();
      hidden.remove();
    };
  }, [height]);

  if (!mounted) return null;
  const selectedCount = selection.size;
  const canSave = mode === 'assign' && !busy && !closing && Boolean(onSave);
  const submitDraft = async () => {
    if (busy || closing || !draft.trim()) return;
    setBusy(true);
    setError('');
    setMessage('');
    try {
      if (editingTagId) {
        const renamedTagId = editingTagId;
        const result = await onRename(renamedTagId, draft);
        if (result.merged && result.tag.id !== renamedTagId) {
          setSelection(current => {
            if (!current.has(renamedTagId)) return current;
            const next = new Set(current);
            next.delete(renamedTagId);
            next.add(result.tag.id);
            return next;
          });
        }
        setEditingTagId(null);
        setDraft('');
        setMessage(result.merged ? '已合并到同名标签' : '标签已重命名');
      } else {
        const created = await onCreate(draft);
        setDraft('');
        if (mode === 'assign') {
          setSelection(current => new Set(current).add(created.id));
        }
        setMessage('标签已添加');
      }
    } catch (reason) {
      setError(readableErrorMessage(reason, '标签暂时未能保存，请稍后重试。'));
    } finally {
      setBusy(false);
    }
  };
  const saveSelection = async () => {
    if (!canSave || !onSave) return;
    setBusy(true);
    setError('');
    try {
      await onSave([...selection]);
      setBusy(false);
      finishClose(true);
    } catch (reason) {
      setBusy(false);
      setError(readableErrorMessage(reason, '会议标签暂时未能保存，请稍后重试。'));
    }
  };
  const beginRename = (tag: MeetingTagRecord) => {
    if (busy || closing) return;
    setEditingTagId(tag.id);
    setDraft(tag.name);
    setMessage('');
    setError('');
  };
  const cancelRename = () => {
    setEditingTagId(null);
    setDraft('');
    setMessage('');
    setError('');
  };
  const toggle = (tagId: string) => {
    if (mode !== 'assign' || busy || closing) return;
    setSelection(current => {
      const next = new Set(current);
      if (next.has(tagId)) next.delete(tagId);
      else next.add(tagId);
      return next;
    });
  };
  const requestClose = () => {
    if (!busy) finishClose(true);
  };
  const requestSystemClose = () => {
    if (keyboardVisibleRef.current) {
      keyboardVisibleRef.current = false;
      Keyboard.dismiss();
      return;
    }
    if (busy) return;
    requestClose();
  };
  const baseSheetHeight = Math.min(height * 0.82, 700);
  const sheetHeight = Math.max(
    0,
    Math.min(
      baseSheetHeight,
      height - androidKeyboardInset - Math.max(insets.top, 12),
    ),
  );

  return (
    <Modal
      visible
      transparent
      animationType="none"
      statusBarTranslucent
      navigationBarTranslucent
      onRequestClose={requestSystemClose}
    >
      <View style={styles.root} accessibilityViewIsModal>
        <Animated.View style={[styles.backdrop, { backgroundColor: colors.backgroundMask, opacity: progress }]}>
          <Pressable
            style={StyleSheet.absoluteFill}
            onPress={requestClose}
            accessibilityRole="button"
            accessibilityLabel="关闭标签面板"
          />
        </Animated.View>
        <KeyboardAvoidingView
          style={[
            styles.keyboardHost,
            Platform.OS === 'android' ? { paddingBottom: androidKeyboardInset } : null,
          ]}
          behavior={Platform.OS === 'ios' ? 'padding' : undefined}
          pointerEvents="box-none"
        >
          <Animated.View
            pointerEvents={closing ? 'none' : 'auto'}
            style={[
              styles.sheet,
              {
                height: sheetHeight,
                paddingBottom: Math.max(12, insets.bottom),
                backgroundColor: colors.backgroundFloat,
                transform: [{
                  translateY: progress.interpolate({ inputRange: [0, 1], outputRange: [baseSheetHeight, 0] }),
                }],
              },
            ]}
            testID="meeting-tag-sheet"
          >
          <View style={[styles.titleBar, { borderBottomColor: colors.divider }]}>
            <Pressable
              style={({ pressed }) => [styles.titleAction, pressed && !busy && { backgroundColor: colors.pressedFill }]}
              onPress={requestClose}
              disabled={busy}
              accessibilityRole="button"
              accessibilityLabel="取消标签操作"
            >
              <Text style={[styles.titleActionText, { color: busy ? colors.textDisabled : colors.textTitle }]}>取消</Text>
            </Pressable>
            <Text style={[styles.title, { color: colors.textTitle }]} numberOfLines={1}>
              {mode === 'assign' ? '设置标签' : '管理标签'}
            </Text>
            {mode === 'manage' ? (
              <Pressable
                style={({ pressed }) => [styles.titleAction, pressed && !busy && { backgroundColor: colors.pressedFill }]}
                onPress={requestClose}
                disabled={busy}
                accessibilityRole="button"
                accessibilityLabel="完成标签管理"
              >
                <Text style={[styles.titleActionText, { color: busy ? colors.textDisabled : colors.primary }]}>完成</Text>
              </Pressable>
            ) : <View style={styles.titleAction} />}
          </View>

          {mode === 'assign' && meetingTitle ? (
            <Text style={[styles.meetingTitle, { color: colors.textCaption }]} numberOfLines={1}>{meetingTitle}</Text>
          ) : null}

          <View style={styles.inputRow}>
            <View style={[styles.inputFrame, { backgroundColor: colors.backgroundFloatOverlay }]}>
              <TextInput
                value={draft}
                onChangeText={value => {
                  setDraft(value);
                  setError('');
                  setMessage('');
                }}
                editable={!busy}
                maxLength={30}
                placeholder={editingTagId ? '输入新名称' : '标签名称'}
                placeholderTextColor={colors.textPlaceholder}
                style={[styles.input, { color: colors.textTitle }]}
                returnKeyType="done"
                onSubmitEditing={() => { void submitDraft(); }}
                accessibilityLabel={editingTagId ? '新标签名称' : '标签名称'}
              />
              {editingTagId ? (
                <Pressable
                  style={styles.inputClear}
                  onPress={cancelRename}
                  accessibilityRole="button"
                  accessibilityLabel="取消重命名"
                >
                  <Ionicons name="close" size={18} color={colors.iconTertiary} />
                </Pressable>
              ) : null}
            </View>
            <Pressable
              style={({ pressed }) => [
                styles.inputAction,
                {
                  backgroundColor: !draft.trim() || busy
                    ? colors.backgroundBase
                    : pressed ? colors.primaryPressed : colors.primary,
                },
              ]}
              onPress={() => { void submitDraft(); }}
              disabled={!draft.trim() || busy}
              accessibilityRole="button"
              accessibilityLabel={editingTagId ? '保存标签名称' : '添加标签'}
              accessibilityState={{ disabled: !draft.trim() || busy, busy }}
            >
              {busy ? <ActivityIndicator size="small" color={colors.primary} /> : (
                <Text style={[styles.inputActionText, { color: draft.trim() ? colors.onPrimary : colors.textDisabled }]}>
                  {editingTagId ? '保存' : '添加'}
                </Text>
              )}
            </Pressable>
          </View>

          <ScrollView
            style={styles.list}
            showsVerticalScrollIndicator={false}
            bounces={false}
            keyboardDismissMode="on-drag"
            keyboardShouldPersistTaps="handled"
          >
            {tags.length === 0 ? (
              <View style={styles.empty}><Text style={[styles.emptyText, { color: colors.textCaption }]}>暂无标签</Text></View>
            ) : tags.map(tag => {
              const checked = selection.has(tag.id);
              return (
                <Pressable
                  key={tag.id}
                  style={({ pressed }) => [
                    styles.row,
                    { borderBottomColor: colors.divider },
                    pressed && !busy && { backgroundColor: colors.pressedFill },
                  ]}
                  onPress={() => toggle(tag.id)}
                  disabled={busy || closing}
                  accessibilityRole={mode === 'assign' ? 'checkbox' : undefined}
                  accessibilityLabel={`${tag.name}，${tag.meetingCount}场会议`}
                  accessibilityState={mode === 'assign' ? { checked, disabled: busy || closing } : undefined}
                >
                  <View style={styles.rowBody}>
                    <Text style={[styles.rowText, { color: colors.textTitle }]} numberOfLines={1}>{tag.name}</Text>
                    <Text style={[styles.rowMeta, { color: colors.textCaption }]}>{tag.meetingCount} 场会议</Text>
                  </View>
                  {mode === 'assign' ? (
                    <View style={[
                      styles.checkbox,
                      {
                        borderColor: checked ? colors.primary : colors.iconTertiary,
                        backgroundColor: checked ? colors.primary : colors.backgroundFloat,
                      },
                    ]}>
                      {checked ? <Ionicons name="checkmark" size={16} color={colors.onPrimary} /> : null}
                    </View>
                  ) : (
                    <View style={styles.manageActions}>
                      <Pressable
                        style={({ pressed }) => [styles.iconAction, pressed && { backgroundColor: colors.pressedFill }]}
                        onPress={() => beginRename(tag)}
                        disabled={busy}
                        accessibilityRole="button"
                        accessibilityLabel={`重命名${tag.name}`}
                      >
                        <Ionicons name="create-outline" size={20} color={colors.iconSecondary} />
                      </Pressable>
                      <Pressable
                        style={({ pressed }) => [styles.iconAction, pressed && { backgroundColor: colors.pressedFill }]}
                        onPress={() => {
                          // AppDialog is owned by the Activity window while
                          // this sheet is a React Native modal window. Close
                          // the sheet first so the destructive confirmation
                          // cannot be rendered invisibly underneath it.
                          finishClose(true);
                          setTimeout(() => onDelete(tag), MOTION_MS + 50);
                        }}
                        disabled={busy}
                        accessibilityRole="button"
                        accessibilityLabel={`删除${tag.name}`}
                      >
                        <Ionicons name="trash-outline" size={20} color={colors.danger} />
                      </Pressable>
                    </View>
                  )}
                </Pressable>
              );
            })}
          </ScrollView>

          <View style={styles.messageSlot}>
            <Text style={[styles.messageText, { color: error ? colors.danger : colors.textCaption }]} numberOfLines={1}>
              {error || message || ' '}
            </Text>
          </View>
          {mode === 'assign' ? (
            <View style={[styles.footer, { borderTopColor: colors.divider }]}>
              <Pressable
                style={({ pressed }) => [
                  styles.submit,
                  { backgroundColor: pressed && canSave ? colors.primaryPressed : canSave ? colors.primary : colors.backgroundBase },
                ]}
                onPress={() => { void saveSelection(); }}
                disabled={!canSave}
                accessibilityRole="button"
                accessibilityLabel={`保存${selectedCount}个会议标签`}
                accessibilityState={{ disabled: !canSave, busy }}
              >
                {busy ? <ActivityIndicator size="small" color={colors.onPrimary} /> : (
                  <Text style={[styles.submitText, { color: canSave ? colors.onPrimary : colors.textDisabled }]}>保存</Text>
                )}
              </Pressable>
            </View>
          ) : null}
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
  sheet: { borderTopLeftRadius: 12, borderTopRightRadius: 12, overflow: 'hidden' },
  titleBar: { height: 52, flexDirection: 'row', alignItems: 'center', borderBottomWidth: StyleSheet.hairlineWidth },
  titleAction: { width: 72, height: 44, alignItems: 'center', justifyContent: 'center', borderRadius: 6 },
  titleActionText: { fontSize: 16, lineHeight: 24, fontWeight: '400' },
  title: { flex: 1, textAlign: 'center', fontSize: 17, lineHeight: 24, fontWeight: '400' },
  meetingTitle: { height: 34, paddingHorizontal: 16, paddingTop: 10, fontSize: 13, lineHeight: 18 },
  inputRow: { height: 60, paddingHorizontal: 16, flexDirection: 'row', alignItems: 'center' },
  inputFrame: { height: 40, flex: 1, borderRadius: 6, flexDirection: 'row', alignItems: 'center' },
  input: { height: 40, flex: 1, paddingHorizontal: 12, paddingVertical: 0, fontSize: 16, lineHeight: 22 },
  inputClear: { width: 40, height: 40, alignItems: 'center', justifyContent: 'center' },
  inputAction: { width: 76, height: 36, marginLeft: 8, borderRadius: 6, alignItems: 'center', justifyContent: 'center' },
  inputActionText: { fontSize: 16, lineHeight: 22, fontWeight: '400' },
  list: { flex: 1 },
  empty: { height: 84, alignItems: 'center', justifyContent: 'center' },
  emptyText: { fontSize: 14, lineHeight: 20 },
  row: { minHeight: 64, paddingLeft: 16, paddingRight: 8, flexDirection: 'row', alignItems: 'center', borderBottomWidth: StyleSheet.hairlineWidth },
  rowBody: { flex: 1, paddingVertical: 8, paddingRight: 12 },
  rowText: { fontSize: 16, lineHeight: 22, fontWeight: '400' },
  rowMeta: { marginTop: 2, fontSize: 12, lineHeight: 18 },
  checkbox: { width: 22, height: 22, marginRight: 8, borderWidth: 1.5, borderRadius: 4, alignItems: 'center', justifyContent: 'center' },
  manageActions: { flexDirection: 'row', alignItems: 'center' },
  iconAction: { width: 44, height: 44, borderRadius: 6, alignItems: 'center', justifyContent: 'center' },
  messageSlot: { height: 30, paddingHorizontal: 16, justifyContent: 'center' },
  messageText: { fontSize: 12, lineHeight: 18 },
  footer: { borderTopWidth: StyleSheet.hairlineWidth, paddingHorizontal: 16, paddingTop: 12 },
  submit: { height: 48, borderRadius: 6, alignItems: 'center', justifyContent: 'center' },
  submitText: { fontSize: 17, lineHeight: 24, fontWeight: '400' },
});
