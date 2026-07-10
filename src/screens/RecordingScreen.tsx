import React, { useEffect, useMemo, useRef, useState } from 'react';
import { View, Text, ScrollView, TouchableOpacity, StyleSheet, Share, Modal, ActivityIndicator, GestureResponderEvent } from 'react-native';
import { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { RouteProp } from '@react-navigation/native';
import { Ionicons } from '@expo/vector-icons';
import { Audio, AVPlaybackStatus } from 'expo-av';
import { Colors as C } from '../theme/colors';
import { ScreenContainer } from '../components/ScreenContainer';

import { RootStackParamList, TranscriptLine } from '../types';
import { useMeetings } from '../store/MeetingsStore';
import { ApiMeetingAudioInfo, fetchMeetingAudioInfo, fetchMeetingTranscript } from '../services/api';
import { generateSummaryForMeeting, meetingSummaryToText } from '../services/meetingSummary';
import { BackHeader, Tag, Waveform } from '../components/Common';
import { BottomTabBar } from '../components/BottomTabBar';
import { openMeetingsTab, openScheduleTab } from '../navigation/tabTargets';
import { fallbackMeetingBars, formatDuration, transcriptDurationSec, transcriptToBars } from '../utils/meetingMedia';
import { useAppDialog } from '../components/AppDialog';
import { useAuth } from '../store/AuthStore';

type Props = {
  navigation: NativeStackNavigationProp<RootStackParamList, 'Recording'>;
  route: RouteProp<RootStackParamList, 'Recording'>;
};

function localAudioInfo(uri: string | null | undefined): ApiMeetingAudioInfo | null {
  return uri ? { url: uri, mime_type: 'audio/wav', file_name: uri.split('/').pop() ?? 'meeting.wav' } : null;
}

export function RecordingScreen({ navigation, route }: Props) {
  const {
    meetings,
    deleteMeeting,
    getCachedTranscript,
    saveCachedTranscript,
    getCachedSummary,
    saveCachedSummary,
  } = useMeetings();
  const { accessToken, isGuest } = useAuth();
  const { showDialog } = useAppDialog();
  const m = meetings.find(x => x.id === route.params.meetingId);
  const [transcriptItems, setTranscriptItems] = useState<TranscriptLine[]>([]);
  const [summaryVisible, setSummaryVisible] = useState(false);
  const [summaryText, setSummaryText] = useState('');
  const [summaryLoading, setSummaryLoading] = useState(false);
  const [audioInfo, setAudioInfo] = useState<ApiMeetingAudioInfo | null>(null);
  const [audioLoading, setAudioLoading] = useState(false);
  const [audioError, setAudioError] = useState('');
  const [isPlaying, setPlaying] = useState(false);
  const [positionMs, setPositionMs] = useState(0);
  const [durationMs, setDurationMs] = useState(0);
  const [speed, setSpeed] = useState(1);
  const [progressWidth, setProgressWidth] = useState(1);
  const soundRef = useRef<Audio.Sound | null>(null);
  const meetingId = m?.id;

  useEffect(() => {
    if (!meetingId) {
      setTranscriptItems([]);
      return;
    }
    let alive = true;
    const cached = getCachedTranscript(meetingId);
    setTranscriptItems(cached);
    if (isGuest || !accessToken) return () => { alive = false; };
    fetchMeetingTranscript(meetingId, accessToken)
      .then(items => {
        if (!alive) return;
        const next = items.length > 0 ? items : cached;
        setTranscriptItems(next);
        if (items.length > 0) void saveCachedTranscript(meetingId, items);
      })
      .catch(() => { if (alive) setTranscriptItems(cached); });
    return () => { alive = false; };
  }, [accessToken, getCachedTranscript, isGuest, meetingId, saveCachedTranscript]);

  useEffect(() => {
    if (!meetingId) {
      setAudioInfo(null);
      setAudioError('');
      return;
    }
    let alive = true;
    setAudioLoading(true);
    setAudioError('');
    setAudioInfo(null);
    setPositionMs(0);
    setDurationMs(0);
    soundRef.current?.unloadAsync().catch(() => {});
    soundRef.current = null;
    const fallbackAudio = localAudioInfo(m?.audioLocalUri);
    if (isGuest || !accessToken) {
      setAudioInfo(fallbackAudio);
      setAudioLoading(false);
      return () => { alive = false; };
    }
    fetchMeetingAudioInfo(meetingId, accessToken)
      .then(info => {
        if (!alive) return;
        const next = info ?? fallbackAudio;
        setAudioInfo(next);
        if (next?.duration_sec) setDurationMs(Math.round(next.duration_sec * 1000));
      })
      .catch(() => {
        if (!alive) return;
        setAudioInfo(fallbackAudio);
        setAudioError(fallbackAudio ? '' : '录音服务暂时不可用');
      })
      .finally(() => {
        if (alive) setAudioLoading(false);
      });
    return () => { alive = false; };
  }, [accessToken, isGuest, meetingId, m?.audioLocalUri]);

  useEffect(() => {
    return () => {
      soundRef.current?.unloadAsync().catch(() => {});
      soundRef.current = null;
    };
  }, []);

  const bars = useMemo(() => {
    const fromTranscript = transcriptToBars(transcriptItems, 50);
    return fromTranscript.length > 0 ? fromTranscript : fallbackMeetingBars(meetingId ?? 'meeting', 50);
  }, [meetingId, transcriptItems]);
  const durationText = formatDuration(transcriptDurationSec(transcriptItems));
  const audioDurationText = formatDuration(Math.round((durationMs || (audioInfo?.duration_sec ?? 0) * 1000) / 1000));
  const positionText = formatDuration(Math.round(positionMs / 1000)) === '—' ? '00:00' : formatDuration(Math.round(positionMs / 1000));
  const progress = durationMs > 0 ? Math.min(1, Math.max(0, positionMs / durationMs)) : 0;

  const handlePlaybackStatus = (status: AVPlaybackStatus) => {
    if (!status.isLoaded) {
      setPlaying(false);
      return;
    }
    setPlaying(status.isPlaying);
    setPositionMs(status.positionMillis ?? 0);
    setDurationMs(status.durationMillis ?? durationMs);
  };

  const ensureSound = async (): Promise<Audio.Sound | null> => {
    if (!audioInfo) return null;
    if (soundRef.current) return soundRef.current;
    setAudioLoading(true);
    setAudioError('');
    try {
      await Audio.setAudioModeAsync({ playsInSilentModeIOS: true });
      const created = await Audio.Sound.createAsync(
        (audioInfo.requires_auth && accessToken
          ? { uri: audioInfo.url, headers: { Authorization: `Bearer ${accessToken}` } }
          : { uri: audioInfo.url }) as any,
        { shouldPlay: false, rate: speed, shouldCorrectPitch: true },
        handlePlaybackStatus,
      );
      soundRef.current = created.sound;
      return created.sound;
    } catch {
      setAudioError('录音加载失败，请稍后重试');
      return null;
    } finally {
      setAudioLoading(false);
    }
  };

  const togglePlayback = async () => {
    if (!audioInfo) {
      showDialog({ title: '暂无录音文件', message: '当前会议只有转写内容，没有可播放的录音文件。', tone: 'info' });
      return;
    }
    const sound = await ensureSound();
    if (!sound) return;
    if (isPlaying) await sound.pauseAsync();
    else await sound.playAsync();
  };

  const handleSeek = async (event: GestureResponderEvent) => {
    if (!durationMs || !soundRef.current) return;
    const ratio = Math.min(1, Math.max(0, event.nativeEvent.locationX / Math.max(1, progressWidth)));
    await soundRef.current.setPositionAsync(Math.round(durationMs * ratio));
  };

  const handleSpeed = async () => {
    const next = speed === 1 ? 1.25 : speed === 1.25 ? 1.5 : 1;
    setSpeed(next);
    if (soundRef.current) await soundRef.current.setRateAsync(next, true);
  };

  if (!m) {
    return (
      <ScreenContainer edges={['top']}>
        <BackHeader title="录音详情" onBack={() => navigation.goBack()} />
        <View style={s.emptyWrap}>
          <Text style={s.emptyTitle}>会议记录不存在</Text>
          <Text style={s.emptyText}>请返回会议列表后重新打开。</Text>
        </View>
        <BottomTabBar
          active="meetings"
          onSchedule={() => openScheduleTab(navigation)}
          onMeetings={() => openMeetingsTab(navigation)}
          onMic={() => navigation.navigate('MeetingLive')}
        />
      </ScreenContainer>
    );
  }

  const handleSummary = async () => {
    setSummaryVisible(true);
    if (summaryText) return; // already loaded
    const cachedText = meetingSummaryToText(getCachedSummary(m.id));
    if (cachedText) {
      setSummaryText(cachedText);
      return;
    }
    if (transcriptItems.length === 0) {
      setSummaryText('该会议暂无转写内容，无法生成总结。');
      return;
    }
    setSummaryLoading(true);
    try {
      const generated = await generateSummaryForMeeting({
        meetingId: m.id,
        title: m.title,
        transcriptLines: transcriptItems,
        isGuest,
        accessToken,
      });
      const text = meetingSummaryToText(generated);
      setSummaryText(text || '暂无总结内容');
      await saveCachedSummary(m.id, generated);
    } catch {
      setSummaryText('获取总结失败，请检查网络后重试');
    } finally {
      setSummaryLoading(false);
    }
  };

  const handleShareMeeting = async () => {
    try {
      const transcriptText = transcriptItems
        .map(item => `[${item.speaker_label ?? item.speaker_id ?? '发言人'}] ${item.text}`)
        .join('\n');
      const cachedSummary = summaryText || meetingSummaryToText(getCachedSummary(m.id));
      await Share.share({
        message: [
          m.title,
          [m.date, m.time].filter(Boolean).join(' '),
          cachedSummary ? `会议总结：\n${cachedSummary}` : '',
          transcriptText ? `转写内容：\n${transcriptText}` : '',
        ].filter(Boolean).join('\n\n'),
      });
    } catch (_) {}
  };

  const tiles = [
    { label: '转写', icon: 'document-text-outline' as const, bg: '#EEF3FF', color: C.blue,
      onPress: () => navigation.navigate('Transcription', { meetingId: m.id }) },
    { label: '总结', icon: 'clipboard-outline' as const, bg: '#FFF4E8', color: C.orange,
      onPress: handleSummary },
    { label: '分享', icon: 'share-outline' as const, bg: '#E8FAFC', color: C.teal,
      onPress: handleShareMeeting },
    { label: '删除', icon: 'trash-outline' as const, bg: '#FFF0F0', color: C.red,
      onPress: () => {
        showDialog({
          title: '确认删除',
          message: '确定要删除这条会议记录吗？',
          tone: 'danger',
          actions: [
            {
              text: '删除',
              role: 'destructive',
              onPress: async () => {
                try {
                  await deleteMeeting(m.id);
                  openMeetingsTab(navigation);
                } catch {
                  showDialog({ title: '删除失败', message: '请检查网络后重试', tone: 'error' });
                }
              },
            },
            { text: '取消', role: 'cancel' },
          ],
        });
      } },
  ];

  return (
    <ScreenContainer edges={['top']}>
      <BackHeader
        title="录音详情"
        onBack={() => navigation.goBack()}
        right={<TouchableOpacity onPress={handleShareMeeting} hitSlop={{ top:8,bottom:8,left:8,right:8 }}>
          <Ionicons name="share-outline" size={20} color={C.sub} />
        </TouchableOpacity>}
      />
      <ScrollView style={s.scroll} contentContainerStyle={s.content} showsVerticalScrollIndicator={false}>
        {/* Title */}
        <View style={s.titleRow}>
          <Text style={s.title}>{m.title}</Text>
          <TouchableOpacity
            hitSlop={{ top:8,bottom:8,left:8,right:8 }}
            onPress={() => navigation.navigate('Transcription', { meetingId: m.id })}
          >
            <Ionicons name="pencil-outline" size={15} color={C.sub} />
          </TouchableOpacity>
        </View>
        <Text style={s.meta}>{[m.date, m.time].filter(Boolean).join('　')}</Text>
        <View style={s.tags}>
          {m.tags.map(t => <Tag key={t.label} label={t.label} color={t.color} />)}
        </View>

        <View style={s.playerCard}>
          <View style={s.waveWrap}>
            <Waveform bars={bars} color={audioInfo ? C.purple : C.faint} height={64} splitAt={audioInfo ? Math.floor(bars.length * progress) : undefined} />
          </View>
          {audioLoading && !audioInfo ? (
            <View style={s.audioState}>
              <ActivityIndicator size="small" color={C.purple} />
              <Text style={s.audioStateText}>正在获取录音</Text>
            </View>
          ) : audioInfo ? (
            <>
              <View style={s.playerTop}>
                <TouchableOpacity style={s.playBtn} onPress={togglePlayback} activeOpacity={0.86}>
                  {audioLoading ? <ActivityIndicator size="small" color="#fff" /> : <Ionicons name={isPlaying ? 'pause' : 'play'} size={22} color="#fff" />}
                </TouchableOpacity>
                <TouchableOpacity style={s.speedBtn} onPress={handleSpeed}>
                  <Text style={s.speedText}>{speed}x</Text>
                </TouchableOpacity>
              </View>
              <TouchableOpacity
                style={s.progressTrack}
                onLayout={event => setProgressWidth(event.nativeEvent.layout.width)}
                onPress={handleSeek}
                activeOpacity={0.8}
              >
                <View style={[s.progressFill, { width: `${progress * 100}%` }]} />
              </TouchableOpacity>
              <View style={s.timeLine}>
                <Text style={s.timeText}>{positionText}</Text>
                <Text style={s.timeText}>{audioDurationText}</Text>
              </View>
            </>
          ) : (
            <>
              <View style={s.timeLine}>
                <Text style={s.timeText}>转写时长</Text>
                <Text style={s.timeText}>{durationText}</Text>
              </View>
              <View style={s.audioState}>
                <Ionicons name="information-circle-outline" size={16} color={C.sub} />
                <Text style={s.audioStateText}>{audioError || '仅有转写，无录音文件'}</Text>
              </View>
            </>
          )}
          <View style={s.recordingActions}>
            <TouchableOpacity
              style={s.recordingAction}
              onPress={() => navigation.navigate('Transcription', { meetingId: m.id })}
              activeOpacity={0.8}
            >
              <Ionicons name="document-text-outline" size={16} color={C.purple} />
              <Text style={s.recordingActionText}>查看转写</Text>
            </TouchableOpacity>
          </View>
        </View>

        {/* 2×2 tiles */}
        <View style={s.tileGrid}>
          {tiles.map(({ label, icon, bg, color, onPress }) => (
            <TouchableOpacity key={label} style={[s.tile, { backgroundColor: bg }]} onPress={onPress} activeOpacity={0.8}>
              <Ionicons name={icon} size={30} color={color} />
              <Text style={s.tileLabel}>{label}</Text>
            </TouchableOpacity>
          ))}
        </View>
        <View style={{ height: 16 }} />
      </ScrollView>
      <BottomTabBar
        active="meetings"
        onSchedule={() => openScheduleTab(navigation)}
        onMeetings={() => openMeetingsTab(navigation)}
        onMic={() => navigation.navigate('MeetingLive')}
      />

      {/* AI Summary Modal */}
      <Modal visible={summaryVisible} transparent animationType="slide" onRequestClose={() => setSummaryVisible(false)}>
        <View style={s.modalOverlay}>
          <View style={s.modalSheet}>
            <View style={s.modalHandle} />
            <Text style={s.modalTitle}>会议总结</Text>
            {summaryLoading
              ? <ActivityIndicator size="large" color={C.purple} style={{ marginVertical: 30 }} />
              : <Text style={s.modalBody}>{summaryText}</Text>
            }
            <TouchableOpacity style={s.modalClose} onPress={() => setSummaryVisible(false)}>
              <Text style={s.modalCloseTxt}>关闭</Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>
    </ScreenContainer>
  );
}

const s = StyleSheet.create({
  container: { flex: 1, backgroundColor: C.appBg },
  scroll: { flex: 1 },
  content: { padding: 20, paddingTop: 22 },
  emptyWrap: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24 },
  emptyTitle: { fontSize: 17, fontWeight: '700', color: C.text, marginBottom: 8 },
  emptyText: { fontSize: 13, color: C.sub, lineHeight: 20 },
  titleRow: { flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 6 },
  title: { fontSize: 21, fontWeight: '800', color: C.text, flex: 1 },
  meta: { fontSize: 13, color: C.sub, marginBottom: 10 },
  tags: { flexDirection: 'row', gap: 6, flexWrap: 'wrap', marginBottom: 24 },
  playerCard: { backgroundColor: C.waveformBg, borderRadius: 20, padding: 20, paddingBottom: 18, marginBottom: 22 },
  waveWrap: { marginBottom: 14 },
  timeLine: { flexDirection: 'row', justifyContent: 'space-between', marginBottom: 14 },
  timeText: { fontSize: 12, color: C.sub },
  playerTop: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 },
  playBtn: { width: 46, height: 46, borderRadius: 23, backgroundColor: C.purple, alignItems: 'center', justifyContent: 'center', shadowColor: C.purple, shadowOffset:{width:0,height:4}, shadowOpacity:0.25, shadowRadius:8, elevation:4 },
  speedBtn: { borderRadius: 15, backgroundColor: C.card, paddingHorizontal: 12, paddingVertical: 7 },
  speedText: { fontSize: 12, color: C.purple, fontWeight: '800' },
  progressTrack: { height: 10, borderRadius: 5, backgroundColor: '#E2DBF4', marginBottom: 10, overflow: 'hidden' },
  progressFill: { height: '100%', borderRadius: 5, backgroundColor: C.purple },
  audioState: { minHeight: 32, borderRadius: 16, backgroundColor: 'rgba(255,255,255,0.62)', flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 7, marginBottom: 14, paddingHorizontal: 12 },
  audioStateText: { fontSize: 12, color: C.sub, fontWeight: '600' },
  recordingActions: { flexDirection: 'row', justifyContent: 'center' },
  recordingAction: { flexDirection: 'row', alignItems: 'center', gap: 6, backgroundColor: C.purpleLight, borderRadius: 16, paddingHorizontal: 14, paddingVertical: 9 },
  recordingActionText: { fontSize: 13, color: C.purple, fontWeight: '700' },
  tileGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 12 },
  tile: { width: '47%', height: 96, borderRadius: 18, alignItems: 'center', justifyContent: 'center', gap: 8 },
  tileLabel: { fontSize: 15, fontWeight: '600', color: C.text },
  // Summary modal
  modalOverlay: { flex: 1, justifyContent: 'flex-end', backgroundColor: 'rgba(0,0,0,0.35)' },
  modalSheet: { backgroundColor: '#fff', borderTopLeftRadius: 24, borderTopRightRadius: 24, padding: 24, paddingBottom: 36, maxHeight: '80%' },
  modalHandle: { width: 40, height: 4, borderRadius: 2, backgroundColor: '#E0D8F0', alignSelf: 'center', marginBottom: 16 },
  modalTitle: { fontSize: 18, fontWeight: '700', color: '#1C1B33', marginBottom: 16 },
  modalBody: { fontSize: 14, color: '#1C1B33', lineHeight: 22 },
  modalClose: { marginTop: 24, backgroundColor: '#7B5CB8', borderRadius: 20, paddingVertical: 12, alignItems: 'center' },
  modalCloseTxt: { fontSize: 15, fontWeight: '600', color: '#fff' },
});
