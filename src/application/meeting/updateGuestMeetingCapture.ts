import type {
  CaptureStatus,
  ProcessingStageTransition,
  ScopeKey,
  TranscriptStatus,
} from '../../domain/meeting';
import {
  assertScopeKey,
  secureClientIdFactory,
  transitionProcessingStage,
  type ClientIdFactory,
} from '../../domain/meeting';
import type {
  MeetingNoteAggregate,
  MeetingNoteRepository,
  RecordingAssetLocalState,
  RecordingAssetRecord,
} from '../../data/repositories';
import type { MeetingRootSyncOperation } from './updateMeetingNote';

type CaptureTransition = Extract<ProcessingStageTransition, { stage: 'capture' }>;
type TranscriptTransition = Extract<ProcessingStageTransition, { stage: 'transcript' }>;
type UploadTransition = Extract<ProcessingStageTransition, { stage: 'upload' }>;

export interface GuestRecordingAssetPatch {
  nativeSessionId?: string | null;
  localUri?: string | null;
  mimeType?: string | null;
  fileName?: string | null;
  byteSize?: number | null;
  durationMs?: number | null;
  checksumSha256?: string | null;
  waveformJson?: string | null;
  localState: RecordingAssetLocalState;
  lastVerifiedAtMs?: number | null;
}

export interface UpdateMeetingCaptureInput {
  meetingId: string;
  scopeKey?: ScopeKey;
  capture: CaptureTransition;
  transcript?: TranscriptTransition | null;
  recordingAsset?: GuestRecordingAssetPatch | null;
  remoteStatus?: string | null;
  syncOperation?: MeetingRootSyncOperation | null;
  canonicalWrite?: boolean;
}

export type UpdateGuestMeetingCaptureInput = UpdateMeetingCaptureInput;

export interface UpdateMeetingCaptureResult {
  aggregate: MeetingNoteAggregate;
  applied: boolean;
  canonicalRevision: number | null;
}

export type UpdateGuestMeetingCaptureResult = UpdateMeetingCaptureResult;

export interface UpdateMeetingCaptureDependencies {
  repository: MeetingNoteRepository;
  idFactory?: ClientIdFactory;
  now?: () => number;
}

export type UpdateGuestMeetingCaptureDependencies = UpdateMeetingCaptureDependencies;

const ACTIVE_CAPTURE_STATUSES = new Set<CaptureStatus>([
  'preparing',
  'recording',
  'paused',
  'finalizing',
]);
const FAILED_CAPTURE_STATUSES = new Set<CaptureStatus>([
  'failed_recoverable',
  'failed_terminal',
]);
const RECORDING_LOCAL_STATES = new Set<RecordingAssetLocalState>([
  'capturing',
  'ingesting',
  'local_ready',
  'remote_only',
  'missing',
]);

