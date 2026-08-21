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
  findPendingQ2ThreadsForMeeting,
  getQ2Snapshot,
  getQ2Thread,
  Q2ActivationFenceError,
  rebindPendingQ2Turn,
  type Q2ActivationFence,
  type Q2CitationInput,
  type Q2StoredActivationFence,
} from '../data/repositories/vnext/questionQ2Repository';
import { DeviceV2ApiError, ensureDeviceV2Session, loadDeviceV2Capabilities } from './deviceV2Api';
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
import {
  bindQ2DurableTransport,
  createDeviceQ2CandidateProvider,
  q2TransportHandles,
} from './questionQ2DeviceProvider';
import { cancelDeviceV2Task, getDeviceV2Task } from './deviceV2SourceStream';
import { RequestTimeoutError } from './http';
import type { MeetingQuestionEvidence, MeetingQuestionSession } from './meetingQuestions';
import { diagnosticAudit } from './diagnostics';

const Q2_PROVIDER_REVISION = 'q2-reader-v2';

export class Q2EvidenceChangedError extends Error {
  constructor() {
    super('会议内容已更新，请在新的问答记录中继续。');
    this.name = 'Q2EvidenceChangedError';
  }
}

function normalizedText(value: string, maximum: number): string {
  return value.normalize('NFC').replace(/\r\n?/g, '\n').trim().slice(0, maximum);
}

function operationFailureKind(error: unknown): string {
  const message = error instanceof Error ? error.message : '';
  if (/foreign key/i.test(message)) return 'foreign_key';
  if (/unique|constraint/i.test(message)) return 'constraint';
  if (/epoch|连接不可用/.test(message)) return 'binding';
  if (/无效/.test(message)) return 'invalid_identifier';
  if (/创建失败/.test(message)) return 'insert_ignored';
  return 'unknown';
}

