import type { EventRef } from '../types';
import { isEventRef } from '../utils/eventIdentity';

export const LAOJI_SEMANTIC_LINK_SCHEME = 'laoji';

export type SemanticEventOrigin = 'notification' | 'widget';
export type SemanticEventAction = 'open-event' | 'start-or-resume-meeting';

export type SemanticNavigationIntent =
  | {
      kind: 'event';
      action: SemanticEventAction;
      origin: SemanticEventOrigin;
      ref: EventRef;
    }
  | {
      kind: 'new-meeting';
      origin: 'quick_tile';
    };

export type SemanticEventNavigationIntent = Extract<SemanticNavigationIntent, { kind: 'event' }>;

const SOURCE_EVENT_ID_MAX_LENGTH = 512;
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f]/;

function validSourceEventId(value: string): boolean {
  return value.length > 0
    && value.length <= SOURCE_EVENT_ID_MAX_LENGTH
    && !CONTROL_CHARACTER_PATTERN.test(value);
}

function validDateKey(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split('-').map(Number);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  return parsed.getUTCFullYear() === year
    && parsed.getUTCMonth() === month - 1
    && parsed.getUTCDate() === day;
}

function hasExactQuery(
  url: URL,
  expected: Readonly<Record<string, string>>,
): boolean {
  const keys = Array.from(url.searchParams.keys());
  const expectedKeys = Object.keys(expected);
  if (keys.length !== expectedKeys.length || new Set(keys).size !== keys.length) return false;
  return expectedKeys.every(key => (
    url.searchParams.getAll(key).length === 1
    && url.searchParams.get(key) === expected[key]
  ));
}

export function semanticEventIntent(
  ref: EventRef,
  action: SemanticEventAction,
  origin: SemanticEventOrigin,
): SemanticEventNavigationIntent | null {
  if (!isEventRef(ref) || !validSourceEventId(ref.sourceEventId) || !validDateKey(ref.occurrenceDate)) {
    return null;
  }
  return { kind: 'event', action, origin, ref };
}

export function parseLaojiSemanticLink(rawUrl: string): SemanticNavigationIntent | null {
  if (typeof rawUrl !== 'string' || rawUrl.length === 0 || rawUrl.length > 2_048) return null;
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return null;
  }
  if (
    url.protocol !== `${LAOJI_SEMANTIC_LINK_SCHEME}:`
    || url.username
    || url.password
    || url.port
    || url.hash
  ) return null;

  if (url.hostname === 'meeting' && url.pathname === '/new') {
    return hasExactQuery(url, { origin: 'quick_tile' })
      ? { kind: 'new-meeting', origin: 'quick_tile' }
      : null;
  }

  if (url.hostname !== 'calendar' || url.pathname !== '/occurrence') return null;
  const sourceEventId = url.searchParams.get('sourceEventId') ?? '';
  const occurrenceDate = url.searchParams.get('occurrenceDate') ?? '';
  const action = url.searchParams.get('action');
  const origin = url.searchParams.get('origin');
  if (
    (action !== 'open' && action !== 'meeting')
    || origin !== 'widget'
    || !hasExactQuery(url, { sourceEventId, occurrenceDate, action, origin })
  ) return null;
  return semanticEventIntent(
    { sourceEventId, occurrenceDate },
    action === 'meeting' ? 'start-or-resume-meeting' : 'open-event',
    'widget',
  );
}

export function semanticLinkForOccurrence(
  ref: EventRef,
  action: 'open' | 'meeting',
): string | null {
  const intent = semanticEventIntent(
    ref,
    action === 'meeting' ? 'start-or-resume-meeting' : 'open-event',
    'widget',
  );
  if (!intent) return null;
  const query = new URLSearchParams({
    sourceEventId: ref.sourceEventId,
    occurrenceDate: ref.occurrenceDate,
    action,
    origin: 'widget',
  });
  return `${LAOJI_SEMANTIC_LINK_SCHEME}://calendar/occurrence?${query.toString()}`;
}
