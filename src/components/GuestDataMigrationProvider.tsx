import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { inspectGuestDataMigration, migrateGuestData } from '../services/guestDataMigration';
import { useAuth } from '../store/AuthStore';
import { useEvents } from '../store/EventsStore';
import { useMeetings } from '../store/MeetingsStore';
import { useAppDialog } from './AppDialog';

type GuestDataMigrationContextValue = {
  migrationBusy: boolean;
  mergeGuestData: () => Promise<void>;
};

const GuestDataMigrationContext = createContext<GuestDataMigrationContextValue | null>(null);

function countMessage(preview: {
  eventCount: number;
  meetingCount: number;
  audioCount: number;
  transcriptCount: number;
  summaryCount: number;
}): string {
  const parts = [
    preview.eventCount > 0 ? `${preview.eventCount} 条日程` : '',
    preview.meetingCount > 0 ? `${preview.meetingCount} 条会议记录` : '',
    preview.audioCount > 0 ? `${preview.audioCount} 份录音` : '',
    preview.transcriptCount > 0 ? `${preview.transcriptCount} 份转写` : '',
    preview.summaryCount > 0 ? `${preview.summaryCount} 份总结` : '',
  ].filter(Boolean);
  return parts.join('、');
}

export function GuestDataMigrationProvider({ children }: { children: React.ReactNode }) {
  const { mode, session, accessToken } = useAuth();
  const { refreshMeetings } = useMeetings();
  const { refreshEvents } = useEvents();
  const { showDialog } = useAppDialog();
  const [migrationBusy, setMigrationBusy] = useState(false);
  const busyRef = useRef(false);
  const previousModeRef = useRef(mode);
  const promptedSessionRef = useRef('');

  const mergeGuestData = useCallback(async () => {
    if (busyRef.current) return;
    if (mode !== 'authenticated' || !session || !accessToken) {
      showDialog({
        title: '请先登录',
        message: '登录账号后才能合并访客数据。',
        tone: 'info',
      });
      return;
    }
    busyRef.current = true;
    setMigrationBusy(true);
    try {
      const userId = String(session.user.id);
      const preview = await inspectGuestDataMigration(userId);
      if (preview.pendingCount === 0) {
        showDialog({ title: '没有待合并数据', message: '访客数据已经合并完成。', tone: 'info' });
        return;
      }
      const result = await migrateGuestData(userId, accessToken);
      const now = new Date();
      await Promise.allSettled([
        refreshMeetings(),
        refreshEvents(now.getFullYear(), now.getMonth() + 1),
      ]);
      if (result.pendingCount === 0) {
        showDialog({
          title: '访客数据已合并',
          message: `已合并 ${result.migratedEvents} 条日程和 ${result.migratedMeetings} 条会议记录。访客源数据仍保留在本机。`,
          tone: 'success',
        });
      } else {
        showDialog({
          title: '部分数据尚未合并',
          message: `已有 ${result.migratedEvents + result.migratedMeetings} 项完成，另有 ${result.pendingCount} 项可稍后重试。`,
          tone: 'warning',
        });
      }
    } catch {
      showDialog({
        title: '合并未完成',
        message: '访客数据仍保留在本机，请稍后在设置中重试。',
        tone: 'error',
      });
    } finally {
      busyRef.current = false;
      setMigrationBusy(false);
    }
  }, [accessToken, mode, refreshEvents, refreshMeetings, session, showDialog]);

  useEffect(() => {
    const previousMode = previousModeRef.current;
    previousModeRef.current = mode;
    if (
      previousMode !== 'guest'
      || mode !== 'authenticated'
      || !session
      || !accessToken
      || promptedSessionRef.current === String(session.user.id)
    ) return;
    const userId = String(session.user.id);
    promptedSessionRef.current = userId;
    let active = true;
    void inspectGuestDataMigration(userId).then(preview => {
      if (!active || preview.pendingCount === 0) return;
      showDialog({
        title: '合并访客数据',
        message: `检测到${countMessage(preview)}。可将它们合并到当前账号；声纹资料不迁移。`,
        tone: 'info',
        actions: [
          { text: '立即合并', role: 'primary', onPress: mergeGuestData },
          { text: '稍后处理', role: 'cancel' },
        ],
      });
    }).catch(() => {});
    return () => { active = false; };
  }, [accessToken, mergeGuestData, mode, session, showDialog]);

  const value = useMemo(() => ({ migrationBusy, mergeGuestData }), [mergeGuestData, migrationBusy]);
  return (
    <GuestDataMigrationContext.Provider value={value}>
      {children}
    </GuestDataMigrationContext.Provider>
  );
}

export function useGuestDataMigration(): GuestDataMigrationContextValue {
  const value = useContext(GuestDataMigrationContext);
  if (!value) throw new Error('useGuestDataMigration must be used inside GuestDataMigrationProvider');
  return value;
}
