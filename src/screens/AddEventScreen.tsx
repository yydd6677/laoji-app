import React, { useState } from 'react';
import {
  ActivityIndicator, Animated, View, Text, TextInput, TouchableOpacity, StyleSheet,
  ScrollView, KeyboardAvoidingView, Platform, useWindowDimensions,
} from 'react-native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import type { NavigationAction, RouteProp } from '@react-navigation/native';
import { Ionicons } from '@expo/vector-icons';
import { Colors as C, withAlpha } from '../theme/colors';
import { ScreenContainer } from '../components/ScreenContainer';
import { ResponsiveContentFrame } from '../components/ResponsiveContentFrame';
import { CalendarDetailTitleBar, CalendarEditTitleBar } from '../components/CalendarTitleBar';
import { EventTimeEditor, EventTimeValue } from '../components/EventTimeEditor';
import { EventTimeRangeArrow } from '../components/EventTimeRangeArrow';
import {
  DescriptionEditorPage,
  LocationEditorPage,
  ReminderSelectionPage,
  RepeatSelectionPage,
} from '../components/EventEditorChoicePages';
import { useAppDialog } from '../components/AppDialog';

import { CalEvent, EventRecurrenceScope, EventRef, RootStackParamList } from '../types';
import type { ScopeKey } from '../domain/meeting';
import { useEvents } from '../store/EventsStore';
import { useAuth } from '../store/AuthStore';
import {
  DEFAULT_REMINDER_MINUTES,
  REMINDER_OPTIONS,
  ReminderMinutes,
  defaultReminderForEvent,
  loadNotificationPrefs,
  reminderUnavailableMessage,
} from '../services/notifications';
import {
  EventCategory,
  normalizeEventCategory,
} from '../utils/eventColors';
import { createClientRequestState, requestStateForPayload } from '../services/clientRequestId';
import { eventRefForEvent } from '../utils/eventIdentity';
import { linkMeetingActionFollowup } from '../services/meetingActionFollowup';
import { resolveEventReference } from '../utils/eventRecurrence';
import { validateEventDraft } from '../utils/eventDraftValidation';
import {
  canEditRecurrenceRule,
  canStopRecurringSeries,
  recurrenceDeleteDialog,
  recurrenceEditDialog,
  recurrenceRuleControlMode,
  resolveRecurrenceEditScope,
} from '../services/recurrenceActions';
import { HttpResponseError, readableErrorMessage } from '../services/errors';

type Props = {
  navigation: NativeStackNavigationProp<RootStackParamList, 'AddEvent'>;
  route: RouteProp<RootStackParamList, 'AddEvent'>;
};

const REPEAT_OPTIONS = ['不重复', '每天', '每周', '每月', '每年'] as const;

type EventEditorSnapshot = {
  title: string;
  date: string;
  endDate: string;
  startTime: string;
  endTime: string;
  hasEndTime: boolean;
  isAllDay: boolean;
  repeat: typeof REPEAT_OPTIONS[number];
  recurrenceUntilDate?: string;
  description: string;
  category: EventCategory;
  location: string;
  reminderMinutes: ReminderMinutes;
};

const REPEAT_MAP = {
  '不重复': 'once' as const,
  '每天':   'daily' as const,
  '每周':   'weekly' as const,
  '每月':   'monthly' as const,
  '每年':   'yearly' as const,
};

function repeatToOption(repeat?: CalEvent['repeat']): typeof REPEAT_OPTIONS[number] {
  switch (repeat) {
    case 'daily': return '每天';
    case 'weekly': return '每周';
    case 'monthly': return '每月';
    case 'yearly': return '每年';
    default: return '不重复';
  }
}

function snapshotKey(snapshot: EventEditorSnapshot): string {
  return JSON.stringify(snapshot);
}

function snapshotFromEvent(event: CalEvent): EventEditorSnapshot {
  const date = event.startDate;
  return {
    title: event.title,
    date,
    endDate: event.endDate ?? date,
    startTime: event.startTime ?? '10:00',
    endTime: event.endTime ?? '11:00',
    hasEndTime: Boolean(event.endTime),
    isAllDay: event.isAllDay ?? false,
    repeat: repeatToOption(event.repeat),
    recurrenceUntilDate: event.recurrenceUntilDate,
    description: event.description ?? event.detail ?? '',
    category: normalizeEventCategory(event.category),
    location: event.location ?? '',
    reminderMinutes: event.reminderMinutes ?? null,
  };
}

