const {
  isPlaceholderProductionHost,
  isSecureDeploymentMode,
  isSubmissionDeploymentMode,
  resolveDeploymentMode,
} = require('./config/deploymentMode');

const base = {
  name: '老记',
  slug: 'laoji-app',
  version: '1.0.0',
  orientation: 'portrait',
  icon: './assets/icon.png',
  userInterfaceStyle: 'light',
  splash: {
    image: './assets/splash-icon.png',
    resizeMode: 'contain',
    backgroundColor: '#FFF5F8',
  },
  ios: {
    supportsTablet: false,
    bundleIdentifier: 'com.laoji.app',
    infoPlist: {
      NSMicrophoneUsageDescription: '老记需要麦克风权限，用于语音输入日程。',
      NSPhotoLibraryUsageDescription: '老记需要访问照片，用于选择账号头像。',
    },
  },
  android: {
    package: 'com.laoji.app',
    versionCode: 35,
    allowBackup: false,
    adaptiveIcon: {
      backgroundColor: '#FFF5F8',
      foregroundImage: './assets/android-icon-foreground.png',
      backgroundImage: './assets/android-icon-background.png',
      monochromeImage: './assets/android-icon-monochrome.png',
    },
    permissions: [
      'RECORD_AUDIO',
      'INTERNET',
      'ACCESS_NETWORK_STATE',
      'POST_NOTIFICATIONS',
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
    './plugins/withAndroidCleartextTraffic',
    './plugins/withAndroidReleaseSigning',
    './plugins/withAndroidReleaseOptimizations',
    ['expo-av', { microphonePermission: '老记需要麦克风权限，用于语音输入日程。' }],
    'expo-font',
    'expo-secure-store',
    ['expo-image-picker', {
      photosPermission: '老记需要访问照片，用于选择账号头像。',
      cameraPermission: false,
    }],
    ['expo-notifications', { color: '#7B5CB8' }],
    ['expo-local-authentication', { faceIDPermission: '老记需要使用系统验证，用于保护你的日程和会议记录。' }],
  ],
};

function boolEnv(value) {
  return ['1', 'true', 'yes', 'on'].includes(String(value || '').toLowerCase());
}

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

function assertRealtimeHost(host, port, secure, deploymentMode) {
  const clean = String(host || '').trim();
  const hostIsDevelopmentIp = /^\d{1,3}(?:\.\d{1,3}){3}$/.test(clean);
  const validHost = clean === 'localhost' || hostIsDevelopmentIp || isDomainName(clean);
  if (!validHost || clean.includes('/') || clean.includes('://')) {
    throw new Error('EXPO_PUBLIC_REALTIME_ASR_HOST must contain only a host name or IP address.');
  }
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('EXPO_PUBLIC_REALTIME_ASR_PORT must be an integer between 1 and 65535.');
  }
  if (isSecureDeploymentMode(deploymentMode)
      && (!secure || hostIsDevelopmentIp || !isDomainName(clean))) {
    throw new Error('EXPO_PUBLIC_REALTIME_ASR_HOST must be a secure domain for production-like builds.');
  }
  if (isSubmissionDeploymentMode(deploymentMode)
      && isPlaceholderProductionHost(clean)) {
    throw new Error('EXPO_PUBLIC_REALTIME_ASR_HOST must not use a reserved or placeholder domain in a production submission.');
  }
}

module.exports = () => {
  const appEnv = resolveDeploymentMode(process.env);
  const laojiApiBase = cleanUrl(process.env.EXPO_PUBLIC_LAOJI_API_BASE);
  const meetingApiBase = cleanUrl(process.env.EXPO_PUBLIC_MEETING_API_BASE);
  const realtimeAsrHost = String(process.env.EXPO_PUBLIC_REALTIME_ASR_HOST || '').trim();
  const realtimeAsrPort = Number(process.env.EXPO_PUBLIC_REALTIME_ASR_PORT || 18020);
  const realtimeAsrSecure = boolEnv(process.env.EXPO_PUBLIC_REALTIME_ASR_SECURE);
  const privacyPolicyUrl = cleanUrl(
    process.env.EXPO_PUBLIC_PRIVACY_POLICY_URL || (laojiApiBase ? `${laojiApiBase}/privacy` : ''),
  );
  const termsOfServiceUrl = cleanUrl(
    process.env.EXPO_PUBLIC_TERMS_OF_SERVICE_URL || (laojiApiBase ? `${laojiApiBase}/terms` : ''),
  );
  const accountDeletionUrl = cleanUrl(
    process.env.EXPO_PUBLIC_ACCOUNT_DELETION_URL || (laojiApiBase ? `${laojiApiBase}/account-deletion` : ''),
  );

  if (!laojiApiBase || !meetingApiBase || !realtimeAsrHost
      || !privacyPolicyUrl || !termsOfServiceUrl || !accountDeletionUrl) {
    throw new Error('LaoJi production configuration is incomplete. Set the API, realtime ASR, privacy policy, and account deletion endpoints.');
  }
  assertServiceUrl('EXPO_PUBLIC_LAOJI_API_BASE', laojiApiBase, appEnv);
  assertServiceUrl('EXPO_PUBLIC_MEETING_API_BASE', meetingApiBase, appEnv);
  assertServiceUrl('EXPO_PUBLIC_PRIVACY_POLICY_URL', privacyPolicyUrl, appEnv);
  assertServiceUrl('EXPO_PUBLIC_TERMS_OF_SERVICE_URL', termsOfServiceUrl, appEnv);
  assertServiceUrl('EXPO_PUBLIC_ACCOUNT_DELETION_URL', accountDeletionUrl, appEnv);
  assertRealtimeHost(realtimeAsrHost, realtimeAsrPort, realtimeAsrSecure, appEnv);

  return {
    ...base,
    extra: {
      ...(base.extra || {}),
      appEnv,
      laojiApiBase,
      meetingApiBase,
      realtimeAsrHost,
      realtimeAsrPort,
      realtimeAsrSecure,
      privacyPolicyUrl,
      termsOfServiceUrl,
      accountDeletionUrl,
    },
  };
};
