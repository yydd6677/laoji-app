import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  View,
  Text,
  ScrollView,
  TouchableOpacity,
  StyleSheet,
  ActivityIndicator,
  GestureResponderEvent,
  AccessibilityActionEvent,
} from 'react-native';
import { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { RouteProp } from '@react-navigation/native';
import { Ionicons } from '@expo/vector-icons';
import { Audio, AVPlaybackStatus } from 'expo-av';
import { Colors as C } from '../theme/colors';
import { ScreenContainer } from '../components/ScreenContainer';

import { RootStackParamList, TranscriptLine } from '../types';
import { MeetingDeletionCleanupError, useMeetings } from '../store/MeetingsStore';
import { ApiMeetingAudioInfo, fetchMeetingAudioInfo, fetchMeetingSummary, fetchMeetingTranscript } from '../services/api';
import { meetingSummaryToText } from '../services/meetingSummary';
import { MeetingShareKind, meetingShareErrorMessage, shareMeetingArtifact } from '../services/meetingShare';
import { BackHeader, Tag, Waveform } from '../components/Common';
import { BottomTabBar, BOTTOM_TAB_BAR_GEOMETRY } from '../components/BottomTabBar';
import { openMeetingsTab, openScheduleTab } from '../navigation/tabTargets';
import { formatDuration, shouldReplayAudio, transcriptDurationSec } from '../utils/meetingMedia';
import { useAppDialog } from '../components/AppDialog';
import { useAuth } from '../store/AuthStore';
import { meetingAudioUrlErrorMessage, validateMeetingAudioUrl } from '../services/meetingAudioSecurity';
import { readableErrorMessage } from '../services/errors';

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
  const [summaryText, setSummaryText] = useState('');
  const [audioInfo, setAudioInfo] = useState<ApiMeetingAudioInfo | null>(null);
  const [audioLoading, setAudioLoading] = useState(false);
  const [audioError, setAudioError] = useState('');
  const [audioReloadKey, setAudioReloadKey] = useState(0);
  const [isPlaying, setPlaying] = useState(false);
  const [positionMs, setPositionMs] = useState(0);
  const [durationMs, setDurationMs] = useState(0);
  const [speed, setSpeed] = useState(1);
  const [progressWidth, setProgressWidth] = useState(1);
  const [sharing, setSharing] = useState(false);
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
        if (items.length > 0) {
          void saveCachedTranscript(meetingId, items).catch(() => {});
        }
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
      if (m?.audioDurationSec) setDurationMs(Math.round(m.audioDurationSec * 1000));
      setAudioLoading(false);
      return () => { alive = false; };
    }
    fetchMeetingAudioInfo(meetingId, accessToken)
      .then(info => {
        if (!alive) return;
        const next = info ?? fallbackAudio;
        setAudioInfo(next);
        const durationSec = next?.duration_sec ?? m?.audioDurationSec;
        if (durationSec) setDurationMs(Math.round(durationSec * 1000));
      })
      .catch(error => {
        if (!alive) return;
        setAudioInfo(fallbackAudio);
        if (m?.audioDurationSec) setDurationMs(Math.round(m.audioDurationSec * 1000));
        setAudioError(fallbackAudio ? '' : meetingAudioUrlErrorMessage(error) ?? '录音服务暂时不可用');
      })
      .finally(() => {
        if (alive) setAudioLoading(false);
      });
    return () => { alive = false; };
  }, [accessToken, audioReloadKey, isGuest, meetingId, m?.audioDurationSec, m?.audioLocalUri]);

  useEffect(() => {
    return () => {
      soundRef.current?.unloadAsync().catch(() => {});
      soundRef.current = null;
    };
  }, []);

  const bars = useMemo(() => m?.audioBars ?? [], [m?.audioBars]);
  const durationText = formatDuration(transcriptDurationSec(transcriptItems));
  const audioDurationText = formatDuration(Math.round((
    durationMs || (audioInfo?.duration_sec ?? m?.audioDurationSec ?? 0) * 1000
  ) / 1000));
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
      const isLocalAudio = audioInfo.url.startsWith('file://') || audioInfo.url.startsWith('content://');
      const sourceUrl = isLocalAudio
        ? audioInfo.url
        : validateMeetingAudioUrl(audioInfo.url, {
          requiresAuth: audioInfo.requires_auth,
          expiresAt: audioInfo.expires_at,
        });
      await Audio.setAudioModeAsync({ playsInSilentModeIOS: true });
      const created = await Audio.Sound.createAsync(
        (audioInfo.requires_auth && accessToken
          ? { uri: sourceUrl, headers: { Authorization: `Bearer ${accessToken}` } }
          : { uri: sourceUrl }) as any,
        { shouldPlay: false, rate: speed, shouldCorrectPitch: true },
        handlePlaybackStatus,
      );
      soundRef.current = created.sound;
      return created.sound;
    } catch (error) {
      setAudioInfo(null);
      setAudioError(meetingAudioUrlErrorMessage(error) ?? '录音加载失败，请稍后重试');
      return null;
    } finally {
      setAudioLoading(false);
    }
  };

  const failPlayback = async (error: unknown) => {
    const sound = soundRef.current;
    soundRef.current = null;
    if (sound) await sound.unloadAsync().catch(() => {});
    setPlaying(false);
    setAudioInfo(null);
    setAudioError(meetingAudioUrlErrorMessage(error) ?? readableErrorMessage(error, '录音播放失败，请重新获取后再试。'));
  };

  const retryAudio = async () => {
    const sound = soundRef.current;
    soundRef.current = null;
    if (sound) await sound.unloadAsync().catch(() => {});
    setPlaying(false);
    setPositionMs(0);
    setAudioError('');
    setAudioReloadKey(value => value + 1);
  };

  const togglePlayback = async () => {
    if (!audioInfo) {
      showDialog({ title: '暂无录音文件', message: '当前会议只有转写内容，没有可播放的录音文件。', tone: 'info' });
      return;
    }
    try {
      const sound = await ensureSound();
      if (!sound) return;
      if (isPlaying) await sound.pauseAsync();
      else if (shouldReplayAudio(positionMs, durationMs)) await sound.replayAsync();
      else await sound.playAsync();
    } catch (error) {
      await failPlayback(error);
    }
  };

  const handleSeek = async (event: GestureResponderEvent) => {
    if (!durationMs || !soundRef.current) return;
    const ratio = Math.min(1, Math.max(0, event.nativeEvent.locationX / Math.max(1, progressWidth)));
    try {
      await soundRef.current.setPositionAsync(Math.round(durationMs * ratio));
    } catch (error) {
      await failPlayback(error);
    }
  };

  const handleAccessibleSeek = async (event: AccessibilityActionEvent) => {
    if (!durationMs || !soundRef.current) return;
    const deltaMs = event.nativeEvent.actionName === 'increment' ? 10_000 : -10_000;
    const nextPositionMs = Math.min(durationMs, Math.max(0, positionMs + deltaMs));
    try {
      await soundRef.current.setPositionAsync(nextPositionMs);
    } catch (error) {
      await failPlayback(error);
    }
  };

  const handleSpeed = async () => {
    const next = speed === 1 ? 1.25 : speed === 1.25 ? 1.5 : 1;
    setSpeed(next);
    if (soundRef.current) {
      try {
        await soundRef.current.setRateAsync(next, true);
      } catch (error) {
        await failPlayback(error);
      }
    }
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

  const runMeetingShare = async (kind: MeetingShareKind) => {
    if (sharing) return;
    setSharing(true);
    try {
      let shareSummary = summaryText || meetingSummaryToText(getCachedSummary(m.id));
      if (!shareSummary && !isGuest && accessToken && ['bundle', 'document'].includes(kind)) {
        shareSummary = await fetchMeetingSummary(m.id, accessToken);
        if (shareSummary) {
          setSummaryText(shareSummary);
          await saveCachedSummary(m.id, {
            meeting_id: m.id,
            full_text: shareSummary,
            generated_at: new Date().toISOString(),
          }).catch(() => {});
        }
      }
      await shareMeetingArtifact(kind, {
        meeting: m,
        transcriptLines: transcriptItems,
        summaryText: shareSummary,
        isGuest,
        accessToken,
        audioInfo,
      });
    } catch (error) {
      showDialog({ title: '分享失败', message: meetingShareErrorMessage(error), tone: 'error' });
    } finally {
      setSharing(false);
    }
  };

  const openShareMenu = () => {
    if (sharing) return;
    const audioAvailable = Boolean(audioInfo || m.audioAvailable || m.audioLocalUri);
    showDialog({
      title: '分享会议文件',
      icon: 'share-outline',
      actions: [
        { text: '完整资料包', role: 'primary', onPress: () => runMeetingShare('bundle') },
        { text: '会议文档', role: 'secondary', onPress: () => runMeetingShare('document') },
        ...(audioAvailable
          ? [{ text: '录音文件', role: 'secondary' as const, onPress: () => runMeetingShare('audio') }]
          : []),
        { text: '取消', role: 'cancel' },
      ],
    });
  };

  const tiles = [
    { label: '转写', icon: 'document-text-outline' as const, bg: '#EEF3FF', color: C.blue,
      onPress: () => navigation.navigate('Transcription', { meetingId: m.id, focus: 'transcript' }) },
    { label: '总结', icon: 'clipboard-outline' as const, bg: '#FFF4E8', color: C.orange,
      onPress: () => navigation.navigate('Transcription', { meetingId: m.id, focus: 'summary' }) },
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
                } catch (error) {
                  if (error instanceof MeetingDeletionCleanupError) {
                    openMeetingsTab(navigation);
                    showDialog({
                      title: '会议已删除，清理未完成',
                      message: error.message,
                      tone: 'warning',
                    });
                  } else {
                    showDialog({
                      title: '删除失败',
                      message: readableErrorMessage(error, '请检查网络后重试。'),
                      tone: 'error',
                    });
                  }
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
        right={sharing
          ? <ActivityIndicator size="small" color={C.purple} />
          : <TouchableOpacity
            onPress={openShareMenu}
            hitSlop={{ top:8,bottom:8,left:8,right:8 }}
            accessible
            accessibilityRole="button"
            accessibilityLabel="分享会议资料"
            testID="recording-share-menu"
          >
            <Ionicons name="share-outline" size={20} color={C.sub} accessible={false} />
          </TouchableOpacity>}
      />
      <ScrollView style={s.scroll} contentContainerStyle={s.content} showsVerticalScrollIndicator={false}>
        {/* Title */}
        <View style={s.titleRow}>
          <Text style={s.title}>{m.title}</Text>
          <TouchableOpacity
            hitSlop={{ top:8,bottom:8,left:8,right:8 }}
            onPress={() => navigation.navigate('Transcription', { meetingId: m.id, focus: 'title' })}
            accessible
            accessibilityRole="button"
            accessibilityLabel="编辑会议标题"
          >
            <Ionicons name="pencil-outline" size={15} color={C.sub} accessible={false} />
          </TouchableOpacity>
        </View>
        <Text style={s.meta}>{[m.date, m.time].filter(Boolean).join('　')}</Text>
        <View style={s.tags}>
          {m.tags.map(t => <Tag key={t.label} label={t.label} color={t.color} />)}
        </View>

        <View style={s.playerCard}>
          <View style={s.waveWrap}>
            {bars.length > 0 ? (
              <Waveform bars={bars} color={audioInfo ? C.purple : C.faint} height={64} splitAt={audioInfo ? Math.floor(bars.length * progress) : undefined} />
            ) : (
              <View style={s.noWaveform}>
                <Ionicons name="pulse-outline" size={18} color={C.faint} />
                <Text style={s.noWaveformText}>暂无可用波形数据</Text>
              </View>
            )}
          </View>
          {audioLoading && !audioInfo ? (
            <View style={s.audioState}>
              <ActivityIndicator size="small" color={C.purple} />
              <Text style={s.audioStateText}>正在获取录音</Text>
            </View>
          ) : audioInfo ? (
            <>
              <View style={s.playerTop}>
                <TouchableOpacity
                  style={s.playBtn}
                  onPress={togglePlayback}
                  activeOpacity={0.86}
                  accessible
                  accessibilityRole="button"
                  accessibilityLabel={isPlaying ? '暂停会议录音' : '播放会议录音'}
                >
                  {audioLoading
                    ? <ActivityIndicator size="small" color="#fff" />
                    : <Ionicons name={isPlaying ? 'pause' : 'play'} size={22} color="#fff" accessible={false} />}
                </TouchableOpacity>
                <TouchableOpacity
                  style={s.speedBtn}
                  onPress={handleSpeed}
                  accessible
                  accessibilityRole="button"
                  accessibilityLabel={`播放速度 ${speed} 倍，点击切换`}
                >
                  <Text style={s.speedText}>{speed}x</Text>
                </TouchableOpacity>
              </View>
              <TouchableOpacity
                style={s.progressTrack}
                onLayout={event => setProgressWidth(event.nativeEvent.layout.width)}
                onPress={handleSeek}
                activeOpacity={0.8}
                accessible
                accessibilityRole="adjustable"
                accessibilityLabel="录音播放进度"
                accessibilityValue={{ min: 0, max: durationMs, now: positionMs, text: `${positionText} / ${audioDurationText}` }}
                accessibilityActions={[
                  { name: 'decrement', label: '后退 10 秒' },
                  { name: 'increment', label: '前进 10 秒' },
                ]}
                onAccessibilityAction={handleAccessibleSeek}
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
                {audioError ? (
                  <TouchableOpacity
                    style={s.audioRetryButton}
                    onPress={retryAudio}
                    accessibilityRole="button"
                    accessibilityLabel="重试获取会议录音"
                    testID="meeting-audio-retry"
                  >
                    <Ionicons name="refresh" size={16} color={C.purple} />
                  </TouchableOpacity>
                ) : null}
              </View>
            </>
          )}
        </View>

        <View style={s.tileGrid}>
          {tiles.map(({ label, icon, bg, color, onPress }) => (
            <TouchableOpacity
              key={label}
              style={[s.tile, { backgroundColor: bg }]}
              onPress={onPress}
              activeOpacity={0.8}
              accessible
              accessibilityRole="button"
              accessibilityLabel={label === '删除' ? '删除会议' : `查看会议${label}`}
            >
              <Ionicons name={icon} size={27} color={color} accessible={false} />
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

    </ScreenContainer>
  );
}

const s = StyleSheet.create({
  container: { flex: 1, backgroundColor: C.appBg },
  scroll: { flex: 1 },
  content: { padding: 20, paddingTop: 22, paddingBottom: BOTTOM_TAB_BAR_GEOMETRY.scrollContentClearance },
  emptyWrap: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24 },
  emptyTitle: { fontSize: 17, fontWeight: '700', color: C.text, marginBottom: 8 },
  emptyText: { fontSize: 13, color: C.sub, lineHeight: 20 },
  titleRow: { flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 6 },
  title: { fontSize: 21, fontWeight: '800', color: C.text, flex: 1 },
  meta: { fontSize: 13, color: C.sub, marginBottom: 10 },
  tags: { flexDirection: 'row', gap: 6, flexWrap: 'wrap', marginBottom: 24 },
  playerCard: { backgroundColor: C.waveformBg, borderRadius: 20, padding: 20, paddingBottom: 18, marginBottom: 22 },
  waveWrap: { marginBottom: 14 },
  noWaveform: { height: 64, borderRadius: 12, backgroundColor: 'rgba(255,255,255,0.5)', alignItems: 'center', justifyContent: 'center', flexDirection: 'row', gap: 7 },
  noWaveformText: { fontSize: 12, color: C.faint, fontWeight: '600' },
  timeLine: { flexDirection: 'row', justifyContent: 'space-between', marginBottom: 14 },
  timeText: { fontSize: 12, color: C.sub },
  playerTop: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 },
  playBtn: { width: 46, height: 46, borderRadius: 23, backgroundColor: C.purple, alignItems: 'center', justifyContent: 'center', shadowColor: C.purple, shadowOffset:{width:0,height:4}, shadowOpacity:0.25, shadowRadius:8, elevation:4 },
  speedBtn: { borderRadius: 15, backgroundColor: C.card, paddingHorizontal: 12, paddingVertical: 7 },
  speedText: { fontSize: 12, color: C.purple, fontWeight: '800' },
  progressTrack: { height: 10, borderRadius: 5, backgroundColor: '#E2DBF4', marginBottom: 10, overflow: 'hidden' },
  progressFill: { height: '100%', borderRadius: 5, backgroundColor: C.purple },
  audioState: { minHeight: 32, borderRadius: 16, backgroundColor: 'rgba(255,255,255,0.62)', flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 7, marginBottom: 14, paddingHorizontal: 12 },
  audioStateText: { flex: 1, fontSize: 12, color: C.sub, fontWeight: '600' },
  audioRetryButton: { width: 32, height: 32, alignItems: 'center', justifyContent: 'center' },
  tileGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 12 },
  tile: { flex: 1, minWidth: 86, height: 88, borderRadius: 16, alignItems: 'center', justifyContent: 'center', gap: 7 },
  tileLabel: { fontSize: 14, fontWeight: '600', color: C.text },
});
