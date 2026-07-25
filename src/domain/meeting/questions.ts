export type MeetingQuestionAnswerKind = 'answer' | 'insufficient';

export type MeetingQuestionCitation =
  | {
    id: string;
    kind: 'transcript';
    segmentId: string;
    startMs: number;
    endMs: number;
    sourceLabel: string;
    sourceExcerpt: string;
  }
  | {
    id: string;
    kind: 'summary';
    sectionId: string;
    sourceLabel: string;
    sourceExcerpt: string;
  }
  | {
    id: string;
    kind: 'manual_note';
    manualNoteRevision: number;
    sourceLabel: string;
    sourceExcerpt: string;
  };

export interface MeetingQuestionTurn {
  id: string;
  requestId: string;
  remoteTurnId: string | null;
  ordinal: number;
  question: string;
  answerKind: MeetingQuestionAnswerKind;
  answer: string;
  citations: readonly MeetingQuestionCitation[];
  createdAtMs: number;
  completedAtMs: number;
}

export interface MeetingQuestionThread {
  id: string;
  meetingId: string;
  inputFingerprint: string;
  transcriptRevisionId: string;
  summaryVersionId: string | null;
  manualNoteRevision: number | null;
  includeManualNote: boolean;
  createdAtMs: number;
  updatedAtMs: number;
  turns: readonly MeetingQuestionTurn[];
}
