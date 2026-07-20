import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  AppState,
  NativeScrollEvent,
  NativeSyntheticEvent,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { RouteProp } from '@react-navigation/native';
import { Ionicons } from '@expo/vector-icons';
import { requestRecordingPermissionsAsync, setAudioModeAsync } from 'expo-audio';
import { Colors as C } from '../theme/colors';
import { ScreenContainer } from '../components/ScreenContainer';
import { Waveform } from '../components/Common';
import { MinutesDetailTitleBar } from '../components/MinutesDetailTitleBar';
import { useAppDialog } from '../components/AppDialog';
import { useAuth } from '../store/AuthStore';
import { useMeetings } from '../store/MeetingsStore';
import {
  ApiGuestRealtimeSession,
  createGuestRealtimeSession,
  deleteGuestRealtimeSession,
  uploadMeetingAudio,
} from '../services/api';
import { createMeetingRecordingFinalizer, finalizeMeetingRecording } from '../services/meetingRecording';
import { RealtimeAsrAudioStats, RealtimeAsrSession, RealtimeAsrStatus, startRealtimeAsr } from '../services/realtimeAsr';
import { RootStackParamList, TranscriptLine } from '../types';
import {
  audioSamplesToBars,
  canResumeMeetingRecording,
  latestTranscriptWindow,
  pcmDurationSec,
  shouldCheckpointTranscript,
} from '../utils/meetingMedia';
import { createClientRequestState, requestStateForPayload } from '../services/clientRequestId';
import { enqueueNativeMeetingUpload } from '../native/nativeTransferCoordinator';
import { readableErrorMessage } from '../services/errors';

type Props = {
  navigation: NativeStackNavigationProp<RootStackParamList, 'MeetingLive'>;
  route: RouteProp<RootStackParamList, 'MeetingLive'>;
};

