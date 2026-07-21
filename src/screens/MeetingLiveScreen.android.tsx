import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  PermissionsAndroid,
  StyleSheet,
  View,
} from 'react-native';
import type { RouteProp } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import {
  LaojiMinutesView,
  type MinutesRecordingPhase,
  type MinutesSemanticAction,
  addNativeRecorderErrorListener,
  addNativeRecorderStateListener,
  addNativeRecorderTranscriptListener,
  assertNativeRecorderDeploymentPolicy,
  getNativeRecorderState,
  hasNativeRecorder,
  pauseNativeRecorder,
  recoverNativeRecordings,
  resolveNativeRecorderInsecureDevelopment,
  resumeNativeRecorder,
  startNativeRecorder,
  stopNativeRecorder,
  type NativeRecorderSnapshot,
  type NativeRecorderStopResult,
} from 'laoji-native-platform';
import { ScreenContainer } from '../components/ScreenContainer';
import { useAppDialog } from '../components/AppDialog';
import { useAuth } from '../store/AuthStore';
import { useMeetings } from '../store/MeetingsStore';
import {
  createGuestRealtimeSession,
  deleteGuestRealtimeSession,
  fetchGuestMeetingTranscript,
  fetchMeetingTranscript,
  type ApiGuestRealtimeSession,
  uploadMeetingAudio,
} from '../services/api';
import { getApiConfig } from '../services/config';
import { createClientRequestState, requestStateForPayload } from '../services/clientRequestId';
import {
  createMeetingRecordingFinalizer,
  finalizeMeetingRecording,
  type FinalizeMeetingRecordingResult,
} from '../services/meetingRecording';
import { buildRealtimeAsrUrl } from '../services/realtimeAsr';
import { readableErrorMessage } from '../services/errors';
import { enqueueNativeMeetingUpload } from '../native/nativeTransferCoordinator';
import {
  buildNativeMinutesRecordingSnapshot,
  finalizedNativeMinutesTranscript,
  mergePersistedMinutesTranscript,
  mergeNativeMinutesTranscript,
  type NativeMinutesTranscriptLine,
} from '../native/nativeMinutesSnapshots';
import type { RootStackParamList } from '../types';
import { canResumeMeetingRecording, shouldCheckpointTranscript } from '../utils/meetingMedia';
import { defaultMeetingTitle, displayMeetingTitle } from '../utils/meetingTitle';
import { CurrentAddressError, getCurrentAddress } from '../services/currentAddress';

type Props = {
  navigation: NativeStackNavigationProp<RootStackParamList, 'MeetingLive'>;
  route: RouteProp<RootStackParamList, 'MeetingLive'>;
};

interface ActiveNativeRecording {
  meetingId: string;
  sessionId: string;
  guestSession?: ApiGuestRealtimeSession;
  finalize: () => Promise<FinalizeMeetingRecordingResult>;
}

function formatMeetingStart(value: Date): string {
  return `${value.getMonth() + 1}月${value.getDate()}日 ${String(value.getHours()).padStart(2, '0')}:${String(value.getMinutes()).padStart(2, '0')}`;
}

function formatStoredMeetingStart(date?: string, time?: string): string {
  const match = date?.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  const dateLabel = match ? `${Number(match[2])}月${Number(match[3])}日` : (date ?? '');
  return [dateLabel, time].filter(Boolean).join(' ');
}

function recordingPhase(state: NativeRecorderSnapshot['state'] | 'idle' | 'saving'): MinutesRecordingPhase {
  if (state === 'localSaved' || state === 'saving') return 'saving';
  return state;
}

function statusLabel(phase: MinutesRecordingPhase): string {
  if (phase === 'preparing') return '正在连接实时转写';
  if (phase === 'recording') return '实时转写中';
  if (phase === 'paused') return '录音已暂停';
  if (phase === 'stopping') return '正在停止录音';
  if (phase === 'saving') return '正在保存会议记录';
  if (phase === 'failed') return '录音需要重试';
  return '准备开始录音';
}

function localUriFromStopError(error: unknown): NativeRecorderStopResult | null {
  const result = (error as { result?: NativeRecorderStopResult } | null)?.result;
  return result?.localSaved && result.localUri ? result : null;
}

