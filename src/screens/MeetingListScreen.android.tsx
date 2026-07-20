import React, { useEffect, useMemo, useState } from 'react';
import { StyleSheet } from 'react-native';
import { useIsFocused } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import {
  LaojiMinutesView,
  MINUTES_SNAPSHOT_SCHEMA_VERSION,
  type MinutesSemanticAction,
  type MinutesViewSnapshot,
  type NativeTabPressEvent,
  getNativeRecorderState,
  hasNativeRecorder,
  recoverNativeRecordings,
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
  const isFocused = useIsFocused();
  const [searching, setSearching] = useState(false);
  const [query, setQuery] = useState('');
  const [appMenuVisible, setAppMenuVisible] = useState(false);
  const [staleRecordingIds, setStaleRecordingIds] = useState<ReadonlySet<string>>(new Set());

  // A cached/local resumable row is not enough to describe the native session.
  // Reconcile active, finalized-local, and interrupted states on the visible
  // list so neither a live recording nor a saved WAV is presented as failed.
  useEffect(() => {
    // The list remains mounted underneath the recording page. Checking before
    // that page finishes starting AudioRecord races the native session and can
    // persist a live recording as failed. Reconcile only while the list itself
    // is visible, then require the inactive result to remain stable.
    if (!isFocused || !hasNativeRecorder()) return;
    const candidates = meetings.filter(canResumeMeetingRecording);
    if (candidates.length === 0) {
      setStaleRecordingIds(current => current.size === 0 ? current : new Set());
      return;
    }
    let cancelled = false;
    const candidateStatusById = new Map(candidates.map(meeting => [meeting.id, meeting.status]));
    void Promise.all(candidates.map(async meeting => {
      try {
        for (let attempt = 0; attempt < 2; attempt += 1) {
          const snapshot = await getNativeRecorderState(meeting.id);
          if (snapshot && ACTIVE_RECORDER_STATES.has(snapshot.state)) {
            return { meetingId: meeting.id, kind: 'active' as const };
          }
          if (snapshot?.localUri) {
            return {
              meetingId: meeting.id,
              kind: 'recovered' as const,
              localUri: snapshot.localUri,
              durationMs: snapshot.durationMs,
            };
          }
          if (attempt === 0) await new Promise(resolve => setTimeout(resolve, 600));
          if (cancelled) return { meetingId: meeting.id, kind: 'unknown' as const };
        }
        return { meetingId: meeting.id, kind: 'inactive' as const };
      } catch {
        // An unavailable/temporarily disconnected native bridge is not proof
        // that the server-side recording is stale.
        return { meetingId: meeting.id, kind: 'unknown' as const };
      }
    })).then(async resolutions => {
      if (cancelled) return;
      const inactiveIds = resolutions
        .filter(result => result.kind === 'inactive')
        .map(result => result.meetingId);
      const recovery = inactiveIds.length > 0
        ? await recoverNativeRecordings().catch(() => null)
        : null;
      if (cancelled) return;
      const recoveredById = new Map(
        recovery?.recordings
          .filter(item => item.purpose === 'meeting' && inactiveIds.includes(item.sessionId))
          .map(item => [item.sessionId, item]) ?? [],
      );
      const recovered = [
        ...resolutions
          .filter(result => result.kind === 'recovered')
          .map(result => ({
            sessionId: result.meetingId,
            localUri: result.localUri,
            durationMs: result.durationMs,
          })),
        ...recoveredById.values(),
      ];
      const recoveredIds = new Set(recovered.map(item => item.sessionId));
      const staleIds = inactiveIds.filter(id => (
        !recoveredIds.has(id) && candidateStatusById.get(id) === 'recording'
      ));
      const activeIdsToRepair = resolutions
        .filter(result => (
          result.kind === 'active' && candidateStatusById.get(result.meetingId) !== 'recording'
        ))
        .map(result => result.meetingId);
      setStaleRecordingIds(new Set(staleIds));
      for (const id of activeIdsToRepair) {
        await updateMeetingStatus(id, 'recording').catch(() => false);
      }
      for (const item of recovered) {
        const durationSec = item.durationMs > 0 ? item.durationMs / 1000 : undefined;
        await updateMeetingStatus(item.sessionId, 'ended', {
          audioAvailable: true,
          audioLocalUri: item.localUri,
          ...(durationSec ? {
            audioDurationSec: durationSec,
            duration: formatDuration(durationSec),
          } : {}),
        }).catch(() => false);
      }
      for (const id of staleIds) {
        await updateMeetingStatus(id, 'failed').catch(() => false);
      }
    });
    return () => { cancelled = true; };
  }, [isFocused, meetings, updateMeetingStatus]);

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
    </>
  );
}

const styles = StyleSheet.create({
  surface: { flex: 1 },
});