function hasOwn<T extends object>(value: T, key: PropertyKey): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function optionalTimestamp(value: number | null | undefined, field: string): number | null {
  if (value === null || value === undefined) return null;
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${field} is invalid`);
  return value;
}

function optionalText(value: string | null | undefined, maximum: number, field: string): string | null {
  if (value === null || value === undefined) return null;
  const normalized = value.trim();
  if (!normalized) return null;
  if (normalized.length > maximum || /[\u0000-\u001f\u007f]/.test(normalized)) {
    throw new Error(`${field} is invalid`);
  }
  return normalized;
}

function captureProgress(status: CaptureStatus): number | null {
  return status === 'local_ready' ? 1 : null;
}

function guestUploadTransition(): UploadTransition {
  return {
    stage: 'upload',
    status: 'not_required',
    progress: null,
  };
}

function lifecyclePatch(
  status: CaptureStatus,
  startedAtMs: number | null,
  endedAtMs: number | null,
  updatedAtMs: number,
): {
  lifecycle: 'draft' | 'active' | 'ended';
  startedAtMs?: number | null;
  endedAtMs?: number | null;
} {
  if (status === 'not_started') {
    return {
      lifecycle: 'draft',
      startedAtMs: null,
      endedAtMs: null,
    };
  }
  if (ACTIVE_CAPTURE_STATUSES.has(status)) {
    return {
      lifecycle: 'active',
      startedAtMs: startedAtMs ?? (status === 'recording' ? updatedAtMs : null),
      endedAtMs: null,
    };
  }
  if (status === 'local_ready' || FAILED_CAPTURE_STATUSES.has(status)) {
    return {
      lifecycle: 'ended',
      endedAtMs: endedAtMs ?? updatedAtMs,
    };
  }
  throw new Error('meeting capture status is unsupported');
}

function transcriptProgress(status: TranscriptStatus): number | null {
  return status === 'ready' ? 1 : null;
}

export class UpdateGuestMeetingCaptureUseCase {
  private readonly repository: MeetingNoteRepository;
  private readonly idFactory: ClientIdFactory;
  private readonly now: () => number;

  constructor(dependencies: UpdateMeetingCaptureDependencies) {
    this.repository = dependencies.repository;
    this.idFactory = dependencies.idFactory ?? secureClientIdFactory;
    this.now = dependencies.now ?? Date.now;
  }

  async execute(input: UpdateMeetingCaptureInput): Promise<UpdateMeetingCaptureResult> {
    const meetingId = input.meetingId.trim();
    if (!meetingId) throw new Error('meeting ID is invalid');
    const scopeKey = input.scopeKey ?? 'guest';
    assertScopeKey(scopeKey);
    const remoteStatus = input.remoteStatus?.trim() || null;
    const operationId = input.syncOperation?.operationId.trim() || '';
    const operationType = input.syncOperation?.operationType.trim() || '';
    if (scopeKey !== 'guest') {
      if (!remoteStatus || remoteStatus.length > 160 || /[\u0000-\u001f\u007f]/.test(remoteStatus)) {
        throw new Error('account meeting status is invalid');
      }
      if (!operationId || operationType !== 'meeting.update') {
        throw new Error('account meeting capture update requires an atomic sync operation');
      }
    }
    let canonicalRevision: number | null = null;
    let applied = false;

    await this.repository.transaction(async transaction => {
      const meeting = await transaction.getMeeting(meetingId, scopeKey);
      if (!meeting) throw new Error('meeting does not exist in active scope');
      if (meeting.lifecycle === 'deleted') throw new Error('deleted meeting cannot accept recording work');
      const capture = await transaction.getStage(meetingId, scopeKey, 'capture');
      const upload = await transaction.getStage(meetingId, scopeKey, 'upload');
      if (!capture || !upload) throw new Error('meeting recording stages are incomplete');

      const clockMs = this.now();
      if (!Number.isSafeInteger(clockMs) || clockMs < 0) throw new Error('meeting clock is invalid');
      let updatedAtMs = Math.max(clockMs, meeting.updatedAtMs, capture.updatedAtMs, upload.updatedAtMs);
      const currentTranscript = input.transcript
        ? await transaction.getStage(meetingId, scopeKey, 'transcript')
        : null;
      if (input.transcript && !currentTranscript) {
        throw new Error('meeting transcript processing stage is missing');
      }
      if (currentTranscript) {
        updatedAtMs = Math.max(updatedAtMs, currentTranscript.updatedAtMs);
      }

      if (scopeKey !== 'guest') {
        const inserted = await transaction.insertOutbox({
          operationId,
          scopeKey,
          aggregateType: 'meeting_note',
          aggregateId: meetingId,
          operationType: 'meeting.update',
          baseRevision: meeting.remoteRevision,
          payloadJson: JSON.stringify({
            schema_version: 1,
            meeting_id: meetingId,
            base_revision: meeting.remoteRevision,
            changes: { status: remoteStatus },
          }),
          createdAtMs: updatedAtMs,
        });
        if (!inserted) return;
      }

      if (input.transcript && currentTranscript) {
        const activeRevision = input.transcript.status === 'ready'
          ? await transaction.getActiveTranscriptRevision(meetingId, scopeKey)
          : null;
        const transition: TranscriptTransition = activeRevision?.kind === 'realtime_draft'
          ? { ...input.transcript, status: 'finalizing', progress: null }
          : input.transcript;
        await transaction.upsertStage(transitionProcessingStage(currentTranscript, {
          ...transition,
          progress: transition.progress ?? transcriptProgress(transition.status),
        }, updatedAtMs), scopeKey);
      }

      await transaction.upsertStage(transitionProcessingStage(capture, {
        ...input.capture,
        progress: input.capture.progress ?? captureProgress(input.capture.status),
      }, updatedAtMs), scopeKey);
      if (scopeKey === 'guest') {
        await transaction.upsertStage(transitionProcessingStage(
          upload,
          guestUploadTransition(),
          updatedAtMs,
        ), scopeKey);
      } else if (
        input.recordingAsset?.localState === 'local_ready'
        && upload.status === 'not_required'
      ) {
        await transaction.upsertStage(transitionProcessingStage(upload, {
          stage: 'upload',
          status: 'queued',
          progress: null,
        }, updatedAtMs), scopeKey);
      }

      if (input.recordingAsset) {
        const patch = input.recordingAsset;
        if (!RECORDING_LOCAL_STATES.has(patch.localState)) {
          throw new Error('recording asset state is invalid');
        }
        const existing = await transaction.getPrimaryRecording(meetingId, scopeKey);
        const localUri = hasOwn(patch, 'localUri')
          ? optionalText(patch.localUri, 16_384, 'recording local URI')
          : existing?.localUri ?? null;
        const nativeSessionId = hasOwn(patch, 'nativeSessionId')
          ? optionalText(patch.nativeSessionId, 512, 'recording native session ID')
          : existing?.nativeSessionId ?? null;
        const durationMs = hasOwn(patch, 'durationMs')
          ? optionalTimestamp(patch.durationMs, 'recording duration')
          : existing?.durationMs ?? null;
        const byteSize = hasOwn(patch, 'byteSize')
          ? optionalTimestamp(patch.byteSize, 'recording size')
          : existing?.byteSize ?? null;
        const lastVerifiedAtMs = hasOwn(patch, 'lastVerifiedAtMs')
          ? optionalTimestamp(patch.lastVerifiedAtMs, 'recording verification time')
          : existing?.lastVerifiedAtMs ?? null;
        if (patch.localState === 'local_ready' && !localUri) {
          throw new Error('local recording asset requires a URI');
        }
        const recordingAsset: RecordingAssetRecord = {
          id: existing?.id ?? this.idFactory.create(),
          meetingId,
          role: 'primary',
          origin: existing?.origin ?? 'captured',
          nativeSessionId,
          localUri,
          remoteAssetId: existing?.remoteAssetId ?? null,
          mimeType: hasOwn(patch, 'mimeType')
            ? optionalText(patch.mimeType, 512, 'recording MIME type')
            : existing?.mimeType ?? null,
          fileName: hasOwn(patch, 'fileName')
            ? optionalText(patch.fileName, 2_000, 'recording file name')
            : existing?.fileName ?? null,
          byteSize,
          durationMs,
          checksumSha256: hasOwn(patch, 'checksumSha256')
            ? optionalText(patch.checksumSha256, 512, 'recording checksum')
            : existing?.checksumSha256 ?? null,
          waveformJson: hasOwn(patch, 'waveformJson')
            ? patch.waveformJson ?? null
            : existing?.waveformJson ?? null,
          localState: patch.localState,
          createdAtMs: existing?.createdAtMs ?? updatedAtMs,
          updatedAtMs,
          lastVerifiedAtMs,
        };
        await transaction.saveRecordingAsset(recordingAsset, scopeKey);
        await transaction.enrichTranscriptRecordingProvenance(
          meetingId,
          recordingAsset.id,
          scopeKey,
        );
      }

      if (input.canonicalWrite) {
        canonicalRevision = await transaction.advanceCanonicalWrite(scopeKey, updatedAtMs);
      }
      await transaction.updateMeeting(meetingId, scopeKey, {
        ...lifecyclePatch(
          input.capture.status,
          meeting.startedAtMs,
          meeting.endedAtMs,
          updatedAtMs,
        ),
        syncState: scopeKey === 'guest' ? 'local' : 'pending',
        updatedAtMs,
      });
      applied = true;
    });

    const aggregate = await this.repository.get(meetingId, scopeKey);
    if (!aggregate) throw new Error('meeting recording transaction lost aggregate');
    return { aggregate, applied, canonicalRevision };
  }
}

export { UpdateGuestMeetingCaptureUseCase as UpdateMeetingCaptureUseCase };