// ── helpers ──────────────────────────────────────────────────────────────────

function parseDateStr(str: string): Date {
  // "YYYY-MM-DD" → Date at local midnight
  const [y, m, d] = str.split('-').map(Number);
  return new Date(y, m - 1, d);
}

function formatDate(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function todayDateStr(): string {
  return formatDate(new Date());
}

function parseTimeStr(str: string): Date {
  const [h, min] = str.split(':').map(Number);
  const d = new Date();
  d.setHours(h, min, 0, 0);
  return d;
}

function formatTime(d: Date): string {
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

const WEEKDAYS = ['日', '一', '二', '三', '四', '五', '六'];
const mediumDecelerate = (progress: number) => 1 - Math.pow(1 - progress, 6);

function formatEditorDate(d: Date): string {
  const includeYear = d.getFullYear() !== new Date().getFullYear();
  return `${includeYear ? `${d.getFullYear()}年` : ''}${d.getMonth() + 1}月${d.getDate()}日 周${WEEKDAYS[d.getDay()]}`;
}

// ─────────────────────────────────────────────────────────────────────────────

export function AddEventScreen({ navigation, route }: Props) {
  const { events, searchableEvents, addEvent, updateEvent, deleteEvent } = useEvents();
  const { mode, session } = useAuth();
  const { showDialog } = useAppDialog();
  const editingRef = route.params?.eventRef;
  const editingEvent = editingRef
    ? resolveEventReference([...events, ...(searchableEvents ?? [])], editingRef) ?? undefined
    : undefined;
  const routeDraft = editingRef ? undefined : route.params?.draft;
  const isEditing = Boolean(editingRef);
  const followup = isEditing ? undefined : route.params?.followup;
  const selectedRecurrenceScope = editingEvent
    ? resolveRecurrenceEditScope(editingEvent, route.params?.recurrenceScope)
    : undefined;
  const recurrenceRuleEditable = editingEvent
    ? canEditRecurrenceRule(editingEvent, selectedRecurrenceScope)
    : true;
  const recurrenceRuleMode = editingEvent
    ? recurrenceRuleControlMode(editingEvent, selectedRecurrenceScope)
    : 'editable';
  const allowStopRepeating = editingEvent
    ? canStopRecurringSeries(editingEvent, selectedRecurrenceScope)
    : true;
  const initDate = editingEvent?.startDate
    ?? routeDraft?.startDate
    ?? route.params?.date
    ?? todayDateStr();
  const initEndDate = editingEvent?.endDate
    ?? routeDraft?.endDate
    ?? route.params?.endDate
    ?? initDate;
  const initStartTime = editingEvent?.startTime ?? routeDraft?.startTime ?? route.params?.startTime ?? '10:00';
  const initEndTime = editingEvent?.endTime ?? routeDraft?.endTime ?? route.params?.endTime ?? '11:00';
  const initHasEndTime = editingEvent
    ? Boolean(editingEvent.endTime)
    : routeDraft
      ? Boolean(routeDraft.endTime)
      : true;
  const [saving, setSaving] = React.useState(false);
  const createRequestRef = React.useRef(followup
    ? { id: followup.clientRequestId, fingerprint: '' }
    : createClientRequestState('event'));
  const createdFollowupEventRef = React.useRef<EventRef | null>(null);
  const saveRunRef = React.useRef(0);
  const saveLockRef = React.useRef(false);
  const saveWriteStartedRef = React.useRef(false);
  const mountedRef = React.useRef(true);

  const [title, setTitle]       = useState(editingEvent?.title ?? routeDraft?.title ?? '');
  const [dateObj, setDateObj]   = useState<Date>(() => parseDateStr(initDate));
  const [endDateObj, setEndDateObj] = useState<Date>(() => parseDateStr(initEndDate));
  const [startObj, setStartObj] = useState<Date>(() => parseTimeStr(initStartTime));
  const [endObj, setEndObj]     = useState<Date>(() => parseTimeStr(initEndTime));
  const [hasEndTime, setHasEndTime] = useState(initHasEndTime);
  const [isAllDay, setAllDay]   = useState(editingEvent?.isAllDay ?? routeDraft?.isAllDay ?? false);
  const [repeat, setRepeat]     = useState<typeof REPEAT_OPTIONS[number]>(repeatToOption(editingEvent?.repeat ?? routeDraft?.repeat));
  const [recurrenceUntilDate, setRecurrenceUntilDate] = useState(
    editingEvent?.recurrenceUntilDate ?? routeDraft?.recurrenceUntilDate,
  );
  const [desc, setDesc]         = useState(editingEvent?.description ?? editingEvent?.detail ?? routeDraft?.description ?? routeDraft?.detail ?? '');
  const [category, setCategory] = useState<EventCategory>(() => normalizeEventCategory(editingEvent?.category ?? routeDraft?.category));
  const [location, setLocation] = useState(editingEvent?.location ?? routeDraft?.location ?? '');
  const [defaultReminder, setDefaultReminder] = useState<ReminderMinutes>(DEFAULT_REMINDER_MINUTES);
  const [reminderMinutes, setReminderMinutes] = useState<ReminderMinutes>(
    editingEvent || routeDraft
      ? (editingEvent?.reminderMinutes ?? routeDraft?.reminderMinutes ?? null)
      : defaultReminderForEvent(false, initStartTime),
  );
  const notificationScope = mode === 'authenticated' && session ? `user:${session.user.id}` : mode === 'guest' ? 'guest' : 'signed_out';
  const meetingScopeKey: ScopeKey | null = mode === 'authenticated' && session
    ? `user:${session.user.id}`
    : mode === 'guest' ? 'guest' : null;

  const [showTimeEditor, setShowTimeEditor] = useState(false);
  const [timeEditorTarget, setTimeEditorTarget] = useState<'start' | 'end'>('start');
  const [choicePage, setChoicePage] = useState<'repeat' | 'reminder' | 'location' | 'description' | null>(null);
  const { height: windowHeight } = useWindowDimensions();
  const editorContentOffset = React.useRef(new Animated.Value(0)).current;
  const editorOverlayVisible = showTimeEditor || choicePage !== null;
  const previousEditorOverlayVisible = React.useRef(false);

  React.useEffect(() => {
    const wasVisible = previousEditorOverlayVisible.current;
    previousEditorOverlayVisible.current = editorOverlayVisible;
    if (wasVisible === editorOverlayVisible) return;

    editorContentOffset.stopAnimation();
    if (editorOverlayVisible) {
      Animated.timing(editorContentOffset, {
        toValue: -windowHeight * 0.05,
        duration: 800,
        easing: mediumDecelerate,
        useNativeDriver: true,
      }).start();
      return;
    }

    editorContentOffset.setValue(-windowHeight * 0.0875);
    Animated.timing(editorContentOffset, {
      toValue: 0,
      duration: 800,
      easing: mediumDecelerate,
      useNativeDriver: true,
    }).start();
  }, [editorContentOffset, editorOverlayVisible, windowHeight]);

  const date      = formatDate(dateObj);
  const endDate   = formatDate(endDateObj);
  const startTime = formatTime(startObj);
  const endTime   = formatTime(endObj);
  const currentSnapshot: EventEditorSnapshot = {
    title,
    date,
    endDate,
    startTime,
    endTime,
    hasEndTime,
    isAllDay,
    repeat,
    recurrenceUntilDate,
    description: desc,
    category,
    location,
    reminderMinutes,
  };
  const baselineSnapshotRef = React.useRef(currentSnapshot);
  const currentSnapshotRef = React.useRef(currentSnapshot);
  const dirtyRef = React.useRef(false);
  const allowLeaveRef = React.useRef(false);
  const leavePromptOpenRef = React.useRef(false);
  currentSnapshotRef.current = currentSnapshot;
  dirtyRef.current = snapshotKey(currentSnapshot) !== snapshotKey(baselineSnapshotRef.current);

  React.useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      saveRunRef.current += 1;
      saveLockRef.current = false;
      saveWriteStartedRef.current = false;
    };
  }, []);

  React.useEffect(() => {
    if (!editingEvent) return;
    const snapshot = snapshotFromEvent(editingEvent);
    baselineSnapshotRef.current = snapshot;
    currentSnapshotRef.current = snapshot;
    dirtyRef.current = false;
    setTitle(snapshot.title);
    setDateObj(parseDateStr(snapshot.date));
    setEndDateObj(parseDateStr(snapshot.endDate));
    setStartObj(parseTimeStr(snapshot.startTime));
    setEndObj(parseTimeStr(snapshot.endTime));
    setHasEndTime(snapshot.hasEndTime);
    setAllDay(snapshot.isAllDay);
    setRepeat(snapshot.repeat);
    setRecurrenceUntilDate(snapshot.recurrenceUntilDate);
    setDesc(snapshot.description);
    setCategory(snapshot.category);
    setLocation(snapshot.location);
    setReminderMinutes(snapshot.reminderMinutes);
  }, [editingEvent?.id]);

  React.useEffect(() => {
    let alive = true;
    loadNotificationPrefs(notificationScope).then(prefs => {
      if (!alive) return;
      setDefaultReminder(prefs.defaultReminderMinutes);
      if (!isEditing && !routeDraft) {
        const current = currentSnapshotRef.current;
        const baseline = baselineSnapshotRef.current;
        if (current.reminderMinutes === baseline.reminderMinutes) {
          const nextReminder = defaultReminderForEvent(
            current.isAllDay,
            current.isAllDay ? undefined : current.startTime,
            prefs.defaultReminderMinutes,
          );
          baselineSnapshotRef.current = { ...baseline, reminderMinutes: nextReminder };
          currentSnapshotRef.current = { ...current, reminderMinutes: nextReminder };
          setReminderMinutes(nextReminder);
        }
      }
    });
    return () => { alive = false; };
  }, [notificationScope, isEditing]);

  const requestLeave = React.useCallback((action?: NavigationAction) => {
    if (saveLockRef.current) return;
    if (allowLeaveRef.current || !dirtyRef.current) {
      if (action) navigation.dispatch(action);
      else navigation.goBack();
      return;
    }
    if (leavePromptOpenRef.current) return;

    leavePromptOpenRef.current = true;
    showDialog({
      title: '确定退出当前日程编辑吗？',
      message: '退出后，将无法保存当前日程的更改',
      tone: 'warning',
      onDismiss: () => { leavePromptOpenRef.current = false; },
      actions: [
        {
          text: '退出',
          role: 'primary',
          onPress: () => {
            allowLeaveRef.current = true;
            leavePromptOpenRef.current = false;
            if (action) navigation.dispatch(action);
            else navigation.goBack();
          },
        },
        {
          text: '继续编辑',
          role: 'cancel',
          onPress: () => { leavePromptOpenRef.current = false; },
        },
      ],
    });
  }, [navigation, showDialog]);

  React.useEffect(() => navigation.addListener('beforeRemove', event => {
    if (allowLeaveRef.current) return;
    if (saveLockRef.current) {
      event.preventDefault();
      return;
    }
    if (!dirtyRef.current) return;
    event.preventDefault();
    requestLeave(event.data.action);
  }), [navigation, requestLeave]);

  const buildEventPayload = (): Omit<CalEvent, 'id'> => ({
    title: title.trim(),
    startDate: date,
    endDate: endDate !== date ? endDate : undefined,
    spanning: endDate !== date,
    startTime: isAllDay ? undefined : startTime,
    endTime: isAllDay || !hasEndTime ? undefined : endTime,
    isAllDay,
    repeat: REPEAT_MAP[repeat],
    recurrenceUntilDate: repeat === '不重复' ? undefined : recurrenceUntilDate,
    description: desc,
    rawText: routeDraft?.rawText,
    color: C.primary,
    category,
    location: location || undefined,
    detail: routeDraft?.detail,
    status: routeDraft?.status,
    reminderMinutes: isAllDay ? null : reminderMinutes,
  });

  const isSaveRunActive = (runId: number) => (
    mountedRef.current
    && saveLockRef.current
    && saveRunRef.current === runId
  );

  const releaseSaveRun = (runId: number) => {
    if (!isSaveRunActive(runId)) return;
    saveLockRef.current = false;
    saveWriteStartedRef.current = false;
    setSaving(false);
  };

  const doSave = async (
    runId: number,
    payload: Omit<CalEvent, 'id'>,
    recurrenceScope: EventRecurrenceScope,
  ) => {
    let reminderDelivery: Awaited<ReturnType<typeof addEvent>>['reminderDelivery'] | undefined;
    let syncStatus: Awaited<ReturnType<typeof addEvent>>['syncStatus'] | undefined;
    let followupEventSaved = false;
    try {
      if (editingEvent) {
        ({ reminderDelivery, syncStatus } = await updateEvent(
          eventRefForEvent(editingEvent),
          payload,
          recurrenceScope,
        ));
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
    } catch (error) {
      if (!isSaveRunActive(runId)) return;
      releaseSaveRun(runId);
      showDialog({
        title: followupEventSaved
          ? '日程已创建，关联未完成'
          : error instanceof HttpResponseError && error.status === 409
            ? '日程已发生变化'
            : '保存失败',
        message: followupEventSaved
          ? '再次点击保存可重试关联，不会重复创建日程。'
          : error instanceof HttpResponseError && error.status === 409
            ? '该日程可能已在其他设备修改，请返回后重新打开再编辑。'
            : readableErrorMessage(error, '请检查网络后重试'),
        tone: followupEventSaved || (error instanceof HttpResponseError && error.status === 409)
          ? 'warning'
          : 'error',
      });
      return;
    }

    if (!isSaveRunActive(runId)) return;
    let reminderWarning: string | undefined;
    if (syncStatus === 'pending') {
      reminderWarning = '保存请求已记录，将在网络恢复后自动确认。';
    } else if (reminderDelivery === 'unavailable') {
      try {
        reminderWarning = await reminderUnavailableMessage();
      } catch {
        reminderWarning = '本机提醒创建失败，请重新打开日程并保存提醒。';
      }
      if (!isSaveRunActive(runId)) return;
    } else if (reminderDelivery === 'unconfirmed') {
      reminderWarning = '本机提醒状态未能确认，可重新打开日程并保存提醒。';
    }

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
    if (reminderWarning) {
      showDialog({
        title: syncStatus === 'pending' ? '日程等待同步' : '日程已保存',
        message: reminderWarning,
        tone: 'warning',
      });
    }
  };

  const startSaveWrite = (
    runId: number,
    payload: Omit<CalEvent, 'id'>,
    recurrenceScope: EventRecurrenceScope,
  ) => {
    if (!isSaveRunActive(runId) || saveWriteStartedRef.current) return;
    saveWriteStartedRef.current = true;
    setSaving(true);
    void doSave(runId, payload, recurrenceScope);
  };

  const selectEditScopeAndSave = (
    runId: number,
    payload: Omit<CalEvent, 'id'>,
  ) => {
    if (editingEvent?.repeat && editingEvent.repeat !== 'once' && !selectedRecurrenceScope) {
      showDialog(recurrenceEditDialog(
        editingEvent,
        recurrenceScope => {
          if (!isSaveRunActive(runId)) return;
          startSaveWrite(runId, payload, recurrenceScope);
        },
        () => releaseSaveRun(runId),
      ));
      return;
    }
    startSaveWrite(runId, payload, selectedRecurrenceScope ?? 'series');
  };

  const handleSave = () => {
    if (saveLockRef.current) return;
    if (isEditing && !editingEvent) {
      showDialog({ title: '日程不存在', message: '请返回后重新打开日程', tone: 'warning' });
      return;
    }

    const payload = buildEventPayload();
    const validation = validateEventDraft(payload);
    if (!validation.valid || !validation.value) {
      const issue = validation.issues[0];
      showDialog({ title: '日程信息不完整', message: issue?.message, tone: 'warning' });
      return;
    }

    saveLockRef.current = true;
    saveWriteStartedRef.current = false;
    const runId = saveRunRef.current + 1;
    saveRunRef.current = runId;
    setSaving(true);
    selectEditScopeAndSave(runId, validation.value);
  };

  const handleDelete = () => {
    if (!editingEvent) return;
    showDialog(recurrenceDeleteDialog(editingEvent, async recurrenceScope => {
      try {
        await deleteEvent(eventRefForEvent(editingEvent), recurrenceScope);
        allowLeaveRef.current = true;
        navigation.popTo('MainTabs', { screen: 'Schedule' });
      } catch {
        showDialog({ title: '删除失败', message: '请检查网络后重试', tone: 'error' });
      }
    }));
  };

  const openTimeEditor = (target: 'start' | 'end') => {
    setTimeEditorTarget(target);
    setShowTimeEditor(true);
  };

  const applyTimeEditorValue = (value: EventTimeValue) => {
    const allDayChanged = value.isAllDay !== isAllDay;
    setDateObj(value.startDate);
    setEndDateObj(value.endDate);
    setStartObj(value.startTime);
    setEndObj(value.endTime);
    setHasEndTime(value.hasEndTime);
    setAllDay(value.isAllDay);
    if (allDayChanged) {
      setReminderMinutes(defaultReminderForEvent(
        value.isAllDay,
        value.isAllDay ? undefined : formatTime(value.startTime),
        defaultReminder,
      ));
    }
    setShowTimeEditor(false);
  };

  if (isEditing && !editingEvent) {
    return (
      <ScreenContainer bg={C.body}>
        <ResponsiveContentFrame testID="event-editor-content-frame">
          <CalendarDetailTitleBar title="编辑日程" onBack={() => navigation.goBack()} />
          <View style={s.emptyWrap}>
            <Text style={s.emptyTitle}>日程不存在</Text>
            <Text style={s.emptyText}>请返回日程详情后重新打开编辑。</Text>
          </View>
        </ResponsiveContentFrame>
      </ScreenContainer>
    );
  }

  return (
    <ScreenContainer bg={C.body}>
      <Animated.View
        style={[s.editorContent, { transform: [{ translateY: editorContentOffset }] }]}
        pointerEvents={editorOverlayVisible || saving ? 'none' : 'auto'}
        accessibilityElementsHidden={editorOverlayVisible || saving}
        importantForAccessibility={editorOverlayVisible || saving ? 'no-hide-descendants' : 'auto'}
        accessibilityState={{ busy: saving }}
        testID="event-editor-main-content"
      >
        <ResponsiveContentFrame testID="event-editor-content-frame">
          <CalendarEditTitleBar
            onCancel={() => requestLeave()}
            onSave={handleSave}
            saveEnabled
            saving={saving}
            saveAccessibilityLabel={isEditing ? '保存日程修改' : '保存到日历'}
          />
          <KeyboardAvoidingView style={s.flex} behavior={Platform.OS === 'ios' ? 'padding' : 'height'}>
            <ScrollView
              testID="event-editor-scroll"
              style={s.scroll}
              contentContainerStyle={s.content}
              keyboardShouldPersistTaps="handled"
              showsVerticalScrollIndicator={false}
            >

          {editingEvent?.repeat && editingEvent.repeat !== 'once' ? (
            <View style={s.seriesNotice}>
              <Ionicons name="repeat-outline" size={16} color={C.primary} />
              <Text style={s.seriesNoticeText}>这是重复日程，保存时可选择修改范围</Text>
            </View>
          ) : null}

          <TextInput
            style={s.titleInput}
            placeholder="添加主题"
            placeholderTextColor={C.faint}
            value={title}
            onChangeText={setTitle}
            editable={!saving}
            maxLength={400}
          />
          <View style={s.sectionDivider} />

          <View style={s.timeBlock}>
            <View style={s.timeIconLane}>
              <Ionicons name="time-outline" size={18} color={C.faint} />
            </View>
            <View style={s.timeLine}>
              <TouchableOpacity
                style={[s.timeEndpoint, s.timeStartEndpoint]}
                onPress={() => openTimeEditor('start')}
                activeOpacity={0.65}
                accessibilityRole="button"
                accessibilityLabel={`开始日期 ${date}`}
              >
                <Text style={s.timeMain} numberOfLines={1}>{formatEditorDate(dateObj)}</Text>
                {!isAllDay ? <Text style={s.timeMinor} numberOfLines={1}>{startTime}</Text> : null}
              </TouchableOpacity>
              <TouchableOpacity
                style={[s.timeEndpoint, s.timeEndEndpoint]}
                onPress={() => openTimeEditor('end')}
                activeOpacity={0.65}
                accessibilityRole="button"
                accessibilityLabel={`结束日期 ${endDate}`}
              >
                <Text style={s.timeMain} numberOfLines={1}>{formatEditorDate(endDateObj)}</Text>
                {!isAllDay ? <Text style={s.timeMinor} numberOfLines={1}>{hasEndTime ? endTime : '未设置'}</Text> : null}
              </TouchableOpacity>
              <View style={s.timeRangeArrow}>
                <EventTimeRangeArrow testID="event-main-time-range-arrow" />
              </View>
            </View>
          </View>

          {recurrenceRuleMode !== 'hidden' ? (
            <TouchableOpacity
              style={[s.editorRow, recurrenceRuleMode === 'disabled' && { opacity: 0.45 }]}
              onPress={() => {
                if (recurrenceRuleEditable) setChoicePage('repeat');
              }}
              activeOpacity={0.65}
              accessibilityRole="button"
              accessibilityLabel={`重复 ${recurrenceRuleMode === 'disabled' ? '不重复' : repeat}`}
              accessibilityState={{ disabled: !recurrenceRuleEditable }}
              disabled={!recurrenceRuleEditable}
            >
              <View style={s.iconLane}>
                <Ionicons name="repeat-outline" size={18} color={C.faint} />
              </View>
              <Text style={s.rowText}>{recurrenceRuleMode === 'disabled' ? '不重复' : repeat}</Text>
                <Ionicons testID="event-repeat-chevron" name="chevron-forward" size={12} color={C.faint} />
            </TouchableOpacity>
          ) : null}

          <View style={s.sectionDivider} />

          <TouchableOpacity
            style={s.editorRow}
            onPress={() => setChoicePage('location')}
            activeOpacity={0.65}
            accessibilityRole="button"
            accessibilityLabel={location ? `地点 ${location}` : '添加地点'}
          >
            <View style={s.iconLane}>
              <Ionicons name="location-outline" size={18} color={C.faint} />
            </View>
            <Text style={[s.rowText, !location && s.placeholderText]} numberOfLines={1}>
              {location || '添加地点'}
            </Text>
            {location ? (
              <TouchableOpacity
                style={s.clearAction}
                onPress={event => {
                  event.stopPropagation();
                  setLocation('');
                }}
                accessibilityRole="button"
                accessibilityLabel="清空地点"
              >
                <Ionicons testID="event-location-clear-icon" name="close" size={12} color={C.faint} />
              </TouchableOpacity>
            ) : null}
          </TouchableOpacity>

          <View style={s.sectionDivider} />

          <TouchableOpacity
            style={s.descriptionRow}
            onPress={() => setChoicePage('description')}
            activeOpacity={0.65}
            accessibilityRole="button"
            accessibilityLabel={desc ? '编辑描述' : '添加描述'}
          >
            <View style={s.iconLane}>
              <Ionicons name="document-text-outline" size={18} color={C.faint} />
            </View>
            <Text
              style={[s.descriptionPreview, !desc && s.placeholderText]}
              numberOfLines={desc ? 4 : 1}
            >
              {desc || '添加描述'}
            </Text>
          </TouchableOpacity>

          <View style={s.sectionDivider} />

          <TouchableOpacity
            style={s.editorRow}
            onPress={() => setChoicePage('reminder')}
            activeOpacity={0.65}
            accessibilityRole="button"
            accessibilityLabel="选择提醒时间"
          >
            <View style={s.iconLane}>
              <Ionicons name="notifications-outline" size={18} color={C.faint} />
            </View>
            <Text style={s.rowText}>
              {REMINDER_OPTIONS.find(option => option.value === reminderMinutes)?.label ?? '不提醒'}
            </Text>
            <Ionicons testID="event-reminder-chevron" name="chevron-forward" size={12} color={C.faint} />
          </TouchableOpacity>

          {isEditing ? (
            <>
              <View style={s.sectionDivider} />
              <TouchableOpacity
                style={s.editorRow}
                onPress={handleDelete}
                activeOpacity={0.65}
                accessibilityRole="button"
                accessibilityLabel="删除日程"
              >
                <View style={s.iconLane}>
                  <Ionicons testID="event-delete-icon" name="trash-outline" size={18} color={C.red} />
                </View>
                <Text style={s.deleteText}>删除</Text>
              </TouchableOpacity>
            </>
          ) : null}
            </ScrollView>
          </KeyboardAvoidingView>
        </ResponsiveContentFrame>
      </Animated.View>

      {saving ? (
        <View
          style={s.savingOverlay}
          accessibilityViewIsModal
          accessibilityRole="progressbar"
          accessibilityLabel="正在保存日程"
          testID="event-saving-overlay"
        >
          <ActivityIndicator color={C.primary} />
          <Text style={s.savingText}>正在保存</Text>
        </View>
      ) : null}

      <EventTimeEditor
        visible={showTimeEditor}
        value={{ startDate: dateObj, endDate: endDateObj, startTime: startObj, endTime: endObj, hasEndTime, isAllDay }}
        initialTarget={timeEditorTarget}
        onCancel={() => setShowTimeEditor(false)}
        onDone={applyTimeEditorValue}
        onInvalid={() => showDialog({
          title: '时间不正确',
          message: isAllDay ? '结束日期不能早于开始日期' : '结束时间需要晚于开始时间',
          tone: 'warning',
        })}
      />
      <RepeatSelectionPage
        visible={recurrenceRuleEditable && choicePage === 'repeat'}
        selectedKey={repeat}
        options={REPEAT_OPTIONS
          .filter(option => allowStopRepeating || option !== '不重复')
          .map(option => ({ key: option, label: option }))}
        onSelect={key => {
          const next = key as typeof REPEAT_OPTIONS[number];
          setRepeat(next);
          if (next === '不重复') setRecurrenceUntilDate(undefined);
        }}
        onClose={() => setChoicePage(null)}
      />
      <ReminderSelectionPage
        visible={choicePage === 'reminder'}
        value={reminderMinutes}
        defaultValue={defaultReminder ?? DEFAULT_REMINDER_MINUTES}
        options={REMINDER_OPTIONS.filter(option => option.value != null).map(option => ({
          key: String(option.value),
          label: option.label,
          value: option.value as number,
        }))}
        disabled={isAllDay}
        onDone={value => {
          setReminderMinutes(value);
          setChoicePage(null);
        }}
        onClose={() => setChoicePage(null)}
      />
      <LocationEditorPage
        visible={choicePage === 'location'}
        value={location}
        onDone={value => {
          setLocation(value);
          setChoicePage(null);
        }}
        onClose={() => setChoicePage(null)}
      />
      <DescriptionEditorPage
        visible={choicePage === 'description'}
        value={desc}
        onDone={value => {
          setDesc(value);
          setChoicePage(null);
        }}
        onClose={() => setChoicePage(null)}
      />
    </ScreenContainer>
  );
}

