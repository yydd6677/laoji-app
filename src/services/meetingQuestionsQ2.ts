import * as Crypto from 'expo-crypto';
import type {
  MeetingQuestionCitation,
  MeetingQuestionThread,
  MeetingQuestionTurn,
} from '../domain/meeting';
import { secureClientIdFactory } from '../domain/meeting';
import {
  createQ2Snapshot,
  createQ2Thread,
  findLatestQ2Thread,
  getQ2Thread,
  rebindPendingQ2Turn,
  type Q2CitationInput,
} from '../data/repositories/vnext/questionQ2Repository';
import { ensureDeviceV2Session, loadDeviceV2Capabilities } from './deviceV2Api';
import { ensureRemoteMeetingServiceBinding } from './deviceAuthority';
import {
  createDeviceOperation,
  getDeviceOperation,
  updateDeviceOperation,
} from '../data/repositories/vnext/deviceOperationsRepository';
import {
  buildQ2CandidateSources,
  executeQ2Candidate,
} from './questionQ2Candidate';
import { createDeviceQ2CandidateProvider } from './questionQ2DeviceProvider';
import type { MeetingQuestionEvidence, MeetingQuestionSession } from './meetingQuestions';

const Q2_PROVIDER_REVISION = 'q2-reader-v1';

export class Q2EvidenceChangedError extends Error {
  constructor() {
    super('会议内容已更新，请在新的问答记录中继续。');
    this.name = 'Q2EvidenceChangedError';
  }
}

function normalizedText(value: string, maximum: number): string {
  return value.normalize('NFC').replace(/\r\n?/g, '\n').trim().slice(0, maximum);
}

function excerpt(value: string): string {
  const normalized = normalizedText(value, 220);
  return normalized.length > 180 ? `${normalized.slice(0, 179)}…` : normalized;
}

