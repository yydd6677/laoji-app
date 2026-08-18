const {
  isPlaceholderProductionHost,
  isSecureDeploymentMode,
  isSubmissionDeploymentMode,
  resolveDeploymentMode,
} = require('./config/deploymentMode');

const DEFAULT_API_BASE = 'https://laoji.cloud';

const base = {
  name: '老记',
  slug: 'laoji-app',
  scheme: 'laoji',
  version: '1.1.10',
  orientation: 'portrait',
  icon: './assets/icon.png',
  userInterfaceStyle: 'light',
  androidStatusBar: {
    backgroundColor: '#FFFFFF',
    barStyle: 'dark-content',
  },
  androidNavigationBar: {
    backgroundColor: '#FFFFFF',
    barStyle: 'dark-content',
  },
  splash: {
    image: './assets/splash-icon.png',
    resizeMode: 'contain',
    backgroundColor: '#FFFFFF',
  },
  ios: {
    supportsTablet: false,
    bundleIdentifier: 'com.laoji.app',
    infoPlist: {
      NSMicrophoneUsageDescription: '老记需要麦克风权限，用于语音输入日程。',
      NSLocationWhenInUseUsageDescription: '老记需要位置权限，用于把当前位置添加到日程。',
      NSPhotoLibraryUsageDescription: '老记需要访问照片，用于选择账号头像。',
    },
  },
  android: {
    package: 'com.laoji.app',
    versionCode: 118,
    allowBackup: false,
    adaptiveIcon: {
      backgroundColor: '#FFFFFF',
      foregroundImage: './assets/android-icon-foreground.png',
      backgroundImage: './assets/android-icon-background.png',
      monochromeImage: './assets/android-icon-monochrome.png',
    },
    permissions: [
      'RECORD_AUDIO',
      'INTERNET',
      'ACCESS_NETWORK_STATE',
      'ACCESS_COARSE_LOCATION',
      'ACCESS_FINE_LOCATION',
      'POST_NOTIFICATIONS',
      'FOREGROUND_SERVICE',
      'FOREGROUND_SERVICE_MICROPHONE',
      'FOREGROUND_SERVICE_MEDIA_PLAYBACK',
    ],
    blockedPermissions: [
      'android.permission.READ_MEDIA_IMAGES',
      'android.permission.READ_EXTERNAL_STORAGE',
      'android.permission.WRITE_EXTERNAL_STORAGE',
      'android.permission.CAMERA',
      'android.permission.SYSTEM_ALERT_WINDOW',
      'com.google.android.c2dm.permission.RECEIVE',
    ],
    predictiveBackGestureEnabled: false,
  },
  web: { favicon: './assets/favicon.png' },
  plugins: [
    '@react-native-community/datetimepicker',
    ['expo-location', {
      locationWhenInUsePermission: '老记需要位置权限，用于把当前位置添加到日程。',
    }],
    './plugins/withAndroidCleartextTraffic',
    './plugins/withAndroidReleaseSigning',
    './plugins/withAndroidReleaseOptimizations',
    './plugins/withLaojiNativePlatform',
    ['expo-audio', {
      microphonePermission: '老记需要麦克风权限，用于语音输入日程。',
      recordAudioAndroid: true,
    }],
    'expo-asset',
    'expo-font',
    'expo-localization',
    'expo-secure-store',
    'expo-sqlite',
    './plugins/withAndroidAppVersion',
    ['expo-image-picker', {
      photosPermission: '老记需要访问照片，用于选择账号头像。',
      cameraPermission: false,
    }],
    ['expo-notifications', { color: '#1456F0' }],
    ['expo-splash-screen', {
      backgroundColor: '#FFFFFF',
      image: './assets/splash-icon.png',
      imageWidth: 288,
      resizeMode: 'contain',
    }],
    ['expo-local-authentication', { faceIDPermission: '老记需要使用系统验证，用于保护你的日程和会议记录。' }],
  ],
};

function cleanUrl(value) {
  return String(value || '').trim().replace(/\/+$/, '');
}

