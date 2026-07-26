import type { ScopeKey } from '../../domain/meeting';

type Listener = (scopeKey: ScopeKey) => void;

const syncListeners = new Set<Listener>();
const changeListeners = new Set<Listener>();

export function requestMeetingTagCatalogSync(scopeKey: ScopeKey): void {
  if (scopeKey === 'guest') return;
  syncListeners.forEach(listener => {
    try {
      listener(scopeKey);
    } catch {
      // A committed local tag mutation must not fail because scheduling failed.
    }
  });
}

export function subscribeMeetingTagCatalogSync(listener: Listener): () => void {
  syncListeners.add(listener);
  return () => syncListeners.delete(listener);
}

export function notifyMeetingTagCatalogChanged(scopeKey: ScopeKey): void {
  changeListeners.forEach(listener => {
    try {
      listener(scopeKey);
    } catch {
      // Remote data is already committed; a screen can refresh on next focus.
    }
  });
}

export function subscribeMeetingTagCatalogChanged(listener: Listener): () => void {
  changeListeners.add(listener);
  return () => changeListeners.delete(listener);
}
