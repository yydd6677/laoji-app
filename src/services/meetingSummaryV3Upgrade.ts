type Listener = (canonicalMeetingId: string) => void;

const listeners = new Set<Listener>();
let interactiveWorkCount = 0;

export function notifySummaryV3UpgradeChanged(canonicalMeetingId: string): void {
  listeners.forEach(listener => listener(canonicalMeetingId));
}

export function subscribeSummaryV3UpgradeChanged(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/**
 * Give foreground meeting work priority over legacy summary upgrades.
 * The returned release function is idempotent so abort and unmount paths can
 * share the same cleanup without underflowing the counter.
 */
export function beginSummaryV3InteractiveWork(): () => void {
  interactiveWorkCount += 1;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    interactiveWorkCount = Math.max(0, interactiveWorkCount - 1);
  };
}

export function hasSummaryV3InteractiveWork(): boolean {
  return interactiveWorkCount > 0;
}
