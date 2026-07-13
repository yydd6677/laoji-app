import {
  deleteSpeaker,
  fetchSpeakers,
  registerSpeaker,
  renameSpeaker,
  supplementSpeaker,
} from '../src/services/speakers';

function response(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: jest.fn(async () => body),
    text: jest.fn(async () => JSON.stringify(body)),
    headers: new Headers(),
  } as unknown as Response;
}

describe('user-isolated speaker API client', () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    globalThis.fetch = jest.fn();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('lists only the profiles returned by the account endpoint', async () => {
    (globalThis.fetch as jest.Mock).mockResolvedValueOnce(response({
      speakers: [{ speaker_id: 'u7_a', name: '张老师', sample_count: 2, quality: 0.82 }],
      total: 1,
    }));

    await expect(fetchSpeakers('token-7')).resolves.toEqual([
      expect.objectContaining({ speaker_id: 'u7_a', name: '张老师' }),
    ]);
    expect(globalThis.fetch).toHaveBeenCalledWith(
      'http://203.0.113.10:18020/api/laoji/speakers',
      expect.objectContaining({ headers: { Authorization: 'Bearer token-7' } }),
    );
  });

  it('uses multipart WAV uploads for registration and supplemental samples', async () => {
    const mutation = {
      success: true,
      speaker: { speaker_id: 'u7_a', name: '张老师', sample_count: 1, quality: 0.8 },
    };
    (globalThis.fetch as jest.Mock)
      .mockResolvedValueOnce(response(mutation, 201))
      .mockResolvedValueOnce(response({
        ...mutation,
        speaker: { ...mutation.speaker, sample_count: 2 },
      }));

    await registerSpeaker('张老师', 'file:///voice.wav', 'voice.wav', 'token-7');
    await supplementSpeaker('u7_a', 'file:///voice-2.wav', 'voice-2.wav', 'token-7');

    expect(globalThis.fetch).toHaveBeenNthCalledWith(
      1,
      'http://203.0.113.10:18020/api/laoji/speakers',
      expect.objectContaining({ method: 'POST', body: expect.any(FormData) }),
    );
    expect(globalThis.fetch).toHaveBeenNthCalledWith(
      2,
      'http://203.0.113.10:18020/api/laoji/speakers/u7_a/samples',
      expect.objectContaining({ method: 'POST', body: expect.any(FormData) }),
    );
  });

  it('renames and deletes through owner-scoped resource routes', async () => {
    (globalThis.fetch as jest.Mock)
      .mockResolvedValueOnce(response({
        success: true,
        speaker: { speaker_id: 'u7_a', name: '新名称', sample_count: 2, quality: 0.8 },
      }))
      .mockResolvedValueOnce(response({ success: true }));

    await renameSpeaker('u7_a', '新名称', 'token-7');
    await deleteSpeaker('u7_a', 'token-7');

    expect(globalThis.fetch).toHaveBeenNthCalledWith(
      1,
      'http://203.0.113.10:18020/api/laoji/speakers/u7_a',
      expect.objectContaining({ method: 'PATCH', body: JSON.stringify({ name: '新名称' }) }),
    );
    expect(globalThis.fetch).toHaveBeenNthCalledWith(
      2,
      'http://203.0.113.10:18020/api/laoji/speakers/u7_a',
      expect.objectContaining({ method: 'DELETE' }),
    );
  });
});
