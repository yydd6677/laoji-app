import type { ScopeKey } from '../domain/meeting';
import type { TranscriptLine } from '../types';
import { diagnosticWarn } from './diagnostics';
import type { MeetingTranscriptFailureKind } from './meetingStageMirror';
import {
  completeMeetingTranscriptAfterCapture,
  type CompleteMeetingTranscriptResult,
} from './meetingTranscriptCompletion';
import {
  clearPendingMeetingTranscriptCompletion,
  recordMeetingTranscriptCompletionAttempt,
  recordMeetingTranscriptCompletionResult,
  savePendingMeetingTranscriptCompletion,
} from './meetingTranscriptCompletionTasks';
import type {
  TranscriptCandidateKind,
  TranscriptServerCompleteness,
} from './transcriptCompleteness';

export interface RunAccountMeetingTranscriptCompletionInput {
  scopeKey: Exclude<ScopeKey, 'guest'>;
  storageScope: string;
  meetingId: string;
  remoteMeetingId: string;
  accessToken: string;
  localLines: readonly TranscriptLine[];
  retryDelaysMs?: readonly number[];
  taskRegistered?: boolean;
  completedCandidateKind?: Extract<TranscriptCandidateKind, 'final' | 'reprocessed'>;
}

export interface RunAccountMeetingTranscriptCompletionDependencies {
  saveTranscript: (
    meetingId: string,
    lines: TranscriptLine[],
    options?: {
      candidateKind?: TranscriptCandidateKind;
      serverCompleteness?: TranscriptServerCompleteness;
      remoteRevisionId?: string | null;
    },
  ) => Promise<void>;
  getCachedTranscript: (meetingId: string) => TranscriptLine[];
  onFailure?: (kind: MeetingTranscriptFailureKind, reason: unknown) => Promise<void>;
}

const inFlightByMeeting = new Map<string, Promise<CompleteMeetingTranscriptResult>>();

function operationKey(scopeKey: ScopeKey, meetingId: string): string {
  return `${scopeKey}\u001f${meetingId}`;
}

/** Account credentials are supplied per run and are never written to the task registry. */
export function runAccountMeetingTranscriptCompletion(
  input: RunAccountMeetingTranscriptCompletionInput,
  dependencies: RunAccountMeetingTranscriptCompletionDependencies,
): Promise<CompleteMeetingTranscriptResult> {
  if (input.storageScope.trim() !== input.scopeKey) {
    return Promise.reject(new Error('transcript completion scope is inconsistent'));
  }
  const key = operationKey(input.scopeKey, input.meetingId);
  const existing = inFlightByMeeting.get(key);
  if (existing) return existing;

  let operation: Promise<CompleteMeetingTranscriptResult>;
  operation = (async () => {
    let registryAvailable = input.taskRegistered === true;
    if (!registryAvailable) {
      try {
        await savePendingMeetingTranscriptCompletion(
          input.storageScope,
          input.meetingId,
          input.remoteMeetingId,
        );
        registryAvailable = true;
      } catch (reason) {
        diagnosticWarn('persist transcript completion task failed', reason);
      }
    }
    if (registryAvailable) {
      await recordMeetingTranscriptCompletionAttempt(input.storageScope, input.meetingId)
        .catch(reason => diagnosticWarn('record transcript completion attempt failed', reason));
    }

    try {
      const result = await completeMeetingTranscriptAfterCapture({
        meetingId: input.meetingId,
        localLines: input.localLines,
        remote: {
          kind: 'account',
          meetingId: input.remoteMeetingId,
          accessToken: input.accessToken,
        },
        retryDelaysMs: input.retryDelaysMs,
        completedCandidateKind: input.completedCandidateKind,
      }, dependencies);
      if (registryAvailable) {
        if (result.status === 'ready') {
          await clearPendingMeetingTranscriptCompletion(
            input.storageScope,
            input.meetingId,
          ).catch(reason => diagnosticWarn('clear transcript completion task failed', reason));
        } else {
          await recordMeetingTranscriptCompletionResult(
            input.storageScope,
            input.meetingId,
            result.status,
          ).catch(reason => diagnosticWarn('update transcript completion task failed', reason));
        }
      }
      return result;
    } catch (reason) {
      if (registryAvailable) {
        await recordMeetingTranscriptCompletionResult(
          input.storageScope,
          input.meetingId,
          'failed',
        ).catch(() => {});
      }
      throw reason;
    }
  })().finally(() => {
    if (inFlightByMeeting.get(key) === operation) inFlightByMeeting.delete(key);
  });
  inFlightByMeeting.set(key, operation);
  return operation;
}

export function resetMeetingTranscriptCompletionCoordinatorForTests(): void {
  inFlightByMeeting.clear();
}
