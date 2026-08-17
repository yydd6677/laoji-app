import type { Meeting } from '../types';
import type { CaptureStatus, MeetingEntryPoint, ScopeKey } from '../domain/meeting';
import {
  createInitialProcessingStages,
  createSecureAssetGeneration,
  secureClientIdFactory,
  transitionProcessingStage,
} from '../domain/meeting';
import { getFeatureFlags } from '../config/featureFlags';
import {
  canonicalRecordingSourceSha256,
  sqliteMeetingNoteRepository,
} from '../data/repositories';
import { diagnosticAudit, diagnosticWarn } from './diagnostics';
import type { CalendarMeetingContext } from './occurrenceMeeting';

function legacyCaptureStatus(meeting: Meeting, hasAsset: boolean): CaptureStatus | null {
  const status = meeting.status?.toLowerCase();
  if (status === 'recording') return 'recording';
  if (status === 'paused') return 'paused';
  if (status === 'processing') return hasAsset || meeting.audioAvailable ? 'local_ready' : 'finalizing';
  if (['completed', 'ended', 'done', 'processed'].includes(status ?? '')) return 'local_ready';
  if (status === 'failed') return hasAsset || meeting.audioAvailable ? 'local_ready' : 'failed_recoverable';
  if (status === 'created') return 'not_started';
  return null;
}

function legacyLifecycle(meeting: Meeting): 'draft' | 'active' | 'ended' | 'deleted' {
  const status = meeting.status?.toLowerCase();
  if (status === 'deleted') return 'deleted';
  if (['recording', 'paused', 'processing'].includes(status ?? '')) return 'active';
  if (['completed', 'ended', 'done', 'processed', 'failed'].includes(status ?? '')) return 'ended';
  return 'draft';
}

function timestamp(value: string | undefined, fallback: number): number {
  const parsed = value ? Date.parse(value) : Number.NaN;
  return Number.isFinite(parsed) ? Math.max(0, Math.trunc(parsed)) : fallback;
}

function normalizedParticipants(meeting: Meeting): readonly string[] {
  if (!Array.isArray(meeting.participants)) return [];
  return meeting.participants
    .filter((value): value is string => typeof value === 'string')
    .map(value => value.trim())
    .filter(Boolean);
}

function normalizedLocation(meeting: Meeting): string | null {
  return typeof meeting.location === 'string' ? meeting.location.trim() || null : null;
}

function normalizedClientRequestId(meeting: Meeting): string | null {
  return typeof meeting.clientRequestId === 'string' ? meeting.clientRequestId.trim() || null : null;
}

function legacyLocalId(scopeKey: ScopeKey, legacyMeetingId: string): string {
  return `legacy:${encodeURIComponent(scopeKey)}:${encodeURIComponent(legacyMeetingId)}`;
}

