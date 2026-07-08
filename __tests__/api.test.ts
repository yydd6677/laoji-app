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
  saveEvent,
  deleteEvent,
  updateEvent,
  updateMeeting,
  transcribeAudio,
  fetchMeetingSummary,
  fetchMeetingAudioInfo,
} from '../src/services/api';
import {
  changePassword as authChangePassword,
  loginAccount as authLoginAccount,
  requestPasswordReset as authRequestPasswordReset,
  registerAccount as authRegisterAccount,
  fetchCurrentUser as authFetchCurrentUser,
  logoutAccount as authLogoutAccount,
  updateRemoteProfile as authUpdateRemoteProfile,
} from '../src/services/auth';

beforeEach(() => {
  (global.fetch as jest.Mock).mockReset();
  (FileSystem.readAsStringAsync as jest.Mock).mockReset();
});

describe('parseText', () => {
  it('sends POST to /api/laoji/parse with text', async () => {
    (global.fetch as jest.Mock).mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        title: '开会',
        event_type: 'once',
        start_date: '2026-07-08',
        start_time: '15:00',
        end_time: '16:00',
        is_all_day: false,
        description: null,
        raw_text: '明天下午三点开会',
        parse_source: 'rules',
        confidence: 0.97,
        needs_clarification: false,
        clarification_question: null,
      }),
    });

    const result = await parseText('明天下午三点开会');

    expect(global.fetch).toHaveBeenCalledWith(
      'http://183.36.243.124:8035/api/laoji/parse',
      expect.objectContaining({
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: '明天下午三点开会' }),
      }),
    );
    expect(result.title).toBe('开会');
    expect(result.start_date).toBe('2026-07-08');
    expect(result.confidence).toBeCloseTo(0.97);
  });

  it('throws on non-OK response', async () => {
    (global.fetch as jest.Mock).mockResolvedValueOnce({ ok: false, status: 500 });
    await expect(parseText('test')).rejects.toThrow('parse failed: 500');
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
      'http://183.36.243.124:8035/api/laoji/events?year=2026&month=7',
      { headers: undefined },
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
      'http://183.36.243.124:8035/api/laoji/events?year=2026&month=7',
      { headers: { Authorization: 'Bearer token-1' } },
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
});

describe('saveEvent', () => {
  it('sends POST to /api/laoji/events', async () => {
    const payload = { title: '开会', event_type: 'once', start_date: '2026-07-08' };
    const saved = { ...payload, id: 10 };
    (global.fetch as jest.Mock).mockResolvedValueOnce({ ok: true, json: async () => saved });

    const result = await saveEvent(payload);

    expect(global.fetch).toHaveBeenCalledWith(
      'http://183.36.243.124:8035/api/laoji/events',
      expect.objectContaining({ method: 'POST' }),
    );
    expect(result).toEqual(saved);
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
      'http://183.36.243.124:8035/api/laoji/clarify',
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
      json: async () => ({ text: '明天下午三点开会', duration_sec: 1.2, provider: 'funasr' }),
    });

    const text = await transcribeAudio('file:///tmp/recording.wav');

    expect(FileSystem.readAsStringAsync).toHaveBeenCalledWith(
      'file:///tmp/recording.wav',
      { encoding: 'base64' },
    );
    expect(global.fetch).toHaveBeenCalledWith(
      'http://183.36.243.124:8035/api/laoji/asr/transcribe',
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
      'http://183.36.243.124:8035/api/laoji/parse-audio',
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
      'http://183.36.243.124:8035/api/laoji/events/42',
      { method: 'DELETE', headers: undefined },
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
        user: { id: 1, account: 'a@example.com', nickname: 'A', created_at: '2026-07-08T00:00:00Z' },
      }),
    });

    const session = await authLoginAccount('a@example.com', 'secret123');

    expect(global.fetch).toHaveBeenCalledWith(
      'http://183.36.243.124:8035/api/auth/login',
      expect.objectContaining({
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ account: 'a@example.com', password: 'secret123' }),
      }),
    );
    expect(session.accessToken).toBe('abc');
    expect(session.user.nickname).toBe('A');
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
      'http://183.36.243.124:8035/api/auth/register',
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
      'http://183.36.243.124:8035/api/auth/me',
      { headers: { Authorization: 'Bearer abc' } },
    );
    expect(global.fetch).toHaveBeenNthCalledWith(
      2,
      'http://183.36.243.124:8035/api/auth/logout',
      { method: 'POST', headers: { Authorization: 'Bearer abc' } },
    );
  });

  it('changes password with the bearer token', async () => {
    (global.fetch as jest.Mock).mockResolvedValueOnce({ ok: true, json: async () => ({ ok: true }) });

    await authChangePassword('abc', 'old-pass', 'new-pass-123');

    expect(global.fetch).toHaveBeenCalledWith(
      'http://183.36.243.124:8035/api/auth/change-password',
      expect.objectContaining({
        method: 'POST',
        headers: { Authorization: 'Bearer abc', 'Content-Type': 'application/json' },
        body: JSON.stringify({ current_password: 'old-pass', new_password: 'new-pass-123' }),
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
      'http://183.36.243.124:8035/api/auth/password-reset-requests',
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
      'http://183.36.243.124:8035/api/auth/me/profile',
      expect.objectContaining({
        method: 'PATCH',
        headers: { Authorization: 'Bearer abc', 'Content-Type': 'application/json' },
        body: JSON.stringify({ nickname: '新昵称' }),
      }),
    );
  });
});

