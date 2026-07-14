const fs = require('fs');
const path = require('path');
const { withAppBuildGradle, withGradleProperties } = require('@expo/config-plugins');

const NOTIFICATIONS_PROGUARD_MARKER = '// LaoJi expo-notifications serialization keep rules';
const PROGUARD_ANCHOR = 'proguardFiles getDefaultProguardFile("proguard-android.txt"), "proguard-rules.pro"';

const VALUES = {
  'org.gradle.jvmargs': '-Xmx3072m -XX:MaxMetaspaceSize=1024m -Dfile.encoding=UTF-8',
  'android.enableMinifyInReleaseBuilds': 'true',
  'android.enableShrinkResourcesInReleaseBuilds': 'true',
  'expo.gif.enabled': 'false',
  'expo.webp.enabled': 'true',
};

module.exports = function withAndroidReleaseOptimizations(config) {
  const withProperties = withGradleProperties(config, gradleConfig => {
    for (const [key, value] of Object.entries(VALUES)) {
      const existing = gradleConfig.modResults.find(item => item.type === 'property' && item.key === key);
      if (existing) existing.value = value;
      else gradleConfig.modResults.push({ type: 'property', key, value });
    }
    return gradleConfig;
  });

  return withAppBuildGradle(withProperties, gradleConfig => {
    if (gradleConfig.modResults.language !== 'groovy') {
      throw new Error('LaoJi Android release optimizations require a Groovy app/build.gradle file.');
    }

    let source = gradleConfig.modResults.contents;
    if (source.includes(NOTIFICATIONS_PROGUARD_MARKER)) return gradleConfig;
    if (!source.includes(PROGUARD_ANCHOR)) {
      throw new Error('Unable to locate the Android release ProGuard configuration.');
    }

    const rulesPath = path.resolve(
      __dirname,
      '../node_modules/expo-notifications/android/proguard-rules.pro',
    );
    if (!fs.existsSync(rulesPath)) {
      throw new Error(`expo-notifications ProGuard rules do not exist: ${rulesPath}`);
    }
    const gradlePath = rulesPath.replace(/\\/g, '/').replace(/"/g, '\\"');
    source = source.replace(
      PROGUARD_ANCHOR,
      `${PROGUARD_ANCHOR}, file("${gradlePath}") ${NOTIFICATIONS_PROGUARD_MARKER}`,
    );
    gradleConfig.modResults.contents = source;
    return gradleConfig;
  });
};