export async function mirrorLegacyMeetingCreated(
  scopeKey: ScopeKey,
  meeting: Meeting,
  calendarContext?: CalendarMeetingContext,
  entryPoint?: MeetingEntryPoint,
): Promise<void> {
  if (!getFeatureFlags().localMeetingDbV1) return;
  try {
    const existing = await sqliteMeetingNoteRepository.findByNativeSessionId(meeting.id, scopeKey);
    if (!existing) {
      const nowMs = Date.now();
      const createdAtMs = timestamp(meeting.createdAt, nowMs);
      const updatedAtMs = timestamp(meeting.updatedAt, createdAtMs);
      const lifecycle = legacyLifecycle(meeting);
      const localId = legacyLocalId(scopeKey, meeting.id);
      await sqliteMeetingNoteRepository.transaction(async transaction => {
        if (await transaction.getMeeting(localId, scopeKey)) return;
        await transaction.insertMeeting({
          id: localId,
          scopeKey,
          remoteId: meeting.source === 'cloud' ? meeting.id : null,
          legacySourceId: meeting.id,
          origin: calendarContext ? 'calendar' : 'ad_hoc',
          entryPoint: entryPoint ?? (calendarContext ? 'calendar_detail' : 'legacy_store'),
          title: meeting.title ?? '',
          description: meeting.description ?? null,
          participants: normalizedParticipants(meeting),
          location: normalizedLocation(meeting),
          mode: meeting.mode ?? null,
          clientRequestId: normalizedClientRequestId(meeting),
          recordedAtMs: timestamp(meeting.createdAt, createdAtMs),
          lifecycle,
          startedAtMs: createdAtMs,
          endedAtMs: lifecycle === 'ended' ? updatedAtMs : null,
          syncState: meeting.source === 'cloud' ? 'synced' : 'local',
          createdAtMs,
        });
        await transaction.saveManualNote({
          meetingId: localId,
          content: '',
          revision: 0,
          baseRemoteRevision: null,
          dirty: false,
          lastSavedAtMs: updatedAtMs,
          userEditedAtMs: null,
        }, scopeKey);
        for (const processingStage of createInitialProcessingStages(localId, scopeKey, updatedAtMs)) {
          await transaction.upsertStage(processingStage, scopeKey);
        }
        if (calendarContext) {
          await transaction.bindOccurrence({
            meetingId: localId,
            scopeKey,
            ...calendarContext.occurrence,
            calendarRevision: calendarContext.snapshot.capturedEventRevision,
            recurrenceSegmentId: calendarContext.recurrenceSegmentId,
            seriesKey: calendarContext.seriesKey,
            linkedAtMs: calendarContext.snapshot.capturedAtMs,
          }, calendarContext.snapshot);
        }
        if (updatedAtMs !== createdAtMs) {
          await transaction.updateMeeting(localId, scopeKey, { updatedAtMs });
        }
      });
    }
    await mirrorLegacyMeetingStageState(scopeKey, meeting);
    diagnosticAudit('meeting_create_shadow_write', {
      status: 'completed',
      scope: scopeKey === 'guest' ? 'guest' : 'account',
    });
  } catch (error) {
    diagnosticWarn('[meeting-db] create shadow write failed', error);
    diagnosticAudit('meeting_create_shadow_write', {
      status: 'failed',
      scope: scopeKey === 'guest' ? 'guest' : 'account',
      error_code: error instanceof Error ? error.name : 'UnknownError',
    });
  }
}

