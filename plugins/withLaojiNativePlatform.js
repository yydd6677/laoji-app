const {
  withAndroidManifest,
  withAppBuildGradle,
  withMainActivity,
} = require('@expo/config-plugins');
const { mergeContents } = require('@expo/config-plugins/build/utils/generateCode');

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

function findMainActivity(application) {
  return (application.activity || []).find(activity => (
    activity.$?.['android:name'] === '.MainActivity'
    || activity.$?.['android:name'] === 'com.laoji.app.MainActivity'
  ));
}

function ensureMediaIntentFilter(activity, action) {
  activity['intent-filter'] = activity['intent-filter'] || [];
  const exists = activity['intent-filter'].some(filter => (
    (filter.action || []).some(item => item.$?.['android:name'] === action)
    && (filter.data || []).some(item => item.$?.['android:mimeType'] === 'audio/*')
  ));
  if (exists) return;
  activity['intent-filter'].push({
    action: [{ $: { 'android:name': action } }],
    category: [{ $: { 'android:name': 'android.intent.category.DEFAULT' } }],
    data: [{ $: { 'android:mimeType': 'audio/*' } }],
  });
}

function ensureSemanticLinkIntentFilter(activity, host, path) {
  activity['intent-filter'] = activity['intent-filter'] || [];
  const exists = activity['intent-filter'].some(filter => (
    (filter.action || []).some(item => item.$?.['android:name'] === 'android.intent.action.VIEW')
    && (filter.category || []).some(item => item.$?.['android:name'] === 'android.intent.category.BROWSABLE')
    && (filter.data || []).some(item => (
      item.$?.['android:scheme'] === 'laoji'
      && item.$?.['android:host'] === host
      && item.$?.['android:path'] === path
    ))
  ));
  if (exists) return;
  activity['intent-filter'].push({
    action: [{ $: { 'android:name': 'android.intent.action.VIEW' } }],
    category: [
      { $: { 'android:name': 'android.intent.category.DEFAULT' } },
      { $: { 'android:name': 'android.intent.category.BROWSABLE' } },
    ],
    data: [{ $: {
      'android:scheme': 'laoji',
      'android:host': host,
      'android:path': path,
    } }],
  });
}

function withMediaImportMainActivity(config) {
  return withMainActivity(config, androidConfig => {
    if (androidConfig.modResults.language !== 'kt') {
      throw new Error('LaoJi media import requires a Kotlin MainActivity.');
    }
    let contents = androidConfig.modResults.contents;
    contents = mergeContents({
      src: contents,
      newSrc: [
        'import android.content.Intent',
        'import com.laoji.nativeplatform.mediaimport.MediaImportIntentInbox',
      ].join('\n'),
      tag: 'laoji-media-import-imports',
      anchor: /^import android\.os\.Bundle$/m,
      offset: 1,
      comment: '//',
    }).contents;
    contents = mergeContents({
      src: contents,
      newSrc: '    MediaImportIntentInbox.offer(this, intent)',
      tag: 'laoji-media-import-initial-intent',
      anchor: /^\s*super\.onCreate\(null\)$/m,
      offset: 1,
      comment: '//',
    }).contents;
    contents = mergeContents({
      src: contents,
      newSrc: [
        '  override fun onNewIntent(intent: Intent) {',
        '    super.onNewIntent(intent)',
        '    setIntent(intent)',
        '    MediaImportIntentInbox.offer(this, intent)',
        '  }',
        '',
      ].join('\n'),
      tag: 'laoji-media-import-new-intent',
      anchor: /^\s*override fun getMainComponentName/m,
      offset: 0,
      comment: '//',
    }).contents;
    androidConfig.modResults.contents = contents;
    return androidConfig;
  });
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

    const mainActivity = findMainActivity(application);
    if (!mainActivity) {
      throw new Error('LaoJi native platform requires an Android MainActivity manifest node.');
    }
    ensureMediaIntentFilter(mainActivity, 'android.intent.action.SEND');
    ensureMediaIntentFilter(mainActivity, 'android.intent.action.SEND_MULTIPLE');
    ensureMediaIntentFilter(mainActivity, 'android.intent.action.VIEW');
    ensureSemanticLinkIntentFilter(mainActivity, 'meeting', '/new');
    ensureSemanticLinkIntentFilter(mainActivity, 'calendar', '/occurrence');
    ensureSemanticLinkIntentFilter(mainActivity, 'collaboration', '/action');
    return androidConfig;
  });

  const withMainActivityImport = withMediaImportMainActivity(withServices);
  return withAppBuildGradle(withMainActivityImport, androidConfig => {
    const desugarMarker = '// @generated-by-laoji-java-time-desugaring';
    if (!androidConfig.modResults.contents.includes(desugarMarker)) {
      androidConfig.modResults.contents += `

${desugarMarker}
// CAL-EDIT-TIME-001 / CAL-REPEAT-RRULE-001
android {
    compileOptions {
        coreLibraryDesugaringEnabled true
    }
}

dependencies {
    coreLibraryDesugaring 'com.android.tools:desugar_jdk_libs:2.1.5'
}
`;
    }

    return androidConfig;
  });
};

module.exports.RECORDING_SERVICE = RECORDING_SERVICE;
module.exports.PLAYBACK_SERVICE = PLAYBACK_SERVICE;
