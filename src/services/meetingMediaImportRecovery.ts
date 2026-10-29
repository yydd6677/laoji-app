import type { IngestedMeetingMedia } from 'laoji-native-platform';

type RecoveryDependencies = {
  list: () => Promise<IngestedMeetingMedia[]>;
  restore: (media: IngestedMeetingMedia) => Promise<void>;
  active: () => boolean;
  report: (phase: 'scan' | 'restore', reason: unknown) => void;
};

/** Journals own retry. A failed item must not block unrelated items or open UI. */
export async function recoverMeetingMediaImportBatch(deps: RecoveryDependencies): Promise<boolean> {
  let pending: IngestedMeetingMedia[];
  try {
    pending = await deps.list();
  } catch (reason) {
    deps.report('scan', reason);
    return false;
  }
  let complete = true;
  for (const media of pending) {
    if (!deps.active()) return false;
    try {
      await deps.restore(media);
    } catch (reason) {
      complete = false;
      deps.report('restore', reason);
    }
  }
  return complete;
}
