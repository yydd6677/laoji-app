const { withAndroidManifest } = require('@expo/config-plugins');
const { isSecureDeploymentMode, resolveDeploymentMode } = require('../config/deploymentMode');

module.exports = function withAndroidCleartextTraffic(config) {
  return withAndroidManifest(config, config => {
    const secureDeployment = isSecureDeploymentMode(resolveDeploymentMode(process.env));
    const allowCleartext = !secureDeployment && process.env.EXPO_ALLOW_CLEARTEXT === 'true';
    const application = config.modResults.manifest.application?.[0];
    if (application?.$) {
      application.$['android:usesCleartextTraffic'] = allowCleartext ? 'true' : 'false';
    }
    return config;
  });
};
