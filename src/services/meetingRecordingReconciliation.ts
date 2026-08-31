import {
  hasNativeRecorder,
  recoverNativeRecordings,
} from 'laoji-native-platform';
import { RecordingReconciler, type RecordingReconciliationResult } from '../application';
import type { ScopeKey } from '../domain/meeting';
import { sqliteMeetingNoteRepository } from "../data/repositories/sqliteMeetingNoteRepository";
import { diagnosticAudit, diagnosticWarn } from './diagnostics';

const reconciler = new RecordingReconciler({ repository: sqliteMeetingNoteRepository });
const inFlightByScope = new Map<ScopeKey, Promise<RecordingReconciliationResult | null>>();
const lastRunAtByScope = new Map<ScopeKey, number>();
const FOREGROUND_THROTTLE_MS = 15_000;

export interface ReconcileNativeMeetingRecordingsOptions {
  force?: boolean;
}

export function reconcileNativeMeetingRecordings(
  scopeKey: ScopeKey,
  options: ReconcileNativeMeetingRecordingsOptions = {},
): Promise<RecordingReconciliationResult | null> {
  if (!hasNativeRecorder()) return Promise.resolve(null);
  const existing = inFlightByScope.get(scopeKey);
  if (existing) return existing;
  const nowMs = Date.now();
  const lastRunAtMs = lastRunAtByScope.get(scopeKey) ?? 0;
  if (!options.force && nowMs - lastRunAtMs < FOREGROUND_THROTTLE_MS) {
    return Promise.resolve(null);
  }
  lastRunAtByScope.set(scopeKey, nowMs);
  let operation: Promise<RecordingReconciliationResult | null>;
  operation = recoverNativeRecordings()
    .then(report => reconciler.reconcile(scopeKey, report))
    .then(result => {
      diagnosticAudit('meeting_recording_reconciled', {
        status: 'completed',
        owner: 'device-local',
        network_path: 'none',
        reconciliation_kind: 'native-journal-local-sqlite',
        matched: result.matched,
        recovered_meetings: result.recoveredMeetingsCreated,
        assets_updated: result.recordingAssetsUpdated,
        missing_assets: result.missingAssetsMarked,
        conflicts: result.conflicts,
        ignored_other_scopes: result.ignoredOtherScopes,
        unresolved_failures: result.unresolvedFailures,
      });
      return result;
    })
    .catch(error => {
      diagnosticWarn('[meeting-db] recording reconciliation failed', error);
      diagnosticAudit('meeting_recording_reconciled', {
        status: 'failed',
        owner: 'device-local',
        network_path: 'none',
        reconciliation_kind: 'native-journal-local-sqlite',
        error_code: error instanceof Error ? error.name : 'UnknownError',
      });
      return null;
    })
    .finally(() => {
      if (inFlightByScope.get(scopeKey) === operation) inFlightByScope.delete(scopeKey);
    });
  inFlightByScope.set(scopeKey, operation);
  return operation;
}
