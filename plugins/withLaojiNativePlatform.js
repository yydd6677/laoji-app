const {
  withAndroidManifest,
  withAppBuildGradle,
  withAndroidStyles,
  withDangerousMod,
  withMainActivity,
} = require('@expo/config-plugins');
const { mergeContents } = require('@expo/config-plugins/build/utils/generateCode');
const fs = require('fs/promises');
const path = require('path');

const RECORDING_SERVICE = 'com.laoji.nativeplatform.audio.LaojiRecordingService';
const PLAYBACK_SERVICE = 'com.laoji.nativeplatform.media.LaojiMinutesPlaybackService';
const THEME_RECREATE_EXTRA = 'com.laoji.app.extra.THEME_RECREATE';
const THEME_FONT_STYLES = [
  ['LaojiThemeNeutral', '@font/xml_laoji_theme_neutral'],
  ['LaojiThemeVivid', '@font/xml_laoji_theme_vivid'],
  ['LaojiThemePaper', '@font/xml_laoji_theme_paper'],
  ['LaojiThemeMidnight', '@font/xml_laoji_theme_midnight'],
];

function withThemeFontStyles(config) {
  return withAndroidStyles(config, androidConfig => {
    const styles = androidConfig.modResults.resources.style || [];
    androidConfig.modResults.resources.style = styles.filter(style => (
      !THEME_FONT_STYLES.some(([name]) => style.$?.name === name)
    ));
    for (const [name, fontResource] of THEME_FONT_STYLES) {
      androidConfig.modResults.resources.style.push({
        $: { name, parent: 'AppTheme' },
        item: [
          { _: fontResource, $: { name: 'android:fontFamily' } },
          { _: fontResource, $: { name: 'fontFamily' } },
        ],
      });
    }
    return androidConfig;
  });
}

function withThemeFontLicenses(config) {
  return withDangerousMod(config, ['android', async androidConfig => {
    const source = path.join(androidConfig.modRequest.projectRoot, 'assets/fonts/licenses');
    const destination = path.join(
      androidConfig.modRequest.platformProjectRoot,
      'app/src/main/assets/font-licenses',
    );
    await fs.mkdir(destination, { recursive: true });
    await fs.cp(source, destination, { recursive: true, force: true });
    return androidConfig;
  }]);
}

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

