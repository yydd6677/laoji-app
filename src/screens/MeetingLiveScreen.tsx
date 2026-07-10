import React, { useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, ScrollView, StyleSheet, Text, TextInput, TouchableOpacity, View } from 'react-native';
import { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { RouteProp } from '@react-navigation/native';
import { Ionicons } from '@expo/vector-icons';
import { Audio } from 'expo-av';
import { LinearGradient } from 'expo-linear-gradient';
import { Colors as C } from '../theme/colors';
import { ScreenContainer } from '../components/ScreenContainer';
import { BackHeader } from '../components/Common';
import { BottomTabBar } from '../components/BottomTabBar';
import { useAppDialog } from '../components/AppDialog';
import { openMeetingsTab, openScheduleTab } from '../navigation/tabTargets';
import { useAuth } from '../store/AuthStore';
import { useMeetings } from '../store/MeetingsStore';
import { generateMeetingSummary, uploadMeetingAudio } from '../services/api';
import { RealtimeAsrAudioStats, RealtimeAsrSession, RealtimeAsrStatus, startRealtimeAsr } from '../services/realtimeAsr';
import { RootStackParamList, TranscriptLine } from '../types';

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

function normalizeAudioUri(uri: string | undefined): string | undefined {
  if (!uri) return undefined;
  return uri.startsWith('file://') || uri.startsWith('content://') ? uri : `file://${uri}`;
}

export function MeetingLiveScreen({ navigation, route }: Props) {
  const { accessToken, isGuest } = useAuth();
  const {
    meetings,
    createMeeting,
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
  const sessionRef = useRef<RealtimeAsrSession | null>(null);
  const startedAtRef = useRef<number | null>(null);
  const activeMeetingIdRef = useRef('');

  const ticking = status === 'connecting' || status === 'recording' || status === 'connected' || status === 'stopping';
  const canStop = status === 'recording' || status === 'connected';
  const canStart = status === 'idle' || status === 'closed' || status === 'failed';
  const busy = status === 'connecting' || status === 'stopping' || status === 'saving' || status === 'summarizing';
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

  useEffect(() => {
    if (!ticking) return;
    const timer = setInterval(() => {
      if (startedAtRef.current) setElapsedMs(Date.now() - startedAtRef.current);
    }, 500);
    return () => clearInterval(timer);
  }, [ticking]);

  useEffect(() => {
    if (!existing?.id) return;
    setTranscript(getCachedTranscript(existing.id));
    activeMeetingIdRef.current = existing.id;
  }, [existing?.id, getCachedTranscript]);

  useEffect(() => {
    return () => {
      const session = sessionRef.current;
      sessionRef.current = null;
      if (session) void session.stop();
    };
  }, []);

  const appendTranscript = (line: Omit<TranscriptLine, 'id'>) => {
    setTranscript(prev => {
      const id = `${activeMeetingIdRef.current || meetingId}-${line.start_time ?? prev.length}-${line.text}`;
      if (prev.some(item => item.id === id || (item.text === line.text && item.start_time === line.start_time))) return prev;
      const next = [...prev, { id, ...line }];
      if (activeMeetingIdRef.current) void saveCachedTranscript(activeMeetingIdRef.current, next);
      return next;
    });
  };

  const startRecording = async () => {
    if (!canStart) return;
    setError('');
    try {
      const permission = await Audio.requestPermissionsAsync();
      if (!permission.granted) {
        showDialog({ title: '无法录音', message: '请允许麦克风权限后再开始会议。', tone: 'warning' });
        return;
      }
      await Audio.setAudioModeAsync({ allowsRecordingIOS: true, playsInSilentModeIOS: true });
      const meeting = existing ?? await createMeeting(title, { mode: 'realtime' });
      setMeetingId(meeting.id);
      activeMeetingIdRef.current = meeting.id;
      await updateMeetingStatus(meeting.id, 'recording');
      startedAtRef.current = Date.now();
      setElapsedMs(0);
      setTranscript(existing?.id === meeting.id ? getCachedTranscript(meeting.id) : []);
      const session = await startRealtimeAsr({
        meetingId: meeting.id,
        accessToken: isGuest ? null : accessToken,
        provider: 'funasr',
        onStatus: next => setStatus(next),
        onAudioStats: setAudioStats,
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
        onError: err => setError(err.message || '实时转写异常'),
      });
      sessionRef.current = session;
    } catch (err) {
      setStatus('failed');
      const message = err instanceof Error ? err.message : '启动会议录音失败';
      setError(message);
      showDialog({ title: '启动失败', message, tone: 'error' });
    }
  };

  const stopRecording = async () => {
    const session = sessionRef.current;
    if (!session || !meetingId) return;
    setStatus('stopping');
    sessionRef.current = null;
    try {
      const audioUri = normalizeAudioUri(await session.stop());
      setStatus('saving');
      await saveCachedTranscript(meetingId, transcript);
      if (!isGuest && accessToken) {
        if (audioUri) {
          try {
            await uploadMeetingAudio(meetingId, audioUri, accessToken, { fileName: `${meetingId}.wav`, mimeType: 'audio/wav' });
          } catch {
            setError('会议已保存，但录音文件上传失败');
          }
        }
        await updateMeetingStatus(meetingId, 'ended', { hasTranscript: transcript.length > 0, audioLocalUri: audioUri ?? null });
        if (transcript.length > 0) {
          setStatus('summarizing');
          try {
            await generateMeetingSummary(meetingId, accessToken);
          } catch {
            setError('转写已保存，总结生成稍后可重试');
          }
        }
        await refreshMeetings();
      } else {
        await updateMeetingStatus(meetingId, 'ended', { hasTranscript: transcript.length > 0, audioLocalUri: audioUri ?? null });
      }
      setStatus('closed');
      navigation.replace('Transcription', { meetingId });
    } catch (err) {
      setStatus('failed');
      const message = err instanceof Error ? err.message : '停止会议失败';
      setError(message);
      showDialog({ title: '停止失败', message, tone: 'error' });
    }
  };

  return (
    <ScreenContainer edges={['top']}>
      <BackHeader title="实时会议" onBack={() => navigation.goBack()} />
      <ScrollView style={s.scroll} contentContainerStyle={s.content} showsVerticalScrollIndicator={false}>
        <View style={s.heroCard}>
          <Text style={s.label}>会议标题</Text>
          <TextInput
            style={s.titleInput}
            value={title}
            onChangeText={setTitle}
            editable={!ticking && !meetingId}
            placeholder="输入会议标题"
            placeholderTextColor={C.faint}
          />
          <View style={s.statusRow}>
            <View style={[s.dot, ticking ? s.dotLive : status === 'failed' ? s.dotError : s.dotIdle]} />
            <Text style={s.statusText}>{statusText}</Text>
            <Text style={s.timer}>{formatClock(elapsedMs)}</Text>
          </View>
        </View>

        <View style={s.levelCard}>
          <Text style={s.sectionTitle}>音频输入</Text>
          <View style={s.levelTrack}>
            <View style={[s.levelFill, { width: `${Math.min(100, Math.round(((audioStats?.sent.rms ?? 0) / 9000) * 100))}%` }]} />
          </View>
          <Text style={s.levelMeta}>
            {audioStats ? `已发送 ${audioStats.frameCount} 帧 · 增益 ${audioStats.gain.toFixed(1)}x` : '等待麦克风输入'}
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
            transcript.map(line => (
              <View key={line.id} style={s.lineItem}>
                <Text style={s.speaker}>{line.speaker_label ?? '发言人'}</Text>
                <Text style={s.lineText}>{line.text}</Text>
              </View>
            ))
          )}
        </View>

        {error ? (
          <View style={s.errorBox}>
            <Ionicons name="alert-circle-outline" size={16} color={C.red} />
            <Text style={s.errorText}>{error}</Text>
          </View>
        ) : null}
      </ScrollView>

      <View style={s.fixedControls}>
        <TouchableOpacity
          activeOpacity={0.88}
          onPress={canStop ? stopRecording : startRecording}
          disabled={!canStart && !canStop}
          accessibilityRole="button"
          accessibilityLabel={canStop ? '停止会议录音' : '开始会议录音'}
        >
          <LinearGradient
            colors={canStop ? [C.red, '#D9363E'] : [C.gradFrom, C.gradTo]}
            start={{ x: 0, y: 0 }}
            end={{ x: 1, y: 1 }}
            style={[s.recordButton, (!canStart && !canStop) && s.recordButtonDisabled]}
          >
            {busy ? (
              <ActivityIndicator color="#fff" />
            ) : (
              <Ionicons name={canStop ? 'stop' : 'mic'} size={31} color="#fff" />
            )}
          </LinearGradient>
        </TouchableOpacity>
        <Text style={s.controlText}>{canStop ? '停止并生成会议记录' : busy ? statusText : '开始录音'}</Text>
      </View>

      <BottomTabBar
        active="meetings"
        onSchedule={() => openScheduleTab(navigation)}
        onMeetings={() => openMeetingsTab(navigation)}
        onMic={() => {
          if (canStop) void stopRecording();
          else if (canStart) void startRecording();
        }}
      />
    </ScreenContainer>
  );
}

