import React, { useEffect, useMemo, useState } from 'react';
import { StyleSheet } from 'react-native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import {
  LaojiMinutesView,
  MINUTES_SNAPSHOT_SCHEMA_VERSION,
  type MinutesSemanticAction,
  type MinutesViewSnapshot,
  type NativeTabPressEvent,
  getNativeRecorderState,
  hasNativeRecorder,
} from 'laoji-native-platform';
import { AppActionSheet, type AppActionSheetItem } from '../components/AppActionSheet';
import { useAppDialog } from '../components/AppDialog';
import { MeetingDeletionCleanupError, useMeetings } from '../store/MeetingsStore';
import type { MeetingSummary, RootStackParamList, TranscriptLine } from '../types';
import { readableErrorMessage } from '../services/errors';
import { meetingSummaryToText } from '../services/meetingSummary';
import { canResumeMeetingRecording, formatDuration, preferredMeetingStatusLabel } from '../utils/meetingMedia';

type MeetingListNavigationProp = NativeStackNavigationProp<RootStackParamList>;

type Props = {
  navigation: MeetingListNavigationProp;
  onTabPress: (event: { nativeEvent: NativeTabPressEvent }) => void;
  // UI-SHELL-BOTTOM-MAIN-001: destination-change motion for the active native root.
  bottomBarSelectionCommand: number;
};

function statusTone(label: string): 'neutral' | 'primary' | 'success' | 'warning' | 'danger' {
  if (label.includes('失败') || label.includes('中断') || label.includes('受阻')) return 'danger';
  if (label.includes('处理中') || label.includes('待')) return 'warning';
  if (label.includes('完成')) return 'success';
  if (label.includes('录音')) return 'primary';
  return 'neutral';
}

const ACTIVE_RECORDER_STATES = new Set(['preparing', 'recording', 'paused', 'stopping']);

