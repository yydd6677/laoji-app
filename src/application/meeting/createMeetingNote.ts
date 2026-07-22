import type {
  ClientIdFactory,
  MeetingEntryPoint,
  MeetingCaptureMode,
  MeetingLifecycle,
  MeetingOrigin,
  MeetingProcessingStatuses,
  OccurrenceReference,
  ScheduleSnapshot,
  ScopeKey,
} from '../../domain/meeting';
import {
  assertScopeKey,
  createInitialProcessingStages,
  secureClientIdFactory,
} from '../../domain/meeting';
import type {
  MeetingNoteAggregate,
  MeetingNoteRepository,
  RecordingAssetLocalState,
  RecordingAssetOrigin,
} from '../../data/repositories';

export interface InitialRecordingAssetInput {
  id?: string;
  origin: RecordingAssetOrigin;
  nativeSessionId?: string | null;
  localUri?: string | null;
  remoteAssetId?: string | null;
  mimeType?: string | null;
  fileName?: string | null;
  byteSize?: number | null;
  durationMs?: number | null;
  checksumSha256?: string | null;
  waveformJson?: string | null;
  localState: RecordingAssetLocalState;
  lastVerifiedAtMs?: number | null;
}

export interface CreateMeetingNoteInput {
  id?: string;
  scopeKey: ScopeKey;
  origin: MeetingOrigin;
  entryPoint: MeetingEntryPoint;
  title?: string | null;
  description?: string | null;
  participants?: readonly string[];
  location?: string | null;
  mode?: MeetingCaptureMode | null;
  clientRequestId?: string | null;
  recordedAtMs?: number | null;
  lifecycle?: MeetingLifecycle;
  startedAtMs?: number | null;
  endedAtMs?: number | null;
  occurrence?: OccurrenceReference | null;
  scheduleSnapshot?: ScheduleSnapshot | null;
  recordingAsset?: InitialRecordingAssetInput | null;
  initialStageStatuses?: Partial<MeetingProcessingStatuses>;
  canonicalWrite?: boolean;
}

export interface CreateMeetingNoteResult {
  aggregate: MeetingNoteAggregate;
  created: boolean;
  canonicalRevision: number | null;
}

export interface CreateMeetingNoteDependencies {
  repository: MeetingNoteRepository;
  idFactory?: ClientIdFactory;
  now?: () => number;
}

function normalizedId(value: string | undefined, factory: ClientIdFactory): string {
  const id = value?.trim() || factory.create().trim();
  if (!id || id.length > 160 || /[\u0000-\u001f\u007f]/.test(id)) {
    throw new Error('meeting ID is invalid');
  }
  return id;
}

