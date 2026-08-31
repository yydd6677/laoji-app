import * as Crypto from 'expo-crypto';
import { sqliteMeetingNoteRepository } from "../data/repositories/sqliteMeetingNoteRepository";
import type { SummarySectionRecord, TranscriptSegmentRecord } from "../data/repositories/meetingNoteRepository";
import {
  type MeetingSummaryAttachmentAuthorization,
  type MeetingQuestionCitation,
  type MeetingQuestionThread,
  type ScopeKey,
} from '../domain/meeting';
import { getActiveAttachmentTextRevision } from '../data/repositories/vnext/immutableSourceRepository';
import { findLatestQ2AttachmentIds } from '../data/repositories/vnext/questionQ2Repository';
import { askQ2MeetingQuestion, prepareQ2MeetingQuestionSession } from './meetingQuestionsQ2';
import { authorizeMeetingQuestionAttachments } from './meetingQuestionAttachments';
import { loadMeetingAttachments } from './meetingAttachments';
import { loadMeetingFactsRecordV3ForVersion } from '../data/repositories/meetingSummaryV3Repository';

type QuestionTranscriptEvidence = {
  segmentId: string;
  sourceSegmentId: string | null;
  startMs: number;
  endMs: number;
  speaker: string | null;
  text: string;
};

type QuestionSummaryEvidence = {
  sectionId: string;
  title: string | null;
  text: string;
};

export type QuestionAttachmentEvidence = {
  attachmentId: string;
  positionMs: number;
  updatedAtMs: number;
  revisionId: string;
  contentSha256: string;
  text: string;
};

export interface MeetingQuestionEvidence {
  meetingId: string;
  inputFingerprint: string;
  /** Fingerprint of immutable question sources only; derived summaries are excluded. */
  sourceFingerprint: string;
  transcriptRevisionId: string;
  summaryVersionId: string | null;
  manualNoteRevision: number | null;
  includeManualNote: boolean;
  hasManualNote: boolean;
  transcript: readonly QuestionTranscriptEvidence[];
  summary: readonly QuestionSummaryEvidence[];
  manualNote: string | null;
  attachments: readonly QuestionAttachmentEvidence[];
  attachmentAuthorization: MeetingSummaryAttachmentAuthorization | null;
  attachmentSelectionSha256: string;
}

export interface MeetingQuestionSession {
  thread: MeetingQuestionThread;
  evidence: MeetingQuestionEvidence;
}

export class MeetingQuestionUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MeetingQuestionUnavailableError';
  }
}

