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
import type {
  MeetingActionShare,
  MeetingActionSharePermission,
} from '../domain/meeting';
import { getFeishuTokens } from '../theme/feishuTokens';

const MOTION_MS = 300;

function permissionLabel(value: MeetingActionSharePermission): string {
  return value === 'action_editor' ? '可编辑待办' : '仅查看';
}

function statusLabel(value: MeetingActionShare): string {
  if (value.status === 'active') return '链接可用';
  if (value.status === 'revoked') return '已撤销';
  if (value.status === 'pending') return '正在创建';
  if (value.status === 'revoking') return '正在撤销';
  if (value.pendingOperation === 'revoke') return '撤销失败';
  return value.status === 'blocked' ? '无法创建' : '创建失败';
}

export function MeetingActionCollaborationSheet({
  visible,
  actionContent,
  authenticated,
  shares,
  loading,
  busyShareId,
  error,
  onClose,
  onCreate,
  onSend,
  onRetry,
  onRevoke,
}: {
  visible: boolean;
  actionContent: string;
  authenticated: boolean;
  shares: readonly MeetingActionShare[];
  loading: boolean;
  busyShareId: string | null;
  error: string;
  onClose: () => void;
  onCreate: (permission: MeetingActionSharePermission) => void;
  onSend: (share: MeetingActionShare) => void;
  onRetry: (share: MeetingActionShare) => void;
  onRevoke: (share: MeetingActionShare) => void;
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
  const [permission, setPermission] = useState<MeetingActionSharePermission>('viewer');
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
      setPermission('viewer');
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
            accessibilityLabel="关闭待办共享"
          />
        </Animated.View>
        <Animated.View
          pointerEvents={closing ? 'none' : 'auto'}
          style={[
            styles.sheet,
            {
              maxHeight: Math.min(height * 0.88, 760),
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
              accessibilityLabel="关闭待办共享"
            >
              <Ionicons name="close" size={24} color={busy ? colors.iconDisabled : colors.iconPrimary} />
            </Pressable>
            <Text style={[styles.title, { color: colors.textTitle }]}>共享待办</Text>
            <View style={styles.titleAction} />
          </View>

          <ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false} bounces={false}>
            <View style={[styles.actionCard, { backgroundColor: colors.backgroundFloatOverlay }]}>
              <Text style={[styles.actionText, { color: colors.textTitle }]} numberOfLines={3}>{actionContent}</Text>
            </View>

            {!authenticated ? (
              <View style={styles.signedOutState}>
                <Text style={[styles.signedOutTitle, { color: colors.textTitle }]}>登录后可共享</Text>
                <Text style={[styles.signedOutText, { color: colors.textCaption }]}>本机待办不会因登录而被公开。</Text>
              </View>
            ) : (
              <>
                <Text style={[styles.sectionTitle, { color: colors.textCaption }]}>新链接权限</Text>
                <View style={styles.permissionRow}>
                  {(['viewer', 'action_editor'] as const).map(value => {
                    const selected = permission === value;
                    return (
                      <Pressable
                        key={value}
                        style={({ pressed }) => [
                          styles.permissionChoice,
                          {
                            borderColor: selected ? colors.primary : colors.divider,
                            backgroundColor: selected ? colors.primarySoft : colors.backgroundFloat,
                          },
                          pressed && !busy && { backgroundColor: colors.pressedFill },
                        ]}
                        onPress={() => setPermission(value)}
                        disabled={busy}
                        accessibilityRole="button"
                        accessibilityLabel={`共享权限：${permissionLabel(value)}`}
                        accessibilityState={{ selected, disabled: busy }}
                      >
                        <Ionicons
                          name={value === 'viewer' ? 'eye-outline' : 'create-outline'}
                          size={20}
                          color={selected ? colors.primary : colors.iconSecondary}
                        />
                        <Text style={[styles.permissionTitle, { color: selected ? colors.primary : colors.textTitle }]}>
                          {permissionLabel(value)}
                        </Text>
                        <Text style={[styles.permissionMeta, { color: colors.textCaption }]}>
                          {value === 'viewer' ? '查看事项与进度' : '可改状态、负责人和截止日期'}
                        </Text>
                      </Pressable>
                    );
                  })}
                </View>
                <Pressable
                  style={({ pressed }) => [
                    styles.create,
                    { backgroundColor: busy ? colors.backgroundBase : pressed ? colors.primaryPressed : colors.primary },
                  ]}
                  onPress={() => onCreate(permission)}
                  disabled={busy}
                  accessibilityRole="button"
                  accessibilityLabel={`创建${permissionLabel(permission)}共享链接`}
                  accessibilityState={{ disabled: busy, busy }}
                >
                  {busyShareId === 'creating' ? <ActivityIndicator color={colors.onPrimary} /> : (
                    <Text style={[styles.createText, { color: busy ? colors.textDisabled : colors.onPrimary }]}>创建链接</Text>
                  )}
                </Pressable>
              </>
            )}

            {authenticated ? (
              <>
                <Text style={[styles.sectionTitle, { color: colors.textCaption }]}>已有链接</Text>
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
                    || (share.status === 'blocked' && share.lastErrorCode === 'action_revision_changed');
                  return (
                    <View key={share.id} style={[styles.shareRow, { borderColor: colors.divider }]}>
                      <View style={styles.shareCopy}>
                        <Text style={[styles.shareTitle, { color: colors.textTitle }]}>{permissionLabel(share.permission)}</Text>
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
              </>
            ) : null}

            <View style={styles.errorSlot}>
              <Text style={[styles.errorText, { color: colors.danger }]}>{error || ' '}</Text>
            </View>
            <Text style={[styles.privacy, { color: colors.textCaption }]}>链接只包含这一条待办，不包含文字记录、录音或我的笔记。</Text>
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
      accessibilityLabel={`${label}待办共享链接`}
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
  content: { paddingHorizontal: 16, paddingTop: 16, paddingBottom: 4 },
  actionCard: { minHeight: 56, borderRadius: 6, paddingHorizontal: 12, paddingVertical: 10, justifyContent: 'center' },
  actionText: { fontSize: 15, lineHeight: 22 },
  sectionTitle: { marginTop: 18, marginBottom: 8, fontSize: 13, lineHeight: 20 },
  permissionRow: { flexDirection: 'row', gap: 8 },
  permissionChoice: { flex: 1, minHeight: 102, borderWidth: 1, borderRadius: 6, padding: 12 },
  permissionTitle: { marginTop: 8, fontSize: 15, lineHeight: 22 },
  permissionMeta: { marginTop: 2, fontSize: 12, lineHeight: 18 },
  create: { marginTop: 12, height: 48, borderRadius: 6, alignItems: 'center', justifyContent: 'center' },
  createText: { fontSize: 17, lineHeight: 24, fontWeight: '400' },
  empty: { height: 72, alignItems: 'center', justifyContent: 'center' },
  emptyText: { fontSize: 14, lineHeight: 22 },
  shareRow: { minHeight: 64, borderTopWidth: StyleSheet.hairlineWidth, flexDirection: 'row', alignItems: 'center' },
  shareCopy: { flex: 1, minWidth: 80, paddingVertical: 10 },
  shareTitle: { fontSize: 15, lineHeight: 22 },
  shareMeta: { marginTop: 2, fontSize: 12, lineHeight: 18 },
  textAction: { minWidth: 52, height: 44, borderRadius: 6, alignItems: 'center', justifyContent: 'center' },
  textActionText: { fontSize: 14, lineHeight: 22 },
  signedOutState: { minHeight: 120, alignItems: 'center', justifyContent: 'center' },
  signedOutTitle: { fontSize: 16, lineHeight: 24, fontWeight: '500' },
  signedOutText: { marginTop: 4, fontSize: 13, lineHeight: 20 },
  errorSlot: { minHeight: 36, justifyContent: 'center' },
  errorText: { fontSize: 13, lineHeight: 18 },
  privacy: { fontSize: 12, lineHeight: 18, textAlign: 'center' },
});
