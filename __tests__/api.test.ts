/**
 * API service unit tests
 * These tests mock fetch and verify the API client correctly formats requests.
 */

// Mock fetch globally
global.fetch = jest.fn();

import * as FileSystem from 'expo-file-system/legacy';
import {
  clarifyText,
  parseText,
  parseAudio,
  fetchEvents,
  fetchAllMeetings,
  fetchMeetingTranscript,
  saveEvent,
  deleteEvent,
  updateEvent,
  updateMeeting,
  transcribeAudio,
  fetchMeetingSummary,
  fetchMeetingSummaryTask,
  fetchMeetingAudioInfo,
  fetchGuestMeetingSummaryTask,
  generateGuestMeetingSummary,
  generateMeetingSummary,
  createGuestRealtimeSession,
  deleteGuestRealtimeSession,
  createMeeting,
  uploadMeetingAudio,
} from '../src/services/api';
import { LocalMeetingAudioFileMissingError } from '../src/services/meetingAudioUploadFailure';
import {
  changePassword as authChangePassword,
  deleteAccount as authDeleteAccount,
  loginAccount as authLoginAccount,
  requestPasswordReset as authRequestPasswordReset,
  registerAccount as authRegisterAccount,
  fetchCurrentUser as authFetchCurrentUser,
  fetchRemoteProfile as authFetchRemoteProfile,
  logoutAccount as authLogoutAccount,
  updateRemoteProfile as authUpdateRemoteProfile,
} from '../src/services/auth';
import { setUnauthorizedHandler } from '../src/services/authInvalidation';

beforeEach(() => {
  (global.fetch as jest.Mock).mockReset();
  (FileSystem.readAsStringAsync as jest.Mock).mockReset();
  (FileSystem.getInfoAsync as jest.Mock).mockReset().mockResolvedValue({ exists: true });
});

