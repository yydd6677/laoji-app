import {
  acknowledgeIngestedMeetingMedia,
  hasNativeMeetingMediaImport,
  ingestMeetingMedia,
  type IngestedMeetingMedia,
} from 'laoji-native-platform';
import type { MeetingNoteRepository, MeetingRecordingMergeTaskRecord, RecordingAssetRecord } from "../../data/repositories/meetingNoteRepository";
import { sqliteMeetingNoteRepository } from "../../data/repositories/sqliteMeetingNoteRepository";
import { canonicalRecordingSourceSha256 } from "../../data/repositories/meetingNoteRepository";
import type { ScopeKey } from '../../domain/meeting';
import { assertScopeKey } from '../../domain/meeting';

const MAXIMUM_RECORDING_MERGE_BYTES = 2 * 1024 * 1024 * 1024;

export interface MeetingRecordingMergeRecoveryState {
  targetMeetingId: string;
  tasks: readonly MeetingRecordingMergeTaskRecord[];
  readyCount: number;
  waitingCount: number;
  failedCount: number;
  blockedCount: number;
}

export interface MergeDetachedMeetingRecordingsResult extends MeetingRecordingMergeRecoveryState {
  completedCount: number;
}

type MergeFailure = {
  code: string;
  retryable: boolean;
};

function errorCode(reason: unknown): string {
  if (!reason || typeof reason !== 'object') return '';
  const code = (reason as { code?: unknown }).code;
  return typeof code === 'string' ? code.trim() : '';
}

function classifyMergeFailure(reason: unknown): MergeFailure {
  switch (errorCode(reason)) {
    case 'ERR_MEDIA_IMPORT_UNAVAILABLE':
      return { code: 'native_copy_unavailable', retryable: false };
    case 'ERR_MEDIA_IMPORT_UNSUPPORTED_TYPE':
      return { code: 'source_format_unsupported', retryable: false };
    case 'ERR_MEDIA_IMPORT_EMPTY':
      return { code: 'source_empty', retryable: false };
    case 'ERR_MEDIA_IMPORT_TOO_LARGE':
      return { code: 'source_too_large', retryable: false };
    case 'ERR_MEDIA_IMPORT_UNREADABLE':
    case 'ERR_MEDIA_IMPORT_CHANGED':
      return { code: 'source_unreadable', retryable: true };
    case 'ERR_MEDIA_IMPORT_NO_SPACE':
      return { code: 'insufficient_storage', retryable: true };
    case 'ERR_MEDIA_IMPORT_IDENTITY_CONFLICT':
      return { code: 'copy_identity_conflict', retryable: true };
    default:
      return { code: 'copy_failed', retryable: true };
  }
}

function sourceAssetForTask(
  task: MeetingRecordingMergeTaskRecord,
  assets: readonly RecordingAssetRecord[],
): RecordingAssetRecord | null {
  return assets.find(asset => asset.id === task.sourceRecordingAssetId) ?? null;
}

function sourceIsWaiting(asset: RecordingAssetRecord | null): boolean {
  return Boolean(asset && (
    asset.localState === 'capturing'
    || asset.localState === 'ingesting'
  ));
}

async function sourceAsset(
  task: MeetingRecordingMergeTaskRecord,
  repository: MeetingNoteRepository,
): Promise<RecordingAssetRecord | null> {
  const aggregate = await repository.get(task.sourceMeetingId, task.scopeKey);
  if (!aggregate || aggregate.note.lifecycle === 'deleted') return null;
  return sourceAssetForTask(task, aggregate.recordingAssets);
}

async function completePreparedMerge(
  scopeKey: ScopeKey,
  task: MeetingRecordingMergeTaskRecord,
  media: IngestedMeetingMedia,
  repository: MeetingNoteRepository,
  now: () => number,
): Promise<boolean> {
  if (
    media.origin !== 'recording_merge'
    || media.meetingId !== task.targetMeetingId
    || media.assetId !== task.targetRecordingAssetId
  ) throw new Error('recording merge media identity is invalid');
  const source = await sourceAsset(task, repository);
  if (!source || source.localState !== 'local_ready' || !source.localUri) {
    throw new Error('recording merge source is not ready');
  }
  const clock = now();
  if (!Number.isSafeInteger(clock) || clock < 0) throw new Error('recording merge clock is invalid');
  const completedAtMs = Math.max(clock, task.updatedAtMs + 1, source.updatedAtMs + 1);
  return repository.completeMeetingRecordingMergeTask({
    taskId: task.id,
    targetMeetingId: task.targetMeetingId,
    scopeKey,
    recordingAsset: {
      id: task.targetRecordingAssetId,
      meetingId: task.targetMeetingId,
      assetGeneration: task.targetAssetGeneration,
      role: 'secondary',
      origin: 'recovered',
      nativeSessionId: null,
      localUri: media.localUri,
      remoteAssetId: null,
      mimeType: media.mimeType,
      fileName: media.fileName,
      byteSize: media.byteSize,
      durationMs: media.durationMs,
      checksumSha256: media.checksumSha256,
      sourceSha256: canonicalRecordingSourceSha256(media.checksumSha256),
      waveformJson: source.waveformJson,
      localState: 'local_ready',
      uploadOperationId: null,
      remoteObjectRevision: null,
      createdAtMs: completedAtMs,
      updatedAtMs: completedAtMs,
      lastVerifiedAtMs: completedAtMs,
    },
    completedAtMs,
  });
}

