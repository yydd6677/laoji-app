import {
  getDeviceV2Task,
  getDeviceV2SourceStream,
  DeviceV2SourceStreamUnavailableError,
  appendDeviceV2SourceBundle,
  appendDeviceV2SourceManifestPage,
  commitDeviceV2SourceBundleGroup,
  createDeviceV2SourceBundleGroup,
  createDeviceV2SourceStream,
  type SourceStreamSourceType,
} from './deviceV2SourceStream';
import { DeviceV2ApiError, deviceV2Request, loadDeviceV2Capabilities } from './deviceV2Api';
import { ensureRemoteMeetingServiceBinding } from './deviceAuthority';
import { RequestTimeoutError } from './http';
import {
  getDeviceOperation,
  updateDeviceOperation,
} from '../data/repositories/vnext/deviceOperationsRepository';
import type {
  Q2Provider,
  Q2ProviderRequest,
  Q2ProviderResponse,
} from './questionQ2Execution';
import * as Crypto from 'expo-crypto';

export const Q2_READER_PROVIDER_REVISION = 'q2-reader-v2';
const MAX_STREAM_BUNDLES = 8;
// A 57-minute source stream completed successfully at the server roughly one
// second after the former 120-second mobile recovery window expired. Keep the
// durable task recoverable through transient generation/queue variance without
// starting a duplicate question operation.
const Q2_TASK_RECOVERY_TIMEOUT_MS = 240_000;
const Q2_TASK_POLL_INTERVAL_MS = 1_000;

function required(value: unknown, field: string, maximum = 512): string {
  if (typeof value !== 'string') throw new Error(`${field}无效`);
  const normalized = value.trim();
  if (!normalized || normalized.length > maximum || /[\u0000-\u001f\u007f]/.test(normalized)) {
    throw new Error(`${field}无效`);
  }
  return normalized;
}

function sourceType(value: unknown): SourceStreamSourceType {
  const normalized = required(value, 'source_type', 32);
  if (!['transcript', 'manual_note', 'attachment'].includes(normalized)) {
    throw new Error('source_type无效');
  }
  return normalized as SourceStreamSourceType;
}