describe('parseText', () => {
  it('uses local rules before server for simple complete text', async () => {
    jest.useFakeTimers().setSystemTime(new Date(2026, 6, 9, 9, 0, 0));

    try {
      const result = await parseText('明天下午三点开会');

      expect(global.fetch).not.toHaveBeenCalled();
      expect(result).toMatchObject({
        title: '开会',
        start_date: '2026-07-10',
        start_time: '15:00',
        end_time: '16:00',
        parse_source: 'rules',
        confidence: 0,
      });
    } finally {
      jest.useRealTimers();
    }
  });

  it('keeps complete relative offsets on the local fast path', async () => {
    jest.useFakeTimers().setSystemTime(new Date(2026, 6, 13, 23, 50, 48));

    try {
      const result = await parseText('十五分钟后提醒我提交材料');

      expect(global.fetch).not.toHaveBeenCalled();
      expect(result).toMatchObject({
        title: '提交材料',
        start_date: '2026-07-14',
        start_time: '00:05',
        reminder_minutes: 0,
        needs_clarification: false,
        clarification_question: null,
        parse_source: 'rules',
      });
    } finally {
      jest.useRealTimers();
    }
  });

  it('keeps dated all-day text on the local fast path without asking for time', async () => {
    jest.useFakeTimers().setSystemTime(new Date(2026, 6, 9, 9, 0, 0));

    try {
      const result = await parseText('明天开会');

      expect(global.fetch).not.toHaveBeenCalled();
      expect(result).toMatchObject({
        start_date: '2026-07-10',
        start_time: null,
        end_time: null,
        is_all_day: true,
        needs_clarification: false,
        clarification_question: null,
      });
    } finally {
      jest.useRealTimers();
    }
  });

  it('removes a server time-only question but never accepts an invented date', async () => {
    jest.useFakeTimers().setSystemTime(new Date(2026, 6, 9, 9, 0, 0));
    const serverResult = {
      title: '项目会',
      event_type: 'once' as const,
      start_date: '2026-07-10',
      start_time: null,
      end_time: null,
      is_all_day: true,
      description: null,
      raw_text: '明天开会，标题就写项目会',
      parse_source: 'local_llm' as const,
      confidence: 0.8,
      needs_clarification: true,
      clarification_question: '没有听到具体时间，是否作为全天事项保存？',
    };
    (global.fetch as jest.Mock).mockResolvedValueOnce({ ok: true, json: async () => serverResult });

    try {
      await expect(parseText('明天开会，标题就写项目会')).resolves.toMatchObject({
        needs_clarification: false,
        clarification_question: null,
      });
      await expect(parseText('开会')).resolves.toMatchObject({
        needs_clarification: true,
        clarification_question: '没有听到具体日期，需要补充日期。',
      });
      expect(global.fetch).toHaveBeenCalledTimes(1);
    } finally {
      jest.useRealTimers();
    }
  });

  it('returns simple missing-date clarification without network or model latency', async () => {
    jest.useFakeTimers().setSystemTime(new Date(2026, 6, 13, 10, 0, 0));

    try {
      await expect(parseText('开会')).resolves.toMatchObject({
        title: '开会',
        start_date: '2026-07-13',
        start_time: null,
        parse_source: 'rules',
        needs_clarification: true,
        clarification_question: '没有听到具体日期，需要补充日期。',
      });
      await expect(parseText('下午三点开会')).resolves.toMatchObject({
        title: '开会',
        start_date: '2026-07-13',
        start_time: '15:00',
        parse_source: 'rules',
        needs_clarification: true,
      });
      expect(global.fetch).not.toHaveBeenCalled();
    } finally {
      jest.useRealTimers();
    }
  });

  it('sends complex correction text to /api/laoji/parse', async () => {
    (global.fetch as jest.Mock).mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        title: '报销发票',
        event_type: 'once',
        start_date: '2026-07-10',
        start_time: '09:00',
        end_time: '10:00',
        is_all_day: false,
        description: null,
        raw_text: '不是星期日，是星期五上午九点报销发票',
        parse_source: 'local_llm',
        confidence: 0,
        needs_clarification: false,
        clarification_question: null,
      }),
    });

    const result = await parseText('不是星期日，是星期五上午九点报销发票');

    expect(global.fetch).toHaveBeenCalledWith(
      'http://203.0.113.10:18035/api/laoji/parse',
      expect.objectContaining({
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: '不是星期日，是星期五上午九点报销发票' }),
      }),
    );
    expect(result.title).toBe('报销发票');
    expect(result.start_date).toBe('2026-07-10');
    expect(result.parse_source).toBe('local_llm');
  });

  it('throws on non-OK response', async () => {
    (global.fetch as jest.Mock).mockResolvedValueOnce({ ok: false, status: 500 });
    await expect(parseText('test')).rejects.toThrow('parse failed: 500');
  });

  it('does not send explicit non-schedule control text to the server', async () => {
    await expect(parseText('我刚才只是测试麦克风，不要真的创建日程')).rejects.toThrow(
      'parse skipped: non-schedule control text',
    );
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('falls back to local rules when the server is unreachable', async () => {
    jest.useFakeTimers().setSystemTime(new Date(2026, 6, 9, 9, 0, 0));
    (global.fetch as jest.Mock).mockRejectedValueOnce(new Error('Network request failed'));

    try {
      const result = await parseText('明天下午三点开会，如果冲突我再改');

      expect(global.fetch).toHaveBeenCalled();
      expect(result).toMatchObject({
        start_date: '2026-07-10',
        start_time: '15:00',
        end_time: '16:00',
        parse_source: 'rules',
        confidence: 0,
      });
    } finally {
      jest.useRealTimers();
    }
  });

  it('keeps the original error when neither server nor local rules can parse', async () => {
    (global.fetch as jest.Mock).mockRejectedValueOnce(new Error('Network request failed'));

    await expect(parseText('只是随便说句话')).rejects.toThrow('Network request failed');
  });
});