export async function mirrorLegacyMeetingStageState(
  scopeKey: ScopeKey,
  legacyMeeting: Meeting,
): Promise<void> {
  if (!getFeatureFlags().localMeetingDbV1) return;
  try {
    const aggregate = await sqliteMeetingNoteRepository.findByNativeSessionId(legacyMeeting.id, scopeKey);
    if (!aggregate || aggregate.note.lifecycle === 'deleted') return;
    await sqliteMeetingNoteRepository.transaction(async transaction => {
      const note = await transaction.getMeeting(aggregate.note.id, scopeKey);
      if (!note || note.lifecycle === 'deleted') return;
      const nowMs = Math.max(Date.now(), note.updatedAtMs);
      let primary = await transaction.getPrimaryRecording(note.id, scopeKey);
      if (legacyMeeting.audioLocalUri || legacyMeeting.audioAvailable) {
        const durationMs = Number.isFinite(legacyMeeting.audioDurationSec)
          ? Math.max(0, Math.round(Number(legacyMeeting.audioDurationSec) * 1000))
          : primary?.durationMs ?? null;
        primary = {
          id: primary?.id ?? secureClientIdFactory.create(),
          meetingId: note.id,
          assetGeneration: primary?.assetGeneration ?? createSecureAssetGeneration(),
          role: 'primary',
          origin: primary?.origin ?? 'captured',
          nativeSessionId: primary?.nativeSessionId ?? legacyMeeting.id,
          localUri: legacyMeeting.audioLocalUri ?? primary?.localUri ?? null,
          remoteAssetId: primary?.remoteAssetId ?? null,
          mimeType: primary?.mimeType ?? 'audio/wav',
          fileName: primary?.fileName ?? null,
          byteSize: primary?.byteSize ?? null,
          durationMs,
          checksumSha256: primary?.checksumSha256 ?? null,
          sourceSha256: primary?.sourceSha256
            ?? canonicalRecordingSourceSha256(primary?.checksumSha256),
          waveformJson: legacyMeeting.audioBars?.length
            ? JSON.stringify(legacyMeeting.audioBars)
            : primary?.waveformJson ?? null,
          localState: legacyMeeting.audioLocalUri ? 'local_ready' : 'remote_only',
          uploadOperationId: primary?.uploadOperationId ?? null,
          remoteObjectRevision: primary?.remoteObjectRevision ?? null,
          createdAtMs: primary?.createdAtMs ?? nowMs,
          updatedAtMs: nowMs,
          lastVerifiedAtMs: legacyMeeting.audioLocalUri ? nowMs : primary?.lastVerifiedAtMs ?? null,
        };
        await transaction.saveRecordingAsset(primary, scopeKey);
      }

      const captureStatus = legacyCaptureStatus(legacyMeeting, Boolean(primary));
      if (captureStatus) {
        const current = await transaction.getStage(note.id, scopeKey, 'capture');
        if (!current) throw new Error('meeting capture processing stage is missing');
        await transaction.upsertStage(transitionProcessingStage(current, {
          stage: 'capture',
          status: captureStatus,
          progress: captureStatus === 'local_ready' ? 1 : null,
          ...(captureStatus === 'failed_recoverable' ? {
            errorCode: 'legacy_recording_failed',
            userMessageKey: 'meeting.capture.retryable',
            retryable: true,
          } : {}),
        }, Math.max(nowMs, current.updatedAtMs)), scopeKey);
      }

      const upload = await transaction.getStage(note.id, scopeKey, 'upload');
      if (!upload) throw new Error('meeting upload processing stage is missing');
      const preserveImportedLocalUpload = primary?.origin === 'imported'
        && primary.remoteAssetId === null;
      const uploadStatus = preserveImportedLocalUpload
        ? null
        : scopeKey === 'guest'
        ? 'not_required'
        : legacyMeeting.audioSyncBlocked
          ? 'blocked'
          : legacyMeeting.audioSyncPending
            ? 'queued'
            : legacyMeeting.audioAvailable
              ? 'uploaded'
              : null;
      if (uploadStatus) {
        await transaction.upsertStage(transitionProcessingStage(upload, {
          stage: 'upload',
          status: uploadStatus,
          progress: uploadStatus === 'uploaded' ? 1 : null,
          ...(uploadStatus === 'blocked' ? {
            errorCode: 'legacy_upload_blocked',
            userMessageKey: 'meeting.upload.blocked',
            retryable: false,
          } : {}),
        }, Math.max(nowMs, upload.updatedAtMs)), scopeKey);
      }

      if (legacyMeeting.hasTranscript || legacyMeeting.status === 'processing') {
        const transcript = await transaction.getStage(note.id, scopeKey, 'transcript');
        if (!transcript) throw new Error('meeting transcript processing stage is missing');
        const activeRevision = await transaction.getActiveTranscriptRevision(note.id, scopeKey);
        const activelyRecordingDraft = legacyMeeting.hasTranscript
          && (legacyMeeting.status === 'recording' || legacyMeeting.status === 'paused');
        const waitingForFinal = activeRevision?.kind === 'realtime_draft' && !activelyRecordingDraft;
        const stableFinalReady = Boolean(
          activeRevision
          && activeRevision.kind !== 'realtime_draft'
          && activeRevision.status === 'ready',
        );
        const transcriptStatus = activelyRecordingDraft
          ? 'realtime_draft'
          : waitingForFinal || !legacyMeeting.hasTranscript
            ? 'finalizing'
            : 'ready';
        if (transcript.status !== 'failed_retryable' || stableFinalReady || activelyRecordingDraft) {
          await transaction.upsertStage(transitionProcessingStage(transcript, {
            stage: 'transcript',
            status: transcriptStatus,
            progress: transcriptStatus === 'ready' ? 1 : null,
          }, Math.max(nowMs, transcript.updatedAtMs)), scopeKey);
        }
      }
      if (legacyMeeting.hasSummary) {
        const summary = await transaction.getStage(note.id, scopeKey, 'summary');
        if (!summary) throw new Error('meeting summary processing stage is missing');
        await transaction.upsertStage(transitionProcessingStage(summary, {
          stage: 'summary',
          status: 'ready',
          progress: 1,
        }, Math.max(nowMs, summary.updatedAtMs)), scopeKey);
      }

      const normalizedStatus = legacyMeeting.status?.toLowerCase();
      const lifecycle = ['recording', 'paused', 'processing'].includes(normalizedStatus ?? '')
        ? 'active'
        : ['completed', 'ended', 'done', 'processed', 'failed'].includes(normalizedStatus ?? '')
          ? 'ended'
          : note.lifecycle;
      await transaction.updateMeeting(note.id, scopeKey, {
        title: legacyMeeting.title ?? '',
        description: legacyMeeting.description ?? null,
        participants: normalizedParticipants(legacyMeeting),
        location: normalizedLocation(legacyMeeting),
        mode: legacyMeeting.mode ?? null,
        clientRequestId: normalizedClientRequestId(legacyMeeting),
        recordedAtMs: timestamp(
          legacyMeeting.createdAt,
          note.recordedAtMs ?? note.createdAtMs,
        ),
        lifecycle,
        ...(lifecycle === 'active' && note.startedAtMs === null ? { startedAtMs: nowMs } : {}),
        ...(lifecycle === 'ended' && note.endedAtMs === null ? { endedAtMs: nowMs } : {}),
        updatedAtMs: Math.max(
          note.updatedAtMs,
          timestamp(legacyMeeting.updatedAt, note.updatedAtMs),
        ),
      });
    });
    diagnosticAudit('meeting_stage_shadow_write', {
      status: 'completed',
      scope: scopeKey === 'guest' ? 'guest' : 'account',
    });
  } catch (error) {
    diagnosticWarn('[meeting-db] stage shadow write failed', error);
    diagnosticAudit('meeting_stage_shadow_write', {
      status: 'failed',
      scope: scopeKey === 'guest' ? 'guest' : 'account',
      error_code: error instanceof Error ? error.name : 'UnknownError',
    });
  }
}

