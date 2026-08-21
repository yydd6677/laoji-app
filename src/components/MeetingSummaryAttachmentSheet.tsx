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
import type { MeetingSummaryAttachmentAuthorization } from '../domain/meeting';
import type { MeetingAttachmentRecord } from '../data/repositories';
import { meetingSummaryImageAttachmentIsSelectable } from '../services/meetingSummaryAttachments';
import { getFeishuTokens } from '../theme/feishuTokens';

const MOTION_MS = 300;
const MAX_SELECTION = 12;
const MAX_IMAGE_SELECTION = 4;
const MAX_IMAGE_BYTES = 40 * 1024 * 1024;

function timeLabel(positionMs: number): string {
  const seconds = Math.max(0, Math.floor(positionMs / 1_000));
  const minutes = Math.floor(seconds / 60);
  return `${String(minutes).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
}

function authorizationErrorMessage(error: unknown, purpose: 'summary' | 'question'): string {
  const message = error instanceof Error ? error.message.trim() : '';
  return message && /[\u3400-\u9fff]/.test(message)
    ? message
    : purpose === 'question' ? '附件暂时无法用于问答。' : '附件暂时无法用于整理。';
}

export function MeetingSummaryAttachmentSheet({
  visible,
  attachments,
  imageSelectionEnabled,
  purpose = 'summary',
  initialSelectedIds = [],
  onClose,
  onSkip,
  onAuthorize,
  onCompleted,
}: {
  visible: boolean;
  attachments: readonly MeetingAttachmentRecord[];
  imageSelectionEnabled: boolean;
  purpose?: 'summary' | 'question';
  initialSelectedIds?: readonly string[];
  onClose: () => void;
  onSkip: () => void;
  onAuthorize: (attachmentIds: readonly string[]) => Promise<MeetingSummaryAttachmentAuthorization>;
  onCompleted: (authorization: MeetingSummaryAttachmentAuthorization) => void;
}) {
  const { colors } = getFeishuTokens();
  const insets = useSafeAreaInsets();
  const { height } = useWindowDimensions();
  const progress = useRef(new Animated.Value(0)).current;
  const mountedRef = useRef(visible);
  const visibleRef = useRef(false);
  const closingRef = useRef(false);
  const closeRef = useRef(onClose);
  const skipRef = useRef(onSkip);
  const authorizeRef = useRef(onAuthorize);
  const completedRef = useRef(onCompleted);
  const attachmentsRef = useRef(attachments);
  const initialSelectedIdsRef = useRef(initialSelectedIds);
  const [mounted, setMounted] = useState(visible);
  const [closing, setClosing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [selectedIds, setSelectedIds] = useState<ReadonlySet<string>>(() => new Set());
  closeRef.current = onClose;
  skipRef.current = onSkip;
  authorizeRef.current = onAuthorize;
  completedRef.current = onCompleted;
  if (visible && !closingRef.current) attachmentsRef.current = attachments;
  if (visible && !closingRef.current) initialSelectedIdsRef.current = initialSelectedIds;

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
      // Selection/skip callbacks clear the request in the parent. Do not
      // also invoke onClose, which used to clear the preparation state before
      // the next stage was started.
      if (afterExit) afterExit();
      else if (notify) closeRef.current();
    });
  }, [progress]);

  useEffect(() => {
    if (visible) {
      if (!visibleRef.current) {
        setSelectedIds(new Set(initialSelectedIdsRef.current));
        setError('');
        setSaving(false);
      }
      visibleRef.current = true;
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
    visibleRef.current = false;
    finishClose(false);
  }, [finishClose, progress, visible]);

  useEffect(() => () => progress.stopAnimation(), [progress]);

  if (!mounted) return null;
  const presented = attachmentsRef.current;
  const imageAvailable = (attachment: MeetingAttachmentRecord) => (
    imageSelectionEnabled
    && meetingSummaryImageAttachmentIsSelectable(attachment)
  );
  const available = (attachment: MeetingAttachmentRecord) => (
    attachment.kind === 'text' || imageAvailable(attachment)
  );
  const selected = presented.filter(item => available(item) && selectedIds.has(item.id));
  // An empty selection is valid: continue without using attachments. The
  // previous disabled button made the template flow appear stuck.
  const canSubmit = !saving && !closing;
  const requestClose = () => {
    if (!saving) finishClose(true);
  };
  const requestSkip = () => {
    if (!saving) finishClose(true, skipRef.current);
  };
  const toggle = (attachment: MeetingAttachmentRecord) => {
    if (!available(attachment) || saving || closing) return;
    if (!selectedIds.has(attachment.id) && selectedIds.size >= MAX_SELECTION) {
      setError(`最多选择 ${MAX_SELECTION} 个附件。`);
      return;
    }
    if (!selectedIds.has(attachment.id) && attachment.kind === 'image') {
      const selectedImages = presented.filter(item => (
        item.kind === 'image' && selectedIds.has(item.id)
      ));
      if (selectedImages.length >= MAX_IMAGE_SELECTION) {
        setError(`最多选择 ${MAX_IMAGE_SELECTION} 张照片。`);
        return;
      }
      if (
        selectedImages.reduce((total, item) => total + (item.byteSize ?? 0), 0)
        + (attachment.byteSize ?? 0) > MAX_IMAGE_BYTES
      ) {
        setError('所选照片总大小不能超过 40 MB。');
        return;
      }
    }
    setError('');
    setSelectedIds(current => {
      const next = new Set(current);
      if (next.has(attachment.id)) next.delete(attachment.id);
      else next.add(attachment.id);
      return next;
    });
  };
  const submit = async () => {
    if (!canSubmit) return;
    if (selected.length === 0) {
      const skip = skipRef.current;
      if (skip) finishClose(true, skip);
      return;
    }
    setSaving(true);
    setError('');
    try {
      const authorization = await authorizeRef.current(selected.map(item => item.id));
      const completed = completedRef.current;
      setSaving(false);
      finishClose(true, () => completed(authorization));
    } catch (reason) {
      setSaving(false);
      setError(authorizationErrorMessage(reason, purpose));
    }
  };

  return (
    <Modal visible transparent animationType="none" statusBarTranslucent onRequestClose={requestClose}>
      <View style={styles.root} accessibilityViewIsModal>
        <Animated.View style={[styles.backdrop, { backgroundColor: colors.backgroundMask, opacity: progress }]}>
          <Pressable
            style={StyleSheet.absoluteFill}
            onPress={requestClose}
            accessibilityRole="button"
            accessibilityLabel="取消选择附件"
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
              style={({ pressed }) => [styles.titleAction, pressed && !saving && { backgroundColor: colors.pressedFill }]}
              onPress={requestClose}
              disabled={saving}
              accessibilityRole="button"
              accessibilityLabel="取消选择附件"
              accessibilityState={{ disabled: saving }}
            >
              <Text style={[styles.titleActionText, { color: saving ? colors.textDisabled : colors.textTitle }]}>取消</Text>
            </Pressable>
            <Text style={[styles.title, { color: colors.textTitle }]}>选择附件</Text>
            <View style={styles.titleAction} />
          </View>

          <ScrollView style={styles.list} showsVerticalScrollIndicator={false} bounces={false}>
            {presented.map(attachment => {
              const itemAvailable = available(attachment);
              const checked = itemAvailable && selectedIds.has(attachment.id);
              const content = attachment.kind === 'text'
                ? attachment.textContent?.trim() || '文字附件'
                : attachment.fileName?.trim() || '照片';
              const meta = attachment.kind === 'text'
                ? `文字 · ${timeLabel(attachment.positionMs)}`
                : `照片 · ${timeLabel(attachment.positionMs)}${itemAvailable ? '' : ' · 暂不可用'}`;
              return (
                <Pressable
                  key={attachment.id}
                  style={({ pressed }) => [
                    styles.row,
                    { borderBottomColor: colors.divider },
                    pressed && itemAvailable && !saving && { backgroundColor: colors.pressedFill },
                  ]}
                  onPress={() => toggle(attachment)}
                  disabled={!itemAvailable || saving || closing}
                  accessibilityRole="checkbox"
                  accessibilityLabel={`${content}，${meta}`}
                  accessibilityState={{ checked, disabled: !itemAvailable || saving || closing }}
                >
                  <View style={[styles.iconSlot, { backgroundColor: itemAvailable ? colors.primarySoft : colors.backgroundBase }]}>
                    <Ionicons
                      name={attachment.kind === 'text' ? 'document-text-outline' : 'image-outline'}
                      size={20}
                      color={itemAvailable ? colors.primary : colors.iconDisabled}
                    />
                  </View>
                  <View style={styles.rowBody}>
                    <Text
                      style={[styles.rowText, { color: itemAvailable ? colors.textTitle : colors.textDisabled }]}
                      numberOfLines={2}
                    >
                      {content}
                    </Text>
                    <Text style={[styles.rowMeta, { color: itemAvailable ? colors.textCaption : colors.textDisabled }]}>
                      {meta}
                    </Text>
                  </View>
                  <View
                    style={[
                      styles.checkbox,
                      {
                        borderColor: checked ? colors.primary : itemAvailable ? colors.iconTertiary : colors.iconDisabled,
                        backgroundColor: checked ? colors.primary : colors.backgroundFloat,
                      },
                    ]}
                  >
                    {checked ? <Ionicons name="checkmark" size={16} color={colors.onPrimary} /> : null}
                  </View>
                </Pressable>
              );
            })}
          </ScrollView>

          <View style={styles.errorSlot}>
            <Text style={[styles.errorText, { color: colors.danger }]} numberOfLines={1}>{error || ' '}</Text>
          </View>
          <View style={[styles.footer, { borderTopColor: colors.divider }]}>
            <Pressable
              style={({ pressed }) => [
                styles.submit,
                {
                  backgroundColor: pressed ? colors.primaryPressed : colors.primary,
                },
              ]}
              onPress={() => { void submit(); }}
              disabled={!canSubmit}
              accessibilityRole="button"
              accessibilityLabel={selected.length > 0
                ? `使用所选 ${selected.length} 个附件`
                : purpose === 'question' ? '继续问答' : '继续整理'}
              accessibilityState={{ disabled: !canSubmit, busy: saving }}
            >
              {saving ? <ActivityIndicator size="small" color={colors.onPrimary} /> : (
                <Text style={[styles.submitText, { color: colors.onPrimary }]}>
                  {selected.length > 0
                    ? `使用（${selected.length}）`
                    : purpose === 'question' ? '继续问答' : '继续整理'}
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
  row: { minHeight: 68, paddingHorizontal: 16, flexDirection: 'row', alignItems: 'center', borderBottomWidth: StyleSheet.hairlineWidth },
  iconSlot: { width: 36, height: 36, borderRadius: 6, alignItems: 'center', justifyContent: 'center' },
  rowBody: { flex: 1, paddingVertical: 8, paddingHorizontal: 12 },
  rowText: { fontSize: 15, lineHeight: 22, fontWeight: '400' },
  rowMeta: { marginTop: 2, fontSize: 12, lineHeight: 18 },
  checkbox: { width: 22, height: 22, borderWidth: 1.5, borderRadius: 4, alignItems: 'center', justifyContent: 'center' },
  errorSlot: { height: 30, paddingHorizontal: 16, justifyContent: 'center' },
  errorText: { fontSize: 12, lineHeight: 18 },
  footer: { borderTopWidth: StyleSheet.hairlineWidth, paddingHorizontal: 16, paddingTop: 12 },
  submit: { height: 48, borderRadius: 6, alignItems: 'center', justifyContent: 'center' },
  submitText: { fontSize: 17, lineHeight: 24, fontWeight: '400' },
});
