import {
  getMeetingManualNoteV2,
  loadMeetingCapabilities,
} from '../data/api/v2';
import { sqliteMeetingNoteRepository } from '../data/repositories';
import type { ScopeKey } from '../domain/meeting';
import { diagnosticAudit } from './diagnostics';

export interface PullMeetingManualNoteInput {
  scopeKey: ScopeKey;
  meetingId: string;
  meetingRemoteId: string;
  accessToken: string;
  signal?: AbortSignal;
}

export interface PullMeetingManualNoteResult {
  outcome: 'updated' | 'attached' | 'conflicted' | 'unchanged' | 'ignored_stale' | 'disabled' | 'stale';
  canonicalMeetingId: string | null;
}

export async function pullMeetingManualNote(
  input: PullMeetingManualNoteInput,
): Promise<PullMeetingManualNoteResult> {
  if (input.scopeKey === 'guest' || !input.accessToken || input.signal?.aborted) {
    return { outcome: 'stale', canonicalMeetingId: null };
  }
  const aggregate = await sqliteMeetingNoteRepository.findByNativeSessionId(
    input.meetingId,
    input.scopeKey,
  );
  if (!aggregate || aggregate.note.lifecycle === 'deleted') {
    return { outcome: 'stale', canonicalMeetingId: null };
  }
  if (aggregate.note.remoteId !== input.meetingRemoteId) {
    throw new Error('笔记拉取会议身份已变化');
  }
  const capability = await loadMeetingCapabilities({
    accessToken: input.accessToken,
    forceRefresh: true,
    allowStaleOnError: false,
  });
  if (input.signal?.aborted) {
    return { outcome: 'stale', canonicalMeetingId: aggregate.note.id };
  }
  if (capability.source !== 'remote' || !capability.capabilities.manualNotesV2) {
    return { outcome: 'disabled', canonicalMeetingId: aggregate.note.id };
  }
  const remote = await getMeetingManualNoteV2({
    accessToken: input.accessToken,
    meetingRemoteId: input.meetingRemoteId,
    signal: input.signal,
  });
  if (input.signal?.aborted) {
    return { outcome: 'stale', canonicalMeetingId: aggregate.note.id };
  }
  const merged = await sqliteMeetingNoteRepository.mergeMeetingManualNoteRemote({
    meetingId: aggregate.note.id,
    remoteMeetingId: input.meetingRemoteId,
    scopeKey: input.scopeKey,
    remote: {
      exists: remote.exists,
      remoteId: remote.remoteId,
      revision: remote.revision,
      clientNoteRevision: remote.clientNoteRevision,
      clientUpdatedAtMs: remote.clientUpdatedAtMs,
      userEditedAtMs: remote.userEditedAtMs,
      content: remote.content,
      serverCreatedAtMs: remote.serverCreatedAtMs,
      serverUpdatedAtMs: remote.serverUpdatedAtMs,
    },
    pulledAtMs: Date.now(),
  });
  diagnosticAudit('manual_note_detail_pull', {
    status: merged.outcome,
    local_revision_before: merged.previousLocalRevision,
    local_revision_after: merged.nextLocalRevision,
  });
  return { outcome: merged.outcome, canonicalMeetingId: aggregate.note.id };
}
