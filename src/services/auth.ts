import * as SecureStore from 'expo-secure-store';
import { getApiConfig } from './config';
import { readResponseData, stringifyErrorDetail } from './errors';
import { fetchWithTimeout as fetch } from './http';
import { notifyUnauthorized } from './authInvalidation';

export type AuthMode = 'signed_out' | 'authenticated' | 'guest';

export interface AuthUser {
  id: number;
  account: string;
  nickname: string;
  email?: string | null;
  phone?: string | null;
  avatar_url?: string | null;
  created_at: string;
}

export interface AuthSession {
  accessToken: string;
  expiresAt: string;
  user: AuthUser;
}

interface ApiAuthSession {
  access_token: string;
  expires_at: string;
  user: AuthUser;
}

export const AUTH_TOKEN_KEY = 'laoji.auth.accessToken';
export const AUTH_SESSION_KEY = 'laoji.auth.session';

let authStorageTail: Promise<void> = Promise.resolve();

function enqueueAuthStorage<T>(operation: () => Promise<T>): Promise<T> {
  const result = authStorageTail.then(operation, operation);
  authStorageTail = result.then(() => undefined, () => undefined);
  return result;
}

async function waitForAuthStorage(): Promise<void> {
  await authStorageTail;
}

export class AuthRequestError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly retryAfterSeconds?: number,
  ) {
    super(message);
    this.name = 'AuthRequestError';
  }
}

export function isAuthUnauthorizedError(error: unknown): boolean {
  return error instanceof AuthRequestError && error.status === 401;
}

function toSession(data: ApiAuthSession): AuthSession {
  return {
    accessToken: data.access_token,
    expiresAt: data.expires_at,
    user: normalizeAuthUser(data.user),
  };
}

function resolveApiUrl(value: string | null | undefined): string | null {
  if (!value) return null;
  if (/^https?:\/\//i.test(value) || value.startsWith('file://')) return value;
  const base = getApiConfig().laojiApiBase.replace(/\/$/, '');
  return `${base}/${value.replace(/^\//, '')}`;
}

function normalizeAuthUser(user: AuthUser): AuthUser {
  return { ...user, avatar_url: resolveApiUrl(user.avatar_url) };
}

function normalizeRemoteProfile(profile: RemoteProfile): RemoteProfile {
  return { ...profile, avatar_url: resolveApiUrl(profile.avatar_url) };
}

function retryAfterSeconds(res: Response): number | undefined {
  const raw = res.headers?.get?.('Retry-After')?.trim();
  if (!raw || !/^\d+$/.test(raw)) return undefined;
  const seconds = Number(raw);
  return Number.isSafeInteger(seconds) && seconds > 0 ? seconds : undefined;
}

function authErrorMessage(res: Response, detail: string | null, fallback: string): AuthRequestError {
  const retryAfter = retryAfterSeconds(res);
  if (res.status === 429 && retryAfter) {
    const base = (detail || '请求过于频繁').replace(/[，,]?请稍后重试[。.]?$/, '');
    const wait = retryAfter < 60
      ? `${retryAfter} 秒`
      : `约 ${Math.ceil(retryAfter / 60)} 分钟`;
    return new AuthRequestError(`${base}，请在${wait}后重试。`, res.status, retryAfter);
  }
  return new AuthRequestError(detail || `${fallback}（${res.status}）`, res.status, retryAfter);
}

async function parseAuthResponse(res: Response): Promise<ApiAuthSession> {
  const data: any = await readResponseData(res);
  if (!res.ok) {
    const detail = stringifyErrorDetail(data?.detail ?? data?.message ?? data?.error);
    throw authErrorMessage(res, detail, '登录服务返回错误');
  }
  return data;
}

async function parseJsonResponse<T>(
  res: Response,
  fallback: string,
  options: { unauthorizedToken?: string } = {},
): Promise<T> {
  const data: any = await readResponseData(res);
  if (!res.ok) {
    const detail = stringifyErrorDetail(data?.detail ?? data?.message ?? data?.error ?? data);
    if (res.status === 401 && options.unauthorizedToken) {
      notifyUnauthorized(options.unauthorizedToken);
    }
    throw authErrorMessage(res, detail, fallback);
  }
  return data as T;
}

function bearer(accessToken: string): Record<string, string> {
  return { Authorization: `Bearer ${accessToken}` };
}

export interface RemoteProfile {
  nickname?: string | null;
  email?: string | null;
  phone?: string | null;
  avatar_initial?: string | null;
  avatar_colors?: [string, string] | string[] | null;
  avatar_url?: string | null;
}

export async function registerAccount(
  account: string,
  password: string,
  nickname?: string,
): Promise<AuthSession> {
  const res = await fetch(`${getApiConfig().laojiApiBase}/api/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ account, password, nickname }),
  });
  return toSession(await parseAuthResponse(res));
}

export async function loginAccount(account: string, password: string): Promise<AuthSession> {
  const res = await fetch(`${getApiConfig().laojiApiBase}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ account, password }),
  });
  return toSession(await parseAuthResponse(res));
}