function defaultTitle() {
  const now = new Date();
  return `会议 ${now.getMonth() + 1}月${now.getDate()}日 ${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
}

function formatClock(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const min = Math.floor(total / 60);
  const sec = total % 60;
  return `${String(min).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
}

function formatMeetingStart(value: Date): string {
  return `${value.getFullYear()}年${value.getMonth() + 1}月${value.getDate()}日 ${String(value.getHours()).padStart(2, '0')}:${String(value.getMinutes()).padStart(2, '0')}`;
}

function formatTranscriptTime(seconds?: number): string {
  const safeSeconds = Number.isFinite(seconds) ? Math.max(0, seconds ?? 0) : 0;
  const minutes = Math.floor(safeSeconds / 60);
  const remainder = Math.floor(safeSeconds % 60);
  return `${String(minutes).padStart(2, '0')}:${String(remainder).padStart(2, '0')}`;
}

const IDLE_WAVE_BARS = Array.from({ length: 48 }, (_, index) => (
  0.08 + ((Math.sin(index * 0.92) + 1) * 0.04)
));

export const MEETING_RECORDING_GEOMETRY = Object.freeze({
  topBarHeight: 44,
  titleMinHeight: 100,
  singleTabDividerHeight: 0.5,
  toolbarHeight: 104,
  waveformHeight: 32,
  controlRowHeight: 56,
  durationHeight: 50,
  resumePauseWidth: 88,
  stopWidth: 72,
  stopHeight: 40,
  transcriptAvatarSize: 18,
  transcriptPaddingStart: 18,
  transcriptPaddingEnd: 20,
});

interface ActiveRecording {
  meetingId: string;
  session: RealtimeAsrSession;
  guestSession?: ApiGuestRealtimeSession;
  finalize: ReturnType<typeof createMeetingRecordingFinalizer>;
}

class MeetingStartCancelledError extends Error {
  constructor() {
    super('meeting start cancelled');
    this.name = 'MeetingStartCancelledError';
  }
}

export function MeetingLiveScreen({ navigation, route }: Props) {
  const { accessToken, isGuest, session } = useAuth();
  const {
    meetings,
    createMeeting,
    deleteMeeting,
    updateMeetingTitle,
    updateMeetingStatus,
    getCachedTranscript,
    saveCachedTranscript,
    refreshMeetings,
  } = useMeetings();
  const { showDialog } = useAppDialog();
  const existing = route.params?.meetingId ? meetings.find(item => item.id === route.params?.meetingId) : undefined;
  const [title, setTitle] = useState(existing?.title ?? defaultTitle());
  const [titleDraft, setTitleDraft] = useState(existing?.title ?? title);
  const [titleEditing, setTitleEditing] = useState(false);
  const [meetingId, setMeetingId] = useState(existing?.id ?? '');
  const [status, setStatus] = useState<RealtimeAsrStatus | 'idle' | 'saving' | 'summarizing' | 'failed'>('idle');
  const [transcript, setTranscript] = useState<TranscriptLine[]>(() => existing ? getCachedTranscript(existing.id) : []);
  const [error, setError] = useState('');
  const [elapsedMs, setElapsedMs] = useState(0);
  const [audioStats, setAudioStats] = useState<RealtimeAsrAudioStats | null>(null);
  const [titleSaving, setTitleSaving] = useState(false);
  const [followingTranscript, setFollowingTranscript] = useState(true);
  const [pauseTransitioning, setPauseTransitioning] = useState(false);
  const activeRecordingRef = useRef<ActiveRecording | null>(null);
  const finalizationUiPromiseRef = useRef<Promise<boolean> | null>(null);
  const navigateAfterFinalizeRef = useRef(false);
  const mountedRef = useRef(true);
  const startedAtRef = useRef<number | null>(null);
  const pausedAtRef = useRef<number | null>(null);
  const accumulatedPausedMsRef = useRef(0);
  const audioStatsRef = useRef<RealtimeAsrAudioStats | null>(null);
  const audioRmsSamplesRef = useRef<number[]>([]);
  const activeMeetingIdRef = useRef('');
  const transcriptRef = useRef<TranscriptLine[]>(transcript);
  const titleRef = useRef(title);
  const transcriptCheckpointRef = useRef({ lineCount: transcript.length, savedAtMs: Date.now() });
  const leavePromptOpenRef = useRef(false);
  const backgroundStopRef = useRef(false);
  const startInFlightRef = useRef(false);
  const autoStartAttemptedRef = useRef(false);
  const transcriptScrollRef = useRef<ScrollView | null>(null);
  const meetingStartedAtRef = useRef(new Date());
  const createRequestRef = useRef(createClientRequestState('meeting'));
  const recordingStorageScope = isGuest ? 'guest' : session ? `user:${session.user.id}` : 'signed_out';

  const recordingElapsedAt = useCallback((now = Date.now()) => {
    if (!startedAtRef.current) return 0;
    const currentPauseMs = pausedAtRef.current ? now - pausedAtRef.current : 0;
    return Math.max(0, now - startedAtRef.current - accumulatedPausedMsRef.current - currentPauseMs);
  }, []);
  const ticking = status === 'connecting' || status === 'recording' || status === 'connected' || status === 'stopping';
  const isPaused = status === 'paused';
  const canStop = Boolean(activeRecordingRef.current) && (
    status === 'recording' || status === 'connected' || status === 'paused' || status === 'failed'
  );
  const canTogglePause = !pauseTransitioning && Boolean(activeRecordingRef.current) && (
    status === 'recording' || status === 'connected' || status === 'paused'
  );
  const requestedMeetingMissing = Boolean(route.params?.meetingId && !existing);
  const canStart = !requestedMeetingMissing && (!existing || canResumeMeetingRecording(existing)) && !activeRecordingRef.current && (
    status === 'idle' || status === 'closed' || status === 'failed'
  );
  const canEditTitle = status !== 'stopping' && status !== 'saving' && !titleSaving;
  const visibleTranscript = useMemo(() => latestTranscriptWindow(transcript, 40), [transcript]);
  const liveWaveBars = useMemo(() => {
    const bars = audioSamplesToBars(audioRmsSamplesRef.current.slice(-160), 48);
    return bars.length > 0 ? bars : IDLE_WAVE_BARS;
  }, [audioStats?.frameCount]);
  const meetingStartText = existing
    ? [existing.date, existing.time].filter(Boolean).join(' ')
    : formatMeetingStart(meetingStartedAtRef.current);
  const statusText = useMemo(() => {
    if (status === 'idle') return '准备开始';
    if (status === 'connecting') return '正在连接实时转写';
    if (status === 'recording' || status === 'connected') return '实时转写中';
    if (status === 'paused') return '录音已暂停';
    if (status === 'stopping') return '正在停止';
    if (status === 'saving') return '正在保存会议';
    if (status === 'summarizing') return '正在生成总结';
    if (status === 'closed') return '已结束';
    return '需要重试';
  }, [status]);

  const restorePlaybackAudioMode = useCallback(async () => {
    await setAudioModeAsync({ allowsRecording: false, playsInSilentMode: true }).catch(() => {});
  }, []);

  useEffect(() => {
    if (!ticking) return;
    const timer = setInterval(() => {
      if (startedAtRef.current) setElapsedMs(recordingElapsedAt());
    }, 500);
    return () => clearInterval(timer);
  }, [recordingElapsedAt, ticking]);

  useEffect(() => {
    if (!existing?.id) return;
    const cachedTranscript = getCachedTranscript(existing.id);
    setTranscript(cachedTranscript);
    transcriptCheckpointRef.current = {
      lineCount: cachedTranscript.length,
      savedAtMs: Date.now(),
    };
    activeMeetingIdRef.current = existing.id;
  }, [existing?.id, getCachedTranscript]);

  useEffect(() => {
    transcriptRef.current = transcript;
  }, [transcript]);

  useEffect(() => {
    titleRef.current = title;
  }, [title]);

  useEffect(() => {
    if (!existing?.title) return;
    titleRef.current = existing.title;
    setTitle(existing.title);
    if (!titleEditing) setTitleDraft(existing.title);
  }, [existing?.id, existing?.title]);

  const persistStoppedSession = useCallback(async (
    session: RealtimeAsrSession,
    id: string,
    guestSession?: ApiGuestRealtimeSession,
  ) => {
    const audioDurationSec = pcmDurationSec(audioStatsRef.current?.byteCount ?? 0);
    const audioBars = audioSamplesToBars(audioRmsSamplesRef.current, 50);
    try {
      return await finalizeMeetingRecording({
        meetingId: id,
        storageScope: recordingStorageScope,
        transcriptLines: transcriptRef.current,
        isGuest,
        accessToken,
        audioDurationSec,
        audioBars,
        stopAudio: session.stop,
        getTranscriptLines: () => transcriptRef.current,
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
      try {
        if (guestSession) {
          await deleteGuestRealtimeSession(guestSession.meeting_id, guestSession.guest_token).catch(() => {});
        }
      } finally {
        await restorePlaybackAudioMode();
      }
    }
  }, [accessToken, isGuest, recordingStorageScope, refreshMeetings, restorePlaybackAudioMode, saveCachedTranscript, updateMeetingStatus]);

  const finalizeActiveRecording = useCallback((
    active: ActiveRecording,
    navigateAfter: boolean,
  ): Promise<boolean> => {
    if (navigateAfter) navigateAfterFinalizeRef.current = true;
    if (finalizationUiPromiseRef.current) return finalizationUiPromiseRef.current;
    if (mountedRef.current) setStatus('saving');

    const operation = active.finalize()
      .then(result => {
        if (activeRecordingRef.current === active) activeRecordingRef.current = null;
        if (!mountedRef.current) return true;
        const syncWarnings: string[] = [];
        if (result.uploadFailed) {
          syncWarnings.push(result.retryQueued
            ? '录音文件待上传，可在转写页重试'
            : '待上传记录写入失败，请勿清理本机数据');
        }
        if (result.statusSyncPending) syncWarnings.push('会议状态将在网络恢复后自动同步');
        if (syncWarnings.length > 0) setError(`会议已保存到本机；${syncWarnings.join('；')}`);
        setStatus('closed');
        const shouldNavigate = navigateAfterFinalizeRef.current;
        navigateAfterFinalizeRef.current = false;
        if (shouldNavigate) navigation.replace('Transcription', { meetingId: active.meetingId });
        return true;
      })
      .catch(err => {
        if (!mountedRef.current) return false;
        setStatus('failed');
        const message = err instanceof Error ? err.message : '停止会议失败';
        setError(message);
        showDialog({ title: '保存失败', message, tone: 'error' });
        return false;
      })
      .finally(() => {
        if (finalizationUiPromiseRef.current === operation) {
          finalizationUiPromiseRef.current = null;
        }
      });
    finalizationUiPromiseRef.current = operation;
    return operation;
  }, [navigation, showDialog]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      const active = activeRecordingRef.current;
      if (active) void active.finalize().catch(() => {});
    };
  }, []);

  const appendTranscript = (line: Omit<TranscriptLine, 'id'>) => {
    const current = transcriptRef.current;
    const id = `${activeMeetingIdRef.current || meetingId}-${line.start_time ?? current.length}-${line.text}`;
    if (current.some(item => item.id === id || (item.text === line.text && item.start_time === line.start_time))) return;
    const next = [...current, { id, ...line }];
    transcriptRef.current = next;
    setTranscript(next);
    if (activeMeetingIdRef.current) {
      const previousCheckpoint = transcriptCheckpointRef.current;
      const now = Date.now();
      if (!shouldCheckpointTranscript(
        next.length,
        previousCheckpoint.lineCount,
        now - previousCheckpoint.savedAtMs,
      )) return;
      transcriptCheckpointRef.current = { lineCount: next.length, savedAtMs: now };
      void saveCachedTranscript(activeMeetingIdRef.current, next).catch(() => {
        if (transcriptCheckpointRef.current.lineCount === next.length) {
          transcriptCheckpointRef.current = previousCheckpoint;
        }
        if (mountedRef.current) setError('转写正在显示，但暂时无法保存到本机；结束会议时会再次尝试');
      });
    }
  };

  const startRecording = async () => {
    if (
      !canStart
      || startInFlightRef.current
      || activeRecordingRef.current
      || finalizationUiPromiseRef.current
    ) return;
    startInFlightRef.current = true;
    setStatus('connecting');
    setError('');
    setAudioStats(null);
    audioStatsRef.current = null;
    audioRmsSamplesRef.current = [];
    pausedAtRef.current = null;
    accumulatedPausedMsRef.current = 0;
    setPauseTransitioning(false);
    let startedMeetingId = '';
    let guestSession: ApiGuestRealtimeSession | undefined;
    let createdForAttempt = false;
    let reusableStatus = 'created';
    const ensureScreenActive = () => {
      if (!mountedRef.current) throw new MeetingStartCancelledError();
    };
    try {
      const permission = await requestRecordingPermissionsAsync();
      ensureScreenActive();
      if (!permission.granted) {
        setStatus('idle');
        showDialog({ title: '无法录音', message: '请允许麦克风权限后再开始会议。', tone: 'warning' });
        return;
      }
      await setAudioModeAsync({ allowsRecording: true, playsInSilentMode: true });
      ensureScreenActive();
      const reusableMeeting = existing ?? (meetingId ? meetings.find(item => item.id === meetingId) : undefined);
      reusableStatus = reusableMeeting?.status ?? 'created';
      createdForAttempt = !reusableMeeting;
      const meetingPayload = { title: titleRef.current.trim() || defaultTitle(), mode: 'realtime' as const };
      createRequestRef.current = requestStateForPayload(createRequestRef.current, 'meeting', meetingPayload);
      const meeting = reusableMeeting ?? await createMeeting(meetingPayload.title, {
        mode: meetingPayload.mode,
        clientRequestId: createRequestRef.current.id,
      });
      startedMeetingId = meeting.id;
      ensureScreenActive();
      setMeetingId(meeting.id);
      activeMeetingIdRef.current = meeting.id;
      const latestTitle = titleRef.current.trim();
      if (latestTitle && latestTitle !== meeting.title) {
        await updateMeetingTitle(meeting.id, latestTitle);
        ensureScreenActive();
      }
      await updateMeetingStatus(meeting.id, 'recording');
      ensureScreenActive();
      const initialTranscript = reusableMeeting ? getCachedTranscript(meeting.id) : [];
      transcriptRef.current = initialTranscript;
      transcriptCheckpointRef.current = { lineCount: initialTranscript.length, savedAtMs: Date.now() };
      setTranscript(initialTranscript);
      if (isGuest) {
        guestSession = await createGuestRealtimeSession(latestTitle || meeting.title);
        ensureScreenActive();
      }
      const session = await startRealtimeAsr({
        meetingId: guestSession?.meeting_id ?? meeting.id,
        accessToken: isGuest ? null : accessToken,
        guestToken: guestSession?.guest_token,
        onStatus: next => {
          if (mountedRef.current) setStatus(next);
        },
        onAudioStats: stats => {
          audioStatsRef.current = stats;
          audioRmsSamplesRef.current.push(stats.raw.rms);
          if (mountedRef.current) setAudioStats(stats);
        },
        onTranscript: item => {
          appendTranscript({
            meeting_id: meeting.id,
            speaker_id: item.speakerName ?? 'unknown',
            speaker_label: item.speakerName ?? '发言人',
            text: item.text,
            start_time: item.startTime,
            end_time: item.endTime,
            confidence: typeof item.raw.speaker_confidence === 'number' ? item.raw.speaker_confidence : undefined,
            created_at: new Date().toISOString(),
          });
        },
        onError: err => {
          if (mountedRef.current) setError(readableErrorMessage(err, '实时转写暂时不可用'));
        },
      });
      const active: ActiveRecording = {
        meetingId: meeting.id,
        session,
        guestSession,
        finalize: createMeetingRecordingFinalizer(() => persistStoppedSession(session, meeting.id, guestSession)),
      };
      if (!mountedRef.current) {
        await active.finalize().catch(() => {});
        if (createdForAttempt) await deleteMeeting(meeting.id).catch(() => {});
        return;
      }
      activeRecordingRef.current = active;
      setStatus('recording');
      void session.completion.then(completion => {
        if (activeRecordingRef.current !== active || !mountedRef.current) return;
        if (completion.reason !== 'connection-closed') return;
        setError('实时连接意外断开，正在保存本次录音和转写');
        void finalizeActiveRecording(active, !finalizationUiPromiseRef.current);
      });
      startedAtRef.current = Date.now();
      pausedAtRef.current = null;
      accumulatedPausedMsRef.current = 0;
      setElapsedMs(0);
    } catch (err) {
      await restorePlaybackAudioMode();
      const cancelled = err instanceof MeetingStartCancelledError || !mountedRef.current;
      if (guestSession) {
        await deleteGuestRealtimeSession(guestSession.meeting_id, guestSession.guest_token).catch(() => {});
      }
      if (startedMeetingId) {
        if (cancelled && createdForAttempt) {
          await deleteMeeting(startedMeetingId).catch(async () => {
            await updateMeetingStatus(startedMeetingId, 'failed').catch(() => {});
          });
        } else {
          await updateMeetingStatus(startedMeetingId, cancelled ? reusableStatus : 'failed').catch(() => {});
        }
      }
      if (mountedRef.current) {
        setStatus('failed');
        const message = readableErrorMessage(err, '启动会议录音失败，请稍后重试');
        setError(message);
        showDialog({ title: '启动失败', message, tone: 'error' });
      }
    } finally {
      startInFlightRef.current = false;
    }
  };

  const stopRecording = useCallback((navigateAfter = true): Promise<boolean> => {
    const active = activeRecordingRef.current;
    if (!active) return Promise.resolve(false);
    setPauseTransitioning(false);
    setStatus('stopping');
    return finalizeActiveRecording(active, navigateAfter);
  }, [finalizeActiveRecording]);

  const togglePauseRecording = async () => {
    const active = activeRecordingRef.current;
    if (!active || !canTogglePause) return;
    setPauseTransitioning(true);
    setError('');
    try {
      if (isPaused) {
        const pausedAt = pausedAtRef.current;
        await active.session.resume();
        const resumedAt = Date.now();
        if (pausedAt) accumulatedPausedMsRef.current += Math.max(0, resumedAt - pausedAt);
        pausedAtRef.current = null;
        setStatus('recording');
      } else {
        await active.session.pause();
        const pausedAt = Date.now();
        pausedAtRef.current = pausedAt;
        setElapsedMs(recordingElapsedAt(pausedAt));
        setStatus('paused');
      }
    } catch (reason) {
      const fallback = isPaused ? '继续录音失败，请重试。' : '暂停录音失败，请重试。';
      setError(readableErrorMessage(reason, fallback));
    } finally {
      if (mountedRef.current) setPauseTransitioning(false);
    }
  };

  const beginTitleEditing = () => {
    if (!canEditTitle) return;
    setTitleDraft(titleRef.current);
    setTitleEditing(true);
  };

  const commitTitle = async () => {
    const previousTitle = titleRef.current;
    const nextTitle = titleDraft.trim();
    setTitleEditing(false);
    if (!nextTitle || nextTitle === previousTitle) {
      setTitleDraft(previousTitle);
      return;
    }
    titleRef.current = nextTitle;
    setTitle(nextTitle);
    setTitleDraft(nextTitle);
    const id = activeMeetingIdRef.current || meetingId || existing?.id;
    if (!id || titleSaving) return;
    setTitleSaving(true);
    try {
      await updateMeetingTitle(id, nextTitle);
    } catch {
      showDialog({ title: '保存失败', message: '会议标题更新失败，请稍后重试。', tone: 'error' });
    } finally {
      if (mountedRef.current) setTitleSaving(false);
    }
  };

  const handleTranscriptScroll = (event: NativeSyntheticEvent<NativeScrollEvent>) => {
    const { contentOffset, contentSize, layoutMeasurement } = event.nativeEvent;
    const distanceFromBottom = contentSize.height - layoutMeasurement.height - contentOffset.y;
    setFollowingTranscript(distanceFromBottom <= 72);
  };

  const scrollToLatestTranscript = () => {
    setFollowingTranscript(true);
    transcriptScrollRef.current?.scrollToEnd({ animated: true });
  };

  const confirmStopRecording = () => {
    if (!canStop) return;
    showDialog({
      title: '结束录音？',
      message: '结束后将保存本次录音和文字记录。',
      tone: 'warning',
      actions: [
        {
          text: '结束录音',
          role: 'primary',
          onPress: async () => { await stopRecording(true); },
        },
        { text: '继续录音', role: 'cancel' },
      ],
    });
  };

  useEffect(() => {
    if (!canStart || autoStartAttemptedRef.current) return;
    autoStartAttemptedRef.current = true;
    void startRecording();
  }, [canStart]);

  useEffect(() => {
    const subscription = AppState.addEventListener('change', nextState => {
      if (nextState === 'active' || !activeRecordingRef.current || backgroundStopRef.current) return;
      backgroundStopRef.current = true;
      if (mountedRef.current) setError('应用进入后台，正在结束并保存本次会议');
      void stopRecording(true).finally(() => {
        backgroundStopRef.current = false;
      });
    });
    return () => subscription.remove();
  }, [stopRecording]);

  useEffect(() => navigation.addListener('beforeRemove', event => {
    if (!activeRecordingRef.current || leavePromptOpenRef.current) return;
    event.preventDefault();
    leavePromptOpenRef.current = true;
    showDialog({
      title: '会议仍在录制',
      message: '离开前需要结束并保存本次录音和转写。',
      tone: 'warning',
      onDismiss: () => { leavePromptOpenRef.current = false; },
      actions: [
        {
          text: '结束并离开',
          role: 'primary',
          onPress: async () => {
            const saved = await stopRecording(false);
            leavePromptOpenRef.current = false;
            if (saved) navigation.dispatch(event.data.action);
          },
        },
        {
          text: '继续录音',
          role: 'cancel',
          onPress: () => { leavePromptOpenRef.current = false; },
        },
      ],
    });
  }), [navigation, showDialog, stopRecording]);

  return (
    <ScreenContainer edges={['top', 'bottom']} bg={C.body}>
      <MinutesDetailTitleBar onBack={() => navigation.goBack()} backgroundColor={C.body} />

      <View style={s.meetingHeader}>
        <View style={s.titleContainer}>
          {titleEditing ? (
            <TextInput
              style={s.titleInput}
              testID="meeting-live-title-editor"
              value={titleDraft}
              onChangeText={setTitleDraft}
              onBlur={() => { void commitTitle(); }}
              editable={canEditTitle}
              autoFocus
              selectTextOnFocus
              multiline
              scrollEnabled={false}
              submitBehavior="blurAndSubmit"
              returnKeyType="done"
              maxLength={80}
              placeholder="输入会议标题"
              placeholderTextColor={C.faint}
              accessibilityLabel="会议标题"
            />
          ) : (
            <TouchableOpacity
              style={s.titleCover}
              onPress={beginTitleEditing}
              activeOpacity={0.72}
              disabled={!canEditTitle}
              accessibilityRole="button"
              accessibilityLabel="编辑会议标题"
            >
              <Text style={s.titleText} testID="meeting-live-title">{title}</Text>
            </TouchableOpacity>
          )}
        </View>
        <View style={s.metaRow}>
          <Ionicons name="time-outline" size={12} color={C.sub} />
          <Text style={s.metaText}>{meetingStartText}</Text>
        </View>
        <View style={s.singleTabDivider} testID="meeting-live-single-tab-divider" />
      </View>

      {error ? (
        <View style={s.errorBox} accessibilityRole="alert">
          <Ionicons name="alert-circle-outline" size={16} color={C.red} />
          <Text style={s.errorText}>{error}</Text>
        </View>
      ) : null}

      <View style={s.transcriptArea}>
        <ScrollView
          ref={transcriptScrollRef}
          style={s.transcriptScroll}
          contentContainerStyle={s.transcriptContent}
          showsVerticalScrollIndicator={false}
          onScroll={handleTranscriptScroll}
          scrollEventThrottle={16}
          onContentSizeChange={() => {
            if (followingTranscript) transcriptScrollRef.current?.scrollToEnd({ animated: true });
          }}
        >
          {transcript.length === 0 ? (
            <View style={s.emptyTranscript}>
              <Text style={s.emptyText} testID="meeting-live-status">
                {requestedMeetingMissing
                  ? '会议记录不存在'
                  : status === 'recording' || status === 'connected'
                    ? '正在聆听'
                    : statusText}
              </Text>
            </View>
          ) : (
            <>
              {visibleTranscript.hiddenCount > 0 ? (
                <Text style={s.archivedText}>较早的 {visibleTranscript.hiddenCount} 句已收纳</Text>
              ) : null}
              {visibleTranscript.items.map((line, index) => (
                <View
                  key={line.id}
                  style={[s.lineItem, index === 0 && s.firstLineItem]}
                  testID="meeting-live-transcript-item"
                >
                  <View style={s.lineMeta}>
                    <View style={s.speakerAvatar} testID="meeting-live-speaker-avatar">
                      <Ionicons name="person" size={10} color={C.faint} />
                    </View>
                    <Text style={s.speaker} numberOfLines={1}>{line.speaker_label ?? '发言人'}</Text>
                    <View style={s.lineDot} />
                    <Text style={s.lineTime}>{formatTranscriptTime(line.start_time)}</Text>
                  </View>
                  <Text style={s.lineText} testID="meeting-live-transcript-line">{line.text}</Text>
                </View>
              ))}
            </>
          )}
        </ScrollView>
        {!followingTranscript && transcript.length > 0 ? (
          <TouchableOpacity
            style={s.backToBottom}
            onPress={scrollToLatestTranscript}
            accessibilityRole="button"
            accessibilityLabel="回到最新转写"
          >
            <Ionicons name="arrow-down" size={18} color={C.sub} />
          </TouchableOpacity>
        ) : null}
      </View>

      <View style={s.recordingToolbar} testID="meeting-live-recording-toolbar">
        <View style={s.waveformWrap} testID="meeting-live-waveform-slot">
          <Waveform
            bars={liveWaveBars}
            color={status === 'recording' || status === 'connected' ? C.primary : C.faint}
            height={MEETING_RECORDING_GEOMETRY.waveformHeight}
          />
        </View>
        <View style={s.recordingControlRow} testID="meeting-live-control-row">
          <Text
            style={s.timer}
            accessibilityLabel={`${statusText}，已录制 ${formatClock(elapsedMs)}`}
          >
            {formatClock(elapsedMs)}
          </Text>
          <View style={s.resumePauseSlot}>
            <TouchableOpacity
              style={[s.resumePauseButton, !canTogglePause && s.controlDisabled]}
              onPress={() => { void togglePauseRecording(); }}
              disabled={!canTogglePause}
              activeOpacity={0.68}
              accessibilityRole="button"
              accessibilityLabel={isPaused ? '继续录音' : '暂停录音'}
              accessibilityState={{ disabled: !canTogglePause }}
              testID="meeting-live-resume-pause"
            >
              {pauseTransitioning ? (
                <ActivityIndicator size="small" color={C.primary} />
              ) : (
                <Ionicons name={isPaused ? 'play' : 'pause'} size={22} color={C.primary} />
              )}
            </TouchableOpacity>
          </View>
          <View style={s.controlSlot}>
            {canStop ? (
              <TouchableOpacity
                style={s.stopButton}
                onPress={confirmStopRecording}
                activeOpacity={0.68}
                accessibilityRole="button"
                accessibilityLabel="结束并保存会议录音"
              >
                <Ionicons name="stop" size={18} color={C.text} />
              </TouchableOpacity>
            ) : canStart ? (
              <TouchableOpacity
                style={s.retryButton}
                onPress={() => { void startRecording(); }}
                activeOpacity={0.72}
                accessibilityRole="button"
                accessibilityLabel={status === 'failed' ? '重试开始会议录音' : '开始会议录音'}
              >
                <Ionicons name={status === 'failed' ? 'refresh' : 'mic'} size={20} color="#FFFFFF" />
              </TouchableOpacity>
            ) : requestedMeetingMissing ? (
              <Ionicons name="close-circle-outline" size={20} color={C.disabled} />
            ) : (
              <ActivityIndicator size="small" color={C.primary} />
            )}
          </View>
        </View>
      </View>
    </ScreenContainer>
  );
}

const s = StyleSheet.create({
  meetingHeader: {
    minHeight: MEETING_RECORDING_GEOMETRY.titleMinHeight,
    backgroundColor: C.body,
  },
  titleContainer: {
    minHeight: 36,
    marginTop: 20,
    marginLeft: 20,
    marginRight: 10,
  },
  titleCover: { minHeight: 36, justifyContent: 'center' },
  titleText: {
    minHeight: 36,
    fontSize: 24,
    lineHeight: 36,
    fontWeight: '700',
    color: C.text,
  },
  titleInput: {
    minHeight: 36,
    padding: 0,
    fontSize: 24,
    lineHeight: 36,
    fontWeight: '700',
    color: C.text,
  },
  metaRow: {
    height: 22,
    marginLeft: 20,
    marginTop: 6,
    marginBottom: 16,
    flexDirection: 'row',
    alignItems: 'center',
  },
  metaText: { marginLeft: 4, fontSize: 14, lineHeight: 22, color: C.sub },
  singleTabDivider: {
    height: MEETING_RECORDING_GEOMETRY.singleTabDividerHeight,
    marginHorizontal: 20,
    backgroundColor: C.border,
  },
  errorBox: {
    minHeight: 44,
    paddingHorizontal: 20,
    backgroundColor: '#FFF3F3',
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  errorText: { flex: 1, fontSize: 13, lineHeight: 20, color: C.red },
  transcriptArea: { flex: 1, backgroundColor: C.body },
  transcriptScroll: { flex: 1 },
  transcriptContent: { flexGrow: 1, paddingBottom: 20 },
  emptyTranscript: { flex: 1, minHeight: 220, alignItems: 'center', justifyContent: 'center' },
  emptyText: { fontSize: 14, lineHeight: 20, color: C.sub, textAlign: 'center' },
  archivedText: { marginTop: 16, fontSize: 12, lineHeight: 18, color: C.sub, textAlign: 'center' },
  lineItem: {
    marginTop: 32,
    paddingLeft: MEETING_RECORDING_GEOMETRY.transcriptPaddingStart,
    paddingRight: MEETING_RECORDING_GEOMETRY.transcriptPaddingEnd,
  },
  firstLineItem: { marginTop: 20 },
  speakerAvatar: {
    width: MEETING_RECORDING_GEOMETRY.transcriptAvatarSize,
    height: MEETING_RECORDING_GEOMETRY.transcriptAvatarSize,
    borderRadius: MEETING_RECORDING_GEOMETRY.transcriptAvatarSize / 2,
    marginLeft: 2,
    marginRight: 6,
    backgroundColor: C.border,
    alignItems: 'center',
    justifyContent: 'center',
  },
  lineMeta: { minHeight: 23, flexDirection: 'row', alignItems: 'center' },
  speaker: { maxWidth: 200, paddingRight: 6, fontSize: 14, lineHeight: 20, color: C.sub },
  lineDot: { width: 3, height: 3, borderRadius: 1.5, marginRight: 12, backgroundColor: C.faint },
  lineTime: { fontSize: 14, lineHeight: 20, color: C.sub },
  lineText: { marginTop: 8, marginLeft: 2, fontSize: 16, lineHeight: 28, color: C.text },
  backToBottom: {
    position: 'absolute',
    right: 20,
    bottom: 12,
    width: 38,
    height: 38,
    borderRadius: 19,
    backgroundColor: C.body,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: C.border,
    elevation: 4,
  },
  recordingToolbar: {
    height: MEETING_RECORDING_GEOMETRY.toolbarHeight,
    backgroundColor: C.body,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: C.border,
  },
  waveformWrap: {
    height: MEETING_RECORDING_GEOMETRY.waveformHeight,
    marginTop: 12,
    marginHorizontal: 4,
    justifyContent: 'center',
    overflow: 'hidden',
  },
  recordingControlRow: {
    height: MEETING_RECORDING_GEOMETRY.controlRowHeight,
    flexDirection: 'row',
    alignItems: 'center',
  },
  timer: {
    minWidth: 88,
    height: MEETING_RECORDING_GEOMETRY.durationHeight,
    marginLeft: 20,
    paddingHorizontal: 13,
    fontSize: 16,
    lineHeight: 22,
    color: C.text,
    fontFamily: 'monospace',
    textAlign: 'center',
    textAlignVertical: 'center',
  },
  resumePauseSlot: {
    position: 'absolute',
    left: '50%',
    marginLeft: -(MEETING_RECORDING_GEOMETRY.resumePauseWidth / 2),
    width: MEETING_RECORDING_GEOMETRY.resumePauseWidth,
    height: MEETING_RECORDING_GEOMETRY.durationHeight,
  },
  resumePauseButton: {
    width: MEETING_RECORDING_GEOMETRY.resumePauseWidth,
    height: MEETING_RECORDING_GEOMETRY.durationHeight,
    borderRadius: 25,
    backgroundColor: C.primaryLight,
    alignItems: 'center',
    justifyContent: 'center',
  },
  controlDisabled: { opacity: 0.35 },
  controlSlot: {
    position: 'absolute',
    right: 20,
    width: MEETING_RECORDING_GEOMETRY.stopWidth,
    height: MEETING_RECORDING_GEOMETRY.durationHeight,
    alignItems: 'center',
    justifyContent: 'center',
  },
  stopButton: {
    width: MEETING_RECORDING_GEOMETRY.stopWidth,
    height: MEETING_RECORDING_GEOMETRY.stopHeight,
    alignItems: 'center',
    justifyContent: 'center',
  },
  retryButton: {
    width: MEETING_RECORDING_GEOMETRY.stopWidth,
    height: MEETING_RECORDING_GEOMETRY.stopHeight,
    borderRadius: 6,
    backgroundColor: C.primary,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