function isIpLiteral(hostname) {
  const clean = String(hostname || '').replace(/^\[|\]$/g, '');
  return /^\d{1,3}(?:\.\d{1,3}){3}$/.test(clean) || clean.includes(':');
}

function isDomainName(hostname) {
  const clean = String(hostname || '').toLowerCase().replace(/\.$/, '');
  if (!clean.includes('.') || clean.length > 253) return false;
  return clean.split('.').every(label => (
    label.length > 0
    && label.length <= 63
    && /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label)
  ));
}

function assertServiceUrl(name, value, deploymentMode) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`${name} must be a valid HTTP(S) URL.`);
  }
  if (!['http:', 'https:'].includes(parsed.protocol)
      || parsed.username
      || parsed.password
      || parsed.search
      || parsed.hash) {
    throw new Error(`${name} must be a valid HTTP(S) service URL without credentials, query, or fragment.`);
  }
  if (isSecureDeploymentMode(deploymentMode) && (
    parsed.protocol !== 'https:'
    || isIpLiteral(parsed.hostname)
    || !isDomainName(parsed.hostname)
  )) {
    throw new Error(`${name} must be an HTTPS domain for production-like builds.`);
  }
  if (isSubmissionDeploymentMode(deploymentMode)
      && isPlaceholderProductionHost(parsed.hostname)) {
    throw new Error(`${name} must not use a reserved or placeholder domain in a production submission.`);
  }
}

