import type { ScopeKey } from '../../domain/meeting';

type Listener = (scopeKey: ScopeKey) => void;

const syncListeners = new Set<Listener>();
const changeListeners = new Set<Listener>();

export function requestMeetingAttachmentSync(scopeKey: ScopeKey): void {
  if (scopeKey === 'guest') return;
  syncListeners.forEach(listener => {
    try {
      listener(scopeKey);
    } catch {
      // The local attachment transaction is already durable.
    }
  });
}

export function subscribeMeetingAttachmentSync(listener: Listener): () => void {
  syncListeners.add(listener);
  return () => syncListeners.delete(listener);
}

export function notifyMeetingAttachmentsChanged(scopeKey: ScopeKey): void {
  changeListeners.forEach(listener => {
    try {
      listener(scopeKey);
    } catch {
      // Screens refresh again on focus if a listener is unavailable.
    }
  });
}

export function subscribeMeetingAttachmentsChanged(listener: Listener): () => void {
  changeListeners.add(listener);
  return () => changeListeners.delete(listener);
}
