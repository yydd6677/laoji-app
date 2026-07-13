import { assertProductionApiConfig, getApiConfig } from '../src/services/config';

describe('API config', () => {
  it('reads and normalizes embedded build values', () => {
    const config = getApiConfig({
      appEnv: 'preview',
      laojiApiBase: 'http://preview.example:18035/',
      meetingApiBase: 'http://preview.example:18020///',
      realtimeAsrHost: 'preview.example',
      realtimeAsrPort: '18020',
      realtimeAsrSecure: 'false',
    });

    expect(config.laojiApiBase).toBe('http://preview.example:18035');
    expect(config.meetingApiBase).toBe('http://preview.example:18020');
    expect(config.realtimeAsrPort).toBe(18020);
    expect(config.appEnv).toBe('preview');
    expect(config.privacyPolicyUrl).toBe('http://preview.example:18035/privacy');
    expect(config.termsOfServiceUrl).toBe('http://preview.example:18035/terms');
    expect(config.accountDeletionUrl).toBe('http://preview.example:18035/account-deletion');
  });

  it('rejects plain HTTP production endpoints', () => {
    const config = getApiConfig({
      appEnv: 'production',
      laojiApiBase: 'http://api.release-domain.cn',
      meetingApiBase: 'https://meetings.release-domain.cn',
      realtimeAsrHost: 'realtime.release-domain.cn',
      realtimeAsrSecure: true,
    });

    expect(() => assertProductionApiConfig(config)).toThrow('Production API endpoints');
  });

  it('accepts HTTPS production domains', () => {
    const config = getApiConfig({
      appEnv: 'production',
      laojiApiBase: 'https://api.release-domain.cn',
      meetingApiBase: 'https://meetings.release-domain.cn',
      realtimeAsrHost: 'realtime.release-domain.cn',
      realtimeAsrSecure: true,
    });

    expect(() => assertProductionApiConfig(config)).not.toThrow();
  });

  it('rejects an insecure external privacy or deletion page in production', () => {
    const config = getApiConfig({
      appEnv: 'production',
      laojiApiBase: 'https://api.release-domain.cn',
      meetingApiBase: 'https://api.release-domain.cn',
      realtimeAsrHost: 'api.release-domain.cn',
      realtimeAsrSecure: true,
      privacyPolicyUrl: 'http://policy.release-domain.cn/privacy',
      termsOfServiceUrl: 'https://api.release-domain.cn/terms',
      accountDeletionUrl: 'https://api.release-domain.cn/account-deletion',
    });

    expect(() => assertProductionApiConfig(config)).toThrow('Production API endpoints');
  });

  it.each([
    ['not a URL', 'not-a-url', 'https://meetings.release-domain.cn', 'realtime.release-domain.cn'],
    ['single-label host', 'https://internal', 'https://meetings.release-domain.cn', 'realtime.release-domain.cn'],
    ['credentials', ['https://user', 'secret@api.release-domain.cn'].join(':'), 'https://meetings.release-domain.cn', 'realtime.release-domain.cn'],
    ['ASR path', 'https://api.release-domain.cn', 'https://meetings.release-domain.cn', 'realtime.release-domain.cn/path'],
  ])('rejects malformed production configuration: %s', (_label, laojiApiBase, meetingApiBase, realtimeAsrHost) => {
    const config = getApiConfig({
      appEnv: 'production',
      laojiApiBase,
      meetingApiBase,
      realtimeAsrHost,
      realtimeAsrSecure: true,
    });

    expect(() => assertProductionApiConfig(config)).toThrow('Production API endpoints');
  });

  it('fails clearly when build-time endpoints are missing', () => {
    expect(() => assertProductionApiConfig(getApiConfig({ appEnv: 'preview' }))).toThrow('configuration is missing');
  });

  it('rejects reserved placeholder domains in a production submission', () => {
    const config = getApiConfig({
      appEnv: 'production',
      laojiApiBase: 'https://api.example.com',
      meetingApiBase: 'https://meetings.release-domain.cn',
      realtimeAsrHost: 'realtime.release-domain.cn',
      realtimeAsrSecure: true,
    });
    expect(() => assertProductionApiConfig(config)).toThrow('reserved or placeholder domains');
  });

  it('keeps production security checks in the explicit rehearsal mode', () => {
    const secureRehearsal = getApiConfig({
      appEnv: 'production-rehearsal',
      laojiApiBase: 'https://api.example.com',
      meetingApiBase: 'https://meetings.example.com',
      realtimeAsrHost: 'realtime.example.com',
      realtimeAsrSecure: true,
    });
    expect(secureRehearsal.isProduction).toBe(true);
    expect(() => assertProductionApiConfig(secureRehearsal)).not.toThrow();

    const insecureRehearsal = getApiConfig({
      appEnv: 'production-rehearsal',
      laojiApiBase: 'http://api.example.com',
      meetingApiBase: 'https://meetings.example.com',
      realtimeAsrHost: 'realtime.example.com',
      realtimeAsrSecure: true,
    });
    expect(() => assertProductionApiConfig(insecureRehearsal)).toThrow('HTTPS/WSS');
  });
});