export type MeetingTranscriptFailureKind = 'persistence' | 'sync' | 'remote_processing' | 'no_speech';

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

export async function mirrorLegacyTranscriptProcessingFailure(
  scopeKey: ScopeKey,
  legacyMeetingId: string,
  kind: MeetingTranscriptFailureKind,
  reason: unknown,
): Promise<void> {
  if (!getFeatureFlags().localMeetingDbV1) return;
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
      scope: scopeKey === 'guest' ? 'guest' : 'account',
      error_code: transcriptProcessingFailureCode(kind, reason),
    });
  } catch (error) {
    diagnosticWarn('[meeting-db] transcript failure shadow write failed', error);
    diagnosticAudit('meeting_transcript_processing_failure', {
      status: 'write_failed',
      failure_kind: kind,
      scope: scopeKey === 'guest' ? 'guest' : 'account',
      error_code: error instanceof Error ? error.name : 'UnknownError',
    });
  }
}

export function mirrorLegacyTranscriptSaveFailure(
  scopeKey: ScopeKey,
  legacyMeetingId: string,
  reason: unknown,
): Promise<void> {
  return mirrorLegacyTranscriptProcessingFailure(
    scopeKey,
    legacyMeetingId,
    'persistence',
    reason,
  );
}

export async function mirrorLegacyMeetingDeletion(scopeKey: ScopeKey, legacyMeetingId: string): Promise<void> {
  if (!getFeatureFlags().localMeetingDbV1) return;
  try {
    const aggregate = await sqliteMeetingNoteRepository.findByNativeSessionId(legacyMeetingId, scopeKey);
    if (!aggregate) return;
    const nowMs = Math.max(Date.now(), aggregate.note.updatedAtMs);
    await sqliteMeetingNoteRepository.transaction(transaction => transaction.updateMeeting(
      aggregate.note.id,
      scopeKey,
      {
        lifecycle: 'deleted',
        syncState: scopeKey === 'guest' ? 'deleted' : aggregate.note.syncState,
        deletedAtMs: nowMs,
        updatedAtMs: nowMs,
      },
    ));
    diagnosticAudit('meeting_delete_shadow_write', {
      status: 'completed',
      scope: scopeKey === 'guest' ? 'guest' : 'account',
    });
  } catch (error) {
    diagnosticWarn('[meeting-db] delete shadow write failed', error);
    diagnosticAudit('meeting_delete_shadow_write', {
      status: 'failed',
      scope: scopeKey === 'guest' ? 'guest' : 'account',
      error_code: error instanceof Error ? error.name : 'UnknownError',
    });
  }
}
