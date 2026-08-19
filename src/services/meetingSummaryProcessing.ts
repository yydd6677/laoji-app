import { UpdateProcessingStageUseCase } from '../application/meeting';
import { getFeatureFlags } from '../config/featureFlags';
import type {
  ProcessingStage,
  ProcessingStageTransition,
  ScopeKey,
} from '../domain/meeting';
import { transitionProcessingStage } from '../domain/meeting';
import { sqliteMeetingNoteRepository } from '../data/repositories';
import { HttpResponseError } from './errors';
import { diagnosticAudit, diagnosticWarn } from './diagnostics';

export type MeetingSummaryProcessingSignal =
  | {
    type: 'prepare';
    inputFingerprint: string;
  }
  | {
    type: 'task_status';
    status: 'queued' | 'generating';
    taskId: string;
    inputFingerprint: string;
  }
  | {
    type: 'failed';
    taskId: string | null;
    inputFingerprint: string;
    errorCode: string;
  }
  | {
    type: 'aborted';
    taskId: string | null;
    inputFingerprint: string;
  }
  | {
    type: 'discarded';
  }
  | {
    type: 'recovery_failed';
  };

export type MeetingSummaryProcessingWriteOutcome =
  | 'updated'
  | 'unchanged'
  | 'disabled'
  | 'meeting_unavailable'
  | 'failed';

export interface RecordMeetingSummaryProcessingInput {
  scopeKey: ScopeKey;
  legacyMeetingId: string;
  signal: MeetingSummaryProcessingSignal;
}

const updateProcessingStage = new UpdateProcessingStageUseCase({
  repository: sqliteMeetingNoteRepository,
});
const pendingWrites = new Map<string, Promise<MeetingSummaryProcessingWriteOutcome>>();

function normalizedRequired(value: string, label: string): string {
  const normalized = value.trim();
  if (!normalized) throw new Error(`${label} is required`);
  return normalized;
}

export function meetingSummaryProcessingTransition(
  current: ProcessingStage,
  signal: MeetingSummaryProcessingSignal,
  hasCurrentSummary: boolean,
): ProcessingStageTransition {
  if (current.stage !== 'summary') throw new Error('meeting summary processing stage is invalid');
  if (signal.type === 'prepare') {
    return {
      stage: 'summary',
      status: 'queued',
      progress: null,
      jobId: null,
      inputFingerprint: normalizedRequired(signal.inputFingerprint, 'summary input fingerprint'),
    };
  }
  if (signal.type === 'task_status') {
    const taskId = normalizedRequired(signal.taskId, 'summary task ID');
    return {
      stage: 'summary',
      status: signal.status,
      attemptStarted: current.jobId !== taskId,
      progress: null,
      jobId: taskId,
      inputFingerprint: normalizedRequired(signal.inputFingerprint, 'summary input fingerprint'),
    };
  }
  if (signal.type === 'failed') {
    return {
      stage: 'summary',
      status: 'failed_retryable',
      progress: null,
      jobId: signal.taskId?.trim() || null,
      inputFingerprint: normalizedRequired(signal.inputFingerprint, 'summary input fingerprint'),
      errorCode: normalizedRequired(signal.errorCode, 'summary error code'),
      userMessageKey: 'meeting.summary.retryable',
      retryable: true,
      nextRetryAtMs: null,
    };
  }
  if (signal.type === 'aborted') {
    const taskId = signal.taskId?.trim() || null;
    // Abort means that this page stopped waiting; it is not a service
    // failure.  Preserve the durable stage for both a known task and the
    // short window before onTaskSubmitted has persisted its task ID.  A later
    // foreground poll/recovery pass is responsible for observing the real
    // terminal state.
    if (
      (current.status === 'queued' || current.status === 'generating')
      && (taskId || current.jobId)
    ) {
      return {
        stage: 'summary',
        status: current.status,
        progress: current.progress,
        jobId: taskId ?? current.jobId,
        inputFingerprint: current.inputFingerprint,
      };
    }
    // No task ID means the page stopped during preparation/submission, before
    // the service accepted a durable job. Keeping a queued stage here would
    // disable every future generation after re-entry even though there is
    // nothing to resume. Return to the real terminal projection instead.
    if (current.status === 'queued') {
      return hasCurrentSummary
        ? {
          stage: 'summary',
          status: 'ready',
          progress: 1,
          jobId: null,
          inputFingerprint: current.inputFingerprint,
        }
        : {
          stage: 'summary',
          status: 'none',
          progress: null,
          jobId: null,
          inputFingerprint: null,
        };
    }
    if (current.status === 'ready' || current.status === 'stale' || current.status === 'none') {
      return {
        stage: 'summary',
        status: current.status,
        progress: current.progress,
        jobId: current.jobId,
        inputFingerprint: current.inputFingerprint,
      };
    }
    return {
      stage: 'summary',
      status: 'failed_retryable',
      progress: null,
      jobId: null,
      inputFingerprint: normalizedRequired(signal.inputFingerprint, 'summary input fingerprint'),
      errorCode: 'summary_submission_interrupted',
      userMessageKey: 'meeting.summary.retryable',
      retryable: true,
      nextRetryAtMs: null,
    };
  }
  if (signal.type === 'recovery_failed') {
    return {
      stage: 'summary',
      status: 'failed_retryable',
      progress: null,
      errorCode: 'summary_recovery_registry_unavailable',
      userMessageKey: 'meeting.summary.retryable',
      retryable: true,
      nextRetryAtMs: null,
    };
  }
  // Discarding a missing or mismatched task is not evidence that the
  // transcript changed. In particular, opening a finished meeting can clear
  // an orphaned queued task after recording stopped and must leave a valid
  // summary valid. Only a summary that was already marked stale remains stale;
  // a valid current summary returns to its terminal ready state.
  if (hasCurrentSummary) {
    return {
      stage: 'summary',
      status: current.status === 'stale' ? 'stale' : 'ready',
      progress: current.status === 'stale' ? null : 1,
      jobId: null,
    };
  }
  return {
    stage: 'summary',
    status: 'none',
    progress: null,
    jobId: null,
    inputFingerprint: null,
  };
}

