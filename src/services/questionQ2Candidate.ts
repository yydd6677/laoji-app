/**
 * Q2 single-reader candidate adapter.
 *
 * This module is intentionally not selected by the current feature flags. It
 * closes the snapshot/provider/grounding/publication boundary with an
 * injectable transport so semantic holdout work can run without copying the
 * legacy question chain into the new owner.
 */

import * as Crypto from 'expo-crypto';
import {
  appendPendingQ2Turn,
  commitQ2Turn,
  createQ2Snapshot,
  createQ2Thread,
  MAX_Q2_SNAPSHOT_SOURCES,
  type Q2AnswerKind,
  type Q2CitationInput,
  type Q2ClauseInput,
  type Q2SnapshotSource,
} from '../data/repositories/vnext/questionQ2Repository';
import type { MeetingQuestionEvidence } from './meetingQuestions';

export type Q2CandidateSource = Q2SnapshotSource & {
  text: string;
};

export interface Q2CandidateProviderRequest {
  schemaVersion: 2;
  meetingId: string;
  snapshotId: string;
  sourceFingerprint: string;
  providerRevision: string;
  question: string;
  operationId?: string;
  sources: readonly Q2CandidateSource[];
}

export interface Q2CandidateProviderCitation {
  citationId: string;
  sourceType: Q2SnapshotSource['sourceType'];
  sourceId: string;
  sourceRevisionId: string;
  contentSha256: string;
  sourceStartUtf8: number;
  sourceEndUtf8: number;
  quote: string;
}

export interface Q2CandidateProviderClause {
  clauseId: string;
  answerStartUtf8: number;
  answerEndUtf8: number;
  citations: readonly Q2CandidateProviderCitation[];
}

export interface Q2CandidateProviderResponse {
  providerRequestId: string;
  providerRevision: string;
  answerKind: Q2AnswerKind;
  answer: string;
  clauses: readonly Q2CandidateProviderClause[];
}

export interface Q2CandidateExecutionResult {
  snapshotId: string;
  threadId: string;
  turnId: string;
  answerKind: Q2AnswerKind;
  answer: string;
  providerRevision: string;
}

export interface Q2CandidateProvider {
  read(request: Q2CandidateProviderRequest): Promise<Q2CandidateProviderResponse>;
}

function identifier(value: string, field: string, maximum = 512): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > maximum || /[\u0000-\u001f\u007f]/.test(normalized)) {
    throw new Error(`${field} 无效`);
  }
  return normalized;
}

function sha256Pattern(value: string, field: string): string {
  const normalized = value.trim().toLowerCase();
  if (!/^sha256:[0-9a-f]{64}$/.test(normalized)) throw new Error(`${field} 无效`);
  return normalized;
}

function utf8Slice(value: string, start: number, end: number, field: string): string {
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end <= start) {
    throw new Error(`${field}范围无效`);
  }
  const bytes = new TextEncoder().encode(value);
  if (end > bytes.length) throw new Error(`${field}超出来源范围`);
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes.slice(start, end));
  } catch {
    throw new Error(`${field}未落在UTF-8字符边界`);
  }
}

async function sha256Text(value: string): Promise<string> {
  const digest = await Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, value);
  return `sha256:${digest.toLowerCase()}`;
}

async function sourceForTranscript(
  evidence: MeetingQuestionEvidence,
): Promise<Q2CandidateSource[]> {
  return Promise.all(evidence.transcript.map(async segment => ({
    sourceType: 'transcript' as const,
    sourceId: identifier(segment.segmentId, 'sourceId'),
    sourceRevisionId: identifier(evidence.transcriptRevisionId, 'sourceRevisionId'),
    contentSha256: await sha256Text(segment.text),
    text: segment.text,
  })));
}

async function sourceForAuxiliary(
  evidence: MeetingQuestionEvidence,
): Promise<Q2CandidateSource[]> {
  // Q2 is grounded in the current immutable meeting sources.  A generated
  // summary is a derived projection and must never become a hidden second
  // evidence owner or a citation fallback.
  if (!evidence.includeManualNote || evidence.manualNote === null || evidence.manualNoteRevision === null) {
    return [];
  }
  return [
    {
      sourceType: 'manual_note' as const,
      sourceId: `manual_note:${evidence.meetingId}`,
      sourceRevisionId: `manual_note:${evidence.manualNoteRevision}`,
      contentSha256: await sha256Text(evidence.manualNote),
      text: evidence.manualNote,
    },
  ];
}

export async function buildQ2CandidateSources(
  evidence: MeetingQuestionEvidence,
): Promise<Q2CandidateSource[]> {
  const sources = [
    ...(await sourceForTranscript(evidence)),
    ...(await sourceForAuxiliary(evidence)),
  ];
  if (sources.length < 1 || sources.length > MAX_Q2_SNAPSHOT_SOURCES) {
    throw new Error('Q2 来源数量超出当前候选上限');
  }
  return sources;
}

