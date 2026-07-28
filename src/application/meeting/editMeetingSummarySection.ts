import type {
  MeetingNoteRepository,
  SummarySectionRecord,
} from '../../data/repositories';
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
  expectedContent: string;
  expectedUserEdited: boolean;
  scopeKey: ScopeKey;
  canonicalWrite?: boolean;
}

export interface EditMeetingSummarySectionResult {
  section: SummarySectionRecord;
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
    if (!meetingId || !versionId || !sectionId) throw new MeetingSummarySectionUnavailableError();
    if (input.content !== null && !validUserContent(requestedContent ?? '')) {
      throw new MeetingSummarySectionContentError();
    }

    let result: EditMeetingSummarySectionResult | null = null;
    await this.repository.transaction(async transaction => {
      const meeting = await transaction.getMeeting(meetingId, input.scopeKey);
      const version = await transaction.getCurrentSummaryVersion(meetingId, input.scopeKey);
      const section = await transaction.getSummarySection(sectionId, versionId, input.scopeKey);
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
      if (
        effectiveContent !== expectedContent
        || (section.userText !== null) !== input.expectedUserEdited
      ) throw new MeetingSummarySectionConflictError();

      const generatedContent = normalizedContent(section.generatedText);
      const nextUserText = requestedContent === null || requestedContent === generatedContent
        ? null
        : requestedContent;
      const unchanged = section.userText === nextUserText;
      if (unchanged) {
        result = {
          section,
          applied: false,
          restored: nextUserText === null,
          canonicalRevision: null,
        };
        return;
      }

      const clockMs = this.now();
      const previousEditMs = section.userEditedAtMs ?? -1;
      const editedAtMs = nextUserText === null ? null : Math.max(clockMs, previousEditMs + 1);
      if (
        !Number.isSafeInteger(clockMs)
        || clockMs < 0
        || (editedAtMs !== null && (!Number.isSafeInteger(editedAtMs) || editedAtMs < 0))
      ) throw new Error('meeting summary section edit clock is invalid');

      const applied = await transaction.updateCurrentSummarySectionUserText(
        meetingId,
        versionId,
        sectionId,
        input.scopeKey,
        nextUserText,
        editedAtMs,
      );
      if (!applied) throw new MeetingSummarySectionConflictError();
      const canonicalRevision = input.canonicalWrite
        ? await transaction.advanceCanonicalWrite(input.scopeKey, clockMs)
        : null;
      const updated = await transaction.getSummarySection(sectionId, versionId, input.scopeKey);
      if (!updated) throw new MeetingSummarySectionUnavailableError();
      result = {
        section: updated,
        applied: true,
        restored: nextUserText === null,
        canonicalRevision,
      };
    });

    if (!result) throw new Error('meeting summary section edit produced no result');
    return result;
  }
}
