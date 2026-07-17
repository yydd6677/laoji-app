import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import type { NavigationAction, RouteProp } from '@react-navigation/native';
import {
  LaojiCalendarEditView,
  type NativeCalendarEditAction,
  type NativeCalendarEditDraftSnapshot,
} from 'laoji-native-platform';
import { ScreenContainer } from '../components/ScreenContainer';
import { AppActionSheet, type AppActionSheetItem } from '../components/AppActionSheet';
import { AppToast } from '../components/AppToast';
import { useAppDialog } from '../components/AppDialog';
import { useEvents } from '../store/EventsStore';
import { useAuth } from '../store/AuthStore';
import type { CalEvent, EventRecurrenceScope, RootStackParamList } from '../types';
import {
  DEFAULT_REMINDER_MINUTES,
  REMINDER_OPTIONS,
  defaultReminderForEvent,
  loadNotificationPrefs,
  reminderUnavailableMessage,
  type ReminderMinutes,
} from '../services/notifications';
import { normalizeEventCategory, type EventCategory } from '../utils/eventColors';
import { createClientRequestState, requestStateForPayload } from '../services/clientRequestId';
import { eventRefForEvent } from '../utils/eventIdentity';
import { resolveEventReference } from '../utils/eventRecurrence';
import { validateEventDraft } from '../utils/eventDraftValidation';
import { recurrenceDeleteDialog, recurrenceEditDialog } from '../services/recurrenceActions';
import { HttpResponseError, readableErrorMessage } from '../services/errors';
import {
  buildNativeCalendarEditSnapshot,
  nativeCalendarEditDraft,
} from '../native/nativeCalendarPages';

type Props = {
  navigation: NativeStackNavigationProp<RootStackParamList, 'AddEvent'>;
  route: RouteProp<RootStackParamList, 'AddEvent'>;
};

type Choice = 'repeat' | 'reminder' | null;

function localDateKey(date = new Date()): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function addMinutes(value: string, minutes: number): string {
  const [hour, minute] = value.split(':').map(Number);
  const total = ((hour * 60 + minute + minutes) % 1440 + 1440) % 1440;
  return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
}

function initialDraft(
  editing: CalEvent | undefined,
  route: RouteProp<RootStackParamList, 'AddEvent'>['params'],
): NativeCalendarEditDraftSnapshot {
  if (editing) return nativeCalendarEditDraft(editing);
  const provided = route?.draft;
  const startDate = provided?.startDate ?? route?.date ?? localDateKey();
  const allDay = Boolean(provided?.isAllDay);
  const explicitTime = provided
    ? provided.startTime
    : route?.startTime ?? '10:00';
  const endTime = provided
    ? provided.endTime
    : route?.endTime ?? (explicitTime ? addMinutes(explicitTime, 30) : undefined);
  return nativeCalendarEditDraft({
    title: provided?.title ?? '',
    startDate,
    endDate: provided?.endDate ?? route?.endDate ?? startDate,
    startTime: allDay ? undefined : explicitTime,
    endTime: allDay ? undefined : endTime,
    isAllDay: allDay,
    repeat: provided?.repeat ?? 'once',
    reminderMinutes: provided?.reminderMinutes ?? defaultReminderForEvent(allDay, explicitTime),
    location: provided?.location,
    description: provided?.description ?? provided?.detail,
  });
}