describe('fetchEvents', () => {
  it('calls correct URL and returns events array', async () => {
    const mockEvents = [{ id: 1, title: '例会', event_type: 'weekly', start_date: '2026-07-06' }];
    (global.fetch as jest.Mock).mockResolvedValueOnce({
      ok: true,
      json: async () => ({ events: mockEvents }),
    });

    const result = await fetchEvents(2026, 7);

    expect(global.fetch).toHaveBeenCalledWith(
      'http://203.0.113.10:18035/api/laoji/events?year=2026&month=7',
      expect.objectContaining({ headers: undefined, signal: expect.anything() }),
    );
    expect(result).toEqual(mockEvents);
  });

  it('adds bearer auth when a token is provided', async () => {
    (global.fetch as jest.Mock).mockResolvedValueOnce({
      ok: true,
      json: async () => ({ events: [] }),
    });

    await fetchEvents(2026, 7, 'token-1');

    expect(global.fetch).toHaveBeenCalledWith(
      'http://203.0.113.10:18035/api/laoji/events?year=2026&month=7',
      expect.objectContaining({ headers: { Authorization: 'Bearer token-1' }, signal: expect.anything() }),
    );
  });

  it('handles flat array response', async () => {
    const mockEvents = [{ id: 1, title: '开会' }];
    (global.fetch as jest.Mock).mockResolvedValueOnce({
      ok: true,
      json: async () => mockEvents,
    });
    const result = await fetchEvents(2026, 7);
    expect(result).toEqual(mockEvents);
  });

  it('fetches the complete authenticated event catalog without a month filter', async () => {
    (global.fetch as jest.Mock).mockResolvedValueOnce({
      ok: true,
      json: async () => ({ events: [] }),
    });

    await fetchEvents(undefined, undefined, 'catalog-token');

    expect(global.fetch).toHaveBeenCalledWith(
      'http://203.0.113.10:18035/api/laoji/events',
      expect.objectContaining({ headers: { Authorization: 'Bearer catalog-token' }, signal: expect.anything() }),
    );
  });

  it('reports an authenticated 401 but ignores an unauthenticated 401', async () => {
    const onUnauthorized = jest.fn();
    const clearHandler = setUnauthorizedHandler(onUnauthorized);
    (global.fetch as jest.Mock)
      .mockResolvedValueOnce({ ok: false, status: 401, text: async () => '{"detail":"token expired"}' })
      .mockResolvedValueOnce({ ok: false, status: 401, text: async () => '{"detail":"login required"}' });

    try {
      await expect(fetchEvents(2026, 7, 'expired-token')).rejects.toMatchObject({ status: 401 });
      await expect(fetchEvents(2026, 7)).rejects.toMatchObject({ status: 401 });
      expect(onUnauthorized).toHaveBeenCalledTimes(1);
    } finally {
      clearHandler();
    }
  });
});

describe('fetchAllMeetings', () => {
  it('loads every page and removes duplicate meeting ids', async () => {
    const firstPage = Array.from({ length: 100 }, (_, index) => ({ id: `m-${index}`, title: `会议${index}` }));
    (global.fetch as jest.Mock)
      .mockResolvedValueOnce({ ok: true, json: async () => ({ items: firstPage }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ items: [{ id: 'm-99', title: '重复' }, { id: 'm-100', title: '会议100' }] }) });

    const result = await fetchAllMeetings('meeting-token');

    expect(result).toHaveLength(101);
    expect(global.fetch).toHaveBeenNthCalledWith(
      2,
      'http://203.0.113.10:18020/api/laoji/meetings?page=2&size=100',
      expect.objectContaining({ headers: { Authorization: 'Bearer meeting-token' }, signal: expect.anything() }),
    );
  });
});

describe('fetchMeetingTranscript', () => {
  it('loads every offset page and returns one atomic transcript collection', async () => {
    const firstPage = Array.from({ length: 1000 }, (_, index) => ({
      id: `line-${index}`,
      text: `line ${index}`,
    }));
    (global.fetch as jest.Mock)
      .mockResolvedValueOnce({ ok: true, json: async () => ({ items: firstPage, total: 1002 }) })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          items: [
            { id: 'line-1000', text: 'line 1000' },
            { id: 'line-1001', text: 'line 1001' },
          ],
          total: 1002,
        }),
      });

    const result = await fetchMeetingTranscript('meeting-1', 'meeting-token');

    expect(result).toHaveLength(1002);
    expect(result[1001]).toEqual({ id: 'line-1001', text: 'line 1001' });
    expect(global.fetch).toHaveBeenNthCalledWith(
      2,
      'http://203.0.113.10:18020/api/laoji/meetings/meeting-1/transcripts?offset=1000&limit=1000',
      expect.objectContaining({ headers: { Authorization: 'Bearer meeting-token' }, signal: expect.anything() }),
    );
  });

  it('keeps a more complete local fallback when a short server response is returned', async () => {
    const local = [
      { id: 'local-1', text: '第一句' },
      { id: 'local-2', text: '第二句' },
    ];
    (global.fetch as jest.Mock).mockResolvedValueOnce({
      ok: true,
      json: async () => ({ items: [{ id: 'remote-1', text: '第一句' }], total: 1 }),
    });

    await expect(fetchMeetingTranscript('meeting-2', undefined, { fallbackItems: local })).resolves.toBe(local);
  });
});

