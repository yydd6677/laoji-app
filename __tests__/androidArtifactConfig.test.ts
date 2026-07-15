declare const require: (path: string) => {
  validateEmbeddedAppConfig: (config: object, mode: 'production' | 'rehearsal') => void;
};

const { validateEmbeddedAppConfig } = require('../scripts/androidArtifactConfig.js');

function embeddedConfig(appEnv = 'production') {
  return {
    extra: {
      appEnv,
      laojiApiBase: 'https://api.release-domain.cn',
      meetingApiBase: 'https://meetings.release-domain.cn',
      realtimeAsrHost: 'realtime.release-domain.cn',
      realtimeAsrPort: 443,
      realtimeAsrSecure: true,
      realtimeAsrProvider: 'qwen',
      privacyPolicyUrl: 'https://www.release-domain.cn/privacy',
      termsOfServiceUrl: 'https://www.release-domain.cn/terms',
      accountDeletionUrl: 'https://www.release-domain.cn/account-deletion',
    },
  };
}

describe('embedded Android artifact configuration policy', () => {
  it('accepts a complete production submission configuration', () => {
    expect(() => validateEmbeddedAppConfig(embeddedConfig(), 'production')).not.toThrow();
  });

  it('does not allow a rehearsal artifact to pass as production', () => {
    expect(() => validateEmbeddedAppConfig(
      embeddedConfig('production-rehearsal'),
      'production',
    )).toThrow('appEnv must be production');
  });

  it.each([
    ['laojiApiBase', 'https://api.example.com'],
    ['meetingApiBase', 'https://meetings.example.test'],
    ['privacyPolicyUrl', 'https://placeholder.release-domain.cn/privacy'],
  ])('rejects a production placeholder in %s', (name, value) => {
    const config = embeddedConfig();
    Object.assign(config.extra, { [name]: value });
    expect(() => validateEmbeddedAppConfig(config, 'production')).toThrow('reserved or placeholder');
  });

  it('accepts placeholders only in a secure rehearsal artifact', () => {
    const config = embeddedConfig('production-rehearsal');
    Object.assign(config.extra, {
      laojiApiBase: 'https://api.example.com',
      meetingApiBase: 'https://meetings.example.com',
      realtimeAsrHost: 'realtime.example.com',
      privacyPolicyUrl: 'https://www.example.com/privacy',
      termsOfServiceUrl: 'https://www.example.com/terms',
      accountDeletionUrl: 'https://www.example.com/account-deletion',
    });
    expect(() => validateEmbeddedAppConfig(config, 'rehearsal')).not.toThrow();
  });

  it('rejects insecure transport even in rehearsal mode', () => {
    const config = embeddedConfig('production-rehearsal');
    config.extra.laojiApiBase = 'http://api.example.com';
    expect(() => validateEmbeddedAppConfig(config, 'rehearsal')).toThrow('HTTPS');
  });

  it('rejects a missing or unknown embedded ASR provider', () => {
    const missing = embeddedConfig();
    delete (missing.extra as { realtimeAsrProvider?: string }).realtimeAsrProvider;
    expect(() => validateEmbeddedAppConfig(missing, 'production')).toThrow('realtimeAsrProvider');

    const unknown = embeddedConfig();
    unknown.extra.realtimeAsrProvider = 'unknown';
    expect(() => validateEmbeddedAppConfig(unknown, 'production')).toThrow('realtimeAsrProvider');
  });
});
