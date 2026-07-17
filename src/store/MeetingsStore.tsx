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
import { canResumeMeetingRecording, formatDuration } from '../utils/meetingMedia';
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

const MEETINGS_CACHE_KEY = '@laoji:meetings:v2';
const TRANSCRIPT_CACHE_KEY = '@laoji:meetingTranscripts:v1';
const SUMMARY_CACHE_KEY = '@laoji:meetingSummaries:v1';

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
  const { date, time } = formatDateTime(m.created_at);
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
    createdAt: m.created_at,
    updatedAt: m.updated_at,
    audioAvailable: Boolean(m.audio_available),
    audioSyncPending: false,
    audioSyncBlocked: false,
    audioDurationSec,
    clientRequestId: m.client_request_id ?? undefined,
    source: 'cloud',
  };
}

function createGuestMeeting(title: string, clientRequestId?: string, now = new Date()): Meeting {
  return {
    id: `guest-meeting-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    title,
    date: `${now.getFullYear()}年${now.getMonth() + 1}月${now.getDate()}日`,
    time: `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`,
    duration: '—',
    tags: [statusTag('created'), { label: '本机', color: C.teal }],
    participants: [],
    hasTranscript: false,
    hasSummary: false,
    status: 'created',
    mode: 'realtime',
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
    audioAvailable: false,
    clientRequestId,
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

interface MeetingsContextType {
  meetings: Meeting[];
  loading: boolean;
  error: string | null;
  createMeeting: (title: string, options?: {
    description?: string | null;
    participants?: string[];
    mode?: ApiMeeting['mode'];
    clientRequestId?: string;
  }) => Promise<Meeting>;
  deleteMeeting: (id: string) => Promise<void>;
  updateMeetingTitle: (id: string, title: string) => Promise<void>;
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

  const refreshMeetingsFromCloud = useCallback(async () => {
    const requestGeneration = generationRef.current;
    if (activeScopeRef.current !== scope) return;
    if (mode === 'signed_out') {
      meetingsRef.current = [];
      setMeetings([]);
      return;
    }
    if (mode === 'guest') {
      return;
    }
    if (!accessToken) return;

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
  }, [accessToken, mode, persistMeetings, scope]);

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
    meetingsRef.current = next;
    setMeetings(next);
    await persistMeetings(next);
  }, [persistMeetings, scope]);

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
    let alive = true;
    const loadGeneration = generationRef.current;
    const isCurrent = () => alive
      && generationRef.current === loadGeneration
      && activeScopeRef.current === scope;
    async function loadForScope() {
      if (mode === 'signed_out') return;
      setLoading(true);
      try {
        const [cachedMeetings, cachedTranscripts, cachedSummaries, pendingAudioUploads] = await Promise.all([
          loadJson<Meeting[]>(meetingsKey, []),
          loadJson<Record<string, TranscriptLine[]>>(transcriptKey, {}),
          loadJson<Record<string, MeetingSummary | null>>(summaryKey, {}),
          mode === 'authenticated'
            ? listPendingMeetingAudioUploads(scope).catch(() => [])
            : Promise.resolve([]),
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
        if (mode === 'authenticated') await refreshMeetings();
      } finally {
        if (isCurrent()) setLoading(false);
      }
    }
    void loadForScope();
    return () => { alive = false; };
  }, [meetingsKey, mode, refreshMeetings, scope, summaryKey, transcriptKey]);

  const createMeeting = useCallback(async (
    title: string,
    options: {
      description?: string | null;
      participants?: string[];
      mode?: ApiMeeting['mode'];
      clientRequestId?: string;
    } = {},
  ): Promise<Meeting> => {
    const operationGeneration = generationRef.current;
    if (activeScopeRef.current !== scope) throw new Error('meeting scope changed');
    const cleanTitle = title.trim() || '未命名会议';
    if (mode === 'guest') {
      return enqueueGuestMutation(async () => {
        if (activeScopeRef.current !== scope) throw new Error('meeting scope changed');
        const local = createGuestMeeting(cleanTitle, options.clientRequestId);
        const next = [local, ...meetingsRef.current];
        await persistMeetingsStrict(next);
        if (generationRef.current !== operationGeneration || activeScopeRef.current !== scope) return local;
        meetingsRef.current = next;
        setMeetings(next);
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
    }, accessToken));
    if (generationRef.current !== operationGeneration || activeScopeRef.current !== scope) return created;
    setMeetings(prev => {
      const next = [created, ...prev.filter(item => item.id !== created.id)];
      meetingsRef.current = next;
      void persistMeetings(next);
      return next;
    });
    return created;
  }, [accessToken, enqueueGuestMutation, mode, persistMeetings, persistMeetingsStrict, scope]);

  const deleteMeeting = useCallback(async (id: string) => {
    const operationGeneration = generationRef.current;
    if (activeScopeRef.current !== scope) return;
    if (mode !== 'guest' && !accessToken) throw new Error('not authenticated');

    if (mode === 'guest') {
      return enqueueGuestMutation(async () => {
        if (generationRef.current !== operationGeneration || activeScopeRef.current !== scope) return;
        const target = meetingsRef.current.find(meeting => meeting.id === id) ?? null;
        if (!target) return;
        if (canResumeMeetingRecording(target)) throw new Error('请先结束并保存当前会议录音，再删除会议。');
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
        const cleanupResults = await Promise.allSettled([
          persistTranscripts(),
          persistSummaries(),
          deletePendingMeetingAudioUpload(scope, id),
          deleteNativeMeetingArtifacts(scope, id),
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
    if (target && canResumeMeetingRecording(target)) {
      throw new Error('请先结束并保存当前会议录音，再删除会议。');
    }
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

    const cleanupResults = await Promise.allSettled([
      persistMeetingsStrict(nextMeetings),
      persistTranscripts(),
      persistSummaries(),
      deletePendingMeetingAudioUpload(scope, id),
      deleteNativeMeetingArtifacts(scope, id),
      ...(target?.audioLocalUri
        ? [FileSystem.deleteAsync(target.audioLocalUri, { idempotent: true })]
        : []),
    ]);
    const failures = cleanupResults.filter(result => result.status === 'rejected').length;
    if (failures > 0) throw new MeetingDeletionCleanupError(failures);
  }, [accessToken, enqueueGuestMutation, meetingsKey, mode, persistMeetings, persistMeetingsStrict, persistSummaries, persistTranscripts, scope, summaryKey, transcriptKey]);

  const updateMeetingTitle = useCallback(async (id: string, title: string) => {
    const operationGeneration = generationRef.current;
    if (activeScopeRef.current !== scope) return;
    const cleanTitle = title.trim();
    if (!cleanTitle) return;
    if (mode === 'guest') {
      return enqueueGuestMutation(async () => {
        if (generationRef.current !== operationGeneration || activeScopeRef.current !== scope) return;
        const next = meetingsRef.current.map(meeting => (
          meeting.id === id ? { ...meeting, title: cleanTitle, updatedAt: new Date().toISOString() } : meeting
        ));
        await persistMeetingsStrict(next);
        if (generationRef.current !== operationGeneration || activeScopeRef.current !== scope) return;
        meetingsRef.current = next;
        setMeetings(next);
      });
    }
    if (!accessToken) throw new Error('not authenticated');
    const previousMeeting = meetingsRef.current.find(meeting => meeting.id === id) ?? null;
    const optimisticUpdatedAt = new Date().toISOString();
    setMeetings(prev => {
      const next = prev.map(m => m.id === id ? { ...m, title: cleanTitle, updatedAt: optimisticUpdatedAt } : m);
      meetingsRef.current = next;
      return next;
    });
    try {
      const updated = serverToLocal(await apiUpdateMeeting(id, { title: cleanTitle }, accessToken));
      if (generationRef.current !== operationGeneration || activeScopeRef.current !== scope) return;
      setMeetings(prev => {
        const next = prev.map(m => m.id === id
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
        void persistMeetings(next);
        return next;
      });
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
      }
      throw err;
    }
  }, [accessToken, enqueueGuestMutation, mode, persistMeetings, persistMeetingsStrict, scope]);

  const updateMeetingStatus = useCallback(async (id: string, status: string, patch: Partial<Meeting> = {}) => {
    const operationGeneration = generationRef.current;
    if (activeScopeRef.current !== scope) return false;
    if (mode === 'guest') {
      return enqueueGuestMutation(async () => {
        if (generationRef.current !== operationGeneration || activeScopeRef.current !== scope) return false;
        const next = meetingsRef.current.map(meeting => meeting.id === id
          ? { ...meeting, ...patch, status, tags: [statusTag(status), { label: '本机', color: C.teal }], updatedAt: new Date().toISOString() }
          : meeting);
        await persistMeetingsStrict(next);
        if (generationRef.current !== operationGeneration || activeScopeRef.current !== scope) return false;
        meetingsRef.current = next;
        setMeetings(next);
        return true;
      });
    }
    if (!accessToken) throw new Error('not authenticated');
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
      return true;
    } catch {
      return false;
    }
  }, [accessToken, enqueueGuestMutation, mode, persistMeetingsStrict, scope]);

  const getCachedTranscript = useCallback((id: string) => transcriptCacheRef.current[id] ?? [], []);
  const saveCachedTranscript = useCallback(async (id: string, transcript: TranscriptLine[]) => {
    const operationGeneration = generationRef.current;
    if (activeScopeRef.current !== scope) return;
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
    setMeetings(prev => {
      const next = prev.map(m => m.id === id ? { ...m, hasTranscript: transcript.length > 0 } : m);
      meetingsRef.current = next;
      void persistMeetings(next);
      return next;
    });
  }, [persistMeetings, persistTranscripts, scope]);

  const getCachedSummary = useCallback((id: string) => summaryCacheRef.current[id] ?? null, []);
  const saveCachedSummary = useCallback(async (id: string, summary: MeetingSummary | null) => {
    const operationGeneration = generationRef.current;
    if (activeScopeRef.current !== scope) return;
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
    setMeetings(prev => {
      const next = prev.map(m => m.id === id ? { ...m, hasSummary: Boolean(usableSummary) } : m);
      meetingsRef.current = next;
      void persistMeetings(next);
      return next;
    });
  }, [persistMeetings, persistSummaries, scope]);

  return (
    <MeetingsContext.Provider
      value={{
        meetings,
        loading,
        error,
        createMeeting,
        deleteMeeting,
        updateMeetingTitle,
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
