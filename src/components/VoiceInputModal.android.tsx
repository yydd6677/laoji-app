import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AppState, InteractionManager, PermissionsAndroid } from 'react-native';
import { NavigationProp, useIsFocused, useNavigation } from '@react-navigation/native';
import * as FileSystem from 'expo-file-system/legacy';
import {
  SCHEDULE_VOICE_SNAPSHOT_SCHEMA_VERSION,
  addNativeWindowOverlayActionListener,
  addNativeWindowOverlayDismissListener,
  addNativeRecorderErrorListener,
  addNativeRecorderLevelListener,
  addNativeRecorderStateListener,
  addNativeRecorderTranscriptListener,
  assertNativeRecorderDeploymentPolicy,
  createNativeOverlayOwnerId,
  dismissNativeWindowOverlay,
  discardNativeRecorderPrewarm,
  hasNativeRecorder,
  resolveNativeRecorderInsecureDevelopment,
  presentNativeWindowOverlay,
  prewarmNativeRecorder,
  startNativeRecorder,
  stopNativeRecorder,
  type NativeRecorderStopResult,
  type ScheduleVoiceAction,
  type ScheduleVoiceSnapshot,
  type NativeWindowOverlayEvent,
} from 'laoji-native-platform';
import {
  ParseResult,
  clarifyText,
  parseAudio,
  parseText,
} from '../services/api';
import { scheduleTimePeriodFromText, scheduleTimePeriodLabel } from '../services/localScheduleParser';
import { getApiConfig } from '../services/config';
import { buildRealtimeAsrUrl, createRealtimeMeetingId } from '../services/realtimeAsr';
import { getLocalDeviceRealtimeAuth, type DeviceRealtimeAuth } from '../services/deviceApi';
import {
  ScheduleTranscriptSegment,
  appendScheduleTranscriptSegment,
  scheduleTranscriptDisplayText,
  scheduleTranscriptText,
} from '../services/scheduleTranscript';
import { useEvents } from '../store/EventsStore';
import { useAppDialog } from './AppDialog';
import { CalEvent, EventDraftParams, RootStackParamList } from '../types';
import { colorForEvent, normalizeEventCategory } from '../utils/eventColors';
import { validateEventDraft } from '../utils/eventDraftValidation';
import { createClientRequestState, requestStateForPayload } from '../services/clientRequestId';
import { reminderUnavailableMessage } from '../services/notifications';
import { readableErrorMessage } from '../services/errors';
import { diagnosticAudit } from '../services/diagnostics';

interface Props {
  visible: boolean;
  onClose: () => void;
  onSaved: () => void;
}

type Phase = ScheduleVoiceSnapshot['phase'];

type ActiveScheduleRecording = {
  auth: DeviceRealtimeAuth;
  sessionId: string;
};

type WarmDeviceSession = {
  promise: Promise<DeviceRealtimeAuth>;
};

type WarmScheduleConnection = {
  authPromise: Promise<DeviceRealtimeAuth>;
  sessionId: string;
  prewarmPromise: Promise<boolean>;
};

const LOW_AUDIO_PEAK = 1000;
const LOW_AUDIO_RMS = 280;

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

function localToday(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
}

function scheduleVoiceErrorMessage(reason: unknown, fallback: string): string {
  const message = readableErrorMessage(reason, fallback);
  if (/无法从语音中提取日程|未识别到有效日期|未识别到语音内容/.test(message)) {
    return '未识别到日程，请重试。';
  }
  return message;
}

