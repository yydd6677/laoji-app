import React from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as FileSystem from 'expo-file-system/legacy';
import { act, render, waitFor } from '@testing-library/react-native';
import {
  fetchAllMeetings,
  createMeeting as apiCreateMeeting,
  deleteMeeting as apiDeleteMeeting,
  updateMeeting as apiUpdateMeeting,
} from '../src/services/api';
import {
  MeetingDeletionCleanupError,
  MeetingsProvider,
  useMeetings,
} from '../src/store/MeetingsStore';
import { useAuth } from '../src/store/AuthStore';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

jest.mock('../src/store/AuthStore', () => ({ useAuth: jest.fn() }));
jest.mock('../src/services/api', () => ({
  fetchAllMeetings: jest.fn(),
  createMeeting: jest.fn(),
  deleteMeeting: jest.fn(),
  updateMeeting: jest.fn(),
}));

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

describe('MeetingsProvider lifecycle and cache', () => {
  let current: ReturnType<typeof useMeetings> | null = null;

  function Probe() {
    current = useMeetings();
    return null;
  }

  beforeEach(() => {
    jest.clearAllMocks();
    (AsyncStorage.setItem as jest.Mock).mockResolvedValue(undefined);
    (AsyncStorage.removeItem as jest.Mock).mockResolvedValue(undefined);
    (FileSystem.deleteAsync as jest.Mock).mockResolvedValue(undefined);
    current = null;
  });

  it('keeps user-scoped cached meetings visible when cloud refresh fails', async () => {
    (useAuth as jest.Mock).mockReturnValue({
      mode: 'authenticated',
      session: { user: { id: 9 } },
      accessToken: 'token-9',
    });
    const cached = [{
      id: 'cached-meeting',
      title: '离线会议',
      date: '2026年7月10日',
      duration: '—',
      tags: [],
      source: 'cloud',
    }];
    (AsyncStorage.getItem as jest.Mock).mockImplementation(async (key: string) => (
      key.includes('@laoji:meetings:v2:user:9') ? JSON.stringify(cached) : null
    ));
    (fetchAllMeetings as jest.Mock).mockRejectedValue(new Error('Network request failed'));

    await act(async () => {
      render(<MeetingsProvider><Probe /></MeetingsProvider>);
      await new Promise(resolve => setTimeout(resolve, 0));
    });

    await waitFor(() => expect(current?.loading).toBe(false));
    expect(current?.meetings.map(meeting => meeting.title)).toContain('离线会议');
    expect(current?.error).toBe('Network request failed');
  });

  it('uses explicit transcript and summary availability instead of ended status', async () => {
    (useAuth as jest.Mock).mockReturnValue({
      mode: 'authenticated',
      session: { user: { id: 9 } },
      accessToken: 'token-9',
    });
    (AsyncStorage.getItem as jest.Mock).mockResolvedValue(null);
    (fetchAllMeetings as jest.Mock).mockResolvedValue([{
      id: 'ended-empty',
      title: '无内容会议',
      status: 'ended',
      created_at: '2026-07-10T08:00:00+08:00',
      updated_at: '2026-07-10T08:10:00+08:00',
      transcript_count: 0,
      transcript_available: false,
      summary_available: false,
    }]);

    await act(async () => {
      render(<MeetingsProvider><Probe /></MeetingsProvider>);
      await new Promise(resolve => setTimeout(resolve, 0));
    });

    await waitFor(() => expect(current?.meetings).toHaveLength(1));
    expect(current?.meetings[0]).toEqual(expect.objectContaining({
      hasTranscript: false,
      hasSummary: false,
    }));
  });

  it('creates and persists guest meetings without calling the cloud create API', async () => {
    (useAuth as jest.Mock).mockReturnValue({ mode: 'guest', session: null, accessToken: null });
    (AsyncStorage.getItem as jest.Mock).mockResolvedValue(null);

    await act(async () => {
      render(<MeetingsProvider><Probe /></MeetingsProvider>);
      await new Promise(resolve => setTimeout(resolve, 0));
    });
    await act(async () => {
      await current?.createMeeting('游客评审会');
    });

    expect(apiCreateMeeting).not.toHaveBeenCalled();
    expect(current?.meetings[0]).toEqual(expect.objectContaining({
      title: '游客评审会',
      source: 'guest',
    }));
    expect(AsyncStorage.setItem).toHaveBeenCalledWith(
      '@laoji:meetings:v2:guest',
      expect.stringContaining('游客评审会'),
    );
  });

  it('does not expose an unsaved guest meeting when local persistence fails', async () => {
    (useAuth as jest.Mock).mockReturnValue({ mode: 'guest', session: null, accessToken: null });
    (AsyncStorage.getItem as jest.Mock).mockResolvedValue(null);
    (AsyncStorage.setItem as jest.Mock).mockImplementation(async (key: string) => {
      if (key === '@laoji:meetings:v2:guest') throw new Error('storage full');
    });

    await render(<MeetingsProvider><Probe /></MeetingsProvider>);
    await waitFor(() => expect(current?.loading).toBe(false));

    await act(async () => {
      await expect(current?.createMeeting('不能持久化的会议')).rejects.toThrow('storage full');
    });

    expect(current?.meetings).toEqual([]);
    expect(apiCreateMeeting).not.toHaveBeenCalled();
  });

  it('rolls back a guest transcript when durable cache persistence fails', async () => {
    (useAuth as jest.Mock).mockReturnValue({ mode: 'guest', session: null, accessToken: null });
    (AsyncStorage.getItem as jest.Mock).mockResolvedValue(null);

    await render(<MeetingsProvider><Probe /></MeetingsProvider>);
    await waitFor(() => expect(current?.loading).toBe(false));
    let createdId = '';
    await act(async () => {
      createdId = (await current!.createMeeting('必须可靠保存的访客会议')).id;
    });
    (AsyncStorage.setItem as jest.Mock).mockImplementation(async (key: string) => {
      if (key === '@laoji:meetingTranscripts:v1:guest') throw new Error('storage full');
    });

    await act(async () => {
      await expect(current!.saveCachedTranscript(createdId, [{ id: 'line-1', text: '不能假装已经保存' }]))
        .rejects.toThrow('storage full');
    });

    expect(current?.getCachedTranscript(createdId)).toEqual([]);
    expect(current?.meetings.find(item => item.id === createdId)?.hasTranscript).toBe(false);
  });

  it('does not let an older failed transcript write roll back a newer successful snapshot', async () => {
    (useAuth as jest.Mock).mockReturnValue({ mode: 'guest', session: null, accessToken: null });
    (AsyncStorage.getItem as jest.Mock).mockResolvedValue(null);

    await render(<MeetingsProvider><Probe /></MeetingsProvider>);
    await waitFor(() => expect(current?.loading).toBe(false));
    let createdId = '';
    await act(async () => {
      createdId = (await current!.createMeeting('并发转写会议')).id;
    });

    const firstWrite = deferred<void>();
    let transcriptWriteCount = 0;
    (AsyncStorage.setItem as jest.Mock).mockImplementation((key: string) => {
      if (key !== '@laoji:meetingTranscripts:v1:guest') return Promise.resolve();
      transcriptWriteCount += 1;
      return transcriptWriteCount === 1 ? firstWrite.promise : Promise.resolve();
    });
    const firstSnapshot = [{ id: 'line-1', text: '第一句' }];
    const secondSnapshot = [...firstSnapshot, { id: 'line-2', text: '第二句' }];

    let writes!: PromiseSettledResult<void>[];
    await act(async () => {
      const first = current!.saveCachedTranscript(createdId, firstSnapshot);
      const second = current!.saveCachedTranscript(createdId, secondSnapshot);
      const settled = Promise.allSettled([first, second]);
      await Promise.resolve();
      firstWrite.reject(new Error('first write failed'));
      writes = await settled;
    });

    expect(writes[0].status).toBe('rejected');
    expect(writes[1].status).toBe('fulfilled');
    expect(current?.getCachedTranscript(createdId)).toEqual(secondSnapshot);
    expect(current?.meetings.find(item => item.id === createdId)?.hasTranscript).toBe(true);
  });

  it('serializes concurrent guest meeting creation without losing either meeting', async () => {
    (useAuth as jest.Mock).mockReturnValue({ mode: 'guest', session: null, accessToken: null });
    (AsyncStorage.getItem as jest.Mock).mockResolvedValue(null);
    const firstWrite = deferred<void>();
    let guestWriteCount = 0;
    (AsyncStorage.setItem as jest.Mock).mockImplementation((key: string) => {
      if (key !== '@laoji:meetings:v2:guest') return Promise.resolve();
      guestWriteCount += 1;
      return guestWriteCount === 1 ? firstWrite.promise : Promise.resolve();
    });

    await render(<MeetingsProvider><Probe /></MeetingsProvider>);
    await waitFor(() => expect(current?.loading).toBe(false));

    let firstCreate!: ReturnType<NonNullable<typeof current>['createMeeting']>;
    let secondCreate!: ReturnType<NonNullable<typeof current>['createMeeting']>;
    await act(async () => {
      firstCreate = current!.createMeeting('并发会议 A');
      secondCreate = current!.createMeeting('并发会议 B');
      await new Promise(resolve => setTimeout(resolve, 0));
    });
    expect(guestWriteCount).toBe(1);

    await act(async () => {
      firstWrite.resolve();
      await Promise.all([firstCreate, secondCreate]);
    });

    expect(current?.meetings.map(meeting => meeting.title)).toEqual(['并发会议 B', '并发会议 A']);
    const guestWrites = (AsyncStorage.setItem as jest.Mock).mock.calls
      .filter(([key]) => key === '@laoji:meetings:v2:guest');
    expect(JSON.parse(guestWrites.at(-1)![1])).toEqual(expect.arrayContaining([
      expect.objectContaining({ title: '并发会议 A' }),
      expect.objectContaining({ title: '并发会议 B' }),
    ]));
  });

  it('clears the old scope immediately and discards a delayed refresh after switching accounts', async () => {
    let auth = {
      mode: 'authenticated',
      session: { user: { id: 'A' } },
      accessToken: 'token-A',
    };
    (useAuth as jest.Mock).mockImplementation(() => auth);
    (AsyncStorage.getItem as jest.Mock).mockImplementation(async (key: string) => {
      if (key === '@laoji:meetings:v2:user:A') {
        return JSON.stringify([{
          id: 'meeting-A',
          title: 'A 的缓存会议',
          date: '2026年7月11日',
          duration: '—',
          tags: [],
        }]);
      }
      if (key === '@laoji:meetingTranscripts:v1:user:A') {
        return JSON.stringify({ 'meeting-A': [{ id: 'line-A', text: 'A 的转写' }] });
      }
      if (key === '@laoji:meetingSummaries:v1:user:A') {
        return JSON.stringify({ 'meeting-A': { full_text: 'A 的总结' } });
      }
      return null;
    });
    const accountA = deferred<unknown[]>();
    const accountB = deferred<unknown[]>();
    (fetchAllMeetings as jest.Mock).mockImplementation((token?: string) => {
      if (token === 'token-A') return accountA.promise;
      if (token === 'token-B') return accountB.promise;
      return Promise.resolve([]);
    });

    const view = await render(<MeetingsProvider><Probe /></MeetingsProvider>);
    await waitFor(() => expect(fetchAllMeetings).toHaveBeenCalledWith('token-A'));
    await waitFor(() => expect(current?.meetings.map(meeting => meeting.title)).toContain('A 的缓存会议'));
    expect(current?.getCachedTranscript('meeting-A')).toHaveLength(1);
    expect(current?.getCachedSummary('meeting-A')).toEqual(expect.objectContaining({ full_text: 'A 的总结' }));

    auth = {
      mode: 'authenticated',
      session: { user: { id: 'B' } },
      accessToken: 'token-B',
    };
    await act(async () => {
      await view.rerender(<MeetingsProvider><Probe /></MeetingsProvider>);
    });
    expect(current?.meetings).toEqual([]);
    expect(current?.getCachedTranscript('meeting-A')).toEqual([]);
    expect(current?.getCachedSummary('meeting-A')).toBeNull();
    await waitFor(() => expect(fetchAllMeetings).toHaveBeenCalledWith('token-B'));

    await act(async () => {
      accountB.resolve([{
        id: 'meeting-B',
        title: 'B 的会议',
        status: 'ended',
        created_at: '2026-07-11T08:00:00+08:00',
        updated_at: '2026-07-11T09:00:00+08:00',
      }]);
      await accountB.promise;
    });
    await waitFor(() => expect(current?.meetings.map(meeting => meeting.title)).toEqual(['B 的会议']));

    await act(async () => {
      accountA.resolve([{
        id: 'meeting-A',
        title: 'A 的迟到会议',
        status: 'ended',
        created_at: '2026-07-11T08:00:00+08:00',
        updated_at: '2026-07-11T09:00:00+08:00',
      }]);
      await accountA.promise;
      await Promise.resolve();
    });

    expect(current?.meetings.map(meeting => meeting.title)).toEqual(['B 的会议']);
    expect(AsyncStorage.setItem).not.toHaveBeenCalledWith(
      '@laoji:meetings:v2:user:B',
      expect.stringContaining('A 的迟到会议'),
    );
  });

  it('rolls back an optimistic meeting title when cloud rename fails', async () => {
    (useAuth as jest.Mock).mockReturnValue({
      mode: 'authenticated',
      session: { user: { id: 9 } },
      accessToken: 'token-9',
    });
    const cachedMeeting = {
      id: 'rename-rollback',
      title: '原会议标题',
      date: '2026年7月13日',
      duration: '10:00',
      tags: [],
      source: 'cloud',
      updatedAt: '2026-07-13T08:00:00+08:00',
    };
    (AsyncStorage.getItem as jest.Mock).mockImplementation(async (key: string) => (
      key === '@laoji:meetings:v2:user:9' ? JSON.stringify([cachedMeeting]) : null
    ));
    (fetchAllMeetings as jest.Mock).mockRejectedValue(new Error('offline'));
    (apiUpdateMeeting as jest.Mock).mockRejectedValue(new Error('rename failed'));

    await render(<MeetingsProvider><Probe /></MeetingsProvider>);
    await waitFor(() => expect(current?.meetings).toHaveLength(1));

    await act(async () => {
      await expect(current!.updateMeetingTitle('rename-rollback', '未同步的新标题'))
        .rejects.toThrow('rename failed');
    });

    expect(current?.meetings[0]).toEqual(expect.objectContaining({
      title: '原会议标题',
      updatedAt: '2026-07-13T08:00:00+08:00',
    }));
    expect(AsyncStorage.setItem).not.toHaveBeenCalledWith(
      '@laoji:meetings:v2:user:9',
      expect.stringContaining('未同步的新标题'),
    );
  });

  it('restores the meeting, transcript, summary, and media cache when cloud deletion fails', async () => {
    (useAuth as jest.Mock).mockReturnValue({
      mode: 'authenticated',
      session: { user: { id: 9 } },
      accessToken: 'token-9',
    });
    const cachedMeeting = {
      id: 'rollback-meeting',
      title: '不可删除的会议',
      date: '2026年7月11日',
      duration: '12:34',
      tags: [],
      hasTranscript: true,
      hasSummary: true,
      audioAvailable: true,
      audioLocalUri: 'file:///tmp/rollback.m4a',
      audioDurationSec: 754,
      audioBars: [0.2, 0.8, 0.4],
      source: 'cloud',
    };
    const transcript = [{ id: 'line-1', text: '必须恢复的转写' }];
    const summary = { meeting_id: 'rollback-meeting', full_text: '必须恢复的总结' };
    (AsyncStorage.getItem as jest.Mock).mockImplementation(async (key: string) => {
      if (key === '@laoji:meetings:v2:user:9') return JSON.stringify([cachedMeeting]);
      if (key === '@laoji:meetingTranscripts:v1:user:9') {
        return JSON.stringify({ 'rollback-meeting': transcript });
      }
      if (key === '@laoji:meetingSummaries:v1:user:9') {
        return JSON.stringify({ 'rollback-meeting': summary });
      }
      return null;
    });
    (fetchAllMeetings as jest.Mock).mockRejectedValue(new Error('offline'));
    (apiDeleteMeeting as jest.Mock).mockRejectedValue(new Error('delete failed'));

    await render(<MeetingsProvider><Probe /></MeetingsProvider>);
    await waitFor(() => expect(current?.meetings).toHaveLength(1));
    await waitFor(() => expect(current?.loading).toBe(false));

    await act(async () => {
      await expect(current?.deleteMeeting('rollback-meeting')).rejects.toThrow('delete failed');
    });

    expect(current?.meetings).toEqual([expect.objectContaining(cachedMeeting)]);
    expect(current?.getCachedTranscript('rollback-meeting')).toEqual(transcript);
    expect(current?.getCachedSummary('rollback-meeting')).toEqual(summary);
    expect(FileSystem.deleteAsync).not.toHaveBeenCalledWith('file:///tmp/rollback.m4a', expect.anything());

    const storageCalls = (AsyncStorage.setItem as jest.Mock).mock.calls as [string, string][];
    const lastValueFor = (key: string) => storageCalls.filter(call => call[0] === key).slice(-1)[0]?.[1];
    expect(JSON.parse(lastValueFor('@laoji:meetings:v2:user:9')!)).toEqual([cachedMeeting]);
    expect(JSON.parse(lastValueFor('@laoji:meetingTranscripts:v1:user:9')!)).toEqual({
      'rollback-meeting': transcript,
    });
    expect(JSON.parse(lastValueFor('@laoji:meetingSummaries:v1:user:9')!)).toEqual({
      'rollback-meeting': summary,
    });
  });

  it('does not restore a cloud-deleted meeting when only local audio cleanup fails', async () => {
    (useAuth as jest.Mock).mockReturnValue({
      mode: 'authenticated',
      session: { user: { id: 9 } },
      accessToken: 'token-9',
    });
    const cachedMeeting = {
      id: 'deleted-remotely',
      title: '已从云端删除的会议',
      date: '2026年7月11日',
      duration: '02:00',
      tags: [],
      audioLocalUri: 'file:///tmp/cannot-delete.wav',
      source: 'cloud',
    };
    (AsyncStorage.getItem as jest.Mock).mockImplementation(async (key: string) => (
      key === '@laoji:meetings:v2:user:9' ? JSON.stringify([cachedMeeting]) : null
    ));
    (fetchAllMeetings as jest.Mock).mockRejectedValue(new Error('offline'));
    (apiDeleteMeeting as jest.Mock).mockResolvedValue(undefined);
    (FileSystem.deleteAsync as jest.Mock).mockRejectedValue(new Error('file busy'));

    await render(<MeetingsProvider><Probe /></MeetingsProvider>);
    await waitFor(() => expect(current?.meetings).toHaveLength(1));
    await waitFor(() => expect(current?.loading).toBe(false));

    await act(async () => {
      await expect(current?.deleteMeeting('deleted-remotely'))
        .rejects.toBeInstanceOf(MeetingDeletionCleanupError);
    });

    expect(apiDeleteMeeting).toHaveBeenCalledWith('deleted-remotely', 'token-9');
    expect(current?.meetings).toEqual([]);
  });

  it('preserves and retries a final meeting status that the cloud has not accepted yet', async () => {
    (useAuth as jest.Mock).mockReturnValue({
      mode: 'authenticated',
      session: { user: { id: 9 } },
      accessToken: 'token-9',
    });
    const remoteRecording = {
      id: 'status-pending',
      title: '断网结束的会议',
      status: 'recording',
      created_at: '2026-07-11T08:00:00+08:00',
      updated_at: '2026-07-11T08:01:00+08:00',
      transcript_available: true,
    };
    (AsyncStorage.getItem as jest.Mock).mockResolvedValue(null);
    (fetchAllMeetings as jest.Mock).mockResolvedValue([remoteRecording]);
    (apiUpdateMeeting as jest.Mock).mockRejectedValue(new Error('offline'));

    await render(<MeetingsProvider><Probe /></MeetingsProvider>);
    await waitFor(() => expect(current?.meetings).toHaveLength(1));

    let synced = true;
    await act(async () => {
      synced = await current!.updateMeetingStatus('status-pending', 'ended', {
        audioLocalUri: 'file:///tmp/status-pending.wav',
        audioAvailable: true,
      });
    });
    expect(synced).toBe(false);
    expect(current?.meetings[0]).toEqual(expect.objectContaining({
      status: 'ended',
      statusSyncPending: true,
      audioLocalUri: 'file:///tmp/status-pending.wav',
    }));

    await act(async () => {
      await current!.refreshMeetings();
    });
    expect(current?.meetings[0]).toEqual(expect.objectContaining({
      status: 'ended',
      statusSyncPending: true,
    }));

    (apiUpdateMeeting as jest.Mock).mockResolvedValue({
      ...remoteRecording,
      status: 'ended',
      updated_at: '2026-07-11T08:05:00+08:00',
    });
    await act(async () => {
      await current!.refreshMeetings();
    });
    expect(current?.meetings[0]).toEqual(expect.objectContaining({
      status: 'ended',
      statusSyncPending: false,
    }));
  });
});
