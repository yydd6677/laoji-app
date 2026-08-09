/**
 * Small in-process scheduler for the device-primary transport.
 *
 * Realtime WebSocket audio must not compete with a background binary upload
 * for the same mobile/Tunnel connection.  Background callers wait between
 * requests (and between chunks), so a recording can start without losing the
 * durable upload; the next chunk resumes as soon as the last realtime session
 * releases its lease.
 */

let realtimeLeases = 0;
const backgroundWaiters: Array<() => void> = [];

export function beginRealtimeNetworkPriority(): () => void {
  realtimeLeases += 1;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    realtimeLeases = Math.max(0, realtimeLeases - 1);
    if (realtimeLeases > 0) return;
    const waiters = backgroundWaiters.splice(0);
    waiters.forEach(resolve => resolve());
  };
}

export function waitForBackgroundNetworkTurn(): Promise<void> {
  if (realtimeLeases === 0) return Promise.resolve();
  return new Promise(resolve => {
    backgroundWaiters.push(resolve);
  });
}

export function isRealtimeNetworkPriorityActive(): boolean {
  return realtimeLeases > 0;
}
