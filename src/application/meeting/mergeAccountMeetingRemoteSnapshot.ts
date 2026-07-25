import type {
  ClientIdFactory,
  MeetingCaptureMode,
  MeetingEntryPoint,
  MeetingLifecycle,
  MeetingOrigin,
  MeetingProcessingStatuses,
  ProcessingStage,
  ScopeKey,
} from '../../domain/meeting';
import {
  assertScopeKey,
  createInitialProcessingStages,
  secureClientIdFactory,
  transitionProcessingStage,
} from '../../domain/meeting';
import type {
  MeetingNoteRepository,
  MeetingRootPatch,
  MeetingTransaction,
} from '../../data/repositories';

export interface AccountMeetingRemoteSnapshot {
  remoteId: string;
  clientNoteId: string | null;
  clientRequestId: string | null;
  remoteRevision: number | null;
  origin: MeetingOrigin | null;
  entryPoint: MeetingEntryPoint | null;
  remoteLifecycle: 'active' | 'deleted' | null;
  deletedAtMs: number | null;
  title: string;
  description: string | null;
  participants: readonly string[];
  location: string | null;
  mode: MeetingCaptureMode | null;
  status: string;
  recordedAtMs: number | null;
  createdAtMs: number;
  updatedAtMs: number;
  audioAvailable: boolean;
  transcriptAvailable: boolean;
  summaryAvailable: boolean;
}

export interface MergeAccountMeetingRemoteSnapshotInput {
  scopeKey: ScopeKey;
  snapshots: readonly AccountMeetingRemoteSnapshot[];
  canonicalWrite?: boolean;
}

export interface MergeAccountMeetingRemoteSnapshotResult {
  created: number;
  updated: number;
  protectedLocal: number;
  tombstonesPreserved: number;
  attachedRemoteIdentities: number;
  remoteTombstonesApplied: number;
  remoteRestoresApplied: number;
  ignoredStale: number;
  canonicalRevision: number | null;
}

export interface MergeAccountMeetingRemoteSnapshotDependencies {
  repository: MeetingNoteRepository;
  idFactory?: ClientIdFactory;
  now?: () => number;
}

function recordId(value: string | null, field: string): string | null {
  if (value === null) return null;
  const normalized = value.trim();
  if (!normalized || normalized.length > 512 || /[\u0000-\u001f\u007f]/.test(normalized)) {
    throw new Error(`${field} is invalid`);
  }
  return normalized;
}

function nullableText(value: string | null, maximum: number, field: string): string | null {
  if (value === null) return null;
  const normalized = value.trim();
  if (!normalized) return null;
  if (normalized.length > maximum || normalized.includes('\u0000')) {
    throw new Error(`${field} is invalid`);
  }
  return normalized;
}