export async function recoverPreparedMeetingRecordingMerge(
  scopeKey: ScopeKey,
  media: IngestedMeetingMedia,
  repository: MeetingNoteRepository = sqliteMeetingNoteRepository,
  now: () => number = Date.now,
): Promise<boolean> {
  assertScopeKey(scopeKey);
  if (media.origin !== 'recording_merge') return false;
  const tasks = await repository.listMeetingRecordingMergeTasks(media.meetingId, scopeKey);
  const task = tasks.find(item => item.targetRecordingAssetId === media.assetId);
  if (!task) return false;
  if (task.status === 'completed') return true;
  return completePreparedMerge(scopeKey, task, media, repository, now);
}

export async function loadMeetingRecordingMergeRecovery(
  scopeKey: ScopeKey,
  targetMeetingId: string,
  repository: MeetingNoteRepository = sqliteMeetingNoteRepository,
): Promise<MeetingRecordingMergeRecoveryState> {
  assertScopeKey(scopeKey);
  const tasks = await repository.listMeetingRecordingMergeTasks(targetMeetingId, scopeKey);
  let readyCount = 0;
  let waitingCount = 0;
  let failedCount = 0;
  let blockedCount = 0;
  for (const task of tasks) {
    if (task.status === 'completed') continue;
    const source = await sourceAsset(task, repository);
    if (task.status === 'failed' && task.retryable) failedCount += 1;
    else if (source?.localState === 'local_ready' && Boolean(source.localUri)) readyCount += 1;
    else if (sourceIsWaiting(source)) waitingCount += 1;
    else blockedCount += 1;
  }
  return {
    targetMeetingId,
    tasks,
    readyCount,
    waitingCount,
    failedCount,
    blockedCount,
  };
}

export class MergeDetachedMeetingRecordingsUseCase {
  constructor(
    private readonly repository: MeetingNoteRepository = sqliteMeetingNoteRepository,
    private readonly now: () => number = Date.now,
  ) {}

  async execute(
    scopeKey: ScopeKey,
    targetMeetingId: string,
  ): Promise<MergeDetachedMeetingRecordingsResult> {
    assertScopeKey(scopeKey);
    if (!targetMeetingId.trim()) throw new Error('recording merge target meeting ID is invalid');
    const tasks = await this.repository.listMeetingRecordingMergeTasks(targetMeetingId, scopeKey);
    let completedCount = 0;
    for (const task of tasks) {
      if (task.status === 'completed' || (task.status === 'failed' && !task.retryable)) continue;
      const source = await sourceAsset(task, this.repository);
      if (sourceIsWaiting(source)) continue;
      if (!source || source.localState !== 'local_ready' || !source.localUri) {
        await this.repository.failMeetingRecordingMergeTask({
          taskId: task.id,
          targetMeetingId,
          scopeKey,
          errorCode: 'source_unavailable',
          retryable: false,
          failedAtMs: Math.max(this.now(), task.updatedAtMs + 1),
        });
        continue;
      }
      try {
        if (!hasNativeMeetingMediaImport()) {
          const unavailable = new Error('native media import is unavailable') as Error & { code?: string };
          unavailable.code = 'ERR_MEDIA_IMPORT_UNAVAILABLE';
          throw unavailable;
        }
        const media = await ingestMeetingMedia({
          sourceUri: source.localUri,
          meetingId: task.targetMeetingId,
          assetId: task.targetRecordingAssetId,
          origin: 'recording_merge',
          maximumBytes: MAXIMUM_RECORDING_MERGE_BYTES,
        });
        const completed = await completePreparedMerge(
          scopeKey,
          task,
          media,
          this.repository,
          this.now,
        );
        if (completed) {
          completedCount += 1;
          await acknowledgeIngestedMeetingMedia(media.meetingId, media.assetId).catch(() => false);
        }
      } catch (reason) {
        const failure = classifyMergeFailure(reason);
        await this.repository.failMeetingRecordingMergeTask({
          taskId: task.id,
          targetMeetingId,
          scopeKey,
          errorCode: failure.code,
          retryable: failure.retryable,
          failedAtMs: Math.max(this.now(), task.updatedAtMs + 1),
        });
      }
    }
    return {
      ...(await loadMeetingRecordingMergeRecovery(scopeKey, targetMeetingId, this.repository)),
      completedCount,
    };
  }
}

const defaultUseCase = new MergeDetachedMeetingRecordingsUseCase();

export function mergeDetachedMeetingRecordings(
  scopeKey: ScopeKey,
  targetMeetingId: string,
): Promise<MergeDetachedMeetingRecordingsResult> {
  return defaultUseCase.execute(scopeKey, targetMeetingId);
}