/** MIN-REC-STATE-001: Android owns capture; this route only coordinates domain operations. */
export function MeetingLiveScreen({ navigation, route }: Props) {
  const { accessToken, isGuest, session } = useAuth();
  const {
    meetings,
    loading: meetingsLoading,
    createMeeting,
    deleteMeeting,
    updateMeetingStatus,
    updateMeetingTitle,
    updateMeetingDetails,
    getCachedTranscript,
    saveCachedTranscript,
    refreshMeetings,
  } = useMeetings();
  const { showDialog } = useAppDialog();
  const requestedMeetingId = route.params?.meetingId;
  const existing = requestedMeetingId
    ? meetings.find(meeting => meeting.id === requestedMeetingId)
    : undefined;
  const [meetingId, setMeetingId] = useState(existing?.id ?? '');
  const [title, setTitle] = useState(displayMeetingTitle(existing?.title ?? defaultMeetingTitle()));
  const [location, setLocation] = useState(existing?.location ?? '');
  const [locationLoading, setLocationLoading] = useState(false);
  const [phase, setPhase] = useState<MinutesRecordingPhase>('idle');
  const [elapsedMs, setElapsedMs] = useState(0);
  const [error, setError] = useState('');
  const [activeSessionId, setActiveSessionId] = useState('');
  const [transcript, setTranscript] = useState<NativeMinutesTranscriptLine[]>(
    () => existing ? getCachedTranscript(existing.id) : [],
  );
  const [followingLatest, setFollowingLatest] = useState(true);
  const mountedRef = useRef(true);
  const activeRef = useRef<ActiveNativeRecording | null>(null);
  const currentSessionIdRef = useRef('');
  const activeMeetingIdRef = useRef(meetingId);
  const recorderSnapshotRef = useRef<NativeRecorderSnapshot | null>(null);
  const recorderErrorVisibleRef = useRef(false);
  const transcriptRef = useRef<NativeMinutesTranscriptLine[]>(transcript);
  const nativeAudioBarsRef = useRef<number[]>([]);
  const titleRef = useRef(title);
  const locationRef = useRef(location);
  const finalizationRef = useRef<Promise<boolean> | null>(null);
  const navigateAfterFinalizeRef = useRef(false);
  const autoStartAttemptedRef = useRef(false);
  const startInFlightRef = useRef(false);
  const startedAtRef = useRef(new Date());
  const checkpointRef = useRef({ lineCount: finalizedNativeMinutesTranscript(transcript).length, savedAtMs: Date.now() });
  const createRequestRef = useRef(createClientRequestState('meeting'));
  const recordingStorageScope = isGuest ? 'guest' : session ? `user:${session.user.id}` : 'signed_out';

  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  useEffect(() => { transcriptRef.current = transcript; }, [transcript]);
  useEffect(() => { titleRef.current = title; }, [title]);
  useEffect(() => { locationRef.current = location; }, [location]);
  useEffect(() => { activeMeetingIdRef.current = meetingId; }, [meetingId]);
  useEffect(() => {
    if (!existing?.title) return;
    setTitle(displayMeetingTitle(existing.title));
  }, [existing?.title]);
  useEffect(() => {
    if (existing?.location == null) return;
    setLocation(existing.location);
  }, [existing?.location]);

  const applyRecorderSnapshot = useCallback((snapshot: NativeRecorderSnapshot) => {
    if (snapshot.sessionId !== currentSessionIdRef.current) return;
    recorderSnapshotRef.current = snapshot;
    if (!mountedRef.current) return;
    setPhase(recordingPhase(snapshot.state));
    setElapsedMs(snapshot.durationMs);
    if (snapshot.state === 'recording' || snapshot.state === 'paused') {
      if (recorderErrorVisibleRef.current) {
        recorderErrorVisibleRef.current = false;
        setError('');
      }
    } else if (snapshot.state === 'failed' && snapshot.errorMessage) {
      recorderErrorVisibleRef.current = true;
      setError(readableErrorMessage(snapshot.errorMessage, '录音暂时不可用，请稍后重试。'));
    }
  }, []);

  const checkpointTranscript = useCallback((next: NativeMinutesTranscriptLine[]) => {
    const id = activeMeetingIdRef.current;
    if (!id) return;
    const finalLines = finalizedNativeMinutesTranscript(next);
    const previous = checkpointRef.current;
    const now = Date.now();
    if (!shouldCheckpointTranscript(finalLines.length, previous.lineCount, now - previous.savedAtMs)) return;
    checkpointRef.current = { lineCount: finalLines.length, savedAtMs: now };
    void saveCachedTranscript(id, finalLines).catch(() => {
      if (checkpointRef.current.lineCount === finalLines.length) checkpointRef.current = previous;
      if (mountedRef.current) setError('转写正在显示，但本机缓存暂时写入失败；结束时会再次保存');
    });
  }, [saveCachedTranscript]);

  const retryTranscriptCache = useCallback(async () => {
    const id = activeMeetingIdRef.current;
    if (!id) {
      if (mountedRef.current) setError('当前会议记录尚未建立，请重新开始录音');
      return;
    }
    const finalLines = finalizedNativeMinutesTranscript(transcriptRef.current);
    try {
      await saveCachedTranscript(id, finalLines);
      checkpointRef.current = { lineCount: finalLines.length, savedAtMs: Date.now() };
      if (mountedRef.current) setError('');
    } catch {
      if (mountedRef.current) setError('本机缓存仍未写入，请检查存储空间后重试');
    }
  }, [saveCachedTranscript]);

  useEffect(() => {
    if (!hasNativeRecorder()) return;
    const subscriptions = [
      addNativeRecorderStateListener(applyRecorderSnapshot),
      addNativeRecorderTranscriptListener(event => {
        const id = activeMeetingIdRef.current;
        if (!id || event.sessionId !== currentSessionIdRef.current) return;
        const next = mergeNativeMinutesTranscript(transcriptRef.current, event, id);
        transcriptRef.current = next;
        if (mountedRef.current) setTranscript(next);
        if (event.isFinal) checkpointTranscript(next);
      }),
      addNativeRecorderErrorListener(event => {
        if (event.sessionId && event.sessionId !== currentSessionIdRef.current) return;
        // Local audio remains valid while the realtime channel reconnects.
        // Do not present a recoverable ASR event as a microphone failure.
        if (event.recoverable) return;
        if (mountedRef.current) {
          recorderErrorVisibleRef.current = true;
          setError(readableErrorMessage(event.errorMessage, '录音暂时不可用，请稍后重试'));
        }
      }),
    ];
    return () => subscriptions.forEach(subscription => subscription.remove());
  }, [applyRecorderSnapshot, checkpointTranscript]);

  const persistNativeRecording = useCallback(async (
    id: string,
    stopAudio: () => Promise<string | undefined>,
    guestSession?: ApiGuestRealtimeSession,
  ) => {
    const recorder = recorderSnapshotRef.current;
    try {
      return await finalizeMeetingRecording({
        meetingId: id,
        storageScope: recordingStorageScope,
        transcriptLines: finalizedNativeMinutesTranscript(transcriptRef.current),
        getTranscriptLines: () => finalizedNativeMinutesTranscript(transcriptRef.current),
        isGuest,
        accessToken,
        audioDurationSec: recorder?.durationMs ? recorder.durationMs / 1000 : undefined,
        getAudioDurationSec: () => {
          const durationMs = recorderSnapshotRef.current?.durationMs;
          return durationMs ? durationMs / 1000 : undefined;
        },
        getAudioBars: () => nativeAudioBarsRef.current,
        stopAudio,
      }, {
        saveTranscript: saveCachedTranscript,
        uploadAudio: (meetingIdToUpload, uri, token) => uploadMeetingAudio(
          meetingIdToUpload,
          uri,
          token,
          { fileName: `${meetingIdToUpload}.wav`, mimeType: 'audio/wav' },
        ),
        enqueuePersistentUpload: (pending, token) => enqueueNativeMeetingUpload({
          scope: recordingStorageScope,
          accessToken: token,
          meetingId: pending.meetingId,
          operationId: `meeting-audio:${pending.meetingId}:${pending.createdAt}`,
          fileUri: pending.audioUri,
          mimeType: pending.mimeType,
          fileName: pending.fileName,
        }),
        updateStatus: updateMeetingStatus,
        refreshMeetings,
      });
    } finally {
      if (guestSession) {
        await deleteGuestRealtimeSession(guestSession.meeting_id, guestSession.guest_token).catch(() => {});
      }
    }
  }, [accessToken, isGuest, recordingStorageScope, refreshMeetings, saveCachedTranscript, updateMeetingStatus]);

  const syncPersistedTranscript = useCallback(async (
    id: string,
    guestSession?: ApiGuestRealtimeSession,
  ) => {
    const local = finalizedNativeMinutesTranscript(transcriptRef.current);
    let merged = local;
    if (isGuest) {
      if (guestSession) {
        for (const delayMs of [0, 250, 750]) {
          if (delayMs > 0) await new Promise(resolve => setTimeout(resolve, delayMs));
          try {
            const remote = await fetchGuestMeetingTranscript(
              guestSession.meeting_id,
              guestSession.guest_token,
              { fallbackItems: local },
            );
            merged = mergePersistedMinutesTranscript(local, remote);
            if (remote.length > 0 && remote.length >= local.length) break;
          } catch {
            if (mountedRef.current) setError('实时转写暂时不可用，已保留现有文字记录');
            break;
          }
        }
      }
    } else if (accessToken) {
      for (const delayMs of [0, 250, 750]) {
        if (delayMs > 0) await new Promise(resolve => setTimeout(resolve, delayMs));
        try {
          const remote = await fetchMeetingTranscript(id, accessToken);
          merged = mergePersistedMinutesTranscript(local, remote);
          if (remote.length > 0 && remote.length >= local.length) break;
        } catch {
          if (mountedRef.current) {
            setError('录音已保存，文字记录暂未补全；详情页会继续同步');
          }
          break;
        }
      }
    }
    await saveCachedTranscript(id, merged).catch(() => {
      if (mountedRef.current) setError('字幕已生成，但本机缓存写入失败；结束时会再次尝试');
    });
    transcriptRef.current = merged;
    if (mountedRef.current) setTranscript(merged);
  }, [accessToken, isGuest, saveCachedTranscript]);

  const createActiveRecording = useCallback((
    id: string,
    guestSession?: ApiGuestRealtimeSession,
  ): ActiveNativeRecording => {
    const stopAudio = async () => {
      let localUri: string | undefined;
      try {
        const result = await stopNativeRecorder(id);
        applyRecorderSnapshot(result.snapshot);
        nativeAudioBarsRef.current = result.audioBars;
        localUri = result.localUri ?? undefined;
      } catch (stopError) {
        const recovered = localUriFromStopError(stopError);
        if (!recovered) throw stopError;
        applyRecorderSnapshot(recovered.snapshot);
        nativeAudioBarsRef.current = recovered.audioBars;
        if (mountedRef.current) {
          setError('录音已保存在本机，但实时转写结束确认超时；可在详情中继续同步');
        }
        localUri = recovered.localUri ?? undefined;
      }
      await syncPersistedTranscript(id, guestSession);
      return localUri;
    };
    return {
      meetingId: id,
      sessionId: id,
      guestSession,
      finalize: createMeetingRecordingFinalizer(() => persistNativeRecording(id, stopAudio, guestSession)),
    };
  }, [applyRecorderSnapshot, persistNativeRecording, syncPersistedTranscript]);

  const finalizeActiveRecording = useCallback((active: ActiveNativeRecording, navigateAfter: boolean) => {
    navigateAfterFinalizeRef.current ||= navigateAfter;
    if (finalizationRef.current) return finalizationRef.current;
    setPhase('stopping');
    let operation: Promise<boolean> | null = null;
    operation = active.finalize()
      .then(() => {
        if (activeRef.current === active) {
          activeRef.current = null;
          if (mountedRef.current) setActiveSessionId('');
        }
        if (!mountedRef.current) return true;
        setPhase('saving');
        setError('');
        const shouldNavigate = navigateAfterFinalizeRef.current;
        navigateAfterFinalizeRef.current = false;
        if (shouldNavigate) navigation.replace('Transcription', { meetingId: active.meetingId });
        return true;
      })
      .catch(reason => {
        if (!mountedRef.current) return false;
        setPhase('failed');
        const message = readableErrorMessage(reason, '会议录音保存失败，请稍后重试。');
        setError(message);
        showDialog({ title: '保存失败', message, tone: 'error' });
        return false;
      })
      .finally(() => {
        if (finalizationRef.current === operation) finalizationRef.current = null;
      });
    finalizationRef.current = operation;
    return operation;
  }, [navigation, showDialog]);

  const restoreNativeSession = useCallback(async (): Promise<boolean> => {
    if (!existing || !hasNativeRecorder()) return false;
    currentSessionIdRef.current = existing.id;
    activeMeetingIdRef.current = existing.id;
    const current = await getNativeRecorderState(existing.id).catch(() => null);
    if (current && ['preparing', 'recording', 'paused', 'failed'].includes(current.state)) {
      setMeetingId(existing.id);
      setTitle(displayMeetingTitle(existing.title));
      setTranscript(getCachedTranscript(existing.id));
      applyRecorderSnapshot(current);
      activeRef.current = createActiveRecording(existing.id);
      setActiveSessionId(existing.id);
      return true;
    }

    const recovery = await recoverNativeRecordings().catch(() => null);
    const recovered = recovery?.recordings.find(item => item.sessionId === existing.id);
    if (!recovered) return false;
    setMeetingId(existing.id);
    setTitle(displayMeetingTitle(existing.title));
    setElapsedMs(recovered.durationMs);
    setPhase('saving');
    recorderSnapshotRef.current = {
      sessionId: existing.id,
      purpose: 'meeting',
      state: 'localSaved',
      startedAtMs: Date.now() - recovered.durationMs,
      updatedAtMs: Date.now(),
      bytesRecorded: recovered.bytesRecorded,
      durationMs: recovered.durationMs,
      localUri: recovered.localUri,
      asrConnected: false,
      readyToStop: true,
      transcriptRecoveryRequired: false,
      errorCode: null,
      errorMessage: null,
    };
    await syncPersistedTranscript(existing.id);
    await persistNativeRecording(existing.id, async () => recovered.localUri);
    if (mountedRef.current) navigation.replace('Transcription', { meetingId: existing.id });
    return true;
  }, [applyRecorderSnapshot, createActiveRecording, existing, getCachedTranscript, navigation, persistNativeRecording, syncPersistedTranscript]);

  const startRecording = useCallback(async () => {
    if (startInFlightRef.current || activeRef.current || finalizationRef.current) return;
    if (!hasNativeRecorder()) {
      setPhase('failed');
      setError('当前版本暂时无法录音，请安装最新完整版本');
      return;
    }
    startInFlightRef.current = true;
    setPhase('preparing');
    recorderErrorVisibleRef.current = false;
    setError('');
    nativeAudioBarsRef.current = [];
    let createdForAttempt = false;
    let startedMeetingId = '';
    let guestSession: ApiGuestRealtimeSession | undefined;
    try {
      const permission = await PermissionsAndroid.request(PermissionsAndroid.PERMISSIONS.RECORD_AUDIO);
      if (permission !== PermissionsAndroid.RESULTS.GRANTED) {
        setPhase('idle');
        showDialog({ title: '无法录音', message: '请允许麦克风权限后再开始会议。', tone: 'warning' });
        return;
      }
      const reusable = existing ?? (meetingId ? meetings.find(item => item.id === meetingId) : undefined);
      if (reusable && !canResumeMeetingRecording(reusable)) {
        throw new Error('该会议已有录音，不能继续写入同一份会议文件');
      }
      const meetingPayload = { title: titleRef.current.trim() || defaultMeetingTitle(), mode: 'realtime' as const };
      createRequestRef.current = requestStateForPayload(createRequestRef.current, 'meeting', meetingPayload);
      const meeting = reusable ?? await createMeeting(meetingPayload.title, {
        mode: meetingPayload.mode,
        clientRequestId: createRequestRef.current.id,
        location: locationRef.current || null,
      });
      createdForAttempt = !reusable;
      startedMeetingId = meeting.id;
      navigation.setParams({ meetingId: meeting.id });
      setMeetingId(meeting.id);
      activeMeetingIdRef.current = meeting.id;
      currentSessionIdRef.current = meeting.id;
      startedAtRef.current = new Date();
      const initialTranscript = reusable ? getCachedTranscript(meeting.id) : [];
      transcriptRef.current = initialTranscript;
      setTranscript(initialTranscript);
      checkpointRef.current = {
        lineCount: finalizedNativeMinutesTranscript(initialTranscript).length,
        savedAtMs: Date.now(),
      };
      const latestTitle = titleRef.current.trim() || meeting.title;
      await updateMeetingStatus(meeting.id, 'recording');
      if (isGuest) guestSession = await createGuestRealtimeSession(latestTitle);
      if (!isGuest && !accessToken) throw new Error('登录会话已失效，请重新登录');

      const config = getApiConfig();
      const allowInsecureDevelopment = resolveNativeRecorderInsecureDevelopment(
        config.isProduction,
        config.realtimeAsrSecure,
      );
      assertNativeRecorderDeploymentPolicy(config.isProduction, allowInsecureDevelopment);
      const websocketMeetingId = guestSession?.meeting_id ?? meeting.id;
      const websocketUrl = buildRealtimeAsrUrl({
        meetingId: websocketMeetingId,
        provider: config.realtimeAsrProvider,
        purpose: 'meeting',
        host: config.realtimeAsrHost,
        port: config.realtimeAsrPort,
        secure: config.realtimeAsrSecure,
      });
      const credentials = isGuest
        ? { guestToken: guestSession!.guest_token }
        : { accessToken: accessToken! };
      const snapshot = await startNativeRecorder({
        sessionId: meeting.id,
        purpose: 'meeting',
        websocketUrl,
        allowInsecureDevelopment,
        ...credentials,
      });
      applyRecorderSnapshot(snapshot);
      activeRef.current = createActiveRecording(meeting.id, guestSession);
      setActiveSessionId(meeting.id);
      setPhase('recording');
    } catch (reason) {
      if (guestSession) {
        await deleteGuestRealtimeSession(guestSession.meeting_id, guestSession.guest_token).catch(() => {});
      }
      if (startedMeetingId) {
        if (createdForAttempt) {
          await deleteMeeting(startedMeetingId).catch(async () => {
            await updateMeetingStatus(startedMeetingId, 'failed').catch(() => {});
          });
        } else {
          await updateMeetingStatus(startedMeetingId, 'failed').catch(() => {});
        }
      }
      if (mountedRef.current) {
        const message = readableErrorMessage(reason, '启动会议录音失败，请稍后重试。');
        recorderErrorVisibleRef.current = true;
        setPhase('failed');
        setError(message);
        showDialog({ title: '启动失败', message, tone: 'error' });
      }
    } finally {
      startInFlightRef.current = false;
    }
  }, [accessToken, applyRecorderSnapshot, createActiveRecording, createMeeting, deleteMeeting, existing, getCachedTranscript, isGuest, meetingId, meetings, navigation, showDialog, updateMeetingStatus]);

  const stopRecording = useCallback((navigateAfter = true) => {
    const active = activeRef.current;
    if (!active) return Promise.resolve(false);
    return finalizeActiveRecording(active, navigateAfter);
  }, [finalizeActiveRecording]);

  const togglePause = useCallback(async () => {
    const active = activeRef.current;
    if (!active || !['recording', 'paused'].includes(phase)) return;
    setError('');
    try {
      const snapshot = phase === 'paused'
        ? await resumeNativeRecorder(active.sessionId)
        : await pauseNativeRecorder(active.sessionId);
      applyRecorderSnapshot(snapshot);
    } catch (reason) {
      setError(readableErrorMessage(reason, '录音状态切换失败，请重试。'));
    }
  }, [applyRecorderSnapshot, phase]);

  useEffect(() => {
    if (autoStartAttemptedRef.current || meetingsLoading) return;
    if (requestedMeetingId && !existing) {
      autoStartAttemptedRef.current = true;
      setPhase('failed');
      setError('会议记录不存在，请返回会议列表后重试');
      return;
    }
    autoStartAttemptedRef.current = true;
    void (async () => {
      if (await restoreNativeSession()) return;
      if (requestedMeetingId && existing) {
        // A server/local row marked "recording" is not proof that Android still
        // owns a live AudioRecord session. Opening such a row must never start
        // the microphone implicitly. Reconcile the stale state and require an
        // explicit tap before creating a new native recording session.
        setElapsedMs(0);
        if (existing.status === 'recording') {
          setPhase('failed');
          setError('上次录音会话已中断，点击下方按钮可重新开始');
          await updateMeetingStatus(existing.id, 'failed').catch(() => {});
        } else {
          setPhase(existing.status === 'failed' ? 'failed' : 'idle');
          setError(existing.status === 'failed' ? '上次录音未完成，点击下方按钮可重新开始' : '点击下方按钮开始录音');
        }
        return;
      }
      await startRecording();
    })();
  }, [existing, meetingsLoading, requestedMeetingId, restoreNativeSession, startRecording, updateMeetingStatus]);

  const confirmStop = useCallback(() => {
    if (!activeRef.current) return;
    showDialog({
      title: '结束录音？',
      message: '结束后将先保存录音，再保存文字记录并安排后台同步。',
      tone: 'warning',
      actions: [
        { text: '结束录音', role: 'primary', onPress: async () => { await stopRecording(true); } },
        { text: '继续录音', role: 'cancel' },
      ],
    });
  }, [showDialog, stopRecording]);

  const requestMeetingLocation = useCallback(async () => {
    if (locationLoading) return;
    setLocationLoading(true);
    const previous = locationRef.current;
    try {
      const result = await getCurrentAddress();
      if (!mountedRef.current) return;
      locationRef.current = result.address;
      setLocation(result.address);
      const id = activeMeetingIdRef.current;
      if (id) await updateMeetingDetails(id, { location: result.address });
      if (result.usedCoordinateFallback && mountedRef.current) {
        showDialog({
          title: '已记录当前位置',
          message: '系统未返回详细地址，已保存当前位置坐标。',
          tone: 'info',
        });
      }
    } catch (reason) {
      locationRef.current = previous;
      if (mountedRef.current) {
        setLocation(previous);
        showDialog({
          title: '无法获取位置',
          message: reason instanceof CurrentAddressError
            ? reason.message
            : readableErrorMessage(reason, '暂时无法获取当前位置，请稍后重试。'),
          tone: 'warning',
        });
      }
    } finally {
      if (mountedRef.current) setLocationLoading(false);
    }
  }, [locationLoading, showDialog, updateMeetingDetails]);

  const handleAction = useCallback((action: MinutesSemanticAction) => {
    switch (action.type) {
      case 'back':
        navigation.goBack();
        break;
      case 'startRecording':
        void startRecording();
        break;
      case 'retryRecording':
        if (activeRef.current && ['recording', 'paused'].includes(phase)) {
          void retryTranscriptCache();
        } else if (activeRef.current && phase === 'failed') {
          void stopRecording(false);
        } else {
          void startRecording();
        }
        break;
      case 'stopRecording':
        confirmStop();
        break;
      case 'toggleRecordingPause':
        void togglePause();
        break;
      case 'requestMeetingLocation':
        void requestMeetingLocation();
        break;
      case 'setFollowLatest':
        setFollowingLatest(action.followLatest);
        break;
      case 'saveTitle': {
        const nextTitle = action.title.trim();
        if (!nextTitle) break;
        setTitle(nextTitle);
        titleRef.current = nextTitle;
        const id = action.meetingId || activeMeetingIdRef.current;
        if (id) {
          void updateMeetingTitle(id, nextTitle).catch(() => {
            if (mountedRef.current) setError('会议标题暂时未能保存，请稍后重试');
          });
        }
        break;
      }
      default:
        break;
    }
  }, [confirmStop, navigation, phase, requestMeetingLocation, retryTranscriptCache, startRecording, stopRecording, togglePause, updateMeetingTitle]);

  // Refs protect async recorder commands, but assigning a ref does not render
  // the native snapshot. Keep a small reactive identity so pause/stop become
  // enabled on the same frame that recording begins.
  const hasActive = Boolean(activeSessionId);
  const requestedMeetingMissing = Boolean(requestedMeetingId && !meetingsLoading && !existing);
  const canPause = hasActive && ['recording', 'paused'].includes(phase);
  const canStop = hasActive && ['recording', 'paused', 'failed'].includes(phase);
  const canStart = !hasActive
    && !requestedMeetingMissing
    && ['idle', 'failed'].includes(phase)
    && (!existing || canResumeMeetingRecording(existing));
  const snapshot = useMemo(() => buildNativeMinutesRecordingSnapshot({
    meetingId: meetingId || requestedMeetingId || '',
    title,
    startedAtLabel: existing
      ? formatStoredMeetingStart(existing.date, existing.time)
      : formatMeetingStart(startedAtRef.current),
    location,
    locationLoading,
    canEditLocation: !['stopping', 'saving'].includes(phase),
    phase,
    elapsedMs,
    statusLabel: statusLabel(phase),
    errorMessage: error,
    canPause,
    canStop,
    canStart,
    followLatest: followingLatest,
    transcript,
  }), [canPause, canStart, canStop, elapsedMs, error, existing, followingLatest, location, locationLoading, meetingId, phase, requestedMeetingId, title, transcript]);

  return (
    <ScreenContainer edges={['top', 'bottom']} bg="#FFFFFF">
      <View
        style={styles.root}
        testID="meeting-live-native-root"
        collapsable={false}
        collapsableChildren={false}
      >
        <LaojiMinutesView
          style={styles.surface}
          surface="recording"
          snapshot={snapshot}
          onMinutesAction={event => handleAction(event.nativeEvent)}
          testID="meeting-live-native-surface"
        />
      </View>
    </ScreenContainer>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  surface: { flex: 1 },
});
