import DateTimePicker from '@react-native-community/datetimepicker';
import type { RouteProp } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { ScreenContainer } from '../components/ScreenContainer';
import { SettingsTitleBar } from '../components/SettingsGroup';
import {
  fetchSharedMeetingAction,
  MeetingActionShareConflictError,
  updateSharedMeetingAction,
} from '../data/api/v2';
import {
  secureClientIdFactory,
  type SharedMeetingAction,
} from '../domain/meeting';
import { getMeetingActionCollaboratorId } from '../services/meetingActionCollaboration';
import { readableErrorMessage } from '../services/errors';
import { getFeishuTokens } from '../theme/feishuTokens';
import type { RootStackParamList } from '../types';

const { colors: F } = getFeishuTokens();

type Props = {
  navigation: NativeStackNavigationProp<RootStackParamList, 'SharedAction'>;
  route: RouteProp<RootStackParamList, 'SharedAction'>;
};

type Draft = {
  status: SharedMeetingAction['action']['status'];
  assignee: string;
  dueAtMs: number | null;
};

function dateLabel(value: number | null): string {
  if (value === null) return '未设置';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '未设置';
  return `${date.getFullYear()}年${date.getMonth() + 1}月${date.getDate()}日`;
}

function localDateStart(value: Date): number {
  return new Date(value.getFullYear(), value.getMonth(), value.getDate()).getTime();
}

function draftFrom(value: SharedMeetingAction): Draft {
  return {
    status: value.action.status,
    assignee: value.action.assignee ?? '',
    dueAtMs: value.action.dueAtMs,
  };
}

function statusLabel(value: Draft['status']): string {
  if (value === 'completed') return '已完成';
  if (value === 'dismissed') return '已忽略';
  return '待完成';
}

