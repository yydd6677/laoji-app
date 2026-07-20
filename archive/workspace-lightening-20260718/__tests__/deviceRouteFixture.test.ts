const {
  finalizeFixtureMeeting,
  fixtureCredentials,
  normalizeBaseUrl,
  parseCli,
  parseDotEnv,
} = require('../scripts/device_route_fixture');

const originalFetch = global.fetch;

afterEach(() => {
  global.fetch = originalFetch;
  jest.restoreAllMocks();
});

describe('disposable Android route fixture', () => {
  it('parses quoted and exported build configuration without comments', () => {
    expect(parseDotEnv(`
      # ignored
      export EXPO_PUBLIC_LAOJI_API_BASE="https://api.example.com"
      EXPO_PUBLIC_MEETING_API_BASE=https://meeting.example.com/ # local note
    `)).toEqual({
      EXPO_PUBLIC_LAOJI_API_BASE: 'https://api.example.com',
      EXPO_PUBLIC_MEETING_API_BASE: 'https://meeting.example.com/',
    });
  });

  it('creates unique-looking ASCII credentials suitable for adb input', () => {
    expect(fixtureCredentials(123, 'abcdef123456')).toEqual({
      account: 'laoji-route-123-abcdef123456@example.com',
      password: 'Route!abcdef123456Aa9',
    });
  });

  it('normalizes supported base URLs and rejects unsafe schemes', () => {
    expect(normalizeBaseUrl('https://api.example.com///', 'API')).toBe('https://api.example.com');
    expect(() => normalizeBaseUrl('file:///tmp/service', 'API')).toThrow('must use HTTP or HTTPS');
  });

  it('requires explicit values for fixture paths', () => {
    expect(parseCli(['node', 'fixture', 'create', '--output', '/tmp/fixture.json'])).toEqual({
      command: 'create',
      options: { output: '/tmp/fixture.json' },
    });
    expect(() => parseCli(['node', 'fixture', 'cleanup', '--input'])).toThrow('missing value');
  });

  it('finalizes route meetings so the app opens transcription instead of resumable recording', async () => {
    global.fetch = jest.fn(async () => ({
      ok: true,
      text: async () => JSON.stringify({ id: 'meeting/1', status: 'completed' }),
    })) as jest.Mock;

    await expect(finalizeFixtureMeeting(
      { meetingApiBase: 'https://meeting.example.com' },
      'access-token',
      { id: 'meeting/1', status: 'created' },
    )).resolves.toEqual({ id: 'meeting/1', status: 'completed' });

    expect(global.fetch).toHaveBeenCalledWith(
      'https://meeting.example.com/api/laoji/meetings/meeting%2F1',
      expect.objectContaining({
        method: 'PATCH',
        headers: expect.objectContaining({ Authorization: 'Bearer access-token' }),
        body: JSON.stringify({ status: 'completed' }),
      }),
    );
  });

  it('rejects a route meeting that the service did not finalize', async () => {
    global.fetch = jest.fn(async () => ({
      ok: true,
      text: async () => JSON.stringify({ id: 'meeting-1', status: 'created' }),
    })) as jest.Mock;

    await expect(finalizeFixtureMeeting(
      { meetingApiBase: 'https://meeting.example.com' },
      'access-token',
      { id: 'meeting-1', status: 'created' },
    )).rejects.toThrow('unexpected status: created');
  });
});