function nonNegativeTime(value: number | null, field: string): number | null {
  if (value === null) return null;
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${field} is invalid`);
  return value;
}

function normalizeSnapshot(value: AccountMeetingRemoteSnapshot): AccountMeetingRemoteSnapshot {
  const remoteId = recordId(value.remoteId, 'meeting remote ID');
  if (!remoteId) throw new Error('meeting remote ID is missing');
  const clientNoteId = recordId(value.clientNoteId, 'meeting client note ID');
  const clientRequestId = recordId(value.clientRequestId, 'meeting client request ID');
  const title = value.title.trim();
  if (title.length > 100_000 || title.includes('\u0000')) throw new Error('meeting title is invalid');
  const participants = value.participants.map(item => item.trim()).filter(Boolean);
  if (participants.length > 500 || participants.some(item => (
    item.length > 1_000 || item.includes('\u0000')
  ))) throw new Error('meeting participants are invalid');
  const mode = value.mode;
  if (mode !== null && !['realtime', 'offline', 'whisper', 'qwen'].includes(mode)) {
    throw new Error('meeting mode is invalid');
  }
  const createdAtMs = nonNegativeTime(value.createdAtMs, 'meeting creation time');
  const updatedAtMs = nonNegativeTime(value.updatedAtMs, 'meeting update time');
  const remoteRevision = nonNegativeTime(value.remoteRevision, 'meeting remote revision');
  if (remoteRevision !== null && remoteRevision < 1) {
    throw new Error('meeting remote revision is invalid');
  }
  const deletedAtMs = nonNegativeTime(value.deletedAtMs, 'meeting deletion time');
  if ((value.remoteLifecycle === 'deleted') !== (deletedAtMs !== null)) {
    throw new Error('meeting remote deletion state is invalid');
  }
  if (createdAtMs === null || updatedAtMs === null) throw new Error('meeting remote clock is missing');
  const status = value.status.trim().toLowerCase();
  if (!status || status.length > 160 || /[\u0000-\u001f\u007f]/.test(status)) {
    throw new Error('meeting remote status is invalid');
  }
  return {
    remoteId,
    clientNoteId,
    clientRequestId,
    remoteRevision,
    origin: value.origin,
    entryPoint: value.entryPoint,
    remoteLifecycle: value.remoteLifecycle,
    deletedAtMs,
    title,
    description: nullableText(value.description, 100_000, 'meeting description'),
    participants: [...new Set(participants)],
    location: nullableText(value.location, 2_000, 'meeting location'),
    mode,
    status,
    recordedAtMs: nonNegativeTime(value.recordedAtMs, 'meeting recorded time'),
    createdAtMs,
    updatedAtMs,
    audioAvailable: Boolean(value.audioAvailable),
    transcriptAvailable: Boolean(value.transcriptAvailable),
    summaryAvailable: Boolean(value.summaryAvailable),
  };
}

function lifecycle(status: string): MeetingLifecycle {
  if (status === 'recording' || status === 'paused' || status === 'processing') return 'active';
  if (['completed', 'ended', 'done', 'processed', 'failed'].includes(status)) return 'ended';
  return 'draft';
}

function snapshotLifecycle(snapshot: AccountMeetingRemoteSnapshot): MeetingLifecycle {
  return snapshot.remoteLifecycle === 'deleted' ? 'deleted' : lifecycle(snapshot.status);
}

function captureStatus(snapshot: AccountMeetingRemoteSnapshot): MeetingProcessingStatuses['capture'] {
  if (snapshot.status === 'recording') return 'recording';
  if (snapshot.status === 'paused') return 'paused';
  if (snapshot.status === 'processing') return snapshot.audioAvailable ? 'local_ready' : 'finalizing';
  if (snapshot.status === 'failed') return snapshot.audioAvailable ? 'local_ready' : 'failed_recoverable';
  if (lifecycle(snapshot.status) === 'ended') return 'local_ready';
  return 'not_started';
}

function initialStatuses(snapshot: AccountMeetingRemoteSnapshot): MeetingProcessingStatuses {
  return {
    capture: captureStatus(snapshot),
    upload: snapshot.audioAvailable ? 'uploaded' : 'not_required',
    transcript: snapshot.transcriptAvailable
      ? 'ready'
      : snapshot.status === 'processing' ? 'finalizing' : 'none',
    summary: snapshot.summaryAvailable ? 'ready' : 'none',
    speaker: 'none',
  };
}

function arraysEqual(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function pendingCreateMatches(
  current: Awaited<ReturnType<MeetingTransaction['getMeeting']>> & {},
  snapshot: AccountMeetingRemoteSnapshot,
): boolean {
  return current.title === snapshot.title
    && current.description === snapshot.description
    && arraysEqual(current.participants, snapshot.participants)
    && current.location === snapshot.location
    && (current.mode ?? 'realtime') === (snapshot.mode ?? 'realtime')
    && current.recordedAtMs === snapshot.recordedAtMs
    && (snapshot.origin === null || current.origin === snapshot.origin)
    && (
      snapshot.clientRequestId === null
      || current.clientRequestId === snapshot.clientRequestId
    );
}

function fieldPatch(
  current: Awaited<ReturnType<MeetingTransaction['getMeeting']>> & {},
  snapshot: AccountMeetingRemoteSnapshot,
  updatedAtMs: number,
): MeetingRootPatch | null {
  const nextLifecycle = snapshotLifecycle(snapshot);
  const patch: MeetingRootPatch = { updatedAtMs };
  let changed = false;
  const set = <Key extends keyof MeetingRootPatch>(key: Key, value: MeetingRootPatch[Key]) => {
    patch[key] = value;
    changed = true;
  };
  if (current.remoteId !== snapshot.remoteId) set('remoteId', snapshot.remoteId);
  if (snapshot.remoteRevision !== null && current.remoteRevision !== snapshot.remoteRevision) {
    set('remoteRevision', snapshot.remoteRevision);
  }
  if (snapshot.origin !== null && current.origin !== snapshot.origin) set('origin', snapshot.origin);
  if (snapshot.entryPoint !== null && current.entryPoint !== snapshot.entryPoint) {
    set('entryPoint', snapshot.entryPoint);
  }
  if (
    snapshot.clientRequestId !== null
    && current.clientRequestId !== snapshot.clientRequestId
  ) set('clientRequestId', snapshot.clientRequestId);
  if (current.title !== snapshot.title) set('title', snapshot.title);
  if (current.description !== snapshot.description) set('description', snapshot.description);
  if (!arraysEqual(current.participants, snapshot.participants)) set('participants', snapshot.participants);
  if (current.location !== snapshot.location) set('location', snapshot.location);
  if (current.mode !== snapshot.mode) set('mode', snapshot.mode);
  if (current.recordedAtMs !== snapshot.recordedAtMs) set('recordedAtMs', snapshot.recordedAtMs);
  if (current.lifecycle !== nextLifecycle) set('lifecycle', nextLifecycle);
  if (current.deletedAtMs !== snapshot.deletedAtMs) set('deletedAtMs', snapshot.deletedAtMs);
  const nextSyncState = nextLifecycle === 'deleted' ? 'deleted' : 'synced';
  if (current.syncState !== nextSyncState) set('syncState', nextSyncState);
  if (nextLifecycle === 'active' && current.startedAtMs === null) {
    set('startedAtMs', snapshot.createdAtMs);
  }
  if (nextLifecycle === 'ended' && current.endedAtMs === null) {
    set('endedAtMs', snapshot.updatedAtMs);
  }
  return changed ? patch : null;
}

function remoteRootFieldsMatch(
  current: Awaited<ReturnType<MeetingTransaction['getMeeting']>> & {},
  snapshot: AccountMeetingRemoteSnapshot,
): boolean {
  return current.remoteId === snapshot.remoteId
    && (snapshot.remoteRevision === null || current.remoteRevision === snapshot.remoteRevision)
    && (snapshot.origin === null || current.origin === snapshot.origin)
    && (snapshot.entryPoint === null || current.entryPoint === snapshot.entryPoint)
    && (
      snapshot.clientRequestId === null
      || current.clientRequestId === snapshot.clientRequestId
    )
    && current.title === snapshot.title
    && current.description === snapshot.description
    && arraysEqual(current.participants, snapshot.participants)
    && current.location === snapshot.location
    && (current.mode ?? 'realtime') === (snapshot.mode ?? 'realtime')
    && current.recordedAtMs === snapshot.recordedAtMs
    && current.lifecycle === snapshotLifecycle(snapshot)
    && (current.deletedAtMs === null) === (snapshot.deletedAtMs === null);
}

async function updateRemoteStages(
  transaction: MeetingTransaction,
  meetingId: string,
  scopeKey: ScopeKey,
  snapshot: AccountMeetingRemoteSnapshot,
  updatedAtMs: number,
): Promise<boolean> {
  const targets = initialStatuses(snapshot);
  let changed = false;
  for (const [stageName, status] of Object.entries(targets)) {
    const stage = stageName as ProcessingStage['stage'];
    const current = await transaction.getStage(meetingId, scopeKey, stage);
    if (!current || current.status === status) continue;
    if (stage === 'upload') {
      if (['queued', 'uploading', 'failed_retryable', 'blocked'].includes(current.status)) continue;
      if (current.status === 'uploaded' && status !== 'uploaded') continue;
    }
    if (stage === 'transcript' && current.status !== 'none' && !snapshot.transcriptAvailable) continue;
    if (stage === 'summary' && current.status !== 'none' && !snapshot.summaryAvailable) continue;
    await transaction.upsertStage(transitionProcessingStage(current, {
      stage,
      status,
      progress: status === 'ready' || status === 'uploaded' || status === 'local_ready' ? 1 : null,
      ...(status === 'failed_recoverable' ? {
        errorCode: 'remote_recording_failed',
        userMessageKey: 'meeting.capture.retryable',
        retryable: true,
      } : {}),
    } as Parameters<typeof transitionProcessingStage>[1], updatedAtMs), scopeKey);
    changed = true;
  }
  return changed;
}

export class MergeAccountMeetingRemoteSnapshotUseCase {
  private readonly repository: MeetingNoteRepository;
  private readonly idFactory: ClientIdFactory;
  private readonly now: () => number;

  constructor(dependencies: MergeAccountMeetingRemoteSnapshotDependencies) {
    this.repository = dependencies.repository;
    this.idFactory = dependencies.idFactory ?? secureClientIdFactory;
    this.now = dependencies.now ?? Date.now;
  }

  async execute(
    input: MergeAccountMeetingRemoteSnapshotInput,
  ): Promise<MergeAccountMeetingRemoteSnapshotResult> {
    assertScopeKey(input.scopeKey);
    if (input.scopeKey === 'guest') throw new Error('account remote snapshot requires account scope');
    const snapshots = input.snapshots.map(normalizeSnapshot);
    if (new Set(snapshots.map(item => item.remoteId)).size !== snapshots.length) {
      throw new Error('meeting remote snapshot contains duplicate identities');
    }
    const nowMs = this.now();
    if (!Number.isSafeInteger(nowMs) || nowMs < 0) throw new Error('meeting remote merge clock is invalid');
    let created = 0;
    let updated = 0;
    let protectedLocal = 0;
    let tombstonesPreserved = 0;
    let attachedRemoteIdentities = 0;
    let remoteTombstonesApplied = 0;
    let remoteRestoresApplied = 0;
    let ignoredStale = 0;
    let canonicalRevision: number | null = null;

    await this.repository.transaction(async transaction => {
      let changed = false;
      for (const snapshot of snapshots) {
        let current = await transaction.findMeetingByRemoteIdentity(
          snapshot.remoteId,
          snapshot.clientNoteId,
          snapshot.clientRequestId,
          input.scopeKey,
        );
        if (!current) {
          const meetingId = this.idFactory.create();
          const meetingLifecycle = snapshotLifecycle(snapshot);
          await transaction.insertMeeting({
            id: meetingId,
            scopeKey: input.scopeKey,
            remoteId: snapshot.remoteId,
            origin: snapshot.origin ?? 'ad_hoc',
            entryPoint: snapshot.entryPoint ?? 'meeting_tab',
            title: snapshot.title,
            description: snapshot.description,
            participants: snapshot.participants,
            location: snapshot.location,
            mode: snapshot.mode,
            clientRequestId: snapshot.clientRequestId,
            recordedAtMs: snapshot.recordedAtMs,
            lifecycle: meetingLifecycle,
            startedAtMs: meetingLifecycle === 'draft' || meetingLifecycle === 'deleted'
              ? null
              : snapshot.createdAtMs,
            endedAtMs: meetingLifecycle === 'ended' ? snapshot.updatedAtMs : null,
            remoteRevision: snapshot.remoteRevision,
            syncState: meetingLifecycle === 'deleted' ? 'deleted' : 'synced',
            deletedAtMs: snapshot.deletedAtMs,
            createdAtMs: snapshot.createdAtMs,
          });
          await transaction.saveManualNote({
            meetingId,
            content: '',
            revision: 0,
            baseRemoteRevision: null,
            dirty: false,
            lastSavedAtMs: snapshot.updatedAtMs,
            userEditedAtMs: null,
          }, input.scopeKey);
          for (const stage of createInitialProcessingStages(
            meetingId,
            input.scopeKey,
            snapshot.updatedAtMs,
            initialStatuses(snapshot),
          )) await transaction.upsertStage(stage, input.scopeKey);
          if (snapshot.audioAvailable) {
            await transaction.saveRecordingAsset({
              id: this.idFactory.create(),
              meetingId,
              role: 'primary',
              origin: 'recovered',
              nativeSessionId: null,
              localUri: null,
              remoteAssetId: null,
              mimeType: null,
              fileName: null,
              byteSize: null,
              durationMs: null,
              checksumSha256: null,
              waveformJson: null,
              localState: 'remote_only',
              createdAtMs: snapshot.createdAtMs,
              updatedAtMs: snapshot.updatedAtMs,
              lastVerifiedAtMs: null,
            }, input.scopeKey);
          }
          if (snapshot.updatedAtMs !== snapshot.createdAtMs) {
            await transaction.updateMeeting(meetingId, input.scopeKey, {
              updatedAtMs: snapshot.updatedAtMs,
            });
          }
          created += 1;
          if (meetingLifecycle === 'deleted') remoteTombstonesApplied += 1;
          changed = true;
          continue;
        }
        if (
          snapshot.remoteRevision !== null
          && current.remoteRevision !== null
          && snapshot.remoteRevision < current.remoteRevision
        ) {
          ignoredStale += 1;
          continue;
        }
        if (current.remoteRevision !== null && snapshot.remoteRevision === null) {
          protectedLocal += 1;
          continue;
        }
        const outstanding = await transaction.hasOutstandingMeetingRootSync(
          current.id,
          input.scopeKey,
        );
        if (outstanding) {
          if (current.remoteId === null && pendingCreateMatches(current, snapshot)) {
            await transaction.updateMeeting(current.id, input.scopeKey, {
              remoteId: snapshot.remoteId,
              remoteRevision: snapshot.remoteRevision,
              updatedAtMs: Math.max(current.updatedAtMs, snapshot.updatedAtMs),
            });
            current = {
              ...current,
              remoteId: snapshot.remoteId,
              remoteRevision: snapshot.remoteRevision,
            };
            attachedRemoteIdentities += 1;
            changed = true;
          }
          protectedLocal += 1;
          continue;
        }
        if (current.lifecycle === 'deleted' && snapshot.remoteLifecycle === null) {
          tombstonesPreserved += 1;
          continue;
        }
        if (
          snapshot.remoteRevision !== null
          && current.remoteRevision === snapshot.remoteRevision
          && !remoteRootFieldsMatch(current, snapshot)
        ) throw new Error('meeting remote payload changed without revision');
        const updatedAtMs = Math.max(current.updatedAtMs, snapshot.updatedAtMs);
        const patch = fieldPatch(current, snapshot, updatedAtMs);
        const nextLifecycle = snapshotLifecycle(snapshot);
        if (current.lifecycle !== 'deleted' && nextLifecycle === 'deleted') {
          remoteTombstonesApplied += 1;
        } else if (current.lifecycle === 'deleted' && nextLifecycle !== 'deleted') {
          remoteRestoresApplied += 1;
        }
        const stagesChanged = nextLifecycle === 'deleted'
          ? false
          : await updateRemoteStages(
            transaction,
            current.id,
            input.scopeKey,
            snapshot,
            updatedAtMs,
          );
        const primary = await transaction.getPrimaryRecording(current.id, input.scopeKey);
        let recordingChanged = false;
        if (nextLifecycle !== 'deleted' && !primary && snapshot.audioAvailable) {
          await transaction.saveRecordingAsset({
            id: this.idFactory.create(),
            meetingId: current.id,
            role: 'primary',
            origin: 'recovered',
            nativeSessionId: null,
            localUri: null,
            remoteAssetId: null,
            mimeType: null,
            fileName: null,
            byteSize: null,
            durationMs: null,
            checksumSha256: null,
            waveformJson: null,
            localState: 'remote_only',
            createdAtMs: snapshot.createdAtMs,
            updatedAtMs,
            lastVerifiedAtMs: null,
          }, input.scopeKey);
          recordingChanged = true;
        }
        if (patch) await transaction.updateMeeting(current.id, input.scopeKey, patch);
        if (patch || stagesChanged || recordingChanged) {
          updated += 1;
          changed = true;
        }
      }
      if (changed && input.canonicalWrite) {
        canonicalRevision = await transaction.advanceCanonicalWrite(input.scopeKey, nowMs);
      }
    });

    return {
      created,
      updated,
      protectedLocal,
      tombstonesPreserved,
      attachedRemoteIdentities,
      remoteTombstonesApplied,
      remoteRestoresApplied,
      ignoredStale,
      canonicalRevision,
    };
  }
}
