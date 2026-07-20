declare const require: (path: string) => () => unknown;

const originalEnv = { ...process.env };

describe('Expo app config release gates', () => {
  afterEach(() => {
    process.env = { ...originalEnv };
    jest.resetModules();
  });

  function configureProduction(overrides: Record<string, string> = {}) {
    process.env = {
      ...originalEnv,
      APP_ENV: 'production',
      EXPO_PUBLIC_LAOJI_API_BASE: 'https://api.release-domain.cn',
      EXPO_PUBLIC_MEETING_API_BASE: 'https://meetings.release-domain.cn',
      EXPO_PUBLIC_REALTIME_ASR_HOST: 'realtime.release-domain.cn',
      EXPO_PUBLIC_REALTIME_ASR_PORT: '443',
      EXPO_PUBLIC_REALTIME_ASR_SECURE: 'true',
      EXPO_PUBLIC_REALTIME_ASR_PROVIDER: 'qwen',
      EXPO_PUBLIC_PRIVACY_POLICY_URL: 'https://www.release-domain.cn/privacy',
      EXPO_PUBLIC_TERMS_OF_SERVICE_URL: 'https://www.release-domain.cn/terms',
      EXPO_PUBLIC_ACCOUNT_DELETION_URL: 'https://www.release-domain.cn/account-deletion',
      ...overrides,
    };
  }

  function loadConfig() {
    return require('../app.config.js')();
  }

  it('accepts complete production HTTPS and WSS domains', () => {
    configureProduction();
    const config = loadConfig() as {
      splash?: { backgroundColor?: string };
      androidStatusBar?: { backgroundColor?: string; barStyle?: string };
      androidNavigationBar?: { backgroundColor?: string; barStyle?: string };
      android?: {
        versionCode?: number;
        allowBackup?: boolean;
        blockedPermissions?: string[];
        adaptiveIcon?: { backgroundColor?: string };
      };
      plugins?: Array<string | [string, Record<string, unknown>]>;
      extra?: { realtimeAsrProvider?: string };
    };
    expect(config.android?.versionCode).toBe(80);
    expect(config.android?.allowBackup).toBe(false);
    expect(config.android?.blockedPermissions).toEqual(expect.arrayContaining([
      'android.permission.CAMERA',
      'android.permission.READ_MEDIA_IMAGES',
      'android.permission.SYSTEM_ALERT_WINDOW',
      'com.google.android.c2dm.permission.RECEIVE',
    ]));
    expect(config.splash?.backgroundColor).toBe('#FFFFFF');
    expect(config.android?.adaptiveIcon?.backgroundColor).toBe('#FFFFFF');
    expect(config.androidStatusBar).toEqual({ backgroundColor: '#FFFFFF', barStyle: 'dark-content' });
    expect(config.androidNavigationBar).toEqual({ backgroundColor: '#FFFFFF', barStyle: 'dark-content' });
    expect(config.extra?.realtimeAsrProvider).toBe('qwen');
    expect(config.plugins).toEqual(expect.arrayContaining([
      ['expo-notifications', { color: '#1456F0' }],
      ['expo-splash-screen', expect.objectContaining({
        backgroundColor: '#FFFFFF',
        imageWidth: 288,
      })],
    ]));
  });

  it('rejects unknown realtime ASR providers', () => {
    configureProduction({ EXPO_PUBLIC_REALTIME_ASR_PROVIDER: 'not-an-asr' });
    expect(loadConfig).toThrow('EXPO_PUBLIC_REALTIME_ASR_PROVIDER');
  });

  it.each([
    ['not-a-url', 'realtime.release-domain.cn'],
    ['http://api.release-domain.cn', 'realtime.release-domain.cn'],
    ['https://203.0.113.10', 'realtime.release-domain.cn'],
    ['https://api.release-domain.cn', 'realtime.release-domain.cn/path'],
  ])('rejects malformed production endpoints', (apiBase, realtimeHost) => {
    configureProduction({
      EXPO_PUBLIC_LAOJI_API_BASE: apiBase,
      EXPO_PUBLIC_REALTIME_ASR_HOST: realtimeHost,
    });
    expect(loadConfig).toThrow();
  });

  it('rejects insecure production policy URLs', () => {
    configureProduction({ EXPO_PUBLIC_PRIVACY_POLICY_URL: 'http://www.release-domain.cn/privacy' });
    expect(loadConfig).toThrow('EXPO_PUBLIC_PRIVACY_POLICY_URL');
  });

  it.each([
    ['EXPO_PUBLIC_LAOJI_API_BASE', 'https://api.example.com'],
    ['EXPO_PUBLIC_MEETING_API_BASE', 'https://meetings.example.test'],
    ['EXPO_PUBLIC_REALTIME_ASR_HOST', 'realtime.placeholder.release-domain.cn'],
    ['EXPO_PUBLIC_PRIVACY_POLICY_URL', 'https://www.example.org/privacy'],
  ])('rejects a production placeholder in %s', (name, value) => {
    configureProduction({ [name]: value });
    expect(loadConfig).toThrow('reserved or placeholder domain');
  });

  it('allows reserved domains only in the explicit secure rehearsal mode', () => {
    configureProduction({
      APP_ENV: 'production-rehearsal',
      EXPO_PUBLIC_LAOJI_API_BASE: 'https://api.laoji.example.com',
      EXPO_PUBLIC_MEETING_API_BASE: 'https://meetings.laoji.example.com',
      EXPO_PUBLIC_REALTIME_ASR_HOST: 'realtime.laoji.example.com',
      EXPO_PUBLIC_PRIVACY_POLICY_URL: 'https://www.laoji.example.com/privacy',
      EXPO_PUBLIC_TERMS_OF_SERVICE_URL: 'https://www.laoji.example.com/terms',
      EXPO_PUBLIC_ACCOUNT_DELETION_URL: 'https://www.laoji.example.com/account-deletion',
    });
    const config = loadConfig() as { extra?: { appEnv?: string } };
    expect(config.extra?.appEnv).toBe('production-rehearsal');
  });

  it('treats the EAS production profile as a submission even if APP_ENV conflicts', () => {
    configureProduction({
      APP_ENV: 'production-rehearsal',
      EAS_BUILD_PROFILE: 'production',
      EXPO_PUBLIC_LAOJI_API_BASE: 'https://api.example.com',
    });
    expect(loadConfig).toThrow('reserved or placeholder domain');
  });
});
