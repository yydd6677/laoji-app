import type { TranscriptLine } from '../types';
import type { MeetingTranscriptFailureKind } from './meetingStageMirror';
import type { TranscriptCandidateKind, TranscriptRemoteState, TranscriptServerCompleteness } from './transcriptCompleteness';

export type MeetingTranscriptCompletionStatus = 'pending' | 'ready' | 'failed';

export interface CompleteMeetingTranscriptInput {
  meetingId: string;
  localLines: readonly TranscriptLine[];
  completedCandidateKind?: Extract<TranscriptCandidateKind, 'final' | 'reprocessed'>;
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
}

export interface CompleteMeetingTranscriptResult {
  status: MeetingTranscriptCompletionStatus;
  lines: TranscriptLine[];
  remoteState: TranscriptRemoteState;
  preservedReadableDraft: false;
  failureKind: MeetingTranscriptFailureKind | null;
}

/** Finalizes the phone-owned transcript projection after local capture commits. */
export async function completeMeetingTranscriptAfterCapture(
  input: CompleteMeetingTranscriptInput,
  dependencies: CompleteMeetingTranscriptDependencies,
): Promise<CompleteMeetingTranscriptResult> {
  const candidate = [...input.localLines];
  let failureKind: MeetingTranscriptFailureKind | null = null;
  let failureReason: unknown = null;
  try {
    await dependencies.saveTranscript(input.meetingId, candidate, {
      candidateKind: input.completedCandidateKind ?? 'final',
      serverCompleteness: 'complete',
      remoteRevisionId: null,
    });
  } catch (reason) {
    failureKind = 'persistence';
    failureReason = reason;
  }

  let cached: TranscriptLine[] = [];
  try {
    cached = dependencies.getCachedTranscript(input.meetingId);
  } catch (reason) {
    failureKind = 'persistence';
    failureReason = reason;
  }
  if (failureKind && dependencies.onFailure) {
    await dependencies.onFailure(failureKind, failureReason).catch(() => undefined);
  }
  return {
    status: failureKind ? 'failed' : 'ready',
    lines: cached.length > 0 || candidate.length === 0 ? cached : candidate,
    remoteState: 'unknown',
    preservedReadableDraft: false,
    failureKind,
  };
}