export function SharedActionScreen({ navigation, route }: Props) {
  const [shared, setShared] = useState<SharedMeetingAction | null>(null);
  const [draft, setDraft] = useState<Draft>({ status: 'pending', assignee: '', dueAtMs: null });
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [showDatePicker, setShowDatePicker] = useState(false);
  const [conflict, setConflict] = useState<{
    current: SharedMeetingAction;
    local: Draft;
  } | null>(null);
  const mountedRef = useRef(true);
  const loadAbortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      loadAbortRef.current?.abort();
      loadAbortRef.current = null;
    };
  }, []);

  const load = useCallback(async () => {
    loadAbortRef.current?.abort();
    const controller = new AbortController();
    loadAbortRef.current = controller;
    setLoading(true);
    setError('');
    try {
      const result = await fetchSharedMeetingAction(route.params.token, controller.signal);
      if (!mountedRef.current || loadAbortRef.current !== controller) return;
      setShared(result);
      setDraft(draftFrom(result));
      setConflict(null);
    } catch (reason) {
      if (mountedRef.current && loadAbortRef.current === controller) {
        setError(readableErrorMessage(reason, '共享待办暂时无法打开，请稍后重试。'));
      }
    } finally {
      if (mountedRef.current && loadAbortRef.current === controller) {
        loadAbortRef.current = null;
        setLoading(false);
      }
    }
  }, [route.params.token]);

  useEffect(() => { void load(); }, [load]);

  const saveAtRevision = useCallback(async (
    value: Draft,
    expectedRevision: number,
  ) => {
    if (saving) return;
    setSaving(true);
    setError('');
    try {
      const actorId = await getMeetingActionCollaboratorId();
      const updated = await updateSharedMeetingAction({
        token: route.params.token,
        expectedActionRevision: expectedRevision,
        idempotencyKey: secureClientIdFactory.create(),
        actorId,
        status: value.status,
        assignee: value.assignee.trim() || null,
        dueAtMs: value.dueAtMs,
      });
      if (!mountedRef.current) return;
      setShared(updated);
      setDraft(draftFrom(updated));
      setConflict(null);
    } catch (reason) {
      if (!mountedRef.current) return;
      if (reason instanceof MeetingActionShareConflictError) {
        try {
          const current = await fetchSharedMeetingAction(route.params.token);
          if (mountedRef.current) setConflict({ current, local: value });
        } catch (refreshReason) {
          if (mountedRef.current) {
            setError(readableErrorMessage(refreshReason, '待办已更新，但最新版本暂时无法读取。'));
          }
        }
      } else {
        setError(readableErrorMessage(reason, '共享待办暂时无法保存，请稍后重试。'));
      }
    } finally {
      if (mountedRef.current) setSaving(false);
    }
  }, [route.params.token, saving]);

  const canEdit = shared?.permission === 'action_editor' && shared.status === 'active';
  const changed = Boolean(shared) && (
    draft.status !== shared!.action.status
    || draft.assignee.trim() !== (shared!.action.assignee ?? '')
    || draft.dueAtMs !== shared!.action.dueAtMs
  );
  const canSave = canEdit && changed && !saving && !conflict;

  return (
    <ScreenContainer bg={F.backgroundBody}>
      <SettingsTitleBar title="共享待办" onBack={() => navigation.goBack()} />
      {loading ? (
        <View style={styles.center}>
          <ActivityIndicator color={F.primary} />
          <Text style={[styles.stateText, { color: F.textCaption }]}>正在加载</Text>
        </View>
      ) : !shared ? (
        <View style={styles.center}>
          <Text style={[styles.stateTitle, { color: F.textTitle }]}>无法打开共享待办</Text>
          <Text style={[styles.stateText, { color: F.textCaption }]}>{error}</Text>
          <Pressable
            style={({ pressed }) => [
              styles.retry,
              { backgroundColor: pressed ? F.primaryPressed : F.primary },
            ]}
            onPress={() => { void load(); }}
            accessibilityRole="button"
            accessibilityLabel="重试加载共享待办"
          >
            <Text style={[styles.primaryText, { color: F.onPrimary }]}>重试</Text>
          </Pressable>
        </View>
      ) : shared.status === 'revoked' ? (
        <View style={styles.center}>
          <Text style={[styles.stateTitle, { color: F.textTitle }]}>共享已撤销</Text>
          <Text style={[styles.stateText, { color: F.textCaption }]}>此链接已不再提供待办内容。</Text>
        </View>
      ) : (
        <ScrollView
          contentContainerStyle={styles.content}
          keyboardShouldPersistTaps="handled"
          keyboardDismissMode="on-drag"
          showsVerticalScrollIndicator={false}
        >
          <View style={[styles.card, { backgroundColor: F.backgroundFloat }]}>
            <View style={styles.cardHeader}>
              <View style={[styles.permission, { backgroundColor: F.primarySoft }]}>
                <Text style={[styles.permissionText, { color: F.primary }]}>
                  {canEdit ? '可编辑待办' : '仅查看'}
                </Text>
              </View>
              <Text style={[styles.revision, { color: F.textCaption }]}>版本 {shared.action.revision}</Text>
            </View>
            <Text style={[styles.actionContent, { color: F.textTitle }]}>{shared.action.content}</Text>
            <Text style={[styles.updated, { color: F.textCaption }]}>最近由{shared.action.actorLabel}更新</Text>
          </View>

          <Text style={[styles.sectionTitle, { color: F.textCaption }]}>状态</Text>
          <View style={styles.statusRow}>
            {(['pending', 'completed', 'dismissed'] as const).map(value => {
              const selected = draft.status === value;
              return (
                <Pressable
                  key={value}
                  style={({ pressed }) => [
                    styles.statusButton,
                    {
                      backgroundColor: selected ? F.primarySoft : F.backgroundFloat,
                      borderColor: selected ? F.primary : F.divider,
                    },
                    pressed && canEdit && { backgroundColor: F.pressedFill },
                  ]}
                  onPress={() => setDraft(current => ({ ...current, status: value }))}
                  disabled={!canEdit || saving}
                  accessibilityRole="button"
                  accessibilityLabel={`将待办设为${statusLabel(value)}`}
                  accessibilityState={{ selected, disabled: !canEdit || saving }}
                >
                  <Text style={[styles.statusText, { color: selected ? F.primary : canEdit ? F.textTitle : F.textDisabled }]}>
                    {statusLabel(value)}
                  </Text>
                </Pressable>
              );
            })}
          </View>

          <Text style={[styles.sectionTitle, { color: F.textCaption }]}>负责人</Text>
          <TextInput
            value={draft.assignee}
            onChangeText={value => setDraft(current => ({ ...current, assignee: value }))}
            editable={canEdit && !saving}
            maxLength={500}
            placeholder="未设置"
            placeholderTextColor={F.textPlaceholder}
            style={[
              styles.input,
              {
                color: canEdit ? F.textTitle : F.textDisabled,
                backgroundColor: canEdit ? F.backgroundFloat : F.backgroundBase,
                borderColor: F.divider,
              },
            ]}
            accessibilityLabel="共享待办负责人"
          />

          <Text style={[styles.sectionTitle, { color: F.textCaption }]}>截止日期</Text>
          <Pressable
            style={({ pressed }) => [
              styles.dateRow,
              {
                backgroundColor: canEdit ? pressed ? F.pressedFill : F.backgroundFloat : F.backgroundBase,
                borderColor: F.divider,
              },
            ]}
            onPress={() => setShowDatePicker(true)}
            disabled={!canEdit || saving}
            accessibilityRole="button"
            accessibilityLabel={`共享待办截止日期，${dateLabel(draft.dueAtMs)}`}
          >
            <Text style={[styles.dateText, { color: draft.dueAtMs === null ? F.textPlaceholder : F.textTitle }]}>
              {dateLabel(draft.dueAtMs)}
            </Text>
            {draft.dueAtMs !== null && canEdit ? (
              <Pressable
                hitSlop={10}
                onPress={event => {
                  event.stopPropagation();
                  setDraft(current => ({ ...current, dueAtMs: null }));
                }}
                accessibilityRole="button"
                accessibilityLabel="清除共享待办截止日期"
              >
                <Text style={[styles.clear, { color: F.primary }]}>清除</Text>
              </Pressable>
            ) : null}
          </Pressable>
          {showDatePicker ? (
            <DateTimePicker
              value={draft.dueAtMs === null ? new Date() : new Date(draft.dueAtMs)}
              mode="date"
              display="default"
              onChange={(event, value) => {
                if (Platform.OS === 'android') setShowDatePicker(false);
                if (event.type !== 'dismissed' && value) {
                  setDraft(current => ({ ...current, dueAtMs: localDateStart(value) }));
                }
              }}
            />
          ) : null}

          <View style={styles.feedbackSlot}>
            {error ? <Text style={[styles.error, { color: F.danger }]}>{error}</Text> : null}
          </View>

          {conflict ? (
            <View style={[styles.conflict, { backgroundColor: F.backgroundFloat, borderColor: F.divider }]}>
              <Text style={[styles.conflictTitle, { color: F.textTitle }]}>待办已被其他协作者更新</Text>
              <View style={styles.conflictActions}>
                <Pressable
                  style={({ pressed }) => [styles.secondaryButton, { borderColor: F.divider }, pressed && { backgroundColor: F.pressedFill }]}
                  onPress={() => {
                    setShared(conflict.current);
                    setDraft(draftFrom(conflict.current));
                    setConflict(null);
                  }}
                  accessibilityRole="button"
                  accessibilityLabel="使用共享待办最新版本"
                >
                  <Text style={[styles.secondaryText, { color: F.textTitle }]}>使用最新版本</Text>
                </Pressable>
                <Pressable
                  style={({ pressed }) => [styles.primaryHalf, { backgroundColor: pressed ? F.primaryPressed : F.primary }]}
                  onPress={() => { void saveAtRevision(conflict.local, conflict.current.action.revision); }}
                  disabled={saving}
                  accessibilityRole="button"
                  accessibilityLabel="保留我的共享待办修改"
                >
                  {saving ? <ActivityIndicator color={F.onPrimary} /> : (
                    <Text style={[styles.secondaryText, { color: F.onPrimary }]}>保留我的修改</Text>
                  )}
                </Pressable>
              </View>
            </View>
          ) : canEdit ? (
            <Pressable
              style={({ pressed }) => [
                styles.save,
                { backgroundColor: canSave ? pressed ? F.primaryPressed : F.primary : F.backgroundBase },
              ]}
              onPress={() => { void saveAtRevision(draft, shared.action.revision); }}
              disabled={!canSave}
              accessibilityRole="button"
              accessibilityLabel="保存共享待办修改"
              accessibilityState={{ disabled: !canSave, busy: saving }}
            >
              {saving ? <ActivityIndicator color={F.onPrimary} /> : (
                <Text style={[styles.primaryText, { color: canSave ? F.onPrimary : F.textDisabled }]}>保存</Text>
              )}
            </Pressable>
          ) : null}

          <Text style={[styles.privacy, { color: F.textCaption }]}>此链接只包含这条待办事项，不包含会议内容。</Text>
        </ScrollView>
      )}
    </ScreenContainer>
  );
}

