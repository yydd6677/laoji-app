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
import type { MeetingContentShare, MeetingContentShareKey } from '../domain/meeting';
import { getFeishuTokens } from '../theme/feishuTokens';

const MOTION_MS = 300;
const LABELS: Readonly<Record<MeetingContentShareKey, string>> = {
  info: '基本信息',
  summary: '整理结果',
  actions: '行动项',
  transcript: '文字记录',
  markers: '标记',
  attachments: '附件',
  manualNote: '我的笔记',
};

function statusLabel(value: MeetingContentShare): string {
  if (value.status === 'active') return value.followLatestSummary ? '整理结果保持最新' : '内容已冻结';
  if (value.status === 'pending') return '正在创建';
  if (value.status === 'revoking') return '正在撤销';
  if (value.pendingOperation === 'revoke') return '撤销失败';
  return value.status === 'blocked' ? '无法创建' : '创建失败';
}

export function MeetingContentShareManagerSheet({
  visible,
  shares,
  loading,
  busyShareId,
  error,
  onClose,
  onSend,
  onRetry,
  onRevoke,
}: {
  visible: boolean;
  shares: readonly MeetingContentShare[];
  loading: boolean;
  busyShareId: string | null;
  error: string;
  onClose: () => void;
  onSend: (share: MeetingContentShare) => void;
  onRetry: (share: MeetingContentShare) => void;
  onRevoke: (share: MeetingContentShare) => void;
}) {
  const { colors } = getFeishuTokens();
  const insets = useSafeAreaInsets();
  const { height } = useWindowDimensions();
  const progress = useRef(new Animated.Value(0)).current;
  const mountedRef = useRef(visible);
  const closingRef = useRef(false);
  const closeRef = useRef(onClose);
  const [mounted, setMounted] = useState(visible);
  const [closing, setClosing] = useState(false);
  closeRef.current = onClose;

  const finishClose = useCallback((notify: boolean) => {
    if (!mountedRef.current || closingRef.current) return;
    closingRef.current = true;
    setClosing(true);
    progress.stopAnimation();
    Animated.timing(progress, { toValue: 0, duration: MOTION_MS, useNativeDriver: true })
      .start(({ finished }) => {
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
      Animated.timing(progress, { toValue: 1, duration: MOTION_MS, useNativeDriver: true }).start();
      return;
    }
    finishClose(false);
  }, [finishClose, progress, visible]);

  useEffect(() => () => progress.stopAnimation(), [progress]);
  if (!mounted) return null;
  const busy = busyShareId !== null;
  const requestClose = () => { if (!busy) finishClose(true); };
  const visibleShares = shares.filter(share => share.status !== 'revoked');

  return (
    <Modal visible transparent animationType="none" statusBarTranslucent onRequestClose={requestClose}>
      <View style={styles.root} accessibilityViewIsModal>
        <Animated.View style={[styles.backdrop, { backgroundColor: colors.backgroundMask, opacity: progress }]}>
          <Pressable
            style={StyleSheet.absoluteFill}
            onPress={requestClose}
            accessibilityRole="button"
            accessibilityLabel="关闭共享链接"
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
              transform: [{ translateY: progress.interpolate({ inputRange: [0, 1], outputRange: [height, 0] }) }],
            },
          ]}
        >
          <View style={[styles.titleBar, { borderBottomColor: colors.divider }]}>
            <Pressable
              style={({ pressed }) => [styles.titleAction, pressed && !busy && { backgroundColor: colors.pressedFill }]}
              onPress={requestClose}
              disabled={busy}
              accessibilityRole="button"
              accessibilityLabel="关闭共享链接"
            >
              <Ionicons name="close" size={24} color={busy ? colors.iconDisabled : colors.iconPrimary} />
            </Pressable>
            <Text style={[styles.title, { color: colors.textTitle }]}>共享链接</Text>
            <View style={styles.titleAction} />
          </View>
          <ScrollView contentContainerStyle={styles.content} bounces={false} showsVerticalScrollIndicator={false}>
            {loading && visibleShares.length === 0 ? (
              <View style={styles.empty}><ActivityIndicator size="small" color={colors.primary} /></View>
            ) : visibleShares.length === 0 ? (
              <View style={styles.empty}>
                <Text style={[styles.emptyText, { color: colors.textCaption }]}>暂无共享链接</Text>
              </View>
            ) : visibleShares.map(share => {
              const rowBusy = busyShareId === share.id
                || share.status === 'pending'
                || share.status === 'revoking';
              const failed = share.status === 'failed_retryable' || share.status === 'blocked';
              const retryable = share.status === 'failed_retryable'
                || (share.status === 'blocked' && share.lastErrorCode === 'share_revision_changed');
              return (
                <View key={share.id} style={[styles.shareRow, { borderColor: colors.divider }]}>
                  <View style={styles.shareCopy}>
                    <Text style={[styles.shareTitle, { color: colors.textTitle }]} numberOfLines={2}>
                      {share.contentScope.map(key => LABELS[key]).join(' · ')}
                    </Text>
                    <Text style={[styles.shareMeta, { color: failed ? colors.danger : colors.textCaption }]}>
                      {statusLabel(share)}
                    </Text>
                  </View>
                  {rowBusy ? <ActivityIndicator size="small" color={colors.primary} /> : share.status === 'active' ? (
                    <>
                      <TextAction label="发送" colors={colors} onPress={() => onSend(share)} />
                      <TextAction label="撤销" colors={colors} destructive onPress={() => onRevoke(share)} />
                    </>
                  ) : retryable ? (
                    <TextAction label="重试" colors={colors} onPress={() => onRetry(share)} />
                  ) : null}
                </View>
              );
            })}
            <View style={styles.errorSlot}>
              <Text style={[styles.errorText, { color: colors.danger }]}>{error || ' '}</Text>
            </View>
            <Text style={[styles.privacy, { color: colors.textCaption }]}>链接只包含创建时选择的文字内容，可随时撤销。</Text>
          </ScrollView>
        </Animated.View>
      </View>
    </Modal>
  );
}

