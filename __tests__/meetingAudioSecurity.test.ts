import {
  meetingAudioUrlErrorMessage,
  validateMeetingAudioUrl,
} from '../src/services/meetingAudioSecurity';
import { ApiConfig } from '../src/services/config';

function config(overrides: Partial<ApiConfig> = {}): ApiConfig {
  return {
    appEnv: 'production',
    laojiApiBase: 'https://api.example.com',
    meetingApiBase: 'https://meetings.example.com',
    realtimeAsrHost: 'realtime.example.com',
    realtimeAsrPort: 443,
    realtimeAsrSecure: true,
    privacyPolicyUrl: 'https://www.example.com/privacy',
    termsOfServiceUrl: 'https://www.example.com/terms',
    accountDeletionUrl: 'https://www.example.com/account-deletion',
    isProduction: true,
    ...overrides,
  };
}

describe('meeting audio URL security', () => {
  it('accepts same-origin authenticated audio and normalizes relative paths', () => {
    expect(validateMeetingAudioUrl(
      '/api/laoji/meetings/1/audio/file',
      { requiresAuth: true },
      config(),
    )).toBe('https://meetings.example.com/api/laoji/meetings/1/audio/file');
  });

  it('allows an external signed HTTPS URL only when no login token is required', () => {
    expect(validateMeetingAudioUrl(
      'https://cdn.example.com/signed/audio.m4a?signature=test',
      { requiresAuth: false },
      config(),
    )).toBe('https://cdn.example.com/signed/audio.m4a?signature=test');
  });

  it('rejects external origins before attaching an authorization header', () => {
    expect(() => validateMeetingAudioUrl(
      'https://external.example/audio.m4a',
      { requiresAuth: true },
      config(),
    )).toThrow(expect.objectContaining({ code: 'AUTH_ORIGIN_MISMATCH' }));
  });

  it('rejects cleartext production audio and unsupported protocols', () => {
    expect(() => validateMeetingAudioUrl('http://meetings.example.com/audio', {}, config()))
      .toThrow(expect.objectContaining({ code: 'INSECURE_URL' }));
    expect(() => validateMeetingAudioUrl('file:///data/private/audio.wav', {}, config()))
      .toThrow(expect.objectContaining({ code: 'INVALID_URL' }));
    expect(() => validateMeetingAudioUrl('https://user:secret@meetings.example.com/audio', {}, config()))
      .toThrow(expect.objectContaining({ code: 'INVALID_URL' }));
  });

  it('rejects expired and malformed expiry values with a user-readable reason', () => {
    let expired: unknown;
    try {
      validateMeetingAudioUrl(
        'https://meetings.example.com/audio',
        { expiresAt: '2026-07-10T00:00:00Z', nowMs: Date.parse('2026-07-11T00:00:00Z') },
        config(),
      );
    } catch (error) {
      expired = error;
    }
    expect(expired).toMatchObject({ code: 'EXPIRED' });
    expect(meetingAudioUrlErrorMessage(expired)).toContain('已过期');

    expect(() => validateMeetingAudioUrl(
      'https://meetings.example.com/audio',
      { expiresAt: 'not-a-date' },
      config(),
    )).toThrow(expect.objectContaining({ code: 'INVALID_URL' }));
  });
});
