const base = require('./app.json').expo;

const INTERNAL_LAOJI_API_BASE = 'http://183.36.243.124:8035';
const INTERNAL_MEETING_API_BASE = 'http://183.36.243.124:8020';
const INTERNAL_REALTIME_ASR_HOST = '183.36.243.124';

function boolEnv(value) {
  return ['1', 'true', 'yes', 'on'].includes(String(value || '').toLowerCase());
}

function cleanUrl(value) {
  return String(value || '').trim().replace(/\/+$/, '');
}

function isProduction() {
  return process.env.APP_ENV === 'production' || process.env.EAS_BUILD_PROFILE === 'production';
}

function assertProductionUrl(name, url) {
  if (!isProduction()) return;
  if (!url || url.startsWith('http://') || /^https?:\/\/\d{1,3}(?:\.\d{1,3}){3}(?::\d+)?(?:\/|$)/.test(url)) {
    throw new Error(`${name} must be an HTTPS domain for production builds.`);
  }
}

module.exports = () => {
  const laojiApiBase = cleanUrl(process.env.EXPO_PUBLIC_LAOJI_API_BASE || INTERNAL_LAOJI_API_BASE);
  const meetingApiBase = cleanUrl(process.env.EXPO_PUBLIC_MEETING_API_BASE || INTERNAL_MEETING_API_BASE);
  const realtimeAsrHost = process.env.EXPO_PUBLIC_REALTIME_ASR_HOST || INTERNAL_REALTIME_ASR_HOST;
  const realtimeAsrPort = Number(process.env.EXPO_PUBLIC_REALTIME_ASR_PORT || 8020);
  const realtimeAsrSecure = boolEnv(process.env.EXPO_PUBLIC_REALTIME_ASR_SECURE);

  assertProductionUrl('EXPO_PUBLIC_LAOJI_API_BASE', laojiApiBase);
  assertProductionUrl('EXPO_PUBLIC_MEETING_API_BASE', meetingApiBase);

  return {
    expo: {
      ...base,
      extra: {
        ...base.extra,
        laojiApiBase,
        meetingApiBase,
        realtimeAsrHost,
        realtimeAsrPort,
        realtimeAsrSecure,
      },
    },
  };
};
