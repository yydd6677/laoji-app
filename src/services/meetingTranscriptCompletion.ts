import type { TranscriptLine } from '../types';
import {
  fetchGuestMeetingTranscriptSnapshot,
  fetchMeetingTranscriptSnapshot,
  type ApiTranscriptSnapshot,
} from './api';
import type { MeetingTranscriptFailureKind } from './meetingStageMirror';
import {
  evaluateTranscriptLineCandidate,
  type TranscriptCandidateKind,
  type TranscriptRemoteState,
  type TranscriptServerCompleteness,
} from './transcriptCompleteness';

const DEFAULT_COMPLETION_DELAYS_MS = [0, 250, 750] as const;

export type MeetingTranscriptCompletionStatus = 'ready' | 'pending' | 'failed';

export type MeetingTranscriptCompletionRemote =
  | { kind: 'guest'; meetingId: string; guestToken: string }
  | { kind: 'account'; meetingId: string; accessToken: string }
  | null;

export interface CompleteMeetingTranscriptInput {
  meetingId: string;
  localLines: readonly TranscriptLine[];
  remote: MeetingTranscriptCompletionRemote;
  retryDelaysMs?: readonly number[];
}

interface SaveMeetingTranscriptOptions {
  candidateKind?: TranscriptCandidateKind;
  serverCompleteness?: TranscriptServerCompleteness;
  remoteRevisionId?: string | null;
}

export interface CompleteMeetingTranscriptDependencies {
  saveTranscript: (
    meetingId: string,
    lines: TranscriptLine[],
    options?: SaveMeetingTranscriptOptions,
  ) => Promise<void>;
  getCachedTranscript: (meetingId: string) => TranscriptLine[];
  onFailure?: (kind: MeetingTranscriptFailureKind, reason: unknown) => Promise<void>;
  fetchGuestSnapshot?: typeof fetchGuestMeetingTranscriptSnapshot;
  fetchAccountSnapshot?: typeof fetchMeetingTranscriptSnapshot;
  wait?: (delayMs: number) => Promise<void>;
}

export interface CompleteMeetingTranscriptResult {
  status: MeetingTranscriptCompletionStatus;
  lines: TranscriptLine[];
  remoteState: TranscriptRemoteState;
  preservedReadableDraft: boolean;
  failureKind: MeetingTranscriptFailureKind | null;
}

function defaultWait(delayMs: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, delayMs));
}

async function fetchRemoteSnapshot(
  remote: Exclude<MeetingTranscriptCompletionRemote, null>,
  dependencies: CompleteMeetingTranscriptDependencies,
): Promise<ApiTranscriptSnapshot> {
  if (remote.kind === 'guest') {
    return (dependencies.fetchGuestSnapshot ?? fetchGuestMeetingTranscriptSnapshot)(
      remote.meetingId,
      remote.guestToken,
    );
  }
  return (dependencies.fetchAccountSnapshot ?? fetchMeetingTranscriptSnapshot)(
    remote.meetingId,
    remote.accessToken,
  );
}

/** ANDR-01: remote completion runs only after the local recording commit. */
export async function completeMeetingTranscriptAfterCapture(
  input: CompleteMeetingTranscriptInput,
  dependencies: CompleteMeetingTranscriptDependencies,
): Promise<CompleteMeetingTranscriptResult> {
  const localLines = [...input.localLines];
  const delays = input.retryDelaysMs ?? DEFAULT_COMPLETION_DELAYS_MS;
  const wait = dependencies.wait ?? defaultWait;
  let selected = localLines;
  let lastCandidate: TranscriptLine[] | null = null;
  let lastCompleteness: TranscriptServerCompleteness = 'unknown';
  let lastRemoteState: TranscriptRemoteState = 'unknown';
  let lastRemoteRevisionId: string | null = null;
  let preservedReadableDraft = false;
  let failureKind: MeetingTranscriptFailureKind | null = null;
  let failureReason: unknown = null;

  if (input.remote) {
    for (const delayMs of delays) {
      if (Number.isFinite(delayMs) && delayMs > 0) await wait(delayMs);
      let remote: ApiTranscriptSnapshot;
      try {
        remote = await fetchRemoteSnapshot(input.remote, dependencies);
      } catch (reason) {
        failureKind = 'sync';
        failureReason = reason;
        break;
      }
      const candidateKind = remote.completeness === 'incomplete' ? 'realtime_draft' : 'final';
      const decision = evaluateTranscriptLineCandidate(selected, remote.items, {
        candidateKind,
        serverCompleteness: remote.completeness,
      });
      lastCandidate = [...remote.items];
      lastCompleteness = remote.completeness;
      lastRemoteState = remote.remoteState;
      lastRemoteRevisionId = remote.remoteRevisionId;
      preservedReadableDraft = !decision.useCandidate || decision.completing;
      if (decision.useCandidate) selected = [...remote.items];
      if (remote.remoteState === 'failed') {
        failureKind = 'remote_processing';
        failureReason = new Error('remote transcript processing failed');
        break;
      }
      if (decision.useCandidate && !decision.completing && remote.items.length > 0) break;
    }
  }

  const syncFailed = failureKind === 'sync';
  const candidate = lastCandidate ?? localLines;
  const candidateKind: TranscriptCandidateKind = syncFailed
    || (lastCandidate !== null && lastCompleteness === 'incomplete')
    ? 'realtime_draft'
    : 'final';
  const serverCompleteness: TranscriptServerCompleteness = syncFailed
    ? 'incomplete'
    : lastCandidate ? lastCompleteness : 'unknown';
  let persistenceFailure: unknown = null;
  try {
    await dependencies.saveTranscript(input.meetingId, candidate, {
      candidateKind,
      serverCompleteness,
      remoteRevisionId: lastRemoteRevisionId,
    });
  } catch (reason) {
    persistenceFailure = reason;
  }

  if (persistenceFailure !== null) {
    failureKind = 'persistence';
    failureReason = persistenceFailure;
  }
  let cached: TranscriptLine[] = [];
  try {
    cached = dependencies.getCachedTranscript(input.meetingId);
  } catch (reason) {
    persistenceFailure = reason;
    failureKind = 'persistence';
    failureReason = reason;
  }
  if (failureKind && dependencies.onFailure) {
    await dependencies.onFailure(failureKind, failureReason).catch(() => {});
  }

  const effective = cached.length > 0 || selected.length === 0
    ? [...cached]
    : persistenceFailure === null ? [...selected] : localLines;
  const status: MeetingTranscriptCompletionStatus = failureKind
    ? 'failed'
    : preservedReadableDraft ? 'pending' : 'ready';
  return {
    status,
    lines: effective,
    remoteState: lastRemoteState,
    preservedReadableDraft,
    failureKind,
  };
}
