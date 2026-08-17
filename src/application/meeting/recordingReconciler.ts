import type { ClientIdFactory, ScopeKey } from '../../domain/meeting';
import {
  assertScopeKey,
  createSecureAssetGeneration,
  secureClientIdFactory,
  transitionProcessingStage,
} from '../../domain/meeting';
import type {
  MeetingNoteRepository,
  RecordingAssetRecord,
} from '../../data/repositories';
import { canonicalRecordingSourceSha256 } from '../../data/repositories';
import { CreateMeetingNoteUseCase } from './createMeetingNote';

export interface RecoveredMeetingRecording {
  sessionId: string;
  purpose: 'schedule' | 'meeting' | 'speaker';
  storageScope?: string | null;
  localUri: string;
  bytesRecorded: number;
  durationMs: number;
  recovered: boolean;
}

export interface MeetingRecordingRecoveryFailure {
  sessionId?: string | null;
  errorCode: string;
}

export interface MeetingRecordingRecoveryReport {
  recordings: readonly RecoveredMeetingRecording[];
  failures: readonly MeetingRecordingRecoveryFailure[];
}

export interface RecordingReconciliationResult {
  matched: number;
  recoveredMeetingsCreated: number;
  recordingAssetsUpdated: number;
  missingAssetsMarked: number;
  conflicts: number;
  ignoredOtherScopes: number;
  unresolvedFailures: number;
}

export interface RecordingReconcilerDependencies {
  repository: MeetingNoteRepository;
  idFactory?: ClientIdFactory;
  now?: () => number;
}

function safeNonNegativeInteger(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(Number.MAX_SAFE_INTEGER, Math.round(value)));
}

export class RecordingReconciler {
  private readonly repository: MeetingNoteRepository;
  private readonly createMeeting: CreateMeetingNoteUseCase;
  private readonly idFactory: ClientIdFactory;
  private readonly now: () => number;

  constructor(dependencies: RecordingReconcilerDependencies) {
    this.repository = dependencies.repository;
    this.idFactory = dependencies.idFactory ?? secureClientIdFactory;
    this.now = dependencies.now ?? Date.now;
    this.createMeeting = new CreateMeetingNoteUseCase({
      repository: dependencies.repository,
      idFactory: this.idFactory,
      now: this.now,
    });
  }

  async reconcile(
    scopeKey: ScopeKey,
    report: MeetingRecordingRecoveryReport,
  ): Promise<RecordingReconciliationResult> {
    assertScopeKey(scopeKey);
    const result: RecordingReconciliationResult = {
      matched: 0,
      recoveredMeetingsCreated: 0,
      recordingAssetsUpdated: 0,
      missingAssetsMarked: 0,
      conflicts: 0,
      ignoredOtherScopes: 0,
      unresolvedFailures: 0,
    };

    for (const recording of report.recordings) {
      if (recording.purpose !== 'meeting') continue;
      const sessionId = recording.sessionId.trim();
      const localUri = recording.localUri.trim();
      if (!sessionId || !localUri) continue;
      if (recording.storageScope && recording.storageScope !== scopeKey) {
        result.ignoredOtherScopes += 1;
        continue;
      }
      let aggregate = await this.repository.findByNativeSessionId(sessionId, scopeKey);
      if (!aggregate) {
        // Old journals did not contain a scope. They may belong to a signed-out or
        // different account scope, so an orphan can only be adopted when the
        // journal itself proves its owner.
        if (recording.storageScope !== scopeKey) {
          result.ignoredOtherScopes += 1;
          continue;
        }
        const endedAtMs = this.safeNow();
        const durationMs = safeNonNegativeInteger(recording.durationMs);
        const created = await this.createMeeting.execute({
          scopeKey,
          origin: 'ad_hoc',
          entryPoint: 'recorder_recovery',
          title: '',
          lifecycle: 'ended',
          startedAtMs: Math.max(0, endedAtMs - durationMs),
          endedAtMs,
          recordingAsset: {
            origin: 'recovered',
            nativeSessionId: sessionId,
            localUri,
            mimeType: 'audio/wav',
            byteSize: safeNonNegativeInteger(recording.bytesRecorded + 44),
            durationMs,
            localState: 'local_ready',
            lastVerifiedAtMs: endedAtMs,
          },
          initialStageStatuses: {
            capture: 'local_ready',
            upload: scopeKey === 'guest' ? 'not_required' : 'queued',
            transcript: 'none',
            summary: 'none',
            speaker: 'none',
          },
        });
        aggregate = created.aggregate;
        result.recoveredMeetingsCreated += created.created ? 1 : 0;
      }
      result.matched += 1;
      const update = await this.attachRecoveredRecording(
        scopeKey,
        aggregate.note.id,
        recording,
      );
      result.recordingAssetsUpdated += update === 'updated' ? 1 : 0;
      result.conflicts += update === 'conflict' ? 1 : 0;
    }

    for (const failure of report.failures) {
      const sessionId = failure.sessionId?.trim();
      if (!sessionId) {
        result.unresolvedFailures += 1;
        continue;
      }
      const aggregate = await this.repository.findByNativeSessionId(sessionId, scopeKey);
      if (!aggregate) {
        result.unresolvedFailures += 1;
        continue;
      }
      const marked = await this.markMissingRecording(
        scopeKey,
        aggregate.note.id,
        failure.errorCode,
      );
      result.missingAssetsMarked += marked ? 1 : 0;
    }
    return result;
  }