describe('saveEvent', () => {
  it('sends POST to /api/laoji/events', async () => {
    const payload = {
      title: '开会',
      event_type: 'once',
      start_date: '2026-07-08',
      client_request_id: 'event:test:1:abcdefghij',
    };
    const saved = { ...payload, id: 10 };
    (global.fetch as jest.Mock).mockResolvedValueOnce({ ok: true, json: async () => saved });

    const result = await saveEvent(payload);

    expect(global.fetch).toHaveBeenCalledWith(
      'http://203.0.113.10:18035/api/laoji/events',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify(payload),
      }),
    );
    expect(result).toEqual(saved);
  });
});

describe('createMeeting', () => {
  it('sends the stable client request ID with the create payload', async () => {
    (global.fetch as jest.Mock).mockResolvedValueOnce({
      ok: true,
      json: async () => ({ id: 'meeting-1', title: '项目会', status: 'created' }),
    });

    await createMeeting({
      title: '项目会',
      mode: 'realtime',
      clientRequestId: 'meeting:test:1:abcdefghij',
    }, 'token-1');

    expect(global.fetch).toHaveBeenCalledWith(
      'http://203.0.113.10:18020/api/laoji/meetings',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          title: '项目会',
          description: null,
          participants: [],
          mode: 'realtime',
          client_request_id: 'meeting:test:1:abcdefghij',
        }),
      }),
    );
  });
});

describe('clarifyText', () => {
  it('sends current draft and answer in the server schema', async () => {
    const draft = {
      title: '开会',
      event_type: 'once' as const,
      start_date: '2026-07-08',
      start_time: '15:00',
      end_time: '16:00',
      is_all_day: false,
      description: null,
      raw_text: '明天下午开会',
      parse_source: 'rules' as const,
      confidence: 0.8,
      needs_clarification: true,
      clarification_question: '具体几点？',
    };
    (global.fetch as jest.Mock).mockResolvedValueOnce({ ok: true, json: async () => draft });

    await clarifyText('明天下午开会', '三点', draft);

    expect(global.fetch).toHaveBeenCalledWith(
      'http://203.0.113.10:18035/api/laoji/clarify',
      expect.objectContaining({
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ current: draft, answer: '三点' }),
      }),
    );
  });
});

describe('transcribeAudio', () => {
  it('reads the local audio URI and sends base64 JSON to ASR endpoint', async () => {
    (FileSystem.readAsStringAsync as jest.Mock).mockResolvedValueOnce('AQIDBA==');
    (global.fetch as jest.Mock).mockResolvedValueOnce({
      ok: true,
      json: async () => ({ text: '明天下午三点开会', duration_sec: 1.2, provider: 'qwen3-asr' }),
    });

    const text = await transcribeAudio('file:///tmp/recording.wav');

    expect(FileSystem.readAsStringAsync).toHaveBeenCalledWith(
      'file:///tmp/recording.wav',
      { encoding: 'base64' },
    );
    expect(global.fetch).toHaveBeenCalledWith(
      'http://203.0.113.10:18020/api/laoji/asr/transcribe',
      expect.objectContaining({
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ audio_base64: 'AQIDBA==', filename: 'recording.wav' }),
      }),
    );
    expect(text).toBe('明天下午三点开会');
  });
});

describe('parseAudio', () => {
  it('sends local audio base64 to the audio parse endpoint', async () => {
    const parsed = {
      title: '开会',
      event_type: 'once',
      start_date: '2026-07-08',
      start_time: '15:00',
      end_time: '16:00',
      is_all_day: false,
      description: null,
      raw_text: '明天下午三点开会',
      parse_source: 'llm',
      confidence: 0.9,
      needs_clarification: false,
      clarification_question: null,
    };
    (FileSystem.readAsStringAsync as jest.Mock).mockResolvedValueOnce('BQYHCA==');
    (global.fetch as jest.Mock).mockResolvedValueOnce({ ok: true, json: async () => parsed });

    const result = await parseAudio('file:///tmp/recording.m4a');

    expect(FileSystem.readAsStringAsync).toHaveBeenCalledWith(
      'file:///tmp/recording.m4a',
      { encoding: 'base64' },
    );
    expect(global.fetch).toHaveBeenCalledWith(
      'http://203.0.113.10:18020/api/laoji/parse-audio',
      expect.objectContaining({
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ audio_base64: 'BQYHCA==', filename: 'recording.m4a' }),
      }),
    );
    expect(result).toEqual(parsed);
  });
});

