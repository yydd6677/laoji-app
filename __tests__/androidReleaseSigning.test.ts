declare const require: (path: string) => (config: object) => object;

const originalEnv = { ...process.env };

describe('Android release signing config gate', () => {
  afterEach(() => {
    process.env = { ...originalEnv };
    jest.resetModules();
  });

  function loadPlugin() {
    return require('../plugins/withAndroidReleaseSigning.js');
  }

  it('requires external signing properties for a local production build', () => {
    process.env = { ...originalEnv, APP_ENV: 'production' };
    delete process.env.LAOJI_SIGNING_PROPERTIES;
    delete process.env.EAS_BUILD;
    expect(() => loadPlugin()({})).toThrow('LAOJI_SIGNING_PROPERTIES is required');
  });

  it('allows the real EAS build environment to manage credentials', () => {
    process.env = { ...originalEnv, APP_ENV: 'production', EAS_BUILD: 'true' };
    delete process.env.LAOJI_SIGNING_PROPERTIES;
    expect(loadPlugin()({})).toEqual({});
  });

  it('does not treat a false EAS_BUILD string as managed signing', () => {
    process.env = { ...originalEnv, APP_ENV: 'production', EAS_BUILD: 'false' };
    delete process.env.LAOJI_SIGNING_PROPERTIES;
    expect(() => loadPlugin()({})).toThrow('LAOJI_SIGNING_PROPERTIES is required');
  });

  it('requires release signing for a local production rehearsal too', () => {
    process.env = { ...originalEnv, APP_ENV: 'production-rehearsal' };
    delete process.env.LAOJI_SIGNING_PROPERTIES;
    delete process.env.EAS_BUILD;
    expect(() => loadPlugin()({})).toThrow('LAOJI_SIGNING_PROPERTIES is required');
  });
});
