import React from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as FileSystem from 'expo-file-system/legacy';
import { AppState } from 'react-native';
import { act, render, waitFor } from '@testing-library/react-native';
import {
  fetchAllMeetings,
  createMeeting as apiCreateMeeting,
  deleteMeeting as apiDeleteMeeting,
  uploadMeetingAudio,
  updateMeeting as apiUpdateMeeting,
} from '../src/services/api';
import {
  MeetingDeletionCleanupError,
  MeetingsProvider,
  useMeetings,
} from '../src/store/MeetingsStore';
import { useAuth } from '../src/store/AuthStore';
import { resetMeetingRecordingStateForTests } from '../src/services/meetingRecording';
import { resetAppStorageQueueForTests } from '../src/services/appStorage';
import { HttpResponseError } from '../src/services/errors';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

jest.mock('../src/store/AuthStore', () => ({ useAuth: jest.fn() }));
jest.mock('../src/services/api', () => ({
  fetchAllMeetings: jest.fn(),
  createMeeting: jest.fn(),
  deleteMeeting: jest.fn(),
  uploadMeetingAudio: jest.fn(),
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

function pendingAudioRecord(meetingId: string, audioUri = `file:///tmp/${meetingId}.wav`) {
  return {
    meetingId,
    audioUri,
    fileName: `${meetingId}.wav`,
    mimeType: 'audio/wav',
    createdAt: '2026-07-14T00:00:00.000Z',
    lastAttemptAt: '2026-07-14T00:00:00.000Z',
    attemptCount: 2,
  };
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
    (uploadMeetingAudio as jest.Mock).mockResolvedValue(null);
    (AppState.addEventListener as jest.Mock).mockImplementation(() => ({ remove: jest.fn() }));
    AppState.currentState = 'active';
    resetAppStorageQueueForTests();
    resetMeetingRecordingStateForTests();
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
    expect(JSON.parse(lastValueFor('@laoji:meetings:v2:user:9')!)).toEqual([
      { ...cachedMeeting, audioSyncPending: false, audioSyncBlocked: false },
    ]);
    expect(JSON.parse(lastValueFor('@laoji:meetingTranscripts:v1:user:9')!)).toEqual({
      'rollback-meeting': transcript,
    });
    expect(JSON.parse(lastValueFor('@laoji:meetingSummaries:v1:user:9')!)).toEqual({
      'rollback-meeting': summary,
    });
  });

  it('treats an already missing cloud meeting as deleted and removes its local recording state', async () => {
    (useAuth as jest.Mock).mockReturnValue({
      mode: 'authenticated',
      session: { user: { id: 9 } },
      accessToken: 'token-9',
    });
    const meetingId = 'already-deleted-cloud-meeting';
    const cachedMeeting = {
      id: meetingId,
      title: '云端已删除会议',
      date: '2026年7月11日',
      duration: '30:00',
      tags: [{ label: '上传受阻', color: '#FF4D4F' }],
      audioLocalUri: `file:///tmp/${meetingId}.wav`,
      audioSyncPending: true,
      audioSyncBlocked: true,
      source: 'cloud',
    };
    const storage = new Map<string, string>([
      ['@laoji:meetings:v2:user:9', JSON.stringify([cachedMeeting])],
      ['@laoji:pendingMeetingAudioUploads:v2:user:9', JSON.stringify({
        [meetingId]: {
          ...pendingAudioRecord(meetingId),
          uploadState: 'blocked',
          failureCode: 'meeting_missing',
        },
      })],
    ]);
    (AsyncStorage.getItem as jest.Mock).mockImplementation(async (key: string) => storage.get(key) ?? null);
    (AsyncStorage.setItem as jest.Mock).mockImplementation(async (key: string, value: string) => {
      storage.set(key, value);
    });
    (AsyncStorage.removeItem as jest.Mock).mockImplementation(async (key: string) => {
      storage.delete(key);
    });
    (fetchAllMeetings as jest.Mock).mockRejectedValue(new Error('offline'));
    (apiDeleteMeeting as jest.Mock).mockRejectedValue(new HttpResponseError('not found', 404));

    await render(<MeetingsProvider><Probe /></MeetingsProvider>);
    await waitFor(() => expect(current?.meetings).toHaveLength(1));

    await act(async () => {
      await expect(current?.deleteMeeting(meetingId)).resolves.toBeUndefined();
    });

    expect(current?.meetings).toEqual([]);
    expect(FileSystem.deleteAsync).toHaveBeenCalledWith(
      `file:///tmp/${meetingId}.wav`,
      { idempotent: true },
    );
    expect(storage.has('@laoji:pendingMeetingAudioUploads:v2:user:9')).toBe(false);
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

  it('retains and retries a status-pending local meeting omitted by the cloud list', async () => {
    (useAuth as jest.Mock).mockReturnValue({
      mode: 'authenticated',
      session: { user: { id: 9 } },
      accessToken: 'token-9',
    });
    const cachedMeeting = {
      id: 'missing-status-pending',
      title: '云端暂缺的结束会议',
      date: '2026年7月14日',
      duration: '12:00',
      tags: [{ label: '已完成', color: '#52C41A' }, { label: '待同步', color: '#FF9500' }],
      status: 'ended',
      statusSyncPending: true,
      source: 'cloud',
    };
    (AsyncStorage.getItem as jest.Mock).mockImplementation(async (key: string) => (
      key === '@laoji:meetings:v2:user:9' ? JSON.stringify([cachedMeeting]) : null
    ));
    (fetchAllMeetings as jest.Mock).mockResolvedValue([]);
    (apiUpdateMeeting as jest.Mock).mockRejectedValue(new Error('not visible yet'));

    await render(<MeetingsProvider><Probe /></MeetingsProvider>);
    await waitFor(() => expect(apiUpdateMeeting).toHaveBeenCalledWith(
      'missing-status-pending',
      { status: 'ended' },
      'token-9',
    ));
    expect(current?.meetings).toEqual([
      expect.objectContaining({
        id: 'missing-status-pending',
        statusSyncPending: true,
        tags: expect.arrayContaining([expect.objectContaining({ label: '待同步' })]),
      }),
    ]);
  });

  it('drops a cloud meeting omitted by an authoritative refresh when no local work is pending', async () => {
    (useAuth as jest.Mock).mockReturnValue({
      mode: 'authenticated',
      session: { user: { id: 9 } },
      accessToken: 'token-9',
    });
    (AsyncStorage.getItem as jest.Mock).mockImplementation(async (key: string) => (
      key === '@laoji:meetings:v2:user:9'
        ? JSON.stringify([{
            id: 'deleted-in-cloud',
            title: '已在其他设备删除',
            date: '2026年7月14日',
            duration: '08:00',
            tags: [{ label: '已完成', color: '#52C41A' }],
            source: 'cloud',
          }])
        : null
    ));
    (fetchAllMeetings as jest.Mock).mockResolvedValue([]);

    await render(<MeetingsProvider><Probe /></MeetingsProvider>);
    await waitFor(() => expect(current?.loading).toBe(false));
    expect(current?.meetings).toEqual([]);
    expect(apiUpdateMeeting).not.toHaveBeenCalled();
    expect(uploadMeetingAudio).not.toHaveBeenCalled();
  });

  it('resumes every persisted recording upload after a cold start and clears the visible pending state', async () => {
    (useAuth as jest.Mock).mockReturnValue({
      mode: 'authenticated',
      session: { user: { id: 9 } },
      accessToken: 'token-9',
    });
    const meetingId = 'cold-start-audio';
    const cachedMeeting = {
      id: meetingId,
      title: '冷启动恢复会议',
      date: '2026年7月14日',
      duration: '35:00',
      tags: [{ label: '已完成', color: '#52C41A' }],
      audioLocalUri: `file:///tmp/${meetingId}.wav`,
      source: 'cloud',
    };
    const pending = pendingAudioRecord(meetingId);
    const storage = new Map<string, string>([
      ['@laoji:meetings:v2:user:9', JSON.stringify([cachedMeeting])],
      ['@laoji:pendingMeetingAudioUploads:v2:user:9', JSON.stringify({ [meetingId]: pending })],
    ]);
    (AsyncStorage.getItem as jest.Mock).mockImplementation(async (key: string) => storage.get(key) ?? null);
    (AsyncStorage.setItem as jest.Mock).mockImplementation(async (key: string, value: string) => {
      storage.set(key, value);
    });
    (AsyncStorage.removeItem as jest.Mock).mockImplementation(async (key: string) => {
      storage.delete(key);
    });
    (fetchAllMeetings as jest.Mock).mockResolvedValue([{
      id: meetingId,
      title: '冷启动恢复会议',
      status: 'ended',
      created_at: '2026-07-14T08:00:00+08:00',
      updated_at: '2026-07-14T08:35:00+08:00',
      audio_available: false,
    }]);
    const upload = deferred<null>();
    (uploadMeetingAudio as jest.Mock).mockReturnValue(upload.promise);

    await render(<MeetingsProvider><Probe /></MeetingsProvider>);
    await waitFor(() => expect(uploadMeetingAudio).toHaveBeenCalledWith(
      meetingId,
      `file:///tmp/${meetingId}.wav`,
      'token-9',
      { fileName: `${meetingId}.wav`, mimeType: 'audio/wav' },
    ));
    expect(current?.meetings[0]).toEqual(expect.objectContaining({
      audioSyncPending: true,
      tags: expect.arrayContaining([expect.objectContaining({ label: '待上传' })]),
    }));
    await act(async () => {
      await current!.refreshMeetings();
    });
    expect(uploadMeetingAudio).toHaveBeenCalledTimes(1);

    await act(async () => {
      upload.resolve(null);
      await upload.promise;
    });
    await waitFor(() => expect(current?.meetings[0]).toEqual(expect.objectContaining({
      audioSyncPending: false,
    })));
    expect(current?.meetings[0].tags.some(tag => tag.label === '待上传')).toBe(false);
    expect(storage.has('@laoji:pendingMeetingAudioUploads:v2:user:9')).toBe(false);
    expect(fetchAllMeetings).toHaveBeenCalledTimes(3);
  });

  it('keeps a permanently rejected recording visible without retrying it on lifecycle refreshes', async () => {
    (useAuth as jest.Mock).mockReturnValue({
      mode: 'authenticated',
      session: { user: { id: 9 } },
      accessToken: 'token-9',
    });
    const meetingId = 'blocked-audio';
    const cachedMeeting = {
      id: meetingId,
      title: '上传受阻会议',
      date: '2026年7月14日',
      duration: '60:00',
      tags: [{ label: '已完成', color: '#52C41A' }],
      audioLocalUri: `file:///tmp/${meetingId}.wav`,
      source: 'cloud',
    };
    const pending = {
      ...pendingAudioRecord(meetingId),
      uploadState: 'blocked',
      failureCode: 'file_too_large',
      failureMessage: '录音文件超过云端上传上限，仍保存在本机。',
    };
    const storage = new Map<string, string>([
      ['@laoji:meetings:v2:user:9', JSON.stringify([cachedMeeting])],
      ['@laoji:pendingMeetingAudioUploads:v2:user:9', JSON.stringify({ [meetingId]: pending })],
    ]);
    (AsyncStorage.getItem as jest.Mock).mockImplementation(async (key: string) => storage.get(key) ?? null);
    (AsyncStorage.setItem as jest.Mock).mockImplementation(async (key: string, value: string) => {
      storage.set(key, value);
    });
    (AsyncStorage.removeItem as jest.Mock).mockImplementation(async (key: string) => {
      storage.delete(key);
    });
    (fetchAllMeetings as jest.Mock).mockResolvedValue([{
      id: meetingId,
      title: cachedMeeting.title,
      status: 'ended',
      created_at: '2026-07-14T08:00:00+08:00',
      updated_at: '2026-07-14T09:00:00+08:00',
      audio_available: false,
    }]);

    await render(<MeetingsProvider><Probe /></MeetingsProvider>);
    await waitFor(() => expect(current?.meetings[0]).toEqual(expect.objectContaining({
      audioSyncPending: true,
      audioSyncBlocked: true,
      tags: expect.arrayContaining([expect.objectContaining({ label: '上传受阻' })]),
    })));
    expect(uploadMeetingAudio).not.toHaveBeenCalled();

    await act(async () => {
      await current!.refreshMeetings();
    });
    expect(uploadMeetingAudio).not.toHaveBeenCalled();
    expect(storage.has('@laoji:pendingMeetingAudioUploads:v2:user:9')).toBe(true);
  });

  it('keeps only failed recordings pending when a cold-start batch partially succeeds', async () => {
    (useAuth as jest.Mock).mockReturnValue({
      mode: 'authenticated',
      session: { user: { id: 9 } },
      accessToken: 'token-9',
    });
    const meetingIds = ['audio-success', 'audio-failure'];
    const cachedMeetings = meetingIds.map((id, index) => ({
      id,
      title: index === 0 ? '可同步会议' : '暂未同步会议',
      date: '2026年7月14日',
      duration: '20:00',
      tags: [{ label: '已完成', color: '#52C41A' }],
      audioLocalUri: `file:///tmp/${id}.wav`,
      source: 'cloud',
    }));
    const pendingRecords = Object.fromEntries(meetingIds.map(id => [id, pendingAudioRecord(id)]));
    const storage = new Map<string, string>([
      ['@laoji:meetings:v2:user:9', JSON.stringify(cachedMeetings)],
      ['@laoji:pendingMeetingAudioUploads:v2:user:9', JSON.stringify(pendingRecords)],
    ]);
    (AsyncStorage.getItem as jest.Mock).mockImplementation(async (key: string) => storage.get(key) ?? null);
    (AsyncStorage.setItem as jest.Mock).mockImplementation(async (key: string, value: string) => {
      storage.set(key, value);
    });
    (AsyncStorage.removeItem as jest.Mock).mockImplementation(async (key: string) => {
      storage.delete(key);
    });
    (fetchAllMeetings as jest.Mock).mockResolvedValue(cachedMeetings
      .filter(meeting => meeting.id === 'audio-success')
      .map(meeting => ({
        id: meeting.id,
        title: meeting.title,
        status: 'ended',
        created_at: '2026-07-14T08:00:00+08:00',
        updated_at: '2026-07-14T08:20:00+08:00',
        audio_available: false,
      })));
    (uploadMeetingAudio as jest.Mock).mockImplementation(async (meetingId: string) => {
      if (meetingId === 'audio-failure') throw new Error('offline');
      return null;
    });

    await render(<MeetingsProvider><Probe /></MeetingsProvider>);
    await waitFor(() => expect(uploadMeetingAudio).toHaveBeenCalledTimes(2));
    await waitFor(() => {
      const success = current?.meetings.find(meeting => meeting.id === 'audio-success');
      const failure = current?.meetings.find(meeting => meeting.id === 'audio-failure');
      expect(success?.audioSyncPending).toBe(false);
      expect(success?.tags.some(tag => tag.label === '待上传')).toBe(false);
      expect(failure?.audioSyncPending).toBe(true);
      expect(failure?.tags.some(tag => tag.label === '待上传')).toBe(true);
    });
    const remaining = JSON.parse(storage.get('@laoji:pendingMeetingAudioUploads:v2:user:9')!);
    expect(Object.keys(remaining)).toEqual(['audio-failure']);
    expect(remaining['audio-failure'].attemptCount).toBe(3);
  });

  it('does not erase an omitted local meeting in the refresh that confirms its audio upload', async () => {
    (useAuth as jest.Mock).mockReturnValue({
      mode: 'authenticated',
      session: { user: { id: 9 } },
      accessToken: 'token-9',
    });
    const meetingId = 'upload-accepted-before-list-catches-up';
    const cachedMeeting = {
      id: meetingId,
      title: '列表稍后可见的会议',
      date: '2026年7月14日',
      duration: '18:00',
      tags: [{ label: '已完成', color: '#52C41A' }],
      audioLocalUri: `file:///tmp/${meetingId}.wav`,
      source: 'cloud',
    };
    const pending = pendingAudioRecord(meetingId);
    const storage = new Map<string, string>([
      ['@laoji:meetings:v2:user:9', JSON.stringify([cachedMeeting])],
      ['@laoji:pendingMeetingAudioUploads:v2:user:9', JSON.stringify({ [meetingId]: pending })],
    ]);
    (AsyncStorage.getItem as jest.Mock).mockImplementation(async (key: string) => storage.get(key) ?? null);
    (AsyncStorage.setItem as jest.Mock).mockImplementation(async (key: string, value: string) => {
      storage.set(key, value);
    });
    (AsyncStorage.removeItem as jest.Mock).mockImplementation(async (key: string) => {
      storage.delete(key);
    });
    (fetchAllMeetings as jest.Mock).mockResolvedValue([]);

    await render(<MeetingsProvider><Probe /></MeetingsProvider>);
    await waitFor(() => expect(uploadMeetingAudio).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(current?.meetings).toEqual([
      expect.objectContaining({
        id: meetingId,
        audioSyncPending: false,
      }),
    ]));
    expect(current?.meetings[0].tags.some(tag => tag.label === '待上传')).toBe(false);
    expect(storage.has('@laoji:pendingMeetingAudioUploads:v2:user:9')).toBe(false);

    await act(async () => {
      await current!.refreshMeetings();
    });
    await waitFor(() => expect(current?.meetings).toEqual([]));
  });

  it('does not let a completed upload from the previous account refresh or mutate the next account', async () => {
    let auth = {
      mode: 'authenticated',
      session: { user: { id: 'A' } },
      accessToken: 'token-A',
    };
    (useAuth as jest.Mock).mockImplementation(() => auth);
    const pendingA = pendingAudioRecord('meeting-A');
    const storage = new Map<string, string>([
      ['@laoji:pendingMeetingAudioUploads:v2:user:A', JSON.stringify({ 'meeting-A': pendingA })],
    ]);
    (AsyncStorage.getItem as jest.Mock).mockImplementation(async (key: string) => storage.get(key) ?? null);
    (AsyncStorage.setItem as jest.Mock).mockImplementation(async (key: string, value: string) => {
      storage.set(key, value);
    });
    (AsyncStorage.removeItem as jest.Mock).mockImplementation(async (key: string) => {
      storage.delete(key);
    });
    (fetchAllMeetings as jest.Mock).mockImplementation(async (token: string) => token === 'token-A'
      ? [{
          id: 'meeting-A', title: 'A 的会议', status: 'ended',
          created_at: '2026-07-14T08:00:00+08:00', updated_at: '2026-07-14T08:30:00+08:00',
        }]
      : [{
          id: 'meeting-B', title: 'B 的会议', status: 'ended',
          created_at: '2026-07-14T09:00:00+08:00', updated_at: '2026-07-14T09:30:00+08:00',
        }]);
    const uploadA = deferred<null>();
    (uploadMeetingAudio as jest.Mock).mockReturnValue(uploadA.promise);

    const view = await render(<MeetingsProvider><Probe /></MeetingsProvider>);
    await waitFor(() => expect(uploadMeetingAudio).toHaveBeenCalledTimes(1));

    auth = {
      mode: 'authenticated',
      session: { user: { id: 'B' } },
      accessToken: 'token-B',
    };
    await act(async () => {
      await view.rerender(<MeetingsProvider><Probe /></MeetingsProvider>);
    });
    await waitFor(() => expect(current?.meetings.map(meeting => meeting.id)).toEqual(['meeting-B']));
    const refreshCountAfterSwitch = (fetchAllMeetings as jest.Mock).mock.calls.length;

    await act(async () => {
      uploadA.resolve(null);
      await uploadA.promise;
      await Promise.resolve();
    });
    expect(current?.meetings.map(meeting => meeting.id)).toEqual(['meeting-B']);
    expect(current?.meetings[0].tags.some(tag => tag.label === '待上传')).toBe(false);
    expect((fetchAllMeetings as jest.Mock).mock.calls.length).toBe(refreshCountAfterSwitch);
  });

  it('retries newly queued recordings when the app returns to the foreground', async () => {
    (useAuth as jest.Mock).mockReturnValue({
      mode: 'authenticated',
      session: { user: { id: 9 } },
      accessToken: 'token-9',
    });
    const meetingId = 'foreground-audio';
    const storage = new Map<string, string>();
    (AsyncStorage.getItem as jest.Mock).mockImplementation(async (key: string) => storage.get(key) ?? null);
    (AsyncStorage.setItem as jest.Mock).mockImplementation(async (key: string, value: string) => {
      storage.set(key, value);
    });
    (AsyncStorage.removeItem as jest.Mock).mockImplementation(async (key: string) => {
      storage.delete(key);
    });
    (fetchAllMeetings as jest.Mock).mockResolvedValue([{
      id: meetingId,
      title: '前台续传会议',
      status: 'ended',
      created_at: '2026-07-14T08:00:00+08:00',
      updated_at: '2026-07-14T08:30:00+08:00',
    }]);
    let appStateListener: ((state: string) => void) | undefined;
    (AppState.addEventListener as jest.Mock).mockImplementation((_event, listener) => {
      appStateListener = listener;
      return { remove: jest.fn() };
    });
    let now = 1_000_000;
    const nowSpy = jest.spyOn(Date, 'now').mockImplementation(() => now);

    try {
      await render(<MeetingsProvider><Probe /></MeetingsProvider>);
      await waitFor(() => expect(current?.loading).toBe(false));
      expect(uploadMeetingAudio).not.toHaveBeenCalled();

      const pending = pendingAudioRecord(meetingId);
      storage.set(
        '@laoji:pendingMeetingAudioUploads:v2:user:9',
        JSON.stringify({ [meetingId]: pending }),
      );
      now += 31_000;
      await act(async () => {
        appStateListener?.('active');
      });

      await waitFor(() => expect(uploadMeetingAudio).toHaveBeenCalledWith(
        meetingId,
        pending.audioUri,
        'token-9',
        { fileName: pending.fileName, mimeType: pending.mimeType },
      ));
      await waitFor(() => expect(storage.has('@laoji:pendingMeetingAudioUploads:v2:user:9')).toBe(false));
    } finally {
      nowSpy.mockRestore();
    }
  });
});
