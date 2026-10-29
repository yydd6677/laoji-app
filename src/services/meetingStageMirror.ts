import type { ScopeKey, TranscriptStatus } from '../domain/meeting';
import { transitionProcessingStage } from '../domain/meeting';
import { sqliteMeetingNoteRepository } from "../data/repositories/sqliteMeetingNoteRepository";
import { diagnosticAudit, diagnosticWarn } from './diagnostics';

export type MeetingTranscriptFailureKind = 'persistence' | 'sync' | 'remote_processing' | 'no_speech';

export async function mirrorDeviceTranscriptTaskProgress(
  scopeKey: ScopeKey,
  legacyMeetingId: string,
  phase: 'queued' | 'running',
  taskId: string,
): Promise<boolean> {
  let changed = false;
  try {
    const aggregate = await sqliteMeetingNoteRepository.findByNativeSessionId(
      legacyMeetingId,
      scopeKey,
    );
    if (!aggregate || aggregate.note.lifecycle === 'deleted') return false;
    await sqliteMeetingNoteRepository.transaction(async transaction => {
      const note = await transaction.getMeeting(aggregate.note.id, scopeKey);
      if (!note || note.lifecycle === 'deleted') return;
      const stage = await transaction.getStage(note.id, scopeKey, 'transcript');
      if (!stage) throw new Error('meeting transcript processing stage is missing');
      const status: TranscriptStatus = phase === 'running' ? 'finalizing' : 'queued';
      if (stage.status === status && stage.jobId === taskId) return;
      const nowMs = Math.max(Date.now(), note.updatedAtMs, stage.updatedAtMs);
      await transaction.upsertStage(transitionProcessingStage(stage, {
        stage: 'transcript',
        status,
        attemptStarted: stage.jobId !== taskId,
        progress: null,
        jobId: taskId,
      }, nowMs), scopeKey);
      await transaction.updateMeeting(note.id, scopeKey, { updatedAtMs: nowMs });
      changed = true;
    });
    if (changed) {
      diagnosticAudit('meeting_transcript_task_projection', {
        status: phase,
        scope: 'guest',
      });
    }
    return changed;
  } catch (error) {
    diagnosticWarn('[meeting-db] transcript task projection failed', error);
    return false;
  }
}

/**
 * Close the canonical transcript stage from the content that is actually
 * readable on the device.  A terminal remote task must never be projected
 * back through `running`: doing so creates a second, fallible write between
 * the final transcript and the list status, leaving a permanent spinner when
 * that later write is interrupted.
 */
export async function mirrorDeviceTranscriptTaskTerminal(
  scopeKey: ScopeKey,
  legacyMeetingId: string,
  outcome: 'text' | 'no_speech',
): Promise<boolean> {
  let changed = false;
  try {
    const aggregate = await sqliteMeetingNoteRepository.findByNativeSessionId(
      legacyMeetingId,
      scopeKey,
    );
    if (!aggregate || aggregate.note.lifecycle === 'deleted') return false;
    await sqliteMeetingNoteRepository.transaction(async transaction => {
      const note = await transaction.getMeeting(aggregate.note.id, scopeKey);
      if (!note || note.lifecycle === 'deleted') return;
      const stage = await transaction.getStage(note.id, scopeKey, 'transcript');
      if (!stage) throw new Error('meeting transcript processing stage is missing');
      if (outcome === 'text') {
        const active = await transaction.getActiveTranscriptRevision(note.id, scopeKey);
        if (!active || active.kind === 'realtime_draft' || active.status !== 'ready') {
          throw new Error('terminal transcript task has no readable final revision');
        }
      }
      const status: TranscriptStatus = outcome === 'text' ? 'ready' : 'no_speech';
      if (stage.status === status && stage.jobId === null) return;
      const nowMs = Math.max(Date.now(), note.updatedAtMs, stage.updatedAtMs);
      await transaction.upsertStage(transitionProcessingStage(stage, {
        stage: 'transcript',
        status,
        progress: outcome === 'text' ? 1 : null,
        jobId: null,
      }, nowMs), scopeKey);
      await transaction.updateMeeting(note.id, scopeKey, { updatedAtMs: nowMs });
      await transaction.advanceCanonicalWrite(scopeKey, nowMs);
      changed = true;
    });
    if (changed) {
      diagnosticAudit('meeting_transcript_task_terminal_projection', {
        outcome,
        scope: 'guest',
      });
    }
    return changed;
  } catch (error) {
    diagnosticWarn('[meeting-db] terminal transcript task projection failed', error);
    throw error;
  }
}

