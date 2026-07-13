import { AuthSession } from './auth';

export const SESSION_REFRESH_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

function expiryTime(session: Pick<AuthSession, 'expiresAt'>): number | null {
  if (!session.expiresAt) return null;
  const value = Date.parse(session.expiresAt);
  return Number.isFinite(value) ? value : null;
}

export function isStoredSessionExpired(
  session: Pick<AuthSession, 'expiresAt'>,
  now = Date.now(),
): boolean {
  const expiresAt = expiryTime(session);
  return expiresAt !== null && expiresAt <= now;
}

export function shouldRefreshStoredSession(
  session: Pick<AuthSession, 'expiresAt'>,
  now = Date.now(),
): boolean {
  const expiresAt = expiryTime(session);
  return expiresAt !== null && expiresAt > now && expiresAt - now <= SESSION_REFRESH_WINDOW_MS;
}
