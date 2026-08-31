/**
 * App-process owner for meeting summary work.
 *
 * A detail screen is only a presenter. Navigating away must not stop source
 * preparation/upload or start another client runner for the same meeting.
 * The durable SQLite processing stage remains the cross-process source of
 * truth; this registry only owns live JavaScript work inside one app process.
 */

const activeOperations = new Map<string, Promise<void>>();

function operationKey(storageScope: string, meetingId: string): string {
  return `${storageScope.trim()}\u0000${meetingId.trim()}`;
}

export function getActiveMeetingSummaryOperation(
  storageScope: string,
  meetingId: string,
): Promise<void> | null {
  return activeOperations.get(operationKey(storageScope, meetingId)) ?? null;
}

export function trackMeetingSummaryOperation(
  storageScope: string,
  meetingId: string,
  operation: Promise<void>,
): Promise<void> {
  const key = operationKey(storageScope, meetingId);
  const existing = activeOperations.get(key);
  if (existing) return existing;
  activeOperations.set(key, operation);
  void operation.finally(() => {
    if (activeOperations.get(key) === operation) activeOperations.delete(key);
  }).catch(() => undefined);
  return operation;
}
