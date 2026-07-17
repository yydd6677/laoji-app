import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AppState, PermissionsAndroid } from 'react-native';
import { NavigationProp, useIsFocused, useNavigation } from '@react-navigation/native';
import * as FileSystem from 'expo-file-system/legacy';
import {
  SCHEDULE_VOICE_SNAPSHOT_SCHEMA_VERSION,
  addNativeWindowOverlayActionListener,
  addNativeWindowOverlayDismissListener,
  addNativeRecorderErrorListener,
  addNativeRecorderStateListener,
  addNativeRecorderTranscriptListener,
  assertNativeRecorderDeploymentPolicy,
  createNativeOverlayOwnerId,
  dismissNativeWindowOverlay,
  hasNativeRecorder,
  resolveNativeRecorderInsecureDevelopment,
  presentNativeWindowOverlay,
  startNativeRecorder,
  stopNativeRecorder,
  type NativeRecorderStopResult,
  type ScheduleVoiceAction,
  type ScheduleVoiceSnapshot,
  type NativeWindowOverlayEvent,
} from 'laoji-native-platform';
import {
  ApiGuestRealtimeSession,
  ParseResult,
  createGuestRealtimeSession,
  deleteGuestRealtimeSession,
  parseAudio,
  parseText,
} from '../services/api';
import { getApiConfig } from '../services/config';
import { buildRealtimeAsrUrl } from '../services/realtimeAsr';
import { useEvents } from '../store/EventsStore';
import { useAppDialog } from './AppDialog';
import { CalEvent, EventDraftParams, RootStackParamList } from '../types';
import { colorForEvent, normalizeEventCategory } from '../utils/eventColors';
import { validateEventDraft } from '../utils/eventDraftValidation';
import { createClientRequestState, requestStateForPayload } from '../services/clientRequestId';
import { reminderUnavailableMessage } from '../services/notifications';
import { readableErrorMessage } from '../services/errors';

interface Props {
  visible: boolean;
  onClose: () => void;
  onSaved: () => void;
}

type Phase = ScheduleVoiceSnapshot['phase'];

type ActiveScheduleRecording = {
  session: ApiGuestRealtimeSession;
  sessionId: string;
};

function dateLabel(value: string): string {
  const date = new Date(`${value}T00:00:00`);
  if (Number.isNaN(date.getTime())) return value;
  const weekday = ['日', '一', '二', '三', '四', '五', '六'][date.getDay()];
  return `${date.getMonth() + 1}月${date.getDate()}日 周${weekday}`;
}

function repeatLabel(value: ParseResult['event_type']): string {
  return ({ once: '不重复', daily: '每天', weekly: '每周', monthly: '每月', yearly: '每年' })[value];
}

function reminderLabel(value: number | null | undefined): string {
  if (value == null) return '不提醒';
  if (value === 0) return '开始时';
  if (value % 1440 === 0) return `提前 ${value / 1440} 天`;
  if (value % 60 === 0) return `提前 ${value / 60} 小时`;
  return `提前 ${value} 分钟`;
}

function eventPayloadFromDraft(source: ParseResult, inputText: string): Omit<CalEvent, 'id'> {
  const category = normalizeEventCategory(source.category);
  const hasTimedRange = !source.is_all_day && Boolean(source.start_time && source.end_time);
  return {
    title: source.title.trim(),
    startDate: source.start_date,
    endDate: source.end_date ?? undefined,
    startTime: source.is_all_day ? undefined : source.start_time ?? undefined,
    endTime: source.is_all_day ? undefined : source.end_time ?? undefined,
    isAllDay: source.is_all_day,
    repeat: source.event_type === 'once' ? undefined : source.event_type,
    description: source.description ?? undefined,
    rawText: source.raw_text || inputText,
    location: source.location ?? undefined,
    category,
    detail: source.detail ?? undefined,
    status: source.status ?? undefined,
    spanning: source.spanning ?? Boolean(source.end_date && source.end_date !== source.start_date),
    reminderMinutes: hasTimedRange ? source.reminder_minutes ?? null : null,
    color: colorForEvent({ category }),
  };
}