function normalizeResponse(value: any, request: Q2ProviderRequest): Q2ProviderResponse {
  if (!value || Number(value.schema_version) !== 2 || value.contract_revision !== 'question.reader.v2') {
    throw new Error('Q2 reader 响应格式无效');
  }
  if (value.provider_revision !== request.providerRevision) throw new Error('Q2 reader revision 不匹配');
  const answerKind = value.answer_kind;
  if (!['answer', 'not_stated', 'cannot_confirm'].includes(answerKind)) throw new Error('Q2 回答类型无效');
  const answer = required(value.answer, 'answer', 20_000);
  if (!Array.isArray(value.clauses)) throw new Error('Q2 分句格式无效');
  return {
    providerRequestId: request.snapshotId,
    providerRevision: request.providerRevision,
    answerKind,
    answer,
    clauses: value.clauses.map((clause: any) => ({
      clauseId: required(clause?.clause_id, 'clause_id', 180),
      answerStartUtf8: Number(clause?.answer_start_utf8),
      answerEndUtf8: Number(clause?.answer_end_utf8),
      citations: Array.isArray(clause?.citations) ? clause.citations.map((citation: any) => ({
        citationId: required(citation?.citation_id, 'citation_id', 180),
        sourceType: sourceType(citation?.source_type),
        sourceId: required(citation?.source_id, 'source_id', 512),
        sourceRevisionId: required(citation?.source_revision_id, 'source_revision_id', 512),
        contentSha256: required(citation?.content_sha256, 'content_sha256', 71),
        sourceStartUtf8: Number(citation?.source_start_utf8),
        sourceEndUtf8: Number(citation?.source_end_utf8),
        quote: required(citation?.quote, 'quote', 600),
      })) : [],
    })),
  };
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map(key => `${JSON.stringify(key)}:${stableJson(record[key])}`).join(',')}}`;
}

async function digest(value: unknown): Promise<string> {
  const hash = await Crypto.digestStringAsync(
    Crypto.CryptoDigestAlgorithm.SHA256,
    typeof value === 'string' ? value : stableJson(value),
  );
  return `sha256:${hash.toLowerCase()}`;
}

export async function q2TransportHandles(
  request: Pick<Q2ProviderRequest, 'operationId' | 'snapshotId' | 'sourceFingerprint'>,
): Promise<{ taskId: string; streamId: string; transportSeed: string }> {
  if (!request.operationId) throw new Error('Q2 operation identity is required for durable transport');
  const transportDigest = await digest({
    operation_id: request.operationId,
    snapshot_id: request.snapshotId,
    source_fingerprint: request.sourceFingerprint,
  });
  const transportSeed = transportDigest.slice('sha256:'.length);
  return {
    taskId: `q2-task:${transportSeed}`,
    streamId: `q2-source-stream:${transportSeed}`,
    transportSeed,
  };
}

async function bindRemoteTaskToOperation(operationId: string, taskId: string): Promise<void> {
  const operation = await getDeviceOperation(operationId);
  if (!operation || operation.capability !== 'question_reader_v2') {
    throw new Error('Q2 durable operation is unavailable');
  }
  if (operation.remoteTaskId === taskId) return;
  if (operation.remoteTaskId !== null) throw new Error('Q2 operation is already bound to another task');
  const updated = await updateDeviceOperation({
    operationId,
    expectedRevision: operation.operationRevision,
    state: operation.remoteState ?? 'running',
    remoteTaskId: taskId,
  });
  if (!updated || updated.remoteTaskId !== taskId) {
    throw new Error('Q2 durable task binding changed concurrently');
  }
}

export async function bindQ2DurableTransport(
  request: Pick<Q2ProviderRequest, 'operationId' | 'snapshotId' | 'sourceFingerprint'>,
): Promise<{ taskId: string; streamId: string }> {
  const handles = await q2TransportHandles(request);
  await bindRemoteTaskToOperation(request.operationId!, handles.taskId);
  return { taskId: handles.taskId, streamId: handles.streamId };
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function retryableReaderError(error: unknown): boolean {
  return error instanceof RequestTimeoutError || (
    error instanceof DeviceV2ApiError
    && (error.code === 'Q2_TASK_BUSY' || error.status === 429 || error.status >= 500)
  );
}

async function recoverQuestionTask(
  taskId: string,
  request: Q2ProviderRequest,
  runAttempt: () => Promise<Q2ProviderResponse>,
): Promise<Q2ProviderResponse> {
  const deadline = Date.now() + Q2_TASK_RECOVERY_TIMEOUT_MS;
  let lastError: unknown = null;
  let claimedRetryKey: string | null = null;
  while (Date.now() < deadline) {
    try {
      const snapshot = await getDeviceV2Task(taskId);
      if (snapshot.task.capability !== 'question' || snapshot.task.input_sha256 !== request.sourceFingerprint) {
        throw new DeviceV2ApiError('会议问答任务来源不匹配', 409, 'Q2_TASK_FENCE_INVALID');
      }
      if (snapshot.task.state === 'success') {
        if (!snapshot.task.result || typeof snapshot.task.result !== 'object' || Array.isArray(snapshot.task.result)) {
          throw new DeviceV2ApiError('会议问答任务结果无效', 502, 'Q2_TASK_RESULT_INVALID');
        }
        return normalizeResponse(snapshot.task.result, request);
      }
      if (snapshot.task.state === 'failure' || snapshot.task.state === 'cancelled') {
        throw new DeviceV2ApiError(
          snapshot.task.state === 'cancelled' ? '会议问答任务已取消' : '会议问答任务失败',
          409,
          snapshot.task.error_code ?? 'Q2_TASK_FAILED',
        );
      }
      const retryAt = snapshot.task.retry_not_before_epoch;
      if (snapshot.task.error_code && retryAt !== null) {
        const waitMs = Math.max(0, Math.ceil(retryAt * 1_000 - Date.now()));
        if (waitMs > 0) {
          await delay(Math.min(waitMs, Q2_TASK_POLL_INTERVAL_MS));
          continue;
        }
        const retryKey = `${snapshot.task.error_code}:${retryAt}`;
        if (claimedRetryKey !== retryKey) {
          claimedRetryKey = retryKey;
          try {
            return await runAttempt();
          } catch (error) {
            if (!retryableReaderError(error)) throw error;
            lastError = error;
          }
        }
      }
      lastError = null;
    } catch (error) {
      if (error instanceof DeviceV2ApiError && error.status >= 400 && error.status < 500) throw error;
      lastError = error;
    }
    await delay(Q2_TASK_POLL_INTERVAL_MS);
  }
  if (lastError instanceof Error) throw lastError;
  throw new DeviceV2ApiError('会议问答仍在处理中，请稍后重试', 504, 'Q2_TASK_TIMEOUT');
}

async function readExistingDurableTask(
  request: Q2ProviderRequest,
): Promise<
  | { kind: 'result'; response: Q2ProviderResponse }
  | { kind: 'active'; taskId: string; streamId: string }
  | null
> {
  if (!request.operationId) return null;
  const { taskId } = await q2TransportHandles(request);
  try {
    const snapshot = await getDeviceV2Task(taskId);
    if (snapshot.task.capability !== 'question' || snapshot.task.input_sha256 !== request.sourceFingerprint) {
      throw new DeviceV2ApiError('会议问答任务来源不匹配', 409, 'Q2_TASK_FENCE_INVALID');
    }
    if (snapshot.task.state === 'success') {
      if (!snapshot.task.result || typeof snapshot.task.result !== 'object' || Array.isArray(snapshot.task.result)) {
        throw new DeviceV2ApiError('会议问答任务结果无效', 502, 'Q2_TASK_RESULT_INVALID');
      }
      return { kind: 'result', response: normalizeResponse(snapshot.task.result, request) };
    }
    if (snapshot.task.state === 'failure' || snapshot.task.state === 'cancelled') {
      throw new DeviceV2ApiError(
        snapshot.task.state === 'cancelled' ? '会议问答任务已取消' : '会议问答任务失败',
        409,
        snapshot.task.error_code ?? 'Q2_TASK_FAILED',
      );
    }
    if (!snapshot.task.source_stream_id) {
      throw new DeviceV2ApiError('会议问答任务缺少可恢复来源', 409, 'Q2_SOURCE_STREAM_MISSING');
    }
    return {
      kind: 'active',
      taskId,
      streamId: snapshot.task.source_stream_id,
    };
  } catch (error) {
    if (error instanceof DeviceV2ApiError && error.status === 404) return null;
    throw error;
  }
}

async function readFromSourceStream(
  request: Q2ProviderRequest,
  binding: Awaited<ReturnType<typeof ensureRemoteMeetingServiceBinding>>,
  stream: { taskId: string; streamId: string },
): Promise<Q2ProviderResponse> {
  const runAttempt = async (): Promise<Q2ProviderResponse> => {
    const value = await deviceV2Request<any>(
      `/meetings/${encodeURIComponent(binding.bindingId)}/questions-v2`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          schema_version: 2,
          contract_revision: 'question.reader.v2',
          provider_revision: request.providerRevision,
          snapshot_id: request.snapshotId,
          source_fingerprint: request.sourceFingerprint,
          question: request.question,
          binding_generation: binding.bindingGeneration,
          binding_revision: binding.bindingRevision,
          cancel_revision: binding.cancelRevision,
          task_id: stream.taskId,
          source_stream_id: stream.streamId,
          sources: [],
        }),
      },
      '会议问答服务暂时不可用',
    );
    return normalizeResponse(value, request);
  };
  try {
    return await runAttempt();
  } catch (error) {
    // The Task exists before inference. Timeouts, concurrent leases and
    // server-marked retryable attempts all stay on that exact Task. Once the
    // server's retry fence opens, POSTing again claims the next attempt rather
    // than creating a second question lifecycle.
    if (!retryableReaderError(error)) throw error;
    return recoverQuestionTask(stream.taskId, request, runAttempt);
  }
}

async function streamLongSources(
  request: Q2ProviderRequest,
  binding: Awaited<ReturnType<typeof ensureRemoteMeetingServiceBinding>>,
): Promise<{ taskId: string; streamId: string }> {
  // Android operation IDs deliberately retain their full predecessor lineage,
  // so they are valid business identities but can exceed transport bounds.
  // Derive compact, deterministic source-stream handles without truncating or
  // weakening the full operation identity used by the local durable task.
  const { taskId, streamId, transportSeed } = await q2TransportHandles(request);
  await bindRemoteTaskToOperation(request.operationId!, taskId);
  const items = request.sources.map((source, index) => {
    const contentBytes = new TextEncoder().encode(source.text).byteLength;
    return {
      // item_id is a transport-local handle. Do not embed the opaque Android
      // source identity here: a valid stable transcript ID can be over 200
      // characters while source.stream.v2 intentionally caps item IDs at 180.
      item_id: `q2-item:${index}:${source.contentSha256.slice(-20)}`,
      source_type: source.sourceType,
      source_id: source.sourceId,
      source_revision_id: source.sourceRevisionId,
      source_start_utf8: 0,
      source_end_utf8: contentBytes,
      content_sha256: source.contentSha256,
      content: source.text,
      start_ms: null,
      end_ms: null,
      speaker: null,
    };
  });
  const bundleSize = Math.max(1, Math.ceil(items.length / MAX_STREAM_BUNDLES));
  const bundles = [];
  for (let offset = 0; offset < items.length; offset += bundleSize) {
    const chunk = items.slice(offset, offset + bundleSize);
    const material = chunk.map(item => ({
      item_id: item.item_id,
      source_type: item.source_type,
      source_id: item.source_id,
      source_revision_id: item.source_revision_id,
      source_start_utf8: item.source_start_utf8,
      source_end_utf8: item.source_end_utf8,
      content_sha256: item.content_sha256,
      content_bytes: new TextEncoder().encode(item.content).byteLength,
      start_ms: item.start_ms,
      end_ms: item.end_ms,
      speaker: item.speaker,
    }));
    bundles.push({
      ordinal: bundles.length,
      items: chunk,
      hash: await digest(material),
      bytes: chunk.reduce((total, item) => total + new TextEncoder().encode(item.content).byteLength, 0),
    });
  }
  if (bundles.length > MAX_STREAM_BUNDLES) throw new Error('会议来源过长，暂时无法创建问答来源流。');
  const chapterHash = await digest(bundles.map(bundle => bundle.hash));
  const declaredBytes = bundles.reduce((total, bundle) => total + bundle.bytes, 0);
  await createDeviceV2SourceStream({
    bindingId: binding.bindingId,
    bindingGeneration: binding.bindingGeneration,
    bindingRevision: binding.bindingRevision,
    cancelRevision: binding.cancelRevision,
    taskId,
    streamId,
    clientOperationId: `q2-operation:${transportSeed}`,
    generationId: `q2-generation:${transportSeed}`,
    requestSha256: request.sourceFingerprint,
    taskInputSha256: request.sourceFingerprint,
    capability: 'question',
    entityId: request.meetingId,
    entityRevision: 1,
  });
  try {
    const descriptor = {
      chapter_ordinal: 0,
      declared_bundle_count: bundles.length,
      declared_item_count: items.length,
      declared_uncompressed_bytes: declaredBytes,
      chapter_sha256: chapterHash,
    };
    await appendDeviceV2SourceManifestPage({
      streamId,
      pageSeq: 0,
      firstChapterOrdinal: 0,
      descriptors: [descriptor],
      pageSha256: await digest([descriptor]),
      finalPage: true,
    });
    const group = await createDeviceV2SourceBundleGroup({
      streamId,
      group: {
        groupId: `${streamId}:group:0`,
        chapterOrdinal: 0,
        declaredBundleCount: bundles.length,
        declaredItemCount: items.length,
        declaredUncompressedBytes: declaredBytes,
        chapterSha256: chapterHash,
        requestSha256: request.sourceFingerprint,
      },
    });
    for (const bundle of bundles) {
      await appendDeviceV2SourceBundle({
        groupId: group.group_id,
        bundle: {
          bundleId: `${streamId}:bundle:${bundle.ordinal}`,
          ordinal: bundle.ordinal,
          bundleSha256: bundle.hash,
          items: bundle.items,
        },
      });
    }
    await commitDeviceV2SourceBundleGroup(group.group_id);
    return { taskId, streamId };
  } catch (error) {
    if (q2SourceStreamFailureIsTerminal(error)) {
      try {
        const { cancelDeviceV2SourceStream } = await import('./deviceV2SourceStream');
        await cancelDeviceV2SourceStream(streamId);
      } catch {
        // The deterministic client/contract failure remains visible even when
        // best-effort remote cancellation cannot be delivered.
      }
    }
    throw error;
  }
}

/**
 * Network loss, timeouts, throttling and server faults leave the durable
 * source stream open so the same operation can replay its idempotent pages and
 * bundles. Only deterministic client/contract failures should cancel it.
 */
export function q2SourceStreamFailureIsTerminal(error: unknown): boolean {
  if (error instanceof RequestTimeoutError) return false;
  if (error instanceof DeviceV2ApiError) {
    return error.status >= 400
      && error.status < 500
      && error.status !== 408
      && error.status !== 429;
  }
  if (
    error instanceof TypeError
    && /network request failed|failed to fetch|networkerror/i.test(error.message)
  ) return false;
  return true;
}

export class DeviceQ2Provider implements Q2Provider {
  async read(request: Q2ProviderRequest): Promise<Q2ProviderResponse> {
    const capabilities = await loadDeviceV2Capabilities();
    if (!capabilities.questionReaderV2) throw new DeviceV2SourceStreamUnavailableError();
    const replay = await readExistingDurableTask(request);
    if (replay?.kind === 'result') return replay.response;
    const binding = await ensureRemoteMeetingServiceBinding(request.meetingId);
    // Every Q2 request uses the generic Task/source-stream owner. A direct
    // reader call cannot be resumed after Android process death and would
    // create a second lifecycle for short meetings.
    const shouldStream = request.sources.length > 0;
    if (shouldStream) {
      if (!capabilities.sourceStreamV2) throw new DeviceV2SourceStreamUnavailableError();
      let stream: { taskId: string; streamId: string };
      if (replay?.kind === 'active') {
        const sourceStream = await getDeviceV2SourceStream(replay.streamId);
        if (
          sourceStream.task_id !== replay.taskId
          || sourceStream.capability !== 'question'
          || sourceStream.binding_id !== binding.bindingId
          || sourceStream.binding_generation !== binding.bindingGeneration
          || sourceStream.binding_revision !== binding.bindingRevision
          || sourceStream.cancel_revision !== binding.cancelRevision
        ) {
          throw new DeviceV2ApiError('会议问答来源流身份不匹配', 409, 'Q2_SOURCE_STREAM_FENCE_INVALID');
        }
        if (sourceStream.state === 'complete') {
          stream = { taskId: replay.taskId, streamId: replay.streamId };
        } else if (sourceStream.state === 'open' || sourceStream.state === 'consuming') {
          // The app may die after the manifest or any individual bundle. The
          // source-stream endpoints are idempotent at every checkpoint, so
          // resume the same stream before asking the reader to consume it.
          stream = await streamLongSources(request, binding);
        } else {
          throw new DeviceV2ApiError('会议问答来源流已失效', 409, 'Q2_SOURCE_STREAM_TERMINAL');
        }
      } else {
        stream = await streamLongSources(request, binding);
      }
      return readFromSourceStream(request, binding, stream);
    }
    const value = await deviceV2Request<any>(
      `/meetings/${encodeURIComponent(binding.bindingId)}/questions-v2`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          schema_version: 2,
          contract_revision: 'question.reader.v2',
          provider_revision: request.providerRevision,
          snapshot_id: request.snapshotId,
          source_fingerprint: request.sourceFingerprint,
          question: request.question,
          binding_generation: binding.bindingGeneration,
          binding_revision: binding.bindingRevision,
          cancel_revision: binding.cancelRevision,
          sources: request.sources.map(source => ({
            source_type: source.sourceType,
            source_id: source.sourceId,
            source_revision_id: source.sourceRevisionId,
            content_sha256: source.contentSha256,
            text: source.text,
          })),
        }),
      },
      '会议问答服务暂时不可用',
    );
    return normalizeResponse(value, request);
  }
}

export function createDeviceQ2Provider(): Q2Provider {
  return new DeviceQ2Provider();
}
