const { withGradleProperties } = require('@expo/config-plugins');

const VALUES = {
  'org.gradle.jvmargs': '-Xmx3072m -XX:MaxMetaspaceSize=1024m -Dfile.encoding=UTF-8',
  'android.enableMinifyInReleaseBuilds': 'true',
  'android.enableShrinkResourcesInReleaseBuilds': 'true',
  'expo.gif.enabled': 'false',
  'expo.webp.enabled': 'true',
};

module.exports = function withAndroidReleaseOptimizations(config) {
  return withGradleProperties(config, gradleConfig => {
    for (const [key, value] of Object.entries(VALUES)) {
      const existing = gradleConfig.modResults.find(item => item.type === 'property' && item.key === key);
      if (existing) existing.value = value;
      else gradleConfig.modResults.push({ type: 'property', key, value });
    }
    return gradleConfig;
  });
};