const styles = StyleSheet.create({
  center: { flex: 1, paddingHorizontal: 24, alignItems: 'center', justifyContent: 'center' },
  stateTitle: { fontSize: 18, lineHeight: 25, fontWeight: '500', textAlign: 'center' },
  stateText: { marginTop: 8, fontSize: 14, lineHeight: 21, textAlign: 'center' },
  retry: { marginTop: 24, minWidth: 104, height: 48, borderRadius: 6, alignItems: 'center', justifyContent: 'center' },
  content: { paddingHorizontal: 16, paddingTop: 16, paddingBottom: 28 },
  card: { borderRadius: 8, padding: 16 },
  cardHeader: { flexDirection: 'row', alignItems: 'center' },
  permission: { height: 28, borderRadius: 6, paddingHorizontal: 10, alignItems: 'center', justifyContent: 'center' },
  permissionText: { fontSize: 13, lineHeight: 20 },
  revision: { flex: 1, textAlign: 'right', fontSize: 12, lineHeight: 18 },
  actionContent: { marginTop: 14, fontSize: 17, lineHeight: 25 },
  updated: { marginTop: 8, fontSize: 12, lineHeight: 18 },
  sectionTitle: { marginTop: 18, marginBottom: 6, fontSize: 13, lineHeight: 20 },
  statusRow: { flexDirection: 'row', gap: 8 },
  statusButton: { flex: 1, height: 40, borderWidth: 1, borderRadius: 6, alignItems: 'center', justifyContent: 'center' },
  statusText: { fontSize: 14, lineHeight: 22 },
  input: { height: 48, borderWidth: 1, borderRadius: 6, paddingHorizontal: 12, fontSize: 16, lineHeight: 23 },
  dateRow: { height: 48, borderWidth: 1, borderRadius: 6, paddingHorizontal: 12, flexDirection: 'row', alignItems: 'center' },
  dateText: { flex: 1, fontSize: 16, lineHeight: 23 },
  clear: { fontSize: 14, lineHeight: 22, paddingHorizontal: 4 },
  feedbackSlot: { minHeight: 36, justifyContent: 'center' },
  error: { fontSize: 13, lineHeight: 18 },
  save: { height: 48, borderRadius: 6, alignItems: 'center', justifyContent: 'center' },
  primaryText: { fontSize: 17, lineHeight: 24, fontWeight: '400' },
  privacy: { marginTop: 16, fontSize: 12, lineHeight: 18, textAlign: 'center' },
  conflict: { borderWidth: 1, borderRadius: 8, padding: 12 },
  conflictTitle: { fontSize: 15, lineHeight: 22, fontWeight: '500' },
  conflictActions: { marginTop: 12, flexDirection: 'row', gap: 8 },
  secondaryButton: { flex: 1, height: 40, borderWidth: 1, borderRadius: 6, alignItems: 'center', justifyContent: 'center' },
  primaryHalf: { flex: 1, height: 40, borderRadius: 6, alignItems: 'center', justifyContent: 'center' },
  secondaryText: { fontSize: 14, lineHeight: 22 },
});