module.exports = () => {
  const appEnv = resolveDeploymentMode(process.env);
  const apiBase = cleanUrl(process.env.EXPO_PUBLIC_API_BASE || DEFAULT_API_BASE);
  // Device-primary registration is a one-time bootstrap handshake.  Keep the
  // key outside source control and inject it through the build environment;
  // the runtime reads the value from Expo extra rather than relying on a
  // Node-only process.env object that is absent in a release APK.
  const deviceBootstrapKey = String(
    process.env.EXPO_PUBLIC_DEVICE_BOOTSTRAP_KEY || '',
  ).trim();
  // A preview/production APK must be able to register a fresh installation.
  // Keep local development flexible, but fail before bundling rather than
  // producing an apparently valid APK that can never complete device setup.
  if (appEnv !== 'development' && deviceBootstrapKey.length < 32) {
    throw new Error(
      'EXPO_PUBLIC_DEVICE_BOOTSTRAP_KEY must contain at least 32 characters for non-development builds.',
    );
  }
  const localMeetingDbV1 = !['0', 'false', 'no', 'off'].includes(
    String(process.env.EXPO_PUBLIC_LOCAL_MEETING_DB_V1 ?? 'true').trim().toLowerCase(),
  );
  const localMeetingDbCanonicalReadV1 = localMeetingDbV1 && ['1', 'true', 'yes', 'on'].includes(
    String(process.env.EXPO_PUBLIC_LOCAL_MEETING_DB_CANONICAL_READ_V1 ?? 'true').trim().toLowerCase(),
  );
  const localMeetingDbCanonicalWriteV1 = localMeetingDbCanonicalReadV1
    && ['1', 'true', 'yes', 'on'].includes(
      String(process.env.EXPO_PUBLIC_LOCAL_MEETING_DB_CANONICAL_WRITE_V1 ?? 'true').trim().toLowerCase(),
    );
  const localMeetingDbLegacyProjectionWriteV1 = localMeetingDbCanonicalReadV1
    ? ['1', 'true', 'yes', 'on'].includes(
      String(process.env.EXPO_PUBLIC_LOCAL_MEETING_DB_LEGACY_PROJECTION_WRITE_V1 ?? 'false').trim().toLowerCase(),
    )
    : ['1', 'true', 'yes', 'on'].includes(
      String(process.env.EXPO_PUBLIC_LOCAL_MEETING_DB_LEGACY_PROJECTION_WRITE_V1 ?? 'true').trim().toLowerCase(),
    );
  const localMeetingDbAccountRootWriteV1 = localMeetingDbCanonicalWriteV1
    && ['1', 'true', 'yes', 'on'].includes(
      String(process.env.EXPO_PUBLIC_LOCAL_MEETING_DB_ACCOUNT_ROOT_WRITE_V1 ?? 'true').trim().toLowerCase(),
    );
  const localMeetingDbAccountUploadWriteV1 = localMeetingDbCanonicalWriteV1
    && ['1', 'true', 'yes', 'on'].includes(
      String(process.env.EXPO_PUBLIC_LOCAL_MEETING_DB_ACCOUNT_UPLOAD_WRITE_V1 ?? 'true').trim().toLowerCase(),
    );
  const meetingQuestionsV1 = localMeetingDbCanonicalReadV1 && !['0', 'false', 'no', 'off'].includes(
    String(process.env.EXPO_PUBLIC_MEETING_QUESTIONS_V1 ?? 'true').trim().toLowerCase(),
  );
  const meetingAutomaticTopicsV1 = localMeetingDbCanonicalReadV1
    && !['0', 'false', 'no', 'off'].includes(
      String(process.env.EXPO_PUBLIC_MEETING_AUTOMATIC_TOPICS_V1 ?? 'true').trim().toLowerCase(),
    );
  const meetingTagSyncV1 = localMeetingDbCanonicalWriteV1
    && !['0', 'false', 'no', 'off'].includes(
      String(process.env.EXPO_PUBLIC_MEETING_TAG_SYNC_V1 ?? 'true').trim().toLowerCase(),
    );
  const meetingAttachmentSyncV1 = localMeetingDbCanonicalWriteV1
    && !['0', 'false', 'no', 'off'].includes(
      String(process.env.EXPO_PUBLIC_MEETING_ATTACHMENT_SYNC_V1 ?? 'true').trim().toLowerCase(),
    );
  const meetingMarkerSyncV1 = localMeetingDbCanonicalWriteV1
    && !['0', 'false', 'no', 'off'].includes(
      String(process.env.EXPO_PUBLIC_MEETING_MARKER_SYNC_V1 ?? 'true').trim().toLowerCase(),
    );
  const meetingSummarySyncV1 = localMeetingDbCanonicalWriteV1
    && !['0', 'false', 'no', 'off'].includes(
      String(process.env.EXPO_PUBLIC_MEETING_SUMMARY_SYNC_V1 ?? 'true').trim().toLowerCase(),
    );
  const meetingContentShareLinksV1 = localMeetingDbCanonicalWriteV1
    && !['0', 'false', 'no', 'off'].includes(
      String(process.env.EXPO_PUBLIC_MEETING_CONTENT_SHARE_LINKS_V1 ?? 'true').trim().toLowerCase(),
    );
  const meetingCrossMeetingSearchV1 = localMeetingDbCanonicalReadV1
    && ['1', 'true', 'yes', 'on'].includes(
      String(process.env.EXPO_PUBLIC_MEETING_CROSS_MEETING_SEARCH_V1 ?? 'false').trim().toLowerCase(),
    );
  const meetingMediaImportExistingV1 = localMeetingDbCanonicalReadV1
    && !['0', 'false', 'no', 'off'].includes(
      String(process.env.EXPO_PUBLIC_MEETING_MEDIA_IMPORT_EXISTING_V1 ?? 'true').trim().toLowerCase(),
    );
  const meetingMediaClipsV1 = localMeetingDbCanonicalReadV1 && !['0', 'false', 'no', 'off'].includes(
    String(process.env.EXPO_PUBLIC_MEETING_MEDIA_CLIPS_V1 ?? 'true').trim().toLowerCase(),
  );
  const meetingTranscriptReprocessV1 = localMeetingDbCanonicalReadV1
    && !['0', 'false', 'no', 'off'].includes(
      String(process.env.EXPO_PUBLIC_MEETING_TRANSCRIPT_REPROCESS_V1 ?? 'true').trim().toLowerCase(),
    );
  const meetingActionCollaborationV1 = localMeetingDbCanonicalReadV1
    && !['0', 'false', 'no', 'off'].includes(
      String(process.env.EXPO_PUBLIC_MEETING_ACTION_COLLABORATION_V1 ?? 'true').trim().toLowerCase(),
    );
  const scheduleGraphV2Candidate = ['1', 'true', 'yes', 'on'].includes(
    String(process.env.EXPO_PUBLIC_SCHEDULE_GRAPH_V2_CANDIDATE ?? 'false').trim().toLowerCase(),
  );
  const realtimeAsrV2Candidate = ['1', 'true', 'yes', 'on'].includes(
    String(process.env.EXPO_PUBLIC_REALTIME_ASR_V2_CANDIDATE ?? 'false').trim().toLowerCase(),
  );
  const meetingQuestionsQ2Candidate = ['1', 'true', 'yes', 'on'].includes(
    String(process.env.EXPO_PUBLIC_MEETING_QUESTIONS_Q2_CANDIDATE ?? 'false').trim().toLowerCase(),
  );
  const meetingSummarySourceStreamCandidate = ['1', 'true', 'yes', 'on'].includes(
    String(process.env.EXPO_PUBLIC_MEETING_SUMMARY_SOURCE_STREAM_CANDIDATE ?? 'false').trim().toLowerCase(),
  );
  const nativeProjectionEnvelopeCandidate = ['1', 'true', 'yes', 'on'].includes(
    String(process.env.EXPO_PUBLIC_NATIVE_PROJECTION_ENVELOPE_CANDIDATE ?? 'false').trim().toLowerCase(),
  );
  const privacyPolicyUrl = cleanUrl(
    process.env.EXPO_PUBLIC_PRIVACY_POLICY_URL || (apiBase ? `${apiBase}/privacy` : ''),
  );
  const termsOfServiceUrl = cleanUrl(
    process.env.EXPO_PUBLIC_TERMS_OF_SERVICE_URL || (apiBase ? `${apiBase}/terms` : ''),
  );
  const accountDeletionUrl = cleanUrl(
    process.env.EXPO_PUBLIC_ACCOUNT_DELETION_URL || (apiBase ? `${apiBase}/account-deletion` : ''),
  );
  const reverseGeocoderUrl = apiBase ? `${apiBase}/api/location/reverse` : '';

  if (!apiBase
      || !privacyPolicyUrl || !termsOfServiceUrl || !accountDeletionUrl) {
    throw new Error('LaoJi production configuration is incomplete. Set EXPO_PUBLIC_API_BASE and legal document endpoints.');
  }
  assertServiceUrl('EXPO_PUBLIC_API_BASE', apiBase, appEnv);
  assertServiceUrl('reverseGeocoderUrl', reverseGeocoderUrl, appEnv);
  assertServiceUrl('EXPO_PUBLIC_PRIVACY_POLICY_URL', privacyPolicyUrl, appEnv);
  assertServiceUrl('EXPO_PUBLIC_TERMS_OF_SERVICE_URL', termsOfServiceUrl, appEnv);
  assertServiceUrl('EXPO_PUBLIC_ACCOUNT_DELETION_URL', accountDeletionUrl, appEnv);

  return {
    ...base,
    extra: {
      ...(base.extra || {}),
      appEnv,
      apiBase,
      deviceBootstrapKey,
      realtimeAsrProvider: 'qwen',
      reverseGeocoderUrl,
      privacyPolicyUrl,
      termsOfServiceUrl,
      accountDeletionUrl,
      featureFlags: {
        localMeetingDbV1,
        localMeetingDbCanonicalReadV1,
        localMeetingDbCanonicalWriteV1,
        localMeetingDbLegacyProjectionWriteV1,
        localMeetingDbAccountRootWriteV1,
        localMeetingDbAccountUploadWriteV1,
        scheduleGraphV2Candidate,
        realtimeAsrV2Candidate,
        meetingQuestionsQ2Candidate,
        meetingSummarySourceStreamCandidate,
        nativeProjectionEnvelopeCandidate,
        meetingQuestionsV1,
        meetingAutomaticTopicsV1,
        meetingTagSyncV1,
        meetingAttachmentSyncV1,
        meetingMarkerSyncV1,
        meetingSummarySyncV1,
        meetingContentShareLinksV1,
        meetingCrossMeetingSearchV1,
        meetingMediaImportExistingV1,
        meetingMediaClipsV1,
        meetingTranscriptReprocessV1,
        meetingActionCollaborationV1,
      },
    },
  };
};
