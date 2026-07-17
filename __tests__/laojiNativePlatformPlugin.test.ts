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

jest.mock('@expo/config-plugins', () => ({
  withAndroidManifest: mockWithAndroidManifest,
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
});