// CAL-EDIT-001 / UI-FORM-001: native inputs emit complete drafts; this route owns validation and writes.
export function AddEventScreen({ navigation, route }: Props) {
  const { events, searchableEvents, addEvent, updateEvent, deleteEvent, findConflicts } = useEvents();
  const { mode, session } = useAuth();
  const { showDialog } = useAppDialog();
  const editingRef = route.params?.eventRef;
  const editingEvent = editingRef
    ? resolveEventReference([...events, ...(searchableEvents ?? [])], editingRef) ?? undefined
    : undefined;
  const editing = Boolean(editingRef);
  const [draft, setDraft] = useState<NativeCalendarEditDraftSnapshot>(() => initialDraft(editingEvent, route.params));
  const [saving, setSaving] = useState(false);
  const [choice, setChoice] = useState<Choice>(null);
  const [feedback, setFeedback] = useState<{ key: number; message: string; durationMs: number } | null>(null);
  const baselineRef = useRef(JSON.stringify(initialDraft(editingEvent, route.params)));
  const draftRef = useRef(draft);
  const mountedRef = useRef(true);
  const allowLeaveRef = useRef(false);
  const leavePromptOpenRef = useRef(false);
  const saveLockRef = useRef(false);
  const saveRunRef = useRef(0);
  const saveWriteStartedRef = useRef(false);
  const createRequestRef = useRef(createClientRequestState('event'));
  const categoryRef = useRef<EventCategory>(normalizeEventCategory(editingEvent?.category ?? route.params?.draft?.category));
  const dirty = JSON.stringify(draft) !== baselineRef.current;
  draftRef.current = draft;

  const notificationScope = mode === 'authenticated' && session
    ? `user:${session.user.id}`
    : mode === 'guest' ? 'guest' : 'signed_out';

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      saveRunRef.current += 1;
      saveLockRef.current = false;
      saveWriteStartedRef.current = false;
    };
  }, []);

  useEffect(() => {
    if (!editingEvent) return;
    const next = nativeCalendarEditDraft(editingEvent);
    baselineRef.current = JSON.stringify(next);
    draftRef.current = next;
    categoryRef.current = normalizeEventCategory(editingEvent.category);
    setDraft(next);
  }, [editingEvent?.id]);

  useEffect(() => {
    if (editing || route.params?.draft) return;
    let active = true;
    void loadNotificationPrefs(notificationScope).then(preferences => {
      if (!active) return;
      setDraft(current => {
        if (JSON.stringify(current) !== baselineRef.current) return current;
        const next = {
          ...current,
          reminderMinutes: defaultReminderForEvent(
            current.isAllDay,
            current.startTime ?? undefined,
            preferences.defaultReminderMinutes,
          ),
        };
        baselineRef.current = JSON.stringify(next);
        return next;
      });
    });
    return () => { active = false; };
  }, [editing, notificationScope, route.params?.draft]);

  const requestLeave = useCallback((action?: NavigationAction) => {
    if (saveLockRef.current) return;
    if (allowLeaveRef.current || JSON.stringify(draftRef.current) === baselineRef.current) {
      if (action) navigation.dispatch(action);
      else navigation.goBack();
      return;
    }
    if (leavePromptOpenRef.current) return;
    leavePromptOpenRef.current = true;
    showDialog({
      title: '退出当前日程编辑？',
      message: '未保存的更改将会丢失。',
      tone: 'warning',
      onDismiss: () => { leavePromptOpenRef.current = false; },
      actions: [
        {
          text: '退出',
          role: 'destructive',
          onPress: () => {
            allowLeaveRef.current = true;
            leavePromptOpenRef.current = false;
            if (action) navigation.dispatch(action);
            else navigation.goBack();
          },
        },
        { text: '继续编辑', role: 'cancel', onPress: () => { leavePromptOpenRef.current = false; } },
      ],
    });
  }, [navigation, showDialog]);

  useEffect(() => navigation.addListener('beforeRemove', event => {
    if (allowLeaveRef.current) return;
    if (saveLockRef.current) {
      event.preventDefault();
      return;
    }
    if (JSON.stringify(draftRef.current) === baselineRef.current) return;
    event.preventDefault();
    requestLeave(event.data.action);
  }), [navigation, requestLeave]);

  const payloadFromDraft = useCallback((value: NativeCalendarEditDraftSnapshot): Omit<CalEvent, 'id'> => ({
    title: value.title.trim(),
    startDate: value.startDate,
    endDate: value.endDate !== value.startDate ? value.endDate : undefined,
    spanning: value.endDate !== value.startDate,
    startTime: value.isAllDay ? undefined : value.startTime ?? undefined,
    endTime: value.isAllDay ? undefined : value.endTime ?? undefined,
    isAllDay: value.isAllDay,
    repeat: value.repeat,
    description: value.notes,
    rawText: route.params?.draft?.rawText,
    color: '#1456F0',
    category: categoryRef.current,
    location: value.location || undefined,
    detail: route.params?.draft?.detail,
    status: route.params?.draft?.status,
    reminderMinutes: value.isAllDay || !value.startTime ? null : value.reminderMinutes,
  }), [route.params?.draft]);

  const activeSave = (runId: number) => mountedRef.current
    && saveLockRef.current
    && saveRunRef.current === runId;

  const releaseSave = (runId: number) => {
    if (!activeSave(runId)) return;
    saveLockRef.current = false;
    saveWriteStartedRef.current = false;
    setSaving(false);
  };

  const writeEvent = async (
    runId: number,
    payload: Omit<CalEvent, 'id'>,
    recurrenceScope: EventRecurrenceScope,
  ) => {
    let reminderDelivery: Awaited<ReturnType<typeof addEvent>>['reminderDelivery'] | undefined;
    let syncStatus: Awaited<ReturnType<typeof addEvent>>['syncStatus'] | undefined;
    try {
      if (editingEvent) {
        ({ reminderDelivery, syncStatus } = await updateEvent(eventRefForEvent(editingEvent), payload, recurrenceScope));
      } else {
        createRequestRef.current = requestStateForPayload(createRequestRef.current, 'event', payload);
        ({ reminderDelivery, syncStatus } = await addEvent({
          ...payload,
          clientRequestId: createRequestRef.current.id,
        }));
      }
    } catch (reason) {
      if (!activeSave(runId)) return;
      releaseSave(runId);
      const stale = reason instanceof HttpResponseError && reason.status === 409;
      showDialog({
        title: stale ? '日程已发生变化' : '保存失败',
        message: stale
          ? '该日程可能已在其他设备修改，请返回后重新打开再编辑。'
          : readableErrorMessage(reason, '请检查网络后重试'),
        tone: stale ? 'warning' : 'error',
      });
      return;
    }
    if (!activeSave(runId)) return;
    let warning: string | undefined;
    if (syncStatus === 'pending') warning = '保存请求已记录，将在网络恢复后自动确认。';
    else if (reminderDelivery === 'unavailable') {
      warning = await reminderUnavailableMessage().catch(() => '本机提醒创建失败，请重新打开日程并保存提醒。');
    } else if (reminderDelivery === 'unconfirmed') {
      warning = '本机提醒状态未能确认，可重新打开日程并保存提醒。';
    }
    if (!activeSave(runId)) return;
    allowLeaveRef.current = true;
    navigation.goBack();
    if (warning) showDialog({
      title: syncStatus === 'pending' ? '日程等待同步' : '日程已保存',
      message: warning,
      tone: 'warning',
    });
  };

  const startWrite = (
    runId: number,
    payload: Omit<CalEvent, 'id'>,
    recurrenceScope: EventRecurrenceScope,
  ) => {
    if (!activeSave(runId) || saveWriteStartedRef.current) return;
    saveWriteStartedRef.current = true;
    void writeEvent(runId, payload, recurrenceScope);
  };

  const checkConflicts = async (
    runId: number,
    payload: Omit<CalEvent, 'id'>,
    recurrenceScope: EventRecurrenceScope,
  ) => {
    let result: Awaited<ReturnType<typeof findConflicts>>;
    try {
      result = await findConflicts(payload, editingRef, recurrenceScope);
    } catch {
      if (!activeSave(runId)) return;
      releaseSave(runId);
      showDialog({ title: '暂时无法检查日程冲突', message: '请稍后重试', tone: 'warning' });
      return;
    }
    if (!activeSave(runId)) return;
    if (!result.hasConflict) {
      startWrite(runId, payload, recurrenceScope);
      return;
    }
    const explicit = result.conflicts.some(conflict => conflict.severity === 'overlap');
    const names = result.conflicts.map(({ event }) => {
      const time = event.startTime && event.endTime
        ? `${event.startTime}-${event.endTime}`
        : event.isAllDay ? '全天' : '无具体时间';
      return `• ${event.title} (${time})`;
    }).join('\n');
    showDialog({
      title: explicit ? '时间冲突' : '全天安排提示',
      message: `${explicit ? '该安排与以下日程重叠' : '该日期已有安排'}：\n${names}`,
      hint: result.complete ? '确认这些安排可以重叠后再保存。' : '当前只能核对本机已有日程。',
      tone: 'warning',
      onDismiss: () => releaseSave(runId),
      actions: [
        { text: '仍然保存', role: 'primary', onPress: () => startWrite(runId, payload, recurrenceScope) },
        { text: '取消', role: 'cancel', onPress: () => releaseSave(runId) },
      ],
    });
  };

  const beginSave = useCallback((value: NativeCalendarEditDraftSnapshot) => {
    if (saveLockRef.current) return;
    const payload = payloadFromDraft(value);
    const validation = validateEventDraft(payload);
    if (!validation.valid || !validation.value) {
      const issue = validation.issues[0];
      showDialog({
        title: issue?.code === 'missing-title' ? issue.message : '日程信息不完整',
        message: issue?.code === 'missing-title' ? undefined : issue?.message,
        tone: issue?.code === 'missing-title' ? 'info' : 'warning',
      });
      return;
    }
    saveLockRef.current = true;
    saveWriteStartedRef.current = false;
    const runId = saveRunRef.current + 1;
    saveRunRef.current = runId;
    setSaving(true);
    const continueWithScope = (scope: EventRecurrenceScope) => {
      if (activeSave(runId)) void checkConflicts(runId, validation.value!, scope);
    };
    if (editingEvent?.repeat && editingEvent.repeat !== 'once') {
      showDialog(recurrenceEditDialog(editingEvent, continueWithScope, () => releaseSave(runId)));
    } else {
      continueWithScope('series');
    }
  }, [editingEvent, payloadFromDraft, showDialog]);

  const beginDelete = useCallback(() => {
    if (!editingEvent || saving) return;
    showDialog(recurrenceDeleteDialog(editingEvent, async recurrenceScope => {
      setSaving(true);
      try {
        await deleteEvent(eventRefForEvent(editingEvent), recurrenceScope);
        allowLeaveRef.current = true;
        navigation.navigate('MainTabs', { screen: 'Schedule' });
      } catch {
        setSaving(false);
        showDialog({ title: '删除失败', message: '请检查网络后重试', tone: 'error' });
      }
    }));
  }, [deleteEvent, editingEvent, navigation, saving, showDialog]);

  const handleAction = useCallback((action: NativeCalendarEditAction) => {
    switch (action.type) {
      case 'cancel':
        requestLeave();
        break;
      case 'draftChange':
        setDraft(action.draft);
        break;
      case 'openRepeat':
        setDraft(action.draft);
        setChoice('repeat');
        break;
      case 'openReminder':
        setDraft(action.draft);
        setChoice('reminder');
        break;
      case 'save':
        setDraft(action.draft);
        beginSave(action.draft);
        break;
      case 'delete':
        beginDelete();
        break;
      case 'feedback':
        setFeedback(current => ({
          key: (current?.key ?? 0) + 1,
          message: action.message,
          durationMs: action.durationMs ?? 3000,
        }));
        break;
      default:
        break;
    }
  }, [beginDelete, beginSave, requestLeave]);

  const choiceItems = useMemo<AppActionSheetItem[]>(() => {
    if (choice === 'repeat') {
      const values: Array<{ value: NativeCalendarEditDraftSnapshot['repeat']; label: string }> = [
        { value: 'once', label: '不重复' },
        { value: 'daily', label: '每天' },
        { value: 'weekly', label: '每周' },
        { value: 'monthly', label: '每月' },
        { value: 'yearly', label: '每年' },
      ];
      return values.map(item => ({
        key: item.value,
        label: `${draft.repeat === item.value ? '✓  ' : ''}${item.label}`,
        onPress: () => setDraft(current => ({ ...current, repeat: item.value })),
      }));
    }
    if (choice === 'reminder') {
      return REMINDER_OPTIONS.map(item => ({
        key: String(item.value),
        label: `${draft.reminderMinutes === item.value ? '✓  ' : ''}${item.label}`,
        onPress: () => setDraft(current => ({ ...current, reminderMinutes: item.value })),
      }));
    }
    return [];
  }, [choice, draft.reminderMinutes, draft.repeat]);

  const missing = editing && !editingEvent;
  const snapshot = useMemo(() => buildNativeCalendarEditSnapshot({
    draft,
    editing,
    recurring: Boolean(editingEvent?.repeat && editingEvent.repeat !== 'once'),
    recurrenceException: Boolean(editingEvent?.isRecurrenceException),
    saving,
    dirty,
    state: missing ? 'error' : 'ready',
    message: missing ? '日程不存在，请返回日程详情后重新打开编辑。' : undefined,
  }), [dirty, draft, editing, editingEvent?.isRecurrenceException, editingEvent?.repeat, missing, saving]);

  return (
    <ScreenContainer edges={['top', 'bottom']} bg="#FFFFFF">
      <View
        style={styles.root}
        testID="event-editor-native-root"
        collapsable={false}
        collapsableChildren={false}
      >
        <LaojiCalendarEditView
          style={styles.surface}
          snapshot={snapshot}
          onAction={event => handleAction(event.nativeEvent)}
          testID="event-editor-native-surface"
        />
      </View>
      <AppActionSheet
        visible={choice !== null}
        title={choice === 'repeat' ? '重复' : '提醒'}
        items={choiceItems}
        onClose={() => setChoice(null)}
      />
      <AppToast
        visible={feedback !== null}
        message={feedback?.message ?? ''}
        autoHideDurationMs={feedback?.durationMs ?? 3000}
        bottom={24}
        presentationKey={feedback?.key ?? 0}
        onDismiss={() => setFeedback(null)}
        testID="event-editor-feedback-toast"
      />
    </ScreenContainer>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  surface: { flex: 1 },
});