describe('deleteEvent', () => {
  it('sends DELETE to /api/laoji/events/:id', async () => {
    (global.fetch as jest.Mock).mockResolvedValueOnce({ ok: true });
    await deleteEvent(42);
    expect(global.fetch).toHaveBeenCalledWith(
      'http://203.0.113.10:18035/api/laoji/events/42',
      expect.objectContaining({ method: 'DELETE', headers: undefined, signal: expect.anything() }),
    );
  });

  it('throws on non-OK response', async () => {
    (global.fetch as jest.Mock).mockResolvedValueOnce({ ok: false, status: 404 });
    await expect(deleteEvent(99)).rejects.toThrow('delete event failed: 404');
  });
});

describe('auth API', () => {
  it('logs in and maps snake_case token fields to AuthSession', async () => {
    (global.fetch as jest.Mock).mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        access_token: 'abc',
        expires_at: '2026-08-08T00:00:00Z',
        user: { id: 1, account: 'a@example.com', nickname: 'A', avatar_url: '/api/auth/avatars/a.png', created_at: '2026-07-08T00:00:00Z' },
      }),
    });

    const session = await authLoginAccount('a@example.com', 'secret123');

    expect(global.fetch).toHaveBeenCalledWith(
      'http://203.0.113.10:18035/api/auth/login',
      expect.objectContaining({
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ account: 'a@example.com', password: 'secret123' }),
      }),
    );
    expect(session.accessToken).toBe('abc');
    expect(session.user.nickname).toBe('A');
    expect(session.user.avatar_url).toBe('http://203.0.113.10:18035/api/auth/avatars/a.png');
  });

  it('registers with an optional nickname', async () => {
    (global.fetch as jest.Mock).mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        access_token: 'new-token',
        expires_at: '2026-08-08T00:00:00Z',
        user: { id: 2, account: 'b@example.com', nickname: 'B', created_at: '2026-07-08T00:00:00Z' },
      }),
    });

    await authRegisterAccount('b@example.com', 'secret123', 'B');

    expect(global.fetch).toHaveBeenCalledWith(
      'http://203.0.113.10:18035/api/auth/register',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ account: 'b@example.com', password: 'secret123', nickname: 'B' }),
      }),
    );
  });

  it('normalizes object-shaped auth errors into readable messages', async () => {
    (global.fetch as jest.Mock).mockResolvedValueOnce({
      ok: false,
      status: 422,
      json: async () => ({
        detail: [
          { type: 'value_error', loc: ['body', 'password'], msg: '密码至少需要 6 位' },
        ],
      }),
    });

    await expect(authLoginAccount('a@example.com', '123')).rejects.toThrow('密码至少需要 6 位');
  });

  it('turns Retry-After into an actionable rate-limit message', async () => {
    (global.fetch as jest.Mock).mockResolvedValueOnce({
      ok: false,
      status: 429,
      headers: { get: (name: string) => name.toLowerCase() === 'retry-after' ? '899' : null },
      json: async () => ({ detail: '请求过于频繁，请稍后重试' }),
    });

    await expect(authLoginAccount('a@example.com', 'wrong-password')).rejects.toMatchObject({
      status: 429,
      retryAfterSeconds: 899,
      message: '请求过于频繁，请在约 15 分钟后重试。',
    });
  });

  it('fetches and logs out the current bearer session', async () => {
    (global.fetch as jest.Mock)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ id: 1, account: 'a@example.com', nickname: 'A', created_at: '2026-07-08T00:00:00Z' }),
      })
      .mockResolvedValueOnce({ ok: true });

    await expect(authFetchCurrentUser('abc')).resolves.toMatchObject({ account: 'a@example.com' });
    await authLogoutAccount('abc');

    expect(global.fetch).toHaveBeenNthCalledWith(
      1,
      'http://203.0.113.10:18035/api/auth/me',
      expect.objectContaining({ headers: { Authorization: 'Bearer abc' }, signal: expect.anything() }),
    );
    expect(global.fetch).toHaveBeenNthCalledWith(
      2,
      'http://203.0.113.10:18035/api/auth/logout',
      expect.objectContaining({ method: 'POST', headers: { Authorization: 'Bearer abc' }, signal: expect.anything() }),
    );
  });

  it('changes password with the bearer token', async () => {
    (global.fetch as jest.Mock).mockResolvedValueOnce({ ok: true, json: async () => ({ ok: true }) });

    await authChangePassword('abc', 'old-pass', 'new-pass-123');

    expect(global.fetch).toHaveBeenCalledWith(
      'http://203.0.113.10:18035/api/auth/change-password',
      expect.objectContaining({
        method: 'POST',
        headers: { Authorization: 'Bearer abc', 'Content-Type': 'application/json' },
        body: JSON.stringify({ current_password: 'old-pass', new_password: 'new-pass-123' }),
      }),
    );
  });

  it('deletes the authenticated account only with password and explicit confirmation', async () => {
    (global.fetch as jest.Mock).mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        deleted: true,
        events_deleted: 3,
        meetings_deleted: 2,
        sessions_deleted: 1,
        cleanup_pending: 0,
      }),
    });

    await expect(authDeleteAccount('abc', 'current-pass', '删除账号')).resolves.toMatchObject({
      deleted: true,
      meetings_deleted: 2,
    });

    expect(global.fetch).toHaveBeenCalledWith(
      'http://203.0.113.10:18035/api/auth/me',
      expect.objectContaining({
        method: 'DELETE',
        headers: { Authorization: 'Bearer abc', 'Content-Type': 'application/json' },
        body: JSON.stringify({ current_password: 'current-pass', confirmation: '删除账号' }),
      }),
    );
  });

  it('submits manual password reset requests', async () => {
    (global.fetch as jest.Mock).mockResolvedValueOnce({
      ok: true,
      json: async () => ({ request_id: 'reset-1', message: '已提交' }),
    });

    await expect(authRequestPasswordReset('a@example.com')).resolves.toMatchObject({ request_id: 'reset-1' });

    expect(global.fetch).toHaveBeenCalledWith(
      'http://203.0.113.10:18035/api/auth/password-reset-requests',
      expect.objectContaining({
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ account: 'a@example.com' }),
      }),
    );
  });

  it('updates remote profile fields', async () => {
    const remote = { nickname: '新昵称', avatar_url: 'https://cdn.example.com/a.jpg' };
    (global.fetch as jest.Mock).mockResolvedValueOnce({ ok: true, json: async () => remote });

    await expect(authUpdateRemoteProfile('abc', { nickname: '新昵称' })).resolves.toEqual(remote);

    expect(global.fetch).toHaveBeenCalledWith(
      'http://203.0.113.10:18035/api/auth/me/profile',
      expect.objectContaining({
        method: 'PATCH',
        headers: { Authorization: 'Bearer abc', 'Content-Type': 'application/json' },
        body: JSON.stringify({ nickname: '新昵称' }),
      }),
    );
  });

  it('normalizes relative avatar URLs in remote profiles', async () => {
    (global.fetch as jest.Mock).mockResolvedValueOnce({
      ok: true,
      json: async () => ({ nickname: 'A', avatar_url: '/api/auth/avatars/a.png' }),
    });

    await expect(authFetchRemoteProfile('abc')).resolves.toMatchObject({
      avatar_url: 'http://203.0.113.10:18035/api/auth/avatars/a.png',
    });
  });
});