export async function refreshAccountSession(accessToken: string): Promise<AuthSession> {
  const res = await fetch(`${getApiConfig().laojiApiBase}/api/auth/refresh`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  return toSession(await parseAuthResponse(res));
}

export async function fetchCurrentUser(accessToken: string): Promise<AuthUser> {
  const res = await fetch(`${getApiConfig().laojiApiBase}/api/auth/me`, {
    headers: bearer(accessToken),
  });
  return normalizeAuthUser(await parseJsonResponse<AuthUser>(res, '恢复登录失败', { unauthorizedToken: accessToken }));
}

export async function logoutAccount(accessToken: string): Promise<void> {
  await fetch(`${getApiConfig().laojiApiBase}/api/auth/logout`, {
    method: 'POST',
    headers: bearer(accessToken),
  });
}

export async function changePassword(
  accessToken: string,
  currentPassword: string,
  newPassword: string,
): Promise<void> {
  const res = await fetch(`${getApiConfig().laojiApiBase}/api/auth/change-password`, {
    method: 'POST',
    headers: { ...bearer(accessToken), 'Content-Type': 'application/json' },
    body: JSON.stringify({ current_password: currentPassword, new_password: newPassword }),
  });
  await parseJsonResponse<unknown>(res, '修改密码失败', { unauthorizedToken: accessToken });
}

export interface AccountDeleteResult {
  deleted: boolean;
  events_deleted: number;
  meetings_deleted: number;
  sessions_deleted: number;
  cleanup_pending: number;
  local_cleanup_failed?: number;
}

export async function deleteAccount(
  accessToken: string,
  currentPassword: string,
  confirmation: string,
): Promise<AccountDeleteResult> {
  const res = await fetch(`${getApiConfig().laojiApiBase}/api/auth/me`, {
    method: 'DELETE',
    headers: { ...bearer(accessToken), 'Content-Type': 'application/json' },
    body: JSON.stringify({ current_password: currentPassword, confirmation }),
  });
  return parseJsonResponse<AccountDeleteResult>(res, '删除账号失败', { unauthorizedToken: accessToken });
}

export async function requestPasswordReset(account: string): Promise<{ request_id?: string; message?: string }> {
  const res = await fetch(`${getApiConfig().laojiApiBase}/api/auth/password-reset-requests`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ account }),
  });
  return parseJsonResponse<{ request_id?: string; message?: string }>(res, '提交重置请求失败');
}

export async function fetchRemoteProfile(accessToken: string): Promise<RemoteProfile> {
  const res = await fetch(`${getApiConfig().laojiApiBase}/api/auth/me/profile`, {
    headers: bearer(accessToken),
  });
  return normalizeRemoteProfile(await parseJsonResponse<RemoteProfile>(res, '获取资料失败', { unauthorizedToken: accessToken }));
}

