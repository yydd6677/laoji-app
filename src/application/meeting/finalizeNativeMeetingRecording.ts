import type { ScopeKey } from '../../domain/meeting';
import type { Meeting, TranscriptLine } from '../../types';
import { diagnosticWarn } from '../../services/diagnostics';
import {
  finalizeMeetingRecording,
  type FinalizeMeetingRecordingResult,
  type PendingMeetingAudioUpload,
} from '../../services/meetingRecording';
import type { MeetingTranscriptFailureKind } from '../../services/meetingStageMirror';
import {
  completeMeetingTranscriptAfterCapture,
  type MeetingTranscriptCompletionStatus,
} from '../../services/meetingTranscriptCompletion';
import type {
  TranscriptCandidateKind,
  TranscriptServerCompleteness,
} from '../../services/transcriptCompleteness';

export interface FinalizeNativeMeetingRecordingInput {
  meetingId: string;
  remoteMeetingId: string | null;
  storageScope: string;
  scopeKey: ScopeKey | null;
  getTranscriptLines: () => TranscriptLine[];
  getAudioDurationSec: () => number | undefined;
  getAudioBars: () => number[] | undefined;
  stopAudio: () => Promise<string | undefined>;
}

export interface FinalizeNativeMeetingRecordingResult extends FinalizeMeetingRecordingResult {
  transcriptCompletion: MeetingTranscriptCompletionStatus;
  transcriptLines: TranscriptLine[];
  transcriptCompletionTask: Promise<NativeMeetingTranscriptCompletionResult>;
}

export interface NativeMeetingTranscriptCompletionResult {
  status: MeetingTranscriptCompletionStatus;
  lines: TranscriptLine[];
}

export interface FinalizeNativeMeetingRecordingDependencies {
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
  recordTranscriptFailure?: (
    scopeKey: ScopeKey,
    meetingId: string,
    kind: MeetingTranscriptFailureKind,
    reason: unknown,
  ) => Promise<void>;
  updateStatus: (
    meetingId: string,
    status: string,
    patch: Partial<Meeting>,
  ) => Promise<boolean>;
  refreshMeetings: () => Promise<void>;
  reconcileUploads?: (uploaded?: PendingMeetingAudioUpload) => Promise<void>;
}

/** ANDR-01: application orchestration starts only after Android owns capture. */
export class FinalizeNativeMeetingRecordingUseCase {
  constructor(private readonly dependencies: FinalizeNativeMeetingRecordingDependencies) {}

  async execute(
    input: FinalizeNativeMeetingRecordingInput,
  ): Promise<FinalizeNativeMeetingRecordingResult> {
    const committed = await finalizeMeetingRecording({
      meetingId: input.meetingId,
      storageScope: input.storageScope,
      transcriptLines: input.getTranscriptLines(),
      getTranscriptLines: input.getTranscriptLines,
      getAudioDurationSec: input.getAudioDurationSec,
      getAudioBars: input.getAudioBars,
      stopAudio: input.stopAudio,
    }, {
      saveTranscript: this.dependencies.saveTranscript,
      onTranscriptSaveFailure: (meetingId, reason) => this.recordTranscriptFailure(
        input.scopeKey,
        meetingId,
        'persistence',
        reason,
      ),
      updateStatus: this.dependencies.updateStatus,
      refreshMeetings: this.dependencies.refreshMeetings,
      reconcileUploads: this.dependencies.reconcileUploads,
    });
    const transcriptLines = input.getTranscriptLines();
    const transcriptCompletionTask = this.completeTranscript(
      input,
      transcriptLines,
    );
    return {
      ...committed,
      transcriptCompletion: 'pending',
      transcriptLines,
      transcriptCompletionTask,
    };
  }

  private async completeTranscript(
    input: FinalizeNativeMeetingRecordingInput,
    localLines: TranscriptLine[],
  ): Promise<NativeMeetingTranscriptCompletionResult> {
    try {
      const completionDependencies = {
        saveTranscript: this.dependencies.saveTranscript,
        getCachedTranscript: this.dependencies.getCachedTranscript,
        onFailure: (kind: MeetingTranscriptFailureKind, reason: unknown) => this.recordTranscriptFailure(
          input.scopeKey,
          input.meetingId,
          kind,
          reason,
        ),
      };
      const completion = await completeMeetingTranscriptAfterCapture({
        meetingId: input.meetingId,
        localLines,
      }, completionDependencies);
      return { status: completion.status, lines: completion.lines };
    } catch (reason) {
      diagnosticWarn('complete transcript after local recording commit failed', reason);
      await this.recordTranscriptFailure(input.scopeKey, input.meetingId, 'sync', reason);
      return { status: 'failed', lines: localLines };
    }
  }

  private recordTranscriptFailure(
    scopeKey: ScopeKey | null,
    meetingId: string,
    kind: MeetingTranscriptFailureKind,
    reason: unknown,
  ): Promise<void> {
    if (!scopeKey || !this.dependencies.recordTranscriptFailure) return Promise.resolve();
    return this.dependencies.recordTranscriptFailure(scopeKey, meetingId, kind, reason)
      .catch(() => {});
  }
}
