import type { IngestedMeetingMedia } from 'laoji-native-platform';
import {
  assertScopeKey,
  transitionProcessingStage,
  type ScopeKey,
} from '../../domain/meeting';
import type {
  MeetingNoteAggregate,
  MeetingNoteRepository,
  RecordingAssetRecord,
} from '../../data/repositories';

export type AttachImportedMeetingMediaErrorCode =
  | 'ERR_MEDIA_IMPORT_TARGET_UNAVAILABLE'
  | 'ERR_MEDIA_IMPORT_TARGET_BUSY'
  | 'ERR_MEDIA_IMPORT_TARGET_CONFLICT';

export class AttachImportedMeetingMediaError extends Error {
  readonly code: AttachImportedMeetingMediaErrorCode;

  constructor(code: AttachImportedMeetingMediaErrorCode, message: string) {
    super(message);
    this.name = 'AttachImportedMeetingMediaError';
    this.code = code;
  }
}

export interface AttachImportedMeetingMediaInput {
  targetMeetingId: string;
  scopeKey: ScopeKey;
  media: IngestedMeetingMedia;
  canonicalWrite?: boolean;
}

export interface AttachImportedMeetingMediaResult {
  aggregate: MeetingNoteAggregate;
  attached: boolean;
  canonicalRevision: number | null;
}

export interface AttachImportedMeetingMediaDependencies {
  repository: MeetingNoteRepository;
  now?: () => number;
}

const ACTIVE_CAPTURE_STATUSES = new Set([
  'preparing',
  'recording',
  'paused',
  'finalizing',
]);

function requiredIdentity(value: string, field: string): string {
  const normalized = value.trim();
  if (
    !normalized
    || normalized.length > 512
    || /[\u0000-\u001f\u007f]/.test(normalized)
  ) throw new Error(`${field} is invalid`);
  return normalized;
}

function requiredText(value: string, maximum: number, field: string): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > maximum || /\u0000/.test(normalized)) {
    throw new Error(`${field} is invalid`);
  }
  return normalized;
}

