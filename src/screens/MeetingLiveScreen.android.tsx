import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AppState,
  PermissionsAndroid,
  StyleSheet,
  ToastAndroid,
  View,
} from 'react-native';
import type { RouteProp } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import {
  LaojiMinutesView,
  type MinutesRecordingContent,
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
import {
  MeetingManualNoteConflictSheet,
  type MeetingManualNoteConflictChoice,
} from '../components/MeetingManualNoteConflictSheet';
import { useAppDialog } from '../components/AppDialog';
import { useAuth } from '../store/AuthStore';
import { useMeetings } from '../store/MeetingsStore';
import {
  createGuestRealtimeSession,
  deleteGuestRealtimeSession,
  fetchGuestMeetingTranscriptSnapshot,
  fetchMeetingTranscriptSnapshot,
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
  formatNativeMinutesTimestamp,
  mergeNativeMinutesTranscript,
  type NativeMinutesTranscriptLine,
} from '../native/nativeMinutesSnapshots';
import type { RootStackParamList } from '../types';
import type { ScopeKey } from '../domain/meeting';
import {
  canResumeMeetingRecording,
  meetingRemoteIdentity,
  requireMeetingRemoteIdentity,
  shouldCheckpointTranscript,
} from '../utils/meetingMedia';
import { defaultMeetingTitle } from '../utils/meetingTitle';
import { CurrentAddressError, getCurrentAddress } from '../services/currentAddress';
import { useMeetingManualNote } from '../hooks/useMeetingManualNote';
import { createMeetingMarker } from '../services/meetingMarkers';
import {
  evaluateTranscriptLineCandidate,
  type TranscriptServerCompleteness,
} from '../services/transcriptCompleteness';
import {
  MeetingManualNoteSyncConflictChangedError,
  RecordingSessionController,
  ResolveMeetingManualNoteSyncConflictUseCase,
} from '../application/meeting';
import { sqliteMeetingNoteRepository } from '../data/repositories';
import {
  cancelMeetingPlannedEndReminder,
  reconcileMeetingPlannedEndReminder,
} from '../services/notifications';
import { pullMeetingManualNote } from '../services/meetingManualNotePull';
import {
  loadMeetingManualNoteSyncConflict,
  type MeetingManualNoteSyncConflictView,
} from '../services/meetingManualNoteConflicts';
import { diagnosticAudit, diagnosticWarn } from '../services/diagnostics';
import { mirrorLegacyTranscriptSaveFailure } from '../services/meetingStageMirror';

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

const resolveMeetingManualNoteSyncConflictUseCase = new ResolveMeetingManualNoteSyncConflictUseCase(
  sqliteMeetingNoteRepository,
);

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
    updateMeetingStatus,
    updateMeetingTitle,
    updateMeetingDetails,
    getCachedTranscript,
    saveCachedTranscript,
    refreshMeetings,
    reconcileAudioUploads,
  } = useMeetings();
  const { showDialog } = useAppDialog();
  const requestedMeetingId = route.params?.meetingId;
  const startRequested = route.params?.startRequested === true;
  const entryPoint = route.params?.entryPoint ?? 'meeting_tab';
  const existing = requestedMeetingId
    ? meetings.find(meeting => meeting.id === requestedMeetingId)
    : undefined;
  const [meetingId, setMeetingId] = useState(existing?.id ?? '');
  const [title, setTitle] = useState(existing?.title ?? defaultMeetingTitle());
  const [location, setLocation] = useState(existing?.location ?? '');
  const [locationLoading, setLocationLoading] = useState(false);
  const [phase, setPhase] = useState<MinutesRecordingPhase>('idle');
  const [elapsedMs, setElapsedMs] = useState(0);
  const [error, setError] = useState('');
  const [activeSessionId, setActiveSessionId] = useState('');
  const [transcript, setTranscript] = useState<NativeMinutesTranscriptLine[]>(
    () => existing ? getCachedTranscript(existing.id) : [],
  );
  const [activeContent, setActiveContent] = useState<MinutesRecordingContent>('transcript');
  const [followingLatest, setFollowingLatest] = useState(true);
  const [manualNoteConflict, setManualNoteConflict] = useState<MeetingManualNoteSyncConflictView | null>(null);
  const [manualNoteConflictTarget, setManualNoteConflictTarget] = useState<MeetingManualNoteSyncConflictView | null>(null);
  const [manualNoteConflictSaving, setManualNoteConflictSaving] = useState(false);
  const [manualNoteConflictError, setManualNoteConflictError] = useState('');
  const mountedRef = useRef(true);
  const recordingControllerRef = useRef(
    new RecordingSessionController<FinalizeMeetingRecordingResult, ActiveNativeRecording>(),
  );
  const currentSessionIdRef = useRef('');
  const activeMeetingIdRef = useRef(meetingId);
  const recorderSnapshotRef = useRef<NativeRecorderSnapshot | null>(null);
  const recorderErrorVisibleRef = useRef(false);
  const transcriptRef = useRef<NativeMinutesTranscriptLine[]>(transcript);
  const nativeAudioBarsRef = useRef<number[]>([]);
  const titleRef = useRef(title);
  const locationRef = useRef(location);
  const finalizationUiRef = useRef<Promise<boolean> | null>(null);
  const markerCreateQueueRef = useRef<Promise<void>>(Promise.resolve());
  const manualNoteConflictRequestGenerationRef = useRef(0);
  const autoStartAttemptedRef = useRef(false);
  const startedAtRef = useRef(new Date());
  const checkpointRef = useRef({ lineCount: finalizedNativeMinutesTranscript(transcript).length, savedAtMs: Date.now() });
  const createRequestRef = useRef(createClientRequestState('meeting'));
  const recordingStorageScope = isGuest ? 'guest' : session ? `user:${session.user.id}` : 'signed_out';
  const meetingScopeKey: ScopeKey | null = isGuest
    ? 'guest'
    : session
      ? `user:${session.user.id}`
      : null;
  const existingRemoteMeetingId = existing && !isGuest ? meetingRemoteIdentity(existing) : null;
  const manualNote = useMeetingManualNote(meetingScopeKey, meetingId || undefined);

  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  useEffect(() => { transcriptRef.current = transcript; }, [transcript]);
  useEffect(() => { titleRef.current = title; }, [title]);
  useEffect(() => { locationRef.current = location; }, [location]);
  useEffect(() => { activeMeetingIdRef.current = meetingId; }, [meetingId]);
  useEffect(() => {
    if (!existing) return;
    setTitle(existing.title ?? '');
  }, [existing?.id, existing?.title]);
  useEffect(() => {
    if (existing?.location == null) return;
    setLocation(existing.location);
  }, [existing?.location]);

  const refreshManualNoteConflict = useCallback(async () => {
    const requestedId = activeMeetingIdRef.current;
    if (!requestedId || !meetingScopeKey || meetingScopeKey === 'guest') {
      setManualNoteConflict(null);
      setManualNoteConflictTarget(null);
      return null;
    }
    const generation = manualNoteConflictRequestGenerationRef.current + 1;
    manualNoteConflictRequestGenerationRef.current = generation;
    try {
      const conflict = await loadMeetingManualNoteSyncConflict(meetingScopeKey, requestedId);
      if (
        !mountedRef.current
        || manualNoteConflictRequestGenerationRef.current !== generation
        || activeMeetingIdRef.current !== requestedId
      ) return null;
      setManualNoteConflict(conflict);
      setManualNoteConflictTarget(current => current && conflict?.id === current.id ? conflict : null);
      return conflict;
    } catch (reason) {
      diagnosticWarn('load live meeting manual note conflict failed', reason);
      return null;
    }
  }, [meetingScopeKey]);

  useEffect(() => {
    manualNoteConflictRequestGenerationRef.current += 1;
    setManualNoteConflict(null);
    setManualNoteConflictTarget(null);
    setManualNoteConflictSaving(false);
    setManualNoteConflictError('');
    void refreshManualNoteConflict();
  }, [meetingId, meetingScopeKey, refreshManualNoteConflict]);

  useEffect(() => {
    if (!meetingId || !meetingScopeKey || meetingScopeKey === 'guest') return undefined;
    let active = true;
    let unsubscribe: (() => void) | null = null;
    void sqliteMeetingNoteRepository.findByNativeSessionId(meetingId, meetingScopeKey)
      .then(aggregate => {
        if (!active || !aggregate) return;
        unsubscribe = sqliteMeetingNoteRepository.observeMeeting(
          aggregate.note.id,
          meetingScopeKey,
          () => { void refreshManualNoteConflict(); },
        );
      })
      .catch(reason => diagnosticWarn('observe live manual note conflict failed', reason));
    return () => {
      active = false;
      unsubscribe?.();
    };
  }, [meetingId, meetingScopeKey, refreshManualNoteConflict]);

  useEffect(() => {
    if (
      !accessToken
      || !meetingId
      || !meetingScopeKey
      || meetingScopeKey === 'guest'
      || !existingRemoteMeetingId
    ) {
      return undefined;
    }
    let active = true;
    let running = false;
    let requested = true;
    let controller: AbortController | null = null;
    const requestPull = () => {
      if (!active) return;
      requested = true;
      if (running) return;
      running = true;
      void (async () => {
        try {
          while (active && requested) {
            requested = false;
            controller = new AbortController();
            try {
              await manualNote.flush();
              const result = await pullMeetingManualNote({
                scopeKey: meetingScopeKey,
                meetingId,
                meetingRemoteId: existingRemoteMeetingId,
                accessToken,
                signal: controller.signal,
              });
              if (result.outcome === 'updated' || result.outcome === 'attached') {
                await manualNote.reload();
              }
              await refreshManualNoteConflict();
            } finally {
              controller = null;
            }
          }
        } catch (reason) {
          if (active) diagnosticWarn('pull live meeting manual note failed', reason);
        } finally {
          running = false;
          if (active && requested) requestPull();
        }
      })();
    };
    const appStateSubscription = AppState.addEventListener('change', nextState => {
      if (nextState === 'active') requestPull();
    });
    requestPull();
    return () => {
      active = false;
      requested = false;
      controller?.abort();
      appStateSubscription.remove();
    };
  }, [accessToken, existingRemoteMeetingId, manualNote.flush, manualNote.reload, meetingId, meetingScopeKey, refreshManualNoteConflict]);

  const applyRecorderSnapshot = useCallback((snapshot: NativeRecorderSnapshot) => {
    if (snapshot.sessionId !== currentSessionIdRef.current) return;
    recorderSnapshotRef.current = snapshot;
    if (snapshot.state === 'localSaved' || snapshot.state === 'failed') {
      void cancelMeetingPlannedEndReminder(snapshot.sessionId);
    }
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
    remoteMeetingId: string | null,
    stopAudio: () => Promise<string | undefined>,
    guestSession?: ApiGuestRealtimeSession,
  ) => {
    const recorder = recorderSnapshotRef.current;
    try {
      return await finalizeMeetingRecording({
        meetingId: id,
        remoteMeetingId,
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
        onTranscriptSaveFailure: (meetingId, reason) => meetingScopeKey
          ? mirrorLegacyTranscriptSaveFailure(meetingScopeKey, meetingId, reason)
          : Promise.resolve(),
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
          remoteMeetingId: pending.remoteMeetingId,
          operationId: `meeting-audio:${pending.meetingId}:${pending.createdAt}`,
          fileUri: pending.audioUri,
          mimeType: pending.mimeType,
          fileName: pending.fileName,
        }),
        updateStatus: updateMeetingStatus,
        refreshMeetings,
        reconcileUploads: reconcileAudioUploads,
      });
    } finally {
      if (guestSession) {
        await deleteGuestRealtimeSession(guestSession.meeting_id, guestSession.guest_token).catch(() => {});
      }
    }
  }, [accessToken, isGuest, meetingScopeKey, reconcileAudioUploads, recordingStorageScope, refreshMeetings, saveCachedTranscript, updateMeetingStatus]);

  const syncPersistedTranscript = useCallback(async (
    id: string,
    remoteMeetingId: string | null,
    guestSession?: ApiGuestRealtimeSession,
  ) => {
    const local = finalizedNativeMinutesTranscript(transcriptRef.current);
    let selected = local;
    let lastCandidate: typeof local | null = null;
    let lastCompleteness: TranscriptServerCompleteness = 'unknown';
    let lastRemoteRevisionId: string | null = null;
    let preservedDraft = false;
    if (isGuest) {
      if (guestSession) {
        for (const delayMs of [0, 250, 750]) {
          if (delayMs > 0) await new Promise(resolve => setTimeout(resolve, delayMs));
          try {
            const remote = await fetchGuestMeetingTranscriptSnapshot(
              guestSession.meeting_id,
              guestSession.guest_token,
            );
            const candidateKind = remote.completeness === 'incomplete' ? 'realtime_draft' : 'final';
            const decision = evaluateTranscriptLineCandidate(selected, remote.items, {
              candidateKind,
              serverCompleteness: remote.completeness,
            });
            lastCandidate = remote.items;
            lastCompleteness = remote.completeness;
            preservedDraft = !decision.useCandidate || decision.completing;
            if (decision.useCandidate) selected = remote.items;
            if (decision.useCandidate && !decision.completing && remote.items.length > 0) break;
          } catch {
            if (mountedRef.current) setError('实时转写暂时不可用，已保留现有文字记录');
            break;
          }
        }
      }
    } else if (accessToken && remoteMeetingId) {
      for (const delayMs of [0, 250, 750]) {
        if (delayMs > 0) await new Promise(resolve => setTimeout(resolve, delayMs));
        try {
          const remote = await fetchMeetingTranscriptSnapshot(remoteMeetingId, accessToken);
          const candidateKind = remote.completeness === 'incomplete' ? 'realtime_draft' : 'final';
          const decision = evaluateTranscriptLineCandidate(selected, remote.items, {
            candidateKind,
            serverCompleteness: remote.completeness,
          });
          lastCandidate = remote.items;
          lastCompleteness = remote.completeness;
          lastRemoteRevisionId = remote.remoteRevisionId;
          preservedDraft = !decision.useCandidate || decision.completing;
          if (decision.useCandidate) selected = remote.items;
          if (decision.useCandidate && !decision.completing && remote.items.length > 0) break;
        } catch {
          if (mountedRef.current) {
            setError('录音已保存，文字记录暂未补全；详情页会继续同步');
          }
          break;
        }
      }
    }
    const candidate = lastCandidate ?? local;
    const candidateKind = lastCandidate && lastCompleteness === 'incomplete'
      ? 'realtime_draft'
      : 'final';
    await saveCachedTranscript(id, candidate, {
      candidateKind,
      serverCompleteness: lastCandidate ? lastCompleteness : 'unknown',
      remoteRevisionId: lastRemoteRevisionId,
    }).catch(() => {
      if (mountedRef.current) setError('字幕已生成，但本机缓存写入失败；结束时会再次尝试');
    });
    const effective = getCachedTranscript(id);
    transcriptRef.current = effective;
    if (mountedRef.current) {
      setTranscript(effective);
      if (preservedDraft) setError('录音已保存，文字记录仍在补全；详情页会继续同步');
    }
  }, [accessToken, getCachedTranscript, isGuest, saveCachedTranscript]);

  const createActiveRecording = useCallback((
    id: string,
    remoteMeetingId: string | null,
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
      await syncPersistedTranscript(id, remoteMeetingId, guestSession);
      return localUri;
    };
    return {
      meetingId: id,
      sessionId: id,
      guestSession,
      finalize: createMeetingRecordingFinalizer(() => persistNativeRecording(
        id,
        remoteMeetingId,
        stopAudio,
        guestSession,
      )),
    };
  }, [applyRecorderSnapshot, persistNativeRecording, syncPersistedTranscript]);

  const finalizeActiveRecording = useCallback((navigateAfter: boolean) => {
    const controller = recordingControllerRef.current;
    if (finalizationUiRef.current) {
      controller.finalizeActive(navigateAfter);
      return finalizationUiRef.current;
    }
    const finalization = controller.finalizeActive(navigateAfter);
    if (!finalization) return Promise.resolve(false);
    setPhase('stopping');
    let operation: Promise<boolean> | null = null;
    operation = finalization
      .then(async completed => {
        await cancelMeetingPlannedEndReminder(completed.session.sessionId).catch(reason => {
          // The recording is already durable at this point. A reminder
          // registry failure must not be mislabeled as a save failure or make
          // the completed native session appear retryable.
          diagnosticWarn('cancel planned meeting end reminder after finalize failed', reason);
        });
        if (mountedRef.current) setActiveSessionId('');
        if (!mountedRef.current) return true;
        setPhase('saving');
        const warnings: string[] = [];
        if (completed.result.transcriptSaveFailed) warnings.push('文字记录保存失败，可稍后重试');
        if (completed.result.uploadFailed) {
          warnings.push(completed.result.retryQueued ? '录音将在联网后继续同步' : '录音上传状态未保存');
        }
        if (completed.result.statusSyncPending) warnings.push('会议状态稍后继续同步');
        const warning = warnings.length > 0 ? `会议录音已保存；${warnings.join('；')}` : '';
        setError(completed.navigateAfter ? '' : warning);
        if (warning) ToastAndroid.show(warning, ToastAndroid.LONG);
        if (completed.navigateAfter) {
          navigation.replace('Transcription', { meetingId: completed.session.meetingId });
        }
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
        if (finalizationUiRef.current === operation) finalizationUiRef.current = null;
      });
    finalizationUiRef.current = operation;
    return operation;
  }, [navigation, showDialog]);

  const restoreNativeSession = useCallback(async (): Promise<boolean> => {
    if (!existing || !hasNativeRecorder()) return false;
    currentSessionIdRef.current = existing.id;
    activeMeetingIdRef.current = existing.id;
    const current = await getNativeRecorderState(existing.id).catch(() => null);
    if (current && ['preparing', 'recording', 'paused', 'failed'].includes(current.state)) {
      setMeetingId(existing.id);
      setTitle(existing.title ?? '');
      setTranscript(getCachedTranscript(existing.id));
      applyRecorderSnapshot(current);
      const recoveredSession = createActiveRecording(
        existing.id,
        isGuest ? null : meetingRemoteIdentity(existing),
      );
      if (!recordingControllerRef.current.attachRecovered(recoveredSession)) return false;
      setActiveSessionId(existing.id);
      if (meetingScopeKey && current.state !== 'failed') {
        await reconcileMeetingPlannedEndReminder(existing.id, meetingScopeKey);
      }
      return true;
    }

    const recovery = await recoverNativeRecordings().catch(() => null);
    const recovered = recovery?.recordings.find(item => item.sessionId === existing.id);
    if (!recovered) return false;
    setMeetingId(existing.id);
    setTitle(existing.title ?? '');
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
    const remoteMeetingId = isGuest ? null : meetingRemoteIdentity(existing);
    await cancelMeetingPlannedEndReminder(existing.id);
    await syncPersistedTranscript(existing.id, remoteMeetingId);
    await persistNativeRecording(existing.id, remoteMeetingId, async () => recovered.localUri);
    await manualNote.flush();
    if (mountedRef.current) navigation.replace('Transcription', { meetingId: existing.id });
    return true;
  }, [applyRecorderSnapshot, createActiveRecording, existing, getCachedTranscript, isGuest, manualNote.flush, meetingScopeKey, navigation, persistNativeRecording, syncPersistedTranscript]);

  const startRecording = useCallback(async () => {
    if (!hasNativeRecorder()) {
      setPhase('failed');
      setError('当前版本暂时无法录音，请安装最新完整版本');
      return;
    }
    const startToken = recordingControllerRef.current.beginStart();
    if (startToken === null) return;
    setPhase('preparing');
    recorderErrorVisibleRef.current = false;
    setError('');
    nativeAudioBarsRef.current = [];
    let startedMeetingId = '';
    let guestSession: ApiGuestRealtimeSession | undefined;
    let nativeCaptureStarted = false;
    let startedSession: ActiveNativeRecording | null = null;
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
      const meetingPayload = { title: titleRef.current.trim(), mode: 'realtime' as const };
      createRequestRef.current = requestStateForPayload(createRequestRef.current, 'meeting', meetingPayload);
      const meeting = reusable ?? await createMeeting(meetingPayload.title, {
        mode: meetingPayload.mode,
        clientRequestId: createRequestRef.current.id,
        location: locationRef.current || null,
        entryPoint,
      });
      const remoteMeetingId = isGuest ? null : requireMeetingRemoteIdentity(meeting);
      startedMeetingId = meeting.id;
      navigation.setParams({ meetingId: meeting.id, startRequested: false });
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
      const websocketMeetingId = guestSession?.meeting_id ?? remoteMeetingId!;
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
        storageScope: recordingStorageScope,
        websocketUrl,
        allowInsecureDevelopment,
        ...credentials,
      });
      nativeCaptureStarted = true;
      applyRecorderSnapshot(snapshot);
      const active = createActiveRecording(meeting.id, remoteMeetingId, guestSession);
      startedSession = active;
      if (!recordingControllerRef.current.completeStart(startToken, active)) {
        // Android has already opened the recorder. Never turn a JS ownership
        // mismatch into a fake microphone failure or delete its remote ASR
        // session. Drop the stale start token and attach the native session as
        // a recovery handle so the user can still pause or stop it.
        recordingControllerRef.current.abandonStart(startToken);
        if (!recordingControllerRef.current.attachRecovered(active)) {
          throw new Error('录音已开始，但页面状态暂未同步；请返回后重新打开本记录');
        }
      }
      setActiveSessionId(meeting.id);
      setPhase('recording');
      if (meetingScopeKey) {
        await reconcileMeetingPlannedEndReminder(meeting.id, meetingScopeKey).catch(reason => {
          diagnosticWarn('reconcile planned meeting end reminder after recorder start failed', reason);
        });
      }
    } catch (reason) {
      if (nativeCaptureStarted) {
        const controller = recordingControllerRef.current;
        controller.abandonStart(startToken);
        const attached = startedSession
          ? controller.attachRecovered(startedSession)
          : controller.current()?.sessionId === startedMeetingId;
        diagnosticWarn('native recorder started before JS session ownership completed', reason);
        if (mountedRef.current) {
          setActiveSessionId(attached ? startedMeetingId : '');
          setPhase('recording');
          const message = attached
            ? '录音仍在继续，页面部分状态暂未同步。'
            : '录音仍在继续，请返回后重新打开本记录。';
          setError(message);
          showDialog({ title: '录音仍在继续', message, tone: 'warning' });
        }
        return;
      }
      if (guestSession) {
        await deleteGuestRealtimeSession(guestSession.meeting_id, guestSession.guest_token).catch(() => {});
      }
      if (startedMeetingId) {
        // The local MeetingNote and its occurrence link are already durable.
        // A recorder/ASR startup failure must stay resumable instead of
        // deleting the record and losing the user's calendar entry point.
        await updateMeetingStatus(startedMeetingId, 'failed').catch(() => {});
      }
      if (mountedRef.current) {
        const message = readableErrorMessage(reason, '启动会议录音失败，请稍后重试。');
        recorderErrorVisibleRef.current = true;
        setPhase('failed');
        setError(message);
        showDialog({ title: '启动失败', message, tone: 'error' });
      }
    } finally {
      recordingControllerRef.current.abandonStart(startToken);
    }
  }, [accessToken, applyRecorderSnapshot, createActiveRecording, createMeeting, entryPoint, existing, getCachedTranscript, isGuest, meetingId, meetingScopeKey, meetings, navigation, showDialog, updateMeetingStatus]);

  const stopRecording = useCallback(async (navigateAfter = true) => {
    if (!recordingControllerRef.current.current()) return false;
    await manualNote.flush();
    return finalizeActiveRecording(navigateAfter);
  }, [finalizeActiveRecording, manualNote.flush]);

  const togglePause = useCallback(async () => {
    const active = recordingControllerRef.current.current();
    if (!active || !['recording', 'paused'].includes(phase)) return;
    setError('');
    try {
      const snapshot = phase === 'paused'
        ? await resumeNativeRecorder(active.sessionId)
        : await pauseNativeRecorder(active.sessionId);
      applyRecorderSnapshot(snapshot);
      await updateMeetingStatus(
        active.meetingId,
        snapshot.state === 'paused' ? 'paused' : 'recording',
      ).catch(() => false);
    } catch (reason) {
      setError(readableErrorMessage(reason, '录音状态切换失败，请重试。'));
    }
  }, [applyRecorderSnapshot, phase, updateMeetingStatus]);

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
      if (requestedMeetingId && existing && startRequested) {
        await startRecording();
        return;
      }
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
  }, [existing, meetingsLoading, requestedMeetingId, restoreNativeSession, startRecording, startRequested, updateMeetingStatus]);

  const confirmStop = useCallback(() => {
    if (!recordingControllerRef.current.current()) return;
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

  const createMarkerAt = useCallback((id: string, positionMs: number) => {
    if (!meetingScopeKey || id !== activeMeetingIdRef.current || !Number.isSafeInteger(positionMs) || positionMs < 0) {
      ToastAndroid.show('当前无法添加标记', ToastAndroid.SHORT);
      return;
    }
    const task = markerCreateQueueRef.current
      .catch(() => {})
      .then(async () => {
        try {
          await createMeetingMarker(meetingScopeKey, id, positionMs);
          if (mountedRef.current) {
            ToastAndroid.show(
              `已标记 ${formatNativeMinutesTimestamp(positionMs / 1_000)}`,
              ToastAndroid.SHORT,
            );
          }
        } catch (reason) {
          if (mountedRef.current) {
            ToastAndroid.show(
              readableErrorMessage(reason, '标记未保存，请重试。'),
              ToastAndroid.LONG,
            );
          }
        }
      });
    markerCreateQueueRef.current = task;
  }, [meetingScopeKey]);

  const openManualNoteConflict = useCallback(async () => {
    await manualNote.flush();
    const conflict = manualNoteConflict ?? await refreshManualNoteConflict();
    if (!conflict) {
      ToastAndroid.show('笔记冲突已处理', ToastAndroid.SHORT);
      return;
    }
    setManualNoteConflictError('');
    setManualNoteConflictTarget(conflict);
  }, [manualNote.flush, manualNoteConflict, refreshManualNoteConflict]);

  const resolveManualNoteConflict = useCallback(async (
    choice: MeetingManualNoteConflictChoice,
  ) => {
    if (!meetingScopeKey || !manualNoteConflictTarget || manualNoteConflictSaving) return;
    setManualNoteConflictSaving(true);
    setManualNoteConflictError('');
    try {
      await resolveMeetingManualNoteSyncConflictUseCase.execute({
        conflictId: manualNoteConflictTarget.id,
        meetingId: manualNoteConflictTarget.meetingId,
        scopeKey: meetingScopeKey,
        expectedLocalRevision: manualNoteConflictTarget.local.revision,
        resolution: choice,
      });
      await manualNote.reload();
      await refreshManualNoteConflict();
      setManualNoteConflictTarget(null);
      ToastAndroid.show(
        choice === 'keep_local' ? '本机笔记将重新同步' : '已使用云端笔记',
        ToastAndroid.SHORT,
      );
    } catch (reason) {
      diagnosticAudit('live_manual_note_conflict_resolution_failed', {
        operation: choice,
        error_code: reason instanceof MeetingManualNoteSyncConflictChangedError
          ? 'conflict_changed'
          : 'resolution_failed',
      });
      setManualNoteConflictError(reason instanceof MeetingManualNoteSyncConflictChangedError
        ? '这次冲突已发生变化，请关闭后重新打开。'
        : choice === 'keep_local'
          ? '本机笔记暂时无法重新同步，请稍后重试。'
          : '云端笔记暂时无法应用，请稍后重试。');
      if (reason instanceof MeetingManualNoteSyncConflictChangedError) {
        await refreshManualNoteConflict().catch(() => null);
      }
    } finally {
      if (mountedRef.current) setManualNoteConflictSaving(false);
    }
  }, [manualNote.reload, manualNoteConflictSaving, manualNoteConflictTarget, meetingScopeKey, refreshManualNoteConflict]);

  const handleAction = useCallback((action: MinutesSemanticAction) => {
    switch (action.type) {
      case 'back':
        void manualNote.flush().finally(() => navigation.goBack());
        break;
      case 'startRecording':
        void startRecording();
        break;
      case 'retryRecording':
        if (recordingControllerRef.current.current() && ['recording', 'paused'].includes(phase)) {
          void retryTranscriptCache();
        } else if (recordingControllerRef.current.current() && phase === 'failed') {
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
      case 'createMarker':
        if (!['recording', 'paused'].includes(phase)) break;
        createMarkerAt(action.meetingId, action.positionMs);
        break;
      case 'requestMeetingLocation':
        void requestMeetingLocation();
        break;
      case 'setFollowLatest':
        setFollowingLatest(action.followLatest);
        break;
      case 'selectRecordingContent':
        if (action.meetingId !== activeMeetingIdRef.current) break;
        setActiveContent(action.content);
        break;
      case 'updateManualNote':
        if (action.meetingId !== activeMeetingIdRef.current) break;
        manualNote.updateContent(action.content);
        break;
      case 'retryManualNote':
        if (action.meetingId !== activeMeetingIdRef.current) break;
        void manualNote.retry();
        break;
      case 'openManualNoteConflict':
        if (action.meetingId !== activeMeetingIdRef.current) break;
        void openManualNoteConflict();
        break;
      case 'saveTitle': {
        const nextTitle = action.title.trim();
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
  }, [confirmStop, createMarkerAt, manualNote, navigation, openManualNoteConflict, phase, requestMeetingLocation, retryTranscriptCache, startRecording, stopRecording, togglePause, updateMeetingTitle]);

  // Refs protect async recorder commands, but assigning a ref does not render
  // the native snapshot. Keep a small reactive identity so pause/stop become
  // enabled on the same frame that recording begins.
  const hasActive = Boolean(activeSessionId);
  const requestedMeetingMissing = Boolean(requestedMeetingId && !meetingsLoading && !existing);
  const canPause = hasActive && ['recording', 'paused'].includes(phase);
  const canStop = hasActive && ['recording', 'paused', 'failed'].includes(phase);
  const canCreateMarker = Boolean(
    meetingScopeKey
    && (meetingId || requestedMeetingId)
    && hasActive
    && ['recording', 'paused'].includes(phase),
  );
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
    canCreateMarker,
    followLatest: followingLatest,
    activeContent,
    manualNote: manualNote.content,
    manualNoteLoading: manualNote.loading,
    manualNoteSaving: manualNote.saving,
    manualNoteEnabled: manualNote.enabled,
    manualNoteError: manualNote.error,
    manualNoteRetryable: manualNote.retryable,
    manualNoteConflict: manualNoteConflict !== null,
    transcript,
  }), [activeContent, canCreateMarker, canPause, canStart, canStop, elapsedMs, error, existing, followingLatest, location, locationLoading, manualNote.content, manualNote.enabled, manualNote.error, manualNote.loading, manualNote.retryable, manualNote.saving, manualNoteConflict, meetingId, phase, requestedMeetingId, title, transcript]);

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
      <MeetingManualNoteConflictSheet
        visible={manualNoteConflictTarget !== null}
        conflict={manualNoteConflictTarget}
        saving={manualNoteConflictSaving}
        error={manualNoteConflictError}
        onClose={() => {
          if (manualNoteConflictSaving) return;
          setManualNoteConflictTarget(null);
          setManualNoteConflictError('');
        }}
        onResolve={choice => { void resolveManualNoteConflict(choice); }}
      />
    </ScreenContainer>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  surface: { flex: 1 },
});