function validTimestamp(value: number | null | undefined, field: string): number | null {
  if (value === null || value === undefined) return null;
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${field} is invalid`);
  return value;
}

function requiredTimestamp(value: number | null | undefined, field: string): number {
  const normalized = validTimestamp(value, field);
  if (normalized === null) throw new Error(`${field} is required`);
  return normalized;
}

function normalizeOptionalText(
  value: string | null | undefined,
  maximum: number,
  field: string,
): string | null {
  if (value === null || value === undefined) return null;
  const normalized = value.trim();
  if (!normalized) return null;
  if (normalized.length > maximum || /[\u0000]/.test(normalized)) {
    throw new Error(`${field} is invalid`);
  }
  return normalized;
}

function normalizeParticipants(values: readonly string[] | undefined): readonly string[] {
  if (!values) return [];
  const normalized = values.map(value => value.trim()).filter(Boolean);
  if (normalized.length > 500 || normalized.some(value => value.length > 1000 || /[\u0000]/.test(value))) {
    throw new Error('meeting participants are invalid');
  }
  return [...new Set(normalized)];
}

function normalizeMode(value: MeetingCaptureMode | null | undefined): MeetingCaptureMode | null {
  if (value === null || value === undefined) return null;
  if (!['realtime', 'offline', 'whisper', 'qwen'].includes(value)) {
    throw new Error('meeting mode is invalid');
  }
  return value;
}

function normalizeOccurrence(reference: OccurrenceReference): OccurrenceReference {
  const sourceEventId = reference.sourceEventId.trim();
  const occurrenceDate = reference.occurrenceDate.trim();
  if (!sourceEventId || sourceEventId.length > 512) throw new Error('calendar occurrence source is invalid');
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(occurrenceDate);
  if (!match) throw new Error('calendar occurrence date is invalid');
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  if (
    parsed.getUTCFullYear() !== year ||
    parsed.getUTCMonth() !== month - 1 ||
    parsed.getUTCDate() !== day
  ) {
    throw new Error('calendar occurrence date is invalid');
  }
  return { sourceEventId, occurrenceDate };
}

function normalizeSnapshot(snapshot: ScheduleSnapshot): ScheduleSnapshot {
  const plannedStartMs = validTimestamp(snapshot.plannedStartMs, 'schedule start');
  const plannedEndMs = validTimestamp(snapshot.plannedEndMs, 'schedule end');
  if (plannedStartMs !== null && plannedEndMs !== null && plannedEndMs < plannedStartMs) {
    throw new Error('schedule end precedes start');
  }
  return {
    eventTitle: snapshot.eventTitle.trim(),
    plannedStartMs,
    plannedEndMs,
    allDay: Boolean(snapshot.allDay),
    timezoneId: snapshot.timezoneId?.trim() || null,
    location: snapshot.location?.trim() || null,
    participants: snapshot.participants.map(item => item.trim()).filter(Boolean),
    description: snapshot.description ?? null,
    capturedEventRevision: snapshot.capturedEventRevision === null
      ? null
      : validTimestamp(snapshot.capturedEventRevision, 'calendar revision'),
    capturedAtMs: requiredTimestamp(snapshot.capturedAtMs, 'schedule capture time'),
  };
}

function assertSourceContract(input: CreateMeetingNoteInput): void {
  const hasOccurrence = Boolean(input.occurrence);
  const hasSnapshot = Boolean(input.scheduleSnapshot);
  if (hasOccurrence !== hasSnapshot) {
    throw new Error('calendar occurrence and schedule snapshot must be created together');
  }
  if (input.origin === 'calendar' && !hasOccurrence) {
    throw new Error('calendar meeting requires an occurrence snapshot');
  }
  if ((input.origin === 'file_import' || input.origin === 'share_intent') && !input.recordingAsset) {
    throw new Error('imported meeting requires an ingesting recording asset');
  }
}

export class CreateMeetingNoteUseCase {
  private readonly repository: MeetingNoteRepository;
  private readonly idFactory: ClientIdFactory;
  private readonly now: () => number;

  constructor(dependencies: CreateMeetingNoteDependencies) {
    this.repository = dependencies.repository;
    this.idFactory = dependencies.idFactory ?? secureClientIdFactory;
    this.now = dependencies.now ?? Date.now;
  }

  async execute(input: CreateMeetingNoteInput): Promise<CreateMeetingNoteResult> {
    assertScopeKey(input.scopeKey);
    assertSourceContract(input);
    const nowMs = this.now();
    if (!Number.isSafeInteger(nowMs) || nowMs < 0) throw new Error('meeting clock is invalid');
    const requestedId = normalizedId(input.id, this.idFactory);
    const startedAtMs = validTimestamp(input.startedAtMs, 'meeting start');
    const endedAtMs = validTimestamp(input.endedAtMs, 'meeting end');
    if (startedAtMs !== null && endedAtMs !== null && endedAtMs < startedAtMs) {
      throw new Error('meeting end precedes start');
    }
    const lifecycle = input.lifecycle ?? (endedAtMs !== null ? 'ended' : startedAtMs !== null ? 'active' : 'draft');
    if (lifecycle === 'ended' && endedAtMs === null) throw new Error('ended meeting requires an end time');
    const occurrence = input.occurrence ? normalizeOccurrence(input.occurrence) : null;
    const snapshot = input.scheduleSnapshot ? normalizeSnapshot(input.scheduleSnapshot) : null;
    const title = input.title?.trim() ?? '';
    const description = normalizeOptionalText(input.description, 100_000, 'meeting description');
    const participants = normalizeParticipants(input.participants);
    const location = normalizeOptionalText(input.location, 2_000, 'meeting location');
    const mode = normalizeMode(input.mode);
    const clientRequestId = normalizeOptionalText(
      input.clientRequestId,
      512,
      'meeting client request ID',
    ) ?? requestedId;
    const recordedAtMs = validTimestamp(input.recordedAtMs, 'meeting recorded time');
    let resolvedId = requestedId;
    let created = false;
    let canonicalRevision: number | null = null;

    await this.repository.transaction(async transaction => {
      if (occurrence) {
        const existingForOccurrence = await transaction.findMeetingByOccurrence(
          occurrence,
          input.scopeKey,
        );
        if (existingForOccurrence && existingForOccurrence.lifecycle !== 'deleted') {
          resolvedId = existingForOccurrence.id;
          return;
        }
      }
      const existing = await transaction.getMeeting(requestedId, input.scopeKey);
      if (existing) {
        if (existing.origin !== input.origin) throw new Error('meeting create retry changed origin');
        if (existing.clientRequestId && existing.clientRequestId !== clientRequestId) {
          throw new Error('meeting create retry changed client request identity');
        }
        resolvedId = existing.id;
        return;
      }

      await transaction.insertMeeting({
        id: requestedId,
        scopeKey: input.scopeKey,
        origin: input.origin,
        entryPoint: input.entryPoint,
        title,
        description,
        participants,
        location,
        mode,
        clientRequestId,
        recordedAtMs,
        lifecycle,
        startedAtMs,
        endedAtMs,
        createdAtMs: nowMs,
      });
      await transaction.saveManualNote({
        meetingId: requestedId,
        content: '',
        revision: 0,
        baseRemoteRevision: null,
        dirty: false,
        lastSavedAtMs: nowMs,
        userEditedAtMs: null,
      }, input.scopeKey);

      const stageOverrides: Partial<MeetingProcessingStatuses> = {
        ...input.initialStageStatuses,
      };
      if (input.recordingAsset?.localState === 'local_ready') {
        stageOverrides.capture ??= 'local_ready';
        stageOverrides.upload ??= input.scopeKey === 'guest' ? 'not_required' : 'queued';
      } else if (input.recordingAsset?.localState === 'capturing') {
        stageOverrides.capture ??= 'preparing';
      }
      const stages = createInitialProcessingStages(
        requestedId,
        input.scopeKey,
        nowMs,
        stageOverrides,
      );
      for (const stage of stages) await transaction.upsertStage(stage, input.scopeKey);

      if (occurrence && snapshot) {
        await transaction.bindOccurrence({
          meetingId: requestedId,
          scopeKey: input.scopeKey,
          ...occurrence,
          calendarRevision: snapshot.capturedEventRevision,
          recurrenceSegmentId: null,
          seriesKey: null,
          linkedAtMs: nowMs,
        }, snapshot);
      }

      if (input.recordingAsset) {
        const assetId = normalizedId(input.recordingAsset.id, this.idFactory);
        const byteSize = validTimestamp(input.recordingAsset.byteSize, 'recording size');
        const durationMs = validTimestamp(input.recordingAsset.durationMs, 'recording duration');
        const lastVerifiedAtMs = validTimestamp(
          input.recordingAsset.lastVerifiedAtMs,
          'recording verification time',
        );
        await transaction.saveRecordingAsset({
          id: assetId,
          meetingId: requestedId,
          role: 'primary',
          origin: input.recordingAsset.origin,
          nativeSessionId: input.recordingAsset.nativeSessionId?.trim() || null,
          localUri: input.recordingAsset.localUri?.trim() || null,
          remoteAssetId: input.recordingAsset.remoteAssetId?.trim() || null,
          mimeType: input.recordingAsset.mimeType?.trim() || null,
          fileName: input.recordingAsset.fileName?.trim() || null,
          byteSize,
          durationMs,
          checksumSha256: input.recordingAsset.checksumSha256?.trim() || null,
          waveformJson: input.recordingAsset.waveformJson ?? null,
          localState: input.recordingAsset.localState,
          createdAtMs: nowMs,
          updatedAtMs: nowMs,
          lastVerifiedAtMs,
        }, input.scopeKey);
      }

      if (input.scopeKey !== 'guest') {
        await transaction.insertOutbox({
          operationId: `meeting.create:${requestedId}`,
          scopeKey: input.scopeKey,
          aggregateType: 'meeting_note',
          aggregateId: requestedId,
          operationType: 'meeting.create',
          baseRevision: null,
          payloadJson: JSON.stringify({
            schema_version: 1,
            client_note_id: requestedId,
            origin: input.origin,
            entry_point: input.entryPoint,
            title,
            description,
            participants,
            location,
            mode,
            client_request_id: clientRequestId,
            recorded_at_ms: recordedAtMs,
            started_at_ms: startedAtMs,
            occurrence_ref: occurrence,
            schedule_snapshot: snapshot,
          }),
          createdAtMs: nowMs,
        });
      }
      if (input.canonicalWrite) {
        canonicalRevision = await transaction.advanceCanonicalWrite(input.scopeKey, nowMs);
      }
      created = true;
    });

    const aggregate = await this.repository.get(resolvedId, input.scopeKey);
    if (!aggregate) throw new Error('meeting create transaction committed without aggregate');
    if (aggregate.processingStages.length !== 5) {
      throw new Error('meeting create transaction committed without all processing stages');
    }
    return { aggregate, created, canonicalRevision };
  }
}