function isRecoverableQ2OperationError(error: unknown): boolean {
  if (error instanceof RequestTimeoutError) return true;
  if (error instanceof DeviceV2ApiError) {
    return error.status === 429 || error.status >= 500 || error.code === 'Q2_TASK_BUSY';
  }
  return error instanceof TypeError
    && /network request failed|failed to fetch|networkerror/i.test(error.message);
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
  kind: 'transcript' | 'manual_note' | 'attachment';
  text: string;
  segmentId?: string;
  startMs?: number;
  endMs?: number;
  manualNoteRevision?: number;
  attachmentId?: string;
  attachmentRevisionId?: string;
  positionMs?: number;
}> {
  const result = new Map<string, {
    kind: 'transcript' | 'manual_note' | 'attachment';
    text: string;
    segmentId?: string;
    startMs?: number;
    endMs?: number;
    manualNoteRevision?: number;
    attachmentId?: string;
    attachmentRevisionId?: string;
    positionMs?: number;
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
  for (const attachment of evidence.attachments) {
    result.set(`attachment:${attachment.attachmentId}`, {
      kind: 'attachment',
      text: attachment.text,
      attachmentId: attachment.attachmentId,
      attachmentRevisionId: attachment.revisionId,
      positionMs: attachment.positionMs,
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
  if (source.kind === 'manual_note') return {
    id: citation.citationId,
    kind: 'manual_note',
    manualNoteRevision: source.manualNoteRevision!,
    sourceLabel: '我的笔记',
    sourceExcerpt: excerpt(source.text),
  };
  return {
    id: citation.citationId,
    kind: 'attachment',
    attachmentId: source.attachmentId!,
    attachmentRevisionId: source.attachmentRevisionId!,
    positionMs: source.positionMs!,
    sourceLabel: `附件 · ${transcriptLabel(source.positionMs!).replace('文字记录 ', '')}`,
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

function recoveryFenceCurrent(
  fence: Q2StoredActivationFence,
  evidence: MeetingQuestionEvidence,
  deviceEpochId: string,
  binding: Awaited<ReturnType<typeof ensureRemoteMeetingServiceBinding>>,
): boolean {
  const noteCurrent = fence.manualNote.mode === 'included'
    ? evidence.includeManualNote && evidence.manualNoteRevision === fence.manualNote.revision
    : fence.manualNote.mode === 'absent'
      ? !evidence.hasManualNote
      : !evidence.includeManualNote;
  return noteCurrent
    && fence.attachmentSelectionSha256 === evidence.attachmentSelectionSha256
    && deviceEpochId === fence.deviceEpochId
    && binding.deviceEpochId === fence.deviceEpochId
    && binding.bindingId === fence.bindingId
    && binding.bindingGeneration === fence.bindingGeneration
    && binding.bindingRevision === fence.bindingRevision
    && binding.cancelRevision === fence.bindingCancelRevision;
}

function activationFenceFor(
  evidence: MeetingQuestionEvidence,
  deviceEpochId: string,
  binding: Awaited<ReturnType<typeof ensureRemoteMeetingServiceBinding>>,
): Q2ActivationFence {
  return {
    meetingId: evidence.meetingId,
    sourceFingerprint: evidence.sourceFingerprint,
    transcriptRevisionId: evidence.transcriptRevisionId,
    deviceEpochId,
    bindingId: binding.bindingId,
    bindingGeneration: binding.bindingGeneration,
    bindingRevision: binding.bindingRevision,
    bindingCancelRevision: binding.cancelRevision,
    manualNote: evidence.includeManualNote && evidence.manualNoteRevision !== null
      ? { mode: 'included', revision: evidence.manualNoteRevision }
      : evidence.hasManualNote
        ? { mode: 'excluded' }
        : { mode: 'absent' },
    attachmentSelectionSha256: evidence.attachmentSelectionSha256,
  };
}

async function terminalizeRecoveredOperation(
  operation: NonNullable<Awaited<ReturnType<typeof getDeviceOperation>>>,
  state: 'success' | 'failure' | 'cancelled',
  errorCode: string | null = null,
): Promise<void> {
  if (operation.remoteState === state) return;
  if (operation.remoteState !== 'queued' && operation.remoteState !== 'running') return;
  await updateDeviceOperation({
    operationId: operation.operationId,
    expectedRevision: operation.operationRevision,
    state,
    errorCode,
  });
}

async function recoverCompletedPendingQ2Turn(
  q2Thread: NonNullable<Awaited<ReturnType<typeof getQ2Thread>>>,
  evidence: MeetingQuestionEvidence,
): Promise<typeof q2Thread | null> {
  const pending = [...q2Thread.turns].reverse().find(turn => turn.completedAtMs === null);
  if (!pending) return q2Thread;
  if (!pending.currentOperationId) return null;
  const operation = await getDeviceOperation(pending.currentOperationId);
  if (!operation || operation.remoteState === 'failure' || operation.remoteState === 'cancelled') return null;
  if (!pending.activationFence || !operation.remoteTaskId) {
    await terminalizeRecoveredOperation(operation, 'failure', 'Q2_RECOVERY_FENCE_MISSING');
    return null;
  }
  const [deviceSession, binding] = await Promise.all([
    ensureDeviceV2Session(),
    ensureRemoteMeetingServiceBinding(evidence.meetingId),
  ]);
  if (!recoveryFenceCurrent(pending.activationFence, evidence, deviceSession.epochId, binding)) {
    await terminalizeRecoveredOperation(operation, 'failure', 'Q2_EVIDENCE_CHANGED');
    return null;
  }
  if (
    operation.capability !== 'question_reader_v2'
    || operation.entityId !== evidence.meetingId
    || operation.inputSha256 !== evidence.sourceFingerprint
    || operation.deviceEpochId !== pending.activationFence.deviceEpochId
  ) {
    await terminalizeRecoveredOperation(operation, 'failure', 'Q2_OPERATION_FENCE_INVALID');
    return null;
  }
  const expectedTransport = await q2TransportHandles({
    operationId: operation.operationId,
    snapshotId: q2Thread.snapshotId,
    sourceFingerprint: evidence.sourceFingerprint,
  });
  if (operation.remoteTaskId !== expectedTransport.taskId) {
    await terminalizeRecoveredOperation(operation, 'failure', 'Q2_TASK_FENCE_INVALID');
    return null;
  }
  let remote;
  try {
    remote = await getDeviceV2Task(operation.remoteTaskId);
  } catch (error) {
    // 404 means the process died after the local binding but before remote
    // creation. Replaying the same deterministic identity is safe. A network
    // or server error is not evidence that the Task does not exist.
    if (!(error instanceof DeviceV2ApiError && error.status === 404)) throw error;
    remote = null;
  }
  if (remote && (
    remote.task.capability !== 'question'
    || remote.task.input_sha256 !== evidence.sourceFingerprint
  )) {
    await terminalizeRecoveredOperation(operation, 'failure', 'Q2_TASK_FENCE_INVALID');
    return null;
  }
  if (remote && (remote.task.state === 'failure' || remote.task.state === 'cancelled')) {
    await terminalizeRecoveredOperation(
      operation,
      remote.task.state === 'cancelled' ? 'cancelled' : 'failure',
      remote.task.error_code ?? 'Q2_TASK_FAILED',
    );
    return null;
  }
  // Both `active` and `success` replay through the same provider. Active Tasks
  // resume their existing lease/attempt; successful Tasks return their stored
  // artifact. A 404 recreates the not-yet-created Task with the same ID.
  try {
    await executeQ2Candidate({
      meetingId: evidence.meetingId,
      evidence,
      question: pending.question,
      provider: createDeviceQ2CandidateProvider(),
      snapshotId: q2Thread.snapshotId,
      threadId: q2Thread.threadId,
      turnId: pending.turnId,
      requestId: pending.requestId,
      operationId: operation.operationId,
      activationFence: {
        meetingId: evidence.meetingId,
        sourceFingerprint: evidence.sourceFingerprint,
        transcriptRevisionId: evidence.transcriptRevisionId,
        ...pending.activationFence,
      },
      ordinal: pending.ordinal,
      providerRevision: pending.providerRevision,
    });
  } catch (error) {
    if (error instanceof Q2ActivationFenceError) {
      const changed = await getDeviceOperation(operation.operationId);
      if (changed) await terminalizeRecoveredOperation(changed, 'failure', 'Q2_EVIDENCE_CHANGED');
      return null;
    }
    if (!isRecoverableQ2OperationError(error)) {
      const failed = await getDeviceOperation(operation.operationId);
      if (failed) await terminalizeRecoveredOperation(failed, 'failure', 'Q2_READER_FAILED');
    }
    throw error;
  }
  const currentOperation = await getDeviceOperation(operation.operationId);
  if (currentOperation) await terminalizeRecoveredOperation(currentOperation, 'success');
  return getQ2Thread(q2Thread.threadId);
}

async function reconcilePendingQ2TurnsForMeeting(
  evidence: MeetingQuestionEvidence,
): Promise<void> {
  const pendingThreads = await findPendingQ2ThreadsForMeeting(evidence.meetingId);
  for (const thread of pendingThreads) {
    const pending = [...thread.turns].reverse().find(turn => turn.completedAtMs === null);
    if (!pending?.currentOperationId) continue;
    const operation = await getDeviceOperation(pending.currentOperationId);
    if (!operation || (operation.remoteState !== 'queued' && operation.remoteState !== 'running')) {
      continue;
    }
    const snapshot = await getQ2Snapshot(thread.snapshotId);
    if (!snapshot || !pending.activationFence || !operation.remoteTaskId) {
      await terminalizeRecoveredOperation(operation, 'failure', 'Q2_RECOVERY_FENCE_MISSING');
      continue;
    }
    if (operation.inputSha256 !== snapshot.sourceFingerprint) {
      await terminalizeRecoveredOperation(operation, 'failure', 'Q2_OPERATION_FENCE_INVALID');
      continue;
    }
    const expectedTransport = await q2TransportHandles({
      operationId: operation.operationId,
      snapshotId: thread.snapshotId,
      sourceFingerprint: snapshot.sourceFingerprint,
    });
    if (operation.remoteTaskId !== expectedTransport.taskId) {
      await terminalizeRecoveredOperation(operation, 'failure', 'Q2_TASK_FENCE_INVALID');
      continue;
    }
    if (snapshot.sourceFingerprint !== evidence.sourceFingerprint) {
      // The result may already be terminal on the server, but it belongs to an
      // older immutable source set. Close the local owner without downloading
      // or activating stale answer text.
      await cancelDeviceV2Task(operation.remoteTaskId).catch(() => undefined);
      await terminalizeRecoveredOperation(operation, 'failure', 'Q2_EVIDENCE_CHANGED');
      continue;
    }
    await recoverCompletedPendingQ2Turn(thread, evidence);
  }
}

export async function prepareQ2MeetingQuestionSession(input: {
  evidence: MeetingQuestionEvidence;
  forceNew?: boolean;
}): Promise<MeetingQuestionSession> {
  await assertQ2Capability();
  // Reconcile all unfinished Tasks for the meeting before selecting the thread
  // for today's source fingerprint. Otherwise an attachment/note/transcript
  // edit can strand a successful remote Task forever in local `running`.
  await reconcilePendingQ2TurnsForMeeting(input.evidence);
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
  const pendingTurns = q2Thread.turns.filter(turn => turn.completedAtMs === null);
  const pendingSameQuestion = [...pendingTurns].reverse().find(turn => turn.question === question);
  const pendingOtherQuestion = pendingTurns.find(turn => turn.question !== question);
  if (pendingOtherQuestion && !pendingSameQuestion) {
    throw new Error('上一条会议问答仍在处理中，请等待或重试上一条问题。');
  }
  // A failed provider attempt leaves one immutable pending turn. Retry must
  // reuse its identity and ordinal; deriving a new request from turns.length
  // would create a duplicate question and make rebindPendingQ2Turn unreachable.
  const ordinal = pendingSameQuestion?.ordinal
    ?? q2Thread.turns.reduce((maximum, turn) => Math.max(maximum, turn.ordinal), -1) + 1;
  const digest = await sha256(question);
  const requestId = pendingSameQuestion?.requestId
    ?? `q2-question:${q2Thread.threadId}:${ordinal}:${digest.slice(-20)}`;
  const turnId = pendingSameQuestion?.turnId
    ?? `q2-turn:${q2Thread.threadId}:${ordinal}:${digest.slice(-20)}`;
  const existingTurn = pendingSameQuestion;
  if (!existingTurn || existingTurn.completedAtMs === null) {
    diagnosticAudit('meeting_question_q2_operation', { phase: 'binding' });
    const binding = await ensureRemoteMeetingServiceBinding(input.evidence.meetingId);
    const operationId = `q2-operation:${requestId}:${secureClientIdFactory.create()}`;
    const deviceSession = await ensureDeviceV2Session();
    if (binding.deviceEpochId !== deviceSession.epochId) {
      throw new Error('会议问答设备 epoch 与会议连接不一致');
    }
    const activationFence = activationFenceFor(input.evidence, deviceSession.epochId, binding);
    if (existingTurn?.currentOperationId) {
      const previousOperation = await getDeviceOperation(existingTurn.currentOperationId);
      if (!previousOperation) {
        throw new Error('上一条会议问答缺少可恢复的任务记录，请新建问答记录。');
      }
      if (previousOperation?.remoteState === 'queued' || previousOperation?.remoteState === 'running') {
        throw new Error('上一条会议问答仍在处理中，请等待完成。');
      }
    } else if (existingTurn) {
      throw new Error('上一条会议问答缺少可恢复的任务记录，请新建问答记录。');
    }
    // Operation IDs deliberately carry the thread and question identities.
    // Concatenating snapshot + request + operation again produced a generation
    // string longer than the shared device-operation contract (240 chars), so
    // a real Android question failed before the provider was reached. Preserve
    // the complete identity as a deterministic digest instead of truncating it.
    // Do not use NUL delimiters here. expo-crypto's native Android path treated
    // the first NUL as the end of input, so every retry hashed only snapshotId
    // and collided with the previous generation's unique idempotency key.
    const generationDigest = await sha256(
      JSON.stringify([q2Thread.snapshotId, requestId, operationId]),
    );
    const generationId = `q2-generation:${generationDigest.slice('sha256:'.length)}`;
    diagnosticAudit('meeting_question_q2_operation', {
      phase: 'local_operation',
      operation_id_chars: operationId.length,
      generation_id_chars: generationId.length,
      predecessor: Boolean(existingTurn?.currentOperationId),
    });
    let operation: Awaited<ReturnType<typeof createDeviceOperation>> | null = null;
    let operationPhase = 'create';
    try {
      operation = await createDeviceOperation({
        operationId,
        deviceEpochId: deviceSession.epochId,
        capability: 'question_reader_v2',
        entityId: input.evidence.meetingId,
        entityRevision: 1,
        inputSha256: input.evidence.sourceFingerprint,
        generationId,
        predecessorOperationId: existingTurn?.currentOperationId ?? null,
        creationReason: existingTurn ? 'retry' : 'original',
      });
      diagnosticAudit('meeting_question_q2_operation', { phase: 'local_operation_ready' });
      if (existingTurn?.currentOperationId) {
        operationPhase = 'rebind';
        const rebound = await rebindPendingQ2Turn({
          turnId: existingTurn.turnId,
          expectedOperationId: existingTurn.currentOperationId,
          newOperationId: operationId,
          // A pending turn can survive an APK/provider contract upgrade. Its
          // answer has not been published yet, so the retry must atomically
          // move both the operation owner and the provider revision. Keeping
          // the old revision makes the upgraded reader impossible to reach.
          newProviderRevision: Q2_PROVIDER_REVISION,
          activationFence,
        });
        if (!rebound) throw new Error('Q2 问答正在其他请求中处理');
        diagnosticAudit('meeting_question_q2_operation', { phase: 'retry_bound' });
      }
      operationPhase = 'running';
      if (operation.remoteState !== 'running') {
        const running = await updateDeviceOperation({
          operationId,
          expectedRevision: operation.operationRevision,
          state: 'running',
        });
        if (!running) throw new Error('Q2 问答任务状态已变化');
      }
      diagnosticAudit('meeting_question_q2_operation', { phase: 'provider' });
      operationPhase = 'provider';
      // Persist the deterministic remote Task identity before the pending turn
      // can enter inference. A process death after this point can always poll
      // or recreate exactly this Task; it never has to guess a second ID.
      await bindQ2DurableTransport({
        operationId,
        snapshotId: q2Thread.snapshotId,
        sourceFingerprint: input.evidence.sourceFingerprint,
      });
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
        activationFence,
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
      diagnosticAudit('meeting_question_q2_operation', { phase: 'success' });
    } catch (error) {
      diagnosticAudit('meeting_question_q2_operation', {
        phase: 'failure',
        operation_phase: operationPhase,
        failure_kind: operationFailureKind(error),
        error_name: error instanceof Error ? error.name : 'unknown',
      });
      const failed = operation ? await getDeviceOperation(operationId) : null;
      if (
        failed
        && (failed.remoteState === 'queued' || failed.remoteState === 'running')
        && !isRecoverableQ2OperationError(error)
      ) {
        await updateDeviceOperation({
          operationId,
          expectedRevision: failed.operationRevision,
          state: 'failure',
          errorCode: error instanceof Q2ActivationFenceError
            ? 'Q2_EVIDENCE_CHANGED'
            : 'Q2_READER_FAILED',
        });
      }
      if (error instanceof Q2ActivationFenceError) throw new Q2EvidenceChangedError();
      throw error;
    }
  }
  const completed = await getQ2Thread(q2Thread.threadId);
  return { thread: await projectThread(completed, input.evidence), evidence: input.evidence };
}
