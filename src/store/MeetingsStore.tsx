import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { Meeting, MeetingSummary, TranscriptLine } from '../types';
import {
  ApiMeeting,
  createMeeting as apiCreateMeeting,
  deleteMeeting as apiDeleteMeeting,
  fetchMeetings,
  updateMeeting as apiUpdateMeeting,
} from '../services/api';
import { useAuth } from './AuthStore';
import { Colors as C } from '../theme/colors';

const MEETINGS_CACHE_KEY = '@laoji:meetings:v2';
const TRANSCRIPT_CACHE_KEY = '@laoji:meetingTranscripts:v1';
const SUMMARY_CACHE_KEY = '@laoji:meetingSummaries:v1';

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

function serverToLocal(m: ApiMeeting): Meeting {
  const { date, time } = formatDateTime(m.created_at);
  const finished = isFinishedStatus(m.status);
  return {
    id: m.id,
    title: m.title,
    date,
    time,
    duration: m.audio_duration_sec ? `${Math.max(1, Math.round(m.audio_duration_sec / 60))} 分钟` : '—',
    tags: [statusTag(m.status), ...(m.mode ? [{ label: m.mode === 'offline' ? '离线' : '实时', color: C.blue }] : [])],
    participants: m.participants ?? [],
    hasTranscript: finished,
    hasSummary: finished,
    status: m.status,
    mode: m.mode ?? 'realtime',
    description: m.description ?? null,
    createdAt: m.created_at,
    updatedAt: m.updated_at,
    audioAvailable: Boolean(m.audio_available),
    source: 'cloud',
  };
}

function createGuestMeeting(title: string, now = new Date()): Meeting {
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
    source: 'guest',
  };
}

async function loadJson<T>(key: string, fallback: T): Promise<T> {
  try {
    const raw = await AsyncStorage.getItem(key);
    return raw ? JSON.parse(raw) as T : fallback;
  } catch {
    return fallback;
  }
}

async function persistJson(key: string, value: unknown): Promise<void> {
  try {
    await AsyncStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Cache failures should not block the main meeting flow.
  }
}

interface MeetingsContextType {
  meetings: Meeting[];
  loading: boolean;
  error: string | null;
  createMeeting: (title: string, options?: { description?: string | null; participants?: string[]; mode?: ApiMeeting['mode'] }) => Promise<Meeting>;
  deleteMeeting: (id: string) => Promise<void>;
  updateMeetingTitle: (id: string, title: string) => Promise<void>;
  updateMeetingStatus: (id: string, status: string, patch?: Partial<Meeting>) => Promise<void>;
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

  const scope = useMemo(() => {
    if (mode === 'authenticated' && session) return `user:${session.user.id}`;
    if (mode === 'guest') return 'guest';
    return 'signed_out';
  }, [mode, session?.user.id]);

  const meetingsKey = `${MEETINGS_CACHE_KEY}:${scope}`;
  const transcriptKey = `${TRANSCRIPT_CACHE_KEY}:${scope}`;
  const summaryKey = `${SUMMARY_CACHE_KEY}:${scope}`;

  const persistMeetings = useCallback((next: Meeting[]) => persistJson(meetingsKey, next), [meetingsKey]);
  const persistTranscripts = useCallback(() => persistJson(transcriptKey, transcriptCacheRef.current), [transcriptKey]);
  const persistSummaries = useCallback(() => persistJson(summaryKey, summaryCacheRef.current), [summaryKey]);

