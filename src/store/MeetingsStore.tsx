import React, { createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { AppState } from 'react-native';
import * as FileSystem from 'expo-file-system/legacy';
import { Meeting, MeetingSummary, TranscriptLine } from '../types';
import {
  ApiMeeting,
  createMeeting as apiCreateMeeting,
  deleteMeeting as apiDeleteMeeting,
  fetchAllMeetings,
  uploadMeetingAudio,
  updateMeeting as apiUpdateMeeting,
} from '../services/api';
import { useAuth } from './AuthStore';
import { Colors as C } from '../theme/colors';
import { formatDuration } from '../utils/meetingMedia';
import {
  deletePendingMeetingAudioUpload,
  listPendingMeetingAudioUploads,
  PendingMeetingAudioUpload,
  retryPendingMeetingAudioUploads,
} from '../services/meetingRecording';
import { getAppStorageItem, writeAppStorageJson } from '../services/appStorage';
import { HttpResponseError } from '../services/errors';
import { meetingSummaryToText } from '../services/meetingSummary';
import { deleteNativeMeetingArtifacts } from '../native/nativeTransferCoordinator';
import { deleteMeetingPlaybackCache } from '../services/meetingPlaybackCache';
import { listPendingMeetingSummaryTasks } from '../services/meetingSummaryTasks';
import {
  runLegacyMeetingShadowImport,
} from '../data/db/legacyImport';
import { isScopeKey, secureClientIdFactory, type ScopeKey } from '../domain/meeting';
import { diagnosticAudit, diagnosticInfo, diagnosticWarn } from '../services/diagnostics';
import { getFeatureFlags } from '../config/featureFlags';
import {
  MeetingRepositoryFacade,
  sqliteMeetingNoteRepository,
  type MeetingDualReadReport,
} from '../data/repositories';
import { reconcileNativeMeetingRecordings } from '../services/meetingRecordingReconciliation';
import {
  mirrorLegacyMeetingCreated,
  mirrorLegacyMeetingDeletion,
  mirrorLegacyMeetingStageState,
} from '../services/meetingStageMirror';
import {
  mirrorLegacySummaryContent,
  mirrorLegacyTranscriptContent,
} from '../services/meetingContentMirror';
import {
  resolveMeetingReadCutover,
  type MeetingReadProjection,
} from '../services/meetingReadCutover';

const MEETINGS_CACHE_KEY = '@laoji:meetings:v2';
const TRANSCRIPT_CACHE_KEY = '@laoji:meetingTranscripts:v1';
const SUMMARY_CACHE_KEY = '@laoji:meetingSummaries:v1';

const meetingRepositoryFacade = new MeetingRepositoryFacade(sqliteMeetingNoteRepository);

function mirrorMeetingProjection(scope: string, meeting: Meeting | undefined): Promise<void> {
  if (!meeting || !isScopeKey(scope)) return Promise.resolve();
  return mirrorLegacyMeetingStageState(scope, meeting);
}

async function mirrorMeetingProjections(scope: string, meetings: readonly Meeting[]): Promise<void> {
  if (!isScopeKey(scope)) return;
  for (let offset = 0; offset < meetings.length; offset += 4) {
    await Promise.all(
      meetings.slice(offset, offset + 4).map(meeting => mirrorLegacyMeetingStageState(scope, meeting)),
    );
  }
}

async function auditShadowRepositoryRead(
  scopeKey: ScopeKey,
  legacyMeetings: readonly Meeting[],
  transcripts: Readonly<Record<string, readonly TranscriptLine[]>>,
  summaries: Readonly<Record<string, MeetingSummary | null>>,
): Promise<MeetingDualReadReport | null> {
  try {
    const transcriptLineCounts = Object.fromEntries(
      Object.entries(transcripts).map(([id, lines]) => [id, lines.length]),
    );
    const summaryReady = Object.fromEntries(
      Object.entries(summaries).map(([id, summary]) => [id, Boolean(meetingSummaryToText(summary))]),
    );
    const report = await meetingRepositoryFacade.compareLegacySnapshot(scopeKey, legacyMeetings, {
      transcriptLineCounts,
      summaryReady,
    });
    diagnosticAudit('meeting_db_repository_read', {
      status: report.status,
      scope: scopeKey === 'guest' ? 'guest' : 'account',
      legacy_meetings: report.legacyMeetings,
      projected_meetings: report.repositoryMeetings,
      tombstones: report.repositoryTombstones,
      invalid_legacy_identities: report.invalidLegacyIdentities,
      missing: report.missingFromRepository,
      extra: report.extraInRepository,
      duplicate_legacy_identities: report.duplicateLegacyIdentities,
      duplicate_identities: report.duplicateRepositoryIdentities,
      order_mismatches: report.orderMismatches,
      title_mismatches: report.titleMismatches,
      lifecycle_mismatches: report.lifecycleMismatches,
      invalid_stage_sets: report.invalidStageSets,
      transcript_count_mismatches: report.transcriptCountMismatches,
      summary_availability_mismatches: report.summaryAvailabilityMismatches,
      context_mismatches: report.contextMismatches,
    });
    return report;
  } catch (error) {
    diagnosticWarn('[meeting-db] repository shadow read failed', error);
    diagnosticAudit('meeting_db_repository_read', {
      status: 'failed',
      scope: scopeKey === 'guest' ? 'guest' : 'account',
      error_code: error instanceof Error ? error.name : 'UnknownError',
    });
    return null;
  }
}

export class MeetingDeletionCleanupError extends Error {
  constructor(public readonly failureCount: number) {
    super('会议记录已删除，但部分本机录音或缓存未能清理。请在隐私设置中清除本机数据。');
    this.name = 'MeetingDeletionCleanupError';
  }
}

function isFinishedStatus(status: string): boolean {
  return ['completed', 'ended', 'done', 'processed'].includes(status);
}

function formatDateTime(value: string | undefined): { date: string; time?: string } {
  if (!value) return { date: '未知日期' };
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return { date: value };
  return {
    date: `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日`,
    time: `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`,
  };
}

function statusTag(status: string): { label: string; color: string } {
  if (status === 'recording') return { label: '录音中', color: C.red };
  if (status === 'processing') return { label: '处理中', color: C.orange };
  if (status === 'failed') return { label: '失败', color: C.red };
  if (isFinishedStatus(status)) return { label: '已完成', color: C.green };
  return { label: '未开始', color: C.purple };
}

const STATUS_TAG_LABELS = new Set(['录音中', '处理中', '失败', '已完成', '未开始']);

function tagsForStatus(meeting: Meeting, status: string): Meeting['tags'] {
  const retained = meeting.tags.filter(tag => !STATUS_TAG_LABELS.has(tag.label) && tag.label !== '待同步');
  return [statusTag(status), ...retained];
}

function tagsWithPendingSync(tags: Meeting['tags']): Meeting['tags'] {
  return [...tags.filter(tag => tag.label !== '待同步'), { label: '待同步', color: C.orange }];
}

function tagsForAudioSync(tags: Meeting['tags'], pending: boolean, blocked = false): Meeting['tags'] {
  const retained = tags.filter(tag => tag.label !== '待上传' && tag.label !== '上传受阻');
  if (!pending) return retained;
  return [...retained, blocked
    ? { label: '上传受阻', color: C.red }
    : { label: '待上传', color: C.orange }];
}

function serverToLocal(m: ApiMeeting): Meeting {
  const recordedAt = m.recorded_at ?? m.created_at;
  const { date, time } = formatDateTime(recordedAt);
  const audioDurationSec = typeof m.audio_duration_sec === 'number' && m.audio_duration_sec > 0
    ? m.audio_duration_sec
    : undefined;
  return {
    id: m.id,
    title: m.title,
    date,
    time,
    duration: formatDuration(audioDurationSec),
    tags: [statusTag(m.status), ...(m.mode ? [{ label: m.mode === 'offline' ? '离线' : '实时', color: C.blue }] : [])],
    participants: m.participants ?? [],
    hasTranscript: m.transcript_available ?? (m.transcript_count ?? 0) > 0,
    hasSummary: m.summary_available ?? false,
    status: m.status,
    mode: m.mode ?? 'realtime',
    description: m.description ?? null,
    location: m.location ?? null,
    createdAt: recordedAt,
    updatedAt: m.updated_at,
    audioAvailable: Boolean(m.audio_available),
    audioSyncPending: false,
    audioSyncBlocked: false,
    audioDurationSec,
    clientRequestId: m.client_request_id ?? undefined,
    source: 'cloud',
  };
}

interface CreateMeetingOptions {
  description?: string | null;
  participants?: string[];
  mode?: ApiMeeting['mode'];
  clientRequestId?: string;
  location?: string | null;
  recordedAt?: string | null;
}

function createGuestMeeting(
  title: string,
  options: CreateMeetingOptions,
  now: Date,
): Meeting {
  return {
    id: secureClientIdFactory.create(),
    title,
    date: `${now.getFullYear()}年${now.getMonth() + 1}月${now.getDate()}日`,
    time: `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`,
    duration: '—',
    tags: [statusTag('created'), { label: '本机', color: C.teal }],
    participants: options.participants ?? [],
    hasTranscript: false,
    hasSummary: false,
    status: 'created',
    mode: options.mode ?? 'realtime',
    description: options.description ?? null,
    location: options.location ?? null,
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
    audioAvailable: false,
    clientRequestId: options.clientRequestId,
    source: 'guest',
  };
}

async function loadJson<T>(key: string, fallback: T): Promise<T> {
  try {
    const raw = await getAppStorageItem(key);
    return raw ? JSON.parse(raw) as T : fallback;
  } catch {
    return fallback;
  }
}

async function persistJson(key: string, value: unknown): Promise<void> {
  await writeAppStorageJson(key, value, { bestEffort: true });
}

function assertMeetingDeletionAllowed(meeting: Meeting): void {
  // Failed and not-yet-started records remain resumable, but they do not own an
  // active recorder and must still be deletable from the long-press menu.
  if (meeting.status === 'recording') {
    throw new Error('请先结束并保存当前会议录音，再删除会议。');
  }
}

interface MeetingsContextType {
  meetings: Meeting[];
  loading: boolean;
  error: string | null;
  createMeeting: (title: string, options?: CreateMeetingOptions) => Promise<Meeting>;
  deleteMeeting: (id: string) => Promise<void>;
  updateMeetingTitle: (id: string, title: string) => Promise<void>;
  updateMeetingDetails: (
    id: string,
    changes: Partial<Pick<Meeting, 'title' | 'description' | 'participants' | 'mode' | 'location'>>,
  ) => Promise<void>;
  updateMeetingStatus: (id: string, status: string, patch?: Partial<Meeting>) => Promise<boolean>;
  refreshMeetings: () => Promise<void>;
  getCachedTranscript: (id: string) => TranscriptLine[];
  saveCachedTranscript: (id: string, transcript: TranscriptLine[]) => Promise<void>;
  getCachedSummary: (id: string) => MeetingSummary | null;
  saveCachedSummary: (id: string, summary: MeetingSummary | null) => Promise<void>;
}

const MeetingsContext = createContext<MeetingsContextType | null>(null);

export function MeetingsProvider({ children }: { children: React.ReactNode }) {
  const { mode, session, accessToken } = useAuth();
  const [meetings, setMeetings] = useState<Meeting[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const transcriptCacheRef = useRef<Record<string, TranscriptLine[]>>({});
  const summaryCacheRef = useRef<Record<string, MeetingSummary | null>>({});
  const meetingsRef = useRef<Meeting[]>([]);
  const canonicalReadProjectionRef = useRef<MeetingReadProjection | null>(null);
  const canonicalReadRequestRef = useRef(0);
  const generationRef = useRef(0);
  const activeScopeRef = useRef<string | null>(null);
  const guestMutationQueueRef = useRef<Promise<void>>(Promise.resolve());
  const audioResumeOperationsRef = useRef(new Map<string, Promise<void>>());
  const lastAudioResumeAtRef = useRef(new Map<string, number>());

  const scope = useMemo(() => {
    if (mode === 'authenticated' && session) return `user:${session.user.id}`;
    if (mode === 'guest') return 'guest';
    return 'signed_out';
  }, [mode, session?.user.id]);

  const meetingsKey = `${MEETINGS_CACHE_KEY}:${scope}`;
  const transcriptKey = `${TRANSCRIPT_CACHE_KEY}:${scope}`;
  const summaryKey = `${SUMMARY_CACHE_KEY}:${scope}`;

  useLayoutEffect(() => {
    generationRef.current += 1;
    activeScopeRef.current = scope;
    meetingsRef.current = [];
    transcriptCacheRef.current = {};
    summaryCacheRef.current = {};
    canonicalReadRequestRef.current += 1;
    canonicalReadProjectionRef.current = null;
    setMeetings([]);
    setError(null);
    setLoading(false);
  }, [scope]);

  const persistMeetings = useCallback((next: Meeting[]) => persistJson(meetingsKey, next), [meetingsKey]);
  const persistMeetingsStrict = useCallback(
    (next: Meeting[]) => writeAppStorageJson(meetingsKey, next, { removeIfEmpty: true }),
    [meetingsKey],
  );
  const persistTranscripts = useCallback(
    () => writeAppStorageJson(transcriptKey, transcriptCacheRef.current, { removeIfEmpty: true }),
    [transcriptKey],
  );
  const persistSummaries = useCallback(
    () => writeAppStorageJson(summaryKey, summaryCacheRef.current, { removeIfEmpty: true }),
    [summaryKey],
  );
  const enqueueGuestMutation = useCallback(<T,>(operation: () => Promise<T>): Promise<T> => {
    const result = guestMutationQueueRef.current.then(operation, operation);
    guestMutationQueueRef.current = result.then(() => undefined, () => undefined);
    return result;
  }, []);

  const deactivateCanonicalRead = useCallback(() => {
    canonicalReadRequestRef.current += 1;
    canonicalReadProjectionRef.current = null;
  }, []);

  const applyMeetingReadCutover = useCallback(async (
    legacyMeetings: readonly Meeting[],
    preflight?: MeetingDualReadReport | null,
  ): Promise<'legacy' | 'sqlite'> => {
    const readRequest = ++canonicalReadRequestRef.current;
    const flags = getFeatureFlags();
    if (!flags.localMeetingDbCanonicalReadV1 || !isScopeKey(scope)) {
      canonicalReadProjectionRef.current = null;
      return 'legacy';
    }
    const operationGeneration = generationRef.current;
    const result = await resolveMeetingReadCutover({
      enabled: true,
      repository: sqliteMeetingNoteRepository,
      scopeKey: scope,
      legacy: {
        meetings: legacyMeetings,
        transcripts: transcriptCacheRef.current,
        summaries: summaryCacheRef.current,
      },
      preflight,
    });
    if (
      generationRef.current !== operationGeneration
      || activeScopeRef.current !== scope
      || canonicalReadRequestRef.current !== readRequest
    ) return 'legacy';
    diagnosticAudit('meeting_db_read_cutover', {
      status: result.source === 'sqlite' ? 'active' : 'fallback',
      scope: scope === 'guest' ? 'guest' : 'account',
      reason: result.reason,
      meetings: result.projection.meetings.length,
      ...(result.preflight ? {
        repository_meetings: result.preflight.repositoryMeetings,
        tombstones: result.preflight.repositoryTombstones,
        invalid_legacy_identities: result.preflight.invalidLegacyIdentities,
        missing: result.preflight.missingFromRepository,
        extra: result.preflight.extraInRepository,
        duplicate_legacy_identities: result.preflight.duplicateLegacyIdentities,
        duplicate_identities: result.preflight.duplicateRepositoryIdentities,
        order_mismatches: result.preflight.orderMismatches,
        title_mismatches: result.preflight.titleMismatches,
        lifecycle_mismatches: result.preflight.lifecycleMismatches,
        invalid_stage_sets: result.preflight.invalidStageSets,
        context_mismatches: result.preflight.contextMismatches,
        transcript_count_mismatches: result.preflight.transcriptCountMismatches,
        summary_availability_mismatches: result.preflight.summaryAvailabilityMismatches,
      } : {}),
      ...(result.compatibility ? {
        meeting_projection_mismatches: result.compatibility.meetingMismatches,
        transcript_content_mismatches: result.compatibility.transcriptContentMismatches,
        summary_content_mismatches: result.compatibility.summaryContentMismatches,
      } : {}),
      ...(result.errorCode ? { error_code: result.errorCode } : {}),
    });
    if (result.source === 'sqlite') {
      canonicalReadProjectionRef.current = result.projection;
      setMeetings(result.projection.meetings);
      return 'sqlite';
    }
    canonicalReadProjectionRef.current = null;
    setMeetings(result.projection.meetings);
    return 'legacy';
  }, [scope]);

  useEffect(() => {
    if (!getFeatureFlags().localMeetingDbCanonicalReadV1 || !isScopeKey(scope)) return undefined;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const unsubscribe = sqliteMeetingNoteRepository.observeList(scope, () => {
      deactivateCanonicalRead();
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        void applyMeetingReadCutover(meetingsRef.current);
      }, 30);
    });
    return () => {
      if (timer) clearTimeout(timer);
      unsubscribe();
    };
  }, [applyMeetingReadCutover, deactivateCanonicalRead, scope]);

  const refreshMeetingsFromCloud = useCallback(async () => {
    const requestGeneration = generationRef.current;
    if (activeScopeRef.current !== scope) return;
    if (mode === 'signed_out') {
      deactivateCanonicalRead();
      meetingsRef.current = [];
      setMeetings([]);
      return;
    }
    if (mode === 'guest') {
      return;
    }
    if (!accessToken) return;

    deactivateCanonicalRead();
    setLoading(true);
    try {
      const data = await fetchAllMeetings(accessToken);
      if (generationRef.current !== requestGeneration || activeScopeRef.current !== scope) return;
      const previousById = new Map(meetingsRef.current.map(item => [item.id, item]));
      const remoteItems = data.map(item => {
        const remote = serverToLocal(item);
        const cached = previousById.get(remote.id);
        const preservePendingStatus = Boolean(cached?.statusSyncPending && cached.status);
        const audioSyncPending = !remote.audioAvailable && Boolean(cached?.audioSyncPending);
        const audioSyncBlocked = audioSyncPending && Boolean(cached?.audioSyncBlocked);
        const statusTags = preservePendingStatus
          ? tagsWithPendingSync(cached?.tags ?? remote.tags)
          : remote.tags;
        return {
          ...remote,
          status: preservePendingStatus ? cached?.status : remote.status,
          tags: tagsForAudioSync(statusTags, audioSyncPending, audioSyncBlocked),
          statusSyncPending: preservePendingStatus,
          audioSyncPending,
          audioSyncBlocked,
          hasTranscript: remote.hasTranscript || (transcriptCacheRef.current[remote.id]?.length ?? 0) > 0,
          hasSummary: remote.hasSummary || Boolean(summaryCacheRef.current[remote.id]),
          audioAvailable: remote.audioAvailable || Boolean(cached?.audioLocalUri),
          audioLocalUri: cached?.audioLocalUri,
          audioDurationSec: remote.audioDurationSec ?? cached?.audioDurationSec,
          audioBars: cached?.audioBars,
          duration: remote.audioDurationSec ? remote.duration : cached?.duration ?? remote.duration,
        };
      });
      const remoteIds = new Set(remoteItems.map(item => item.id));
      const retainedPendingItems = meetingsRef.current
        .filter(item => (
          !remoteIds.has(item.id)
          && (item.statusSyncPending || item.audioSyncPending)
        ))
        .map(item => ({
          ...item,
          tags: tagsForAudioSync(
            item.statusSyncPending ? tagsWithPendingSync(item.tags) : item.tags,
            Boolean(item.audioSyncPending),
            Boolean(item.audioSyncBlocked),
          ),
        }));
      const local = await Promise.all([...remoteItems, ...retainedPendingItems].map(async item => {
        if (!item.statusSyncPending || !item.status) return item;
        try {
          const synced = serverToLocal(await apiUpdateMeeting(item.id, { status: item.status }, accessToken));
          return {
            ...item,
            status: synced.status,
            tags: tagsForAudioSync(
              synced.tags,
              Boolean(item.audioSyncPending),
              Boolean(item.audioSyncBlocked),
            ),
            updatedAt: synced.updatedAt,
            statusSyncPending: false,
          };
        } catch {
          return item;
        }
      }));
      if (generationRef.current !== requestGeneration || activeScopeRef.current !== scope) return;
      meetingsRef.current = local;
      setMeetings(local);
      await persistMeetings(local);
      const mirrorOperation = mirrorMeetingProjections(scope, local);
      if (getFeatureFlags().localMeetingDbCanonicalReadV1) {
        await mirrorOperation;
        if (generationRef.current !== requestGeneration || activeScopeRef.current !== scope) return;
        await applyMeetingReadCutover(local);
      } else {
        void mirrorOperation;
      }
      if (generationRef.current !== requestGeneration || activeScopeRef.current !== scope) return;
      setError(null);
    } catch (err) {
      if (generationRef.current !== requestGeneration || activeScopeRef.current !== scope) return;
      setError(err instanceof Error ? err.message : '会议服务暂时不可用');
    } finally {
      if (generationRef.current === requestGeneration && activeScopeRef.current === scope) {
        setLoading(false);
      }
    }
  }, [accessToken, applyMeetingReadCutover, deactivateCanonicalRead, mode, persistMeetings, scope]);

  const reconcilePendingAudioUploads = useCallback(async (
    pendingUploads: PendingMeetingAudioUpload[],
    operationGeneration: number,
  ) => {
    if (generationRef.current !== operationGeneration || activeScopeRef.current !== scope) return;
    const pendingById = new Map(pendingUploads.map(item => [item.meetingId, item]));
    let changed = false;
    const next = meetingsRef.current.map(meeting => {
      const pending = pendingById.get(meeting.id);
      const audioSyncPending = Boolean(pending);
      const audioSyncBlocked = pending?.uploadState === 'blocked';
      const tags = tagsForAudioSync(meeting.tags, audioSyncPending, audioSyncBlocked);
      const hasMatchingTag = meeting.tags.some(tag => tag.label === '待上传') === audioSyncPending;
      const hasMatchingBlockedTag = meeting.tags.some(tag => tag.label === '上传受阻') === audioSyncBlocked;
      const pendingTagMatches = audioSyncBlocked
        ? !meeting.tags.some(tag => tag.label === '待上传')
        : hasMatchingTag;
      if (
        meeting.audioSyncPending === audioSyncPending
        && meeting.audioSyncBlocked === audioSyncBlocked
        && pendingTagMatches
        && hasMatchingBlockedTag
      ) return meeting;
      changed = true;
      return { ...meeting, audioSyncPending, audioSyncBlocked, tags };
    });
    if (!changed) return;
    deactivateCanonicalRead();
    meetingsRef.current = next;
    setMeetings(next);
    await persistMeetings(next);
    const mirrorOperation = mirrorMeetingProjections(scope, next);
    if (getFeatureFlags().localMeetingDbCanonicalReadV1) {
      await mirrorOperation;
      if (generationRef.current !== operationGeneration || activeScopeRef.current !== scope) return;
      await applyMeetingReadCutover(next);
    } else {
      void mirrorOperation;
    }
  }, [applyMeetingReadCutover, deactivateCanonicalRead, persistMeetings, scope]);

  const resumePendingAudioUploads = useCallback((force = false): Promise<void> => {
    if (mode !== 'authenticated' || !accessToken || activeScopeRef.current !== scope) {
      return Promise.resolve();
    }
    const operationKey = scope;
    const existing = audioResumeOperationsRef.current.get(operationKey);
    if (existing) return existing;
    const now = Date.now();
    const lastAttemptAt = lastAudioResumeAtRef.current.get(operationKey) ?? 0;
    if (!force && now - lastAttemptAt < 30_000) return Promise.resolve();
    lastAudioResumeAtRef.current.set(operationKey, now);
    const operationGeneration = generationRef.current;

    let operation: Promise<void>;
    operation = (async () => {
      const before = await listPendingMeetingAudioUploads(scope);
      if (generationRef.current !== operationGeneration || activeScopeRef.current !== scope) return;
      await reconcilePendingAudioUploads(before, operationGeneration);
      if (before.length === 0) return;

      const result = await retryPendingMeetingAudioUploads(
        scope,
        accessToken,
        (pending, token) => uploadMeetingAudio(
          pending.meetingId,
          pending.audioUri,
          token,
          { fileName: pending.fileName, mimeType: pending.mimeType },
        ),
        2,
      );
      const after = await listPendingMeetingAudioUploads(scope);
      if (generationRef.current !== operationGeneration || activeScopeRef.current !== scope) return;
      if (result.uploadedIds.length > 0 || after.length < before.length) {
        await refreshMeetingsFromCloud();
      }
      if (generationRef.current !== operationGeneration || activeScopeRef.current !== scope) return;
      await reconcilePendingAudioUploads(after, operationGeneration);
    })().finally(() => {
      if (audioResumeOperationsRef.current.get(operationKey) === operation) {
        audioResumeOperationsRef.current.delete(operationKey);
      }
    });
    audioResumeOperationsRef.current.set(operationKey, operation);
    return operation;
  }, [accessToken, mode, reconcilePendingAudioUploads, refreshMeetingsFromCloud, scope]);

  const refreshMeetings = useCallback(async () => {
    await refreshMeetingsFromCloud();
    void resumePendingAudioUploads(true).catch(() => {});
  }, [refreshMeetingsFromCloud, resumePendingAudioUploads]);

  useEffect(() => {
    if (mode !== 'authenticated' || !accessToken) return undefined;
    const subscription = AppState.addEventListener('change', nextState => {
      if (nextState === 'active') void resumePendingAudioUploads().catch(() => {});
    });
    return () => subscription.remove();
  }, [accessToken, mode, resumePendingAudioUploads]);

  useEffect(() => {
    if (!isScopeKey(scope)) return undefined;
    const subscription = AppState.addEventListener('change', nextState => {
      if (nextState === 'active') void reconcileNativeMeetingRecordings(scope);
    });
    return () => subscription.remove();
  }, [scope]);

  useEffect(() => {
    let alive = true;
    const loadGeneration = generationRef.current;
    const isCurrent = () => alive
      && generationRef.current === loadGeneration
      && activeScopeRef.current === scope;
    async function loadForScope() {
      if (mode === 'signed_out') return;
      setLoading(true);
      try {
        const [
          cachedMeetings,
          cachedTranscripts,
          cachedSummaries,
          pendingAudioUploads,
          pendingSummaryTasks,
        ] = await Promise.all([
          loadJson<Meeting[]>(meetingsKey, []),
          loadJson<Record<string, TranscriptLine[]>>(transcriptKey, {}),
          loadJson<Record<string, MeetingSummary | null>>(summaryKey, {}),
          mode === 'authenticated'
            ? listPendingMeetingAudioUploads(scope).catch(() => [])
            : Promise.resolve([]),
          listPendingMeetingSummaryTasks(scope).catch(() => []),
        ]);
        if (!isCurrent()) return;
        transcriptCacheRef.current = cachedTranscripts;
        summaryCacheRef.current = cachedSummaries;
        const pendingAudioById = new Map(pendingAudioUploads.map(item => [item.meetingId, item]));
        const hydratedMeetings = cachedMeetings.map(meeting => {
          const pendingAudio = pendingAudioById.get(meeting.id);
          const audioSyncPending = Boolean(pendingAudio);
          const audioSyncBlocked = pendingAudio?.uploadState === 'blocked';
          return {
            ...meeting,
            hasTranscript: meeting.hasTranscript || (cachedTranscripts[meeting.id]?.length ?? 0) > 0,
            hasSummary: meeting.hasSummary || Boolean(cachedSummaries[meeting.id]),
            audioSyncPending,
            audioSyncBlocked,
            tags: tagsForAudioSync(meeting.tags, audioSyncPending, audioSyncBlocked),
          };
        });
        meetingsRef.current = hydratedMeetings;
        setMeetings(hydratedMeetings);
        const flags = getFeatureFlags();
        const synchronizeMeetingDb = async (legacyMeetings: readonly Meeting[]) => {
          if (!flags.localMeetingDbV1 || !isScopeKey(scope)) return;
          try {
            const report = await runLegacyMeetingShadowImport({
              scopeKey: scope,
              meetings: legacyMeetings,
              transcripts: transcriptCacheRef.current,
              summaries: summaryCacheRef.current,
              pendingAudioUploads,
              pendingSummaryTasks,
            });
            if (!isCurrent()) return;
            const counts = report.counts;
            diagnosticInfo(
              `[meeting-db] shadow ${report.skipped ? 'unchanged' : 'completed'}: `
              + `${counts.meetingNotes} meetings, ${counts.transcriptSegments} transcript segments, `
              + `${counts.summaryVersions} summaries, ${counts.recordingAssets} recordings`,
            );
            diagnosticAudit('meeting_db_shadow_import', {
              status: report.skipped ? 'unchanged' : 'completed',
              scope: scope === 'guest' ? 'guest' : 'account',
              meetings: counts.meetingNotes,
              transcript_segments: counts.transcriptSegments,
              summaries: counts.summaryVersions,
              recordings: counts.recordingAssets,
            });
            const preflight = await auditShadowRepositoryRead(
              scope,
              legacyMeetings,
              transcriptCacheRef.current,
              summaryCacheRef.current,
            );
            if (!isCurrent()) return;
            if (flags.localMeetingDbCanonicalReadV1) {
              if (preflight) await applyMeetingReadCutover(legacyMeetings, preflight);
              else {
                deactivateCanonicalRead();
                setMeetings([...legacyMeetings]);
                diagnosticAudit('meeting_db_read_cutover', {
                  status: 'fallback',
                  scope: scope === 'guest' ? 'guest' : 'account',
                  reason: 'preflight_failed',
                });
              }
            }
            void reconcileNativeMeetingRecordings(scope, { force: true });
          } catch (error) {
            if (!isCurrent()) return;
            deactivateCanonicalRead();
            setMeetings([...legacyMeetings]);
            diagnosticWarn('[meeting-db] shadow import failed', error);
            diagnosticAudit('meeting_db_shadow_import', {
              status: 'failed',
              scope: scope === 'guest' ? 'guest' : 'account',
              error_code: error instanceof Error ? error.name : 'UnknownError',
            });
            if (flags.localMeetingDbCanonicalReadV1) {
              diagnosticAudit('meeting_db_read_cutover', {
                status: 'fallback',
                scope: scope === 'guest' ? 'guest' : 'account',
                reason: 'shadow_import_failed',
              });
            }
          }
        };
        if (flags.localMeetingDbCanonicalReadV1) {
          if (mode === 'authenticated') await refreshMeetings();
          if (isCurrent()) await synchronizeMeetingDb(meetingsRef.current);
        } else {
          void synchronizeMeetingDb(cachedMeetings);
          if (mode === 'authenticated') await refreshMeetings();
        }
      } finally {
        if (isCurrent()) setLoading(false);
      }
    }
    void loadForScope();
    return () => { alive = false; };
  }, [
    applyMeetingReadCutover,
    deactivateCanonicalRead,
    meetingsKey,
    mode,
    refreshMeetings,
    scope,
    summaryKey,
    transcriptKey,
  ]);

  const createMeeting = useCallback(async (
    title: string,
    options: CreateMeetingOptions = {},
  ): Promise<Meeting> => {
    const operationGeneration = generationRef.current;
    if (activeScopeRef.current !== scope) throw new Error('meeting scope changed');
    const cleanTitle = title.trim();
    if (mode === 'guest') {
      return enqueueGuestMutation(async () => {
        if (activeScopeRef.current !== scope) throw new Error('meeting scope changed');
        deactivateCanonicalRead();
        const requestedRecordedAt = options.recordedAt ? new Date(options.recordedAt) : new Date();
        const recordedAt = Number.isNaN(requestedRecordedAt.getTime()) ? new Date() : requestedRecordedAt;
        const local = createGuestMeeting(cleanTitle, options, recordedAt);
        const next = [local, ...meetingsRef.current];
        await persistMeetingsStrict(next);
        if (generationRef.current !== operationGeneration || activeScopeRef.current !== scope) return local;
        meetingsRef.current = next;
        setMeetings(next);
        if (isScopeKey(scope)) await mirrorLegacyMeetingCreated(scope, local);
        return local;
      });
    }
    if (!accessToken) throw new Error('not authenticated');
    const created = serverToLocal(await apiCreateMeeting({
      title: cleanTitle,
      description: options.description ?? null,
      participants: options.participants ?? [],
      mode: options.mode ?? 'realtime',
      clientRequestId: options.clientRequestId,
      location: options.location ?? null,
      recordedAt: options.recordedAt ?? null,
    }, accessToken));
    if (generationRef.current !== operationGeneration || activeScopeRef.current !== scope) return created;
    deactivateCanonicalRead();
    const next = [created, ...meetingsRef.current.filter(item => item.id !== created.id)];
    meetingsRef.current = next;
    setMeetings(next);
    void persistMeetings(next);
    if (isScopeKey(scope)) await mirrorLegacyMeetingCreated(scope, created);
    return created;
  }, [accessToken, deactivateCanonicalRead, enqueueGuestMutation, mode, persistMeetings, persistMeetingsStrict, scope]);

  const deleteMeeting = useCallback(async (id: string) => {
    const operationGeneration = generationRef.current;
    if (activeScopeRef.current !== scope) return;
    if (mode !== 'guest' && !accessToken) throw new Error('not authenticated');

    if (mode === 'guest') {
      return enqueueGuestMutation(async () => {
        if (generationRef.current !== operationGeneration || activeScopeRef.current !== scope) return;
        const target = meetingsRef.current.find(meeting => meeting.id === id) ?? null;
        if (!target) return;
        assertMeetingDeletionAllowed(target);
        deactivateCanonicalRead();
        const nextMeetings = meetingsRef.current.filter(meeting => meeting.id !== id);
        await persistMeetingsStrict(nextMeetings);
        if (generationRef.current !== operationGeneration || activeScopeRef.current !== scope) return;

        const nextTranscripts = { ...transcriptCacheRef.current };
        const nextSummaries = { ...summaryCacheRef.current };
        delete nextTranscripts[id];
        delete nextSummaries[id];
        meetingsRef.current = nextMeetings;
        transcriptCacheRef.current = nextTranscripts;
        summaryCacheRef.current = nextSummaries;
        setMeetings(nextMeetings);
        if (isScopeKey(scope)) void mirrorLegacyMeetingDeletion(scope, id);
        const cleanupResults = await Promise.allSettled([
          persistTranscripts(),
          persistSummaries(),
          deletePendingMeetingAudioUpload(scope, id),
          deleteNativeMeetingArtifacts(scope, id),
          deleteMeetingPlaybackCache(id),
          ...(target.audioLocalUri
            ? [FileSystem.deleteAsync(target.audioLocalUri, { idempotent: true })]
            : []),
        ]);
        const failures = cleanupResults.filter(result => result.status === 'rejected').length;
        if (failures > 0) throw new MeetingDeletionCleanupError(failures);
      });
    }

    const previousMeetings = meetingsRef.current;
    const previousTranscripts = transcriptCacheRef.current;
    const previousSummaries = summaryCacheRef.current;
    const target = previousMeetings.find(m => m.id === id) ?? null;
    if (target) assertMeetingDeletionAllowed(target);
    deactivateCanonicalRead();
    const targetIndex = previousMeetings.findIndex(m => m.id === id);
    const hadTranscript = Object.prototype.hasOwnProperty.call(previousTranscripts, id);
    const previousTranscript = previousTranscripts[id];
    const hadSummary = Object.prototype.hasOwnProperty.call(previousSummaries, id);
    const previousSummary = previousSummaries[id];
    const nextMeetings = previousMeetings.filter(m => m.id !== id);
    const nextTranscripts = { ...transcriptCacheRef.current };
    const nextSummaries = { ...summaryCacheRef.current };
    delete nextTranscripts[id];
    delete nextSummaries[id];
    meetingsRef.current = nextMeetings;
    transcriptCacheRef.current = nextTranscripts;
    summaryCacheRef.current = nextSummaries;
    setMeetings(nextMeetings);

    try {
      await apiDeleteMeeting(id, accessToken!);
    } catch (err) {
      const alreadyDeleted = err instanceof HttpResponseError && err.status === 404;
      if (!alreadyDeleted) {
        if (generationRef.current !== operationGeneration || activeScopeRef.current !== scope) {
          await Promise.allSettled([
            persistJson(meetingsKey, previousMeetings),
            writeAppStorageJson(transcriptKey, previousTranscripts, { removeIfEmpty: true }),
            writeAppStorageJson(summaryKey, previousSummaries, { removeIfEmpty: true }),
          ]);
          throw err;
        }
        if (target) {
          const restoredMeetings = meetingsRef.current.some(m => m.id === id)
            ? meetingsRef.current
            : [
              ...meetingsRef.current.slice(0, Math.max(0, targetIndex)),
              target,
              ...meetingsRef.current.slice(Math.max(0, targetIndex)),
            ];
          meetingsRef.current = restoredMeetings;
          setMeetings(restoredMeetings);
        }
        const restoredTranscripts = { ...transcriptCacheRef.current };
        if (hadTranscript) restoredTranscripts[id] = previousTranscript;
        else delete restoredTranscripts[id];
        transcriptCacheRef.current = restoredTranscripts;
        const restoredSummaries = { ...summaryCacheRef.current };
        if (hadSummary) restoredSummaries[id] = previousSummary;
        else delete restoredSummaries[id];
        summaryCacheRef.current = restoredSummaries;
        await Promise.allSettled([
          persistMeetings(meetingsRef.current),
          persistTranscripts(),
          persistSummaries(),
        ]);
        throw err;
      }
    }

    if (isScopeKey(scope)) void mirrorLegacyMeetingDeletion(scope, id);

    const cleanupResults = await Promise.allSettled([
      persistMeetingsStrict(nextMeetings),
      persistTranscripts(),
      persistSummaries(),
      deletePendingMeetingAudioUpload(scope, id),
      deleteNativeMeetingArtifacts(scope, id),
      deleteMeetingPlaybackCache(id),
      ...(target?.audioLocalUri
        ? [FileSystem.deleteAsync(target.audioLocalUri, { idempotent: true })]
        : []),
    ]);
    const failures = cleanupResults.filter(result => result.status === 'rejected').length;
    if (failures > 0) throw new MeetingDeletionCleanupError(failures);
  }, [accessToken, deactivateCanonicalRead, enqueueGuestMutation, meetingsKey, mode, persistMeetings, persistMeetingsStrict, persistSummaries, persistTranscripts, scope, summaryKey, transcriptKey]);

  const updateMeetingTitle = useCallback(async (id: string, title: string) => {
    const operationGeneration = generationRef.current;
    if (activeScopeRef.current !== scope) return;
    const cleanTitle = title.trim();
    if (mode === 'guest') {
      return enqueueGuestMutation(async () => {
        if (generationRef.current !== operationGeneration || activeScopeRef.current !== scope) return;
        deactivateCanonicalRead();
        const next = meetingsRef.current.map(meeting => (
          meeting.id === id ? { ...meeting, title: cleanTitle, updatedAt: new Date().toISOString() } : meeting
        ));
        await persistMeetingsStrict(next);
        if (generationRef.current !== operationGeneration || activeScopeRef.current !== scope) return;
        meetingsRef.current = next;
        setMeetings(next);
        mirrorMeetingProjection(scope, next.find(meeting => meeting.id === id));
      });
    }
    if (!accessToken) throw new Error('not authenticated');
    const previousMeeting = meetingsRef.current.find(meeting => meeting.id === id) ?? null;
    deactivateCanonicalRead();
    const optimisticUpdatedAt = new Date().toISOString();
    const optimistic = meetingsRef.current.map(m => (
      m.id === id ? { ...m, title: cleanTitle, updatedAt: optimisticUpdatedAt } : m
    ));
    meetingsRef.current = optimistic;
    setMeetings(optimistic);
    if (previousMeeting) {
      mirrorMeetingProjection(scope, { ...previousMeeting, title: cleanTitle, updatedAt: optimisticUpdatedAt });
    }
    try {
      const updated = serverToLocal(await apiUpdateMeeting(id, { title: cleanTitle }, accessToken));
      if (generationRef.current !== operationGeneration || activeScopeRef.current !== scope) return;
      const next = meetingsRef.current.map(m => m.id === id
        ? {
            ...m,
            ...updated,
            audioSyncPending: m.audioSyncPending,
            audioSyncBlocked: m.audioSyncBlocked,
            tags: tagsForAudioSync(
              updated.tags,
              Boolean(m.audioSyncPending),
              Boolean(m.audioSyncBlocked),
            ),
          }
        : m);
      meetingsRef.current = next;
      setMeetings(next);
      void persistMeetings(next);
      mirrorMeetingProjection(scope, next.find(meeting => meeting.id === id));
    } catch (err) {
      if (generationRef.current !== operationGeneration || activeScopeRef.current !== scope) throw err;
      if (previousMeeting) {
        const rolledBack = meetingsRef.current.map(meeting => (
          meeting.id === id && meeting.title === cleanTitle
            ? { ...meeting, title: previousMeeting.title, updatedAt: previousMeeting.updatedAt }
            : meeting
        ));
        meetingsRef.current = rolledBack;
        setMeetings(rolledBack);
        mirrorMeetingProjection(scope, rolledBack.find(meeting => meeting.id === id));
      }
      throw err;
    }
  }, [accessToken, deactivateCanonicalRead, enqueueGuestMutation, mode, persistMeetings, persistMeetingsStrict, scope]);

  const updateMeetingDetails = useCallback(async (
    id: string,
    changes: Partial<Pick<Meeting, 'title' | 'description' | 'participants' | 'mode' | 'location'>>,
  ) => {
    const operationGeneration = generationRef.current;
    if (activeScopeRef.current !== scope) return;
    const normalized = {
      ...changes,
      ...(Object.prototype.hasOwnProperty.call(changes, 'title')
        ? { title: changes.title?.trim() ?? '' }
        : {}),
      ...(Object.prototype.hasOwnProperty.call(changes, 'location')
        ? { location: changes.location?.trim() || null }
        : {}),
    };
    const previous = meetingsRef.current.find(meeting => meeting.id === id);
    if (!previous) throw new Error('会议记录不存在');

    deactivateCanonicalRead();
    const optimistic = meetingsRef.current.map(meeting => meeting.id === id
      ? { ...meeting, ...normalized, updatedAt: new Date().toISOString() }
      : meeting);
    await persistMeetingsStrict(optimistic);
    if (generationRef.current !== operationGeneration || activeScopeRef.current !== scope) return;
    meetingsRef.current = optimistic;
    setMeetings(optimistic);
    mirrorMeetingProjection(scope, optimistic.find(meeting => meeting.id === id));

    if (mode === 'guest') return;
    if (!accessToken) throw new Error('登录状态已失效，请重新登录');
    try {
      const updated = serverToLocal(await apiUpdateMeeting(id, {
        title: normalized.title,
        description: normalized.description,
        participants: normalized.participants,
        mode: normalized.mode,
        location: normalized.location,
      }, accessToken));
      if (generationRef.current !== operationGeneration || activeScopeRef.current !== scope) return;
      const next = meetingsRef.current.map(meeting => meeting.id === id
        ? {
            ...meeting,
            ...updated,
            audioLocalUri: meeting.audioLocalUri,
            audioBars: meeting.audioBars,
            audioSyncPending: meeting.audioSyncPending,
            audioSyncBlocked: meeting.audioSyncBlocked,
            statusSyncPending: meeting.statusSyncPending,
            tags: tagsForAudioSync(
              meeting.statusSyncPending ? tagsWithPendingSync(updated.tags) : updated.tags,
              Boolean(meeting.audioSyncPending),
              Boolean(meeting.audioSyncBlocked),
            ),
          }
        : meeting);
      await persistMeetingsStrict(next);
      if (generationRef.current !== operationGeneration || activeScopeRef.current !== scope) return;
      meetingsRef.current = next;
      setMeetings(next);
      mirrorMeetingProjection(scope, next.find(meeting => meeting.id === id));
    } catch (error) {
      if (generationRef.current === operationGeneration && activeScopeRef.current === scope) {
        const rolledBack = meetingsRef.current.map(meeting => meeting.id === id ? previous : meeting);
        meetingsRef.current = rolledBack;
        setMeetings(rolledBack);
        mirrorMeetingProjection(scope, rolledBack.find(meeting => meeting.id === id));
        await persistMeetingsStrict(rolledBack).catch(() => {});
      }
      throw error;
    }
  }, [accessToken, deactivateCanonicalRead, mode, persistMeetingsStrict, scope]);

  const updateMeetingStatus = useCallback(async (id: string, status: string, patch: Partial<Meeting> = {}) => {
    const operationGeneration = generationRef.current;
    if (activeScopeRef.current !== scope) return false;
    if (mode === 'guest') {
      return enqueueGuestMutation(async () => {
        if (generationRef.current !== operationGeneration || activeScopeRef.current !== scope) return false;
        deactivateCanonicalRead();
        const next = meetingsRef.current.map(meeting => meeting.id === id
          ? { ...meeting, ...patch, status, tags: [statusTag(status), { label: '本机', color: C.teal }], updatedAt: new Date().toISOString() }
          : meeting);
        await persistMeetingsStrict(next);
        if (generationRef.current !== operationGeneration || activeScopeRef.current !== scope) return false;
        meetingsRef.current = next;
        setMeetings(next);
        mirrorMeetingProjection(scope, next.find(meeting => meeting.id === id));
        return true;
      });
    }
    if (!accessToken) throw new Error('not authenticated');
    deactivateCanonicalRead();
    const local = meetingsRef.current.map(meeting => {
      if (meeting.id !== id) return meeting;
      const audioSyncPending = Boolean(patch.audioSyncPending ?? meeting.audioSyncPending);
      const audioSyncBlocked = audioSyncPending
        && Boolean(patch.audioSyncBlocked ?? meeting.audioSyncBlocked);
      return {
        ...meeting,
        ...patch,
        status,
        tags: tagsForAudioSync(
          tagsWithPendingSync(tagsForStatus(meeting, status)),
          audioSyncPending,
          audioSyncBlocked,
        ),
        audioSyncPending,
        audioSyncBlocked,
        statusSyncPending: true,
        updatedAt: new Date().toISOString(),
      };
    });
    await persistMeetingsStrict(local);
    if (generationRef.current !== operationGeneration || activeScopeRef.current !== scope) return false;
    meetingsRef.current = local;
    setMeetings(local);
    mirrorMeetingProjection(scope, local.find(meeting => meeting.id === id));
    try {
      const updated = serverToLocal(await apiUpdateMeeting(id, { status }, accessToken));
      if (generationRef.current !== operationGeneration || activeScopeRef.current !== scope) return true;
      const synced = meetingsRef.current.map(meeting => {
        if (meeting.id !== id) return meeting;
        const audioSyncPending = Boolean(patch.audioSyncPending ?? meeting.audioSyncPending);
        const audioSyncBlocked = audioSyncPending
          && Boolean(patch.audioSyncBlocked ?? meeting.audioSyncBlocked);
        return {
          ...meeting,
          ...updated,
          ...patch,
          tags: tagsForAudioSync(updated.tags, audioSyncPending, audioSyncBlocked),
          audioSyncPending,
          audioSyncBlocked,
          statusSyncPending: false,
        };
      });
      await persistMeetingsStrict(synced);
      if (generationRef.current !== operationGeneration || activeScopeRef.current !== scope) return true;
      meetingsRef.current = synced;
      setMeetings(synced);
      mirrorMeetingProjection(scope, synced.find(meeting => meeting.id === id));
      return true;
    } catch {
      return false;
    }
  }, [accessToken, deactivateCanonicalRead, enqueueGuestMutation, mode, persistMeetingsStrict, scope]);

  const getCachedTranscript = useCallback((id: string) => {
    const canonical = canonicalReadProjectionRef.current;
    return canonical ? canonical.transcripts[id] ?? [] : transcriptCacheRef.current[id] ?? [];
  }, []);
  const saveCachedTranscript = useCallback(async (id: string, transcript: TranscriptLine[]) => {
    const operationGeneration = generationRef.current;
    if (activeScopeRef.current !== scope) return;
    deactivateCanonicalRead();
    const previous = transcriptCacheRef.current;
    const next = { ...previous, [id]: transcript };
    transcriptCacheRef.current = next;
    try {
      await persistTranscripts();
    } catch (error) {
      if (transcriptCacheRef.current === next) transcriptCacheRef.current = previous;
      throw error;
    }
    if (generationRef.current !== operationGeneration || activeScopeRef.current !== scope) return;
    const contentMeeting = meetingsRef.current.find(meeting => meeting.id === id);
    if (contentMeeting && isScopeKey(scope)) {
      void mirrorLegacyTranscriptContent(scope, contentMeeting, transcript);
    }
    const nextMeetings = meetingsRef.current.map(m => (
      m.id === id ? { ...m, hasTranscript: transcript.length > 0 } : m
    ));
    meetingsRef.current = nextMeetings;
    setMeetings(nextMeetings);
    void persistMeetings(nextMeetings);
    mirrorMeetingProjection(scope, nextMeetings.find(meeting => meeting.id === id));
  }, [deactivateCanonicalRead, persistMeetings, persistTranscripts, scope]);

  const getCachedSummary = useCallback((id: string) => {
    const canonical = canonicalReadProjectionRef.current;
    return canonical ? canonical.summaries[id] ?? null : summaryCacheRef.current[id] ?? null;
  }, []);
  const saveCachedSummary = useCallback(async (id: string, summary: MeetingSummary | null) => {
    const operationGeneration = generationRef.current;
    if (activeScopeRef.current !== scope) return;
    deactivateCanonicalRead();
    const usableSummary = summary && meetingSummaryToText(summary) ? summary : null;
    const previous = summaryCacheRef.current;
    const next = { ...previous, [id]: usableSummary };
    summaryCacheRef.current = next;
    try {
      await persistSummaries();
    } catch (error) {
      if (summaryCacheRef.current === next) summaryCacheRef.current = previous;
      throw error;
    }
    if (generationRef.current !== operationGeneration || activeScopeRef.current !== scope) return;
    const contentMeeting = meetingsRef.current.find(meeting => meeting.id === id);
    if (contentMeeting && isScopeKey(scope)) {
      void mirrorLegacySummaryContent(scope, contentMeeting, usableSummary);
    }
    const nextMeetings = meetingsRef.current.map(m => (
      m.id === id ? { ...m, hasSummary: Boolean(usableSummary) } : m
    ));
    meetingsRef.current = nextMeetings;
    setMeetings(nextMeetings);
    void persistMeetings(nextMeetings);
    mirrorMeetingProjection(scope, nextMeetings.find(meeting => meeting.id === id));
  }, [deactivateCanonicalRead, persistMeetings, persistSummaries, scope]);

  return (
    <MeetingsContext.Provider
      value={{
        meetings,
        loading,
        error,
        createMeeting,
        deleteMeeting,
        updateMeetingTitle,
        updateMeetingDetails,
        updateMeetingStatus,
        refreshMeetings,
        getCachedTranscript,
        saveCachedTranscript,
        getCachedSummary,
        saveCachedSummary,
      }}
    >
      {children}
    </MeetingsContext.Provider>
  );
}

export function useMeetings() {
  const ctx = useContext(MeetingsContext);
  if (!ctx) throw new Error('useMeetings must be used inside MeetingsProvider');
  return ctx;
}
