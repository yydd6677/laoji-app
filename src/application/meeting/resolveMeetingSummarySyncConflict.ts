import {
  resolveMeetingSummarySyncConflict,
} from '../../data/repositories';
import type { ScopeKey } from '../../domain/meeting';
import { assertScopeKey } from '../../domain/meeting';
import {
  notifyMeetingSummaryChanged,
  requestMeetingSummarySync,
} from './summarySyncTrigger';

export class MeetingSummarySyncConflictChangedError extends Error {
  constructor() {
    super('meeting summary sync conflict changed');
    this.name = 'MeetingSummarySyncConflictChangedError';
  }
}

export class ResolveMeetingSummarySyncConflictUseCase {
  async execute(input: {
    scopeKey: ScopeKey;
    meetingId: string;
    conflictId: string;
    resolution: 'keep_local' | 'use_remote';
  }): Promise<void> {
    assertScopeKey(input.scopeKey);
    if (input.scopeKey === 'guest') throw new MeetingSummarySyncConflictChangedError();
    const applied = await resolveMeetingSummarySyncConflict({
      ...input,
      resolvedAtMs: Date.now(),
    });
    if (!applied) throw new MeetingSummarySyncConflictChangedError();
    notifyMeetingSummaryChanged(input.scopeKey);
    requestMeetingSummarySync(input.scopeKey);
  }
}
