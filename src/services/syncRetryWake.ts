function assertOptionalDelay(value: number | null, label: string): void {
  if (value !== null && (!Number.isSafeInteger(value) || value < 0)) {
    throw new Error(`${label} is invalid`);
  }
}

/** Combines a relative retry already seen in this drain with an absolute durable wake time. */
export function mergeSyncRetryAfterMs(
  nowMs: number,
  persistedAttemptAtMs: number | null,
  observedRetryAfterMs: number | null,
): number | null {
  if (!Number.isSafeInteger(nowMs) || nowMs < 0) throw new Error('sync retry clock is invalid');
  assertOptionalDelay(persistedAttemptAtMs, 'sync persisted attempt time');
  assertOptionalDelay(observedRetryAfterMs, 'sync observed retry delay');
  const persistedDelay = persistedAttemptAtMs === null
    ? null
    : Math.max(0, persistedAttemptAtMs - nowMs);
  if (observedRetryAfterMs === null) return persistedDelay;
  if (persistedDelay === null) return observedRetryAfterMs;
  return Math.min(observedRetryAfterMs, persistedDelay);
}