function transitionChangesStage(
  current: ProcessingStage,
  transition: ProcessingStageTransition,
): boolean {
  const next = transitionProcessingStage(current, transition, current.updatedAtMs);
  return next.status !== current.status
    || next.attemptCount !== current.attemptCount
    || next.progress !== current.progress
    || next.jobId !== current.jobId
    || next.inputFingerprint !== current.inputFingerprint
    || next.errorCode !== current.errorCode
    || next.userMessageKey !== current.userMessageKey
    || next.retryable !== current.retryable
    || next.nextRetryAtMs !== current.nextRetryAtMs;
}

async function writeProcessingState(
  input: RecordMeetingSummaryProcessingInput,
): Promise<MeetingSummaryProcessingWriteOutcome> {
  if (!getFeatureFlags().localMeetingDbV1) return 'disabled';
  try {
    const legacyMeetingId = normalizedRequired(input.legacyMeetingId, 'legacy meeting ID');
    const direct = await sqliteMeetingNoteRepository.get(legacyMeetingId, input.scopeKey);
    const aggregate = direct ?? await sqliteMeetingNoteRepository.findByNativeSessionId(
      legacyMeetingId,
      input.scopeKey,
    );
    if (!aggregate || aggregate.note.lifecycle === 'deleted') return 'meeting_unavailable';
    const current = aggregate.processingStages.find(stage => stage.stage === 'summary');
    if (!current) throw new Error('meeting summary processing stage is missing');
    const transition = meetingSummaryProcessingTransition(
      current,
      input.signal,
      aggregate.note.currentSummaryVersionId !== null,
    );
    if (!transitionChangesStage(current, transition)) return 'unchanged';
    await updateProcessingStage.execute({
      meetingId: aggregate.note.id,
      scopeKey: input.scopeKey,
      transition,
    });
    return 'updated';
  } catch (reason) {
    diagnosticWarn('[meeting-db] summary processing stage write failed', reason);
    return 'failed';
  }
}

export function recordMeetingSummaryProcessing(
  input: RecordMeetingSummaryProcessingInput,
): Promise<MeetingSummaryProcessingWriteOutcome> {
  const key = `${input.scopeKey}\u0000${input.legacyMeetingId.trim()}`;
  const previous = pendingWrites.get(key) ?? Promise.resolve('unchanged');
  const operation = previous
    .catch(() => 'failed' as const)
    .then(() => writeProcessingState(input));
  pendingWrites.set(key, operation);
  void operation.then(outcome => {
    if (outcome !== 'unchanged') {
      diagnosticAudit('meeting_summary_processing_stage', {
        signal: input.signal.type,
        outcome,
        scope: input.scopeKey === 'guest' ? 'guest' : 'account',
      });
    }
    if (pendingWrites.get(key) === operation) pendingWrites.delete(key);
  });
  return operation;
}

export function meetingSummaryProcessingFailureCode(reason: unknown): string {
  if (reason instanceof HttpResponseError) {
    if (reason.status === 401) return 'summary_authentication_required';
    if (reason.status === 403) return 'summary_access_denied';
    if (reason.status === 400) return 'summary_request_invalid';
    if (reason.status === 404) return 'summary_task_missing';
    if (reason.status >= 500) return 'summary_service_unavailable';
  }
  const name = reason instanceof Error ? reason.name : '';
  const message = reason instanceof Error ? reason.message.toLowerCase() : '';
  if (name === 'DeviceMeetingUnavailableError') return 'summary_device_meeting_unavailable';
  if (name === 'MeetingSummaryTaskFailureError') return 'summary_worker_failed';
  if (name === 'MeetingSummaryInputChangedError') return 'summary_input_changed';
  if (/timed out|timeout/.test(message)) return 'summary_task_timeout';
  if (/network|failed to fetch|connection refused/.test(message)) return 'summary_network_unavailable';
  return 'summary_generation_failed';
}
