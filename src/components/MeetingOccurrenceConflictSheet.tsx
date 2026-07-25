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
import type {
  MeetingOccurrenceConflictMeetingView,
  MeetingOccurrenceSyncConflictView,
} from '../services/meetingOccurrenceConflicts';
import { getFeishuTokens } from '../theme/feishuTokens';

const MOTION_MS = 300;

function MeetingCard({
  label,
  meeting,
}: {
  label: string;
  meeting: MeetingOccurrenceConflictMeetingView;
}) {
  const { colors } = getFeishuTokens();
  return (
    <View
      style={[styles.meetingCard, { backgroundColor: colors.backgroundFloat, borderColor: colors.divider }]}
      accessibilityLabel={`${label}，${meeting.title}`}
    >
      <Text style={[styles.meetingLabel, { color: colors.textCaption }]}>{label}</Text>
      <Text style={[styles.meetingTitle, { color: colors.textTitle }]} numberOfLines={2}>
        {meeting.title}
      </Text>
      <Text style={[styles.meetingMeta, { color: colors.textCaption }]}>
        {meeting.statusLabel}
      </Text>
    </View>
  );
}

/** [INFERENCE] LaoJi-only Calendar conflict flow using Feishu-style sheet and UDButton geometry. */
export function MeetingOccurrenceConflictSheet({
  visible,
  conflict,
  saving,
  error,
  onClose,
  onResolve,
}: {
  visible: boolean;
  conflict: MeetingOccurrenceSyncConflictView | null;
  saving: boolean;
  error: string;
  onClose: () => void;
  onResolve: () => void;
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

  if (!mounted || !conflict?.remote) return null;
  const hasRecordingsToMerge = conflict.local.mergeableRecordingCount > 0;
  const requestClose = () => {
    if (!saving) finishClose(true);
  };
  const disabled = saving || closing || !conflict.canResolve;

  return (
    <Modal visible transparent animationType="none" statusBarTranslucent onRequestClose={requestClose}>
      <View style={styles.root} accessibilityViewIsModal>
        <Animated.View
          style={[styles.backdrop, { backgroundColor: colors.backgroundMask, opacity: progress }]}
        >
          <Pressable
            style={StyleSheet.absoluteFill}
            onPress={requestClose}
            accessibilityLabel="关闭日程关联处理"
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
              accessibilityLabel="取消处理日程关联"
            >
              <Text style={[styles.titleActionText, { color: saving ? colors.textDisabled : colors.textCaption }]}>取消</Text>
            </Pressable>
            <Text style={[styles.title, { color: colors.textTitle }]}>处理日程关联</Text>
            <View style={styles.titleAction} />
          </View>
          <ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false} bounces={false}>
            <Text style={[styles.summary, { color: colors.textCaption }]}>同一日程关联了两条不同的会议记录。</Text>
            <MeetingCard label="本机会议记录" meeting={conflict.local} />
            <MeetingCard label="日程当前关联" meeting={conflict.remote} />
            <View style={[styles.notice, { backgroundColor: colors.pressedFill }]}>
              <Text style={[styles.noticeText, { color: colors.textCaption }]}>
                {hasRecordingsToMerge
                  ? '处理后，本机会议仍完整保留；录音会复制到日程当前关联，原文件不会移除。'
                  : '处理后，本机会议记录会独立保留；日程将使用云端关联。'}
              </Text>
            </View>
            <View style={styles.errorSlot}>
              <Text style={[styles.errorText, { color: colors.danger }]} accessibilityLiveRegion="polite">
                {error}
              </Text>
            </View>
            <Pressable
              style={({ pressed }) => [
                styles.commit,
                {
                  backgroundColor: disabled
                    ? colors.primaryLoading
                    : pressed ? colors.primaryPressed : colors.primary,
                },
              ]}
              disabled={disabled}
              onPress={onResolve}
              accessibilityRole="button"
              accessibilityLabel={hasRecordingsToMerge ? '保留本机记录并加入本机录音' : '保留本机记录，使用云端关联'}
              accessibilityState={{ disabled, busy: saving }}
            >
              {saving
                ? <ActivityIndicator color={colors.onPrimary} />
                : <Text style={[styles.commitText, { color: colors.onPrimary }]}>
                  {hasRecordingsToMerge ? '保留并加入本机录音' : '保留本机记录，使用云端关联'}
                </Text>}
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
  titleBar: {
    height: 52,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 4,
  },
  titleAction: { width: 64, height: 44, borderRadius: 6, alignItems: 'center', justifyContent: 'center' },
  titleActionText: { fontSize: 16, lineHeight: 24, fontWeight: '400' },
  title: { flex: 1, textAlign: 'center', fontSize: 17, lineHeight: 24, fontWeight: '600' },
  content: { paddingHorizontal: 16, paddingTop: 4, paddingBottom: 4, gap: 12 },
  summary: { fontSize: 14, lineHeight: 22, fontWeight: '400' },
  meetingCard: { borderWidth: 0.5, borderRadius: 6, padding: 16, minHeight: 104 },
  meetingLabel: { fontSize: 13, lineHeight: 20, fontWeight: '400' },
  meetingTitle: { marginTop: 4, fontSize: 16, lineHeight: 24, fontWeight: '500' },
  meetingMeta: { marginTop: 6, fontSize: 13, lineHeight: 20, fontWeight: '400' },
  notice: { borderRadius: 6, paddingHorizontal: 12, paddingVertical: 10 },
  noticeText: { fontSize: 14, lineHeight: 22, fontWeight: '400' },
  errorSlot: { minHeight: 40, justifyContent: 'center' },
  errorText: { fontSize: 13, lineHeight: 20, fontWeight: '400' },
  commit: { height: 48, borderRadius: 6, alignItems: 'center', justifyContent: 'center' },
  commitText: { fontSize: 17, lineHeight: 24, fontWeight: '400' },
});
