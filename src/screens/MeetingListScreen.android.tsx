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
import { useAppDialog } from '../components/AppDialog';
import { MeetingDeletionCleanupError, useMeetings } from '../store/MeetingsStore';
import type { Meeting, MeetingSummary, RootStackParamList, TranscriptLine } from '../types';
import { readableErrorMessage } from '../services/errors';
import { meetingDeletionPresentation } from '../services/meetingDeletionPresentation';
import { briefGreetingSummaryText, meetingSummaryToText } from '../services/meetingSummary';
import { canResumeMeetingRecording, formatDuration } from '../utils/meetingMedia';
import { speakerDisplayLabel } from '../utils/speakerLabels';
import { displayMeetingTitle } from '../utils/meetingTitle';
import { useMeetingMediaImport } from '../components/MeetingMediaImportProvider';
import { deriveLegacyMeetingPresentationState } from '../services/meetingPresentation';

type MeetingListNavigationProp = NativeStackNavigationProp<RootStackParamList>;

type Props = {
  navigation: MeetingListNavigationProp;
  onTabPress: (event: { nativeEvent: NativeTabPressEvent }) => void;
  // UI-SHELL-BOTTOM-MAIN-001: destination-change motion for the active native root.
  bottomBarSelectionCommand: number;
};

const ACTIVE_RECORDER_STATES = new Set(['preparing', 'recording', 'paused', 'stopping']);

function meetingListPresentation(meeting: Meeting, captureInterrupted: boolean) {
  const presentation = deriveLegacyMeetingPresentationState(meeting, captureInterrupted
    ? { captureOverride: 'failed_recoverable' }
    : undefined);
  const hasRootSyncPending = Boolean(meeting.statusSyncPending)
    || meeting.tags.some(tag => tag.label === '待同步');
  if (
    hasRootSyncPending
    && (presentation.key === 'ready' || presentation.key === 'not_started')
  ) {
    return { label: '待同步', tone: 'warning' as const };
  }
  const imported = meeting.tags.some(tag => tag.label === '已导入');
  if (imported && (presentation.key === 'ready' || presentation.key === 'not_started')) {
    return { label: '已导入', tone: 'primary' as const };
  }
  return presentation;
}

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
  const summaryText = [
    meetingSummaryToText(summary),
    briefGreetingSummaryText(transcript),
  ]
    .map(value => cleanCoverText(value ?? ''))
    .find(value => value.length >= 8) ?? '';
  if (summaryText.length >= 8) {
    return {
      coverType: 'summary' as const,
      coverTitle: '总结',
      coverText: summaryText.slice(0, 220),
    };
  }

  const groups = new Map<string, { label: string; lines: string[]; score: number }>();
  transcript.forEach(line => {
    const text = cleanCoverText(line.text);
    if (text.length < 4) return;
    const speakerId = line.speaker_id?.trim();
    const speakerLabel = line.speaker_label?.trim();
    const displayLabel = speakerDisplayLabel(speakerLabel, speakerId);
    const namedLabel = !['发言人', '讲话人', '说话人', '未知发言人', '未知讲话人', '未知说话人', '未知'].includes(displayLabel)
      ? displayLabel
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
  const match = date.trim().match(/^(?:(\d{4})年)?(\d{1,2})月(\d{1,2})日$/);
  let compactDate = date;
  if (match) {
    const now = new Date();
    const year = match[1] ? Number(match[1]) : now.getFullYear();
    const month = Number(match[2]);
    const day = Number(match[3]);
    const parsed = new Date(year, month - 1, day);
    const isValid = parsed.getFullYear() === year
      && parsed.getMonth() === month - 1
      && parsed.getDate() === day;
    if (isValid) {
      const localDayNumber = (value: Date) => Date.UTC(
        value.getFullYear(),
        value.getMonth(),
        value.getDate(),
      ) / 86_400_000;
      const dayOffset = localDayNumber(parsed) - localDayNumber(now);
      compactDate = dayOffset === 0
        ? '今天'
        : dayOffset === -1
          ? '昨天'
          : `${year === now.getFullYear() ? '' : `${year}年`}${month}月${day}日`;
    }
  }
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
  const { busy: mediaImporting, selectMeetingMedia } = useMeetingMediaImport();
  const isFocused = useIsFocused();
  const [searching, setSearching] = useState(false);
  const [query, setQuery] = useState('');
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
      mediaImporting,
      phase: loading && meetings.length === 0
        ? 'loading'
        : error ? 'error' : meetings.length === 0 ? 'empty' : 'ready',
      message: error
        ? readableErrorMessage(error, '会议记录暂时无法加载，请稍后重试。')
        : '',
      showingCachedData: Boolean(error && meetings.length > 0),
      meetings: meetings.map(meeting => {
        const presentation = meetingListPresentation(
          meeting,
          staleRecordingIds.has(meeting.id),
        );
        const statusLabel = presentation.label === '已完成' ? '' : presentation.label;
        const cover = inferredMeetingCover(
          getCachedSummary(meeting.id),
          getCachedTranscript(meeting.id),
        );
        return {
          id: meeting.id,
          title: displayMeetingTitle(meeting.title),
          dateTimeLabel: compactMeetingDateTime(meeting.date, meeting.time),
          durationLabel: meeting.audioDurationSec
            ? formatDuration(meeting.audioDurationSec)
            : meeting.duration,
          statusLabel,
          statusTone: presentation.tone,
          canResume: canResumeMeetingRecording(meeting),
          ...cover,
        };
      }),
    },
  }), [error, getCachedSummary, getCachedTranscript, loading, mediaImporting, meetings, query, searching, staleRecordingIds]);

  const confirmDelete = (id: string) => {
    const target = meetings.find(meeting => meeting.id === id);
    if (!target) return;
    const presentation = meetingDeletionPresentation(target);
    if (presentation.blocked) {
      showDialog({
        title: presentation.title,
        message: presentation.message,
        tone: 'warning',
      });
      return;
    }
    showDialog({
      title: presentation.title,
      message: presentation.message,
      tone: 'danger',
      actions: [
        {
          text: presentation.confirmText,
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
      case 'importMedia':
        void selectMeetingMedia();
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
        // The native title bar owns its source-matched anchored menu.
        break;
      case 'openSpeakers':
        navigation.navigate('SpeakerManager');
        break;
      case 'openProfile':
        navigation.navigate('Profile');
        break;
      default:
        break;
    }
  };

  return (
    <LaojiMinutesView
      style={styles.surface}
      surface="list"
      snapshot={snapshot}
      bottomBarSelectionCommand={bottomBarSelectionCommand}
      onMinutesAction={event => handleAction(event.nativeEvent)}
      onTabPress={onTabPress}
      testID="meeting-native-list"
    />
  );
}

const styles = StyleSheet.create({
  surface: { flex: 1 },
});
