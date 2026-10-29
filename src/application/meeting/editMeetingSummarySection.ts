import type { MeetingNoteRepository, SummaryCitationRecord, SummarySectionRecord } from "../../data/repositories/meetingNoteRepository";
import type { ScopeKey } from '../../domain/meeting';
import { assertScopeKey } from '../../domain/meeting';

const MAX_SUMMARY_SECTION_LENGTH = 20_000;

export class MeetingSummarySectionUnavailableError extends Error {
  constructor() {
    super('meeting summary section is unavailable');
    this.name = 'MeetingSummarySectionUnavailableError';
  }
}

export class MeetingSummarySectionConflictError extends Error {
  constructor() {
    super('meeting summary section changed');
    this.name = 'MeetingSummarySectionConflictError';
  }
}

export class MeetingSummarySectionContentError extends Error {
  constructor() {
    super('meeting summary section content is invalid');
    this.name = 'MeetingSummarySectionContentError';
  }
}

export interface EditMeetingSummarySectionInput {
  meetingId: string;
  versionId: string;
  sectionId: string;
  content: string | null;
  visibleCitationIds: readonly string[] | null;
  expectedContent: string;
  expectedVisibleCitationIds: readonly string[];
  expectedUserEdited: boolean;
  scopeKey: ScopeKey;
  canonicalWrite?: boolean;
}

export interface EditMeetingSummarySectionResult {
  section: SummarySectionRecord;
  citations: readonly SummaryCitationRecord[];
  applied: boolean;
  restored: boolean;
  canonicalRevision: number | null;
}

function normalizedContent(value: string): string {
  return value.replace(/\r\n?/g, '\n').trim();
}

function validUserContent(value: string): boolean {
  return Boolean(value)
    && value.length <= MAX_SUMMARY_SECTION_LENGTH
    && !value.includes('\u0000');
}

function normalizedCitationIds(values: readonly string[]): string[] {
  const ids = values.map(value => value.trim());
  if (ids.some(id => !id) || new Set(ids).size !== ids.length) {
    throw new MeetingSummarySectionContentError();
  }
  return ids;
}

function sameIds(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

export class EditMeetingSummarySectionUseCase {
  constructor(
    private readonly repository: MeetingNoteRepository,
    private readonly now: () => number = Date.now,
  ) {}

  async execute(input: EditMeetingSummarySectionInput): Promise<EditMeetingSummarySectionResult> {
    assertScopeKey(input.scopeKey);
    const meetingId = input.meetingId.trim();
    const versionId = input.versionId.trim();
    const sectionId = input.sectionId.trim();
    const expectedContent = normalizedContent(input.expectedContent);
    const requestedContent = input.content === null ? null : normalizedContent(input.content);
    const expectedVisibleCitationIds = normalizedCitationIds(input.expectedVisibleCitationIds);
    const requestedVisibleCitationIds = input.visibleCitationIds === null
      ? null
      : normalizedCitationIds(input.visibleCitationIds);
    if (!meetingId || !versionId || !sectionId) throw new MeetingSummarySectionUnavailableError();
    if ((input.content === null) !== (input.visibleCitationIds === null)) {
      throw new MeetingSummarySectionContentError();
    }
    if (input.content !== null && !validUserContent(requestedContent ?? '')) {
      throw new MeetingSummarySectionContentError();
    }

    let result: EditMeetingSummarySectionResult | null = null;
    await this.repository.transaction(async transaction => {
      const meeting = await transaction.getMeeting(meetingId, input.scopeKey);
      const version = await transaction.getCurrentSummaryVersion(meetingId, input.scopeKey);
      const section = await transaction.getSummarySection(sectionId, versionId, input.scopeKey);
      const citations = await transaction.getSummarySectionCitations(sectionId, versionId, input.scopeKey);
      if (
        !meeting
        || meeting.lifecycle === 'deleted'
        || !version
        || version.id !== versionId
        || version.meetingId !== meetingId
        || !section
        || section.versionId !== versionId
      ) throw new MeetingSummarySectionUnavailableError();

      const effectiveContent = normalizedContent(section.userText ?? section.generatedText);
      const allCitationIds = citations.map(citation => citation.id);
      const currentVisibleCitationIds = citations
        .filter(citation => citation.userRemovedAtMs === null)
        .map(citation => citation.id);
      const currentUserEdited = section.userText !== null
        || currentVisibleCitationIds.length !== allCitationIds.length;
      if (
        effectiveContent !== expectedContent
        || !sameIds(currentVisibleCitationIds, expectedVisibleCitationIds)
        || currentUserEdited !== input.expectedUserEdited
      ) throw new MeetingSummarySectionConflictError();

      const generatedContent = normalizedContent(section.generatedText);
      const nextUserText = requestedContent === null || requestedContent === generatedContent
        ? null
        : requestedContent;
      const nextVisibleCitationIds = requestedVisibleCitationIds ?? allCitationIds;
      const allCitationIdSet = new Set(allCitationIds);
      if (nextVisibleCitationIds.some(citationId => !allCitationIdSet.has(citationId))) {
        throw new MeetingSummarySectionContentError();
      }
      const unchanged = section.userText === nextUserText
        && sameIds(currentVisibleCitationIds, nextVisibleCitationIds);
      if (unchanged) {
        result = {
          section,
          citations,
          applied: false,
          restored: nextUserText === null && nextVisibleCitationIds.length === allCitationIds.length,
          canonicalRevision: null,
        };
        return;
      }

      const clockMs = this.now();
      const previousEditMs = Math.max(
        section.userEditedAtMs ?? -1,
        ...citations.map(citation => citation.userRemovedAtMs ?? -1),
      );
      const mutationAtMs = Math.max(clockMs, previousEditMs + 1);
      const editedAtMs = nextUserText === null ? null : mutationAtMs;
      const citationRemovedAtMs = nextVisibleCitationIds.length === allCitationIds.length
        ? null
        : mutationAtMs;
      if (
        !Number.isSafeInteger(clockMs)
        || clockMs < 0
        || !Number.isSafeInteger(mutationAtMs)
        || mutationAtMs < 0
        || (editedAtMs !== null && (!Number.isSafeInteger(editedAtMs) || editedAtMs < 0))
      ) throw new Error('meeting summary section edit clock is invalid');

      const applied = await transaction.updateCurrentSummarySectionUserState(
        meetingId,
        versionId,
        sectionId,
        input.scopeKey,
        nextUserText,
        editedAtMs,
        nextVisibleCitationIds,
        citationRemovedAtMs,
      );
      if (!applied) throw new MeetingSummarySectionConflictError();
      const canonicalRevision = input.canonicalWrite
        ? await transaction.advanceCanonicalWrite(input.scopeKey, mutationAtMs)
        : null;
      const updated = await transaction.getSummarySection(sectionId, versionId, input.scopeKey);
      const updatedCitations = await transaction.getSummarySectionCitations(sectionId, versionId, input.scopeKey);
      if (!updated || updatedCitations.length !== citations.length) {
        throw new MeetingSummarySectionUnavailableError();
      }
      const restored = updated.userText === null
        && updatedCitations.every(citation => citation.userRemovedAtMs === null);
      result = {
        section: updated,
        citations: updatedCitations,
        applied: true,
        restored,
        canonicalRevision,
      };
    });

    if (!result) throw new Error('meeting summary section edit produced no result');
    const committed = result as EditMeetingSummarySectionResult;
    return committed;
  }
}
