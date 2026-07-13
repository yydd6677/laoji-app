import Constants from 'expo-constants';
import {
  isPlaceholderProductionHost,
  isSecureDeploymentMode,
  isSubmissionDeploymentMode,
} from '../../config/deploymentMode';

declare const process:
  | { env?: Record<string, string | undefined> }
  | undefined;

const DEFAULT_REALTIME_ASR_PORT = 18020;

interface ApiConfigSource {
  appEnv?: string;
  laojiApiBase?: string;
  meetingApiBase?: string;
  realtimeAsrHost?: string;
  realtimeAsrPort?: string | number;
  realtimeAsrSecure?: string | boolean;
  privacyPolicyUrl?: string;
  termsOfServiceUrl?: string;
  accountDeletionUrl?: string;
}

export interface ApiConfig {
  appEnv: string;
  laojiApiBase: string;
  meetingApiBase: string;
  realtimeAsrHost: string;
  realtimeAsrPort: number;
  realtimeAsrSecure: boolean;
  privacyPolicyUrl: string;
  termsOfServiceUrl: string;
  accountDeletionUrl: string;
  isProduction: boolean;
}

function normalizeBaseUrl(value: string): string {
  return value.trim().replace(/\/+$/, '');
}

function isIpLiteral(hostname: string): boolean {
  const clean = hostname.replace(/^\[|\]$/g, '');
  return /^\d{1,3}(?:\.\d{1,3}){3}$/.test(clean) || clean.includes(':');
}

function isDomainName(hostname: string): boolean {
  const clean = hostname.toLowerCase().replace(/\.$/, '');
  if (!clean.includes('.') || clean.length > 253) return false;
  return clean.split('.').every(label => (
    label.length > 0
    && label.length <= 63
    && /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label)
  ));
}

function validServiceUrl(value: string, production: boolean): boolean {
  try {
    const parsed = new URL(value);
    if (!['http:', 'https:'].includes(parsed.protocol)
        || parsed.username
        || parsed.password
        || parsed.search
        || parsed.hash) return false;
    if (!production) return true;
    return parsed.protocol === 'https:'
      && !isIpLiteral(parsed.hostname)
      && isDomainName(parsed.hostname);
  } catch {
    return false;
  }
}

function validRealtimeHost(host: string, production: boolean): boolean {
  const clean = host.trim();
  if (!clean || clean.includes('/') || clean.includes('://')) return false;
  if (production) return !isIpLiteral(clean) && isDomainName(clean);
  return clean === 'localhost' || isIpLiteral(clean) || isDomainName(clean);
}

function envBool(value: string | boolean | undefined): boolean {
  if (typeof value === 'boolean') return value;
  return ['1', 'true', 'yes', 'on'].includes((value ?? '').trim().toLowerCase());
}

function envInt(value: string | number | undefined, fallback: number): number {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function runtimeSource(): ApiConfigSource {
  const extra = (Constants.expoConfig?.extra ?? {}) as ApiConfigSource;
  const runtimeEnv = typeof process !== 'undefined' ? process.env : undefined;
  return {
    appEnv: runtimeEnv?.APP_ENV || runtimeEnv?.EAS_BUILD_PROFILE || extra.appEnv,
    laojiApiBase: runtimeEnv?.EXPO_PUBLIC_LAOJI_API_BASE || extra.laojiApiBase,
    meetingApiBase: runtimeEnv?.EXPO_PUBLIC_MEETING_API_BASE || extra.meetingApiBase,
    realtimeAsrHost: runtimeEnv?.EXPO_PUBLIC_REALTIME_ASR_HOST || extra.realtimeAsrHost,
    realtimeAsrPort: runtimeEnv?.EXPO_PUBLIC_REALTIME_ASR_PORT || extra.realtimeAsrPort,
    realtimeAsrSecure: runtimeEnv?.EXPO_PUBLIC_REALTIME_ASR_SECURE ?? extra.realtimeAsrSecure,
    privacyPolicyUrl: runtimeEnv?.EXPO_PUBLIC_PRIVACY_POLICY_URL || extra.privacyPolicyUrl,
    termsOfServiceUrl: runtimeEnv?.EXPO_PUBLIC_TERMS_OF_SERVICE_URL || extra.termsOfServiceUrl,
    accountDeletionUrl: runtimeEnv?.EXPO_PUBLIC_ACCOUNT_DELETION_URL || extra.accountDeletionUrl,
  };
}

export function getApiConfig(source: ApiConfigSource = runtimeSource()): ApiConfig {
  const appEnv = String(source.appEnv ?? '').trim().toLowerCase();
  const laojiApiBase = normalizeBaseUrl(String(source.laojiApiBase ?? ''));
  return {
    appEnv,
    laojiApiBase,
    meetingApiBase: normalizeBaseUrl(String(source.meetingApiBase ?? '')),
    realtimeAsrHost: String(source.realtimeAsrHost ?? '').trim(),
    realtimeAsrPort: envInt(source.realtimeAsrPort, DEFAULT_REALTIME_ASR_PORT),
    realtimeAsrSecure: envBool(source.realtimeAsrSecure),
    privacyPolicyUrl: normalizeBaseUrl(String(source.privacyPolicyUrl ?? (laojiApiBase ? `${laojiApiBase}/privacy` : ''))),
    termsOfServiceUrl: normalizeBaseUrl(String(source.termsOfServiceUrl ?? (laojiApiBase ? `${laojiApiBase}/terms` : ''))),
    accountDeletionUrl: normalizeBaseUrl(String(source.accountDeletionUrl ?? (laojiApiBase ? `${laojiApiBase}/account-deletion` : ''))),
    isProduction: isSecureDeploymentMode(appEnv),
  };
}

export function assertProductionApiConfig(config: ApiConfig = getApiConfig()): void {
  if (!config.laojiApiBase || !config.meetingApiBase || !config.realtimeAsrHost
      || !config.privacyPolicyUrl || !config.termsOfServiceUrl || !config.accountDeletionUrl) {
    throw new Error('API endpoint configuration is missing. Rebuild LaoJi with the required EXPO_PUBLIC_* values.');
  }
  if (!Number.isInteger(config.realtimeAsrPort) || config.realtimeAsrPort < 1 || config.realtimeAsrPort > 65535) {
    throw new Error('Realtime ASR port configuration is invalid.');
  }
  if (!config.isProduction) return;

  const urls = [
    config.laojiApiBase,
    config.meetingApiBase,
    config.privacyPolicyUrl,
    config.termsOfServiceUrl,
    config.accountDeletionUrl,
  ];
  const hasInvalidUrl = urls.some(url => !validServiceUrl(url, true));
  if (hasInvalidUrl || !config.realtimeAsrSecure || !validRealtimeHost(config.realtimeAsrHost, true)) {
    throw new Error('Production API endpoints must use HTTPS/WSS domain names.');
  }
  if (isSubmissionDeploymentMode(config.appEnv)) {
    const usesPlaceholderHost = urls.some(url => {
      try {
        return isPlaceholderProductionHost(new URL(url).hostname);
      } catch {
        return true;
      }
    }) || isPlaceholderProductionHost(config.realtimeAsrHost);
    if (usesPlaceholderHost) {
      throw new Error('Production submission endpoints must not use reserved or placeholder domains.');
    }
  }
}