function eventPayloadFromDraft(source: ParseResult, inputText: string): Omit<CalEvent, 'id'> {
  const category = normalizeEventCategory(source.category);
  const hasStartTime = !source.is_all_day && Boolean(source.start_time);
  return {
    title: source.title.trim(),
    startDate: source.start_date,
    endDate: source.end_date ?? undefined,
    startTime: source.is_all_day ? undefined : source.start_time ?? undefined,
    endTime: source.is_all_day ? undefined : source.end_time ?? undefined,
    isAllDay: source.is_all_day,
    repeat: source.event_type === 'once' ? undefined : source.event_type,
    recurrenceInterval: source.recurrence_interval ?? undefined,
    recurrenceWeekdays: source.recurrence_weekdays ?? undefined,
    recurrenceUntilDate: source.recurrence_until_date ?? undefined,
    description: source.description ?? undefined,
    rawText: source.raw_text || inputText,
    location: source.location ?? undefined,
    category,
    detail: source.detail ?? undefined,
    status: source.status ?? undefined,
    spanning: source.spanning ?? Boolean(source.end_date && source.end_date !== source.start_date),
    reminderMinutes: hasStartTime ? source.reminder_minutes ?? null : null,
    color: colorForEvent({ category }),
    ...(source.schedule_graph ? {
      eventRevision: source.schedule_graph.provenance.draft_revision,
      draftSourceSha256: source.schedule_graph.source.content_sha256,
      producerRevision: source.schedule_graph.provenance.producer_revision,
      graphSchemaRevision: 'mention-graph-v1',
    } : {}),
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
    recurrenceInterval: payload.recurrenceInterval,
    recurrenceWeekdays: payload.recurrenceWeekdays,
    recurrenceUntilDate: payload.recurrenceUntilDate,
    description: payload.description,
    rawText: payload.rawText,
    location: payload.location,
    category: payload.category,
    detail: payload.detail,
    status: payload.status,
    reminderMinutes: payload.reminderMinutes,
    eventRevision: payload.eventRevision,
    draftSourceSha256: payload.draftSourceSha256,
    producerRevision: payload.producerRevision,
    graphSchemaRevision: payload.graphSchemaRevision,
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
  const { addEvent } = useEvents();
  const { showDialog } = useAppDialog();
  const [phase, setPhase] = useState<Phase>('input');
  const [text, setText] = useState('');
  const [error, setError] = useState('');
  const [draft, setDraft] = useState<ParseResult | null>(null);
  const [clarificationAnswer, setClarificationAnswer] = useState('');
  const activeRef = useRef<ActiveScheduleRecording | null>(null);
  const stoppingSessionIdRef = useRef<string | null>(null);
  const transcriptRef = useRef<ScheduleTranscriptSegment[]>([]);
  const audioLevelRef = useRef({ frameCount: 0, maxPeak: 0, maxRms: 0 });
  const stopPromiseRef = useRef<Promise<ParseResult | null> | null>(null);
  const recordingPressedAtMsRef = useRef<number | null>(null);
  const firstTranscriptLoggedRef = useRef(false);
  const stopPressedAtMsRef = useRef<number | null>(null);
  const recordingStartingRunRef = useRef<number | null>(null);
  const stopRequestedWhileStartingRef = useRef(false);
  const stopAfterStartRef = useRef<() => void>(() => undefined);
  const warmDeviceSessionRef = useRef<WarmDeviceSession | null>(null);
  const warmScheduleConnectionRef = useRef<WarmScheduleConnection | null>(null);
  const mountedRef = useRef(true);
  const runRef = useRef(0);
  const createRequestRef = useRef(createClientRequestState('event'));
  const ownerId = useMemo(() => createNativeOverlayOwnerId('schedule-voice'), []);
  const visibleRef = useRef(visible);
  visibleRef.current = visible;

  const currentTranscript = useCallback(() => scheduleTranscriptText(transcriptRef.current), []);

  useEffect(() => {
    if (!visible || !hasNativeRecorder()) return undefined;
    const subscriptions = [
      addNativeRecorderStateListener(event => {
        if (event.sessionId !== activeRef.current?.sessionId || !mountedRef.current) return;
        if (event.state === 'preparing') setPhase('preparing');
        if (event.state === 'recording') {
          setPhase('recording');
          setError('');
        }
        if (event.state === 'failed') {
          setError(scheduleVoiceErrorMessage({
            errorCode: event.errorCode,
            errorMessage: event.errorMessage,
            // State snapshots do not expose a separate `recoverable` field.
            // A local URI plus recovery marker means PCM was preserved and
            // the user can continue syncing after the live ASR failure.
            recoverable: Boolean(event.localUri && event.transcriptRecoveryRequired),
          }, '语音输入暂时不可用'));
        }
      }),
      addNativeRecorderTranscriptListener(event => {
        const ownedSessionId = activeRef.current?.sessionId ?? stoppingSessionIdRef.current;
        if (event.sessionId !== ownedSessionId || !event.text.trim()) return;
        if (!firstTranscriptLoggedRef.current && recordingPressedAtMsRef.current != null) {
          firstTranscriptLoggedRef.current = true;
          diagnosticAudit('schedule_voice_first_text', {
            latency_ms: Math.max(0, Math.round(performance.now() - recordingPressedAtMsRef.current)),
            kind: event.kind,
          });
        }
        transcriptRef.current = appendScheduleTranscriptSegment(transcriptRef.current, {
          text: event.text,
          receivedAt: event.receivedAtMs,
          startTime: event.startMs == null ? undefined : event.startMs / 1000,
          endTime: event.endMs == null ? undefined : event.endMs / 1000,
        });
        if (mountedRef.current) {
          setText(scheduleTranscriptDisplayText(transcriptRef.current));
          setError('');
        }
      }),
      addNativeRecorderLevelListener(event => {
        if (event.sessionId !== activeRef.current?.sessionId) return;
        const level = audioLevelRef.current;
        level.frameCount += 1;
        level.maxPeak = Math.max(level.maxPeak, event.peak);
        level.maxRms = Math.max(level.maxRms, event.rms);
      }),
      addNativeRecorderErrorListener(event => {
        if (event.sessionId && event.sessionId !== activeRef.current?.sessionId) return;
        // Realtime ASR may reconnect while local recording remains healthy.
        // A recoverable transport event is not a microphone failure and must
        // not compete visually with an active recording/transcript state.
        if (event.recoverable) return;
        if (mountedRef.current) {
          setError(scheduleVoiceErrorMessage({
            errorCode: event.errorCode,
            errorMessage: event.errorMessage,
            recoverable: event.recoverable,
          }, '语音输入暂时不可用'));
        }
      }),
    ];
    return () => subscriptions.forEach(subscription => subscription.remove());
  }, [currentTranscript, visible]);

  const releaseDeviceSession = useCallback(async (_active: ActiveScheduleRecording | null) => {}, []);

  const createWarmDeviceSession = useCallback((): WarmDeviceSession => {
    const existing = warmDeviceSessionRef.current;
    if (existing) return existing;
    const warm: WarmDeviceSession = {
      promise: getLocalDeviceRealtimeAuth(),
    };
    warmDeviceSessionRef.current = warm;
    void warm.promise.catch(() => {
      if (warmDeviceSessionRef.current === warm) warmDeviceSessionRef.current = null;
    });
    return warm;
  }, []);

  const discardWarmDeviceSession = useCallback(async () => {
    warmDeviceSessionRef.current = null;
  }, []);

  const discardWarmScheduleConnection = useCallback(() => {
    const warm = warmScheduleConnectionRef.current;
    warmScheduleConnectionRef.current = null;
    if (warm) discardNativeRecorderPrewarm(warm.sessionId);
  }, []);

  const createWarmScheduleConnection = useCallback((): WarmScheduleConnection => {
    const existing = warmScheduleConnectionRef.current;
    if (existing) return existing;
    const sessionId = createRealtimeMeetingId();
    const authPromise = createWarmDeviceSession().promise;
    const prewarmPromise = authPromise.then(auth => {
      const config = getApiConfig();
      const realtimeSecure = config.realtimeAsrBase.startsWith('wss://');
      const allowInsecureDevelopment = resolveNativeRecorderInsecureDevelopment(
        config.isProduction,
        realtimeSecure,
      );
      assertNativeRecorderDeploymentPolicy(config.isProduction, allowInsecureDevelopment);
      return prewarmNativeRecorder({
        sessionId,
        purpose: 'schedule',
        websocketUrl: buildRealtimeAsrUrl({
          meetingId: sessionId,
          purpose: 'schedule',
          provider: config.realtimeAsrProvider,
          realtimeAsrBase: config.realtimeAsrBase,
        }),
        deviceToken: auth.deviceToken,
        dataEpoch: auth.dataEpoch,
        allowInsecureDevelopment,
        levelIntervalMs: 120,
      });
    });
    const warm = { authPromise, sessionId, prewarmPromise };
    warmScheduleConnectionRef.current = warm;
    void prewarmPromise.catch(() => {
      // RecorderEngine transparently creates a fresh socket if this warm
      // connection failed before the microphone was pressed.
    });
    return warm;
  }, [createWarmDeviceSession]);

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
      await releaseDeviceSession(active);
    }
  }, [releaseDeviceSession]);

  // Keep the device registration ready while the calendar screen is open.
  // The request is deferred until the first interaction batch has completed so
  // it cannot extend the app's first-frame work, but it normally finishes
  // before the user reaches the microphone button.
  useEffect(() => {
    if (!hasNativeRecorder()) return undefined;
    const interaction = InteractionManager.runAfterInteractions(() => {
      createWarmDeviceSession();
      createWarmScheduleConnection();
    });
    return () => {
      interaction.cancel();
      mountedRef.current = false;
      runRef.current += 1;
      discardWarmScheduleConnection();
      void Promise.allSettled([stopAndDiscard(), discardWarmDeviceSession()]);
    };
  }, [
    createWarmDeviceSession,
    createWarmScheduleConnection,
    discardWarmDeviceSession,
    discardWarmScheduleConnection,
    stopAndDiscard,
  ]);

  useEffect(() => {
    if (visible) {
      setPhase('input');
      setError('');
      setDraft(null);
      setClarificationAnswer('');
      setText('');
      transcriptRef.current = [];
      audioLevelRef.current = { frameCount: 0, maxPeak: 0, maxRms: 0 };
      createRequestRef.current = createClientRequestState('event');
      // Registration is short-lived work and never blocks the first frame.
      createWarmDeviceSession();
      createWarmScheduleConnection();
      return undefined;
    }
    runRef.current += 1;
    // Keep an unused warm connection while Calendar remains mounted. It owns
    // no microphone and removes the public TLS/WebSocket handshake from the
    // next press. Component cleanup and app backgrounding release it.
    void stopAndDiscard();
    return undefined;
  }, [createWarmDeviceSession, createWarmScheduleConnection, stopAndDiscard, visible]);

  const close = useCallback(() => {
    runRef.current += 1;
    discardWarmScheduleConnection();
    void stopAndDiscard().finally(onClose);
  }, [discardWarmScheduleConnection, onClose, stopAndDiscard]);

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
      setError('当前版本暂时无法录音，请更新后重试');
      return;
    }
    const runId = ++runRef.current;
    recordingStartingRunRef.current = runId;
    stopRequestedWhileStartingRef.current = false;
    recordingPressedAtMsRef.current = performance.now();
    firstTranscriptLoggedRef.current = false;
    stopPressedAtMsRef.current = null;
    // The microphone owns the interaction immediately. Local AudioRecord is
    // the critical path; service readiness and WebSocket setup stay hidden.
    setPhase('recording');
    setError('');
    transcriptRef.current = [];
    audioLevelRef.current = { frameCount: 0, maxPeak: 0, maxRms: 0 };
    setText('');
    try {
      const permissionPromise = PermissionsAndroid.check(PermissionsAndroid.PERMISSIONS.RECORD_AUDIO)
        .then(granted => granted
          ? PermissionsAndroid.RESULTS.GRANTED
          : PermissionsAndroid.request(PermissionsAndroid.PERMISSIONS.RECORD_AUDIO));
      const warmConnection = warmScheduleConnectionRef.current ?? createWarmScheduleConnection();
      warmScheduleConnectionRef.current = null;
      const deviceAuthPromise = warmConnection.authPromise;
      const [permissionResult, deviceAuthResult] = await Promise.allSettled([
        permissionPromise,
        deviceAuthPromise,
      ]);
      if (permissionResult.status === 'rejected') throw permissionResult.reason;
      if (deviceAuthResult.status === 'rejected') throw deviceAuthResult.reason;
      const deviceAuth = deviceAuthResult.value;
      const permission = permissionResult.value;
      if (permission !== PermissionsAndroid.RESULTS.GRANTED) {
        discardNativeRecorderPrewarm(warmConnection.sessionId);
        if (recordingStartingRunRef.current === runId) recordingStartingRunRef.current = null;
        setPhase('input');
        showDialog({ title: '无法录音', message: '请在系统设置中允许老记使用麦克风。', tone: 'warning' });
        return;
      }
      if (runRef.current !== runId) {
        discardNativeRecorderPrewarm(warmConnection.sessionId);
        if (recordingStartingRunRef.current === runId) recordingStartingRunRef.current = null;
        return;
      }
      const config = getApiConfig();
      const realtimeSecure = config.realtimeAsrBase.startsWith('wss://');
      const allowInsecureDevelopment = resolveNativeRecorderInsecureDevelopment(
        config.isProduction,
        realtimeSecure,
      );
      assertNativeRecorderDeploymentPolicy(config.isProduction, allowInsecureDevelopment);
      const sessionId = warmConnection.sessionId;
      const websocketUrl = buildRealtimeAsrUrl({
        meetingId: sessionId,
        purpose: 'schedule',
        provider: config.realtimeAsrProvider,
        realtimeAsrBase: config.realtimeAsrBase,
      });
      activeRef.current = {
        auth: deviceAuth,
        sessionId,
      };
      await startNativeRecorder({
        sessionId,
        purpose: 'schedule',
        websocketUrl,
        deviceToken: deviceAuth.deviceToken,
        dataEpoch: deviceAuth.dataEpoch,
        allowInsecureDevelopment,
        levelIntervalMs: 120,
      });
      if (recordingPressedAtMsRef.current != null) {
        diagnosticAudit('schedule_voice_capture_started', {
          latency_ms: Math.max(0, Math.round(performance.now() - recordingPressedAtMsRef.current)),
        });
      }
      if (recordingStartingRunRef.current === runId) recordingStartingRunRef.current = null;
      if (mountedRef.current && runRef.current === runId) {
        setPhase('recording');
        if (stopRequestedWhileStartingRef.current) stopAfterStartRef.current();
      }
    } catch (reason) {
      if (recordingStartingRunRef.current === runId) {
        recordingStartingRunRef.current = null;
        stopRequestedWhileStartingRef.current = false;
      }
      const active = activeRef.current;
      activeRef.current = null;
      if (active) await releaseDeviceSession(active);
      if (mountedRef.current && runRef.current === runId) {
        setPhase('input');
        setError(scheduleVoiceErrorMessage(reason, '语音服务连接失败，请稍后重试。'));
      }
    }
  }, [createWarmScheduleConnection, phase, releaseDeviceSession, showDialog]);

  const parseSourceText = useCallback(async (sourceText: string): Promise<ParseResult> => {
    return parseText(sourceText.trim());
  }, []);

  const stopAndParse = useCallback((): Promise<ParseResult | null> => {
    if (stopPromiseRef.current) return stopPromiseRef.current;
    const active = activeRef.current;
    if (!active) {
      if (recordingStartingRunRef.current !== null) stopRequestedWhileStartingRef.current = true;
      return Promise.resolve(null);
    }
    activeRef.current = null;
    stoppingSessionIdRef.current = active.sessionId;
    stopPressedAtMsRef.current = performance.now();
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
        for (const segment of stopResult.transcriptSegments ?? []) {
          transcriptRef.current = appendScheduleTranscriptSegment(transcriptRef.current, {
            text: segment.text,
            receivedAt: segment.receivedAtMs,
            startTime: segment.startMs == null ? undefined : segment.startMs / 1000,
            endTime: segment.endMs == null ? undefined : segment.endMs / 1000,
          });
        }
        const transcript = currentTranscript().trim();
        const needsFullAudioRecovery = stopResult.snapshot.transcriptRecoveryRequired;
        const level = audioLevelRef.current;
        const clearlySilent = level.frameCount >= 2
          && level.maxPeak < LOW_AUDIO_PEAK
          && level.maxRms < LOW_AUDIO_RMS;
        const result = transcript && !needsFullAudioRecovery
          ? await parseSourceText(transcript)
          : localUri && !clearlySilent
            ? await parseAudio(localUri, {
                reference_datetime: new Date().toISOString(),
                timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
              })
            : null;
        if (!result) throw new Error('未识别到语音内容');
        if (runRef.current !== runId) return null;
        const rawText = result.raw_text?.trim() || transcript;
        setText(rawText);
        setDraft(result);
        setClarificationAnswer('');
        setPhase('confirm');
        if (stopPressedAtMsRef.current != null) {
          diagnosticAudit('schedule_voice_draft_ready', {
            latency_ms: Math.max(0, Math.round(performance.now() - stopPressedAtMsRef.current)),
            used_recovery: needsFullAudioRecovery,
          });
        }
        return result;
      } catch (reason) {
        if (stopPressedAtMsRef.current != null) {
          diagnosticAudit('schedule_voice_draft_failed', {
            latency_ms: Math.max(0, Math.round(performance.now() - stopPressedAtMsRef.current)),
          });
        }
        if (mountedRef.current && runRef.current === runId) {
          setPhase('input');
          setError(scheduleVoiceErrorMessage(reason, '未识别到日程，请重试。'));
        }
        return null;
      } finally {
        if (stoppingSessionIdRef.current === active.sessionId) {
          stoppingSessionIdRef.current = null;
        }
        await deleteNativeScheduleAudio(localUri);
        await releaseDeviceSession(active);
      }
    })().finally(() => {
      if (stopPromiseRef.current === operation) stopPromiseRef.current = null;
    });
    stopPromiseRef.current = operation;
    return operation;
  }, [currentTranscript, parseSourceText, releaseDeviceSession]);
  stopAfterStartRef.current = () => { void stopAndParse(); };

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
      setClarificationAnswer('');
      setPhase('confirm');
    } catch (reason) {
      if (runRef.current !== runId) return;
      setError(scheduleVoiceErrorMessage(reason, '日程解析失败，请检查输入后重试。'));
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
    if (draft.needs_clarification || !draft.start_date) {
      setError(draft.clarification_question || '需要先补充日程信息');
      return;
    }
    const payload = eventPayloadFromDraft(draft, text);
    const validation = validateEventDraft(payload);
    if (!validation.valid || !validation.value) {
      setError(validation.issues[0]?.message ?? '日程信息不完整');
      return;
    }
    await persistDraft(validation.value);
  }, [draft, persistDraft, text]);

  const clarify = useCallback(async () => {
    const answer = clarificationAnswer.trim();
    if (!draft?.needs_clarification || !answer) return;
    const runId = ++runRef.current;
    setPhase('parsing');
    setError('');
    try {
      const result = await clarifyText(draft.raw_text?.trim() || text, answer, draft);
      if (runRef.current !== runId) return;
      setDraft(result);
      setClarificationAnswer('');
      setPhase('confirm');
    } catch (reason) {
      if (runRef.current !== runId) return;
      setError(scheduleVoiceErrorMessage(reason, '没有理解这次补充，请修改后重试。'));
      setPhase('confirm');
    }
  }, [clarificationAnswer, draft, text]);

  const openDetails = useCallback(() => {
    if (!draft) return;
    const editable = draft.start_date ? draft : { ...draft, start_date: localToday() };
    const params = { date: editable.start_date, draft: detailedDraft(editable, text) };
    onClose();
    navigation.navigate('AddEvent', params);
  }, [draft, navigation, onClose, text]);

  const handleAction = useCallback((action: ScheduleVoiceAction) => {
    if (action.type === 'text-change') setText(action.text);
    else if (action.type === 'clarification-change') setClarificationAnswer(action.text);
    else if (action.type === 'close') close();
    else if (action.type === 'record-start') void startRecording();
    else if (action.type === 'record-stop') void stopAndParse();
    else if (action.type === 'parse') void parseManualText();
    else if (action.type === 'save') void save();
    else if (action.type === 'clarify') void clarify();
    else if (action.type === 'edit-details') openDetails();
    else if (action.type === 'retry-input') {
      setDraft(null);
      setClarificationAnswer('');
      setPhase('input');
      setError('');
    }
  }, [clarify, close, openDetails, parseManualText, save, startRecording, stopAndParse]);

  const snapshot = useMemo<ScheduleVoiceSnapshot>(() => {
    const dateRange = draft
      ? draft.end_date && draft.end_date !== draft.start_date
        ? `${dateLabel(draft.start_date)} - ${dateLabel(draft.end_date)}`
        : draft.start_date ? dateLabel(draft.start_date) : '待补充'
      : '';
    const fuzzyTimeLabel = draft && !draft.start_time && !draft.is_all_day
      ? scheduleTimePeriodLabel(draft.time_period ?? scheduleTimePeriodFromText(draft.raw_text))
      : null;
    const fields = draft ? [
      { key: 'date', label: '日期', value: dateRange },
      {
        key: 'time',
        label: '时间',
        value: draft.is_all_day
          ? '全天'
          : fuzzyTimeLabel ?? (!draft.start_time
            ? '无具体时间'
            : `${draft.start_time}${draft.end_time ? ` - ${draft.end_time}` : ''}`),
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
          ? ''
          : phase === 'recording'
          ? '正在识别'
          : phase === 'parsing'
            ? '正在解析日程'
            : phase === 'saving'
              ? '正在保存日程'
              : '',
      title: draft?.title,
      fields,
      canParse: Boolean(text.trim()),
      canSave: Boolean(draft?.start_date && !draft.needs_clarification),
      canEditDetails: Boolean(draft),
      needsClarification: Boolean(draft?.needs_clarification),
      clarificationQuestion: draft?.clarification_question ?? '',
      clarificationAnswer,
      canClarify: Boolean(draft?.needs_clarification && clarificationAnswer.trim()),
    };
  }, [clarificationAnswer, draft, error, phase, text]);

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
    discardWarmScheduleConnection();
    void discardWarmDeviceSession();
    void dismissNativeWindowOverlay(ownerId, 'schedule-voice', 'component-unmounted');
  }, [discardWarmDeviceSession, discardWarmScheduleConnection, ownerId]);

  return null;
}

export const VOICE_INPUT_GEOMETRY = Object.freeze({
  titleBarHeight: 50,
  microphoneSize: 64,
  microphoneTouchSize: 88,
  holdToTalkDelay: 320,
  errorSlotHeight: 38,
});
