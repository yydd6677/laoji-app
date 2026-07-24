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
import type { CalEvent, EventRecurrenceScope, EventRef, RootStackParamList } from '../types';
import type { ScopeKey } from '../domain/meeting';
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
import {
  canEditRecurrenceRule,
  canStopRecurringSeries,
  recurrenceDeleteChoices,
  recurrenceDeleteDialog,
  recurrenceEditChoices,
  resolveRecurrenceEditScope,
} from '../services/recurrenceActions';
import { HttpResponseError, readableErrorMessage } from '../services/errors';
import { CurrentAddressError, getCurrentAddress } from '../services/currentAddress';
import {
  buildNativeCalendarEditSnapshot,
  nativeCalendarEditDraft,
} from '../native/nativeCalendarPages';
import { linkMeetingActionFollowup } from '../services/meetingActionFollowup';

type Props = {
  navigation: NativeStackNavigationProp<RootStackParamList, 'AddEvent'>;
  route: RouteProp<RootStackParamList, 'AddEvent'>;
};

type Choice = 'repeat' | 'reminder' | null;
type ScopeRequest = {
  kind: 'edit' | 'delete';
  onSelect: (scope: EventRecurrenceScope) => void;
};

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
    recurrenceUntilDate: provided?.recurrenceUntilDate,
    reminderMinutes: provided?.reminderMinutes ?? defaultReminderForEvent(allDay, explicitTime),
    location: provided?.location,
    description: provided?.description ?? provided?.detail,
  });
}

