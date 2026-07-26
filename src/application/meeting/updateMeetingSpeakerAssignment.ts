import type {
  ApplySpeakerCorrectionResult,
  MeetingNoteRepository,
} from '../../data/repositories';
import {
  assertScopeKey,
  secureClientIdFactory,
  type ClientIdFactory,
  type ScopeKey,
} from '../../domain/meeting';
import { requestMeetingSpeakerCorrectionSync } from './speakerCorrectionSyncTrigger';

const MAX_SPEAKER_NAME_LENGTH = 120;

export class SpeakerAssignmentTargetUnavailableError extends Error {
  constructor() {
    super('speaker assignment target is unavailable');
    this.name = 'SpeakerAssignmentTargetUnavailableError';
  }
}

export class SpeakerAssignmentDraftError extends Error {
  constructor() {
    super('speaker assignment requires a stable transcript revision');
    this.name = 'SpeakerAssignmentDraftError';
  }
}

export interface UpdateMeetingSpeakerAssignmentInput {
  nativeMeetingId: string;
  scopeKey: ScopeKey;
  lineId: string;
  positionMs: number;
  speakerId: string | null;
  scope: 'segment' | 'cluster' | 'future_profile';
  displayName: string;
  speakerProfileId?: string | null;
  consentToProfileUpdate?: boolean;
}

export interface UpdateMeetingSpeakerAssignmentResult extends ApplySpeakerCorrectionResult {
  canonicalMeetingId: string;
}

function normalizedDisplayName(value: string): string {
  const name = value.normalize('NFKC').replace(/[\t ]+/g, ' ').trim();
  if (!name || name.length > MAX_SPEAKER_NAME_LENGTH || /[\u0000-\u001f\u007f]/.test(name)) {
    throw new Error('speaker display name is invalid');
  }
  return name;
}

export class UpdateMeetingSpeakerAssignmentUseCase {
  constructor(
    private readonly repository: MeetingNoteRepository,
    private readonly now: () => number = Date.now,
    private readonly idFactory: ClientIdFactory = secureClientIdFactory,
  ) {}

