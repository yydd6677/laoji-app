import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { BackHandler, StyleSheet } from 'react-native';
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
import { resolveMeetingDeletionPresentation } from '../services/meetingDeletionPresentation';
import { briefGreetingSummaryText, meetingSummaryToText } from '../services/meetingSummary';
import { canResumeMeetingRecording, formatDuration } from '../utils/meetingMedia';
import { speakerDisplayLabel } from '../utils/speakerLabels';
import { displayMeetingTitle } from '../utils/meetingTitle';
import { useMeetingMediaImport } from '../components/MeetingMediaImportProvider';
import { deriveLegacyMeetingPresentationState } from '../services/meetingPresentation';
import { useMeetingRecycleCapability } from '../hooks/useMeetingRecycleCapability';
import { useAuth } from '../store/AuthStore';
import {
  getMeetingTagCatalogSyncConflict,
  resolveMeetingTagCatalogSyncConflict,
  sqliteMeetingNoteRepository,
} from '../data/repositories';
import type { MeetingSearchResult, MeetingTagRecord } from '../data/repositories';
import {
  ManageMeetingOrganizationUseCase,
  notifyMeetingTagCatalogChanged,
  requestMeetingTagCatalogSync,
  subscribeMeetingTagCatalogChanged,
} from '../application/meeting';
import { listMeetingRecycleBin, type MeetingRecycleBinEntry } from '../services/meetingRecycleBin';
import type { ScopeKey } from '../domain/meeting';
import { MeetingTagSheet } from '../components/MeetingTagSheet';
import { buildNativeProfileEntrySnapshot } from '../native/profileEntrySnapshot';

type MeetingListNavigationProp = NativeStackNavigationProp<RootStackParamList>;

type Props = {
  navigation: MeetingListNavigationProp;
  onTabPress: (event: { nativeEvent: NativeTabPressEvent }) => void;
  // UI-SHELL-BOTTOM-MAIN-001: destination-change motion for the active native root.
  bottomBarSelectionCommand: number;
};

const ACTIVE_RECORDER_STATES = new Set(['preparing', 'recording', 'paused', 'stopping']);
const meetingOrganization = new ManageMeetingOrganizationUseCase(sqliteMeetingNoteRepository);

const SEARCH_SOURCE_LABELS: Record<MeetingSearchResult['sourceKind'], string> = {
  title: '标题',
  tag: '标签',
  manual_note: '我的笔记',
  transcript: '文字记录',
  summary: '整理结果',
  action: '事项',
};

