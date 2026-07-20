declare const require: (path: string) => (config: object) => {
  modResults: {
    manifest: { application: Array<{ $: Record<string, string> }> };
  };
};

const originalEnv = { ...process.env };
const mockWithAndroidManifest = jest.fn((
  config: object,
  action: (androidConfig: {
    modResults: {
      manifest: { application: Array<{ $: Record<string, string> }> };
    };
  }) => void,
) => {
  const androidConfig = {
    modResults: {
      manifest: { application: [{ $: {} as Record<string, string> }] },
    },
  };
  action(androidConfig);
  return { ...config, modResults: androidConfig.modResults };
});

jest.mock('@expo/config-plugins', () => ({
  withAndroidManifest: mockWithAndroidManifest,
}));

describe('Android cleartext deployment gate', () => {
  afterEach(() => {
    process.env = { ...originalEnv };
    jest.resetModules();
  });

  function generatedValue(env: Record<string, string>): string | undefined {
    process.env = { ...originalEnv, ...env };
    const plugin = require('../plugins/withAndroidCleartextTraffic.js');
    return plugin({}).modResults.manifest.application[0].$['android:usesCleartextTraffic'];
  }

  it('keeps cleartext disabled for a production rehearsal', () => {
    expect(generatedValue({
      APP_ENV: 'production-rehearsal',
      EXPO_ALLOW_CLEARTEXT: 'true',
    })).toBe('false');
  });

  it('allows an explicit internal preview cleartext build', () => {
    expect(generatedValue({
      APP_ENV: 'preview',
      EXPO_ALLOW_CLEARTEXT: 'true',
    })).toBe('true');
  });

  it('lets the EAS production profile override a conflicting APP_ENV', () => {
    expect(generatedValue({
      APP_ENV: 'preview',
      EAS_BUILD_PROFILE: 'production',
      EXPO_ALLOW_CLEARTEXT: 'true',
    })).toBe('false');
  });
});
