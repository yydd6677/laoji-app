import React, { useEffect, useRef, useState } from 'react';
import {
  AccessibilityActionEvent,
  ActivityIndicator,
  GestureResponderEvent,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import {
  AudioPlayer,
  AudioStatus,
  createAudioPlayer,
  setAudioModeAsync,
} from 'expo-audio';
import { Colors as C } from '../theme/colors';
import { Meeting } from '../types';
import { ApiMeetingAudioInfo, fetchMeetingAudioInfo } from '../services/api';
import { useAppDialog } from './AppDialog';
import { meetingAudioUrlErrorMessage, validateMeetingAudioUrl } from '../services/meetingAudioSecurity';
import { readableErrorMessage } from '../services/errors';
import {
  formatDuration,
  nextMeetingPlaybackRate,
  shouldReplayAudio,
} from '../utils/meetingMedia';

export const MEETING_AUDIO_PLAYER_GEOMETRY = Object.freeze({
  seekSectionHeight: 44,
  controlRowHeight: 56,
  horizontalInset: 20,
  playButtonWidth: 80,
  playButtonHeight: 48,
  sideControlWidth: 40,
});

type Props = {
  meeting: Meeting;
  accessToken: string | null;
  isGuest: boolean;
  fallbackDurationSec?: number;
};

function localAudioInfo(uri: string | null | undefined): ApiMeetingAudioInfo | null {
  return uri
    ? { url: uri, mime_type: 'audio/wav', file_name: uri.split('/').pop() ?? 'meeting.wav' }
    : null;
}

function durationLabel(seconds: number): string {
  const label = formatDuration(seconds);
  return label === '—' ? '00:00' : label;
}

export function MeetingAudioPlayerDock({
  meeting,
  accessToken,
  isGuest,
  fallbackDurationSec = 0,
}: Props) {
  const { showDialog } = useAppDialog();
  const [audioInfo, setAudioInfo] = useState<ApiMeetingAudioInfo | null>(null);
  const [audioLoading, setAudioLoading] = useState(false);
  const [audioError, setAudioError] = useState('');
  const [reloadKey, setReloadKey] = useState(0);
  const [isPlaying, setPlaying] = useState(false);
  const [positionMs, setPositionMs] = useState(0);
  const [durationMs, setDurationMs] = useState(0);
  const [speed, setSpeed] = useState(1);
  const [trackWidth, setTrackWidth] = useState(1);
  const playerRef = useRef<AudioPlayer | null>(null);
  const statusSubscriptionRef = useRef<{ remove(): void } | null>(null);

  const disposePlayer = () => {
    statusSubscriptionRef.current?.remove();
    statusSubscriptionRef.current = null;
    const player = playerRef.current;
    playerRef.current = null;
    player?.remove();
  };

  useEffect(() => {
    let alive = true;
    const fallbackAudio = localAudioInfo(meeting.audioLocalUri);
    const knownDurationSec = meeting.audioDurationSec ?? fallbackDurationSec;

    disposePlayer();
    setPlaying(false);
    setPositionMs(0);
    setDurationMs(knownDurationSec > 0 ? Math.round(knownDurationSec * 1000) : 0);
    setAudioInfo(null);
    setAudioError('');
    setAudioLoading(true);

    if (isGuest || !accessToken) {
      setAudioInfo(fallbackAudio);
      setAudioLoading(false);
      return () => { alive = false; };
    }

    fetchMeetingAudioInfo(meeting.id, accessToken)
      .then(info => {
        if (!alive) return;
        const next = info ?? fallbackAudio;
        setAudioInfo(next);
        const durationSec = next?.duration_sec ?? knownDurationSec;
        if (durationSec > 0) setDurationMs(Math.round(durationSec * 1000));
      })
      .catch(error => {
        if (!alive) return;
        setAudioInfo(fallbackAudio);
        setAudioError(fallbackAudio ? '' : meetingAudioUrlErrorMessage(error) ?? '录音服务暂时不可用');
      })
      .finally(() => {
        if (alive) setAudioLoading(false);
      });

    return () => { alive = false; };
  }, [accessToken, fallbackDurationSec, isGuest, meeting.audioDurationSec, meeting.audioLocalUri, meeting.id, reloadKey]);

  useEffect(() => () => {
    disposePlayer();
  }, []);

  const handlePlaybackStatus = (status: AudioStatus) => {
    if (!status.isLoaded) {
      setPlaying(false);
      return;
    }
    setPlaying(status.playing);
    setPositionMs(Math.round(status.currentTime * 1000));
    if (status.duration > 0) setDurationMs(Math.round(status.duration * 1000));
  };

  const ensurePlayer = async (): Promise<AudioPlayer | null> => {
    if (!audioInfo) return null;
    if (playerRef.current) return playerRef.current;
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
      await setAudioModeAsync({ playsInSilentMode: true });
      const created = createAudioPlayer(
        audioInfo.requires_auth && accessToken
          ? { uri: sourceUrl, headers: { Authorization: `Bearer ${accessToken}` } }
          : { uri: sourceUrl },
        { updateInterval: 200 },
      );
      created.setPlaybackRate(speed);
      statusSubscriptionRef.current = created.addListener('playbackStatusUpdate', handlePlaybackStatus);
      playerRef.current = created;
      return created;
    } catch (error) {
      setAudioInfo(null);
      setAudioError(meetingAudioUrlErrorMessage(error) ?? '录音加载失败，请稍后重试');
      return null;
    } finally {
      setAudioLoading(false);
    }
  };

  const failPlayback = async (error: unknown) => {
    disposePlayer();
    setPlaying(false);
    setAudioInfo(null);
    setAudioError(meetingAudioUrlErrorMessage(error)
      ?? readableErrorMessage(error, '录音播放失败，请重新获取后再试。'));
  };

  const retryAudio = async () => {
    disposePlayer();
    setPlaying(false);
    setPositionMs(0);
    setAudioError('');
    setReloadKey(value => value + 1);
  };

  const togglePlayback = async () => {
    if (!audioInfo) {
      showDialog({
        title: '暂无录音文件',
        message: '当前会议只有转写内容，没有可播放的录音文件。',
        tone: 'info',
      });
      return;
    }
    try {
      const player = await ensurePlayer();
      if (!player) return;
      if (isPlaying) player.pause();
      else {
        if (shouldReplayAudio(positionMs, durationMs)) await player.seekTo(0);
        player.play();
      }
    } catch (error) {
      await failPlayback(error);
    }
  };

  const seekTo = async (nextPositionMs: number) => {
    if (!durationMs || !audioInfo) return;
    try {
      const player = await ensurePlayer();
      if (!player) return;
      const clampedPosition = Math.min(durationMs, Math.max(0, nextPositionMs));
      await player.seekTo(clampedPosition / 1000);
      setPositionMs(clampedPosition);
    } catch (error) {
      await failPlayback(error);
    }
  };

  const handleSeek = (event: GestureResponderEvent) => {
    const ratio = Math.min(1, Math.max(0, event.nativeEvent.locationX / Math.max(1, trackWidth)));
    void seekTo(Math.round(durationMs * ratio));
  };

  const handleAccessibleSeek = (event: AccessibilityActionEvent) => {
    const deltaMs = event.nativeEvent.actionName === 'increment' ? 15_000 : -15_000;
    void seekTo(positionMs + deltaMs);
  };

  const handleSpeed = async () => {
    const next = nextMeetingPlaybackRate(speed);
    setSpeed(next);
    if (!playerRef.current) return;
    try {
      playerRef.current.setPlaybackRate(next);
    } catch (error) {
      await failPlayback(error);
    }
  };

  const progress = durationMs > 0 ? Math.min(1, Math.max(0, positionMs / durationMs)) : 0;
  const positionText = durationLabel(Math.round(positionMs / 1000));
  const totalDurationSec = Math.round((durationMs || fallbackDurationSec * 1000) / 1000);
  const totalDurationText = durationLabel(totalDurationSec);
  const progressPixels = trackWidth * progress;

  return (
    <View testID="meeting-audio-player-dock" style={s.playerDock}>
      <View style={s.seekSection}>
        <View style={s.timeRow}>
          <Text style={s.timeText}>{positionText}</Text>
          <Text style={s.timeText}>{totalDurationText}</Text>
        </View>
        <TouchableOpacity
          style={s.trackTouch}
          onLayout={event => setTrackWidth(event.nativeEvent.layout.width)}
          onPress={handleSeek}
          activeOpacity={0.8}
          disabled={!audioInfo}
          accessible
          accessibilityRole="adjustable"
          accessibilityLabel="录音播放进度"
          accessibilityValue={{
            min: 0,
            max: Math.max(1, durationMs),
            now: positionMs,
            text: `${positionText} / ${totalDurationText}`,
          }}
          accessibilityActions={[
            { name: 'decrement', label: '后退 15 秒' },
            { name: 'increment', label: '前进 15 秒' },
          ]}
          onAccessibilityAction={handleAccessibleSeek}
        >
          <View style={s.track}>
            <View style={[s.trackProgress, { width: progressPixels }]} />
            {audioInfo ? <View style={[s.trackThumb, { left: Math.max(0, progressPixels - 7) }]} /> : null}
          </View>
        </TouchableOpacity>
      </View>

      {audioLoading && !audioInfo ? (
        <View style={s.audioState}>
          <ActivityIndicator size="small" color={C.primary} />
          <Text style={s.audioStateText}>正在获取录音</Text>
        </View>
      ) : audioInfo ? (
        <View style={s.playerControls}>
          <TouchableOpacity
            style={s.sideControl}
            onPress={handleSpeed}
            accessibilityRole="button"
            accessibilityLabel={`播放速度 ${speed} 倍，点击切换`}
          >
            <Text style={s.speedText}>{speed}x</Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={s.sideControl}
            onPress={() => void seekTo(positionMs - 15_000)}
            accessibilityRole="button"
            accessibilityLabel="后退 15 秒"
          >
            <Ionicons name="play-back-outline" size={22} color={C.text} />
          </TouchableOpacity>
          <TouchableOpacity
            style={s.playButton}
            onPress={togglePlayback}
            activeOpacity={0.8}
            accessibilityRole="button"
            accessibilityLabel={isPlaying ? '暂停会议录音' : '播放会议录音'}
          >
            <Ionicons name={isPlaying ? 'pause' : 'play'} size={24} color="#FFFFFF" />
          </TouchableOpacity>
          <TouchableOpacity
            style={s.sideControl}
            onPress={() => void seekTo(positionMs + 15_000)}
            accessibilityRole="button"
            accessibilityLabel="前进 15 秒"
          >
            <Ionicons name="play-forward-outline" size={22} color={C.text} />
          </TouchableOpacity>
          <View style={s.sideControl} />
        </View>
      ) : (
        <View style={s.audioState}>
          <Ionicons name="information-circle-outline" size={16} color={C.sub} />
          <Text style={s.audioStateText}>{audioError || '仅有转写，无录音文件'}</Text>
          {audioError ? (
            <TouchableOpacity
              style={s.retryButton}
              onPress={retryAudio}
              accessibilityRole="button"
              accessibilityLabel="重试获取会议录音"
              testID="meeting-audio-retry"
            >
              <Ionicons name="refresh" size={17} color={C.primary} />
            </TouchableOpacity>
          ) : null}
        </View>
      )}
    </View>
  );
}

