import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import type { NavigationAction, RouteProp } from '@react-navigation/native';
import type {
  NativeCalendarEditAction,
  NativeCalendarEditDraftSnapshot,
} from 'laoji-native-platform';
import { ScheduleEditorSurface } from '../components/ScheduleEditorSurface';
import { ScreenContainer } from '../components/ScreenContainer';
import { AppActionSheet, type AppActionSheetItem } from '../components/AppActionSheet';
import { AppToast } from '../components/AppToast';
import { useAppDialog } from '../components/AppDialog';
import { useEvents } from '../store/EventsStore';
import type { CalEvent, EventRecurrenceScope, EventRef, RootStackParamList } from '../types';
import {
  REMINDER_OPTIONS,
  defaultReminderForEvent,
  loadNotificationPrefs,
  reminderUnavailableMessage,
} from '../services/notifications';
import { normalizeEventCategory } from '../utils/eventColors';
import { createClientRequestState } from '../services/clientRequestId';
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
  nativeDraftFromScheduleEditor,
  scheduleEditorChangesFromNative,
} from '../native/nativeCalendarPages';
import { createScheduleEditorDraft, editScheduleFields, type ScheduleEditorDraft } from '../domain/scheduleEditor';
import { scheduleTimeForEvent } from '../utils/scheduleEventTime';
import { useScheduleEditorDraft } from '../hooks/useScheduleEditorDraft';
import { useScheduleEditorInput } from '../hooks/useScheduleEditorInput';
import { useTheme } from '../theme/ThemeProvider';

type Props = {
  navigation: NativeStackNavigationProp<RootStackParamList, 'AddEvent'>;
  route: RouteProp<RootStackParamList, 'AddEvent'>;
};

type Choice = 'repeat' | 'reminder' | 'input' | null;
type ScopeRequest = {
  kind: 'edit' | 'delete';
  onSelect: (scope: EventRecurrenceScope) => void;
};

function localDateKey(date = new Date()): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
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
    : route?.startTime;
  const endTime = provided
    ? provided.endTime
    : route?.endTime;
  return nativeCalendarEditDraft({
    title: provided?.title ?? '',
    startDate,
    endDate: provided?.endDate ?? route?.endDate ?? startDate,
    startTime: allDay ? undefined : explicitTime,
    endTime: allDay ? undefined : endTime,
    isAllDay: allDay,
    timePrecision: provided?.timePrecision,
    timePeriod: provided?.timePeriod,
    repeat: provided?.repeat ?? 'once',
    recurrenceUntilDate: provided?.recurrenceUntilDate,
    reminderMinutes: provided?.reminderMinutes ?? defaultReminderForEvent(allDay, explicitTime),
    location: provided?.location,
    description: provided?.description ?? provided?.detail,
  });
}

// One draft, input and commit owner on every platform. Surfaces only render
// fields and emit actions; native inputs retain their existing editable instance.
export function AddEventScreen(props: Props) {
  const { events, searchableEvents, loading } = useEvents();
  const ref = props.route.params?.eventRef;
  const key = JSON.stringify([props.route.key, ref, props.route.params?.recurrenceScope]);
  const resolved = ref ? resolveEventReference([...events, ...(searchableEvents ?? [])], ref) ?? undefined : undefined;
  // This is the immutable editing baseline, not a live second event owner.
  // Publishing this editor's own moved event must not unmount its pending save.
  const entry = useRef<{ key: string; event?: CalEvent }>({ key, event: resolved });
  if (entry.current.key !== key) entry.current = { key, event: resolved };
  else if (!entry.current.event && resolved) entry.current.event = resolved;
  const event = entry.current.event;
  if (ref && !event && !props.route.params?.editorDraftId) return (
    <ScreenContainer edges={['top', 'bottom']}>
      <ScheduleEditorSurface style={{ flex: 1 }} snapshot={buildNativeCalendarEditSnapshot({
        draft: initialDraft(undefined, props.route.params), editing: true,
        state: loading ? 'loading' : 'error', message: loading ? undefined : '日程不存在，请返回日历后重新打开',
      })} onAction={action => { if (action.type === 'cancel') props.navigation.goBack(); }} />
    </ScreenContainer>
  );
  return <ScheduleEditorScreen key={key} {...props} editingEvent={event} />;
}

