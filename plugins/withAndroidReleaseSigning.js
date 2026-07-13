const fs = require('fs');
const path = require('path');
const { withAppBuildGradle } = require('@expo/config-plugins');
const { isSecureDeploymentMode, resolveDeploymentMode } = require('../config/deploymentMode');

const MARKER = '// LaoJi local release signing';

module.exports = function withAndroidReleaseSigning(config) {
  const propertiesPath = process.env.LAOJI_SIGNING_PROPERTIES;
  const isProductionLike = isSecureDeploymentMode(resolveDeploymentMode(process.env));
  const easManagesSigning = ['1', 'true'].includes(String(process.env.EAS_BUILD || '').toLowerCase());
  if (!propertiesPath) {
    if (isProductionLike && !easManagesSigning) {
      throw new Error('LAOJI_SIGNING_PROPERTIES is required for a local production-like Android build.');
    }
    return config;
  }

  const absolutePath = path.resolve(propertiesPath);
  if (!fs.existsSync(absolutePath)) {
    throw new Error(`LAOJI_SIGNING_PROPERTIES does not exist: ${absolutePath}`);
  }

  return withAppBuildGradle(config, gradleConfig => {
    if (gradleConfig.modResults.language !== 'groovy') {
      throw new Error('LaoJi local signing currently requires a Groovy app/build.gradle file.');
    }

    let source = gradleConfig.modResults.contents;
    if (source.includes(MARKER)) return gradleConfig;

    const escapedPath = absolutePath.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    const loader = `${MARKER}\n` +
      `def laojiSigningProperties = new Properties()\n` +
      `def laojiSigningPropertiesFile = file("${escapedPath}")\n` +
      `laojiSigningPropertiesFile.withInputStream { laojiSigningProperties.load(it) }\n\n`;
    source = source.replace('\nandroid {', `\n${loader}android {`);

    const signingAnchor = 'signingConfigs {\n        debug {';
    if (!source.includes(signingAnchor)) {
      throw new Error('Unable to locate Android signingConfigs block.');
    }
    source = source.replace(
      signingAnchor,
      `signingConfigs {\n` +
      `        release {\n` +
      `            storeFile file(laojiSigningProperties['storeFile'])\n` +
      `            storePassword laojiSigningProperties['storePassword']\n` +
      `            keyAlias laojiSigningProperties['keyAlias']\n` +
      `            keyPassword laojiSigningProperties['keyPassword']\n` +
      `        }\n` +
      `        debug {`,
    );

    const debugSigning = 'signingConfig signingConfigs.debug';
    const releaseSigningIndex = source.lastIndexOf(debugSigning);
    if (releaseSigningIndex < 0) {
      throw new Error('Unable to locate Android release signing assignment.');
    }
    source = `${source.slice(0, releaseSigningIndex)}signingConfig signingConfigs.release${source.slice(releaseSigningIndex + debugSigning.length)}`;
    gradleConfig.modResults.contents = source;
    return gradleConfig;
  });
};