const s = StyleSheet.create({
  playerDock: {
    backgroundColor: C.body,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: C.border,
  },
  seekSection: {
    height: MEETING_AUDIO_PLAYER_GEOMETRY.seekSectionHeight,
    paddingHorizontal: MEETING_AUDIO_PLAYER_GEOMETRY.horizontalInset,
    paddingTop: 4,
  },
  timeRow: { height: 16, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  timeText: { fontSize: 11, lineHeight: 16, color: C.sub, fontVariant: ['tabular-nums'] },
  trackTouch: { height: 24, justifyContent: 'center' },
  track: { height: 2, borderRadius: 1, backgroundColor: C.border },
  trackProgress: { position: 'absolute', left: 0, top: 0, bottom: 0, borderRadius: 1, backgroundColor: C.primary },
  trackThumb: {
    position: 'absolute',
    top: -7,
    width: 16,
    height: 16,
    borderRadius: 8,
    backgroundColor: C.body,
    borderWidth: 4,
    borderColor: C.primary,
  },
  playerControls: {
    height: MEETING_AUDIO_PLAYER_GEOMETRY.controlRowHeight,
    paddingHorizontal: MEETING_AUDIO_PLAYER_GEOMETRY.horizontalInset,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  sideControl: {
    width: MEETING_AUDIO_PLAYER_GEOMETRY.sideControlWidth,
    height: 48,
    alignItems: 'center',
    justifyContent: 'center',
  },
  playButton: {
    width: MEETING_AUDIO_PLAYER_GEOMETRY.playButtonWidth,
    height: MEETING_AUDIO_PLAYER_GEOMETRY.playButtonHeight,
    borderRadius: 6,
    backgroundColor: C.primary,
    alignItems: 'center',
    justifyContent: 'center',
  },
  speedText: { fontSize: 14, lineHeight: 20, color: C.text, fontWeight: '500' },
  audioState: {
    height: MEETING_AUDIO_PLAYER_GEOMETRY.controlRowHeight,
    paddingHorizontal: MEETING_AUDIO_PLAYER_GEOMETRY.horizontalInset,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
  },
  audioStateText: { flex: 1, fontSize: 14, lineHeight: 20, color: C.sub, textAlign: 'center' },
  retryButton: { width: 40, height: 48, alignItems: 'center', justifyContent: 'center' },
});
