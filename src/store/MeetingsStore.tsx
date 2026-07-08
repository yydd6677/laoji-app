import React, { createContext, useContext, useState, useEffect, useCallback } from 'react';
import { Meeting } from '../types';
import { fetchMeetings, deleteMeeting as apiDeleteMeeting, updateMeeting as apiUpdateMeeting, ApiMeeting } from '../services/api';

function isFinishedStatus(status: string): boolean {
  return ['completed', 'ended', 'done', 'processed'].includes(status);
}

function serverToLocal(m: ApiMeeting): Meeting {
  const d = new Date(m.created_at);
  const dateStr = Number.isNaN(d.getTime())
    ? m.created_at
    : `${d.getFullYear()}年${d.getMonth()+1}月${d.getDate()}日`;
  const timeStr = Number.isNaN(d.getTime())
    ? undefined
    : `${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`;
  const finished = isFinishedStatus(m.status);
  return {
    id: m.id,
    title: m.title,
    date: dateStr,
    time: timeStr,
    duration: '—',
    tags: finished
      ? [{ label: '已完成', color: '#52C41A' }]
      : [{ label: m.status, color: '#7B5CB8' }],
    participants: m.participants ?? [],
    hasTranscript: finished,
    hasSummary: finished,
    status: m.status,
  };
}

interface MeetingsContextType {
  meetings: Meeting[];
  loading: boolean;
  error: string | null;
  deleteMeeting: (id: string) => Promise<void>;
  updateMeetingTitle: (id: string, title: string) => Promise<void>;
  refreshMeetings: () => Promise<void>;
}

const MeetingsContext = createContext<MeetingsContextType | null>(null);

export function MeetingsProvider({ children }: { children: React.ReactNode }) {
  const [meetings, setMeetings] = useState<Meeting[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refreshMeetings = useCallback(async () => {
    setLoading(true);
    try {
      const data = await fetchMeetings(1, 50);
      setMeetings(data.map(serverToLocal));
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : '会议服务暂时不可用');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { refreshMeetings(); }, []);

  const deleteMeeting = useCallback(async (id: string) => {
    const target = meetings.find(m => m.id === id) ?? null;
    setMeetings(prev => prev.filter(m => m.id !== id));
    try {
      await apiDeleteMeeting(id);
    } catch (err) {
      if (target) setMeetings(prev => prev.some(m => m.id === id) ? prev : [target, ...prev]);
      throw err;
    }
  }, [meetings]);

  const updateMeetingTitle = useCallback(async (id: string, title: string) => {
    setMeetings(prev => prev.map(m => m.id === id ? { ...m, title } : m));
    try {
      const updated = await apiUpdateMeeting(id, { title });
      setMeetings(prev => prev.map(m => m.id === id ? serverToLocal(updated) : m));
    } catch (err) {
      await refreshMeetings();
      throw err;
    }
  }, [refreshMeetings]);

  return (
    <MeetingsContext.Provider value={{ meetings, loading, error, deleteMeeting, updateMeetingTitle, refreshMeetings }}>
      {children}
    </MeetingsContext.Provider>
  );
}

export function useMeetings() {
  const ctx = useContext(MeetingsContext);
  if (!ctx) throw new Error('useMeetings must be used inside MeetingsProvider');
  return ctx;
}