// CAL-EDIT-001 / CAL-REPEAT-RRULE-001 / UI-FORM-001: native inputs emit complete drafts;
// this route owns validation and writes.
export function AddEventScreen({ navigation, route }: Props) {
  const { events, searchableEvents, addEvent, updateEvent, deleteEvent } = useEvents();
  const { mode, session } = useAuth();
  const { showDialog } = useAppDialog();
  const editingRef = route.params?.eventRef;
  const editingEvent = editingRef
    ? resolveEventReference([...events, ...(searchableEvents ?? [])], editingRef) ?? undefined
    : undefined;
  const editing = Boolean(editingRef);
  const followup = editing ? undefined : route.params?.followup;
  const selectedRecurrenceScope = editingEvent
    ? resolveRecurrenceEditScope(editingEvent, route.params?.recurrenceScope)
    : undefined;
  const recurrenceRuleEditable = editingEvent
    ? canEditRecurrenceRule(editingEvent, selectedRecurrenceScope)
    : true;
  const allowStopRepeating = editingEvent
    ? canStopRecurringSeries(editingEvent, selectedRecurrenceScope)
    : true;
  const [draft, setDraft] = useState<NativeCalendarEditDraftSnapshot>(() => initialDraft(editingEvent, route.params));
  const [saving, setSaving] = useState(false);
  const [choice, setChoice] = useState<Choice>(null);
  const [scopeRequest, setScopeRequest] = useState<ScopeRequest | null>(null);
  const [feedback, setFeedback] = useState<{ key: number; message: string; durationMs: number } | null>(null);
  const [locating, setLocating] = useState(false);
  const locatingRef = useRef(false);
  const baselineRef = useRef(JSON.stringify(initialDraft(editingEvent, route.params)));
  const draftRef = useRef(draft);
  const mountedRef = useRef(true);
  const allowLeaveRef = useRef(false);
  const leavePromptOpenRef = useRef(false);
  const saveLockRef = useRef(false);
  const saveRunRef = useRef(0);
  const saveWriteStartedRef = useRef(false);
  const createRequestRef = useRef(followup
    ? { id: followup.clientRequestId, fingerprint: '' }
    : createClientRequestState('event'));
  const createdFollowupEventRef = useRef<EventRef | null>(null);
  const categoryRef = useRef<EventCategory>(normalizeEventCategory(editingEvent?.category ?? route.params?.draft?.category));
  const dirty = JSON.stringify(draft) !== baselineRef.current;
  draftRef.current = draft;

  const notificationScope = mode === 'authenticated' && session
    ? `user:${session.user.id}`
    : mode === 'guest' ? 'guest' : 'signed_out';
  const meetingScopeKey: ScopeKey | null = mode === 'authenticated' && session
    ? `user:${session.user.id}`
    : mode === 'guest' ? 'guest' : null;

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
    recurrenceUntilDate: value.repeat === 'once' ? undefined : value.recurrenceUntilDate ?? undefined,
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
    let followupEventSaved = false;
    try {
      if (editingEvent) {
        ({ reminderDelivery, syncStatus } = await updateEvent(eventRefForEvent(editingEvent), payload, recurrenceScope));
      } else {
        let createdEventRef = createdFollowupEventRef.current;
        if (!createdEventRef) {
          if (!followup) {
            createRequestRef.current = requestStateForPayload(createRequestRef.current, 'event', payload);
          }
          const created = await addEvent({
            ...payload,
            clientRequestId: createRequestRef.current.id,
          });
          ({ reminderDelivery, syncStatus } = created);
          createdEventRef = created.eventRef;
          if (followup) createdFollowupEventRef.current = createdEventRef;
        }
        if (followup) {
          followupEventSaved = true;
          if (!meetingScopeKey) throw new Error('当前登录状态无法关联后续日程');
          await linkMeetingActionFollowup(followup, meetingScopeKey, createdEventRef.sourceEventId);
        }
      }
    } catch (reason) {
      if (!activeSave(runId)) return;
      releaseSave(runId);
      const stale = reason instanceof HttpResponseError && reason.status === 409;
      showDialog({
        title: followupEventSaved ? '日程已创建，关联未完成' : stale ? '日程已发生变化' : '保存失败',
        message: followupEventSaved
          ? '再次点击保存可重试关联，不会重复创建日程。'
          : stale
            ? '该日程可能已在其他设备修改，请返回后重新打开再编辑。'
            : readableErrorMessage(reason, '请检查网络后重试'),
        tone: followupEventSaved || stale ? 'warning' : 'error',
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
    if (followup) {
      navigation.popTo('Transcription', {
        meetingId: followup.meetingId,
        focus: 'summary',
        actionId: followup.actionId,
        actionFocusRequestId: Date.now(),
      });
    } else {
      navigation.goBack();
    }
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

  const beginSave = useCallback((value: NativeCalendarEditDraftSnapshot) => {
    if (saveLockRef.current) return;
    const payload = payloadFromDraft(value);
    const validation = validateEventDraft(payload);
    if (!validation.valid || !validation.value) {
      const issue = validation.issues[0];
      showDialog({
        title: '日程信息不完整',
        message: issue?.message,
        tone: 'warning',
      });
      return;
    }
    const continueWithScope = (scope: EventRecurrenceScope) => {
      if (saveLockRef.current) return;
      saveLockRef.current = true;
      saveWriteStartedRef.current = false;
      const runId = saveRunRef.current + 1;
      saveRunRef.current = runId;
      setSaving(true);
      startWrite(runId, validation.value!, scope);
    };
    if (editingEvent?.repeat && editingEvent.repeat !== 'once' && !selectedRecurrenceScope) {
      setScopeRequest({ kind: 'edit', onSelect: continueWithScope });
    } else {
      continueWithScope(selectedRecurrenceScope ?? 'series');
    }
  }, [editingEvent, payloadFromDraft, selectedRecurrenceScope, showDialog]);

  const beginDelete = useCallback(() => {
    if (!editingEvent || saving) return;
    const remove = async (recurrenceScope: EventRecurrenceScope) => {
      setSaving(true);
      try {
        await deleteEvent(eventRefForEvent(editingEvent), recurrenceScope);
        allowLeaveRef.current = true;
        navigation.popTo('MainTabs', { screen: 'Schedule' });
      } catch {
        setSaving(false);
        showDialog({ title: '删除失败', message: '请检查网络后重试', tone: 'error' });
      }
    };
    if (editingEvent.repeat && editingEvent.repeat !== 'once') {
      setScopeRequest({ kind: 'delete', onSelect: scope => { void remove(scope); } });
    } else {
      showDialog(recurrenceDeleteDialog(editingEvent, scope => remove(scope)));
    }
  }, [deleteEvent, editingEvent, navigation, saving, showDialog]);

  const requestCurrentLocation = useCallback(async (value: NativeCalendarEditDraftSnapshot) => {
    if (locatingRef.current) return;
    locatingRef.current = true;
    setLocating(true);
    setDraft(value);
    try {
      const result = await getCurrentAddress();
      if (!mountedRef.current) return;
      setDraft(current => ({ ...current, location: result.address }));
      if (result.usedCoordinateFallback) {
        setFeedback(current => ({
          key: (current?.key ?? 0) + 1,
          message: '未能解析详细地址，已填入当前位置坐标。',
          durationMs: 4000,
        }));
      }
    } catch (reason) {
      if (!mountedRef.current) return;
      setFeedback(current => ({
        key: (current?.key ?? 0) + 1,
        message: reason instanceof CurrentAddressError
          ? reason.message
          : '暂时无法获取当前位置，请稍后重试。',
        durationMs: 4000,
      }));
    } finally {
      locatingRef.current = false;
      if (mountedRef.current) setLocating(false);
    }
  }, []);

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
        if (recurrenceRuleEditable) setChoice('repeat');
        break;
      case 'openReminder':
        setDraft(action.draft);
        setChoice('reminder');
        break;
      case 'requestCurrentLocation':
        void requestCurrentLocation(action.draft);
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
  }, [beginDelete, beginSave, recurrenceRuleEditable, requestCurrentLocation, requestLeave]);

  const choiceItems = useMemo<AppActionSheetItem[]>(() => {
    if (scopeRequest && editingEvent) {
      const choices = scopeRequest.kind === 'edit'
        ? recurrenceEditChoices(editingEvent)
        : recurrenceDeleteChoices(editingEvent);
      return choices.map(item => ({
        key: `scope-${item.scope}`,
        label: item.label,
        destructive: item.destructive,
        disabled: item.disabled,
        onPress: () => scopeRequest.onSelect(item.scope),
      }));
    }
    if (choice === 'repeat') {
      const allValues: Array<{ value: NativeCalendarEditDraftSnapshot['repeat']; label: string }> = [
        { value: 'once', label: '不重复' },
        { value: 'daily', label: '每天' },
        { value: 'weekly', label: '每周' },
        { value: 'monthly', label: '每月' },
        { value: 'yearly', label: '每年' },
      ];
      const values = allValues.filter(item => allowStopRepeating || item.value !== 'once');
      return values.map(item => ({
        key: item.value,
        label: `${draft.repeat === item.value ? '✓  ' : ''}${item.label}`,
        onPress: () => setDraft(current => ({
          ...current,
          repeat: item.value,
          recurrenceUntilDate: item.value === 'once' ? null : current.recurrenceUntilDate,
        })),
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
  }, [allowStopRepeating, choice, draft.reminderMinutes, draft.repeat, editingEvent, scopeRequest]);

  const missing = editing && !editingEvent;
  const snapshot = useMemo(() => buildNativeCalendarEditSnapshot({
    draft,
    editing,
    recurring: Boolean(editingEvent?.repeat && editingEvent.repeat !== 'once'),
    recurrenceException: Boolean(editingEvent?.isRecurrenceException),
    recurrenceScope: selectedRecurrenceScope ?? null,
    saving,
    dirty,
    locating,
    state: missing ? 'error' : 'ready',
    message: missing ? '日程不存在，请返回日程详情后重新打开编辑。' : undefined,
  }), [dirty, draft, editing, editingEvent?.isRecurrenceException, editingEvent?.repeat, locating, missing, saving, selectedRecurrenceScope]);

  return (
    <ScreenContainer edges={['top', 'bottom']} bg="#FFFFFF">
      <View
        style={styles.root}
        testID="event-editor-native-root"
        collapsable={false}
        collapsableChildren={false}
      >
        <LaojiCalendarEditView
          nativeID="feishu:CAL-REPEAT-RRULE-001:calendar-edit-native-surface"
          style={styles.surface}
          snapshot={snapshot}
          onAction={event => handleAction(event.nativeEvent)}
          testID="event-editor-native-surface"
        />
      </View>
      <AppActionSheet
        feishuEvidence="feishu:CAL-REPEAT-RRULE-001:calendar-edit-repeat-choice-sheet"
        visible={choice !== null || scopeRequest !== null}
        title={scopeRequest ? undefined : choice === 'repeat' ? '重复' : '提醒'}
        items={choiceItems}
        onClose={() => {
          setChoice(null);
          setScopeRequest(null);
        }}
      />
      <AppToast
        feishuEvidence="feishu:CAL-REPEAT-RRULE-001:calendar-edit-feedback-toast"
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
