import type { MeetingNoteRepository } from '../../data/repositories';
import { sqliteMeetingNoteRepository } from '../../data/repositories';
import type {
  ClientIdFactory,
  OccurrenceReference,
  ScopeKey,
} from '../../domain/meeting';
import { assertScopeKey, secureClientIdFactory } from '../../domain/meeting';
import { loadMeetingOccurrenceSyncConflict } from '../../services/meetingOccurrenceConflicts';

export class MeetingOccurrenceSyncConflictChangedError extends Error {
  constructor() {
    super('日程关联状态已变化，请刷新后重试');
    this.name = 'MeetingOccurrenceSyncConflictChangedError';
  }
}

export interface ResolveMeetingOccurrenceSyncConflictUseCaseInput {
  conflictId: string;
  scopeKey: ScopeKey;
  occurrence: OccurrenceReference;
}

export interface ResolveMeetingOccurrenceSyncConflictUseCaseResult {
  localMeetingId: string;
  targetMeetingId: string;
}

export class ResolveMeetingOccurrenceSyncConflictUseCase {
  constructor(
    private readonly repository: MeetingNoteRepository = sqliteMeetingNoteRepository,
    private readonly now: () => number = Date.now,
    private readonly idFactory: ClientIdFactory = secureClientIdFactory,
  ) {}

  async execute(
    input: ResolveMeetingOccurrenceSyncConflictUseCaseInput,
  ): Promise<ResolveMeetingOccurrenceSyncConflictUseCaseResult> {
    assertScopeKey(input.scopeKey);
    if (input.scopeKey === 'guest') throw new Error('访客会议没有云端日程关联冲突');
    const conflictId = input.conflictId.trim();
    if (!conflictId) throw new Error('日程关联冲突标识无效');
    const current = await loadMeetingOccurrenceSyncConflict(
      input.scopeKey,
      input.occurrence,
      this.repository,
    );
    if (!current || current.id !== conflictId) {
      throw new MeetingOccurrenceSyncConflictChangedError();
    }
    if (!current.canResolve || !current.remote || !current.remoteLink) {
      if (current.kind === 'remote_meeting_unavailable') {
        throw new Error('云端会议尚未同步到本机，请稍后重试');
      }
      throw new Error('当前日程关联不能自动处理，请刷新后重试');
    }
    const clock = this.now();
    if (!Number.isSafeInteger(clock) || clock < 0) throw new Error('日程关联处理时间无效');
    const resolvedAtMs = Math.max(
      clock,
      current.createdAtMs + 1,
      current.remoteLink.clientUpdatedAtMs + 1,
    );
    if (!Number.isSafeInteger(resolvedAtMs)) throw new Error('日程关联处理时间溢出');
    const applied = await this.repository.resolveMeetingOccurrenceSyncConflict({
      conflictId,
      meetingId: current.local.id,
      targetMeetingId: current.remote.id,
      detachedHistoryId: this.idFactory.create(),
      scopeKey: input.scopeKey,
      expectedRemotePayloadJson: current.expectedRemotePayloadJson,
      remote: current.remoteLink,
      resolvedAtMs,
    });
    if (!applied) throw new MeetingOccurrenceSyncConflictChangedError();
    return {
      localMeetingId: current.local.id,
      targetMeetingId: current.remote.id,
    };
  }
}

const defaultUseCase = new ResolveMeetingOccurrenceSyncConflictUseCase();

export function resolveMeetingOccurrenceSyncConflict(
  input: ResolveMeetingOccurrenceSyncConflictUseCaseInput,
): Promise<ResolveMeetingOccurrenceSyncConflictUseCaseResult> {
  return defaultUseCase.execute(input);
}
