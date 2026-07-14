declare const require: (path: string) => (config: object) => {
  modResults: Array<{ type: string; key: string; value: string }>;
  appBuildGradle: string;
};

const mockWithGradleProperties = jest.fn((
  config: object,
  action: (gradleConfig: {
    modResults: Array<{ type: string; key: string; value: string }>;
  }) => void,
) => {
  const gradleConfig = {
    modResults: [
      { type: 'property', key: 'org.gradle.jvmargs', value: '-Xmx512m' },
    ],
  };
  action(gradleConfig);
  return { ...config, modResults: gradleConfig.modResults };
});

const mockWithAppBuildGradle = jest.fn((
  config: object,
  action: (gradleConfig: {
    modResults: { language: string; contents: string };
  }) => void,
) => {
  const gradleConfig = {
    modResults: {
      language: 'groovy',
      contents: 'proguardFiles getDefaultProguardFile("proguard-android.txt"), "proguard-rules.pro"',
    },
  };
  action(gradleConfig);
  return { ...config, appBuildGradle: gradleConfig.modResults.contents };
});

jest.mock('@expo/config-plugins', () => ({
  withAppBuildGradle: mockWithAppBuildGradle,
  withGradleProperties: mockWithGradleProperties,
}));

describe('Android release optimization config', () => {
  it('keeps release shrinking and gives full builds enough JVM metaspace', () => {
    const plugin = require('../plugins/withAndroidReleaseOptimizations.js');
    const result = plugin({});
    const properties = Object.fromEntries(
      result.modResults.map(item => [item.key, item.value]),
    );

    expect(properties['org.gradle.jvmargs'])
      .toBe('-Xmx3072m -XX:MaxMetaspaceSize=1024m -Dfile.encoding=UTF-8');
    expect(properties['android.enableMinifyInReleaseBuilds']).toBe('true');
    expect(properties['android.enableShrinkResourcesInReleaseBuilds']).toBe('true');
    expect(result.appBuildGradle).toContain(
      'node_modules/expo-notifications/android/proguard-rules.pro',
    );
    expect(result.appBuildGradle).toContain(
      '// LaoJi expo-notifications serialization keep rules',
    );
  });
});
