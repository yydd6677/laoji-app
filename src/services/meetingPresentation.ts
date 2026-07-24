import type { Meeting } from '../types';
import {
  deriveMeetingPresentationState,
  meetingPresentationStateFromLabel,
  type CaptureStatus,
  type MeetingPresentationState,
  type MeetingProcessingStatuses,
} from '../domain/meeting';

export interface LegacyMeetingPresentationOptions {
  captureOverride?: CaptureStatus;
}

function hasTag(meeting: Meeting, label: string): boolean {
  return meeting.tags.some(tag => tag.label === label);
}

function legacyCaptureStatus(
  meeting: Meeting,
  override?: CaptureStatus,
): CaptureStatus {
  if (override) return override;
  const status = meeting.status?.trim().toLowerCase() ?? 'created';
  if (status === 'preparing') return 'preparing';
  if (status === 'recording') return 'recording';
  if (status === 'paused') return 'paused';
  if (status === 'stopping' || status === 'saving') return 'finalizing';
  if (status === 'failed') {
    return meeting.audioAvailable || Boolean(meeting.audioLocalUri)
      ? 'local_ready'
      : 'failed_recoverable';
  }
  if (status === 'processing') {
    return meeting.audioAvailable || Boolean(meeting.audioLocalUri)
      ? 'local_ready'
      : 'finalizing';
  }
  if (['completed', 'ended', 'done', 'processed'].includes(status)) return 'local_ready';
  return 'not_started';
}

export function legacyMeetingProcessingStatuses(
  meeting: Meeting,
  options: LegacyMeetingPresentationOptions = {},
): MeetingProcessingStatuses {
  const status = meeting.status?.trim().toLowerCase() ?? 'created';
  const capture = legacyCaptureStatus(meeting, options.captureOverride);
  const uploadBlocked = Boolean(meeting.audioSyncBlocked) || hasTag(meeting, '上传受阻');
  const uploadPending = Boolean(meeting.audioSyncPending) || hasTag(meeting, '待上传');
  const transcriptReady = Boolean(meeting.hasTranscript);
  const summaryReady = Boolean(meeting.hasSummary);
  return {
    capture,
    upload: uploadBlocked
      ? 'blocked'
      : uploadPending
        ? 'queued'
        : meeting.source === 'cloud' && meeting.audioAvailable
          ? 'uploaded'
          : 'not_required',
    transcript: transcriptReady
      ? (capture === 'recording' || capture === 'paused' ? 'realtime_draft' : 'ready')
      : status === 'processing' && capture === 'local_ready'
        ? 'finalizing'
        : status === 'failed' && capture === 'local_ready'
          ? 'failed_retryable'
          : ['completed', 'ended', 'done', 'processed'].includes(status)
            ? 'unavailable'
            : 'none',
    summary: summaryReady
      ? 'ready'
      : status === 'processing' && transcriptReady
        ? 'generating'
        : status === 'failed' && transcriptReady
          ? 'failed_retryable'
          : 'none',
    speaker: 'none',
  };
}

/**
 * Compatibility projection for the old Meeting DTO. Canonical readers put the
 * domain-derived label first; legacy-only rows are reconstructed from their
 * coarse status and explicit upload/content flags.
 */
export function deriveLegacyMeetingPresentationState(
  meeting: Meeting,
  options: LegacyMeetingPresentationOptions = {},
): MeetingPresentationState {
  if (!options.captureOverride) {
    const canonicalProjection = meetingPresentationStateFromLabel(meeting.tags[0]?.label ?? '');
    if (canonicalProjection) return canonicalProjection;
  }
  return deriveMeetingPresentationState(legacyMeetingProcessingStatuses(meeting, options));
}