function transcriptProcessingFailureCode(
  kind: MeetingTranscriptFailureKind,
  reason: unknown,
): string {
  if (kind === 'no_speech') return 'transcript_no_speech';
  if (kind === 'remote_processing') return 'transcript_remote_processing_failed';
  const message = reason instanceof Error
    ? `${reason.name} ${reason.message}`.toLowerCase()
    : '';
  if (kind === 'persistence') {
    if (/recording asset does not belong|录音.*不属于/.test(message)) {
      return 'transcript_recording_asset_missing';
    }
    if (/recording asset.*identity|录音.*身份/.test(message)) {
      return 'transcript_recording_asset_identity_changed';
    }
    if (/processing stage is missing|处理阶段.*缺失/.test(message)) {
      return 'transcript_stage_missing';
    }
    if (/does not accept transcript|会议记录已不存在/.test(message)) {
      return 'transcript_meeting_unavailable';
    }
    if (/本机升级/.test(message)) return 'transcript_canonical_projection_missing';
    if (/本机数据状态异常/.test(message)) return 'transcript_canonical_reload_failed';
    if (/保存后的数据不完整/.test(message)) return 'transcript_canonical_projection_incomplete';
    if (/clock is invalid|时钟/.test(message)) return 'transcript_clock_invalid';
    if (/transaction did not evaluate|事务.*未完成/.test(message)) {
      return 'transcript_transaction_incomplete';
    }
    if (/storage|disk|space|quota|full|存储|磁盘|空间/.test(message)) {
      return 'transcript_local_storage_unavailable';
    }
    if (/foreign key.*constraint/.test(message)) return 'transcript_database_foreign_key';
    if (/unique.*transcript_revisions\.meeting_id.*remote_id/.test(message)) {
      return 'transcript_remote_revision_duplicate';
    }
    if (/unique.*transcript_revisions\.meeting_id/.test(message)) {
      return 'transcript_active_revision_duplicate';
    }
    if (/unique.*transcript_segments\.revision_id.*source_segment_id/.test(message)) {
      return 'transcript_source_segment_duplicate';
    }
    if (/unique.*transcript_segments\.revision_id.*ordinal/.test(message)) {
      return 'transcript_segment_ordinal_duplicate';
    }
    if (/unique.*transcript_segments\.id/.test(message)) {
      return 'transcript_segment_id_duplicate';
    }
    if (/unique.*transcript_revisions\.id/.test(message)) {
      return 'transcript_revision_id_duplicate';
    }
    if (/unique.*constraint/.test(message)) return 'transcript_database_unique';
    if (/not null.*constraint/.test(message)) return 'transcript_database_not_null';
    if (/constraint|约束/.test(message)) return 'transcript_database_constraint';
    if (/database is locked|database is busy|locked|busy|锁定/.test(message)) {
      return 'transcript_database_busy';
    }
    if (/cannot start.*transaction|no transaction is active/.test(message)) {
      return 'transcript_database_transaction_state';
    }
    if (/sqlite/.test(message)) return 'transcript_sqlite_write_failed';
    if (/database|transaction|数据库|事务/.test(message)) return 'transcript_database_write_failed';
    if (/scope|account|session|作用域|账号|会话/.test(message)) return 'transcript_scope_changed';
    return 'transcript_persistence_failed';
  }
  if (/timed out|timeout|超时/.test(message)) return 'transcript_sync_timeout';
  return 'transcript_sync_failed';
}

export async function recordTranscriptProcessingFailure(
  scopeKey: ScopeKey,
  legacyMeetingId: string,
  kind: MeetingTranscriptFailureKind,
  reason: unknown,
): Promise<void> {
  let outcome = 'meeting_unavailable';
  try {
    const aggregate = await sqliteMeetingNoteRepository.findByNativeSessionId(
      legacyMeetingId,
      scopeKey,
    );
    if (!aggregate || aggregate.note.lifecycle === 'deleted') return;
    await sqliteMeetingNoteRepository.transaction(async transaction => {
      const note = await transaction.getMeeting(aggregate.note.id, scopeKey);
      if (!note || note.lifecycle === 'deleted') return;
      const active = await transaction.getActiveTranscriptRevision(note.id, scopeKey);
      if (active && active.kind !== 'realtime_draft' && active.status === 'ready') {
        outcome = 'preserved_ready';
        return;
      }
      const stage = await transaction.getStage(note.id, scopeKey, 'transcript');
      if (!stage) throw new Error('meeting transcript processing stage is missing');
      const nowMs = Math.max(Date.now(), note.updatedAtMs, stage.updatedAtMs);
      const noSpeech = kind === 'no_speech';
      await transaction.upsertStage(transitionProcessingStage(stage, {
        stage: 'transcript',
        status: noSpeech ? 'no_speech' : 'failed_retryable',
        attemptStarted: true,
        progress: null,
        errorCode: transcriptProcessingFailureCode(kind, reason),
        userMessageKey: noSpeech ? 'meeting.transcript.no_speech' : 'meeting.transcript.retryable',
        retryable: !noSpeech,
        nextRetryAtMs: null,
      }, nowMs), scopeKey);
      await transaction.updateMeeting(note.id, scopeKey, { updatedAtMs: nowMs });
      outcome = noSpeech ? 'no_speech' : 'failed_retryable';
    });
    diagnosticAudit('meeting_transcript_processing_failure', {
      status: outcome,
      failure_kind: kind,
      scope: 'guest',
      error_code: transcriptProcessingFailureCode(kind, reason),
    });
  } catch (error) {
    diagnosticWarn('[meeting-db] transcript failure write failed', error);
    diagnosticAudit('meeting_transcript_processing_failure', {
      status: 'write_failed',
      failure_kind: kind,
      scope: 'guest',
      error_code: error instanceof Error ? error.name : 'UnknownError',
    });
  }
}
