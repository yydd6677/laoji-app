const { withAndroidManifest, withAppBuildGradle, withSettingsGradle } = require('@expo/config-plugins');

const RECORDING_SERVICE = 'com.laoji.nativeplatform.audio.LaojiRecordingService';
const PLAYBACK_SERVICE = 'com.laoji.nativeplatform.media.LaojiMinutesPlaybackService';

function findOrCreateService(application, name) {
  application.service = application.service || [];
  const existing = application.service.find(item => item.$?.['android:name'] === name);
  if (existing) return existing;
  const service = { $: { 'android:name': name } };
  application.service.push(service);
  return service;
}

module.exports = function withLaojiNativePlatform(config) {
  const withServices = withAndroidManifest(config, androidConfig => {
    const application = androidConfig.modResults.manifest.application?.[0];
    if (!application) {
      throw new Error('LaoJi native platform requires an Android application manifest node.');
    }

    const service = findOrCreateService(application, RECORDING_SERVICE);
    service.$['android:name'] = RECORDING_SERVICE;
    service.$['android:exported'] = 'false';
    service.$['android:foregroundServiceType'] = 'microphone';
    service.$['android:stopWithTask'] = 'false';

    const playback = findOrCreateService(application, PLAYBACK_SERVICE);
    playback.$['android:exported'] = 'true';
    playback.$['android:foregroundServiceType'] = 'mediaPlayback';
    playback.$['android:stopWithTask'] = 'false';
    playback['intent-filter'] = [{
      action: [
        { $: { 'android:name': 'androidx.media3.session.MediaSessionService' } },
        { $: { 'android:name': 'android.media.browse.MediaBrowserService' } },
      ],
    }];
    return androidConfig;
  });

  const withEvidenceLint = withSettingsGradle(withServices, androidConfig => {
    const marker = '// @generated-by-laoji-feishu-evidence-lint';
    if (androidConfig.modResults.contents.includes(marker)) return androidConfig;
    androidConfig.modResults.contents += `

${marker}
include ':feishu-evidence-lint'
project(':feishu-evidence-lint').projectDir = new File(rootDir, '../tools/feishu-evidence-lint')
`;
    return androidConfig;
  });

  return withAppBuildGradle(withEvidenceLint, androidConfig => {
    const marker = '// @generated-by-laoji-feishu-evidence-gate';
    if (androidConfig.modResults.contents.includes(marker)) return androidConfig;
    androidConfig.modResults.contents += `

${marker}
def laojiRepoRoot = rootDir.parentFile
def laojiPython3 = System.getenv('PYTHON3') ?: 'python3'
def laojiNode = System.getenv('NODE_BINARY') ?: 'node'
def laojiParityAssets = layout.buildDirectory.dir('generated/laojiParityAssets').get().asFile
def laojiTypeScriptAstReport = new File(laojiRepoRoot, 'build/feishu-ui-ast-report.json')
def laojiWorkspaceSourceReport = new File(laojiRepoRoot, 'build/workspace-source-resolution-report.json')
android.sourceSets.main.assets.srcDir(laojiParityAssets)

tasks.register('verifyLaojiWorkspaceSource', Exec) {
    group = 'verification'
    description = 'Proves Node, Metro and Expo autolinking resolve this worktree.'
    workingDir laojiRepoRoot
    outputs.file(laojiWorkspaceSourceReport)
    commandLine laojiNode,
        'scripts/check_workspace_source_resolution.js',
        'check',
        '--output',
        laojiWorkspaceSourceReport.absolutePath
}

tasks.register('verifyLaojiTypeScriptEvidence', Exec) {
    group = 'verification'
    description = 'Generates and enforces the Android-active TypeScript AST evidence report.'
    workingDir laojiRepoRoot
    outputs.file(laojiTypeScriptAstReport)
    commandLine laojiNode,
        'scripts/feishu_ui_ast_gate.js',
        'check',
        '--output',
        laojiTypeScriptAstReport.absolutePath
}

tasks.register('generateLaojiParityAttestation', Exec) {
    group = 'verification'
    description = 'Fail-closed Feishu evidence verification and embedded release attestation.'
    workingDir laojiRepoRoot
    outputs.file(new File(laojiParityAssets, 'parity-attestation.json'))
    dependsOn tasks.named('verifyLaojiWorkspaceSource')
    dependsOn tasks.named('verifyLaojiTypeScriptEvidence')
    dependsOn ':laoji-native-platform:verifyFeishuEvidenceLint'
    doFirst { laojiParityAssets.mkdirs() }
    commandLine laojiPython3,
        'scripts/feishu_evidence_gate.py',
        'attest',
        '--output',
        new File(laojiParityAssets, 'parity-attestation.json').absolutePath
}

tasks.matching { it.name == 'preReleaseBuild' }.configureEach {
    dependsOn tasks.named('generateLaojiParityAttestation')
}
`;
    return androidConfig;
  });
};

module.exports.RECORDING_SERVICE = RECORDING_SERVICE;
module.exports.PLAYBACK_SERVICE = PLAYBACK_SERVICE;
