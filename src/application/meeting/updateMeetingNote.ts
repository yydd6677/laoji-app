import type { MeetingCaptureMode, ScopeKey } from '../../domain/meeting';
import { assertScopeKey } from '../../domain/meeting';
import type { MeetingNoteAggregate, MeetingNoteRepository, MeetingRootPatch } from "../../data/repositories/meetingNoteRepository";

export interface UpdateMeetingNoteChanges {
  title?: string | null;
  description?: string | null;
  participants?: readonly string[];
  location?: string | null;
  mode?: MeetingCaptureMode | null;
  recordedAtMs?: number | null;
}

export interface MeetingRootSyncOperation {
  operationId: string;
  operationType: string;
}

export interface UpdateMeetingNoteInput {
  meetingId: string;
  scopeKey: ScopeKey;
  changes: UpdateMeetingNoteChanges;
  syncOperation?: MeetingRootSyncOperation | null;
  canonicalWrite?: boolean;
}

export interface UpdateMeetingNoteResult {
  aggregate: MeetingNoteAggregate;
  applied: boolean;
  canonicalRevision: number | null;
}

export interface UpdateMeetingNoteDependencies {
  repository: MeetingNoteRepository;
  now?: () => number;
}

function hasOwn<T extends object>(value: T, key: PropertyKey): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function normalizeNullableText(
  value: string | null | undefined,
  maximum: number,
  field: string,
): string | null {
  if (value === null || value === undefined) return null;
  const normalized = value.trim();
  if (!normalized) return null;
  if (normalized.length > maximum || normalized.includes('\u0000')) {
    throw new Error(`${field} is invalid`);
  }
  return normalized;
}

function normalizeParticipants(values: readonly string[] | undefined): readonly string[] {
  const normalized = (values ?? []).map(value => value.trim()).filter(Boolean);
  if (normalized.length > 500 || normalized.some(value => (
    value.length > 1000 || value.includes('\u0000')
  ))) throw new Error('meeting participants are invalid');
  return [...new Set(normalized)];
}

function normalizeChanges(changes: UpdateMeetingNoteChanges): Omit<MeetingRootPatch, 'updatedAtMs'> {
  const normalized: Omit<MeetingRootPatch, 'updatedAtMs'> = {};
  let fields = 0;
  if (hasOwn(changes, 'title')) {
    const title = changes.title?.trim() ?? '';
    if (title.length > 100_000 || title.includes('\u0000')) throw new Error('meeting title is invalid');
    normalized.title = title;
    fields += 1;
  }
  if (hasOwn(changes, 'description')) {
    normalized.description = normalizeNullableText(changes.description, 100_000, 'meeting description');
    fields += 1;
  }
  if (hasOwn(changes, 'participants')) {
    normalized.participants = normalizeParticipants(changes.participants);
    fields += 1;
  }
  if (hasOwn(changes, 'location')) {
    normalized.location = normalizeNullableText(changes.location, 2_000, 'meeting location');
    fields += 1;
  }
  if (hasOwn(changes, 'mode')) {
    const mode = changes.mode ?? null;
    if (mode !== null && !['realtime', 'offline'].includes(mode)) {
      throw new Error('meeting mode is invalid');
    }
    normalized.mode = mode;
    fields += 1;
  }
  if (hasOwn(changes, 'recordedAtMs')) {
    const recordedAtMs = changes.recordedAtMs ?? null;
    if (recordedAtMs !== null && (!Number.isSafeInteger(recordedAtMs) || recordedAtMs < 0)) {
      throw new Error('meeting recorded time is invalid');
    }
    normalized.recordedAtMs = recordedAtMs;
    fields += 1;
  }
  if (fields === 0) throw new Error('meeting update contains no changes');
  return normalized;
}

export class UpdateMeetingNoteUseCase {
  private readonly repository: MeetingNoteRepository;
  private readonly now: () => number;

  constructor(dependencies: UpdateMeetingNoteDependencies) {
    this.repository = dependencies.repository;
    this.now = dependencies.now ?? Date.now;
  }

  async execute(input: UpdateMeetingNoteInput): Promise<UpdateMeetingNoteResult> {
    assertScopeKey(input.scopeKey);
    const meetingId = input.meetingId.trim();
    if (!meetingId) throw new Error('meeting ID is invalid');
    const changes = normalizeChanges(input.changes);
    let applied = false;
    let canonicalRevision: number | null = null;

    await this.repository.transaction(async transaction => {
      const meeting = await transaction.getMeeting(meetingId, input.scopeKey);
      if (!meeting) throw new Error('meeting does not exist in active scope');
      if (meeting.lifecycle === 'deleted') throw new Error('deleted meeting cannot be updated');
      const clockMs = this.now();
      if (!Number.isSafeInteger(clockMs) || clockMs < 0) throw new Error('meeting clock is invalid');
      const updatedAtMs = Math.max(clockMs, meeting.updatedAtMs);
      if (input.canonicalWrite) {
        canonicalRevision = await transaction.advanceCanonicalWrite(input.scopeKey, updatedAtMs);
      }
      await transaction.updateMeeting(meetingId, input.scopeKey, {
        ...changes,
        updatedAtMs,
      });
      applied = true;
    });

    const aggregate = await this.repository.get(meetingId, input.scopeKey);
    if (!aggregate) throw new Error('meeting update transaction lost aggregate');
    return { aggregate, applied, canonicalRevision };
  }
}
