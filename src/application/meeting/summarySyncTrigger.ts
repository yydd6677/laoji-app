import type { ScopeKey } from '../../domain/meeting';

type Listener = (scopeKey: ScopeKey) => void;

const syncListeners = new Set<Listener>();
const changeListeners = new Set<Listener>();

export function requestMeetingSummarySync(scopeKey: ScopeKey): void {
  if (scopeKey === 'guest') return;
  syncListeners.forEach(listener => {
    try {
      listener(scopeKey);
    } catch {
      // The local Summary mutation is already durable and is repaired on foreground.
    }
  });
}

export function subscribeMeetingSummarySync(listener: Listener): () => void {
  syncListeners.add(listener);
  return () => syncListeners.delete(listener);
}

export function notifyMeetingSummaryChanged(scopeKey: ScopeKey): void {
  changeListeners.forEach(listener => {
    try {
      listener(scopeKey);
    } catch {
      // Detail screens also refresh on focus.
    }
  });
}

export function subscribeMeetingSummaryChanged(listener: Listener): () => void {
  changeListeners.add(listener);
  return () => changeListeners.delete(listener);
}