function transcriptLabel(startMs: number): string {
  const seconds = Math.floor(startMs / 1_000);
  return `文字记录 ${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
}

function utf8Slice(value: string, start: number, end: number): string {
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end <= start) {
    throw new Error('Q2 引用范围无效');
  }
  const bytes = new TextEncoder().encode(value);
  if (end > bytes.length) throw new Error('Q2 引用超出来源范围');
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes.slice(start, end));
  } catch {
    throw new Error('Q2 引用未落在 UTF-8 字符边界');
  }
}

async function sha256(value: string): Promise<string> {
  const digest = await Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, value);
  return `sha256:${digest.toLowerCase()}`;
}

function q2SourceText(evidence: MeetingQuestionEvidence): Map<string, {
  kind: 'transcript' | 'manual_note';
  text: string;
  segmentId?: string;
  startMs?: number;
  endMs?: number;
  manualNoteRevision?: number;
}> {
  const result = new Map<string, {
    kind: 'transcript' | 'manual_note';
    text: string;
    segmentId?: string;
    startMs?: number;
    endMs?: number;
    manualNoteRevision?: number;
  }>();
  for (const segment of evidence.transcript) {
    result.set(segment.segmentId, {
      kind: 'transcript',
      text: segment.text,
      segmentId: segment.segmentId,
      startMs: segment.startMs,
      endMs: segment.endMs,
    });
  }
  if (evidence.includeManualNote && evidence.manualNote !== null && evidence.manualNoteRevision !== null) {
    result.set(`manual_note:${evidence.meetingId}`, {
      kind: 'manual_note',
      text: evidence.manualNote,
      manualNoteRevision: evidence.manualNoteRevision,
    });
  }
  return result;
}

async function citationFromQ2(
  citation: Q2CitationInput,
  evidence: MeetingQuestionEvidence,
  sources: ReturnType<typeof q2SourceText>,
): Promise<MeetingQuestionCitation> {
  const source = sources.get(citation.sourceId);
  if (!source || source.kind !== citation.sourceType) {
    throw new Error('Q2 引用不属于当前会议来源');
  }
  const quote = utf8Slice(source.text, citation.sourceStartUtf8, citation.sourceEndUtf8);
  if (await sha256(quote) !== citation.quoteSha256) throw new Error('Q2 引用校验失败');
  if (source.kind === 'transcript') {
    return {
      id: citation.citationId,
      kind: 'transcript',
      segmentId: source.segmentId!,
      startMs: source.startMs!,
      endMs: source.endMs!,
      sourceLabel: transcriptLabel(source.startMs!),
      sourceExcerpt: excerpt(source.text),
    };
  }
  return {
    id: citation.citationId,
    kind: 'manual_note',
    manualNoteRevision: source.manualNoteRevision!,
    sourceLabel: '我的笔记',
    sourceExcerpt: excerpt(source.text),
  };
}

async function projectThread(
  q2Thread: Awaited<ReturnType<typeof getQ2Thread>>,
  evidence: MeetingQuestionEvidence,
): Promise<MeetingQuestionThread> {
  if (!q2Thread) throw new Error('Q2 问答记录不存在');
  const sources = q2SourceText(evidence);
  const turns: MeetingQuestionTurn[] = [];
  for (const turn of q2Thread.turns) {
    if (turn.completedAtMs === null || turn.answer === null || turn.answerKind === null) continue;
    const citations: MeetingQuestionCitation[] = [];
    const seen = new Set<string>();
    for (const clause of turn.clauses) {
      for (const citation of clause.citations) {
        if (seen.has(citation.citationId)) continue;
        seen.add(citation.citationId);
        citations.push(await citationFromQ2(citation, evidence, sources));
      }
    }
    turns.push({
      id: turn.turnId,
      requestId: turn.requestId,
      remoteTurnId: null,
      ordinal: turn.ordinal,
      question: turn.question,
      answerScope: 'meeting',
      answerKind: turn.answerKind === 'answer' ? 'answer' : 'insufficient',
      answer: turn.answer,
      citations,
      createdAtMs: turn.createdAtMs,
      completedAtMs: turn.completedAtMs,
    });
  }
  return {
    id: q2Thread.threadId,
    meetingId: q2Thread.meetingId,
    inputFingerprint: evidence.sourceFingerprint,
    transcriptRevisionId: evidence.transcriptRevisionId,
    summaryVersionId: null,
    manualNoteRevision: evidence.manualNoteRevision,
    includeManualNote: evidence.includeManualNote,
    createdAtMs: q2Thread.createdAtMs,
    updatedAtMs: q2Thread.updatedAtMs,
    turns,
  };
}

async function assertQ2Capability(): Promise<void> {
  const capabilities = await loadDeviceV2Capabilities();
  if (!capabilities.questionReaderV2) throw new Error('当前版本未开启新版会议问答。');
}

export async function prepareQ2MeetingQuestionSession(input: {
  evidence: MeetingQuestionEvidence;
  forceNew?: boolean;
}): Promise<MeetingQuestionSession> {
  await assertQ2Capability();
  const existingForSources = await findLatestQ2Thread({
    meetingId: input.evidence.meetingId,
    sourceFingerprint: input.evidence.sourceFingerprint,
  });
  const existing = input.forceNew ? null : existingForSources;
  if (existing) {
    return { thread: await projectThread(existing, input.evidence), evidence: input.evidence };
  }
  const sources = await buildQ2CandidateSources(input.evidence);
  const suffix = input.evidence.sourceFingerprint.slice(-20);
  const snapshotId = existingForSources?.snapshotId
    ?? `q2-snapshot:${input.evidence.meetingId}:${suffix}:${secureClientIdFactory.create()}`;
  const threadId = `q2-thread:${input.evidence.meetingId}:${suffix}:${secureClientIdFactory.create()}`;
  if (!existingForSources) {
    await createQ2Snapshot({
      snapshotId,
      meetingId: input.evidence.meetingId,
      sourceFingerprint: input.evidence.sourceFingerprint,
      transcriptRevisionId: input.evidence.transcriptRevisionId,
      sources,
    });
  }
  await createQ2Thread({ threadId, meetingId: input.evidence.meetingId, snapshotId });
  const created = await getQ2Thread(threadId);
  return { thread: await projectThread(created, input.evidence), evidence: input.evidence };
}

export async function askQ2MeetingQuestion(input: {
  session: MeetingQuestionSession;
  evidence: MeetingQuestionEvidence;
  question: string;
}): Promise<MeetingQuestionSession> {
  await assertQ2Capability();
  const question = normalizedText(input.question, 2_001);
  if (!question || question.length > 2_000) throw new Error('请输入不超过 2000 字的问题。');
  if (
    input.session.evidence.sourceFingerprint !== input.evidence.sourceFingerprint
    || input.session.thread.inputFingerprint !== input.evidence.sourceFingerprint
  ) throw new Q2EvidenceChangedError();
  const q2Thread = await getQ2Thread(input.session.thread.id);
  if (!q2Thread) throw new Error('Q2 问答记录不存在');
  const ordinal = q2Thread.turns.length;
  const digest = await sha256(question);
  const requestId = `q2-question:${q2Thread.threadId}:${ordinal}:${digest.slice(-20)}`;
  const turnId = `q2-turn:${q2Thread.threadId}:${ordinal}:${digest.slice(-20)}`;
  const existingTurn = q2Thread.turns.find(turn => turn.requestId === requestId);
  if (!existingTurn || existingTurn.completedAtMs === null) {
    const binding = await ensureRemoteMeetingServiceBinding(input.evidence.meetingId);
    const operationId = `q2-operation:${requestId}:${secureClientIdFactory.create()}`;
    const deviceSession = await ensureDeviceV2Session();
    if (binding.deviceEpochId !== deviceSession.epochId) {
      throw new Error('会议问答设备 epoch 与会议连接不一致');
    }
    const operation = await createDeviceOperation({
      operationId,
      deviceEpochId: deviceSession.epochId,
      capability: 'question_reader_v2',
      entityId: input.evidence.meetingId,
      entityRevision: 1,
      inputSha256: input.evidence.sourceFingerprint,
      generationId: `${q2Thread.snapshotId}:${requestId}:${operationId}`,
    });
    if (existingTurn?.currentOperationId) {
      const rebound = await rebindPendingQ2Turn({
        turnId: existingTurn.turnId,
        expectedOperationId: existingTurn.currentOperationId,
        newOperationId: operationId,
      });
      if (!rebound) throw new Error('Q2 问答正在其他请求中处理');
    }
    if (operation.remoteState !== 'running') {
      await updateDeviceOperation({
        operationId,
        expectedRevision: operation.operationRevision,
        state: 'running',
      });
    }
    try {
      await executeQ2Candidate({
        meetingId: input.evidence.meetingId,
        evidence: input.evidence,
        question,
        provider: createDeviceQ2CandidateProvider(),
        snapshotId: q2Thread.snapshotId,
        threadId: q2Thread.threadId,
        turnId,
        requestId,
        operationId,
        ordinal,
        providerRevision: Q2_PROVIDER_REVISION,
      });
      const finished = await getDeviceOperation(operationId);
      if (finished && finished.remoteState === 'running') {
        await updateDeviceOperation({
          operationId,
          expectedRevision: finished.operationRevision,
          state: 'success',
        });
      }
    } catch (error) {
      const failed = await getDeviceOperation(operationId);
      if (failed && (failed.remoteState === 'queued' || failed.remoteState === 'running')) {
        await updateDeviceOperation({
          operationId,
          expectedRevision: failed.operationRevision,
          state: 'failure',
          errorCode: 'Q2_READER_FAILED',
        });
      }
      throw error;
    }
  }
  const completed = await getQ2Thread(q2Thread.threadId);
  return { thread: await projectThread(completed, input.evidence), evidence: input.evidence };
}
