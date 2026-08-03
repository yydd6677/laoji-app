import * as Crypto from 'expo-crypto';
import {
  askMeetingQuestionRemote,
  requireFreshMeetingCapability,
  type MeetingQuestionRequestWire,
  type MeetingQuestionResponseWire,
} from '../data/api/v2';
import {
  createMeetingQuestionThread,
  findLatestMeetingQuestionThread,
  saveMeetingQuestionTurn,
  sqliteMeetingNoteRepository,
  type SummarySectionRecord,
  type TranscriptSegmentRecord,
} from '../data/repositories';
import {
  secureClientIdFactory,
  type MeetingQuestionCitation,
  type MeetingQuestionThread,
  type MeetingQuestionTurn,
  type ScopeKey,
} from '../domain/meeting';
import { getFeatureFlags } from '../config/featureFlags';

const INSUFFICIENT_ANSWER = '当前会议记录中没有足够信息';
const MAX_CONTEXT_TURNS = 12;

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

export interface MeetingQuestionEvidence {
  meetingId: string;
  remoteMeetingId: string | null;
  inputFingerprint: string;
  transcriptRevisionId: string;
  summaryVersionId: string | null;
  manualNoteRevision: number | null;
  includeManualNote: boolean;
  hasManualNote: boolean;
  transcript: readonly QuestionTranscriptEvidence[];
  summary: readonly QuestionSummaryEvidence[];
  manualNote: string | null;
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

async function loadQuestionEvidence(input: {
  scopeKey: ScopeKey;
  navigationMeetingId: string;
  includeManualNote: boolean;
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
  const summaryItems = summary && ['ready', 'stale'].includes(summary.version.status)
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
  };
  const inputFingerprint = `sha256:${await sha256(stableJson(fingerprintPayload))}`;
  return {
    meetingId,
    remoteMeetingId: aggregate.note.remoteId,
    inputFingerprint,
    transcriptRevisionId: transcript.revision.id,
    summaryVersionId,
    manualNoteRevision,
    includeManualNote,
    hasManualNote,
    transcript: transcriptItems,
    summary: summaryItems,
    manualNote,
  };
}

export async function prepareMeetingQuestionSession(input: {
  scopeKey: ScopeKey;
  navigationMeetingId: string;
  includeManualNote?: boolean;
  forceNew?: boolean;
}): Promise<MeetingQuestionSession> {
  if (!getFeatureFlags().meetingQuestionsV1) {
    throw new MeetingQuestionUnavailableError('当前版本未开启会议问答。');
  }
  const evidence = await loadQuestionEvidence({
    scopeKey: input.scopeKey,
    navigationMeetingId: input.navigationMeetingId,
    includeManualNote: input.includeManualNote === true,
  });
  const existing = input.forceNew ? null : await findLatestMeetingQuestionThread({
    meetingId: evidence.meetingId,
    scopeKey: input.scopeKey,
    inputFingerprint: evidence.inputFingerprint,
    includeManualNote: evidence.includeManualNote,
  });
  if (existing) return { thread: existing, evidence };
  const thread = await createMeetingQuestionThread({
    id: secureClientIdFactory.create(),
    meetingId: evidence.meetingId,
    scopeKey: input.scopeKey,
    inputFingerprint: evidence.inputFingerprint,
    transcriptRevisionId: evidence.transcriptRevisionId,
    summaryVersionId: evidence.summaryVersionId,
    manualNoteRevision: evidence.manualNoteRevision,
    includeManualNote: evidence.includeManualNote,
    createdAtMs: Date.now(),
  });
  return { thread, evidence };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function strictString(value: unknown, label: string, maximum = 512): string {
  if (typeof value !== 'string') throw new Error(`${label}无效`);
  const normalized = normalizedText(value, maximum + 1);
  if (!normalized || normalized.length > maximum || normalized.includes('\u0000')) {
    throw new Error(`${label}无效`);
  }
  return normalized;
}

function strictNullableString(value: unknown, label: string, maximum = 512): string | null {
  return value === null ? null : strictString(value, label, maximum);
}

function strictTime(value: unknown, label: string): number {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0) throw new Error(`${label}无效`);
  return number;
}

function transcriptLabel(startMs: number): string {
  const seconds = Math.floor(startMs / 1_000);
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  return `文字记录 ${String(minutes).padStart(2, '0')}:${String(remainder).padStart(2, '0')}`;
}

function excerpt(value: string): string {
  const normalized = normalizedText(value, 220);
  return normalized.length > 180 ? `${normalized.slice(0, 179)}…` : normalized;
}

function parseQuestionResponse(
  value: unknown,
  request: MeetingQuestionRequestWire,
  evidence: MeetingQuestionEvidence,
): Omit<MeetingQuestionTurn, 'id' | 'citations'> & {
  citations: readonly Omit<MeetingQuestionCitation, 'id'>[];
} {
  if (!isRecord(value) || value.schema_version !== 1) throw new Error('会议问答响应格式无效');
  const response = value as unknown as MeetingQuestionResponseWire;
  if (
    response.client_meeting_id !== request.client_meeting_id
    || response.client_thread_id !== request.client_thread_id
    || response.client_request_id !== request.client_request_id
    || response.ordinal !== request.expected_ordinal
    || response.input_fingerprint !== request.input_fingerprint
    || response.transcript_revision_id !== request.transcript_revision_id
    || response.summary_version_id !== request.summary_version_id
    || response.manual_note_revision !== request.manual_note_revision
  ) {
    throw new Error('服务端返回的问答来源与本次会议不一致，结果未保存。');
  }
  const remoteTurnId = strictNullableString(response.remote_turn_id, '远端问答标识');
  const answerScope = response.answer_scope;
  if (answerScope !== 'meeting' && answerScope !== 'general') {
    throw new Error('问答响应范围无效');
  }
  const answerKind = response.answer_kind;
  if (answerKind !== 'answer' && answerKind !== 'insufficient') {
    throw new Error('会议问答响应状态无效');
  }
  const answer = strictString(response.answer, '会议回答', 20_000);
  if (!Array.isArray(response.citations) || response.citations.length > 20) {
    throw new Error('会议回答引用格式无效');
  }
  const transcriptById = new Map(evidence.transcript.map(item => [item.segmentId, item]));
  const summaryById = new Map(evidence.summary.map(item => [item.sectionId, item]));
  const seen = new Set<string>();
  const citations = response.citations.map(item => {
    if (!isRecord(item)) throw new Error('会议回答引用格式无效');
    const kind = item.kind;
    const sourceId = strictString(item.source_id, '会议回答来源');
    const identity = `${kind}:${sourceId}`;
    if (seen.has(identity)) throw new Error('会议回答包含重复引用');
    seen.add(identity);
    if (kind === 'transcript') {
      const source = transcriptById.get(sourceId);
      if (!source) throw new Error('会议回答引用不属于当前文字记录');
      return {
        kind: 'transcript' as const,
        segmentId: source.segmentId,
        startMs: source.startMs,
        endMs: source.endMs,
        sourceLabel: transcriptLabel(source.startMs),
        sourceExcerpt: excerpt(source.text),
      };
    }
    if (kind === 'summary') {
      const source = summaryById.get(sourceId);
      if (!source) throw new Error('会议回答引用不属于当前整理结果');
      return {
        kind: 'summary' as const,
        sectionId: source.sectionId,
        sourceLabel: source.title || '整理结果',
        sourceExcerpt: excerpt(source.text),
      };
    }
    const expectedId = evidence.manualNoteRevision === null
      ? null
      : `manual-note:${evidence.manualNoteRevision}`;
    if (kind !== 'manual_note' || !expectedId || sourceId !== expectedId || !evidence.manualNote) {
      throw new Error('会议回答引用了未授权的我的笔记');
    }
    return {
      kind: 'manual_note' as const,
      manualNoteRevision: evidence.manualNoteRevision!,
      sourceLabel: '我的笔记',
      sourceExcerpt: excerpt(evidence.manualNote),
    };
  });
  if (answerScope === 'meeting' && answerKind === 'answer' && citations.length === 0) {
    throw new Error('会议回答缺少可定位来源，结果未保存。');
  }
  if (
    answerScope === 'meeting'
    && answerKind === 'insufficient'
    && (answer !== INSUFFICIENT_ANSWER || citations.length !== 0)
  ) {
    throw new Error('会议无来源回答格式无效');
  }
  if (answerScope === 'general' && (answerKind !== 'answer' || citations.length !== 0)) {
    throw new Error('普通问答响应格式无效');
  }
  const createdAtMs = strictTime(response.created_at_ms, '提问时间');
  const completedAtMs = strictTime(response.completed_at_ms, '回答时间');
  if (completedAtMs < createdAtMs) throw new Error('会议问答时间顺序无效');
  return {
    requestId: request.client_request_id,
    remoteTurnId,
    ordinal: request.expected_ordinal,
    question: request.question,
    answerScope,
    answerKind,
    answer,
    citations,
    createdAtMs,
    completedAtMs,
  };
}

function sourceIdForCitation(citation: MeetingQuestionCitation): string {
  if (citation.kind === 'transcript') return citation.segmentId;
  if (citation.kind === 'summary') return citation.sectionId;
  return `manual-note:${citation.manualNoteRevision}`;
}

export async function askMeetingQuestion(input: {
  scopeKey: ScopeKey;
  navigationMeetingId: string;
  session: MeetingQuestionSession;
  question: string;
  accessToken?: string | null;
  signal?: AbortSignal;
}): Promise<MeetingQuestionSession> {
  const question = normalizedText(input.question, 2_001);
  if (!question || question.length > 2_000) throw new Error('请输入不超过 2000 字的问题。');
  const currentEvidence = await loadQuestionEvidence({
    scopeKey: input.scopeKey,
    navigationMeetingId: input.navigationMeetingId,
    includeManualNote: input.session.thread.includeManualNote,
  });
  if (
    currentEvidence.meetingId !== input.session.evidence.meetingId
    || currentEvidence.inputFingerprint !== input.session.thread.inputFingerprint
    || currentEvidence.transcriptRevisionId !== input.session.thread.transcriptRevisionId
    || currentEvidence.summaryVersionId !== input.session.thread.summaryVersionId
    || currentEvidence.manualNoteRevision !== input.session.thread.manualNoteRevision
  ) {
    throw new MeetingQuestionEvidenceChangedError();
  }
  // Guest questions use the public transient endpoint and do not have an
  // account capability token to refresh. Account-scoped questions still
  // require a fresh capability response before sending meeting evidence.
  if (input.scopeKey !== 'guest') {
    await requireFreshMeetingCapability('meetingQuestionsV1', input.accessToken);
  }
  const ordinal = input.session.thread.turns.length;
  const questionDigest = await sha256(question);
  const requestId = `question:${input.session.thread.id}:${ordinal}:${questionDigest.slice(0, 20)}`;
  const context = input.session.thread.turns.slice(-MAX_CONTEXT_TURNS).map(turn => ({
    ordinal: turn.ordinal,
    question: turn.question,
    answer_scope: turn.answerScope,
    answer_kind: turn.answerKind,
    answer: turn.answer,
    citations: turn.citations.map(citation => ({
      kind: citation.kind,
      source_id: sourceIdForCitation(citation),
    })),
  }));
  const request: MeetingQuestionRequestWire = {
    schema_version: 1,
    client_meeting_id: currentEvidence.meetingId,
    client_thread_id: input.session.thread.id,
    client_request_id: requestId,
    expected_ordinal: ordinal,
    input_fingerprint: currentEvidence.inputFingerprint,
    transcript_revision_id: currentEvidence.transcriptRevisionId,
    summary_version_id: currentEvidence.summaryVersionId,
    manual_note_revision: currentEvidence.manualNoteRevision,
    include_manual_note: currentEvidence.includeManualNote,
    question,
    transcript_segments: currentEvidence.transcript.map(segment => ({
      segment_id: segment.segmentId,
      source_segment_id: segment.sourceSegmentId,
      start_ms: segment.startMs,
      end_ms: segment.endMs,
      speaker: segment.speaker,
      text: segment.text,
    })),
    summary_sections: currentEvidence.summary.map(section => ({
      section_id: section.sectionId,
      title: section.title,
      text: section.text,
    })),
    manual_note: currentEvidence.manualNoteRevision !== null && currentEvidence.manualNote !== null
      ? { revision: currentEvidence.manualNoteRevision, content: currentEvidence.manualNote }
      : null,
    context,
  };
  const raw = await askMeetingQuestionRemote({
    request,
    remoteMeetingId: currentEvidence.remoteMeetingId,
    accessToken: input.accessToken,
    // A synced account meeting has an owner-bound server identity. If its
    // token is absent/expired, fail closed instead of sending the full local
    // transcript to the transient guest route. Unsynced account meetings may
    // still use the guest compute path because they have no server identity.
    requiresAuthentication: input.scopeKey !== 'guest' && Boolean(currentEvidence.remoteMeetingId),
    signal: input.signal,
  });
  const parsed = parseQuestionResponse(raw, request, currentEvidence);
  const turnId = `question-turn:${input.session.thread.id}:${ordinal}:${questionDigest.slice(0, 20)}`;
  const turn: MeetingQuestionTurn = {
    ...parsed,
    id: turnId,
    citations: parsed.citations.map((citation, citationOrdinal) => ({
      ...citation,
      id: `${turnId}:citation:${citationOrdinal}`,
    } as MeetingQuestionCitation)),
  };
  const thread = await saveMeetingQuestionTurn({
    threadId: input.session.thread.id,
    meetingId: currentEvidence.meetingId,
    scopeKey: input.scopeKey,
    turn,
  });
  return { thread, evidence: currentEvidence };
}
