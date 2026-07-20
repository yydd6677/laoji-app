declare const require: (path: string) => ((config: object) => {
  modResults: {
    manifest: {
      application: Array<{
        $: Record<string, string>;
        service?: Array<{
          $: Record<string, string>;
          'intent-filter'?: Array<{ action: Array<{ $: Record<string, string> }> }>;
        }>;
      }>;
    };
  };
  contents?: string;
  settingsContents?: string;
  }) & { RECORDING_SERVICE: string; PLAYBACK_SERVICE: string };

const mockWithAndroidManifest = jest.fn((
  config: object,
  action: (androidConfig: {
    modResults: {
      manifest: {
        application: Array<{
          $: Record<string, string>;
          service?: Array<{
            $: Record<string, string>;
            'intent-filter'?: Array<{ action: Array<{ $: Record<string, string> }> }>;
          }>;
        }>;
      };
    };
  }) => void,
) => {
  const androidConfig = {
    modResults: {
      manifest: { application: [{ $: {} as Record<string, string> }] },
    },
  };
  action(androidConfig);
  return { ...config, modResults: androidConfig.modResults };
});

const mockWithAppBuildGradle = jest.fn((
  config: object,
  action: (androidConfig: { modResults: { contents: string } }) => void,
) => {
  const androidConfig = { modResults: { contents: '' } };
  action(androidConfig);
  return { ...config, contents: androidConfig.modResults.contents };
});

const mockWithSettingsGradle = jest.fn((
  config: object,
  action: (androidConfig: { modResults: { contents: string } }) => void,
) => {
  const androidConfig = { modResults: { contents: '' } };
  action(androidConfig);
  return { ...config, settingsContents: androidConfig.modResults.contents };
});

jest.mock('@expo/config-plugins', () => ({
  withAndroidManifest: mockWithAndroidManifest,
  withAppBuildGradle: mockWithAppBuildGradle,
  withSettingsGradle: mockWithSettingsGradle,
}));

describe('LaoJi native platform manifest plugin', () => {
  it('registers one non-exported microphone foreground service', () => {
    const plugin = require('../plugins/withLaojiNativePlatform.js');
    const first = plugin({});
    const service = first.modResults.manifest.application[0].service?.[0];

    expect(service?.$).toEqual({
      'android:name': plugin.RECORDING_SERVICE,
      'android:exported': 'false',
      'android:foregroundServiceType': 'microphone',
      'android:stopWithTask': 'false',
    });
    const playback = first.modResults.manifest.application[0].service?.[1];
    expect(playback?.$).toEqual({
      'android:name': plugin.PLAYBACK_SERVICE,
      'android:exported': 'true',
      'android:foregroundServiceType': 'mediaPlayback',
      'android:stopWithTask': 'false',
    });
    expect(playback?.['intent-filter']?.[0].action.map(item => item.$['android:name'])).toEqual([
      'androidx.media3.session.MediaSessionService',
      'android.media.browse.MediaBrowserService',
    ]);
    expect(first.contents).toContain('@generated-by-laoji-feishu-evidence-gate');
    expect(first.contents).toContain('@generated-by-laoji-java-time-desugaring');
    expect(first.contents).toContain('coreLibraryDesugaringEnabled true');
    expect(first.contents).toContain("coreLibraryDesugaring 'com.android.tools:desugar_jdk_libs:2.1.5'");
    expect(first.contents).toContain('generateLaojiParityAttestation');
    expect(first.contents).toContain('verifyLaojiTypeScriptEvidence');
    expect(first.contents).toContain('verifyLaojiWorkspaceSource');
    expect(first.contents).toContain(':laoji-native-platform:verifyFeishuEvidenceLint');
    expect((first as { settingsContents?: string }).settingsContents).toContain(
      '@generated-by-laoji-feishu-evidence-lint',
    );
  });

  it('does not duplicate the service when applied twice', () => {
    const plugin = require('../plugins/withLaojiNativePlatform.js');
    const first = plugin({});
    const application = first.modResults.manifest.application[0];
    mockWithAndroidManifest.mockImplementationOnce((config, action) => {
      const androidConfig = { modResults: { manifest: { application: [application] } } };
      action(androidConfig);
      return { ...config, modResults: androidConfig.modResults };
    });

    const second = plugin({});
    expect(second.modResults.manifest.application[0].service).toHaveLength(2);
  });

  it('adds the release evidence hook idempotently', () => {
    const plugin = require('../plugins/withLaojiNativePlatform.js');
    plugin({});
    const firstContents = mockWithAppBuildGradle.mock.results.at(-1)?.value.contents as string;
    mockWithAppBuildGradle.mockImplementationOnce((config, action) => {
      const androidConfig = { modResults: { contents: firstContents } };
      action(androidConfig);
      return { ...config, contents: androidConfig.modResults.contents };
    });

    const second = plugin({});
    expect(second.contents?.match(/@generated-by-laoji-feishu-evidence-gate/g)).toHaveLength(1);
    expect(second.contents?.match(/@generated-by-laoji-java-time-desugaring/g)).toHaveLength(1);
  });

  it('adds the evidence lint project idempotently', () => {
    const plugin = require('../plugins/withLaojiNativePlatform.js');
    plugin({});
    const firstContents = mockWithSettingsGradle.mock.results.at(-1)?.value.settingsContents as string;
    mockWithSettingsGradle.mockImplementationOnce((config, action) => {
      const androidConfig = { modResults: { contents: firstContents } };
      action(androidConfig);
      return { ...config, settingsContents: androidConfig.modResults.contents };
    });

    const second = plugin({});
    expect(second.settingsContents?.match(/@generated-by-laoji-feishu-evidence-lint/g)).toHaveLength(1);
  });
});
