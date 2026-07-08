import * as SecureStore from 'expo-secure-store';
import { getApiConfig } from './config';
import { stringifyErrorDetail } from './errors';

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

function toSession(data: ApiAuthSession): AuthSession {
  return {
    accessToken: data.access_token,
    expiresAt: data.expires_at,
    user: data.user,
  };
}

async function parseAuthResponse(res: Response): Promise<ApiAuthSession> {
  let data: any = null;
  try {
    data = await res.json();
  } catch {
    data = null;
  }
  if (!res.ok) {
    const detail = stringifyErrorDetail(data?.detail ?? data?.message ?? data?.error);
    throw new Error(detail || `登录服务返回错误（${res.status}）`);
  }
  return data;
}

async function parseJsonResponse<T>(res: Response, fallback: string): Promise<T> {
  let data: any = null;
  try {
    data = await res.json();
  } catch {
    data = null;
  }
  if (!res.ok) {
    const detail = stringifyErrorDetail(data?.detail ?? data?.message ?? data?.error ?? data);
    throw new Error(detail || `${fallback}（${res.status}）`);
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
  if (!res.ok) throw new Error(`fetch current user failed: ${res.status}`);
  return res.json();
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
  await parseJsonResponse<unknown>(res, '修改密码失败');
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
  return parseJsonResponse<RemoteProfile>(res, '获取资料失败');
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
  return parseJsonResponse<RemoteProfile>(res, '保存资料失败');
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
  return parseJsonResponse<RemoteProfile>(res, '上传头像失败');
}

export async function deleteRemoteAvatar(accessToken: string): Promise<RemoteProfile> {
  const res = await fetch(`${getApiConfig().laojiApiBase}/api/auth/me/avatar`, {
    method: 'DELETE',
    headers: bearer(accessToken),
  });
  return parseJsonResponse<RemoteProfile>(res, '删除头像失败');
}

export async function loadStoredToken(): Promise<string | null> {
  return SecureStore.getItemAsync(AUTH_TOKEN_KEY);
}

export async function saveStoredToken(token: string): Promise<void> {
  await SecureStore.setItemAsync(AUTH_TOKEN_KEY, token);
}

export async function clearStoredToken(): Promise<void> {
  await SecureStore.deleteItemAsync(AUTH_TOKEN_KEY);
}
