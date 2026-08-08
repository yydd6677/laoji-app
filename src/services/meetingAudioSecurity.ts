import { ApiConfig, getApiConfig } from './config';

export type MeetingAudioUrlErrorCode =
  | 'INVALID_URL'
  | 'INSECURE_URL'
  | 'AUTH_ORIGIN_MISMATCH'
  | 'EXPIRED';

export class MeetingAudioUrlError extends Error {
  constructor(public readonly code: MeetingAudioUrlErrorCode, message: string) {
    super(message);
    this.name = 'MeetingAudioUrlError';
  }
}

interface MeetingAudioUrlOptions {
  requiresAuth?: boolean;
  expiresAt?: string | null;
  nowMs?: number;
}

export function validateMeetingAudioUrl(
  rawUrl: string,
  options: MeetingAudioUrlOptions = {},
  config: ApiConfig = getApiConfig(),
): string {
  let parsed: URL;
  let meetingOrigin: string;
  try {
    const base = new URL(config.apiBase);
    parsed = new URL(rawUrl, base);
    meetingOrigin = base.origin;
  } catch {
    throw new MeetingAudioUrlError('INVALID_URL', 'meeting audio URL is invalid');
  }

  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new MeetingAudioUrlError('INVALID_URL', 'meeting audio URL protocol is unsupported');
  }
  if (parsed.username || parsed.password) {
    throw new MeetingAudioUrlError('INVALID_URL', 'meeting audio URL must not embed credentials');
  }
  if (config.isProduction && parsed.protocol !== 'https:') {
    throw new MeetingAudioUrlError('INSECURE_URL', 'production meeting audio must use HTTPS');
  }
  if (options.requiresAuth && parsed.origin !== meetingOrigin) {
    throw new MeetingAudioUrlError('AUTH_ORIGIN_MISMATCH', 'refusing to send credentials to an external audio origin');
  }
  if (options.expiresAt) {
    const expiresAtMs = Date.parse(options.expiresAt);
    if (!Number.isFinite(expiresAtMs)) {
      throw new MeetingAudioUrlError('INVALID_URL', 'meeting audio expiry is invalid');
    }
    if (expiresAtMs <= (options.nowMs ?? Date.now())) {
      throw new MeetingAudioUrlError('EXPIRED', 'meeting audio URL has expired');
    }
  }
  return parsed.toString();
}

export function meetingAudioUrlErrorMessage(error: unknown): string | null {
  if (!(error instanceof MeetingAudioUrlError)) return null;
  if (error.code === 'EXPIRED') return '录音链接已过期，请刷新会议后重试。';
  if (error.code === 'AUTH_ORIGIN_MISMATCH') return '录音地址未通过安全校验，已停止发送登录凭据。';
  if (error.code === 'INSECURE_URL') return '录音地址未使用安全连接，已停止加载。';
  return '录音地址无效，无法加载。';
}