describe('updateEvent', () => {
  it('sends PUT to /api/laoji/events/:id with only changed fields', async () => {
    const changes = { title: '改后的会议', start_time: '16:00' };
    const updated = { id: 42, title: '改后的会议', event_type: 'once', start_date: '2026-07-08', start_time: '16:00' };
    (global.fetch as jest.Mock).mockResolvedValueOnce({ ok: true, json: async () => updated });

    const result = await updateEvent(42, changes);

    expect(global.fetch).toHaveBeenCalledWith(
      'http://203.0.113.10:18035/api/laoji/events/42',
      expect.objectContaining({
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(changes),
      }),
    );
    expect(result).toEqual(updated);
  });
});

describe('fetchMeetingSummary', () => {
  it('accepts meeting summary fields used by the meeting backend', async () => {
    (global.fetch as jest.Mock).mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        overview: '会议概览',
        full_text: '完整总结',
        markdown: '# Markdown 总结',
      }),
    });

    await expect(fetchMeetingSummary('meeting-1')).resolves.toBe('# Markdown 总结');
  });

  it('normalizes nested summary objects', async () => {
    (global.fetch as jest.Mock).mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        summary: {
          overview: '概览',
          content: '行动项',
        },
      }),
    });

    await expect(fetchMeetingSummary('meeting-2')).resolves.toBe('概览\n\n行动项');
  });
});

