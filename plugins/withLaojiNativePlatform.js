const { withAndroidManifest } = require('@expo/config-plugins');

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
  return withAndroidManifest(config, androidConfig => {
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
};

module.exports.RECORDING_SERVICE = RECORDING_SERVICE;
module.exports.PLAYBACK_SERVICE = PLAYBACK_SERVICE;
