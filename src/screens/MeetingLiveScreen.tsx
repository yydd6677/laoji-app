import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AppState, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { RouteProp } from '@react-navigation/native';
import { Ionicons } from '@expo/vector-icons';
import { Audio } from 'expo-av';
import { Colors as C } from '../theme/colors';
import { ScreenContainer } from '../components/ScreenContainer';
import { BackHeader } from '../components/Common';
import { BottomTabBar, BOTTOM_TAB_BAR_GEOMETRY } from '../components/BottomTabBar';
import { useAppDialog } from '../components/AppDialog';
import { openMeetingsTab, openScheduleTab } from '../navigation/tabTargets';
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
import { meetingAudioInputLabel, meetingAudioLevelPercent } from '../utils/meetingAudioStatus';
import { createClientRequestState, requestStateForPayload } from '../services/clientRequestId';

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
    updateMeetingStatus,
    getCachedTranscript,
    saveCachedTranscript,
    refreshMeetings,
  } = useMeetings();
  const { showDialog } = useAppDialog();
  const existing = route.params?.meetingId ? meetings.find(item => item.id === route.params?.meetingId) : undefined;
  const [title, setTitle] = useState(existing?.title ?? defaultTitle());
  const [meetingId, setMeetingId] = useState(existing?.id ?? '');
  const [status, setStatus] = useState<RealtimeAsrStatus | 'idle' | 'saving' | 'summarizing' | 'failed'>('idle');
  const [transcript, setTranscript] = useState<TranscriptLine[]>(() => existing ? getCachedTranscript(existing.id) : []);
  const [error, setError] = useState('');
  const [elapsedMs, setElapsedMs] = useState(0);
  const [audioStats, setAudioStats] = useState<RealtimeAsrAudioStats | null>(null);
  const activeRecordingRef = useRef<ActiveRecording | null>(null);
  const finalizationUiPromiseRef = useRef<Promise<boolean> | null>(null);
  const navigateAfterFinalizeRef = useRef(false);
  const mountedRef = useRef(true);
  const startedAtRef = useRef<number | null>(null);
  const audioStatsRef = useRef<RealtimeAsrAudioStats | null>(null);
  const audioRmsSamplesRef = useRef<number[]>([]);
  const activeMeetingIdRef = useRef('');
  const transcriptRef = useRef<TranscriptLine[]>(transcript);
  const transcriptCheckpointRef = useRef({ lineCount: transcript.length, savedAtMs: Date.now() });
  const leavePromptOpenRef = useRef(false);
  const backgroundStopRef = useRef(false);
  const startInFlightRef = useRef(false);
  const createRequestRef = useRef(createClientRequestState('meeting'));
  const recordingStorageScope = isGuest ? 'guest' : session ? `user:${session.user.id}` : 'signed_out';

  const ticking = status === 'connecting' || status === 'recording' || status === 'connected' || status === 'stopping';
  const canStop = Boolean(activeRecordingRef.current) && (
    status === 'recording' || status === 'connected' || status === 'failed'
  );
  const canStart = (!existing || canResumeMeetingRecording(existing)) && !activeRecordingRef.current && (
    status === 'idle' || status === 'closed' || status === 'failed'
  );
  const visibleTranscript = useMemo(() => latestTranscriptWindow(transcript, 40), [transcript]);
  const statusText = useMemo(() => {
    if (status === 'idle') return '准备开始';
    if (status === 'connecting') return '正在连接实时转写';
    if (status === 'recording' || status === 'connected') return '实时转写中';
    if (status === 'stopping') return '正在停止';
    if (status === 'saving') return '正在保存会议';
    if (status === 'summarizing') return '正在生成总结';
    if (status === 'closed') return '已结束';
    return '需要重试';
  }, [status]);

  const restorePlaybackAudioMode = useCallback(async () => {
    await Audio.setAudioModeAsync({ allowsRecordingIOS: false, playsInSilentModeIOS: true }).catch(() => {});
  }, []);

  useEffect(() => {
    if (!ticking) return;
    const timer = setInterval(() => {
      if (startedAtRef.current) setElapsedMs(Date.now() - startedAtRef.current);
    }, 500);
    return () => clearInterval(timer);
  }, [ticking]);

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
    let startedMeetingId = '';
    let guestSession: ApiGuestRealtimeSession | undefined;
    let createdForAttempt = false;
    let reusableStatus = 'created';
    const ensureScreenActive = () => {
      if (!mountedRef.current) throw new MeetingStartCancelledError();
    };
    try {
      const permission = await Audio.requestPermissionsAsync();
      ensureScreenActive();
      if (!permission.granted) {
        setStatus('idle');
        showDialog({ title: '无法录音', message: '请允许麦克风权限后再开始会议。', tone: 'warning' });
        return;
      }
      await Audio.setAudioModeAsync({ allowsRecordingIOS: true, playsInSilentModeIOS: true });
      ensureScreenActive();
      const reusableMeeting = existing ?? (meetingId ? meetings.find(item => item.id === meetingId) : undefined);
      reusableStatus = reusableMeeting?.status ?? 'created';
      createdForAttempt = !reusableMeeting;
      const meetingPayload = { title: title.trim() || defaultTitle(), mode: 'realtime' as const };
      createRequestRef.current = requestStateForPayload(createRequestRef.current, 'meeting', meetingPayload);
      const meeting = reusableMeeting ?? await createMeeting(meetingPayload.title, {
        mode: meetingPayload.mode,
        clientRequestId: createRequestRef.current.id,
      });
      startedMeetingId = meeting.id;
      ensureScreenActive();
      setMeetingId(meeting.id);
      activeMeetingIdRef.current = meeting.id;
      await updateMeetingStatus(meeting.id, 'recording');
      ensureScreenActive();
      const initialTranscript = reusableMeeting ? getCachedTranscript(meeting.id) : [];
      transcriptRef.current = initialTranscript;
      transcriptCheckpointRef.current = { lineCount: initialTranscript.length, savedAtMs: Date.now() };
      setTranscript(initialTranscript);
      if (isGuest) {
        guestSession = await createGuestRealtimeSession(meeting.title);
        ensureScreenActive();
      }
      const session = await startRealtimeAsr({
        meetingId: guestSession?.meeting_id ?? meeting.id,
        accessToken: isGuest ? null : accessToken,
        guestToken: guestSession?.guest_token,
        provider: 'funasr',
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
          if (mountedRef.current) setError(err.message || '实时转写异常');
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
      void session.completion.then(completion => {
        if (activeRecordingRef.current !== active || !mountedRef.current) return;
        if (completion.reason !== 'connection-closed') return;
        setError('实时连接意外断开，正在保存本次录音和转写');
        void finalizeActiveRecording(active, !finalizationUiPromiseRef.current);
      });
      startedAtRef.current = Date.now();
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
        const message = err instanceof Error ? err.message : '启动会议录音失败';
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
    setStatus('stopping');
    return finalizeActiveRecording(active, navigateAfter);
  }, [finalizeActiveRecording]);

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
    <ScreenContainer edges={['top']}>
      <BackHeader title="实时会议" onBack={() => navigation.goBack()} />
      <ScrollView style={s.scroll} contentContainerStyle={s.content} showsVerticalScrollIndicator={false}>
        <View style={s.heroCard}>
          <Text style={s.label}>会议标题</Text>
          <TextInput
            style={s.titleInput}
            testID="meeting-live-title"
            value={title}
            onChangeText={setTitle}
            editable={!ticking && !meetingId}
            placeholder="输入会议标题"
            placeholderTextColor={C.faint}
          />
          <View style={s.statusRow}>
            <View style={[s.dot, ticking ? s.dotLive : status === 'failed' ? s.dotError : s.dotIdle]} />
            <Text style={s.statusText} testID="meeting-live-status">{statusText}</Text>
            <Text style={s.timer}>{formatClock(elapsedMs)}</Text>
          </View>
        </View>

        <View style={s.levelCard}>
          <Text style={s.sectionTitle}>音频输入</Text>
          <View style={s.levelTrack}>
            <View style={[s.levelFill, { width: `${meetingAudioLevelPercent(audioStats?.raw.rms ?? 0)}%` }]} />
          </View>
          <Text style={s.levelMeta}>
            {audioStats ? meetingAudioInputLabel(audioStats.raw.rms) : '等待麦克风输入'}
          </Text>
        </View>

        <View style={s.transcriptCard}>
          <View style={s.cardHead}>
            <Text style={s.sectionTitle}>实时转写</Text>
            <Text style={s.countText}>{transcript.length} 句</Text>
          </View>
          {transcript.length === 0 ? (
            <View style={s.emptyTranscript}>
              <Ionicons name="mic-outline" size={28} color={C.faint} />
              <Text style={s.emptyText}>开始录音后，识别出的句子会实时出现在这里</Text>
            </View>
          ) : (
            <>
              {visibleTranscript.hiddenCount > 0 ? (
                <Text style={s.archivedText}>较早的 {visibleTranscript.hiddenCount} 句已收纳</Text>
              ) : null}
              {visibleTranscript.items.map(line => (
                <View key={line.id} style={s.lineItem}>
                  <Text style={s.speaker}>{line.speaker_label ?? '发言人'}</Text>
                  <Text style={s.lineText} testID="meeting-live-transcript-line">{line.text}</Text>
                </View>
              ))}
            </>
          )}
        </View>

        {error ? (
          <View style={s.errorBox}>
            <Ionicons name="alert-circle-outline" size={16} color={C.red} />
            <Text style={s.errorText}>{error}</Text>
          </View>
        ) : null}
      </ScrollView>

      <BottomTabBar
        active="meetings"
        onSchedule={() => openScheduleTab(navigation)}
        onMeetings={() => openMeetingsTab(navigation)}
        micTone={canStop ? 'recording' : 'meeting'}
        onMic={() => {
          if (canStop) void stopRecording(true);
          else if (canStart) void startRecording();
        }}
      />
    </ScreenContainer>
  );
}