function cleanCoverText(value: string): string {
  return value
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/!\[([^\]]*)\]\([^)]+\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/^\s{0,3}(?:#{1,6}|[-*+]|\d+[.)]|>)\s*/gm, '')
    .replace(/[*_~`]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Feishu's Android client consumes server-selected text_cover_type/text_cover.
 * LaoJi has no equivalent home-list field, so this is an explicit local inference:
 * a usable summary wins; otherwise use a named dominant speaker and one representative line.
 */
function inferredMeetingCover(summary: MeetingSummary | null, transcript: readonly TranscriptLine[]) {
  const summaryText = [summary?.overview, summary?.full_text, meetingSummaryToText(summary)]
    .map(value => cleanCoverText(value ?? ''))
    .find(value => value.length >= 8) ?? '';
  if (summaryText.length >= 8) {
    return {
      coverType: 'summary' as const,
      coverTitle: '会议总结',
      coverText: summaryText.slice(0, 220),
    };
  }

  const groups = new Map<string, { label: string; lines: string[]; score: number }>();
  transcript.forEach(line => {
    const text = cleanCoverText(line.text);
    if (text.length < 4) return;
    const speakerId = line.speaker_id?.trim();
    const speakerLabel = line.speaker_label?.trim();
    const namedLabel = speakerLabel && !['发言人', '未知发言人', '未知'].includes(speakerLabel)
      ? speakerLabel
      : '';
    const identity = speakerId && speakerId !== 'unknown' ? speakerId : namedLabel;
    if (!identity || !namedLabel) return;
    const duration = Math.max(0, (line.end_time ?? 0) - (line.start_time ?? 0));
    const previous = groups.get(identity) ?? { label: namedLabel, lines: [], score: 0 };
    previous.lines.push(text);
    previous.score += text.length + Math.min(duration, 120) * 2;
    groups.set(identity, previous);
  });
  const dominant = [...groups.values()].sort((left, right) => right.score - left.score)[0];
  const representative = dominant?.lines
    .slice()
    .sort((left, right) => Math.min(right.length, 120) - Math.min(left.length, 120))[0];
  if (dominant && representative) {
    return {
      coverType: 'speakerSummary' as const,
      coverTitle: dominant.label,
      coverText: representative.slice(0, 180),
    };
  }
  return { coverType: 'default' as const };
}

function compactMeetingDateTime(date: string, time?: string): string {
  const currentYearPrefix = `${new Date().getFullYear()}年`;
  const compactDate = date.startsWith(currentYearPrefix) ? date.slice(currentYearPrefix.length) : date;
  return [compactDate, time].filter(Boolean).join(' ');
}

/** MIN-ROOT-001 / MIN-SEARCH-001: Android renders the Minutes native list surface. */
export function MeetingListScreen({ navigation, onTabPress, bottomBarSelectionCommand }: Props) {
  const {
    meetings,
    loading,
    error,
    deleteMeeting,
    refreshMeetings,
    updateMeetingStatus,
    getCachedTranscript,
    getCachedSummary,
  } = useMeetings();
  const { showDialog } = useAppDialog();
  const [searching, setSearching] = useState(false);
  const [query, setQuery] = useState('');
  const [appMenuVisible, setAppMenuVisible] = useState(false);
  const [meetingMenuId, setMeetingMenuId] = useState<string | null>(null);
  const [staleRecordingIds, setStaleRecordingIds] = useState<ReadonlySet<string>>(new Set());
  const menuMeeting = meetings.find(meeting => meeting.id === meetingMenuId);

  // A cached/local row marked `recording` is not enough to claim that this
  // Android process still owns an AudioRecord session. Resolve that ambiguity
  // on the list surface so an interrupted recording is not presented as live
  // until the user opens it.
  useEffect(() => {
    if (!hasNativeRecorder()) return;
    const candidates = meetings.filter(meeting =>
      meeting.status === 'recording'
      && !meeting.audioAvailable
      && !meeting.audioLocalUri,
    );
    if (candidates.length === 0) {
      setStaleRecordingIds(current => current.size === 0 ? current : new Set());
      return;
    }
    let cancelled = false;
    void Promise.all(candidates.map(async meeting => {
      try {
        const snapshot = await getNativeRecorderState(meeting.id);
        return snapshot && ACTIVE_RECORDER_STATES.has(snapshot.state) ? null : meeting.id;
      } catch {
        // An unavailable/temporarily disconnected native bridge is not proof
        // that the server-side recording is stale.
        return null;
      }
    })).then(async ids => {
      if (cancelled) return;
      const staleIds = ids.filter((id): id is string => Boolean(id));
      setStaleRecordingIds(new Set(staleIds));
      await Promise.all(staleIds.map(id => updateMeetingStatus(id, 'failed').catch(() => false)));
    });
    return () => { cancelled = true; };
  }, [meetings, updateMeetingStatus]);

  const snapshot = useMemo<MinutesViewSnapshot>(() => ({
    schemaVersion: MINUTES_SNAPSHOT_SCHEMA_VERSION,
    surface: 'list',
    list: {
      title: '会议记录',
      searching,
      query,
      phase: loading && meetings.length === 0
        ? 'loading'
        : error ? 'error' : meetings.length === 0 ? 'empty' : 'ready',
      message: error
        ? readableErrorMessage(error, '会议记录暂时无法加载，请稍后重试。')
        : '',
      showingCachedData: Boolean(error && meetings.length > 0),
      meetings: meetings.map(meeting => {
        const statusLabel = staleRecordingIds.has(meeting.id)
          ? '录音中断'
          : preferredMeetingStatusLabel(meeting.tags);
        const cover = inferredMeetingCover(
          getCachedSummary(meeting.id),
          getCachedTranscript(meeting.id),
        );
        return {
          id: meeting.id,
          title: meeting.title,
          dateTimeLabel: compactMeetingDateTime(meeting.date, meeting.time),
          durationLabel: meeting.audioDurationSec
            ? formatDuration(meeting.audioDurationSec)
            : meeting.duration,
          statusLabel,
          statusTone: statusTone(statusLabel),
          canResume: canResumeMeetingRecording(meeting),
          ...cover,
        };
      }),
    },
  }), [error, getCachedSummary, getCachedTranscript, loading, meetings, query, searching, staleRecordingIds]);

  const confirmDelete = (id: string) => {
    showDialog({
      title: '删除会议',
      message: '确定删除此会议记录？',
      tone: 'danger',
      actions: [
        {
          text: '删除',
          role: 'destructive',
          onPress: async () => {
            try {
              await deleteMeeting(id);
            } catch (deleteError) {
              showDialog({
                title: deleteError instanceof MeetingDeletionCleanupError
                  ? '会议已删除，清理未完成'
                  : '删除失败',
                message: readableErrorMessage(
                  deleteError,
                  deleteError instanceof MeetingDeletionCleanupError
                    ? '会议已删除，但本机清理尚未完成。'
                    : '删除失败，请稍后重试。',
                ),
                tone: deleteError instanceof MeetingDeletionCleanupError ? 'warning' : 'error',
              });
            }
          },
        },
        { text: '取消', role: 'cancel' },
      ],
    });
  };

  const handleAction = (action: MinutesSemanticAction) => {
    switch (action.type) {
      case 'openMeeting':
        navigation.navigate('Transcription', { meetingId: action.meetingId });
        break;
      case 'openRecording':
        navigation.navigate('MeetingLive', { meetingId: action.meetingId });
        break;
      case 'openMeetingMenu':
        setMeetingMenuId(action.meetingId);
        break;
      case 'renameMeeting':
        navigation.navigate('Transcription', { meetingId: action.meetingId, focus: 'title' });
        break;
      case 'deleteMeeting':
        confirmDelete(action.meetingId);
        break;
      case 'startRecording':
        {
          const resumable = meetings.find(canResumeMeetingRecording);
          if (resumable) navigation.navigate('MeetingLive', { meetingId: resumable.id });
          else navigation.navigate('MeetingLive');
        }
        break;
      case 'search':
      case 'beginSearch':
        setSearching(true);
        break;
      case 'endSearch':
        setSearching(false);
        setQuery('');
        break;
      case 'updateSearchQuery':
        setQuery(action.query);
        break;
      case 'refreshMeetings':
        void refreshMeetings();
        break;
      case 'more':
        setAppMenuVisible(true);
        break;
      default:
        break;
    }
  };

  const appMenuItems: AppActionSheetItem[] = [
    { key: 'speakers', label: '管理讲话人', onPress: () => navigation.navigate('SpeakerManager') },
    { key: 'profile', label: '个人资料', onPress: () => navigation.navigate('Profile') },
  ];
  const meetingMenuItems: AppActionSheetItem[] = menuMeeting ? [
    ...(canResumeMeetingRecording(menuMeeting) ? [{
      key: 'resume',
      label: '继续录音',
      onPress: () => navigation.navigate('MeetingLive', { meetingId: menuMeeting.id }),
    }] : []),
    {
      key: 'rename',
      label: '重命名',
      onPress: () => navigation.navigate('Transcription', { meetingId: menuMeeting.id, focus: 'title' }),
    },
    { key: 'delete', label: '删除', destructive: true, onPress: () => confirmDelete(menuMeeting.id) },
  ] : [];

  return (
    <>
      <LaojiMinutesView
        style={styles.surface}
        surface="list"
        snapshot={snapshot}
        bottomBarSelectionCommand={bottomBarSelectionCommand}
        onMinutesAction={event => handleAction(event.nativeEvent)}
        onTabPress={onTabPress}
        testID="meeting-native-list"
      />
      <AppActionSheet
        visible={appMenuVisible}
        title="会议记录"
        items={appMenuItems}
        onClose={() => setAppMenuVisible(false)}
      />
      <AppActionSheet
        visible={Boolean(menuMeeting)}
        title={menuMeeting?.title ?? ''}
        items={meetingMenuItems}
        onClose={() => setMeetingMenuId(null)}
      />
    </>
  );
}

const styles = StyleSheet.create({
  surface: { flex: 1 },
});
