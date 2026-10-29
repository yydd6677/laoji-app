const { withAndroidStyles, withDangerousMod } = require('@expo/config-plugins');
const fs = require('node:fs/promises');
const path = require('node:path');

function applySplashBranding(resources) {
  const splash = (resources.style || []).find(style => style.$?.name === 'Theme.App.SplashScreen');
  if (!splash) throw new Error('Apply LaoJi branding after expo-splash-screen creates its theme.');
  splash.item = (splash.item || []).filter(item => item.$?.name !== 'android:windowSplashScreenBrandingImage');
  splash.item.push({
    $: { name: 'android:windowSplashScreenBrandingImage' },
    _: '@drawable/laoji_splash_credit',
  });
  return resources;
}

function withLaojiBranding(config) {
  config = withAndroidStyles(config, androidConfig => {
    applySplashBranding(androidConfig.modResults.resources);
    return androidConfig;
  });
  return withDangerousMod(config, ['android', async androidConfig => {
    const res = path.join(androidConfig.modRequest.platformProjectRoot, 'app/src/main/res');
    const destination = path.join(res, 'drawable-xxxhdpi');
    await fs.mkdir(destination, { recursive: true });
    await fs.copyFile(
      path.join(androidConfig.modRequest.projectRoot, 'assets/brand/splash-credit.png'),
      path.join(destination, 'laoji_splash_credit.png'),
    );
    return androidConfig;
  }]);
}

module.exports = withLaojiBranding;
module.exports.applySplashBranding = applySplashBranding;