function TextAction({
  label,
  colors,
  destructive = false,
  onPress,
}: {
  label: string;
  colors: ReturnType<typeof getFeishuTokens>['colors'];
  destructive?: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      style={({ pressed }) => [styles.textAction, pressed && { backgroundColor: colors.pressedFill }]}
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={`${label}会议共享链接`}
    >
      <Text style={[styles.textActionText, { color: destructive ? colors.danger : colors.primary }]}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, justifyContent: 'flex-end' },
  backdrop: { ...StyleSheet.absoluteFillObject },
  sheet: { borderTopLeftRadius: 12, borderTopRightRadius: 12, overflow: 'hidden' },
  titleBar: { height: 52, flexDirection: 'row', alignItems: 'center', borderBottomWidth: StyleSheet.hairlineWidth },
  titleAction: { width: 60, height: 44, alignItems: 'center', justifyContent: 'center' },
  title: { flex: 1, textAlign: 'center', fontSize: 17, lineHeight: 24, fontWeight: '400' },
  content: { paddingHorizontal: 16, paddingBottom: 4 },
  empty: { minHeight: 120, alignItems: 'center', justifyContent: 'center' },
  emptyText: { fontSize: 14, lineHeight: 22 },
  shareRow: { minHeight: 72, borderBottomWidth: StyleSheet.hairlineWidth, flexDirection: 'row', alignItems: 'center' },
  shareCopy: { flex: 1, minWidth: 80, paddingVertical: 10 },
  shareTitle: { fontSize: 15, lineHeight: 22 },
  shareMeta: { marginTop: 2, fontSize: 12, lineHeight: 18 },
  textAction: { minWidth: 52, height: 44, borderRadius: 6, alignItems: 'center', justifyContent: 'center' },
  textActionText: { fontSize: 14, lineHeight: 22 },
  errorSlot: { minHeight: 40, justifyContent: 'center' },
  errorText: { fontSize: 13, lineHeight: 18 },
  privacy: { fontSize: 12, lineHeight: 18, textAlign: 'center' },
});
