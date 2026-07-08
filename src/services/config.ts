declare const process:
  | { env?: Record<string, string | undefined> }
  | undefined;

const INTERNAL_LAOJI_API_BASE = 'http://183.36.243.124:8035';
const INTERNAL_MEETING_API_BASE = 'http://183.36.243.124:8020';
const INTERNAL_REALTIME_ASR_HOST = '183.36.243.124';
const INTERNAL_REALTIME_ASR_PORT = 8020;

export interface ApiConfig {
  laojiApiBase: string;
  meetingApiBase: string;
  realtimeAsrHost: string;
  realtimeAsrPort: number;
  realtimeAsrSecure: boolean;
  isProduction: boolean;
}

function env(name: string): string | undefined {
  try {
    return typeof process !== 'undefined' ? process.env?.[name] : undefined;
  } catch {
    return undefined;
  }
}

function normalizeBaseUrl(value: string): string {
  return value.trim().replace(/\/+$/, '');
}

function envBool(value: string | undefined): boolean {
  return ['1', 'true', 'yes', 'on'].includes((value ?? '').trim().toLowerCase());
}

function envInt(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? '', 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function detectProduction(): boolean {
  return env('APP_ENV') === 'production' || env('EAS_BUILD_PROFILE') === 'production';
}

export function getApiConfig(): ApiConfig {
  const isProduction = detectProduction();
  return {
    laojiApiBase: normalizeBaseUrl(env('EXPO_PUBLIC_LAOJI_API_BASE') || INTERNAL_LAOJI_API_BASE),
    meetingApiBase: normalizeBaseUrl(env('EXPO_PUBLIC_MEETING_API_BASE') || INTERNAL_MEETING_API_BASE),
    realtimeAsrHost: env('EXPO_PUBLIC_REALTIME_ASR_HOST') || INTERNAL_REALTIME_ASR_HOST,
    realtimeAsrPort: envInt(env('EXPO_PUBLIC_REALTIME_ASR_PORT'), INTERNAL_REALTIME_ASR_PORT),
    realtimeAsrSecure: envBool(env('EXPO_PUBLIC_REALTIME_ASR_SECURE')),
    isProduction,
  };
}

export function assertProductionApiConfig(config: ApiConfig = getApiConfig()): void {
  if (!config.isProduction) return;
  const urls = [config.laojiApiBase, config.meetingApiBase];
  const hasBareHttpIp = urls.some(url => /^http:\/\/\d{1,3}(?:\.\d{1,3}){3}(?::\d+)?(?:\/|$)/.test(url));
  const hasPlainHttp = urls.some(url => url.startsWith('http://'));
  if (hasBareHttpIp || hasPlainHttp) {
    throw new Error('Production API endpoints must use HTTPS domain names.');
  }
}