function ScheduleEditorScreen({ navigation, route, editingEvent }: Props & { editingEvent?: CalEvent }) {
  const { colors: C } = useTheme();
  const { addEvent, updateEvent, deleteEvent } = useEvents();
  const { showDialog } = useAppDialog();
  const editingRef = route.params?.eventRef;
  const editing = Boolean(editingRef);
  const entryFollowup = editing ? undefined : route.params?.followup;
  const selectedRecurrenceScope = editingEvent
    ? resolveRecurrenceEditScope(editingEvent, route.params?.recurrenceScope)
    : undefined;
  const recurrenceRuleEditable = editingEvent
    ? canEditRecurrenceRule(editingEvent, selectedRecurrenceScope)
    : true;
  const allowStopRepeating = editingEvent
    ? canStopRecurringSeries(editingEvent, selectedRecurrenceScope)
    : true;
  const restoringEditor = useRef(Boolean(route.params?.editorDraftId)).current;
  const seedRef = useRef<ScheduleEditorDraft | null>(null);
  if (!seedRef.current) {
    const initial = initialDraft(editingEvent, route.params);
    seedRef.current = createScheduleEditorDraft({
      id: route.params?.editorDraftId ?? createClientRequestState('schedule-editor').id,
      saveRequestId: route.params?.draft?.clientRequestId ?? entryFollowup?.clientRequestId ?? createClientRequestState('event').id,
      startDate: initial.startDate || null, eventRef: editingRef,
      dateOrigin: editingEvent ? 'legacy' : route.params?.draft ? 'explicit' : route.params?.date ? 'context' : 'default',
      eventRevision: editingEvent ? editingEvent.eventRevision ?? editingEvent.revision ?? 1 : undefined,
      recurrenceScope: selectedRecurrenceScope,
      sourceInputJobId: route.params?.draft?.inputJobId,
      sourceKind: route.params?.draft?.inputJobId ? 'hardware_voice' : entryFollowup ? 'meeting_action' : 'manual',
      followup: entryFollowup,
      content: {
        endDate: initial.endDate && initial.endDate !== initial.startDate ? initial.endDate : null,
        time: scheduleTimeForEvent({ ...initial, startTime: initial.startTime ?? undefined, endTime: initial.endTime ?? undefined }),
        title: initial.title, location: initial.location, notes: initial.notes,
        legacyIsAllDay: initial.isAllDay, category: normalizeEventCategory(editingEvent?.category ?? route.params?.draft?.category),
        repeat: initial.repeat, recurrenceUntilDate: initial.recurrenceUntilDate,
        recurrenceInterval: editingEvent?.recurrenceInterval ?? route.params?.draft?.recurrenceInterval ?? 1,
        recurrenceWeekdays: editingEvent?.recurrenceWeekdays ?? route.params?.draft?.recurrenceWeekdays ?? [],
        reminderMinutes: initial.reminderMinutes,
      },
    });
    seedRef.current.latestInputText = route.params?.draft?.rawText ?? '';
  }
  const editor = useScheduleEditorDraft(seedRef.current, restoringEditor);
  const followup = editor.draft.followup?.params ?? entryFollowup;
  const input = useScheduleEditorInput(editor);
  const draft = useMemo(() => nativeDraftFromScheduleEditor(editor.draft), [editor.draft]);
  const setDraft = useCallback((value: NativeCalendarEditDraftSnapshot | ((previous: NativeCalendarEditDraftSnapshot) => NativeCalendarEditDraftSnapshot)) => {
    editor.change(previous => {
      const next = typeof value === 'function' ? value(nativeDraftFromScheduleEditor(previous)) : value;
      const changes = scheduleEditorChangesFromNative(next);
      if (next.repeat !== previous.repeat) Object.assign(changes, { recurrenceInterval: 1, recurrenceWeekdays: [] });
      return editScheduleFields(previous, changes);
    });
  }, [editor.change]);
  const saving = editor.draft.phase === 'saving';
  const setSaving = useCallback((value: boolean) => {
    editor.change(previous => previous.phase === 'saved' ? previous
      : { ...previous, phase: value ? 'saving' : 'editing', stateRevision: previous.stateRevision + 1 });
  }, [editor.change]);
  const [choice, setChoice] = useState<Choice>(null);
  const [nativeEditAck, setNativeEditAck] = useState<string | null>(null);
  const [scopeRequest, setScopeRequest] = useState<ScopeRequest | null>(null);
  const [feedback, setFeedback] = useState<{ key: number; message: string; durationMs: number } | null>(null);
  const [locating, setLocating] = useState(false);
  const locatingRef = useRef(false);
  const baselineRef = useRef(JSON.stringify(nativeDraftFromScheduleEditor(seedRef.current)));
  const draftRef = useRef(draft);
  const mountedRef = useRef(true);
  const allowLeaveRef = useRef(false);
  const leavePromptOpenRef = useRef(false);
  const saveLockRef = useRef(false);
  const saveRunRef = useRef(0);
  const saveWriteStartedRef = useRef(false);
  const dirty = JSON.stringify(draft) !== baselineRef.current;
  draftRef.current = draft;

  const notificationScope = 'guest';

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
    if (!route.params?.editorDraftId) navigation.setParams({ editorDraftId: seedRef.current!.id });
  }, [navigation, route.params?.editorDraftId]);

  useEffect(() => {
    if (editor.restoring || saveWriteStartedRef.current
      || editor.draft.phase !== 'saved' || !editor.draft.savedEventRef) return;
    allowLeaveRef.current = true;
    if (followup) navigation.popTo('Transcription', { meetingId: followup.meetingId, focus: 'summary',
      actionId: followup.actionId, actionFocusRequestId: Date.now() });
    else navigation.popTo('EventDetail', { eventRef: editor.draft.savedEventRef });
  }, [restoringEditor, editor.restoring, editor.draft.phase, editor.draft.savedEventRef, followup, navigation]);

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
    if (allowLeaveRef.current) {
      if (action) navigation.dispatch(action);
      else navigation.goBack();
      return;
    }
    // This seed was never the stored draft and cannot have accepted edits.
    // Leaving a failed/pending restore must not retry persistence or discard
    // an unread object. Keep the stored data for a normal later reopen.
    if (restoringEditor && (editor.restoring || editor.restoreError)) {
      allowLeaveRef.current = true;
      if (action) navigation.dispatch(action); else navigation.goBack();
      return;
    }
    if (leavePromptOpenRef.current) return;
    leavePromptOpenRef.current = true;
    void (async () => {
      input.cancel();
      if (JSON.stringify(draftRef.current) === baselineRef.current && !route.params?.draft
        && !editor.current.current.latestInputText.trim()) await editor.discard();
      else await editor.flush();
      allowLeaveRef.current = true;
      if (action) navigation.dispatch(action); else navigation.goBack();
    })().catch(reason => showDialog({ title: '草稿暂未保存',
      message: readableErrorMessage(reason, '请稍后重试'), tone: 'error',
    })).finally(() => { leavePromptOpenRef.current = false; });
  }, [navigation, showDialog, editor.discard, editor.flush, editor.restoring, editor.restoreError,
    restoringEditor, route.params?.draft, input.cancel]);

  useEffect(() => navigation.addListener('beforeRemove', event => {
    if (allowLeaveRef.current) return;
    if (saveLockRef.current) {
      event.preventDefault();
      return;
    }
    event.preventDefault();
    requestLeave(event.data.action);
  }), [navigation, requestLeave]);

  const discardDraft = useCallback((): void => {
    if (saveLockRef.current || editor.current.current.sourceInputJobId) return;
    showDialog({ title: editing ? '放弃未保存的修改？' : '放弃草稿？', actions: [
      { text: '取消', role: 'cancel' },
      { text: '放弃', role: 'destructive', onPress: async () => {
        if (saveLockRef.current) return;
        input.cancel();
        try {
          await editor.discard();
          allowLeaveRef.current = true;
          navigation.goBack();
        } catch (reason) {
          showDialog({ title: '草稿暂时无法放弃', message: readableErrorMessage(reason, '请稍后重试'),
            actions: [{ text: '取消', role: 'cancel' }, { text: '重试', onPress: discardDraft }] });
        }
      } },
    ] });
  }, [editing, editor.current, editor.discard, input.cancel, navigation, showDialog]);

  const payloadFromDraft = useCallback((value: NativeCalendarEditDraftSnapshot): Omit<CalEvent, 'id'> => ({
    title: value.title.trim(),
    startDate: value.startDate,
    endDate: value.endDate !== value.startDate ? value.endDate : undefined,
    spanning: value.endDate !== value.startDate,
    startTime: value.isAllDay ? undefined : value.startTime ?? undefined,
    endTime: value.isAllDay ? undefined : value.endTime ?? undefined,
    isAllDay: value.isAllDay,
    timePrecision: value.timePrecision,
    timePeriod: value.timePeriod,
    repeat: value.repeat,
    recurrenceUntilDate: value.repeat === 'once' ? undefined : value.recurrenceUntilDate ?? undefined,
    description: value.notes,
    rawText: route.params?.draft?.rawText,
    color: C.primary,
    category: editor.current.current.category,
    recurrenceInterval: editor.current.current.recurrenceInterval,
    recurrenceWeekdays: editor.current.current.recurrenceWeekdays.length
      ? editor.current.current.recurrenceWeekdays : undefined,
    location: value.location,
    detail: route.params?.draft?.detail,
    status: route.params?.draft?.status,
    reminderMinutes: value.isAllDay || !value.startTime ? null : value.reminderMinutes,
    ...(route.params?.draft?.draftSourceSha256 ? {
      eventRevision: route.params.draft.eventRevision,
      draftSourceSha256: route.params.draft.draftSourceSha256,
      producerRevision: route.params.draft.producerRevision,
      graphSchemaRevision: route.params.draft.graphSchemaRevision,
    } : {}),
  }), [C.primary, route.params?.draft, editor.current]);

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
    let committedEventRef: EventRef | undefined;
    try {
      await editor.flush();
      const current = editor.current.current;
      const saveRequest = { draftId: current.id, saveRequestId: current.saveRequestId, stateRevision: current.stateRevision };
      if (editingEvent) {
        const updated = await updateEvent(eventRefForEvent(editingEvent), payload, recurrenceScope, saveRequest);
        ({ reminderDelivery } = updated);
        if (!updated.editorReceipt) throw new Error('日程保存回执未返回');
        editor.acceptSaveReceipt(updated.editorReceipt);
        committedEventRef = updated.editorReceipt.eventRef;
      } else {
        const created = await addEvent({
          ...payload,
          clientRequestId: editor.current.current.saveRequestId,
        }, saveRequest);
        ({ reminderDelivery } = created);
        if (!created.editorReceipt) throw new Error('日程保存回执未返回');
        editor.acceptSaveReceipt(created.editorReceipt);
        committedEventRef = created.eventRef;
      }
    } catch (reason) {
      if (!activeSave(runId)) return;
      releaseSave(runId);
      const stale = reason instanceof HttpResponseError && reason.status === 409;
      showDialog({
        title: stale ? '日程已发生变化' : '保存失败',
        message: stale
            ? '该日程内容已发生变化，请返回后重新打开再编辑。'
            : readableErrorMessage(reason, '请检查网络后重试'),
        tone: stale ? 'warning' : 'error',
      });
      return;
    }
    if (!activeSave(runId)) return;
    let warning: string | undefined;
    if (reminderDelivery === 'unavailable') {
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
    } else if (editing && committedEventRef) {
      navigation.popTo('EventDetail', { eventRef: committedEventRef });
    } else {
      navigation.goBack();
    }
    if (warning) showDialog({
      title: '日程已保存',
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
    if (saveLockRef.current || editor.current.current.phase !== 'editing') return;
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
    input.cancel();
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
    if (action.nativeEditToken) setNativeEditAck(action.nativeEditToken);
    switch (action.type) {
      case 'inputStart': input.start(); break;
      case 'inputStop': input.stop(); break;
      case 'inputCancel': input.cancel(); break;
      case 'inputUndo': input.undo(); break;
      case 'inputOptions': setChoice('input'); break;
      case 'inputTextChange': input.setText(action.text); break;
      case 'inputSubmit': input.submit(action.text); break;
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
  }, [beginDelete, beginSave, recurrenceRuleEditable, requestCurrentLocation, requestLeave,
    input.start, input.stop, input.cancel, input.undo, input.setText, input.submit]);

  const choiceItems = useMemo<AppActionSheetItem[]>(() => {
    if (choice === 'input') return [
      { key: 'replace', label: '重新输入', onPress: () => input.start('replace') },
      ...(!editor.draft.sourceInputJobId ? [{ key: 'discard-draft', label: '放弃草稿', destructive: true, onPress: discardDraft }] : []),
    ];
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
  }, [allowStopRepeating, choice, draft.reminderMinutes, draft.repeat, editingEvent, scopeRequest, input.start,
    editor.draft.sourceInputJobId, discardDraft]);

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
    nativeEditAck,
    input: { phase: editor.draft.phase, text: editor.draft.latestInputText, error: input.error,
      level: input.level, durationMs: input.durationMs, canUndo: editor.draft.lastUndo !== null },
    state: missing || editor.restoreError ? 'error' : editor.restoring ? 'loading' : 'ready',
    message: editor.restoreError ? '未保存的日程暂时无法读取' : missing ? '日程不存在，请返回日程详情后重新打开编辑。' : undefined,
  }), [dirty, draft, editing, editingEvent?.isRecurrenceException, editingEvent?.repeat, locating, nativeEditAck, missing, saving, selectedRecurrenceScope,
    editor.restoreError, editor.restoring, editor.draft.phase, editor.draft.latestInputText, editor.draft.lastUndo, input.error, input.level, input.durationMs]);

  return (
    <ScreenContainer edges={['top', 'bottom']} bg={C.body}>
      <View
        style={styles.root}
        testID="event-editor-native-root"
        collapsable={false}
        collapsableChildren={false}
      >
        <ScheduleEditorSurface
          style={styles.surface}
          snapshot={snapshot}
          onAction={handleAction}
          testID="event-editor-native-surface"
        />
      </View>
      <AppActionSheet
        visible={choice !== null || scopeRequest !== null}
        title={scopeRequest ? undefined : choice === 'repeat' ? '重复' : choice === 'input' ? undefined : '提醒'}
        items={choiceItems}
        onClose={() => {
          setChoice(null);
          setScopeRequest(null);
        }}
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