function detailedDraft(source: ParseResult, inputText: string): EventDraftParams {
  const payload = eventPayloadFromDraft(source, inputText);
  return {
    title: payload.title,
    startDate: payload.startDate,
    endDate: payload.endDate,
    startTime: payload.startTime,
    endTime: payload.endTime,
    isAllDay: payload.isAllDay ?? false,
    repeat: payload.repeat,
    description: payload.description,
    rawText: payload.rawText,
    location: payload.location,
    category: payload.category,
    detail: payload.detail,
    status: payload.status,
    reminderMinutes: payload.reminderMinutes,
  };
}

async function deleteNativeScheduleAudio(uri: string | null | undefined): Promise<void> {
  if (!uri) return;
  const normalized = uri.includes('://') ? uri : `file://${uri}`;
  await FileSystem.deleteAsync(normalized, { idempotent: true }).catch(() => undefined);
}

function stopResultFromError(error: unknown): NativeRecorderStopResult | null {
  return (error as { result?: NativeRecorderStopResult } | null)?.result ?? null;
}

/** UI-OVERLAY-WINDOW-001 / MIN-AUDIO-001: Activity-owned sheet and AudioRecord runtime. */
export function VoiceInputModal({ visible, onClose, onSaved }: Props) {
  const navigation = useNavigation<NavigationProp<RootStackParamList>>();
  const isFocused = useIsFocused();
  const { addEvent, findConflicts } = useEvents();
  const { showDialog } = useAppDialog();
  const [phase, setPhase] = useState<Phase>('input');
  const [text, setText] = useState('');
  const [error, setError] = useState('');
  const [draft, setDraft] = useState<ParseResult | null>(null);
  const activeRef = useRef<ActiveScheduleRecording | null>(null);
  const transcriptRef = useRef(new Map<string, { text: string; startMs: number | null }>());
  const stopPromiseRef = useRef<Promise<ParseResult | null> | null>(null);
  const mountedRef = useRef(true);
  const runRef = useRef(0);
  const createRequestRef = useRef(createClientRequestState('event'));
  const ownerId = useMemo(() => createNativeOverlayOwnerId('schedule-voice'), []);
  const visibleRef = useRef(visible);
  visibleRef.current = visible;

  useEffect(() => () => { mountedRef.current = false; }, []);

  const currentTranscript = useCallback(() => [...transcriptRef.current.values()]
    .sort((left, right) => (left.startMs ?? Number.MAX_SAFE_INTEGER) - (right.startMs ?? Number.MAX_SAFE_INTEGER))
    .map(item => item.text.trim())
    .filter(Boolean)
    .join(''), []);

  useEffect(() => {
    if (!visible || !hasNativeRecorder()) return undefined;
    const subscriptions = [
      addNativeRecorderStateListener(event => {
        if (event.sessionId !== activeRef.current?.sessionId || !mountedRef.current) return;
        if (event.state === 'preparing') setPhase('preparing');
        if (event.state === 'recording') setPhase('recording');
        if (event.state === 'failed') setError(event.errorMessage || '语音输入暂时不可用');
      }),
      addNativeRecorderTranscriptListener(event => {
        if (event.sessionId !== activeRef.current?.sessionId || !event.text.trim()) return;
        transcriptRef.current.set(event.segmentId, { text: event.text, startMs: event.startMs });
        if (mountedRef.current) setText(currentTranscript());
      }),
      addNativeRecorderErrorListener(event => {
        if (event.sessionId && event.sessionId !== activeRef.current?.sessionId) return;
        if (mountedRef.current) setError(event.errorMessage || '语音输入暂时不可用');
      }),
    ];
    return () => subscriptions.forEach(subscription => subscription.remove());
  }, [currentTranscript, visible]);

  const releaseGuestSession = useCallback(async (active: ActiveScheduleRecording | null) => {
    if (!active) return;
    await deleteGuestRealtimeSession(active.session.meeting_id, active.session.guest_token).catch(() => undefined);
  }, []);

  const stopAndDiscard = useCallback(async () => {
    const active = activeRef.current;
    activeRef.current = null;
    if (!active) return;
    try {
      const result = await stopNativeRecorder(active.sessionId);
      await deleteNativeScheduleAudio(result.localUri);
    } catch (reason) {
      await deleteNativeScheduleAudio(stopResultFromError(reason)?.localUri);
    } finally {
      await releaseGuestSession(active);
    }
  }, [releaseGuestSession]);

  useEffect(() => {
    if (visible) {
      setPhase('input');
      setError('');
      setDraft(null);
      setText('');
      transcriptRef.current.clear();
      createRequestRef.current = createClientRequestState('event');
      return undefined;
    }
    runRef.current += 1;
    void stopAndDiscard();
    return undefined;
  }, [stopAndDiscard, visible]);

  const close = useCallback(() => {
    runRef.current += 1;
    void stopAndDiscard().finally(onClose);
  }, [onClose, stopAndDiscard]);

  useEffect(() => {
    if (visible && !isFocused) close();
  }, [close, isFocused, visible]);

  useEffect(() => {
    if (!visible) return undefined;
    const subscription = AppState.addEventListener('change', state => {
      if (state !== 'active') close();
    });
    return () => subscription.remove();
  }, [close, visible]);

  const startRecording = useCallback(async () => {
    if (activeRef.current || phase !== 'input') return;
    if (!hasNativeRecorder()) {
      setError('当前安装包未包含原生录音模块');
      return;
    }
    const runId = ++runRef.current;
    setPhase('preparing');
    setError('');
    transcriptRef.current.clear();
    setText('');
    let guestSession: ApiGuestRealtimeSession | null = null;
    try {
      const permission = await PermissionsAndroid.request(PermissionsAndroid.PERMISSIONS.RECORD_AUDIO);
      if (permission !== PermissionsAndroid.RESULTS.GRANTED) {
        setPhase('input');
        showDialog({ title: '无法录音', message: '请在系统设置中允许老记使用麦克风。', tone: 'warning' });
        return;
      }
      guestSession = await createGuestRealtimeSession('日程语音输入');
      if (runRef.current !== runId) {
        await deleteGuestRealtimeSession(guestSession.meeting_id, guestSession.guest_token).catch(() => undefined);
        return;
      }
      const config = getApiConfig();
      const allowInsecureDevelopment = resolveNativeRecorderInsecureDevelopment(
        config.isProduction,
        config.realtimeAsrSecure,
      );
      assertNativeRecorderDeploymentPolicy(config.isProduction, allowInsecureDevelopment);
      const websocketUrl = buildRealtimeAsrUrl({
        meetingId: guestSession.meeting_id,
        purpose: 'schedule',
        provider: config.realtimeAsrProvider,
        host: config.realtimeAsrHost,
        port: config.realtimeAsrPort,
        secure: config.realtimeAsrSecure,
      });
      activeRef.current = {
        session: guestSession,
        sessionId: guestSession.meeting_id,
      };
      await startNativeRecorder({
        sessionId: guestSession.meeting_id,
        purpose: 'schedule',
        websocketUrl,
        guestToken: guestSession.guest_token,
        allowInsecureDevelopment,
        levelIntervalMs: 120,
      });
      if (mountedRef.current && runRef.current === runId) setPhase('recording');
    } catch (reason) {
      const active = activeRef.current;
      activeRef.current = null;
      if (active) await releaseGuestSession(active);
      else if (guestSession) {
        await deleteGuestRealtimeSession(guestSession.meeting_id, guestSession.guest_token).catch(() => undefined);
      }
      if (mountedRef.current && runRef.current === runId) {
        setPhase('input');
        setError(readableErrorMessage(reason, '语音服务连接失败，请稍后重试。'));
      }
    }
  }, [phase, releaseGuestSession, showDialog]);

  const parseSourceText = useCallback(async (sourceText: string): Promise<ParseResult> => {
    const result = await parseText(sourceText.trim());
    if (!result.start_date) throw new Error('未识别到有效日期');
    return result;
  }, []);

  const stopAndParse = useCallback((): Promise<ParseResult | null> => {
    if (stopPromiseRef.current) return stopPromiseRef.current;
    const active = activeRef.current;
    if (!active) return Promise.resolve(null);
    activeRef.current = null;
    const runId = ++runRef.current;
    setPhase('parsing');
    setError('');
    const operation = (async () => {
      let localUri: string | null = null;
      try {
        let stopResult: NativeRecorderStopResult;
        try {
          stopResult = await stopNativeRecorder(active.sessionId);
        } catch (reason) {
          const recovered = stopResultFromError(reason);
          if (!recovered?.localSaved) throw reason;
          stopResult = recovered;
        }
        localUri = stopResult.localUri;
        const transcript = currentTranscript().trim();
        const result = transcript
          ? await parseSourceText(transcript)
          : localUri
            ? await parseAudio(localUri)
            : null;
        if (!result) throw new Error('未识别到语音内容');
        if (runRef.current !== runId) return null;
        const rawText = result.raw_text?.trim() || transcript;
        setText(rawText);
        setDraft(result);
        setPhase('confirm');
        return result;
      } catch (reason) {
        if (mountedRef.current && runRef.current === runId) {
          setPhase('input');
          setError(readableErrorMessage(reason, '未识别到语音内容，请重新录制。'));
        }
        return null;
      } finally {
        await deleteNativeScheduleAudio(localUri);
        await releaseGuestSession(active);
      }
    })().finally(() => {
      if (stopPromiseRef.current === operation) stopPromiseRef.current = null;
    });
    stopPromiseRef.current = operation;
    return operation;
  }, [currentTranscript, parseSourceText, releaseGuestSession]);

  const parseManualText = useCallback(async () => {
    const source = text.trim();
    if (!source || phase !== 'input') return;
    const runId = ++runRef.current;
    setPhase('parsing');
    setError('');
    try {
      const result = await parseSourceText(source);
      if (runRef.current !== runId) return;
      setDraft(result);
      setPhase('confirm');
    } catch (reason) {
      if (runRef.current !== runId) return;
      setError(readableErrorMessage(reason, '日程解析失败，请检查输入后重试。'));
      setPhase('input');
    }
  }, [parseSourceText, phase, text]);

  const persistDraft = useCallback(async (payload: Omit<CalEvent, 'id'>) => {
    const runId = ++runRef.current;
    setPhase('saving');
    try {
      createRequestRef.current = requestStateForPayload(createRequestRef.current, 'event', payload);
      const result = await addEvent({ ...payload, clientRequestId: createRequestRef.current.id });
      if (runRef.current !== runId) return;
      onSaved();
      onClose();
      if (result.reminderDelivery === 'unavailable') {
        const message = await reminderUnavailableMessage();
        showDialog({ title: '日程已保存', message, tone: 'warning' });
      } else if (result.reminderDelivery === 'unconfirmed') {
        showDialog({
          title: '日程已保存',
          message: '本机提醒状态未能确认，可重新打开日程并保存提醒。',
          tone: 'warning',
        });
      }
    } catch (reason) {
      if (runRef.current !== runId) return;
      setPhase('confirm');
      setError(readableErrorMessage(reason, '保存失败，请重试。'));
    }
  }, [addEvent, onClose, onSaved, showDialog]);

  const save = useCallback(async () => {
    if (!draft) return;
    const payload = eventPayloadFromDraft(draft, text);
    const validation = validateEventDraft(payload);
    if (!validation.valid || !validation.value) {
      setError(validation.issues[0]?.message ?? '日程信息不完整');
      return;
    }
    try {
      const conflicts = await findConflicts(validation.value);
      if (!conflicts.hasConflict) {
        await persistDraft(validation.value);
        return;
      }
      const names = conflicts.conflicts.map(({ event }) => `• ${event.title}`).join('\n');
      showDialog({
        title: '时间冲突',
        message: `该安排与以下日程重叠：\n${names}`,
        hint: conflicts.complete ? '确认可以重叠后仍可保存。' : '当前只能核对本机已有日程。',
        tone: 'warning',
        actions: [
          { text: '仍然保存', role: 'primary', onPress: () => { void persistDraft(validation.value!); } },
          { text: '取消', role: 'cancel' },
        ],
      });
    } catch (reason) {
      setError(readableErrorMessage(reason, '暂时无法检查日程冲突，请重试。'));
    }
  }, [draft, findConflicts, persistDraft, showDialog, text]);

  const openDetails = useCallback(() => {
    if (!draft) return;
    const params = { date: draft.start_date, draft: detailedDraft(draft, text) };
    onClose();
    navigation.navigate('AddEvent', params);
  }, [draft, navigation, onClose, text]);

  const handleAction = useCallback((action: ScheduleVoiceAction) => {
    if (action.type === 'text-change') setText(action.text);
    else if (action.type === 'close') close();
    else if (action.type === 'record-start') void startRecording();
    else if (action.type === 'record-stop') void stopAndParse();
    else if (action.type === 'parse') void parseManualText();
    else if (action.type === 'save') void save();
    else if (action.type === 'edit-details') openDetails();
    else if (action.type === 'retry-input') {
      setDraft(null);
      setPhase('input');
      setError('');
    }
  }, [close, openDetails, parseManualText, save, startRecording, stopAndParse]);

  const snapshot = useMemo<ScheduleVoiceSnapshot>(() => {
    const dateRange = draft
      ? draft.end_date && draft.end_date !== draft.start_date
        ? `${dateLabel(draft.start_date)} - ${dateLabel(draft.end_date)}`
        : dateLabel(draft.start_date)
      : '';
    const fields = draft ? [
      { key: 'date', label: '日期', value: dateRange },
      {
        key: 'time',
        label: '时间',
        value: draft.is_all_day || !draft.start_time
          ? '全天 / 无具体时间'
          : `${draft.start_time}${draft.end_time ? ` - ${draft.end_time}` : ''}`,
      },
      { key: 'repeat', label: '重复', value: repeatLabel(draft.event_type) },
      { key: 'reminder', label: '提醒', value: reminderLabel(draft.reminder_minutes) },
      ...(draft.location ? [{ key: 'location', label: '地点', value: draft.location }] : []),
      ...(draft.category ? [{ key: 'category', label: '分类', value: String(draft.category) }] : []),
    ] : [];
    return {
      schemaVersion: SCHEDULE_VOICE_SNAPSHOT_SCHEMA_VERSION,
      phase,
      text,
      errorMessage: error,
      statusLabel: phase === 'preparing'
        ? '正在连接语音服务'
        : phase === 'recording'
          ? '实时识别中，轻点或松开结束'
          : phase === 'parsing'
            ? '正在解析日程'
            : phase === 'saving'
              ? '正在保存日程'
              : '',
      title: draft?.title,
      fields,
      canParse: Boolean(text.trim()),
      canSave: Boolean(draft?.title.trim() && draft.start_date),
      canEditDetails: Boolean(draft?.start_date),
    };
  }, [draft, error, phase, text]);

  useEffect(() => {
    const matchesOwner = (event: NativeWindowOverlayEvent) => (
      event.kind === 'schedule-voice' && event.ownerId === ownerId
    );
    const actionSubscription = addNativeWindowOverlayActionListener(event => {
      if (!matchesOwner(event) || !event.type) return;
      handleAction(event as unknown as ScheduleVoiceAction);
    });
    const dismissSubscription = addNativeWindowOverlayDismissListener(event => {
      if (matchesOwner(event) && visibleRef.current) onClose();
    });
    return () => {
      actionSubscription.remove();
      dismissSubscription.remove();
    };
  }, [handleAction, onClose, ownerId]);

  useEffect(() => {
    if (visible) {
      void presentNativeWindowOverlay(ownerId, 'schedule-voice', snapshot);
    } else {
      void dismissNativeWindowOverlay(ownerId, 'schedule-voice', 'closed');
    }
  }, [ownerId, snapshot, visible]);

  useEffect(() => () => {
    void dismissNativeWindowOverlay(ownerId, 'schedule-voice', 'component-unmounted');
  }, [ownerId]);

  return null;
}

export const VOICE_INPUT_GEOMETRY = Object.freeze({
  titleBarHeight: 50,
  microphoneSize: 64,
  microphoneTouchSize: 88,
  holdToTalkDelay: 320,
  errorSlotHeight: 38,
});