async function validateResponse(
  response: Q2CandidateProviderResponse,
  request: Q2CandidateProviderRequest,
  sources: readonly Q2CandidateSource[],
): Promise<{ answer: string; answerKind: Q2AnswerKind; clauses: Q2ClauseInput[] }> {
  void request;
  const answer = identifier(response.answer, 'answer', 20_000);
  const providerRequestId = identifier(response.providerRequestId, 'providerRequestId', 180);
  const providerRevision = identifier(response.providerRevision, 'providerRevision', 180);
  void providerRequestId;
  void providerRevision;
  if (!['answer', 'not_stated', 'cannot_confirm'].includes(response.answerKind)) {
    throw new Error('Q2 回答类型无效');
  }
  if (response.answerKind !== 'answer') {
    if (response.clauses.length !== 0) throw new Error('未确认回答不能包含引用');
    return { answer, answerKind: response.answerKind, clauses: [] };
  }
  if (response.clauses.length < 1 || response.clauses.length > 32) {
    throw new Error('Q2 回答分句数量无效');
  }
  const sourceMap = new Map(sources.map(source => [
    `${source.sourceType}:${source.sourceId}:${source.sourceRevisionId}:${source.contentSha256}`,
    source,
  ]));
  const clauses: Q2ClauseInput[] = [];
  let previousAnswerEnd = 0;
  for (const clause of response.clauses) {
    const clauseId = identifier(clause.clauseId, 'clauseId', 180);
    if (!Number.isSafeInteger(clause.answerStartUtf8) || !Number.isSafeInteger(clause.answerEndUtf8)
      || clause.answerStartUtf8 < previousAnswerEnd || clause.answerEndUtf8 <= clause.answerStartUtf8) {
      throw new Error('Q2 回答分句范围无效');
    }
    utf8Slice(answer, clause.answerStartUtf8, clause.answerEndUtf8, '回答分句');
    previousAnswerEnd = clause.answerEndUtf8;
    if (clause.citations.length < 1 || clause.citations.length > 8) throw new Error('Q2 分句引用数量无效');
    const citations: Q2CitationInput[] = [];
    for (const citation of clause.citations) {
      const sourceType = citation.sourceType;
      const key = `${sourceType}:${identifier(citation.sourceId, 'sourceId')}:${identifier(citation.sourceRevisionId, 'sourceRevisionId')}:${sha256Pattern(citation.contentSha256, 'contentSha256')}`;
      const source = sourceMap.get(key);
      if (!source) throw new Error('Q2 引用不属于当前来源快照');
      const quote = utf8Slice(source.text, citation.sourceStartUtf8, citation.sourceEndUtf8, '来源引用');
      if (quote !== citation.quote) throw new Error('Q2 引用原文不匹配');
      citations.push({
        citationId: identifier(citation.citationId, 'citationId', 180),
        sourceType,
        sourceId: source.sourceId,
        sourceRevisionId: source.sourceRevisionId,
        contentSha256: source.contentSha256,
        sourceStartUtf8: citation.sourceStartUtf8,
        sourceEndUtf8: citation.sourceEndUtf8,
        quoteSha256: await sha256Text(citation.quote),
      });
    }
    clauses.push({ clauseId, answerStartUtf8: clause.answerStartUtf8, answerEndUtf8: clause.answerEndUtf8, citations });
  }
  if (previousAnswerEnd !== new TextEncoder().encode(answer).length) {
    throw new Error('Q2 回答存在未归因文字');
  }
  return { answer, answerKind: response.answerKind, clauses };
}

export async function executeQ2Candidate(input: {
  meetingId: string;
  evidence: MeetingQuestionEvidence;
  question: string;
  provider: Q2CandidateProvider;
  snapshotId: string;
  threadId: string;
  turnId: string;
  requestId: string;
  operationId: string;
  ordinal: number;
  providerRevision: string;
  nowMs?: number;
}): Promise<Q2CandidateExecutionResult> {
  const meetingId = identifier(input.meetingId, 'meetingId');
  const question = identifier(input.question, 'question', 2_000);
  const sources = await buildQ2CandidateSources(input.evidence);
  const snapshot = await createQ2Snapshot({
    snapshotId: input.snapshotId,
    meetingId,
    sourceFingerprint: input.evidence.sourceFingerprint,
    transcriptRevisionId: input.evidence.transcriptRevisionId,
    sources,
    createdAtMs: input.nowMs,
  });
  await createQ2Thread({
    threadId: input.threadId,
    meetingId,
    snapshotId: snapshot.snapshotId,
    nowMs: input.nowMs,
  });
  const request: Q2CandidateProviderRequest = {
    schemaVersion: 2,
    meetingId,
    snapshotId: snapshot.snapshotId,
    sourceFingerprint: snapshot.sourceFingerprint,
    providerRevision: identifier(input.providerRevision, 'providerRevision', 180),
    question,
    operationId: input.operationId,
    sources,
  };
  await appendPendingQ2Turn({
    turnId: input.turnId,
    threadId: input.threadId,
    requestId: input.requestId,
    operationId: input.operationId,
    ordinal: input.ordinal,
    question,
    providerRevision: request.providerRevision,
    createdAtMs: input.nowMs,
  });
  const response = await input.provider.read(request);
  if (identifier(response.providerRevision, 'providerRevision', 180) !== request.providerRevision) {
    throw new Error('Q2 provider revision 不匹配');
  }
  const validated = await validateResponse(response, request, sources);
  const committed = await commitQ2Turn({
    turnId: input.turnId,
    expectedOperationId: input.operationId,
    answerKind: validated.answerKind,
    answer: validated.answer,
    clauses: validated.clauses,
    completedAtMs: input.nowMs,
  });
  if (!committed) throw new Error('Q2 回答提交发生竞争');
  return {
    snapshotId: snapshot.snapshotId,
    threadId: input.threadId,
    turnId: input.turnId,
    answerKind: validated.answerKind,
    answer: validated.answer,
    providerRevision: identifier(response.providerRevision, 'providerRevision', 180),
  };
}

// Exported for the semantic holdout harness; it has no database or provider side effect.
export { validateResponse as validateQ2CandidateResponse };