describe('guest meeting summary', () => {
  it('submits locally cached transcript without an auth header', async () => {
    (global.fetch as jest.Mock).mockResolvedValueOnce({
      ok: true,
      json: async () => ({ task_id: 'guest-task-1', transcript_count: 1 }),
    });

    await expect(generateGuestMeetingSummary('guest-meeting-1', [{
      id: 'line-1',
      speaker_label: '发言人 1',
      text: '今天讨论了发布安排。',
      start_time: 0,
      end_time: 2.5,
    }], '游客会议', undefined, '2026-07-10')).resolves.toMatchObject({ task_id: 'guest-task-1' });

    expect(global.fetch).toHaveBeenCalledWith(
      'http://203.0.113.10:18020/api/laoji/meetings/guest-summary',
      expect.objectContaining({
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          meeting_id: 'guest-meeting-1',
          title: '游客会议',
          meeting_date: '2026-07-10',
          force: false,
          transcript_lines: [{
            speaker_label: '发言人 1',
            speaker_id: null,
            text: '今天讨论了发布安排。',
            start_time: 0,
            end_time: 2.5,
            confidence: null,
          }],
        }),
      }),
    );
  });

  it('marks an explicit authenticated regeneration as forced', async () => {
    (global.fetch as jest.Mock).mockResolvedValueOnce({
      ok: true,
      json: async () => ({ task_id: 'cloud-task-2' }),
    });

    await expect(generateMeetingSummary('meeting-2', 'access-token', undefined, true)).resolves.toMatchObject({
      task_id: 'cloud-task-2',
    });
    expect(global.fetch).toHaveBeenCalledWith(
      'http://203.0.113.10:18020/api/laoji/meetings/meeting-2/summaries/generate?summary_type=final&force=true',
      expect.objectContaining({
        method: 'POST',
        headers: { Authorization: 'Bearer access-token' },
      }),
    );
  });

  it('long-polls a guest task without an auth header', async () => {
    (global.fetch as jest.Mock).mockResolvedValueOnce({
      ok: true,
      json: async () => ({ task_id: 'guest-task-1', status: 'SUCCESS', result: { overview: '完成' } }),
    });

    await expect(fetchGuestMeetingSummaryTask('guest-task-1')).resolves.toMatchObject({ status: 'SUCCESS' });
    expect(global.fetch).toHaveBeenCalledWith(
      'http://203.0.113.10:18020/api/laoji/meetings/guest-summary/tasks/guest-task-1?wait_ms=5000',
      expect.objectContaining({ signal: expect.anything() }),
    );
  });

  it('long-polls an authenticated task within its meeting scope', async () => {
    (global.fetch as jest.Mock).mockResolvedValueOnce({
      ok: true,
      json: async () => ({ task_id: 'cloud-task-1', status: 'STARTED', result: null }),
    });

    await expect(fetchMeetingSummaryTask(
      'meeting-1',
      'cloud-task-1',
      'access-token',
    )).resolves.toMatchObject({ status: 'STARTED' });
    expect(global.fetch).toHaveBeenCalledWith(
      'http://203.0.113.10:18020/api/laoji/meetings/meeting-1/summaries/task/cloud-task-1?wait_ms=5000',
      expect.objectContaining({
        headers: { Authorization: 'Bearer access-token' },
        signal: expect.anything(),
      }),
    );
  });
});

