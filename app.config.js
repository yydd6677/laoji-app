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
  version: '1.2.10',
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
    enforceContrast: false,
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
      NSMicrophoneUsageDescription: '老记需要麦克风权限，用于语音输入和会议录音。',
      NSLocationWhenInUseUsageDescription: '老记需要位置权限，用于添加日程或会议地点。',
      NSPhotoLibraryUsageDescription: '老记需要访问照片，用于添加会议附件。',
    },
  },
  android: {
    package: 'com.laoji.app',
    versionCode: 218,
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
      'BLUETOOTH',
      'BLUETOOTH_ADMIN',
      'BLUETOOTH_SCAN',
      'BLUETOOTH_CONNECT',
      'CHANGE_NETWORK_STATE',
      'ACCESS_WIFI_STATE',
      'CHANGE_WIFI_STATE',
      'NEARBY_WIFI_DEVICES',
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
      locationWhenInUsePermission: '老记需要位置权限，用于添加日程或会议地点。',
    }],
    './plugins/withAndroidCleartextTraffic',
    './plugins/withAndroidReleaseSigning',
    './plugins/withAndroidReleaseOptimizations',
    './plugins/withLaojiNativePlatform',
    ['expo-audio', {
      microphonePermission: '老记需要麦克风权限，用于语音输入和会议录音。',
      recordAudioAndroid: true,
    }],
    'expo-asset',
    ['expo-font', {
      android: {
        fonts: [
          {
            fontFamily: 'LaojiThemeNeutral',
            fontDefinitions: [{ path: './assets/fonts/theme/laoji_theme_neutral.ttf', weight: 400 }],
          },
          {
            fontFamily: 'LaojiThemeVivid',
            fontDefinitions: [{ path: './assets/fonts/theme/laoji_theme_vivid.ttf', weight: 400 }],
          },
          {
            fontFamily: 'LaojiThemePaper',
            fontDefinitions: [{ path: './assets/fonts/theme/laoji_theme_paper.ttf', weight: 400 }],
          },
          {
            fontFamily: 'LaojiThemeMidnight',
            fontDefinitions: [{ path: './assets/fonts/theme/laoji_theme_midnight.ttf', weight: 400 }],
          },
        ],
      },
      ios: {
        fonts: [
          './assets/fonts/theme/laoji_theme_neutral.ttf',
          './assets/fonts/theme/laoji_theme_vivid.ttf',
          './assets/fonts/theme/laoji_theme_paper.ttf',
          './assets/fonts/theme/laoji_theme_midnight.ttf',
        ],
      },
    }],
    'expo-localization',
    'expo-secure-store',
    'expo-sqlite',
    './plugins/withAndroidAppVersion',
    ['expo-image-picker', {
      photosPermission: '老记需要访问照片，用于添加会议附件。',
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
  // Legacy device-v1 registration uses a shared admission token.  Because an
  // EXPO_PUBLIC value is embedded in the release bundle, it is extractable
  // from the APK and must not be treated as a server secret, device identity,
  // or authorization boundary. Keep it out of source control for operational
  // rotation; device-v2 challenge authentication is the durable replacement.
  const deviceBootstrapKey = String(
    process.env.EXPO_PUBLIC_DEVICE_BOOTSTRAP_KEY || '',
  ).trim();
  // A preview/production APK must still admit a fresh v1 installation while
  // current v1 callers remain.
  // Keep local development flexible, but fail before bundling rather than
  // producing an apparently valid APK that can never complete device setup.
  if (appEnv !== 'development' && deviceBootstrapKey.length < 32) {
    throw new Error(
      'EXPO_PUBLIC_DEVICE_BOOTSTRAP_KEY must contain at least 32 characters for non-development builds.',
    );
  }
  const privacyPolicyUrl = cleanUrl(
    process.env.EXPO_PUBLIC_PRIVACY_POLICY_URL || (apiBase ? `${apiBase}/privacy` : ''),
  );
  const termsOfServiceUrl = cleanUrl(
    process.env.EXPO_PUBLIC_TERMS_OF_SERVICE_URL || (apiBase ? `${apiBase}/terms` : ''),
  );
  const reverseGeocoderUrl = apiBase ? `${apiBase}/api/location/reverse` : '';

  if (!apiBase
      || !privacyPolicyUrl || !termsOfServiceUrl) {
    throw new Error('LaoJi production configuration is incomplete. Set EXPO_PUBLIC_API_BASE and legal document endpoints.');
  }
  assertServiceUrl('EXPO_PUBLIC_API_BASE', apiBase, appEnv);
  assertServiceUrl('reverseGeocoderUrl', reverseGeocoderUrl, appEnv);
  assertServiceUrl('EXPO_PUBLIC_PRIVACY_POLICY_URL', privacyPolicyUrl, appEnv);
  assertServiceUrl('EXPO_PUBLIC_TERMS_OF_SERVICE_URL', termsOfServiceUrl, appEnv);

  // A development APK may target the isolated loopback/tunnel endpoint over
  // HTTP, but only when the build explicitly opts into Android cleartext
  // traffic.  Without this guard Expo can produce a successful Release APK
  // whose manifest silently blocks every request before the app reaches the
  // configured service.
  if (!isSecureDeploymentMode(appEnv)) {
    const apiProtocol = new URL(apiBase).protocol;
    if (apiProtocol === 'http:' && process.env.EXPO_ALLOW_CLEARTEXT !== 'true') {
      throw new Error(
        'HTTP development endpoints require EXPO_ALLOW_CLEARTEXT=true so Android cleartext policy is explicit.',
      );
    }
  }

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
    },
  };
};
