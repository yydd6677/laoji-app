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
  type NativeProjectionEnvelope,
  addNativeRecorderErrorListener,
  addNativeRecorderStateListener,
  addNativeRecorderTranscriptListener,
  acknowledgeNativeDeviceV2Transcript,
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
import { createMeetingBinding, getDeviceRealtimeAuth } from '../services/deviceApi';
import { loadDeviceV2Capabilities } from '../services/deviceV2Api';
import { startDeviceV2RealtimeRecording } from '../services/deviceV2Realtime';
import { getApiConfig } from '../services/config';
import { getFeatureFlags } from '../config/featureFlags';
import { useNativeProjection } from '../native/useNativeProjection';
import { fenceNativeProjectionAction } from '../native/projectionActionFence';
import { createClientRequestState, requestStateForPayload } from '../services/clientRequestId';
import {
  createMeetingRecordingFinalizer,
} from '../services/meetingRecording';
import { buildRealtimeAsrUrl } from '../services/realtimeAsr';
import { readableErrorMessage, readableRecorderErrorMessage } from '../services/errors';
import {
  buildNativeMinutesRecordingSnapshot,
  finalizedNativeMinutesTranscript,
  formatNativeMinutesTimestamp,
  mergeNativeMinutesTranscript,
  type NativeMinutesTranscriptLine,
} from '../native/nativeMinutesSnapshots';
import type { RootStackParamList } from '../types';
import {
  canResumeMeetingRecording,
  meetingRemoteIdentity,
  shouldCheckpointTranscript,
} from '../utils/meetingMedia';
import { defaultMeetingTitle } from '../utils/meetingTitle';
import { CurrentAddressError, getCurrentAddress } from '../services/currentAddress';
import { useMeetingManualNote } from '../hooks/useMeetingManualNote';
import {
  useNativeMeetingRecordingFinalizer,
  type NativeMeetingRecordingFinalizeRequest,
} from '../hooks/useNativeMeetingRecordingFinalizer';
import { createMeetingMarker } from '../services/meetingMarkers';
import {
  type FinalizeNativeMeetingRecordingResult,
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
import { Colors as C } from '../theme/colors';
import {
  findOwnedRecoveredMeetingRecording,
  nativeMeetingSnapshotFromRecovery,
} from '../services/nativeMeetingRecordingRecovery';

type Props = {
  navigation: NativeStackNavigationProp<RootStackParamList, 'MeetingLive'>;
  route: RouteProp<RootStackParamList, 'MeetingLive'>;
};

interface ActiveNativeRecording {
  meetingId: string;
  sessionId: string;
  finalize: () => Promise<FinalizeNativeMeetingRecordingResult>;
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

function localUriFromStopError(
  error: unknown,
  storageScope: string,
): NativeRecorderStopResult | null {
  const result = (error as { result?: NativeRecorderStopResult } | null)?.result;
  return result?.localSaved
    && result.localUri
    && result.snapshot.storageScope === storageScope
    ? result
    : null;
}

/** MIN-REC-STATE-001: Android owns capture; this route only coordinates domain operations. */
export function MeetingLiveScreen({ navigation, route }: Props) {
  const projectionCandidateEnabled = getFeatureFlags().nativeProjectionEnvelopeCandidate;
  const currentProjectionRef = useRef<NativeProjectionEnvelope | null>(null);
  const { accessToken, isGuest } = useAuth();
  const {
    meetings,
    loading: meetingsLoading,
    createMeeting,
    updateMeetingStatus,
    updateMeetingTitle,
    updateMeetingDetails,
    getCachedTranscript,
    saveCachedTranscript,
  } = useMeetings();
  const {
    finalizeRecording,
    recordingStorageScope,
    meetingScopeKey,
  } = useNativeMeetingRecordingFinalizer();
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
    new RecordingSessionController<FinalizeNativeMeetingRecordingResult, ActiveNativeRecording>(),
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
  const durableTranscriptQueueRef = useRef<Promise<void>>(Promise.resolve());
  const createRequestRef = useRef(createClientRequestState('meeting'));
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
    if (
      snapshot.sessionId !== currentSessionIdRef.current
      || snapshot.storageScope !== recordingStorageScope
    ) return;
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
      setError(readableRecorderErrorMessage(
        snapshot.errorCode,
        snapshot.errorMessage,
        '录音暂时不可用，请稍后重试。',
        Boolean(snapshot.localUri && snapshot.transcriptRecoveryRequired),
      ));
    }
  }, [recordingStorageScope]);

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

  const persistDurableTranscriptEvent = useCallback((
    sessionId: string,
    id: string,
    eventSequence: number,
    next: NativeMinutesTranscriptLine[],
  ) => {
    const finalLines = finalizedNativeMinutesTranscript(next);
    const operation = durableTranscriptQueueRef.current
      .catch(() => undefined)
      .then(async () => {
        await saveCachedTranscript(id, finalLines);
        const acknowledged = await acknowledgeNativeDeviceV2Transcript(
          sessionId,
          eventSequence,
        );
        if (!acknowledged) throw new Error('device-v2 transcript acknowledgement was rejected');
        checkpointRef.current = {
          lineCount: finalLines.length,
          savedAtMs: Date.now(),
        };
      });
    durableTranscriptQueueRef.current = operation;
    void operation.catch(reason => {
      diagnosticWarn('persist durable realtime transcript event failed', reason);
      if (mountedRef.current) {
        setError('文字记录正在显示，但本机持久化尚未完成；连接恢复后会继续处理');
      }
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
        const eventSequence = Number(event.eventSequence);
        if (event.isFinal && Number.isSafeInteger(eventSequence) && eventSequence > 0) {
          persistDurableTranscriptEvent(event.sessionId, id, eventSequence, next);
        } else if (event.isFinal) {
          checkpointTranscript(next);
        }
      }),
      addNativeRecorderErrorListener(event => {
        if (event.sessionId && event.sessionId !== currentSessionIdRef.current) return;
        // Local audio remains valid while the realtime channel reconnects.
        // Do not present a recoverable ASR event as a microphone failure.
        if (event.recoverable) return;
        if (mountedRef.current) {
          recorderErrorVisibleRef.current = true;
          setError(readableRecorderErrorMessage(
            event.errorCode,
            event.errorMessage,
            '录音暂时不可用，请稍后重试',
            event.recoverable,
          ));
        }
      }),
    ];
    return () => subscriptions.forEach(subscription => subscription.remove());
  }, [applyRecorderSnapshot, checkpointTranscript, persistDurableTranscriptEvent]);

  const buildFinalizeRequest = useCallback((
    id: string,
    remoteMeetingId: string | null,
    stopAudio: () => Promise<string | undefined>,
  ): NativeMeetingRecordingFinalizeRequest => ({
    meetingId: id,
    remoteMeetingId,
    getTranscriptLines: () => finalizedNativeMinutesTranscript(transcriptRef.current),
    getAudioDurationSec: () => {
      const durationMs = recorderSnapshotRef.current?.durationMs;
      return durationMs ? durationMs / 1000 : undefined;
    },
    getAudioBars: () => nativeAudioBarsRef.current,
    stopAudio,
  }), []);

  const createActiveRecording = useCallback((
    id: string,
    remoteMeetingId: string | null,
  ): ActiveNativeRecording => {
    const stopAudio = async () => {
      let localUri: string | undefined;
      try {
        const result = await stopNativeRecorder(id);
        applyRecorderSnapshot(result.snapshot);
        nativeAudioBarsRef.current = result.audioBars;
        localUri = result.localUri ?? undefined;
      } catch (stopError) {
        const stoppedWithLocalFile = localUriFromStopError(stopError, recordingStorageScope);
        if (stoppedWithLocalFile) {
          applyRecorderSnapshot(stoppedWithLocalFile.snapshot);
          nativeAudioBarsRef.current = stoppedWithLocalFile.audioBars;
          if (mountedRef.current) {
            setError('录音已保存在本机，但实时转写结束确认超时；可在详情中继续同步');
          }
          localUri = stoppedWithLocalFile.localUri ?? undefined;
        } else {
          const recovery = await recoverNativeRecordings().catch(() => null);
          const recovered = findOwnedRecoveredMeetingRecording(
            recovery?.recordings ?? [],
            id,
            recordingStorageScope,
          );
          if (!recovered) throw stopError;
          applyRecorderSnapshot(nativeMeetingSnapshotFromRecovery(recovered));
          nativeAudioBarsRef.current = [];
          if (mountedRef.current) {
            setError('录音已从本机恢复，文字记录将在后台继续补全');
          }
          localUri = recovered.localUri;
        }
      }
      return localUri;
    };
    return {
      meetingId: id,
      sessionId: id,
      finalize: createMeetingRecordingFinalizer(() => finalizeRecording(
        buildFinalizeRequest(id, remoteMeetingId, stopAudio),
      )),
    };
  }, [applyRecorderSnapshot, buildFinalizeRequest, finalizeRecording, recordingStorageScope]);

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
        transcriptRef.current = completed.result.transcriptLines;
        if (mountedRef.current) setTranscript(completed.result.transcriptLines);
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
        if (completed.result.uploadFailed) {
          warnings.push(completed.result.retryQueued ? '录音将在联网后继续同步' : '录音上传状态未保存');
        }
        if (completed.result.statusSyncPending && !completed.result.statusSyncInBackground) {
          warnings.push('会议状态稍后继续同步');
        }
        const warning = warnings.length > 0 ? `会议录音已保存；${warnings.join('；')}` : '';
        const pending = completed.result.transcriptCompletion === 'pending'
          ? '会议录音已保存；文字记录仍在补全'
          : '';
        setError(completed.navigateAfter ? '' : warning || pending);
        if (warning) ToastAndroid.show(warning, ToastAndroid.LONG);
        if (completed.navigateAfter) {
          navigation.replace('Transcription', { meetingId: completed.session.meetingId });
        }
        void completed.result.transcriptCompletionTask.then(completion => {
          transcriptRef.current = completion.lines;
          if (!mountedRef.current) return;
          setTranscript(completion.lines);
          if (completed.navigateAfter) return;
          const settledWarnings = [...warnings];
          if (completion.status === 'failed') {
            settledWarnings.unshift(completed.result.transcriptSaveFailed
              ? '文字记录保存失败，可稍后重试'
              : '文字记录补全失败，可稍后重试');
          }
          const settledWarning = settledWarnings.length > 0
            ? `会议录音已保存；${settledWarnings.join('；')}`
            : '';
          setError(completion.status === 'pending'
            ? settledWarning || '会议录音已保存；文字记录仍在补全'
            : settledWarning);
        }).catch(reason => {
          diagnosticWarn('observe transcript completion after finalize failed', reason);
        });
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
    if (
      current
      && current.storageScope === recordingStorageScope
      && ['preparing', 'recording', 'paused', 'failed'].includes(current.state)
    ) {
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
    const recovered = findOwnedRecoveredMeetingRecording(
      recovery?.recordings ?? [],
      existing.id,
      recordingStorageScope,
    );
    if (!recovered) return false;
    setMeetingId(existing.id);
    setTitle(existing.title ?? '');
    setElapsedMs(recovered.durationMs);
    setPhase('saving');
    recorderSnapshotRef.current = nativeMeetingSnapshotFromRecovery(recovered);
    const remoteMeetingId = isGuest ? null : meetingRemoteIdentity(existing);
    await cancelMeetingPlannedEndReminder(existing.id);
    const finalized = await finalizeRecording(buildFinalizeRequest(
      existing.id,
      remoteMeetingId,
      async () => recovered.localUri,
    ));
    transcriptRef.current = finalized.transcriptLines;
    if (mountedRef.current) setTranscript(finalized.transcriptLines);
    await manualNote.flush();
    if (mountedRef.current) navigation.replace('Transcription', { meetingId: existing.id });
    return true;
  }, [applyRecorderSnapshot, buildFinalizeRequest, createActiveRecording, existing, finalizeRecording, getCachedTranscript, isGuest, manualNote.flush, meetingScopeKey, navigation, recordingStorageScope]);

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
      // Guest mode is now a local-data mode, not an anonymous server session.
      // Establish the device/epoch binding before opening the ASR socket so
      // the server can scope the realtime meeting to this installation.
      const readyMeeting = meeting;
      const remoteMeetingId = null;
      startedMeetingId = readyMeeting.id;
      navigation.setParams({ meetingId: readyMeeting.id, startRequested: false });
      setMeetingId(readyMeeting.id);
      activeMeetingIdRef.current = readyMeeting.id;
      currentSessionIdRef.current = readyMeeting.id;
      startedAtRef.current = new Date();
      const initialTranscript = reusable ? getCachedTranscript(readyMeeting.id) : [];
      transcriptRef.current = initialTranscript;
      setTranscript(initialTranscript);
      checkpointRef.current = {
        lineCount: finalizedNativeMinutesTranscript(initialTranscript).length,
        savedAtMs: Date.now(),
      };
      await updateMeetingStatus(readyMeeting.id, 'recording');
      const config = getApiConfig();
      const realtimeSecure = config.realtimeAsrBase.startsWith('wss://');
      const allowInsecureDevelopment = resolveNativeRecorderInsecureDevelopment(
        config.isProduction,
        realtimeSecure,
      );
      assertNativeRecorderDeploymentPolicy(config.isProduction, allowInsecureDevelopment);
      const realtimeV2Candidate = getFeatureFlags().realtimeAsrV2Candidate;
      const realtimeV2 = realtimeV2Candidate
        ? await loadDeviceV2Capabilities().catch(reason => {
          diagnosticWarn('vNext realtime capability unavailable; legacy fallback is disabled', reason);
          return null;
        })
        : null;
      if (realtimeV2Candidate && !realtimeV2?.realtimeAsrV2) {
        throw new Error('新版实时转写服务暂时不可用，录音尚未开始，请稍后重试');
      }
      const snapshot = realtimeV2Candidate
        ? await startDeviceV2RealtimeRecording({
          meetingId: readyMeeting.id,
          sessionId: readyMeeting.id,
          storageScope: recordingStorageScope,
          allowInsecureDevelopment,
        })
        : await (async () => {
          const deviceAuth = await getDeviceRealtimeAuth();
          await createMeetingBinding(readyMeeting.id);
          const websocketUrl = buildRealtimeAsrUrl({
            meetingId: readyMeeting.id,
            provider: config.realtimeAsrProvider,
            purpose: 'meeting',
            realtimeAsrBase: config.realtimeAsrBase,
          });
          return startNativeRecorder({
            sessionId: readyMeeting.id,
            purpose: 'meeting',
            storageScope: recordingStorageScope,
            websocketUrl,
            allowInsecureDevelopment,
            deviceToken: deviceAuth.deviceToken,
            dataEpoch: deviceAuth.dataEpoch,
          });
        })();
      nativeCaptureStarted = true;
      applyRecorderSnapshot(snapshot);
      const active = createActiveRecording(readyMeeting.id, remoteMeetingId);
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
      setActiveSessionId(readyMeeting.id);
      setPhase('recording');
      if (meetingScopeKey) {
        await reconcileMeetingPlannedEndReminder(readyMeeting.id, meetingScopeKey).catch(reason => {
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
  }, [applyRecorderSnapshot, createActiveRecording, createMeeting, entryPoint, existing, getCachedTranscript, meetingId, meetingScopeKey, meetings, navigation, showDialog, updateMeetingStatus]);

  const stopRecording = useCallback(async (navigateAfter = true) => {
    if (!recordingControllerRef.current.current()) return false;
    const noteFlush = manualNote.flush();
    void noteFlush.catch(reason => {
      diagnosticWarn('flush manual note while stopping recording failed', reason);
    });
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
    const projectionFence = fenceNativeProjectionAction(
      projectionCandidateEnabled,
      currentProjectionRef.current,
      action.projection,
    );
    if (!projectionFence.accepted) {
      diagnosticAudit('native_projection_action_rejected', {
        surface: 'recording',
        action_type: action.type,
        reason: projectionFence.reason,
      });
      return;
    }
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
  }, [confirmStop, createMarkerAt, manualNote, navigation, openManualNoteConflict, phase, projectionCandidateEnabled, requestMeetingLocation, retryTranscriptCache, startRecording, stopRecording, togglePause, updateMeetingTitle]);

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
  const snapshotBody = useMemo(() => buildNativeMinutesRecordingSnapshot({
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
  const snapshot = useNativeProjection(snapshotBody, {
    enabled: projectionCandidateEnabled,
    entityId: meetingId || requestedMeetingId || 'recording',
    surfaceKey: 'recording',
  });
  currentProjectionRef.current = snapshot.projection ?? null;

  return (
    <ScreenContainer edges={['top', 'bottom']} bg={C.body}>
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