describe('guest realtime meeting session', () => {
  it('creates and revokes a transient session without bearer authentication', async () => {
    (global.fetch as jest.Mock)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          meeting_id: 'guest-session-1',
          guest_token: 'guest-token-1',
          expires_at: '2026-07-11T04:00:00+00:00',
          transient: true,
        }),
      })
      .mockResolvedValueOnce({ ok: true, status: 204 });

    const session = await createGuestRealtimeSession('游客会议');
    await deleteGuestRealtimeSession(session.meeting_id, session.guest_token);

    expect(global.fetch).toHaveBeenNthCalledWith(
      1,
      'http://203.0.113.10:18020/api/laoji/meetings/guest-sessions',
      expect.objectContaining({
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: '游客会议' }),
        signal: expect.anything(),
      }),
    );
    expect(global.fetch).toHaveBeenNthCalledWith(
      2,
      'http://203.0.113.10:18020/api/laoji/meetings/guest-sessions/guest-session-1',
      expect.objectContaining({
        method: 'DELETE',
        headers: { 'X-Guest-Session-Token': 'guest-token-1' },
        signal: expect.anything(),
      }),
    );
  });
});

describe('uploadMeetingAudio', () => {
  it('rejects a missing local file before starting a network request', async () => {
    (FileSystem.getInfoAsync as jest.Mock).mockResolvedValueOnce({ exists: false });

    await expect(uploadMeetingAudio(
      'meeting-missing-file',
      'file:///data/missing.wav',
      'token-1',
    )).rejects.toBeInstanceOf(LocalMeetingAudioFileMissingError);

    expect(global.fetch).not.toHaveBeenCalled();
  });
});

describe('fetchMeetingAudioInfo', () => {
  it('returns HTTPS meeting audio metadata', async () => {
    (global.fetch as jest.Mock).mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        url: 'https://cdn.example.com/meeting.m4a',
        mime_type: 'audio/mp4',
        duration_sec: 128,
        file_name: 'meeting.m4a',
        expires_at: '2099-07-08T12:00:00Z',
      }),
    });

    await expect(fetchMeetingAudioInfo('meeting-1')).resolves.toMatchObject({
      url: 'https://cdn.example.com/meeting.m4a',
      duration_sec: 128,
    });
    expect(global.fetch).toHaveBeenCalledWith(
      'http://203.0.113.10:18020/api/laoji/meetings/meeting-1/audio',
      expect.objectContaining({ headers: undefined, signal: expect.anything() }),
    );
  });

  it('normalizes app-owned relative audio URLs', async () => {
    (global.fetch as jest.Mock).mockResolvedValueOnce({
      ok: true,
      json: async () => ({ url: '/api/laoji/meetings/meeting-2/audio/file', requires_auth: true }),
    });

    await expect(fetchMeetingAudioInfo('meeting-2')).resolves.toMatchObject({
      url: 'http://203.0.113.10:18020/api/laoji/meetings/meeting-2/audio/file',
      requires_auth: true,
    });
  });

  it('treats missing audio as a normal empty state', async () => {
    (global.fetch as jest.Mock).mockResolvedValueOnce({ ok: false, status: 404, json: async () => ({ detail: 'not found' }) });
    await expect(fetchMeetingAudioInfo('meeting-3')).resolves.toBeNull();
  });

  it('rejects an already expired audio URL instead of handing it to the player', async () => {
    (global.fetch as jest.Mock).mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        url: 'https://cdn.example.com/expired.m4a',
        expires_at: '2000-01-01T00:00:00Z',
      }),
    });

    await expect(fetchMeetingAudioInfo('meeting-expired')).rejects.toMatchObject({ code: 'EXPIRED' });
  });
});

describe('updateMeeting', () => {
  it('sends PATCH to /api/laoji/meetings/:id with changed meeting fields', async () => {
    const updated = {
      id: 'meeting-1',
      title: '新的会议标题',
      description: null,
      status: 'ended',
      participants: [],
      created_at: '2026-07-08T00:00:00',
      updated_at: '2026-07-08T00:01:00',
    };
    (global.fetch as jest.Mock).mockResolvedValueOnce({ ok: true, json: async () => updated });

    const result = await updateMeeting('meeting-1', { title: '新的会议标题' });

    expect(global.fetch).toHaveBeenCalledWith(
      'http://203.0.113.10:18020/api/laoji/meetings/meeting-1',
      expect.objectContaining({
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: '新的会议标题' }),
      }),
    );
    expect(result).toEqual(updated);
  });
});
