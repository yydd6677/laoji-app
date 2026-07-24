import type {
  ProcessingStage,
  ScopeKey,
  UploadStatus,
} from '../../domain/meeting';
import {
  assertProcessingStage,
  assertScopeKey,
  secureClientIdFactory,
  transitionProcessingStage,
  type ClientIdFactory,
} from '../../domain/meeting';
import type {
  MeetingNoteAggregate,
  MeetingNoteRepository,
  RecordingAssetRecord,
} from '../../data/repositories';

export interface MeetingAudioUploadEvidence {
  status: UploadStatus;
  nativeSessionId?: string | null;
  localUri?: string | null;
  mimeType?: string | null;
  fileName?: string | null;
  attemptCount: number;
  operationId?: string | null;
  credentialGeneration?: number | null;
  errorCode?: string | null;
  retryable?: boolean;
  nextRetryAtMs?: number | null;
}

export interface ReconcileMeetingAudioUploadInput {
  meetingId: string;
  scopeKey: ScopeKey;
  evidence: MeetingAudioUploadEvidence;
  canonicalWrite?: boolean;
}

export interface ReconcileMeetingAudioUploadResult {
  aggregate: MeetingNoteAggregate;
  changed: boolean;
  canonicalRevision: number | null;
}

export interface ReconcileMeetingAudioUploadDependencies {
  repository: MeetingNoteRepository;
  idFactory?: ClientIdFactory;
  now?: () => number;
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

function optionalTimestamp(value: number | null | undefined, field: string): number | null {
  if (value === null || value === undefined) return null;
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${field} is invalid`);
  return value;
}

function assertAttemptCount(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error('meeting upload attempt count is invalid');
  }
}

function generationFingerprint(generation: number | null): string | null {
  if (generation === null) return null;
  if (!Number.isSafeInteger(generation) || generation < 0) {
    throw new Error('meeting upload credential generation is invalid');
  }
  return `credential-generation:${generation}`;
}

function assetMatches(left: RecordingAssetRecord | null, right: RecordingAssetRecord): boolean {
  if (!left) return false;
  return left.id === right.id
    && left.meetingId === right.meetingId
    && left.role === right.role
    && left.origin === right.origin
    && left.nativeSessionId === right.nativeSessionId
    && left.localUri === right.localUri
    && left.remoteAssetId === right.remoteAssetId
    && left.mimeType === right.mimeType
    && left.fileName === right.fileName
    && left.byteSize === right.byteSize
    && left.durationMs === right.durationMs
    && left.checksumSha256 === right.checksumSha256
    && left.waveformJson === right.waveformJson
    && left.localState === right.localState
    && left.lastVerifiedAtMs === right.lastVerifiedAtMs;
}

function stageMatches(left: ProcessingStage, right: ProcessingStage): boolean {
  return left.meetingId === right.meetingId
    && left.stage === right.stage
    && left.status === right.status
    && left.attemptCount === right.attemptCount
    && left.progress === right.progress
    && left.jobId === right.jobId
    && left.inputFingerprint === right.inputFingerprint
    && left.errorCode === right.errorCode
    && left.userMessageKey === right.userMessageKey
    && left.retryable === right.retryable
    && left.nextRetryAtMs === right.nextRetryAtMs;
}

function uploadMessageKey(status: UploadStatus): string | null {
  if (status === 'failed_retryable') return 'meeting.upload.retryable';
  if (status === 'blocked') return 'meeting.upload.blocked';
  return null;
}

export class ReconcileMeetingAudioUploadUseCase {
  private readonly repository: MeetingNoteRepository;
  private readonly idFactory: ClientIdFactory;
  private readonly now: () => number;

  constructor(dependencies: ReconcileMeetingAudioUploadDependencies) {
    this.repository = dependencies.repository;
    this.idFactory = dependencies.idFactory ?? secureClientIdFactory;
    this.now = dependencies.now ?? Date.now;
  }

  async execute(input: ReconcileMeetingAudioUploadInput): Promise<ReconcileMeetingAudioUploadResult> {
    assertScopeKey(input.scopeKey);
    if (input.scopeKey === 'guest') {
      throw new Error('guest meeting audio does not require upload reconciliation');
    }
    const meetingId = input.meetingId.trim();
    if (!meetingId) throw new Error('meeting ID is invalid');
    assertAttemptCount(input.evidence.attemptCount);

    const operationId = optionalText(input.evidence.operationId, 2_000, 'meeting upload operation ID');
    const nativeSessionId = optionalText(
      input.evidence.nativeSessionId,
      512,
      'recording native session ID',
    );
    const localUri = optionalText(input.evidence.localUri, 16_384, 'recording local URI');
    const mimeType = optionalText(input.evidence.mimeType, 512, 'recording MIME type');
    const fileName = optionalText(input.evidence.fileName, 2_000, 'recording file name');
    const errorCode = optionalText(input.evidence.errorCode, 512, 'meeting upload error code');
    const nextRetryAtMs = optionalTimestamp(
      input.evidence.nextRetryAtMs,
      'meeting upload retry time',
    );
    const inputFingerprint = generationFingerprint(input.evidence.credentialGeneration ?? null);
    let changed = false;
    let canonicalRevision: number | null = null;

    await this.repository.transaction(async transaction => {
      const meeting = await transaction.getMeeting(meetingId, input.scopeKey);
      if (!meeting) throw new Error('meeting does not exist in active scope');
      if (meeting.lifecycle === 'deleted') throw new Error('deleted meeting cannot accept upload work');
      const currentUpload = await transaction.getStage(meetingId, input.scopeKey, 'upload');
      if (!currentUpload) throw new Error('meeting upload processing stage is missing');
      const existingAsset = await transaction.getPrimaryRecording(meetingId, input.scopeKey);
      if (!existingAsset && !localUri && input.evidence.status !== 'uploaded') {
        throw new Error('meeting upload requires a local recording asset');
      }
      if (
        existingAsset?.nativeSessionId
        && nativeSessionId
        && existingAsset.nativeSessionId !== nativeSessionId
      ) {
        throw new Error('meeting upload recording identity is inconsistent');
      }
      if (
        existingAsset?.localUri
        && localUri
        && existingAsset.localUri !== localUri
        && currentUpload.jobId === operationId
      ) {
        throw new Error('meeting upload local asset changed within one operation');
      }

      const clockMs = this.now();
      if (!Number.isSafeInteger(clockMs) || clockMs < 0) throw new Error('meeting clock is invalid');
      const updatedAtMs = Math.max(
        clockMs,
        meeting.updatedAtMs,
        currentUpload.updatedAtMs,
        existingAsset?.updatedAtMs ?? 0,
      );
      const terminalForSameOperation = currentUpload.status === 'uploaded'
        && input.evidence.status !== 'uploaded'
        && (!operationId || operationId === currentUpload.jobId);
      const effectiveStatus = terminalForSameOperation ? 'uploaded' : input.evidence.status;
      const effectiveOperationId = terminalForSameOperation
        ? currentUpload.jobId
        : operationId ?? currentUpload.jobId;
      const effectiveFingerprint = terminalForSameOperation
        ? currentUpload.inputFingerprint
        : inputFingerprint ?? currentUpload.inputFingerprint;
      const failed = effectiveStatus === 'failed_retryable' || effectiveStatus === 'blocked';
      const transitioned = transitionProcessingStage(currentUpload, {
        stage: 'upload',
        status: effectiveStatus,
        progress: effectiveStatus === 'uploaded' ? 1 : null,
        jobId: effectiveOperationId,
        inputFingerprint: effectiveFingerprint,
        errorCode: failed ? errorCode ?? currentUpload.errorCode ?? 'upload_failed' : null,
        userMessageKey: failed ? uploadMessageKey(effectiveStatus) : null,
        retryable: effectiveStatus === 'failed_retryable'
          ? input.evidence.retryable ?? true
          : false,
        nextRetryAtMs: effectiveStatus === 'failed_retryable' ? nextRetryAtMs : null,
      }, updatedAtMs);
      const nextUpload: ProcessingStage = {
        ...transitioned,
        attemptCount: terminalForSameOperation
          ? currentUpload.attemptCount
          : Math.max(currentUpload.attemptCount, input.evidence.attemptCount),
      };
      assertProcessingStage(nextUpload);

      const effectiveLocalUri = localUri ?? existingAsset?.localUri ?? null;
      const localFileMissing = effectiveStatus === 'blocked' && errorCode === 'file_missing';
      const nextAsset: RecordingAssetRecord = {
        id: existingAsset?.id ?? this.idFactory.create(),
        meetingId,
        role: 'primary',
        origin: existingAsset?.origin ?? 'captured',
        nativeSessionId: nativeSessionId ?? existingAsset?.nativeSessionId ?? null,
        localUri: effectiveLocalUri,
        remoteAssetId: existingAsset?.remoteAssetId ?? null,
        mimeType: mimeType ?? existingAsset?.mimeType ?? null,
        fileName: fileName ?? existingAsset?.fileName ?? null,
        byteSize: existingAsset?.byteSize ?? null,
        durationMs: existingAsset?.durationMs ?? null,
        checksumSha256: existingAsset?.checksumSha256 ?? null,
        waveformJson: existingAsset?.waveformJson ?? null,
        localState: localFileMissing
          ? 'missing'
          : effectiveLocalUri
            ? 'local_ready'
            : 'remote_only',
        createdAtMs: existingAsset?.createdAtMs ?? updatedAtMs,
        updatedAtMs,
        lastVerifiedAtMs: localFileMissing
          ? updatedAtMs
          : existingAsset?.lastVerifiedAtMs ?? null,
      };

      const uploadChanged = !stageMatches(currentUpload, nextUpload);
      const recordingChanged = !assetMatches(existingAsset, nextAsset);
      changed = uploadChanged || recordingChanged;
      if (!changed) return;
      if (recordingChanged) await transaction.saveRecordingAsset(nextAsset, input.scopeKey);
      if (uploadChanged) await transaction.upsertStage(nextUpload, input.scopeKey);
      await transaction.updateMeeting(meetingId, input.scopeKey, { updatedAtMs });
      if (input.canonicalWrite) {
        canonicalRevision = await transaction.advanceCanonicalWrite(input.scopeKey, updatedAtMs);
      }
    });

    const aggregate = await this.repository.get(meetingId, input.scopeKey);
    if (!aggregate) throw new Error('meeting upload reconciliation lost aggregate');
    return { aggregate, changed, canonicalRevision };
  }
}
