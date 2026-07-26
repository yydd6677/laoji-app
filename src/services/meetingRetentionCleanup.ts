import * as FileSystem from 'expo-file-system/legacy';
import type { ScopeKey } from '../domain/meeting';
import {
  sqliteMeetingNoteRepository,
  type MeetingRetentionCleanupJob,
} from '../data/repositories';
import { deleteNativeMeetingArtifacts } from '../native/nativeTransferCoordinator';
import { deletePendingMeetingAudioUpload } from './meetingRecording';
import { clearPendingMeetingSummaryTask } from './meetingSummaryTasks';
import { clearPendingMeetingTranscriptCompletion } from './meetingTranscriptCompletionTasks';
import { deleteMeetingPlaybackCache } from './meetingPlaybackCache';
import { deleteMeetingAttachmentFiles } from './meetingAttachmentStorage';
import { cancelMeetingActionNotificationsForMeeting } from './notifications';
import { diagnosticAudit, diagnosticWarn } from './diagnostics';

const DAY_MS = 24 * 60 * 60 * 1_000;
const CLEANUP_BATCH = 20;

function appPrivateRoots(): readonly string[] {
  return [FileSystem.documentDirectory, FileSystem.cacheDirectory]
    .filter((value): value is string => Boolean(value));
}

async function deleteRecordedLocalUri(uri: string): Promise<void> {
  if (!uri.startsWith('file://') || uri.includes('..')) return;
  if (!appPrivateRoots().some(root => uri.startsWith(root))) return;
  await FileSystem.deleteAsync(uri, { idempotent: true });
}

async function deleteJobArtifacts(job: MeetingRetentionCleanupJob): Promise<void> {
  const cleanup = await Promise.allSettled([
    deletePendingMeetingAudioUpload(job.scopeKey, job.navigationMeetingId),
    clearPendingMeetingTranscriptCompletion(job.scopeKey, job.navigationMeetingId),
    clearPendingMeetingSummaryTask(job.scopeKey, job.navigationMeetingId),
    deleteNativeMeetingArtifacts(job.scopeKey, job.navigationMeetingId),
    deleteMeetingPlaybackCache(job.navigationMeetingId),
    deleteMeetingAttachmentFiles(job.navigationMeetingId),
    cancelMeetingActionNotificationsForMeeting(job.scopeKey, job.navigationMeetingId),
    ...job.localUris.map(deleteRecordedLocalUri),
  ]);
  const failed = cleanup.filter(result => result.status === 'rejected');
  if (failed.length > 0) {
    throw new Error(`meeting retention artifact cleanup failed: ${failed.length}`);
  }
}

export interface MeetingRetentionCleanupResult {
  queued: number;
  completed: number;
  failed: number;
  remaining: number;
}

export async function drainMeetingRetentionCleanup(
  scopeKey: ScopeKey,
): Promise<Omit<MeetingRetentionCleanupResult, 'queued'>> {
  let completed = 0;
  let failed = 0;
  const jobs = await sqliteMeetingNoteRepository.listMeetingRetentionCleanupJobs(
    scopeKey,
    CLEANUP_BATCH,
  );
  for (const job of jobs) {
    try {
      await deleteJobArtifacts(job);
      if (await sqliteMeetingNoteRepository.completeMeetingRetentionCleanupJob(job.id, scopeKey)) {
        completed += 1;
      }
    } catch (reason) {
      failed += 1;
      await sqliteMeetingNoteRepository.failMeetingRetentionCleanupJob(
        job.id,
        scopeKey,
        'artifact_cleanup_failed',
        Date.now(),
      ).catch(() => false);
      diagnosticWarn('[meeting-retention] artifact cleanup failed', reason);
    }
  }
  const remaining = (await sqliteMeetingNoteRepository.listMeetingRetentionCleanupJobs(
    scopeKey,
    1,
  )).length;
  return { completed, failed, remaining };
}

export async function runMeetingRetentionCleanup(input: {
  scopeKey: ScopeKey;
  retentionDays: number;
  nowMs?: number;
}): Promise<MeetingRetentionCleanupResult> {
  if (
    !Number.isSafeInteger(input.retentionDays)
    || input.retentionDays < 1
    || input.retentionDays > 3_650
  ) throw new Error('回收站保留期限无效');
  const nowMs = input.nowMs ?? Date.now();
  if (!Number.isSafeInteger(nowMs) || nowMs < 0) throw new Error('回收站时间无效');
  const retentionMs = input.retentionDays * DAY_MS;
  const expiresBeforeMs = Math.max(0, nowMs - retentionMs);
  const queued = await sqliteMeetingNoteRepository.queueExpiredMeetingRetentionCleanup({
    scopeKey: input.scopeKey,
    expiresBeforeMs,
    queuedAtMs: nowMs,
    limit: CLEANUP_BATCH,
  });
  const drained = await drainMeetingRetentionCleanup(input.scopeKey);
  diagnosticAudit('meeting_retention_cleanup', {
    queued: queued.length,
    completed: drained.completed,
    failed: drained.failed,
    remaining: drained.remaining,
  });
  return { queued: queued.length, ...drained };
}
