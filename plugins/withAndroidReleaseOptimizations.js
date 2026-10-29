const fs = require('fs');
const path = require('path');
const { withAppBuildGradle, withGradleProperties } = require('@expo/config-plugins');

const NOTIFICATIONS_PROGUARD_MARKER = '// LaoJi expo-notifications serialization keep rules';
const PROGUARD_ANCHOR = 'proguardFiles getDefaultProguardFile("proguard-android.txt"), "proguard-rules.pro"';
const RELEASE_CONTRACT_MARKER = '// @generated-by-laoji-release-contract-verification';
const LINT_COMPATIBILITY_MARKER = '// @generated-by-laoji-lint-compatibility';
const LINT_COMPATIBILITY_BLOCK = `
    ${LINT_COMPATIBILITY_MARKER}
    // lifecycle-lint's detector is binary-incompatible with the Android lint
    // runtime used by this Expo/AGP combination and crashes before reporting
    // any source finding. Disable only that broken third-party detector.
    lint {
        disable 'NullSafeMutableLiveData'
    }
`;
const RELEASE_CONTRACT_BLOCK = `

${RELEASE_CONTRACT_MARKER}
// A Release APK is installable production output unless an isolated test
// explicitly opts out. Verify the embedded Expo config after bundling so an
// APK with development flags or no device bootstrap key cannot be published.
def allowNonProductionRelease = providers.gradleProperty("laoji.allowNonProductionRelease")
    .map { it.toBoolean() }
    .orElse(false)
def verifyLaojiReleaseContract = tasks.register("verifyLaojiReleaseContract", Exec) {
    onlyIf { !allowNonProductionRelease.get() }
    workingDir rootProject.projectDir.parentFile
    commandLine(
        "python3",
        new File(rootProject.projectDir.parentFile, "tools/verify_compact_apk_config.py").absolutePath,
        new File(project.buildDir, "outputs/apk/release/app-release.apk").absolutePath,
    )
}

afterEvaluate {
    tasks.named("assembleRelease").configure {
        finalizedBy(verifyLaojiReleaseContract)
    }
}
`;

const VALUES = {
  'org.gradle.jvmargs': '-Xmx3072m -XX:MaxMetaspaceSize=1024m -Dfile.encoding=UTF-8',
  // Public APKs target modern Android phones. Development tooling supplies
  // x86_64 explicitly for emulator-5562 instead of creating a universal APK.
  reactNativeArchitectures: 'arm64-v8a',
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
    if (!source.includes(NOTIFICATIONS_PROGUARD_MARKER)) {
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
      source = source.replace(
        PROGUARD_ANCHOR,
        `${PROGUARD_ANCHOR}, rootProject.file("../node_modules/expo-notifications/android/proguard-rules.pro") ${NOTIFICATIONS_PROGUARD_MARKER}`,
      );
    }
    if (!source.includes(LINT_COMPATIBILITY_MARKER)) {
      const packagingAnchor = '    packagingOptions {';
      if (!source.includes(packagingAnchor)) {
        throw new Error('Unable to locate the Android packaging configuration.');
      }
      source = source.replace(packagingAnchor, `${LINT_COMPATIBILITY_BLOCK}${packagingAnchor}`);
    }
    if (!source.includes(RELEASE_CONTRACT_MARKER)) source += RELEASE_CONTRACT_BLOCK;
    gradleConfig.modResults.contents = source;
    return gradleConfig;
  });
};