describe('updateEvent', () => {
  it('sends PUT to /api/laoji/events/:id with only changed fields', async () => {
    const changes = { title: '改后的会议', start_time: '16:00' };
    const updated = { id: 42, title: '改后的会议', event_type: 'once', start_date: '2026-07-08', start_time: '16:00' };
    (global.fetch as jest.Mock).mockResolvedValueOnce({ ok: true, json: async () => updated });

    const result = await updateEvent(42, changes);

    expect(global.fetch).toHaveBeenCalledWith(
      'http://183.36.243.124:8035/api/laoji/events/42',
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

describe('fetchMeetingAudioInfo', () => {
  it('returns HTTPS meeting audio metadata', async () => {
    (global.fetch as jest.Mock).mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        url: 'https://cdn.example.com/meeting.m4a',
        mime_type: 'audio/mp4',
        duration_sec: 128,
        file_name: 'meeting.m4a',
        expires_at: '2026-07-08T12:00:00Z',
      }),
    });

    await expect(fetchMeetingAudioInfo('meeting-1')).resolves.toMatchObject({
      url: 'https://cdn.example.com/meeting.m4a',
      duration_sec: 128,
    });
    expect(global.fetch).toHaveBeenCalledWith('http://183.36.243.124:8020/api/meetings/meeting-1/audio-url');
  });

  it('does not expose plain HTTP audio URLs to the player', async () => {
    (global.fetch as jest.Mock).mockResolvedValueOnce({
      ok: true,
      json: async () => ({ url: 'http://183.36.243.124:8020/audio/meeting.m4a' }),
    });

    await expect(fetchMeetingAudioInfo('meeting-2')).resolves.toBeNull();
  });

  it('treats missing audio as a normal empty state', async () => {
    (global.fetch as jest.Mock).mockResolvedValueOnce({ ok: false, status: 404, json: async () => ({ detail: 'not found' }) });
    await expect(fetchMeetingAudioInfo('meeting-3')).resolves.toBeNull();
  });
});

describe('updateMeeting', () => {
  it('sends PATCH to /api/meetings/:id with changed meeting fields', async () => {
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
      'http://183.36.243.124:8020/api/meetings/meeting-1',
      expect.objectContaining({
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: '新的会议标题' }),
      }),
    );
    expect(result).toEqual(updated);
  });
});
