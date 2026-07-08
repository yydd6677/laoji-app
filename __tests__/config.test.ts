import { assertProductionApiConfig, getApiConfig } from '../src/services/config';

const OLD_ENV = { ...process.env };

afterEach(() => {
  process.env = { ...OLD_ENV };
});

describe('API config', () => {
  it('uses the internal test server by default', () => {
    delete process.env.APP_ENV;
    delete process.env.EAS_BUILD_PROFILE;
    delete process.env.EXPO_PUBLIC_LAOJI_API_BASE;

    expect(getApiConfig().laojiApiBase).toBe('http://183.36.243.124:8035');
    expect(getApiConfig().meetingApiBase).toBe('http://183.36.243.124:8020');
  });

  it('rejects plain HTTP production endpoints', () => {
    process.env.APP_ENV = 'production';
    process.env.EXPO_PUBLIC_LAOJI_API_BASE = 'http://183.36.243.124:8035';
    process.env.EXPO_PUBLIC_MEETING_API_BASE = 'https://meetings.example.com';

    expect(() => assertProductionApiConfig(getApiConfig())).toThrow('Production API endpoints');
  });

  it('accepts HTTPS production domains', () => {
    process.env.APP_ENV = 'production';
    process.env.EXPO_PUBLIC_LAOJI_API_BASE = 'https://api.laoji.example.com';
    process.env.EXPO_PUBLIC_MEETING_API_BASE = 'https://meetings.laoji.example.com';

    expect(() => assertProductionApiConfig(getApiConfig())).not.toThrow();
  });
});