  async execute(
    input: UpdateMeetingSpeakerAssignmentInput,
  ): Promise<UpdateMeetingSpeakerAssignmentResult> {
    assertScopeKey(input.scopeKey);
    const nativeMeetingId = input.nativeMeetingId.trim();
    const lineId = input.lineId.trim();
    const speakerId = input.speakerId?.trim() || null;
    const speakerProfileId = input.speakerProfileId?.trim() || null;
    const consentToProfileUpdate = input.consentToProfileUpdate === true;
    const displayName = normalizedDisplayName(input.displayName);
    if (!nativeMeetingId || !lineId || !['segment', 'cluster', 'future_profile'].includes(input.scope)) {
      throw new Error('speaker assignment identity is invalid');
    }
    if (
      input.scope === 'future_profile'
      && (input.scopeKey === 'guest' || !speakerProfileId || !consentToProfileUpdate)
    ) {
      throw new Error('future speaker profile assignment is not authorized');
    }
    if (input.scope !== 'future_profile' && (speakerProfileId || consentToProfileUpdate)) {
      throw new Error('meeting-local speaker assignment cannot update a profile');
    }
    if (!Number.isSafeInteger(input.positionMs) || input.positionMs < 0) {
      throw new Error('speaker assignment position is invalid');
    }

    let result: UpdateMeetingSpeakerAssignmentResult | null = null;
    await this.repository.transaction(async transaction => {
      const meeting = await transaction.findMeetingByNativeSessionId(nativeMeetingId, input.scopeKey);
      if (!meeting || meeting.lifecycle === 'deleted') throw new SpeakerAssignmentTargetUnavailableError();
      const transcript = await transaction.getActiveTranscriptContent(meeting.id, input.scopeKey);
      if (!transcript) throw new SpeakerAssignmentTargetUnavailableError();
      if (transcript.revision.kind === 'realtime_draft') throw new SpeakerAssignmentDraftError();

      const exact = transcript.segments.filter(segment => (
        segment.id === lineId || segment.sourceId === lineId
      ));
      const positioned = exact.length === 0
        ? transcript.segments.filter(segment => (
          segment.startMs === input.positionMs
          && (!speakerId || segment.speakerClusterId === speakerId || segment.speakerProfileId === speakerId)
        ))
        : [];
      const target = exact.length === 1
        ? exact[0]
        : positioned.length === 1 ? positioned[0] : null;
      if (!target) throw new SpeakerAssignmentTargetUnavailableError();

      const sourceClusterId = target.speakerClusterId?.trim() || null;
      if (input.scope !== 'segment' && !sourceClusterId) {
        throw new SpeakerAssignmentTargetUnavailableError();
      }
      const affected = input.scope !== 'segment'
        ? transcript.segments.filter(segment => segment.speakerClusterId === sourceClusterId)
        : [target];
      if (affected.length === 0) throw new SpeakerAssignmentTargetUnavailableError();
      const remoteSegmentIds: string[] = [];
      const seenRemoteSegmentIds = new Set<string>();
      let hasCompleteRemoteSegmentIdentity = true;
      for (const segment of affected) {
        const remoteSegmentId = segment.sourceId?.trim() || '';
        if (
          !remoteSegmentId
          || remoteSegmentId.length > 512
          || /[\u0000-\u001f\u007f]/.test(remoteSegmentId)
          || seenRemoteSegmentIds.has(remoteSegmentId)
        ) {
          hasCompleteRemoteSegmentIdentity = false;
          break;
        }
        seenRemoteSegmentIds.add(remoteSegmentId);
        remoteSegmentIds.push(remoteSegmentId);
      }
      const shouldQueueRemoteCorrection = input.scopeKey !== 'guest'
        && hasCompleteRemoteSegmentIdentity;
      if (affected.every(segment => (
        (segment.speakerLabelOverride ?? segment.speakerLabel ?? '').trim() === displayName
        && (
          input.scope !== 'future_profile'
          || segment.speakerProfileId === speakerProfileId
        )
      ))) {
        result = {
          canonicalMeetingId: meeting.id,
          correctionId: '',
          assignmentRevision: 0,
          affectedSegmentIds: affected.map(segment => segment.id),
          applied: false,
        };
        return;
      }

      const createdAtMs = this.now();
      if (!Number.isSafeInteger(createdAtMs) || createdAtMs < 0) {
        throw new Error('speaker assignment clock is invalid');
      }
      const applied = await transaction.applySpeakerCorrection({
        correctionId: this.idFactory.create(),
        assignmentIdPrefix: this.idFactory.create(),
        clusterRecordId: sourceClusterId ? this.idFactory.create() : null,
        meetingId: meeting.id,
        transcriptRevisionId: transcript.revision.id,
        targetSegmentId: target.id,
        sourceClusterId,
        scope: input.scope,
        displayName,
        speakerProfileId,
        consentToProfileUpdate,
        syncState: shouldQueueRemoteCorrection ? 'pending' : 'local_only',
        createdAtMs,
      }, input.scopeKey);
      if (applied.applied) {
        await transaction.markCurrentSummaryStale(meeting.id, input.scopeKey);
        if (shouldQueueRemoteCorrection) {
          const inserted = await transaction.insertOutbox({
            operationId: `speaker-correction:${applied.correctionId}`,
            scopeKey: input.scopeKey,
            aggregateType: 'speaker_correction',
            aggregateId: applied.correctionId,
            operationType: 'speaker_correction.submit',
            baseRevision: applied.assignmentRevision - 1,
            payloadJson: JSON.stringify({
              schema_version: 2,
              meeting_id: meeting.id,
              client_request_id: applied.correctionId,
              local_transcript_revision_id: transcript.revision.id,
              scope: input.scope,
              segment_ids: remoteSegmentIds,
              cluster_id: sourceClusterId,
              speaker_profile_id: speakerProfileId,
              display_name: displayName,
              consent_to_profile_update: consentToProfileUpdate,
              base_revision: applied.assignmentRevision - 1,
            }),
            createdAtMs,
          });
          if (!inserted) throw new Error('speaker correction sync identity already exists');
          await transaction.updateMeeting(meeting.id, input.scopeKey, {
            syncState: 'pending',
            updatedAtMs: Math.max(createdAtMs, meeting.updatedAtMs + 1),
          });
        }
        await transaction.reconcileSpeakerProcessingStage(
          meeting.id,
          input.scopeKey,
          createdAtMs,
        );
      }
      result = { ...applied, canonicalMeetingId: meeting.id };
    });

    if (!result) throw new Error('speaker assignment transaction produced no result');
    const committedResult = result as UpdateMeetingSpeakerAssignmentResult;
    if (committedResult.applied) requestMeetingSpeakerCorrectionSync(input.scopeKey);
    return committedResult;
  }
}