  const refreshMeetings = useCallback(async () => {
    if (mode === 'signed_out') {
      setMeetings([]);
      return;
    }
    if (mode === 'guest') {
      return;
    }
    if (!accessToken) return;

    setLoading(true);
    try {
      const data = await fetchMeetings(1, 100, accessToken);
      const local = data.map(serverToLocal);
      setMeetings(local);
      void persistMeetings(local);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : '会议服务暂时不可用');
    } finally {
      setLoading(false);
    }
  }, [accessToken, mode, persistMeetings]);

  useEffect(() => {
    let alive = true;
    async function loadForScope() {
      setError(null);
      setLoading(true);
      try {
        const [cachedMeetings, cachedTranscripts, cachedSummaries] = await Promise.all([
          loadJson<Meeting[]>(meetingsKey, []),
          loadJson<Record<string, TranscriptLine[]>>(transcriptKey, {}),
          loadJson<Record<string, MeetingSummary | null>>(summaryKey, {}),
        ]);
        if (!alive) return;
        transcriptCacheRef.current = cachedTranscripts;
        summaryCacheRef.current = cachedSummaries;
        setMeetings(cachedMeetings);
        if (mode === 'authenticated') await refreshMeetings();
        if (mode === 'signed_out') setMeetings([]);
      } finally {
        if (alive) setLoading(false);
      }
    }
    void loadForScope();
    return () => { alive = false; };
  }, [meetingsKey, mode, refreshMeetings, summaryKey, transcriptKey]);

  const createMeeting = useCallback(async (
    title: string,
    options: { description?: string | null; participants?: string[]; mode?: ApiMeeting['mode'] } = {},
  ): Promise<Meeting> => {
    const cleanTitle = title.trim() || '未命名会议';
    if (mode === 'guest') {
      const local = createGuestMeeting(cleanTitle);
      setMeetings(prev => {
        const next = [local, ...prev];
        void persistMeetings(next);
        return next;
      });
      return local;
    }
    if (!accessToken) throw new Error('not authenticated');
    const created = serverToLocal(await apiCreateMeeting({
      title: cleanTitle,
      description: options.description ?? null,
      participants: options.participants ?? [],
      mode: options.mode ?? 'realtime',
    }, accessToken));
    setMeetings(prev => {
      const next = [created, ...prev.filter(item => item.id !== created.id)];
      void persistMeetings(next);
      return next;
    });
    return created;
  }, [accessToken, mode, persistMeetings]);

  const deleteMeeting = useCallback(async (id: string) => {
    const target = meetings.find(m => m.id === id) ?? null;
    setMeetings(prev => {
      const next = prev.filter(m => m.id !== id);
      void persistMeetings(next);
      return next;
    });
    delete transcriptCacheRef.current[id];
    delete summaryCacheRef.current[id];
    void persistTranscripts();
    void persistSummaries();

    if (mode === 'guest') return;
    if (!accessToken) throw new Error('not authenticated');
    try {
      await apiDeleteMeeting(id, accessToken);
    } catch (err) {
      if (target) {
        setMeetings(prev => {
          const next = prev.some(m => m.id === id) ? prev : [target, ...prev];
          void persistMeetings(next);
          return next;
        });
      }
      throw err;
    }
  }, [accessToken, meetings, mode, persistMeetings, persistSummaries, persistTranscripts]);

  const updateMeetingTitle = useCallback(async (id: string, title: string) => {
    const cleanTitle = title.trim();
    if (!cleanTitle) return;
    setMeetings(prev => {
      const next = prev.map(m => m.id === id ? { ...m, title: cleanTitle, updatedAt: new Date().toISOString() } : m);
      void persistMeetings(next);
      return next;
    });
    if (mode === 'guest') return;
    if (!accessToken) throw new Error('not authenticated');
    try {
      const updated = serverToLocal(await apiUpdateMeeting(id, { title: cleanTitle }, accessToken));
      setMeetings(prev => {
        const next = prev.map(m => m.id === id ? { ...m, ...updated } : m);
        void persistMeetings(next);
        return next;
      });
    } catch (err) {
      await refreshMeetings();
      throw err;
    }
  }, [accessToken, mode, persistMeetings, refreshMeetings]);

  const updateMeetingStatus = useCallback(async (id: string, status: string, patch: Partial<Meeting> = {}) => {
    setMeetings(prev => {
      const next = prev.map(m => m.id === id
        ? { ...m, ...patch, status, tags: [statusTag(status), ...(m.source === 'guest' ? [{ label: '本机', color: C.teal }] : [])], updatedAt: new Date().toISOString() }
        : m);
      void persistMeetings(next);
      return next;
    });
    if (mode === 'guest') return;
    if (!accessToken) throw new Error('not authenticated');
    try {
      const updated = serverToLocal(await apiUpdateMeeting(id, { status }, accessToken));
      setMeetings(prev => {
        const next = prev.map(m => m.id === id ? { ...m, ...updated, ...patch } : m);
        void persistMeetings(next);
        return next;
      });
    } catch {
      // Keep local status so the user does not lose the active recording state.
    }
  }, [accessToken, mode, persistMeetings]);

  const getCachedTranscript = useCallback((id: string) => transcriptCacheRef.current[id] ?? [], []);
  const saveCachedTranscript = useCallback(async (id: string, transcript: TranscriptLine[]) => {
    transcriptCacheRef.current = { ...transcriptCacheRef.current, [id]: transcript };
    await persistTranscripts();
    setMeetings(prev => {
      const next = prev.map(m => m.id === id ? { ...m, hasTranscript: transcript.length > 0 } : m);
      void persistMeetings(next);
      return next;
    });
  }, [persistMeetings, persistTranscripts]);

  const getCachedSummary = useCallback((id: string) => summaryCacheRef.current[id] ?? null, []);
  const saveCachedSummary = useCallback(async (id: string, summary: MeetingSummary | null) => {
    summaryCacheRef.current = { ...summaryCacheRef.current, [id]: summary };
    await persistSummaries();
    setMeetings(prev => {
      const next = prev.map(m => m.id === id ? { ...m, hasSummary: Boolean(summary) } : m);
      void persistMeetings(next);
      return next;
    });
  }, [persistMeetings, persistSummaries]);

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