export class MeetingQuestionEvidenceChangedError extends Error {
  constructor() {
    super('会议内容已更新，请在新的问答记录中继续。');
    this.name = 'MeetingQuestionEvidenceChangedError';
  }
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map(key => (
    `${JSON.stringify(key)}:${stableJson(record[key])}`
  )).join(',')}}`;
}

async function sha256(value: string): Promise<string> {
  const digest = await Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, value);
  return digest.toLowerCase();
}

function normalizedText(value: string, maximum: number): string {
  return value.normalize('NFC').replace(/\r\n?/g, '\n').trim().slice(0, maximum);
}

function sectionText(section: SummarySectionRecord): string {
  return normalizedText(section.userText ?? section.generatedText, 20_000);
}

function transcriptEvidence(segment: TranscriptSegmentRecord): QuestionTranscriptEvidence {
  return {
    segmentId: segment.id,
    sourceSegmentId: segment.sourceId,
    startMs: segment.startMs,
    endMs: Math.max(segment.startMs, segment.endMs),
    speaker: segment.speakerLabelOverride ?? segment.speakerLabel,
    text: normalizedText(segment.text, 8_000),
  };
}

async function resolveQuestionAttachments(input: {
  scopeKey: ScopeKey;
  navigationMeetingId: string;
  meetingId: string;
  authorization: MeetingSummaryAttachmentAuthorization | null;
}): Promise<{
  attachments: readonly QuestionAttachmentEvidence[];
  authorization: MeetingSummaryAttachmentAuthorization | null;
}> {
  if (!input.authorization) return { attachments: [], authorization: null };
  const requested = input.authorization.items;
  if (
    requested.length < 1
    || requested.length > 12
    || requested.some(item => item.kind !== 'text')
  ) throw new MeetingQuestionEvidenceChangedError();
  const ids = requested.map(item => item.attachmentId.trim());
  if (ids.some(id => !id) || new Set(ids).size !== ids.length) {
    throw new MeetingQuestionEvidenceChangedError();
  }
  const records = await loadMeetingAttachments(input.scopeKey, input.navigationMeetingId);
  const byId = new Map(records.map(record => [record.id, record]));
  const attachments: QuestionAttachmentEvidence[] = [];
  const canonicalItems = [];
  for (const requestedItem of requested) {
    if (requestedItem.kind !== 'text') throw new MeetingQuestionEvidenceChangedError();
    const record = byId.get(requestedItem.attachmentId);
    const text = normalizedText(record?.textContent ?? '', 2_001);
    if (
      !record
      || record.meetingId !== input.meetingId
      || record.kind !== 'text'
      || !text
      || text.length > 2_000
      || record.positionMs !== requestedItem.positionMs
      || record.updatedAtMs !== requestedItem.updatedAtMs
      || text !== requestedItem.content
    ) throw new MeetingQuestionEvidenceChangedError();
    const immutable = await getActiveAttachmentTextRevision({
      attachmentId: record.id,
      meetingId: input.meetingId,
    });
    if (
      !immutable
      || immutable.content !== text
      || immutable.contentSha256 !== requestedItem.contentSha256
    ) throw new MeetingQuestionEvidenceChangedError();
    attachments.push({
      attachmentId: record.id,
      positionMs: record.positionMs,
      updatedAtMs: record.updatedAtMs,
      revisionId: immutable.revisionId,
      contentSha256: immutable.contentSha256,
      text,
    });
    canonicalItems.push({
      attachmentId: record.id,
      kind: 'text' as const,
      positionMs: record.positionMs,
      content: text,
      contentSha256: immutable.contentSha256,
      updatedAtMs: record.updatedAtMs,
    });
  }
  return {
    attachments,
    authorization: { requestId: input.authorization.requestId, items: canonicalItems },
  };
}

export async function loadQuestionEvidence(input: {
  scopeKey: ScopeKey;
  navigationMeetingId: string;
  includeManualNote: boolean;
  attachmentAuthorization?: MeetingSummaryAttachmentAuthorization | null;
}): Promise<MeetingQuestionEvidence> {
  const meetingId = await sqliteMeetingNoteRepository.resolveCanonicalMeetingId(
    input.navigationMeetingId,
    input.scopeKey,
  );
  if (!meetingId) throw new MeetingQuestionUnavailableError('这场会议的本机内容尚未准备好。');
  const [aggregate, transcript, summary] = await Promise.all([
    sqliteMeetingNoteRepository.get(meetingId, input.scopeKey),
    sqliteMeetingNoteRepository.getActiveTranscriptContent(meetingId, input.scopeKey),
    sqliteMeetingNoteRepository.getCurrentSummaryContent(meetingId, input.scopeKey),
  ]);
  if (!aggregate || aggregate.note.lifecycle === 'deleted') {
    throw new MeetingQuestionUnavailableError('这场会议已不可用。');
  }
  if (
    !transcript
    || transcript.revision.kind === 'realtime_draft'
    || transcript.revision.status !== 'ready'
    || transcript.segments.length === 0
    || transcript.segments.some(segment => !segment.isFinal)
  ) {
    throw new MeetingQuestionUnavailableError('文字记录完成后才能进行会议问答。');
  }
  const transcriptItems = transcript.segments
    .map(transcriptEvidence)
    .filter(segment => Boolean(segment.text));
  if (transcriptItems.length === 0) {
    throw new MeetingQuestionUnavailableError('当前文字记录中没有可用于回答的内容。');
  }
  const summaryFacts = summary
    ? await loadMeetingFactsRecordV3ForVersion(summary.version.id)
    : null;
  const summaryItems = summary
    && summaryFacts?.canonicalMeetingId === meetingId
    && ['ready', 'stale'].includes(summary.version.status)
    ? summary.sections
      .map(section => ({
        sectionId: section.id,
        title: section.title ? normalizedText(section.title, 200) : null,
        text: sectionText(section),
      }))
      .filter(section => Boolean(section.text))
    : [];
  const summaryVersionId = summaryItems.length > 0 ? summary?.version.id ?? null : null;
  const manualNoteContent = normalizedText(aggregate.manualNote.content, 200_000);
  const hasManualNote = Boolean(manualNoteContent);
  const includeManualNote = input.includeManualNote && hasManualNote;
  const manualNoteRevision = includeManualNote ? aggregate.manualNote.revision : null;
  const manualNote = includeManualNote ? manualNoteContent : null;
  const attachmentSelection = await resolveQuestionAttachments({
    scopeKey: input.scopeKey,
    navigationMeetingId: input.navigationMeetingId,
    meetingId,
    authorization: input.attachmentAuthorization ?? null,
  });
  const attachments = attachmentSelection.attachments;
  const fingerprintPayload = {
    schemaVersion: 1,
    meetingId,
    transcriptRevisionId: transcript.revision.id,
    transcript: transcriptItems,
    summaryVersionId,
    summary: summaryItems,
    includeManualNote,
    manualNoteRevision,
    manualNote,
    attachments: attachments.map(attachment => ({
      attachmentId: attachment.attachmentId,
      positionMs: attachment.positionMs,
      updatedAtMs: attachment.updatedAtMs,
      revisionId: attachment.revisionId,
      contentSha256: attachment.contentSha256,
    })),
  };
  const sourceFingerprintSources = [
    ...(await Promise.all(transcriptItems.map(async segment => ({
      source_type: 'transcript' as const,
      source_id: segment.segmentId,
      source_revision_id: transcript.revision.id,
      content_sha256: `sha256:${await sha256(segment.text)}`,
    })))),
    ...(includeManualNote && manualNote !== null && manualNoteRevision !== null
      ? [{
        source_type: 'manual_note' as const,
        source_id: `manual_note:${meetingId}`,
        source_revision_id: String(manualNoteRevision),
        content_sha256: `sha256:${await sha256(manualNote)}`,
      }]
      : []),
    ...attachments.map(attachment => ({
      source_type: 'attachment' as const,
      source_id: `attachment:${attachment.attachmentId}`,
      source_revision_id: attachment.revisionId,
      content_sha256: attachment.contentSha256,
    })),
  ];
  const sourceFingerprintPayload = {
    schema_version: 2,
    sources: sourceFingerprintSources,
  };
  const inputFingerprint = `sha256:${await sha256(stableJson(fingerprintPayload))}`;
  const sourceFingerprint = `sha256:${await sha256(stableJson(sourceFingerprintPayload))}`;
  const attachmentSelectionSha256 = `sha256:${await sha256(stableJson(
    attachments.map(attachment => ({
      attachment_id: attachment.attachmentId,
      source_revision_id: attachment.revisionId,
      content_sha256: attachment.contentSha256,
    })),
  ))}`;
  return {
    meetingId,
    inputFingerprint,
    sourceFingerprint,
    transcriptRevisionId: transcript.revision.id,
    summaryVersionId,
    manualNoteRevision,
    includeManualNote,
    hasManualNote,
    transcript: transcriptItems,
    summary: summaryItems,
    manualNote,
    attachments,
    attachmentAuthorization: attachmentSelection.authorization,
    attachmentSelectionSha256,
  };
}

export async function prepareMeetingQuestionSession(input: {
  scopeKey: ScopeKey;
  navigationMeetingId: string;
  includeManualNote?: boolean;
  attachmentAuthorization?: MeetingSummaryAttachmentAuthorization | null;
  forceNew?: boolean;
}): Promise<MeetingQuestionSession> {
  let evidence = await loadQuestionEvidence({
    scopeKey: input.scopeKey,
    navigationMeetingId: input.navigationMeetingId,
    includeManualNote: input.includeManualNote === true,
    attachmentAuthorization: input.attachmentAuthorization ?? null,
  });
  // An omitted selection means "reopen the latest Q2 source snapshot". An
  // explicit null means the user chose to continue without attachments.
  if (input.attachmentAuthorization === undefined) {
    const previousIds = await findLatestQ2AttachmentIds(evidence.meetingId);
    if (previousIds.length > 0) {
      try {
        const authorization = await authorizeMeetingQuestionAttachments({
          scopeKey: input.scopeKey,
          navigationMeetingId: input.navigationMeetingId,
          attachmentIds: previousIds,
        });
        evidence = await loadQuestionEvidence({
          scopeKey: input.scopeKey,
          navigationMeetingId: input.navigationMeetingId,
          includeManualNote: input.includeManualNote === true,
          attachmentAuthorization: authorization,
        });
      } catch {
        // The old result remains in history, but stale/deleted attachment
        // text must never be silently re-authorized for a new session.
      }
    }
  }
  return prepareQ2MeetingQuestionSession({ evidence, forceNew: input.forceNew });
}

function excerpt(value: string): string {
  const normalized = normalizedText(value, 220);
  return normalized.length > 180 ? `${normalized.slice(0, 179)}…` : normalized;
}

/**
 * Device-first transcript rows have both a local projection ID and the
 * server/device line ID stored as `sourceSegmentId`.  The device question
 * endpoint returns the latter, while account/guest questions normally return
 * the former.  Resolve both aliases to one local canonical segment and mark
 * duplicate aliases unusable instead of guessing between two segments.
 */
function transcriptEvidenceById(
  evidence: MeetingQuestionEvidence,
): Map<string, QuestionTranscriptEvidence | null> {
  const byId = new Map<string, QuestionTranscriptEvidence | null>();
  for (const source of evidence.transcript) {
    for (const id of [source.segmentId, source.sourceSegmentId]) {
      const normalized = id?.trim();
      if (!normalized) continue;
      const previous = byId.get(normalized);
      if (previous && previous.segmentId !== source.segmentId) {
        byId.set(normalized, null);
      } else if (previous === undefined) {
        byId.set(normalized, source);
      }
    }
  }
  return byId;
}

export function isMeetingQuestionCitationCurrent(
  citation: MeetingQuestionCitation,
  evidence: MeetingQuestionEvidence,
): boolean {
  if (citation.kind === 'transcript') {
    const source = transcriptEvidenceById(evidence).get(citation.segmentId);
    return Boolean(
      source
      && source.segmentId === citation.segmentId
      && source.startMs === citation.startMs
      && source.endMs === citation.endMs
      && citation.sourceExcerpt === excerpt(source.text),
    );
  }
  if (citation.kind === 'summary') {
    const source = evidence.summary.find(item => item.sectionId === citation.sectionId);
    return Boolean(source && citation.sourceExcerpt === excerpt(source.text));
  }
  if (citation.kind === 'attachment') {
    const source = evidence.attachments.find(item => item.attachmentId === citation.attachmentId);
    return Boolean(
      source
      && source.revisionId === citation.attachmentRevisionId
      && source.positionMs === citation.positionMs
      && citation.sourceExcerpt === excerpt(source.text),
    );
  }
  return Boolean(
    evidence.includeManualNote
    && evidence.manualNoteRevision === citation.manualNoteRevision
    && evidence.manualNote !== null
    && citation.sourceExcerpt === excerpt(evidence.manualNote),
  );
}

export async function askMeetingQuestion(input: {
  scopeKey: ScopeKey;
  navigationMeetingId: string;
  session: MeetingQuestionSession;
  question: string;
}): Promise<MeetingQuestionSession> {
  const question = normalizedText(input.question, 2_001);
  if (!question || question.length > 2_000) throw new Error('请输入不超过 2000 字的问题。');
  const currentEvidence = await loadQuestionEvidence({
    scopeKey: input.scopeKey,
    navigationMeetingId: input.navigationMeetingId,
    includeManualNote: input.session.thread.includeManualNote,
    attachmentAuthorization: input.session.evidence.attachmentAuthorization,
  });
  return askQ2MeetingQuestion({
    session: input.session,
    evidence: currentEvidence,
    question,
  });
}
