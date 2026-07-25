import { Ionicons } from '@expo/vector-icons';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  Animated,
  Modal,
  Pressable,
  StyleSheet,
  Text,
  useWindowDimensions,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import {
  defaultMeetingShareSelection,
  selectedMeetingShareContents,
  type MeetingShareAvailability,
  type MeetingShareContentKey,
  type MeetingShareSelection,
} from '../services/meetingShare';
import { getFeishuTokens } from '../theme/feishuTokens';

const MOTION_MS = 300;
const CONTENT_ROWS: readonly { key: MeetingShareContentKey; label: string }[] = [
  { key: 'info', label: '基本会议信息' },
  { key: 'summary', label: '整理结果' },
  { key: 'actions', label: '行动项' },
  { key: 'transcript', label: '文字记录' },
  { key: 'attachments', label: '附件' },
  { key: 'audio', label: '录音' },
  { key: 'manualNote', label: '我的笔记' },
];

function availableSelection(
  selection: MeetingShareSelection,
  availability: MeetingShareAvailability,
): MeetingShareSelection {
  return {
    info: selection.info && availability.info,
    summary: selection.summary && availability.summary,
    actions: selection.actions && availability.actions,
    transcript: selection.transcript && availability.transcript,
    attachments: selection.attachments && availability.attachments,
    audio: selection.audio && availability.audio,
    manualNote: selection.manualNote && availability.manualNote,
  };
}

export function MeetingShareSheet({
  visible,
  availability,
  onClose,
  onShare,
}: {
  visible: boolean;
  availability: MeetingShareAvailability;
  onClose: () => void;
  onShare: (selection: MeetingShareSelection) => void;
}) {
  const { colors } = getFeishuTokens();
  const insets = useSafeAreaInsets();
  const { height } = useWindowDimensions();
  const progress = useRef(new Animated.Value(0)).current;
  const mountedRef = useRef(visible);
  const closingRef = useRef(false);
  const closeRef = useRef(onClose);
  const shareRef = useRef(onShare);
  const availabilityRef = useRef(availability);
  const [mounted, setMounted] = useState(visible);
  const [closing, setClosing] = useState(false);
  const [selection, setSelection] = useState(() => defaultMeetingShareSelection(availability));
  closeRef.current = onClose;
  shareRef.current = onShare;
  availabilityRef.current = availability;

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
      if (!mountedRef.current) setSelection(defaultMeetingShareSelection(availabilityRef.current));
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

  useEffect(() => {
    if (!visible) return;
    setSelection(current => availableSelection(current, availability));
  }, [availability, visible]);

  useEffect(() => () => progress.stopAnimation(), [progress]);

  if (!mounted) return null;
  const activeSelection = availableSelection(selection, availability);
  const canShare = selectedMeetingShareContents(activeSelection, availability).length > 0 && !closing;
  const requestClose = () => finishClose(true);
  const submit = () => {
    if (!canShare) return;
    const submitted = activeSelection;
    finishClose(true, () => shareRef.current(submitted));
  };

  return (
    <Modal
      visible
      transparent
      animationType="none"
      statusBarTranslucent
      onRequestClose={requestClose}
    >
      <View style={styles.root} accessibilityViewIsModal>
        <Animated.View
          style={[styles.backdrop, { backgroundColor: colors.backgroundMask, opacity: progress }]}
        >
          <Pressable
            style={StyleSheet.absoluteFill}
            onPress={requestClose}
            accessibilityRole="button"
            accessibilityLabel="关闭分享内容选择"
          />
        </Animated.View>
        <Animated.View
          pointerEvents={closing ? 'none' : 'auto'}
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
              accessibilityRole="button"
              accessibilityLabel="取消分享"
            >
              <Ionicons name="close" size={24} color={colors.iconPrimary} />
            </Pressable>
            <Text style={[styles.title, { color: colors.textTitle }]}>分享会议资料</Text>
            <View style={styles.titleAction} />
          </View>

          <View>
            {CONTENT_ROWS.map((row, index) => {
              const enabled = availability[row.key];
              const checked = activeSelection[row.key];
              return (
                <Pressable
                  key={row.key}
                  style={({ pressed }) => [
                    styles.row,
                    pressed && enabled && { backgroundColor: colors.pressedFill },
                  ]}
                  onPress={() => {
                    if (!enabled) return;
                    setSelection(current => ({ ...current, [row.key]: !current[row.key] }));
                  }}
                  disabled={!enabled || closing}
                  accessibilityRole="checkbox"
                  accessibilityLabel={row.label}
                  accessibilityState={{ checked, disabled: !enabled || closing }}
                >
                  <Text style={[styles.rowLabel, { color: enabled ? colors.textTitle : colors.textDisabled }]}>
                    {row.label}
                  </Text>
                  <View
                    style={[
                      styles.checkbox,
                      {
                        borderColor: checked ? colors.primary : enabled ? colors.iconTertiary : colors.iconDisabled,
                        backgroundColor: checked ? colors.primary : colors.backgroundFloat,
                      },
                    ]}
                  >
                    {checked ? <Ionicons name="checkmark" size={16} color={colors.onPrimary} /> : null}
                  </View>
                  {index < CONTENT_ROWS.length - 1 ? (
                    <View style={[styles.divider, { backgroundColor: colors.divider }]} />
                  ) : null}
                </Pressable>
              );
            })}
          </View>

          <View style={styles.footer}>
            <Pressable
              style={({ pressed }) => [
                styles.share,
                {
                  backgroundColor: canShare
                    ? pressed ? colors.primaryPressed : colors.primary
                    : colors.backgroundBase,
                },
              ]}
              onPress={submit}
              disabled={!canShare}
              accessibilityRole="button"
              accessibilityLabel="分享所选会议资料"
              accessibilityState={{ disabled: !canShare }}
            >
              <Text style={[styles.shareText, { color: canShare ? colors.onPrimary : colors.textDisabled }]}>分享</Text>
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
  titleAction: { width: 60, height: 44, alignItems: 'center', justifyContent: 'center' },
  title: { flex: 1, textAlign: 'center', fontSize: 17, lineHeight: 24, fontWeight: '500' },
  row: { height: 56, paddingLeft: 16, paddingRight: 12, flexDirection: 'row', alignItems: 'center' },
  rowLabel: { flex: 1, fontSize: 16, lineHeight: 24, fontWeight: '400' },
  checkbox: { width: 22, height: 22, borderWidth: 1.5, borderRadius: 4, alignItems: 'center', justifyContent: 'center' },
  divider: { position: 'absolute', left: 16, right: 0, bottom: 0, height: StyleSheet.hairlineWidth },
  footer: { paddingHorizontal: 16, paddingTop: 12 },
  share: { height: 48, borderRadius: 6, alignItems: 'center', justifyContent: 'center' },
  shareText: { fontSize: 17, lineHeight: 24, fontWeight: '400' },
});
