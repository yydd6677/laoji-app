const { withAppBuildGradle } = require('@expo/config-plugins');

function replaceDefaultConfigValue(source, key, value) {
  const defaultConfigStart = source.indexOf('defaultConfig {');
  if (defaultConfigStart < 0) {
    throw new Error(`Unable to locate Android defaultConfig for ${key}.`);
  }
  const nextBlock = source.indexOf('\n    }', defaultConfigStart);
  if (nextBlock < 0) {
    throw new Error(`Unable to locate Android defaultConfig end for ${key}.`);
  }
  const before = source.slice(0, defaultConfigStart);
  const block = source.slice(defaultConfigStart, nextBlock);
  const after = source.slice(nextBlock);
  const pattern = key === 'versionName'
    ? /versionName\s+['"][^'"]+['"]/m
    : /versionCode\s+\d+/m;
  if (!pattern.test(block)) {
    throw new Error(`Unable to locate Android ${key} in defaultConfig.`);
  }
  const replacement = key === 'versionName'
    ? `versionName "${value}"`
    : `versionCode ${value}`;
  return `${before}${block.replace(pattern, replacement)}${after}`;
}

module.exports = function withAndroidAppVersion(config) {
  return withAppBuildGradle(config, androidConfig => {
    if (androidConfig.modResults.language !== 'groovy') {
      throw new Error('LaoJi Android version synchronization requires a Groovy app/build.gradle file.');
    }
    const version = String(config.version || '').trim();
    const versionCode = Number(config.android?.versionCode);
    if (!version || !Number.isSafeInteger(versionCode) || versionCode < 1) {
      throw new Error('LaoJi Android version configuration is incomplete.');
    }
    let source = androidConfig.modResults.contents;
    source = replaceDefaultConfigValue(source, 'versionName', version);
    source = replaceDefaultConfigValue(source, 'versionCode', versionCode);
    androidConfig.modResults.contents = source;
    return androidConfig;
  });
};