const s = StyleSheet.create({
  scroll: { flex: 1 },
  content: { padding: 14, paddingBottom: BOTTOM_TAB_BAR_GEOMETRY.scrollContentClearance },
  heroCard: {
    backgroundColor: C.card,
    borderRadius: 18,
    padding: 16,
    shadowColor: '#5028A0',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.07,
    shadowRadius: 12,
    elevation: 2,
  },
  label: { fontSize: 12, color: C.sub, fontWeight: '700', marginBottom: 8 },
  titleInput: { minHeight: 42, fontSize: 20, fontWeight: '800', color: C.text, padding: 0 },
  statusRow: { height: 34, marginTop: 12, flexDirection: 'row', alignItems: 'center', gap: 8 },
  dot: { width: 8, height: 8, borderRadius: 4 },
  dotLive: { backgroundColor: C.red },
  dotError: { backgroundColor: C.red },
  dotIdle: { backgroundColor: C.faint },
  statusText: { flex: 1, fontSize: 13, color: C.sub, fontWeight: '700' },
  timer: { fontSize: 20, color: C.purpleDark, fontWeight: '800' },
  levelCard: { marginTop: 12, backgroundColor: C.waveformBg, borderRadius: 18, padding: 16 },
  sectionTitle: { fontSize: 15, color: C.text, fontWeight: '800' },
  levelTrack: { height: 10, borderRadius: 5, backgroundColor: '#E2DBF4', overflow: 'hidden', marginTop: 14 },
  levelFill: { height: '100%', borderRadius: 5, backgroundColor: C.purple },
  levelMeta: { marginTop: 10, fontSize: 12, color: C.sub, fontWeight: '600' },
  transcriptCard: { marginTop: 12, backgroundColor: C.card, borderRadius: 18, padding: 16, minHeight: 260 },
  cardHead: { height: 26, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 },
  countText: { fontSize: 12, color: C.sub, fontWeight: '700' },
  archivedText: { marginBottom: 8, fontSize: 11, color: C.sub, textAlign: 'center', fontWeight: '600' },
  emptyTranscript: { minHeight: 192, alignItems: 'center', justifyContent: 'center', gap: 10 },
  emptyText: { fontSize: 13, color: C.sub, textAlign: 'center', lineHeight: 20 },
  lineItem: { borderRadius: 12, backgroundColor: '#F8F5FF', padding: 12, marginBottom: 8 },
  speaker: { fontSize: 12, color: C.purple, fontWeight: '800', marginBottom: 4 },
  lineText: { fontSize: 14, color: '#4A4666', lineHeight: 22 },
  errorBox: { minHeight: 40, borderRadius: 14, backgroundColor: '#FFF0F0', marginTop: 12, paddingHorizontal: 12, flexDirection: 'row', alignItems: 'center', gap: 8 },
  errorText: { flex: 1, fontSize: 12, color: C.red, fontWeight: '700' },
});
