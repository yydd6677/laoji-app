const assert = require('assert');
const path = require('path');
const { validateEmbeddedAppConfig } = require('./androidArtifactConfig');

const projectRoot = path.resolve(__dirname, '..');
const configPath = path.join(projectRoot, 'app.config.js');
const eas = require(path.join(projectRoot, 'eas.json'));

const MANAGED_ENV_KEYS = [
  'APP_ENV',
  'EAS_BUILD_PROFILE',
  'EXPO_ALLOW_CLEARTEXT',
  'EXPO_PUBLIC_LAOJI_API_BASE',
  'EXPO_PUBLIC_MEETING_API_BASE',
  'EXPO_PUBLIC_REALTIME_ASR_HOST',
  'EXPO_PUBLIC_REALTIME_ASR_PORT',
  'EXPO_PUBLIC_REALTIME_ASR_PROVIDER',
  'EXPO_PUBLIC_REALTIME_ASR_SECURE',
  'EXPO_PUBLIC_PRIVACY_POLICY_URL',
  'EXPO_PUBLIC_TERMS_OF_SERVICE_URL',
  'EXPO_PUBLIC_ACCOUNT_DELETION_URL',
];

function loadConfig(environment) {
  const original = Object.fromEntries(MANAGED_ENV_KEYS.map(key => [key, process.env[key]]));
  try {
    for (const key of MANAGED_ENV_KEYS) delete process.env[key];
    Object.assign(process.env, environment);
    delete require.cache[require.resolve(configPath)];
    return require(configPath)();
  } finally {
    for (const key of MANAGED_ENV_KEYS) {
      if (original[key] === undefined) delete process.env[key];
      else process.env[key] = original[key];
    }
    delete require.cache[require.resolve(configPath)];
  }
}

const productionProfile = eas?.build?.production;
assert(productionProfile, 'eas.json must define a production profile');
assert.strictEqual(productionProfile.android?.buildType, 'app-bundle');
assert.strictEqual(productionProfile.env?.APP_ENV, 'production');
assert.strictEqual(productionProfile.env?.EXPO_ALLOW_CLEARTEXT, 'false');
assert.strictEqual(productionProfile.env?.EXPO_PUBLIC_REALTIME_ASR_PROVIDER, 'qwen');

const secureFixture = {
  APP_ENV: 'production',
  EAS_BUILD_PROFILE: 'production',
  EXPO_ALLOW_CLEARTEXT: 'false',
  EXPO_PUBLIC_LAOJI_API_BASE: 'https://api.release-domain.cn',
  EXPO_PUBLIC_MEETING_API_BASE: 'https://meetings.release-domain.cn',
  EXPO_PUBLIC_REALTIME_ASR_HOST: 'realtime.release-domain.cn',
  EXPO_PUBLIC_REALTIME_ASR_PORT: '443',
  EXPO_PUBLIC_REALTIME_ASR_PROVIDER: 'qwen',
  EXPO_PUBLIC_REALTIME_ASR_SECURE: 'true',
  EXPO_PUBLIC_PRIVACY_POLICY_URL: 'https://www.release-domain.cn/privacy',
  EXPO_PUBLIC_TERMS_OF_SERVICE_URL: 'https://www.release-domain.cn/terms',
  EXPO_PUBLIC_ACCOUNT_DELETION_URL: 'https://www.release-domain.cn/account-deletion',
};
const productionConfig = loadConfig(secureFixture);
assert.strictEqual(productionConfig.android?.allowBackup, false);
assert(Number.isSafeInteger(productionConfig.android?.versionCode));
assert(productionConfig.plugins?.includes('./plugins/withAndroidCleartextTraffic'));
validateEmbeddedAppConfig(productionConfig, 'production');

assert.throws(() => loadConfig({
  ...secureFixture,
  EXPO_PUBLIC_LAOJI_API_BASE: 'http://203.0.113.10:18035',
}), /HTTPS domain|Production service URLs/);
assert.throws(() => loadConfig({
  APP_ENV: 'production',
  EAS_BUILD_PROFILE: 'production',
  EXPO_ALLOW_CLEARTEXT: 'false',
  EXPO_PUBLIC_REALTIME_ASR_PROVIDER: 'qwen',
}), /configuration is incomplete/);

console.log('Android release configuration gate passed; production remains fail-closed without final HTTPS domains.');
