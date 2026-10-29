import type {
  ProcessingStageTransition,
  ScopeKey,
  TypedProcessingStage,
} from '../../domain/meeting';
import {
  assertScopeKey,
  transitionProcessingStage,
} from '../../domain/meeting';
import type { MeetingNoteAggregate, MeetingNoteRepository } from "../../data/repositories/meetingNoteRepository";

export interface UpdateProcessingStageInput {
  meetingId: string;
  scopeKey: ScopeKey;
  transition: ProcessingStageTransition;
}

export interface UpdateProcessingStageDependencies {
  repository: MeetingNoteRepository;
  now?: () => number;
}

export class UpdateProcessingStageUseCase {
  private readonly repository: MeetingNoteRepository;
  private readonly now: () => number;

  constructor(dependencies: UpdateProcessingStageDependencies) {
    this.repository = dependencies.repository;
    this.now = dependencies.now ?? Date.now;
  }

  async execute(input: UpdateProcessingStageInput): Promise<MeetingNoteAggregate> {
    assertScopeKey(input.scopeKey);
    const meetingId = input.meetingId.trim();
    if (!meetingId) throw new Error('meeting ID is invalid');
    let updatedStage: TypedProcessingStage | null = null;

    await this.repository.transaction(async transaction => {
      const meeting = await transaction.getMeeting(meetingId, input.scopeKey);
      if (!meeting) throw new Error('meeting does not exist in active scope');
      if (meeting.lifecycle === 'deleted') throw new Error('deleted meeting cannot accept processing work');
      const current = await transaction.getStage(meetingId, input.scopeKey, input.transition.stage);
      if (!current) throw new Error('meeting processing stage is missing');
      const clockMs = this.now();
      if (!Number.isSafeInteger(clockMs) || clockMs < 0) throw new Error('meeting clock is invalid');
      const updatedAtMs = Math.max(clockMs, meeting.updatedAtMs, current.updatedAtMs);
      updatedStage = transitionProcessingStage(current, input.transition, updatedAtMs);
      await transaction.upsertStage(updatedStage, input.scopeKey);

      const patch: Parameters<typeof transaction.updateMeeting>[2] = { updatedAtMs };
      if (
        input.transition.stage === 'capture' &&
        ['preparing', 'recording', 'paused', 'finalizing'].includes(input.transition.status)
      ) {
        patch.lifecycle = 'active';
        if (meeting.startedAtMs === null && input.transition.status === 'recording') {
          patch.startedAtMs = updatedAtMs;
        }
      }
      if (input.transition.stage === 'capture' && input.transition.status === 'local_ready') {
        patch.lifecycle = 'ended';
        patch.endedAtMs = meeting.endedAtMs ?? updatedAtMs;
      }
      await transaction.updateMeeting(meetingId, input.scopeKey, patch);

    });

    if (!updatedStage) throw new Error('meeting processing transition did not run');
    const aggregate = await this.repository.get(meetingId, input.scopeKey);
    if (!aggregate) throw new Error('meeting processing transaction lost aggregate');
    return aggregate;
  }
}