  private safeNow(): number {
    const value = this.now();
    if (!Number.isSafeInteger(value) || value < 0) throw new Error('meeting clock is invalid');
    return value;
  }

  private async attachRecoveredRecording(
    scopeKey: ScopeKey,
    meetingId: string,
    recording: RecoveredMeetingRecording,
  ): Promise<'updated' | 'unchanged' | 'conflict'> {
    let outcome: 'updated' | 'unchanged' | 'conflict' = 'unchanged';
    await this.repository.transaction(async transaction => {
      const note = await transaction.getMeeting(meetingId, scopeKey);
      if (!note || note.lifecycle === 'deleted') return;
      const nowMs = Math.max(this.safeNow(), note.updatedAtMs);
      const existing = await transaction.getPrimaryRecording(meetingId, scopeKey);
      const sessionId = recording.sessionId.trim();
      if (existing?.nativeSessionId && existing.nativeSessionId !== sessionId) {
        outcome = 'conflict';
        return;
      }
      const durationMs = safeNonNegativeInteger(recording.durationMs);
      const byteSize = safeNonNegativeInteger(recording.bytesRecorded + 44);
      const asset: RecordingAssetRecord = {
        id: existing?.id ?? this.idFactory.create(),
        meetingId,
        assetGeneration: existing?.assetGeneration ?? createSecureAssetGeneration(),
        role: 'primary',
        origin: existing?.origin ?? (recording.recovered ? 'recovered' : 'captured'),
        nativeSessionId: sessionId,
        localUri: recording.localUri.trim(),
        remoteAssetId: existing?.remoteAssetId ?? null,
        mimeType: existing?.mimeType ?? 'audio/wav',
        fileName: existing?.fileName ?? null,
        byteSize,
        durationMs,
        checksumSha256: existing?.checksumSha256 ?? null,
        sourceSha256: existing?.sourceSha256
          ?? canonicalRecordingSourceSha256(existing?.checksumSha256),
        waveformJson: existing?.waveformJson ?? null,
        localState: 'local_ready',
        uploadOperationId: existing?.uploadOperationId ?? null,
        remoteObjectRevision: existing?.remoteObjectRevision ?? null,
        createdAtMs: existing?.createdAtMs ?? nowMs,
        updatedAtMs: nowMs,
        lastVerifiedAtMs: nowMs,
      };
      await transaction.saveRecordingAsset(asset, scopeKey);

      const capture = await transaction.getStage(meetingId, scopeKey, 'capture');
      if (!capture) throw new Error('meeting capture processing stage is missing');
      await transaction.upsertStage(transitionProcessingStage(capture, {
        stage: 'capture',
        status: 'local_ready',
        progress: 1,
      }, Math.max(nowMs, capture.updatedAtMs)), scopeKey);
      const upload = await transaction.getStage(meetingId, scopeKey, 'upload');
      if (!upload) throw new Error('meeting upload processing stage is missing');
      if (upload.status !== 'uploaded') {
        await transaction.upsertStage(transitionProcessingStage(upload, {
          stage: 'upload',
          status: scopeKey === 'guest' ? 'not_required' : 'queued',
          progress: null,
        }, Math.max(nowMs, upload.updatedAtMs)), scopeKey);
      }
      await transaction.updateMeeting(meetingId, scopeKey, {
        lifecycle: 'ended',
        startedAtMs: note.startedAtMs ?? Math.max(0, nowMs - durationMs),
        endedAtMs: note.endedAtMs ?? nowMs,
        updatedAtMs: nowMs,
      });
      outcome = 'updated';
    });
    return outcome;
  }

  private async markMissingRecording(
    scopeKey: ScopeKey,
    meetingId: string,
    errorCode: string,
  ): Promise<boolean> {
    let changed = false;
    await this.repository.transaction(async transaction => {
      const note = await transaction.getMeeting(meetingId, scopeKey);
      if (!note || note.lifecycle === 'deleted') return;
      const asset = await transaction.getPrimaryRecording(meetingId, scopeKey);
      if (!asset || asset.remoteAssetId) return;
      const nowMs = Math.max(this.safeNow(), note.updatedAtMs, asset.updatedAtMs);
      await transaction.saveRecordingAsset({
        ...asset,
        localState: 'missing',
        updatedAtMs: nowMs,
        lastVerifiedAtMs: nowMs,
      }, scopeKey);
      const capture = await transaction.getStage(meetingId, scopeKey, 'capture');
      if (!capture) throw new Error('meeting capture processing stage is missing');
      await transaction.upsertStage(transitionProcessingStage(capture, {
        stage: 'capture',
        status: 'failed_recoverable',
        errorCode: errorCode.trim() || 'recovery_failed',
        userMessageKey: 'meeting.capture.recovery_failed',
        retryable: true,
      }, Math.max(nowMs, capture.updatedAtMs)), scopeKey);
      await transaction.updateMeeting(meetingId, scopeKey, { updatedAtMs: nowMs });
      changed = true;
    });
    return changed;
  }
}