function meetingListPresentation(meeting: Meeting, captureInterrupted: boolean) {
  const presentation = deriveLegacyMeetingPresentationState(meeting, captureInterrupted
    ? { captureOverride: 'failed_recoverable' }
    : undefined);
  const hasRootSyncPending = Boolean(meeting.statusSyncPending)
    || meeting.tags.some(tag => tag.label === '待同步');
  if (meeting.tags.some(tag => tag.label === '同步冲突')) {
    return { label: '同步冲突', tone: 'danger' as const };
  }
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
    reorderMeetings,
    deleteMeeting,
    restoreDeletedMeeting,
    refreshMeetings,
    updateMeetingStatus,
    getCachedTranscript,
    getCachedSummary,
  } = useMeetings();
  const { isGuest, session, profile } = useAuth();
  const {
    retentionDays,
    refresh: refreshRecycleCapability,
  } = useMeetingRecycleCapability();
  const { showDialog } = useAppDialog();
  const { busy: mediaImporting, selectMeetingMedia } = useMeetingMediaImport();
  const isFocused = useIsFocused();
  const [searching, setSearching] = useState(false);
  const [query, setQuery] = useState('');
  const [optimisticMeetingOrder, setOptimisticMeetingOrder] = useState<readonly string[] | null>(null);
  const [reorderSaving, setReorderSaving] = useState(false);
  const [staleRecordingIds, setStaleRecordingIds] = useState<ReadonlySet<string>>(new Set());
  const [recycleBinVisible, setRecycleBinVisible] = useState(false);
  const [recycleBinEntries, setRecycleBinEntries] = useState<readonly MeetingRecycleBinEntry[]>([]);
  const [recycleBinLoading, setRecycleBinLoading] = useState(false);
  const [recycleBinError, setRecycleBinError] = useState('');
  const [restoringMeetingId, setRestoringMeetingId] = useState<string | null>(null);
  const [meetingTags, setMeetingTags] = useState<readonly MeetingTagRecord[]>([]);
  const [tagAssignments, setTagAssignments] = useState<ReadonlyMap<string, readonly string[]>>(new Map());
  const [tagSheetMode, setTagSheetMode] = useState<'assign' | 'manage' | null>(null);
  const [tagMeetingId, setTagMeetingId] = useState<string | null>(null);
  const [searchResults, setSearchResults] = useState<readonly MeetingSearchResult[]>([]);
  const [searchLoading, setSearchLoading] = useState(false);
  const [searchError, setSearchError] = useState('');
  const searchRequestRef = useRef(0);
  const focusRequestRef = useRef(0);
  const reorderInFlightRef = useRef(false);
  const accountScope = !isGuest && session ? `user:${session.user.id}` as ScopeKey : null;
  const meetingScope = isGuest ? 'guest' as ScopeKey : accountScope;
  const profileEntry = useMemo(
    () => buildNativeProfileEntrySnapshot(profile, isGuest),
    [isGuest, profile.avatarLocalUri, profile.avatarUrl, profile.nickname],
  );

  const refreshRecycleBin = useCallback(async (syncRemote = false) => {
    if (!accountScope || retentionDays === null) {
      setRecycleBinEntries([]);
      return;
    }
    setRecycleBinLoading(true);
    setRecycleBinError('');
    try {
      if (syncRemote) await refreshMeetings();
      setRecycleBinEntries(await listMeetingRecycleBin(
        sqliteMeetingNoteRepository,
        accountScope,
        retentionDays,
      ));
    } catch (reason) {
      setRecycleBinError(readableErrorMessage(reason, '回收站暂时无法加载，请稍后重试。'));
    } finally {
      setRecycleBinLoading(false);
    }
  }, [accountScope, refreshMeetings, retentionDays]);

  useEffect(() => {
    if (!recycleBinVisible) return;
    if (retentionDays === null) {
      setRecycleBinVisible(false);
      return;
    }
    void refreshRecycleBin(true);
  }, [recycleBinVisible, refreshRecycleBin, retentionDays]);

  useEffect(() => {
    if (!recycleBinVisible) return;
    const subscription = BackHandler.addEventListener('hardwareBackPress', () => {
      setRecycleBinVisible(false);
      return true;
    });
    return () => subscription.remove();
  }, [recycleBinVisible]);

  const refreshOrganization = useCallback(async () => {
    if (!meetingScope) {
      setMeetingTags([]);
      setTagAssignments(new Map());
      return '当前无法使用会议标签。';
    }
    try {
      const [tags, assignments] = await Promise.all([
        meetingOrganization.listTags(meetingScope),
        meetingOrganization.listAssignments(meetingScope),
      ]);
      const byMeeting = new Map<string, string[]>();
      assignments.forEach(assignment => {
        byMeeting.set(assignment.meetingId, [
          ...(byMeeting.get(assignment.meetingId) ?? []),
          assignment.tagId,
        ]);
      });
      setMeetingTags(tags);
      setTagAssignments(byMeeting);
      return null;
    } catch (reason) {
      const message = readableErrorMessage(reason, '标签暂时无法加载，请稍后重试。');
      return message;
    }
  }, [meetingScope]);

  useEffect(() => {
    if (!isFocused) return;
    void refreshOrganization();
  }, [isFocused, meetings, refreshOrganization]);

  useEffect(() => subscribeMeetingTagCatalogChanged(changedScope => {
    if (changedScope === meetingScope) void refreshOrganization();
  }), [meetingScope, refreshOrganization]);

  useEffect(() => {
    const request = ++searchRequestRef.current;
    const normalized = query.normalize('NFKC').trim();
    if (!searching || !meetingScope || !normalized) {
      setSearchResults([]);
      setSearchLoading(false);
      setSearchError('');
      return undefined;
    }
    setSearchLoading(true);
    setSearchResults([]);
    setSearchError('');
    const timer = setTimeout(() => {
      void meetingOrganization.search(meetingScope, normalized).then(results => {
        if (searchRequestRef.current !== request) return;
        setSearchResults(results);
        setSearchLoading(false);
      }).catch(reason => {
        if (searchRequestRef.current !== request) return;
        setSearchResults([]);
        setSearchLoading(false);
        setSearchError(readableErrorMessage(reason, '会议记录暂时无法搜索，请稍后重试。'));
      });
    }, 180);
    return () => clearTimeout(timer);
  }, [meetingScope, query, searching]);

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

  const tagNameById = useMemo(
    () => new Map(meetingTags.map(tag => [tag.id, tag.name])),
    [meetingTags],
  );
  const orderedMeetings = useMemo(() => {
    if (!optimisticMeetingOrder) return meetings;
    const byId = new Map(meetings.map(meeting => [meeting.id, meeting]));
    const optimistic = optimisticMeetingOrder
      .map(id => byId.get(id))
      .filter((meeting): meeting is Meeting => Boolean(meeting));
    return optimistic.length === meetings.length && new Set(optimisticMeetingOrder).size === meetings.length
      ? optimistic
      : meetings;
  }, [meetings, optimisticMeetingOrder]);
  const meetingById = useMemo(() => new Map(meetings.map(meeting => [meeting.id, meeting])), [meetings]);
  const activeSearch = searching && query.normalize('NFKC').trim().length > 0;
  const normalMeetingSnapshots = useMemo(() => orderedMeetings.map(meeting => {
    const presentation = meetingListPresentation(meeting, staleRecordingIds.has(meeting.id));
    const assignedNames = (tagAssignments.get(meeting.id) ?? [])
      .map(tagId => tagNameById.get(tagId))
      .filter((name): name is string => Boolean(name));
    const visibleNames = assignedNames.slice(0, 3);
    const supportText = visibleNames.length > 0
      ? `标签 · ${visibleNames.join('、')}${assignedNames.length > visibleNames.length ? ` 等${assignedNames.length}个` : ''}`
      : '';
    return {
      id: meeting.id,
      targetMeetingId: meeting.id,
      title: displayMeetingTitle(meeting.title),
      dateTimeLabel: compactMeetingDateTime(meeting.date, meeting.time),
      durationLabel: meeting.audioDurationSec
        ? formatDuration(meeting.audioDurationSec)
        : meeting.duration,
      statusLabel: presentation.label === '已完成' ? '' : presentation.label,
      statusTone: presentation.tone,
      canResume: canResumeMeetingRecording(meeting),
      supportText,
      ...inferredMeetingCover(getCachedSummary(meeting.id), getCachedTranscript(meeting.id)),
    };
  }), [getCachedSummary, getCachedTranscript, orderedMeetings, staleRecordingIds, tagAssignments, tagNameById]);
  const searchMeetingSnapshots = useMemo(() => searchResults.flatMap(result => {
    const meeting = meetingById.get(result.navigationMeetingId);
    if (!meeting) return [];
    const presentation = meetingListPresentation(meeting, staleRecordingIds.has(meeting.id));
    const sourceLabel = SEARCH_SOURCE_LABELS[result.sourceKind];
    const snippet = result.snippet || displayMeetingTitle(meeting.title);
    return [{
      id: result.resultId,
      targetMeetingId: meeting.id,
      title: displayMeetingTitle(meeting.title),
      dateTimeLabel: compactMeetingDateTime(meeting.date, meeting.time),
      durationLabel: meeting.audioDurationSec
        ? formatDuration(meeting.audioDurationSec)
        : meeting.duration,
      statusLabel: presentation.label === '已完成' ? '' : presentation.label,
      statusTone: presentation.tone,
      canResume: false,
      coverType: 'summary' as const,
      coverTitle: sourceLabel,
      coverText: snippet,
      supportText: `${sourceLabel} · ${snippet}`,
      searchSource: result.sourceKind,
      searchSourceId: result.sourceId,
      ...(result.startMs !== null ? { searchPositionMs: result.startMs } : {}),
    }];
  }), [meetingById, searchResults, staleRecordingIds]);

  const snapshot = useMemo<MinutesViewSnapshot>(() => {
    const recycleMeetings = recycleBinEntries.map(entry => {
      const recordedAt = new Date(entry.recordedAtMs);
      const date = `${recordedAt.getFullYear()}年${recordedAt.getMonth() + 1}月${recordedAt.getDate()}日`;
      const time = `${String(recordedAt.getHours()).padStart(2, '0')}:${String(recordedAt.getMinutes()).padStart(2, '0')}`;
      return {
        id: entry.meetingId,
        targetMeetingId: entry.meetingId,
        title: displayMeetingTitle(entry.title),
        dateTimeLabel: compactMeetingDateTime(date, time),
        statusLabel: restoringMeetingId === entry.meetingId
          ? '正在恢复'
          : entry.canRestore ? `还可恢复${entry.remainingDays}天` : '同步冲突',
        statusTone: entry.canRestore ? 'warning' as const : 'danger' as const,
        action: 'restore' as const,
        actionEnabled: entry.canRestore && restoringMeetingId === null,
        coverType: 'default' as const,
      };
    });
    const searchPhase = searchLoading
      ? 'loading' as const
      : searchError ? 'error' as const : searchMeetingSnapshots.length === 0 ? 'empty' as const : 'ready' as const;
    const searchMessage = searchLoading
      ? '正在搜索会议记录'
      : searchError || (searchMeetingSnapshots.length === 0 ? '未找到相关会议记录' : '');
    return {
      schemaVersion: MINUTES_SNAPSHOT_SCHEMA_VERSION,
      surface: 'list',
      list: {
        title: recycleBinVisible ? '回收站' : '会议记录',
        mode: recycleBinVisible ? 'recycleBin' : 'meetings',
        canOpenRecycleBin: retentionDays !== null,
        canReorder: !recycleBinVisible
          && !searching
          && !reorderSaving
          && orderedMeetings.length > 1,
        searching: recycleBinVisible ? false : searching,
        query: recycleBinVisible ? '' : query,
        mediaImporting: recycleBinVisible ? false : mediaImporting,
        phase: recycleBinVisible
          ? recycleBinLoading && recycleBinEntries.length === 0
            ? 'loading'
            : recycleBinError ? 'error' : recycleBinEntries.length === 0 ? 'empty' : 'ready'
          : activeSearch
            ? searchPhase
            : loading && meetings.length === 0
              ? 'loading'
              : error ? 'error' : meetings.length === 0 ? 'empty' : 'ready',
        message: recycleBinVisible
          ? recycleBinError
          : activeSearch
            ? searchMessage
            : error ? readableErrorMessage(error, '会议记录暂时无法加载，请稍后重试。') : '',
        showingCachedData: recycleBinVisible || activeSearch
          ? false
          : Boolean(error && meetings.length > 0),
        meetings: recycleBinVisible
          ? recycleMeetings
          : activeSearch ? searchMeetingSnapshots : normalMeetingSnapshots,
      },
    };
  }, [activeSearch, error, loading, mediaImporting, meetings.length, normalMeetingSnapshots, orderedMeetings.length, query, recycleBinEntries, recycleBinError, recycleBinLoading, recycleBinVisible, reorderSaving, restoringMeetingId, retentionDays, searchError, searchLoading, searchMeetingSnapshots, searching]);

  const confirmDelete = async (id: string) => {
    const target = meetings.find(meeting => meeting.id === id);
    if (!target) return;
    let presentation;
    try {
      presentation = await resolveMeetingDeletionPresentation(target, refreshRecycleCapability);
    } catch (reason) {
      showDialog({
        title: '无法确认删除方式',
        message: readableErrorMessage(reason, '暂时无法确认此会议是否可以恢复，请稍后重试。'),
        tone: 'error',
      });
      return;
    }
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
              await deleteMeeting(id, {
                recoverable: presentation.recoverable,
                expectedRetentionDays: presentation.retentionDays,
              });
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

  const confirmRestore = (meetingId: string) => {
    const entry = recycleBinEntries.find(item => item.meetingId === meetingId);
    if (!entry || !entry.canRestore || retentionDays === null || restoringMeetingId) return;
    showDialog({
      title: '恢复会议记录？',
      message: '恢复后，此会议会重新显示在会议记录中。',
      actions: [
        {
          text: '恢复',
          role: 'primary',
          onPress: async () => {
            setRestoringMeetingId(meetingId);
            try {
              await restoreDeletedMeeting(meetingId, retentionDays);
              await refreshRecycleBin(false);
            } catch (reason) {
              showDialog({
                title: '恢复失败',
                message: readableErrorMessage(reason, '会议记录暂时无法恢复，请稍后重试。'),
                tone: 'error',
              });
            } finally {
              setRestoringMeetingId(null);
            }
          },
        },
        { text: '取消', role: 'cancel' },
      ],
    });
  };

  const persistMeetingOrder = async (meetingIds: readonly string[]) => {
    if (reorderInFlightRef.current || searching || recycleBinVisible) return;
    const currentIds = orderedMeetings.map(meeting => meeting.id);
    if (
      meetingIds.length !== currentIds.length
      || new Set(meetingIds).size !== meetingIds.length
      || currentIds.some(id => !meetingIds.includes(id))
    ) {
      showDialog({
        title: '顺序未保存',
        message: '会议列表已经变化，请重新拖动排序。',
        tone: 'warning',
      });
      return;
    }
    reorderInFlightRef.current = true;
    setOptimisticMeetingOrder([...meetingIds]);
    setReorderSaving(true);
    try {
      await reorderMeetings(meetingIds);
      setOptimisticMeetingOrder(null);
    } catch (reason) {
      setOptimisticMeetingOrder(null);
      showDialog({
        title: '顺序未保存',
        message: readableErrorMessage(reason, '会议顺序暂时无法保存，请稍后重试。'),
        tone: 'error',
      });
    } finally {
      reorderInFlightRef.current = false;
      setReorderSaving(false);
    }
  };

  const handleAction = (action: MinutesSemanticAction) => {
    switch (action.type) {
      case 'openMeeting': {
        const requestId = ++focusRequestRef.current;
        if (action.searchSource === 'transcript') {
          navigation.navigate('Transcription', {
            meetingId: action.meetingId,
            focus: 'transcript',
            segmentId: action.searchSourceId,
            positionMs: action.searchPositionMs,
            transcriptFocusRequestId: requestId,
          });
        } else if (action.searchSource === 'summary') {
          navigation.navigate('Transcription', { meetingId: action.meetingId, focus: 'summary' });
        } else if (action.searchSource === 'action') {
          navigation.navigate('Transcription', {
            meetingId: action.meetingId,
            focus: 'summary',
            actionId: action.searchSourceId,
            actionFocusRequestId: requestId,
          });
        } else if (action.searchSource === 'manual_note') {
          navigation.navigate('Transcription', { meetingId: action.meetingId, focus: 'notes' });
        } else {
          navigation.navigate('Transcription', { meetingId: action.meetingId });
        }
        break;
      }
      case 'openRecording':
        navigation.navigate('MeetingLive', { meetingId: action.meetingId });
        break;
      case 'openMeetingMenu':
        break;
      case 'openRecycleBin':
        void refreshRecycleCapability()
          .then(days => {
            if (days !== null) {
              setRecycleBinVisible(true);
              return;
            }
            showDialog({
              title: '回收站暂时不可用',
              message: '当前会议服务未提供可恢复删除，请稍后重试。',
              tone: 'warning',
            });
          })
          .catch(reason => {
            showDialog({
              title: '回收站暂时无法打开',
              message: readableErrorMessage(reason, '暂时无法连接会议服务，请稍后重试。'),
              tone: 'error',
            });
          });
        break;
      case 'openMeetingTags':
        void openTagSheet('manage', null);
        break;
      case 'openMeetingOrganization':
        navigation.navigate('MeetingOrganization');
        break;
      case 'closeRecycleBin':
        setRecycleBinVisible(false);
        break;
      case 'restoreMeeting':
        confirmRestore(action.meetingId);
        break;
      case 'reorderMeetings':
        void persistMeetingOrder(action.meetingIds);
        break;
      case 'renameMeeting':
        navigation.navigate('Transcription', { meetingId: action.meetingId, focus: 'title' });
        break;
      case 'setMeetingTags':
        void openTagSheet('assign', action.meetingId);
        break;
      case 'deleteMeeting':
        void confirmDelete(action.meetingId);
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
        if (recycleBinVisible) void refreshRecycleBin(true);
        else void refreshMeetings();
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

  async function openTagSheet(mode: 'assign' | 'manage', meetingId: string | null) {
    const loadError = await refreshOrganization();
    if (loadError) {
      showDialog({ title: '标签暂时不可用', message: loadError, tone: 'error' });
      return;
    }
    if (accountScope) {
      try {
        const conflict = await getMeetingTagCatalogSyncConflict(accountScope);
        if (conflict) {
          const resolve = async (resolution: 'keep_local' | 'use_cloud') => {
            try {
              const result = await resolveMeetingTagCatalogSyncConflict(
                accountScope,
                resolution,
                Date.now(),
              );
              if (!result.resolved) throw new Error('标签同步冲突已经变化');
              notifyMeetingTagCatalogChanged(accountScope);
              requestMeetingTagCatalogSync(accountScope);
              await refreshOrganization();
              setTagMeetingId(meetingId);
              setTagSheetMode(mode);
            } catch (reason) {
              showDialog({
                title: '标签同步冲突未解决',
                message: readableErrorMessage(reason, '标签暂时无法合并，请稍后重试。'),
                tone: 'error',
              });
            }
          };
          showDialog({
            title: '标签已在其他设备更新',
            message: '请选择保留本机标签，或使用云端标签。',
            tone: 'warning',
            actions: [
              { text: '保留本机', role: 'primary', onPress: () => resolve('keep_local') },
              { text: '使用云端', onPress: () => resolve('use_cloud') },
              { text: '取消', role: 'cancel' },
            ],
          });
          return;
        }
      } catch (reason) {
        showDialog({
          title: '标签暂时不可用',
          message: readableErrorMessage(reason, '标签同步状态暂时无法读取，请稍后重试。'),
          tone: 'error',
        });
        return;
      }
    }
    setTagMeetingId(meetingId);
    setTagSheetMode(mode);
  }

  const createTag = async (name: string): Promise<MeetingTagRecord> => {
    if (!meetingScope) throw new Error('当前无法使用会议标签。');
    const tag = await meetingOrganization.createTag(meetingScope, name);
    await refreshOrganization();
    return tag;
  };

  const renameTag = async (tagId: string, name: string) => {
    if (!meetingScope) throw new Error('当前无法使用会议标签。');
    const result = await meetingOrganization.renameOrMergeTag(tagId, meetingScope, name);
    await refreshOrganization();
    return result;
  };

  const requestDeleteTag = (tag: MeetingTagRecord) => {
    if (!meetingScope) return;
    showDialog({
      title: `删除标签“${tag.name}”？`,
      message: tag.meetingCount > 0
        ? `会从 ${tag.meetingCount} 场会议中移除此标签，会议内容不会被删除。`
        : '会议内容不会被删除。',
      tone: 'danger',
      actions: [
        {
          text: '删除',
          role: 'destructive',
          onPress: async () => {
            try {
              await meetingOrganization.deleteTag(tag.id, meetingScope);
              await refreshOrganization();
            } catch (reason) {
              showDialog({
                title: '删除失败',
                message: readableErrorMessage(reason, '标签暂时未能删除，请稍后重试。'),
                tone: 'error',
              });
            }
          },
        },
        { text: '取消', role: 'cancel' },
      ],
    });
  };

  const saveMeetingTags = async (tagIds: readonly string[]) => {
    if (!meetingScope || !tagMeetingId) throw new Error('当前无法保存会议标签。');
    await meetingOrganization.replaceMeetingTags(tagMeetingId, meetingScope, tagIds);
    await refreshOrganization();
  };

  const tagMeeting = tagMeetingId ? meetings.find(meeting => meeting.id === tagMeetingId) ?? null : null;

  return (
    <>
      <LaojiMinutesView
        style={styles.surface}
        surface="list"
        snapshot={snapshot}
        profileEntry={profileEntry}
        bottomBarSelectionCommand={bottomBarSelectionCommand}
        onMinutesAction={event => handleAction(event.nativeEvent)}
        onTabPress={onTabPress}
        testID="meeting-native-list"
      />
      {tagSheetMode && meetingScope && (tagSheetMode === 'manage' || tagMeeting) ? (
        <MeetingTagSheet
          visible
          mode={tagSheetMode}
          meetingTitle={tagMeeting ? displayMeetingTitle(tagMeeting.title) : undefined}
          tags={meetingTags}
          selectedTagIds={tagMeetingId ? tagAssignments.get(tagMeetingId) ?? [] : []}
          onClose={() => {
            setTagSheetMode(null);
            setTagMeetingId(null);
          }}
          onCreate={createTag}
          onRename={renameTag}
          onDelete={requestDeleteTag}
          onSave={tagSheetMode === 'assign' ? saveMeetingTags : undefined}
        />
      ) : null}
    </>
  );
}

const styles = StyleSheet.create({
  surface: { flex: 1 },
});