export async function updateRemoteProfile(
  accessToken: string,
  profile: RemoteProfile,
): Promise<RemoteProfile> {
  const res = await fetch(`${getApiConfig().laojiApiBase}/api/auth/me/profile`, {
    method: 'PATCH',
    headers: { ...bearer(accessToken), 'Content-Type': 'application/json' },
    body: JSON.stringify(profile),
  });
  return normalizeRemoteProfile(await parseJsonResponse<RemoteProfile>(res, '保存资料失败', { unauthorizedToken: accessToken }));
}

function imageNameFromUri(uri: string): string {
  const name = uri.split('?')[0].split('#')[0].split('/').pop();
  return name && name.includes('.') ? decodeURIComponent(name) : 'avatar.jpg';
}

function imageTypeFromName(name: string): string {
  const ext = name.split('.').pop()?.toLowerCase();
  if (ext === 'png') return 'image/png';
  if (ext === 'webp') return 'image/webp';
  return 'image/jpeg';
}

export async function uploadRemoteAvatar(
  accessToken: string,
  uri: string,
  fileName = imageNameFromUri(uri),
  mimeType = imageTypeFromName(fileName),
): Promise<RemoteProfile> {
  const form = new FormData();
  form.append('file', { uri, name: fileName, type: mimeType } as any);
  const res = await fetch(`${getApiConfig().laojiApiBase}/api/auth/me/avatar`, {
    method: 'POST',
    headers: bearer(accessToken),
    body: form,
  });
  return normalizeRemoteProfile(await parseJsonResponse<RemoteProfile>(res, '上传头像失败', { unauthorizedToken: accessToken }));
}

export async function deleteRemoteAvatar(accessToken: string): Promise<RemoteProfile> {
  const res = await fetch(`${getApiConfig().laojiApiBase}/api/auth/me/avatar`, {
    method: 'DELETE',
    headers: bearer(accessToken),
  });
  return normalizeRemoteProfile(await parseJsonResponse<RemoteProfile>(res, '删除头像失败', { unauthorizedToken: accessToken }));
}

export async function loadStoredToken(): Promise<string | null> {
  await waitForAuthStorage();
  return SecureStore.getItemAsync(AUTH_TOKEN_KEY);
}

export async function loadStoredSession(): Promise<AuthSession | null> {
  await waitForAuthStorage();
  const raw = await SecureStore.getItemAsync(AUTH_SESSION_KEY);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<AuthSession>;
    if (!parsed.accessToken || !parsed.user?.id) return null;
    return {
      accessToken: parsed.accessToken,
      expiresAt: parsed.expiresAt ?? '',
      user: normalizeAuthUser(parsed.user as AuthUser),
    };
  } catch {
    return null;
  }
}

export async function saveStoredToken(token: string): Promise<void> {
  await enqueueAuthStorage(() => SecureStore.setItemAsync(AUTH_TOKEN_KEY, token));
}

export async function saveStoredSession(session: AuthSession): Promise<void> {
  await enqueueAuthStorage(() => Promise.all([
    SecureStore.setItemAsync(AUTH_TOKEN_KEY, session.accessToken),
    SecureStore.setItemAsync(AUTH_SESSION_KEY, JSON.stringify(session)),
  ]).then(() => undefined));
}

export async function clearStoredToken(): Promise<void> {
  await enqueueAuthStorage(() => Promise.all([
    SecureStore.deleteItemAsync(AUTH_TOKEN_KEY),
    SecureStore.deleteItemAsync(AUTH_SESSION_KEY),
  ]).then(() => undefined));
}

export async function flushAuthStorageOperations(): Promise<void> {
  await waitForAuthStorage();
}

export function resetAuthStorageQueueForTests(): void {
  authStorageTail = Promise.resolve();
}