function nonNegativeInteger(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${field} is invalid`);
  return value;
}

function sameImportedAsset(
  current: RecordingAssetRecord,
  media: IngestedMeetingMedia,
): boolean {
  return current.origin === 'imported'
    && current.localUri === media.localUri.trim()
    && current.mimeType === media.mimeType.trim().toLowerCase()
    && current.fileName === media.fileName.trim()
    && current.byteSize === media.byteSize
    && current.durationMs === media.durationMs
    && current.checksumSha256?.toLowerCase() === media.checksumSha256.trim().toLowerCase()
    && current.localState === 'local_ready';
}

export class AttachImportedMeetingMediaUseCase {
  private readonly repository: MeetingNoteRepository;
  private readonly now: () => number;

  constructor(dependencies: AttachImportedMeetingMediaDependencies) {
    this.repository = dependencies.repository;
    this.now = dependencies.now ?? Date.now;
  }

  async execute(input: AttachImportedMeetingMediaInput): Promise<AttachImportedMeetingMediaResult> {
    assertScopeKey(input.scopeKey);
    const targetMeetingId = requiredIdentity(input.targetMeetingId, 'target meeting ID');
    const assetId = requiredIdentity(input.media.assetId, 'recording asset ID');
    if (input.media.origin !== 'file_import' && input.media.origin !== 'share_intent') {
      throw new Error('imported recording origin is invalid');
    }
    const localUri = requiredText(input.media.localUri, 16_384, 'recording local URI');
    const mimeType = requiredText(input.media.mimeType, 512, 'recording MIME type').toLowerCase();
    const fileName = requiredText(input.media.fileName, 2_000, 'recording file name');
    const byteSize = nonNegativeInteger(input.media.byteSize, 'recording byte size');
    const durationMs = nonNegativeInteger(input.media.durationMs, 'recording duration');
    const checksumSha256 = input.media.checksumSha256.trim().toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(checksumSha256)) {
      throw new Error('recording checksum is invalid');
    }

    let attached = false;
    let canonicalRevision: number | null = null;

    await this.repository.transaction(async transaction => {
      const meeting = await transaction.getMeeting(targetMeetingId, input.scopeKey);
      if (!meeting || meeting.lifecycle === 'deleted') {
        throw new AttachImportedMeetingMediaError(
          'ERR_MEDIA_IMPORT_TARGET_UNAVAILABLE',
          'target meeting is unavailable',
        );
      }
      const [capture, upload, summary, currentAsset, primary] = await Promise.all([
        transaction.getStage(targetMeetingId, input.scopeKey, 'capture'),
        transaction.getStage(targetMeetingId, input.scopeKey, 'upload'),
        transaction.getStage(targetMeetingId, input.scopeKey, 'summary'),
        transaction.getRecordingAsset(targetMeetingId, assetId, input.scopeKey),
        transaction.getPrimaryRecording(targetMeetingId, input.scopeKey),
      ]);
      if (!capture || !upload || !summary) {
        throw new AttachImportedMeetingMediaError(
          'ERR_MEDIA_IMPORT_TARGET_UNAVAILABLE',
          'target meeting processing state is incomplete',
        );
      }
      if (ACTIVE_CAPTURE_STATUSES.has(capture.status)) {
        throw new AttachImportedMeetingMediaError(
          'ERR_MEDIA_IMPORT_TARGET_BUSY',
          'target meeting is recording',
        );
      }
      if (currentAsset) {
        if (!sameImportedAsset(currentAsset, input.media)) {
          throw new AttachImportedMeetingMediaError(
            'ERR_MEDIA_IMPORT_TARGET_CONFLICT',
            'recording asset identity conflicts with existing content',
          );
        }
        return;
      }

      const clockMs = this.now();
      if (!Number.isSafeInteger(clockMs) || clockMs < 0) throw new Error('meeting clock is invalid');
      const updatedAtMs = Math.max(
        clockMs,
        meeting.updatedAtMs,
        capture.updatedAtMs,
        upload.updatedAtMs,
        summary.updatedAtMs,
      );
      try {
        await transaction.saveRecordingAsset({
          id: assetId,
          meetingId: targetMeetingId,
          role: primary ? 'secondary' : 'primary',
          origin: 'imported',
          nativeSessionId: null,
          localUri,
          remoteAssetId: null,
          mimeType,
          fileName,
          byteSize,
          durationMs,
          checksumSha256,
          waveformJson: null,
          localState: 'local_ready',
          createdAtMs: updatedAtMs,
          updatedAtMs,
          lastVerifiedAtMs: updatedAtMs,
        }, input.scopeKey);
      } catch (error) {
        throw new AttachImportedMeetingMediaError(
          'ERR_MEDIA_IMPORT_TARGET_CONFLICT',
          error instanceof Error ? error.message : 'recording asset cannot be attached',
        );
      }

      if (!primary && capture.status !== 'local_ready') {
        await transaction.upsertStage(transitionProcessingStage(capture, {
          stage: 'capture',
          status: 'local_ready',
          progress: 1,
          jobId: null,
          inputFingerprint: null,
        }, updatedAtMs), input.scopeKey);
      }
      if (input.scopeKey === 'guest') {
        if (upload.status !== 'not_required') {
          await transaction.upsertStage(transitionProcessingStage(upload, {
            stage: 'upload',
            status: 'not_required',
            progress: null,
            jobId: null,
            inputFingerprint: null,
          }, updatedAtMs), input.scopeKey);
        }
      } else if (upload.status === 'not_required' || upload.status === 'uploaded') {
        await transaction.upsertStage(transitionProcessingStage(upload, {
          stage: 'upload',
          status: 'queued',
          progress: null,
          jobId: null,
          inputFingerprint: null,
        }, updatedAtMs), input.scopeKey);
      }

      const summaryBecameStale = await transaction.markCurrentSummaryStale(
        targetMeetingId,
        input.scopeKey,
      );
      if (summaryBecameStale && summary.status === 'ready') {
        await transaction.upsertStage(transitionProcessingStage(summary, {
          stage: 'summary',
          status: 'stale',
          progress: null,
          jobId: null,
          inputFingerprint: null,
        }, updatedAtMs), input.scopeKey);
      }

      await transaction.updateMeeting(targetMeetingId, input.scopeKey, {
        ...(primary ? {} : {
          lifecycle: 'ended',
          endedAtMs: meeting.endedAtMs ?? updatedAtMs,
        }),
        updatedAtMs,
      });
      if (input.canonicalWrite) {
        canonicalRevision = await transaction.advanceCanonicalWrite(input.scopeKey, updatedAtMs);
      }
      attached = true;
    });

    const aggregate = await this.repository.get(targetMeetingId, input.scopeKey);
    if (!aggregate || aggregate.note.lifecycle === 'deleted') {
      throw new AttachImportedMeetingMediaError(
        'ERR_MEDIA_IMPORT_TARGET_UNAVAILABLE',
        'target meeting disappeared after import',
      );
    }
    return { aggregate, attached, canonicalRevision };
  }
}
