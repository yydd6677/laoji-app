import type { MinutesDetailTab } from 'laoji-native-platform';
import type {
  MeetingFactsResultV3,
  MeetingSummaryDocument,
} from '../domain/meeting';

export interface MeetingDetailFactsSession {
  canonicalMeetingId: string;
  summaryVersionId: string;
  result: MeetingFactsResultV3;
}

export interface MeetingDetailSessionState {
  activeTab: MinutesDetailTab;
  summaryDocument: MeetingSummaryDocument | null;
  activeFactsV3: MeetingDetailFactsSession | null;
}

const MAX_SESSIONS = 24;
const sessions = new Map<string, MeetingDetailSessionState>();

function sessionKey(scopeKey: string, meetingId: string): string {
  return `${scopeKey.trim()}\u0000${meetingId.trim()}`;
}

export function readMeetingDetailSession(
  scopeKey: string,
  meetingId: string,
): MeetingDetailSessionState | null {
  const key = sessionKey(scopeKey, meetingId);
  const value = sessions.get(key) ?? null;
  if (!value) return null;
  sessions.delete(key);
  sessions.set(key, value);
  return value;
}

export function rememberMeetingDetailSession(
  scopeKey: string,
  meetingId: string,
  state: MeetingDetailSessionState,
): void {
  const key = sessionKey(scopeKey, meetingId);
  sessions.delete(key);
  sessions.set(key, state);
  while (sessions.size > MAX_SESSIONS) {
    const oldest = sessions.keys().next().value as string | undefined;
    if (!oldest) break;
    sessions.delete(oldest);
  }
}

/**
 * A native detail-tab tap already owns the visible transition. Persist that
 * lightweight preference without forcing the React detail screen to rebuild
 * its full transcript/summary snapshot just to mirror the selected tab.
 */
export function rememberMeetingDetailActiveTab(
  scopeKey: string,
  meetingId: string,
  activeTab: MinutesDetailTab,
): void {
  const key = sessionKey(scopeKey, meetingId);
  const current = sessions.get(key);
  if (!current) return;
  sessions.delete(key);
  sessions.set(key, { ...current, activeTab });
}

export function forgetMeetingDetailSession(scopeKey: string, meetingId: string): void {
  sessions.delete(sessionKey(scopeKey, meetingId));
}
