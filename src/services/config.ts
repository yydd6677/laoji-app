import Constants from 'expo-constants';
import {
  isPlaceholderProductionHost,
  isSecureDeploymentMode,
  isSubmissionDeploymentMode,
} from '../../config/deploymentMode';

declare const process:
  | { env?: Record<string, string | undefined> }
  | undefined;

const DEFAULT_API_BASE = 'https://laoji.cloud';

export type RealtimeAsrProvider = 'qwen';

interface ApiConfigSource {
  appEnv?: string;
  apiBase?: string;
  deviceBootstrapKey?: string;
  privacyPolicyUrl?: string;
  termsOfServiceUrl?: string;
  accountDeletionUrl?: string;
}

export interface ApiConfig {
  appEnv: string;
  apiBase: string;
  deviceBootstrapKey: string;
  realtimeAsrBase: string;
  realtimeAsrProvider: RealtimeAsrProvider;
  reverseGeocoderUrl: string;
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

function realtimeBaseUrl(apiBase: string): string {
  if (!apiBase) return '';
  try {
    const parsed = new URL(apiBase);
    if (parsed.protocol === 'https:') parsed.protocol = 'wss:';
    else if (parsed.protocol === 'http:') parsed.protocol = 'ws:';
    else return '';
    return parsed.toString().replace(/\/+$/, '');
  } catch {
    return '';
  }
}

function runtimeSource(): ApiConfigSource {
  const extra = (Constants.expoConfig?.extra ?? {}) as ApiConfigSource;
  const runtimeEnv = typeof process !== 'undefined' ? process.env : undefined;
  return {
    appEnv: runtimeEnv?.APP_ENV || runtimeEnv?.EAS_BUILD_PROFILE || extra.appEnv,
    apiBase: runtimeEnv?.EXPO_PUBLIC_API_BASE || extra.apiBase,
    deviceBootstrapKey: runtimeEnv?.EXPO_PUBLIC_DEVICE_BOOTSTRAP_KEY || extra.deviceBootstrapKey,
    privacyPolicyUrl: runtimeEnv?.EXPO_PUBLIC_PRIVACY_POLICY_URL || extra.privacyPolicyUrl,
    termsOfServiceUrl: runtimeEnv?.EXPO_PUBLIC_TERMS_OF_SERVICE_URL || extra.termsOfServiceUrl,
    accountDeletionUrl: runtimeEnv?.EXPO_PUBLIC_ACCOUNT_DELETION_URL || extra.accountDeletionUrl,
  };
}

export function getApiConfig(source: ApiConfigSource = runtimeSource()): ApiConfig {
  const appEnv = String(source.appEnv ?? '').trim().toLowerCase();
  const apiBase = normalizeBaseUrl(String(source.apiBase ?? DEFAULT_API_BASE));
  return {
    appEnv,
    apiBase,
    deviceBootstrapKey: String(source.deviceBootstrapKey ?? '').trim(),
    realtimeAsrBase: realtimeBaseUrl(apiBase),
    realtimeAsrProvider: 'qwen',
    reverseGeocoderUrl: apiBase ? `${apiBase}/api/location/reverse` : '',
    privacyPolicyUrl: normalizeBaseUrl(String(source.privacyPolicyUrl ?? (apiBase ? `${apiBase}/privacy` : ''))),
    termsOfServiceUrl: normalizeBaseUrl(String(source.termsOfServiceUrl ?? (apiBase ? `${apiBase}/terms` : ''))),
    accountDeletionUrl: normalizeBaseUrl(String(source.accountDeletionUrl ?? (apiBase ? `${apiBase}/account-deletion` : ''))),
    isProduction: isSecureDeploymentMode(appEnv),
  };
}

export function assertProductionApiConfig(config: ApiConfig = getApiConfig()): void {
  if (!config.apiBase || !config.realtimeAsrBase
      || !config.privacyPolicyUrl || !config.termsOfServiceUrl || !config.accountDeletionUrl) {
    throw new Error('API endpoint configuration is missing. Rebuild LaoJi with EXPO_PUBLIC_API_BASE.');
  }
  if (!config.isProduction) return;

  const urls = [
    config.apiBase,
    config.reverseGeocoderUrl,
    config.privacyPolicyUrl,
    config.termsOfServiceUrl,
    config.accountDeletionUrl,
  ];
  const hasInvalidUrl = urls.some(url => !validServiceUrl(url, true));
  if (hasInvalidUrl || !config.realtimeAsrBase.startsWith('wss://')) {
    throw new Error('Production API endpoints must use HTTPS/WSS domain names.');
  }
  if (isSubmissionDeploymentMode(config.appEnv)) {
    const usesPlaceholderHost = urls.some(url => {
      try {
        return isPlaceholderProductionHost(new URL(url).hostname);
      } catch {
        return true;
      }
    });
    if (usesPlaceholderHost) {
      throw new Error('Production submission endpoints must not use reserved or placeholder domains.');
    }
  }
}