function ensureMediaIntentFilter(activity, action, mimeType) {
  activity['intent-filter'] = activity['intent-filter'] || [];
  const exists = activity['intent-filter'].some(filter => (
    (filter.action || []).some(item => item.$?.['android:name'] === action)
    && (filter.data || []).some(item => item.$?.['android:mimeType'] === mimeType)
  ));
  if (exists) return;
  activity['intent-filter'].push({
    action: [{ $: { 'android:name': action } }],
    category: [{ $: { 'android:name': 'android.intent.category.DEFAULT' } }],
    data: [{ $: { 'android:mimeType': mimeType } }],
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
    const splashRegistration = '    SplashScreenManager.registerOnActivity(this)';
    if (!contents.includes('val isThemeRecreation = intent?.getBooleanExtra(')) {
      if (!contents.includes(splashRegistration)) {
        throw new Error('LaoJi theme recreation requires the Expo splash registration hook.');
      }
      contents = contents.replace(
        splashRegistration,
        [
          `    val isThemeRecreation = intent?.getBooleanExtra("${THEME_RECREATE_EXTRA}", false) == true`,
          '    if (isThemeRecreation) {',
          `      intent?.removeExtra("${THEME_RECREATE_EXTRA}")`,
          '      // The selected theme was applied before splash registration.',
          '    } else {',
          '      SplashScreenManager.registerOnActivity(this)',
          '    }',
        ].join('\n'),
      );
    }
    contents = mergeContents({
      src: contents,
      newSrc: [
        'import android.content.Intent',
        'import androidx.core.view.WindowCompat',
        'import com.laoji.nativeplatform.mediaimport.MediaImportIntentInbox',
        'import com.laoji.nativeplatform.ui.LaojiSystemBars',
        'import com.laoji.nativeplatform.ui.LaojiThemeTypography',
      ].join('\n'),
      tag: 'laoji-media-import-imports',
      anchor: /^import android\.os\.Bundle$/m,
      offset: 1,
      comment: '//',
    }).contents;
    contents = mergeContents({
      src: contents,
      newSrc: '    LaojiThemeTypography.applyActivityTheme(this)',
      tag: 'laoji-themed-font-activity',
      anchor: /^\s*override fun onCreate\(savedInstanceState: Bundle\?\) \{$/m,
      offset: 1,
      comment: '//',
    }).contents;
    contents = mergeContents({
      src: contents,
      newSrc: '    LaojiSystemBars.apply(this)',
      tag: 'laoji-themed-system-bars',
      anchor: /^\s*super\.onCreate\(null\)$/m,
      offset: 1,
      comment: '//',
    }).contents;
    contents = mergeContents({
      src: contents,
      newSrc: [
        '    // Theme changes may recreate this Activity. Keep the window geometry',
        '    // identical to a cold start so native surfaces own system-bar insets once.',
        '    WindowCompat.setDecorFitsSystemWindows(window, false)',
      ].join('\n'),
      tag: 'laoji-edge-to-edge-layout',
      anchor: /^\s*super\.onCreate\(null\)$/m,
      offset: 0,
      comment: '//',
    }).contents;
    contents = mergeContents({
      src: contents,
      newSrc: [
        '  override fun onResume() {',
        '    super.onResume()',
        '    LaojiSystemBars.apply(this)',
        '  }',
        '',
      ].join('\n'),
      tag: 'laoji-themed-system-bars-resume',
      anchor: /^\s*override fun getMainComponentName/m,
      offset: 0,
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
    const manifest = androidConfig.modResults.manifest;
    manifest['uses-permission'] = manifest['uses-permission'] || [];
    const nearbyWifi = manifest['uses-permission'].find(item => (
      item.$?.['android:name'] === 'android.permission.NEARBY_WIFI_DEVICES'
    ));
    if (nearbyWifi) {
      nearbyWifi.$['android:usesPermissionFlags'] = 'neverForLocation';
    }
    manifest['uses-feature'] = manifest['uses-feature'] || [];
    const usbHostFeature = manifest['uses-feature'].find(item => (
      item.$?.['android:name'] === 'android.hardware.usb.host'
    ));
    if (usbHostFeature) {
      usbHostFeature.$['android:required'] = 'false';
    } else {
      manifest['uses-feature'].push({
        $: {
          'android:name': 'android.hardware.usb.host',
          'android:required': 'false',
        },
      });
    }
    const bluetoothLeFeature = manifest['uses-feature'].find(item => (
      item.$?.['android:name'] === 'android.hardware.bluetooth_le'
    ));
    if (bluetoothLeFeature) {
      bluetoothLeFeature.$['android:required'] = 'false';
    } else {
      manifest['uses-feature'].push({
        $: {
          'android:name': 'android.hardware.bluetooth_le',
          'android:required': 'false',
        },
      });
    }
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
    for (const action of [
      'android.intent.action.SEND',
      'android.intent.action.SEND_MULTIPLE',
      'android.intent.action.VIEW',
    ]) {
      ensureMediaIntentFilter(mainActivity, action, 'audio/*');
      ensureMediaIntentFilter(mainActivity, action, 'video/*');
    }
    ensureSemanticLinkIntentFilter(mainActivity, 'meeting', '/new');
    ensureSemanticLinkIntentFilter(mainActivity, 'calendar', '/occurrence');
    ensureSemanticLinkIntentFilter(mainActivity, 'collaboration', '/action');
    ensureSemanticLinkIntentFilter(mainActivity, 'share', '/meeting');
    return androidConfig;
  });

  const withMainActivityImport = withMediaImportMainActivity(withServices);
  const withThemeStyles = withThemeFontStyles(withMainActivityImport);
  const withFontLicenses = withThemeFontLicenses(withThemeStyles);
  return withAppBuildGradle(withFontLicenses, androidConfig => {
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
