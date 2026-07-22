import type { Meeting, MeetingSummary, TranscriptLine } from '../types';
import type {
  MeetingNoteRepository,
  MeetingScopeWriteState,
} from '../data/repositories';
import type { ScopeKey } from '../domain/meeting';
import { assertScopeKey } from '../domain/meeting';
import {
  buildCanonicalMeetingReadProjection,
  type MeetingReadProjection,
} from './meetingReadCutover';

export interface LegacyMeetingProjectionWriter {
  writeMeetings(scopeKey: ScopeKey, meetings: readonly Meeting[]): Promise<void>;
  writeTranscripts(
    scopeKey: ScopeKey,
    transcripts: Readonly<Record<string, readonly TranscriptLine[]>>,
  ): Promise<void>;
  writeSummaries(
    scopeKey: ScopeKey,
    summaries: Readonly<Record<string, MeetingSummary | null>>,
  ): Promise<void>;
}

export interface MirrorCanonicalMeetingScopeInput {
  repository: MeetingNoteRepository;
  writer: LegacyMeetingProjectionWriter;
  scopeKey: ScopeKey;
  force?: boolean;
  maxRevisionRetries?: number;
  now?: () => number;
}

export interface MirrorCanonicalMeetingScopeResult {
  status: 'not_owned' | 'unchanged' | 'clean';
  state: MeetingScopeWriteState;
  projection: MeetingReadProjection | null;
}

function stableOwnedRevision(
  before: MeetingScopeWriteState,
  after: MeetingScopeWriteState,
): boolean {
  return before.writeOwner === 'canonical'
    && after.writeOwner === 'canonical'
    && before.canonicalRevision === after.canonicalRevision;
}

function errorCode(error: unknown): string {
  const name = error instanceof Error ? error.name.trim() : 'UnknownError';
  const code = name.replace(/[^A-Za-z0-9_.-]/g, '_').slice(0, 160);
  return code || 'UnknownError';
}

function validClock(now: () => number): number {
  const value = now();
  if (!Number.isSafeInteger(value) || value < 0) throw new Error('meeting mirror clock is invalid');
  return value;
}

export async function mirrorCanonicalMeetingScopeToLegacy(
  input: MirrorCanonicalMeetingScopeInput,
): Promise<MirrorCanonicalMeetingScopeResult> {
  assertScopeKey(input.scopeKey);
  const now = input.now ?? Date.now;
  const requestedRetries = Math.trunc(input.maxRevisionRetries ?? 3);
  const maxRevisionRetries = Number.isFinite(requestedRetries)
    ? Math.max(1, Math.min(10, requestedRetries))
    : 3;
  let force = Boolean(input.force);

  for (let attempt = 0; attempt < maxRevisionRetries; attempt += 1) {
    const before = await input.repository.getScopeWriteState(input.scopeKey);
    if (before.writeOwner !== 'canonical') {
      return { status: 'not_owned', state: before, projection: null };
    }
    if (
      !force
      && before.legacyMirrorStatus === 'clean'
      && before.legacyMirrorRevision === before.canonicalRevision
    ) return { status: 'unchanged', state: before, projection: null };

    const projection = await buildCanonicalMeetingReadProjection(input.repository, input.scopeKey);
    const afterProjection = await input.repository.getScopeWriteState(input.scopeKey);
    if (!stableOwnedRevision(before, afterProjection)) continue;

    const writes = await Promise.allSettled([
      input.writer.writeMeetings(input.scopeKey, projection.meetings),
      input.writer.writeTranscripts(input.scopeKey, projection.transcripts),
      input.writer.writeSummaries(input.scopeKey, projection.summaries),
    ]);
    const failedWrite = writes.find(result => result.status === 'rejected');
    if (failedWrite?.status === 'rejected') {
      const markedFailed = await input.repository.transaction(transaction => transaction.markLegacyMirror(
        input.scopeKey,
        before.canonicalRevision,
        'failed',
        errorCode(failedWrite.reason),
        validClock(now),
      ));
      if (!markedFailed) {
        // This projection may have partially overwritten a newer clean mirror.
        // Force a complete rewrite of the latest revision before returning.
        force = true;
        continue;
      }
      throw failedWrite.reason;
    }

    const markedClean = await input.repository.transaction(transaction => transaction.markLegacyMirror(
      input.scopeKey,
      before.canonicalRevision,
      'clean',
      null,
      validClock(now),
    ));
    if (!markedClean) {
      force = true;
      continue;
    }
    const state = await input.repository.getScopeWriteState(input.scopeKey);
    if (
      state.writeOwner !== 'canonical'
      || state.canonicalRevision !== before.canonicalRevision
      || state.legacyMirrorRevision !== before.canonicalRevision
      || state.legacyMirrorStatus !== 'clean'
    ) {
      force = true;
      continue;
    }
    return { status: 'clean', state, projection };
  }
  throw new Error('meeting canonical revision changed during legacy mirror');
}