const s = StyleSheet.create({
  scroll: { flex: 1 },
  content: { padding: 14, paddingBottom: 134 },
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
  emptyTranscript: { minHeight: 192, alignItems: 'center', justifyContent: 'center', gap: 10 },
  emptyText: { fontSize: 13, color: C.sub, textAlign: 'center', lineHeight: 20 },
  lineItem: { borderRadius: 12, backgroundColor: '#F8F5FF', padding: 12, marginBottom: 8 },
  speaker: { fontSize: 12, color: C.purple, fontWeight: '800', marginBottom: 4 },
  lineText: { fontSize: 14, color: '#4A4666', lineHeight: 22 },
  errorBox: { minHeight: 40, borderRadius: 14, backgroundColor: '#FFF0F0', marginTop: 12, paddingHorizontal: 12, flexDirection: 'row', alignItems: 'center', gap: 8 },
  errorText: { flex: 1, fontSize: 12, color: C.red, fontWeight: '700' },
  fixedControls: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 86,
    alignItems: 'center',
    pointerEvents: 'box-none',
  },
  recordButton: {
    width: 84,
    height: 84,
    borderRadius: 42,
    alignItems: 'center',
    justifyContent: 'center',
    shadowColor: '#6A38B2',
    shadowOffset: { width: 0, height: 8 },
    shadowOpacity: 0.34,
    shadowRadius: 16,
    elevation: 12,
  },
  recordButtonDisabled: { opacity: 0.58 },
  controlText: { marginTop: 8, fontSize: 12, color: C.sub, fontWeight: '800' },
});
