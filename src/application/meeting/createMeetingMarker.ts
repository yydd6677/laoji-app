import type {
  MarkerRecord,
  MeetingNoteRepository,
} from '../../data/repositories';
import type { ScopeKey } from '../../domain/meeting';
import { assertScopeKey, secureClientIdFactory, type ClientIdFactory } from '../../domain/meeting';

const SAFE_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_MARKER_LABEL_LENGTH = 500;

export class MeetingMarkerIdentityConflictError extends Error {
  constructor() {
    super('meeting marker identity already exists');
    this.name = 'MeetingMarkerIdentityConflictError';
  }
}

export interface CreateMeetingMarkerInput {
  meetingId: string;
  scopeKey: ScopeKey;
  positionMs: number;
  label?: string | null;
  markerId?: string;
}

export interface CreateMeetingMarkerResult {
  marker: MarkerRecord;
  applied: boolean;
}

function normalizedMarkerId(value: string | undefined, idFactory: ClientIdFactory): string {
  const markerId = value?.trim() || idFactory.create();
  if (!SAFE_UUID.test(markerId)) throw new Error('meeting marker identity is invalid');
  return markerId.toLowerCase();
}

function normalizedLabel(value: string | null | undefined): string | null {
  if (value == null) return null;
  const label = value.trim();
  if (label.length > MAX_MARKER_LABEL_LENGTH) throw new Error('meeting marker label is too long');
  return label || null;
}

export class CreateMeetingMarkerUseCase {
  constructor(
    private readonly repository: MeetingNoteRepository,
    private readonly now: () => number = Date.now,
    private readonly idFactory: ClientIdFactory = secureClientIdFactory,
  ) {}

  async execute(input: CreateMeetingMarkerInput): Promise<CreateMeetingMarkerResult> {
    assertScopeKey(input.scopeKey);
    const meetingId = input.meetingId.trim();
    const markerId = normalizedMarkerId(input.markerId, this.idFactory);
    const label = normalizedLabel(input.label);
    if (!meetingId) throw new Error('meeting marker identity is invalid');
    if (!Number.isSafeInteger(input.positionMs) || input.positionMs < 0) {
      throw new Error('meeting marker position is invalid');
    }
    let result: CreateMeetingMarkerResult | null = null;

    await this.repository.transaction(async transaction => {
      const meeting = await transaction.getMeeting(meetingId, input.scopeKey);
      if (!meeting || meeting.lifecycle === 'deleted') {
        throw new Error('meeting does not exist in active scope');
      }
      const existing = await transaction.getMeetingMarker(markerId, meetingId, input.scopeKey);
      if (existing) {
        if (
          existing.positionMs !== input.positionMs
          || existing.label !== label
          || existing.kind !== 'important'
        ) throw new MeetingMarkerIdentityConflictError();
        result = { marker: existing, applied: false };
        return;
      }
      const recording = await transaction.getPrimaryRecording(meetingId, input.scopeKey);
      if (recording?.durationMs !== null && recording?.durationMs !== undefined
        && input.positionMs > recording.durationMs) {
        throw new Error('meeting marker position exceeds recording duration');
      }
      const nowMs = this.now();
      if (!Number.isSafeInteger(nowMs) || nowMs < 0) throw new Error('meeting marker clock is invalid');
      const marker: MarkerRecord = {
        id: markerId,
        meetingId,
        positionMs: input.positionMs,
        nearestSegmentId: null,
        label,
        kind: 'important',
        createdAtMs: nowMs,
        updatedAtMs: nowMs,
      };
      const inserted = await transaction.insertMeetingMarker(marker, input.scopeKey);
      if (!inserted) throw new MeetingMarkerIdentityConflictError();
      await transaction.reconcileMeetingMarkers(meetingId, input.scopeKey, nowMs);
      const reconciled = await transaction.getMeetingMarker(markerId, meetingId, input.scopeKey);
      if (!reconciled) throw new Error('meeting marker disappeared during creation');
      result = { marker: reconciled, applied: true };
    });

    if (!result) throw new Error('meeting marker transaction produced no result');
    return result;
  }
}
