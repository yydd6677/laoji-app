import type { NativeMeetingUploadRegistration } from '../../native/nativeTransferCoordinator';
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
import { runAccountMeetingTranscriptCompletion } from '../../services/meetingTranscriptCompletionCoordinator';
import { savePendingMeetingTranscriptCompletion } from '../../services/meetingTranscriptCompletionTasks';
import { requestMeetingTranscriptCompletion } from './transcriptCompletionTrigger';

export interface FinalizeNativeMeetingRecordingInput {
  meetingId: string;
  remoteMeetingId: string | null;
  storageScope: string;
  scopeKey: ScopeKey | null;
  isGuest: boolean;
  accessToken?: string | null;
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
  uploadAudio: (meetingId: string, uri: string, accessToken: string) => Promise<unknown>;
  enqueuePersistentUpload?: (
    pending: PendingMeetingAudioUpload,
    accessToken: string,
  ) => Promise<NativeMeetingUploadRegistration | null>;
  updateStatus: (
    meetingId: string,
    status: string,
    patch: Partial<Meeting>,
    options?: { remoteSync?: 'wait' | 'background' },
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
      remoteMeetingId: input.remoteMeetingId,
      storageScope: input.storageScope,
      transcriptLines: input.getTranscriptLines(),
      getTranscriptLines: input.getTranscriptLines,
      isGuest: input.isGuest,
      accessToken: input.accessToken,
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
      uploadAudio: this.dependencies.uploadAudio,
      enqueuePersistentUpload: this.dependencies.enqueuePersistentUpload,
      updateStatus: this.dependencies.updateStatus,
      refreshMeetings: this.dependencies.refreshMeetings,
      reconcileUploads: this.dependencies.reconcileUploads,
    });
    const transcriptLines = input.getTranscriptLines();
    let transcriptCompletionTaskRegistered = false;
    if (
      !input.isGuest
      && input.scopeKey
      && input.scopeKey !== 'guest'
      && input.accessToken
      && input.remoteMeetingId
    ) {
      try {
        await savePendingMeetingTranscriptCompletion(
          input.storageScope,
          input.meetingId,
          input.remoteMeetingId,
        );
        transcriptCompletionTaskRegistered = true;
      } catch (reason) {
        diagnosticWarn('register transcript completion after local commit failed', reason);
      }
    }
    const transcriptCompletionTask = this.completeTranscript(
      input,
      transcriptLines,
      transcriptCompletionTaskRegistered,
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
    taskRegistered: boolean,
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
      const completion = !input.isGuest
        && input.scopeKey
        && input.scopeKey !== 'guest'
        && input.accessToken
        && input.remoteMeetingId
        ? await runAccountMeetingTranscriptCompletion({
            scopeKey: input.scopeKey,
            storageScope: input.storageScope,
            meetingId: input.meetingId,
            remoteMeetingId: input.remoteMeetingId,
            accessToken: input.accessToken,
            localLines,
            taskRegistered,
          }, completionDependencies)
        : await completeMeetingTranscriptAfterCapture({
            meetingId: input.meetingId,
            localLines,
            remote: this.remoteTranscriptIdentity(input),
          }, completionDependencies);
      if (completion.status !== 'ready' && input.scopeKey && input.scopeKey !== 'guest') {
        requestMeetingTranscriptCompletion(input.scopeKey);
      }
      return { status: completion.status, lines: completion.lines };
    } catch (reason) {
      diagnosticWarn('complete transcript after local recording commit failed', reason);
      await this.recordTranscriptFailure(input.scopeKey, input.meetingId, 'sync', reason);
      if (input.scopeKey && input.scopeKey !== 'guest') {
        requestMeetingTranscriptCompletion(input.scopeKey);
      }
      return { status: 'failed', lines: localLines };
    }
  }

  private remoteTranscriptIdentity(input: FinalizeNativeMeetingRecordingInput) {
    // Guest is the local device scope. It must never become an anonymous
    // HTTP transcript session; the durable device uploader is responsible for
    // the server-side completion after the local recording commit.
    if (input.isGuest) return null;
    return input.accessToken && input.remoteMeetingId
      ? {
          kind: 'account' as const,
          meetingId: input.remoteMeetingId,
          accessToken: input.accessToken,
        }
      : null;
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