const s = StyleSheet.create({
  flex: { flex: 1 },
  editorContent: { flex: 1 },
  savingOverlay: {
    ...StyleSheet.absoluteFillObject,
    zIndex: 80,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: withAlpha(C.body, 0.72),
  },
  savingText: { marginTop: 10, fontSize: 14, lineHeight: 20, color: C.sub },
  emptyWrap: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24, backgroundColor: C.body },
  emptyTitle: { fontSize: 17, lineHeight: 24, fontWeight: '600', color: C.text, marginBottom: 8 },
  emptyText: { fontSize: 14, color: C.sub, lineHeight: 22 },
  scroll: { flex: 1, backgroundColor: C.body },
  content: { paddingBottom: 50 },
  seriesNotice: { minHeight: 40, backgroundColor: C.primaryLight, paddingHorizontal: 16, flexDirection: 'row', alignItems: 'center', gap: 8 },
  seriesNoticeText: { flex: 1, fontSize: 13, lineHeight: 20, color: C.primary },
  titleInput: { minHeight: 54, paddingHorizontal: 16, paddingVertical: 12, fontSize: 20, lineHeight: 28, fontWeight: '600', color: C.text },
  sectionDivider: { height: StyleSheet.hairlineWidth, backgroundColor: C.divider, marginLeft: 16, marginVertical: 14 },
  iconLane: { width: 46, minHeight: 22, alignItems: 'center', justifyContent: 'center' },
  timeBlock: { position: 'relative', minHeight: 68, paddingBottom: 12 },
  timeIconLane: { position: 'absolute', left: 0, top: 12, width: 46, height: 44, alignItems: 'center', justifyContent: 'center' },
  timeLine: { minHeight: 56, flexDirection: 'row', alignItems: 'flex-start' },
  timeEndpoint: { width: '50%', minHeight: 56, paddingTop: 12 },
  timeStartEndpoint: { paddingLeft: 46, paddingRight: 12 },
  timeEndEndpoint: { paddingLeft: 32, paddingRight: 16 },
  timeRangeArrow: { position: 'absolute', left: '50%', top: 18, marginLeft: -4, width: 8, height: 32 },
  timeMain: { fontSize: 16, lineHeight: 22, color: C.text },
  timeMinor: { fontSize: 14, lineHeight: 22, color: C.text },
  editorRow: { minHeight: 48, paddingRight: 16, flexDirection: 'row', alignItems: 'center' },
  rowText: { flex: 1, fontSize: 16, lineHeight: 22, color: C.text },
  placeholderText: { color: C.faint },
  clearAction: { width: 32, height: 48, alignItems: 'center', justifyContent: 'center' },
  descriptionRow: { minHeight: 48, flexDirection: 'row', alignItems: 'flex-start', paddingRight: 16 },
  descriptionPreview: { flex: 1, marginTop: 13, marginBottom: 13, fontSize: 16, lineHeight: 22, color: C.text },
  deleteText: { flex: 1, fontSize: 16, lineHeight: 22, color: C.red },
});
