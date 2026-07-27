import { Ionicons } from '@expo/vector-icons';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Animated,
  FlatList,
  Modal,
  Pressable,
  StyleSheet,
  Text,
  useWindowDimensions,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { MeetingSummaryActionCandidate } from '../domain/meeting';
import { getFeishuTokens } from '../theme/feishuTokens';

const MOTION_MS = 300;
const ROW_HEIGHT = 92;

function actionId(action: MeetingSummaryActionCandidate): string {
  return action.canonicalId ?? action.id;
}

function dateLabel(value: number): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  const now = new Date();
  const year = date.getFullYear() === now.getFullYear() ? '' : `${date.getFullYear()}年`;
  return `${year}${date.getMonth() + 1}月${date.getDate()}日`;
}

function timeLabel(milliseconds: number): string {
  const total = Math.max(0, Math.floor(milliseconds / 1_000));
  const hours = Math.floor(total / 3_600);
  const minutes = Math.floor((total % 3_600) / 60);
  const seconds = total % 60;
  return hours > 0
    ? `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`
    : `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

function actionMetadata(
  action: MeetingSummaryActionCandidate,
  conflicted: boolean,
): string {
  const parts = [
    conflicted ? '同步冲突' : action.status === 'completed' ? '已完成' : '待完成',
    action.assignee?.trim() ? `负责人：${action.assignee.trim()}` : '',
    action.dueAtMs === null ? '' : `截止：${dateLabel(action.dueAtMs)}`,
  ].filter(Boolean);
  return parts.join(' · ');
}

function actionSource(action: MeetingSummaryActionCandidate): { label: string; available: boolean } {
  const citation = action.citations[0];
  const positionMs = citation?.startMs ?? action.sourceStartMs;
  if (positionMs === null || positionMs === undefined || !Number.isFinite(positionMs)) {
    return { label: '', available: false };
  }
  return { label: `来源 ${timeLabel(positionMs)}`, available: true };
}

/**
 * [PRODUCT] Meeting-global action collection. It deliberately sits outside the
 * immutable AI summary; [INFERENCE] geometry follows the established Minutes sheet family.
 */
export function MeetingActionsSheet({
  visible,
  actions,
  conflictedActionIds,
  loading,
  busyActionId,
  error,
  focusActionId,
  onClose,
  onRetry,
  onCreate,
  onToggle,
  onEdit,
  onOpenSource,
  onOpenFollowup,
}: {
  visible: boolean;
  actions: readonly MeetingSummaryActionCandidate[];
  conflictedActionIds: ReadonlySet<string>;
  loading: boolean;
  busyActionId: string | null;
  error: string;
  focusActionId: string | null;
  onClose: () => void;
  onRetry: () => void;
  onCreate: () => void;
  onToggle: (actionId: string, completed: boolean) => void;
  onEdit: (actionId: string) => void;
  onOpenSource: (actionId: string) => void;
  onOpenFollowup: (actionId: string) => void;
}) {
  const { colors } = getFeishuTokens();
  const insets = useSafeAreaInsets();
  const { height } = useWindowDimensions();
  const progress = useRef(new Animated.Value(0)).current;
  const listRef = useRef<FlatList<MeetingSummaryActionCandidate>>(null);
  const mountedRef = useRef(visible);
  const closingRef = useRef(false);
  const closeRef = useRef(onClose);
  const [mounted, setMounted] = useState(visible);
  const [closing, setClosing] = useState(false);
  closeRef.current = onClose;

  const visibleActions = useMemo(
    () => actions.filter(action => action.status !== 'dismissed' || conflictedActionIds.has(actionId(action))),
    [actions, conflictedActionIds],
  );

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

  useEffect(() => {
    if (!visible || !focusActionId || visibleActions.length === 0) return;
    const index = visibleActions.findIndex(action => actionId(action) === focusActionId);
    if (index < 0) return;
    const timer = setTimeout(() => {
      listRef.current?.scrollToIndex({ index, animated: true, viewPosition: 0.35 });
    }, MOTION_MS + 40);
    return () => clearTimeout(timer);
  }, [focusActionId, visible, visibleActions]);

  if (!mounted) return null;
  const requestClose = () => {
    if (!busyActionId) finishClose(true);
  };

  return (
    <Modal visible transparent animationType="none" statusBarTranslucent onRequestClose={requestClose}>
      <View style={styles.root} accessibilityViewIsModal>
        <Animated.View style={[styles.backdrop, { backgroundColor: colors.backgroundMask, opacity: progress }]}>
          <Pressable
            style={StyleSheet.absoluteFill}
            onPress={requestClose}
            accessibilityRole="button"
            accessibilityLabel="关闭本场待办"
          />
        </Animated.View>
        <Animated.View
          pointerEvents={closing ? 'none' : 'auto'}
          style={[
            styles.sheet,
            {
              maxHeight: Math.min(height * 0.82, 720),
              paddingBottom: Math.max(12, insets.bottom),
              backgroundColor: colors.backgroundFloat,
              transform: [{ translateY: progress.interpolate({ inputRange: [0, 1], outputRange: [height, 0] }) }],
            },
          ]}
        >
          <View style={[styles.titleBar, { borderBottomColor: colors.divider }]}>
            <Pressable
              style={({ pressed }) => [styles.titleAction, pressed && !busyActionId && { backgroundColor: colors.pressedFill }]}
              onPress={requestClose}
              disabled={Boolean(busyActionId)}
              accessibilityRole="button"
              accessibilityLabel="关闭本场待办"
              accessibilityState={{ disabled: Boolean(busyActionId) }}
            >
              <Ionicons name="close" size={24} color={busyActionId ? colors.iconDisabled : colors.iconPrimary} />
            </Pressable>
            <Text style={[styles.title, { color: colors.textTitle }]}>本场待办</Text>
            <Pressable
              style={({ pressed }) => [styles.titleAction, pressed && !busyActionId && { backgroundColor: colors.primarySoft }]}
              onPress={onCreate}
              disabled={Boolean(busyActionId)}
              accessibilityRole="button"
              accessibilityLabel="新建待办事项"
              accessibilityState={{ disabled: Boolean(busyActionId) }}
            >
              <Ionicons name="add" size={26} color={busyActionId ? colors.iconDisabled : colors.primary} />
            </Pressable>
          </View>

          <FlatList
            ref={listRef}
            data={visibleActions}
            keyExtractor={actionId}
            style={styles.list}
            bounces={false}
            showsVerticalScrollIndicator={false}
            getItemLayout={(_, index) => ({ length: ROW_HEIGHT, offset: ROW_HEIGHT * index, index })}
            onScrollToIndexFailed={({ index }) => {
              listRef.current?.scrollToOffset({ offset: ROW_HEIGHT * index, animated: false });
            }}
            ListEmptyComponent={loading ? (
              <View style={styles.empty}><ActivityIndicator size="small" color={colors.primary} /></View>
            ) : error ? (
              <View style={styles.empty}>
                <Text style={[styles.emptyText, { color: colors.textCaption }]}>待办暂时无法加载</Text>
                <Pressable
                  style={({ pressed }) => [styles.retry, pressed && { backgroundColor: colors.primarySoft }]}
                  onPress={onRetry}
                  accessibilityRole="button"
                  accessibilityLabel="重新加载本场待办"
                >
                  <Text style={[styles.retryText, { color: colors.primary }]}>重试</Text>
                </Pressable>
              </View>
            ) : (
              <View style={styles.empty}>
                <Text style={[styles.emptyText, { color: colors.textCaption }]}>暂无待办</Text>
              </View>
            )}
            renderItem={({ item }) => {
              const id = actionId(item);
              const conflicted = conflictedActionIds.has(id);
              const completed = item.status === 'completed';
              const busy = Boolean(busyActionId);
              const updating = busyActionId === id;
              const source = actionSource(item);
              const focused = focusActionId === id;
              return (
                <View
                  style={[
                    styles.row,
                    {
                      borderBottomColor: colors.divider,
                      backgroundColor: focused ? colors.primarySoft : colors.backgroundFloat,
                    },
                  ]}
                >
                  <Pressable
                    style={styles.checkTarget}
                    onPress={() => onToggle(id, !completed)}
                    disabled={busy || conflicted}
                    accessibilityRole="checkbox"
                    accessibilityLabel={completed ? `恢复待办事项：${item.content}` : `完成待办事项：${item.content}`}
                    accessibilityState={{ checked: completed, disabled: busy || conflicted, busy: updating }}
                  >
                    {updating ? (
                      <ActivityIndicator size="small" color={colors.primary} />
                    ) : (
                      <View
                        style={[
                          styles.check,
                          {
                            borderColor: conflicted
                              ? colors.danger
                              : completed ? colors.primary : colors.iconTertiary,
                            backgroundColor: completed ? colors.primary : colors.backgroundFloat,
                          },
                        ]}
                      >
                        {completed ? <Ionicons name="checkmark" size={15} color={colors.onPrimary} /> : null}
                      </View>
                    )}
                  </Pressable>

                  <Pressable
                    style={({ pressed }) => [styles.rowBody, pressed && !busy && { opacity: 0.72 }]}
                    onPress={() => onEdit(id)}
                    disabled={busy}
                    accessibilityRole="button"
                    accessibilityLabel={`编辑待办事项：${item.content}`}
                    accessibilityState={{ disabled: busy }}
                  >
                    <Text
                      style={[
                        styles.rowTitle,
                        {
                          color: completed ? colors.textCaption : colors.textTitle,
                          textDecorationLine: completed ? 'line-through' : 'none',
                        },
                      ]}
                      numberOfLines={2}
                    >
                      {item.content}
                    </Text>
                    <View style={styles.metadataRow}>
                      <Text
                        style={[styles.rowMeta, { color: conflicted ? colors.danger : colors.textCaption }]}
                        numberOfLines={1}
                      >
                        {actionMetadata(item, conflicted)}
                      </Text>
                      {source.available ? (
                        <Pressable
                          hitSlop={6}
                          onPress={event => {
                            event.stopPropagation();
                            onOpenSource(id);
                          }}
                          disabled={busy}
                          accessibilityRole="button"
                          accessibilityLabel={`查看待办来源，${source.label}`}
                        >
                          <Text style={[styles.source, { color: busy ? colors.textDisabled : colors.primary }]}>{source.label}</Text>
                        </Pressable>
                      ) : null}
                    </View>
                  </Pressable>

                  <Pressable
                    style={({ pressed }) => [styles.iconAction, pressed && !busy && { backgroundColor: colors.primarySoft }]}
                    onPress={() => onOpenFollowup(id)}
                    disabled={busy || conflicted || item.status !== 'pending'}
                    accessibilityRole="button"
                    accessibilityLabel={item.followupEventSourceId ? '查看后续日程' : '创建后续日程'}
                    accessibilityState={{ disabled: busy || conflicted || item.status !== 'pending' }}
                  >
                    <Ionicons
                      name={item.followupEventSourceId ? 'calendar' : 'calendar-outline'}
                      size={20}
                      color={busy || conflicted || item.status !== 'pending' ? colors.iconDisabled : colors.primary}
                    />
                  </Pressable>
                  <Ionicons name="chevron-forward" size={18} color={colors.iconTertiary} />
                </View>
              );
            }}
          />
          <View style={styles.errorSlot}>
            <Text style={[styles.errorText, { color: colors.danger }]} numberOfLines={2}>
              {visibleActions.length > 0 && error ? error : ' '}
            </Text>
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
  titleAction: { width: 60, height: 44, borderRadius: 6, alignItems: 'center', justifyContent: 'center' },
  title: { flex: 1, textAlign: 'center', fontSize: 17, lineHeight: 24, fontWeight: '400' },
  list: { flexGrow: 0, flexShrink: 1 },
  empty: { height: 144, alignItems: 'center', justifyContent: 'center' },
  emptyText: { fontSize: 14, lineHeight: 22 },
  retry: { minWidth: 60, height: 36, marginTop: 8, paddingHorizontal: 16, borderRadius: 6, alignItems: 'center', justifyContent: 'center' },
  retryText: { fontSize: 14, lineHeight: 22 },
  row: { height: ROW_HEIGHT, paddingLeft: 4, paddingRight: 8, flexDirection: 'row', alignItems: 'center', borderBottomWidth: StyleSheet.hairlineWidth },
  checkTarget: { width: 48, height: 48, alignItems: 'center', justifyContent: 'center' },
  check: { width: 22, height: 22, borderWidth: 1.5, borderRadius: 11, alignItems: 'center', justifyContent: 'center' },
  rowBody: { flex: 1, minWidth: 96, alignSelf: 'stretch', justifyContent: 'center', paddingRight: 8 },
  rowTitle: { fontSize: 15, lineHeight: 21, fontWeight: '400' },
  metadataRow: { marginTop: 3, flexDirection: 'row', alignItems: 'center', gap: 8 },
  rowMeta: { flexShrink: 1, fontSize: 12, lineHeight: 18 },
  source: { fontSize: 12, lineHeight: 18 },
  iconAction: { width: 44, height: 44, borderRadius: 6, alignItems: 'center', justifyContent: 'center' },
  errorSlot: { minHeight: 34, paddingHorizontal: 16, justifyContent: 'center' },
  errorText: { fontSize: 12, lineHeight: 18 },
});
