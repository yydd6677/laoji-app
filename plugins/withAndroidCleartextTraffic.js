const { withAndroidManifest } = require('@expo/config-plugins');

module.exports = function withAndroidCleartextTraffic(config) {
  return withAndroidManifest(config, config => {
    const isProduction = process.env.APP_ENV === 'production'
      || process.env.EAS_BUILD_PROFILE === 'production';
    const allowCleartext = !isProduction || process.env.EXPO_ALLOW_CLEARTEXT === 'true';
    const application = config.modResults.manifest.application?.[0];
    if (application?.$) {
      application.$['android:usesCleartextTraffic'] = allowCleartext ? 'true' : 'false';
    }
    return config;
  });
};
