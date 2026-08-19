import {
  getDeviceV2Task,
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
import type {
  Q2CandidateProvider,
  Q2CandidateProviderRequest,
  Q2CandidateProviderResponse,
} from './questionQ2Candidate';
import * as Crypto from 'expo-crypto';

export const Q2_READER_PROVIDER_REVISION = 'q2-reader-v1';
const LONG_SOURCE_CHAR_THRESHOLD = 40_000;
const MAX_DIRECT_SOURCE_ITEMS = 1_024;
const MAX_STREAM_BUNDLES = 8;
// A 57-minute source stream completed successfully at the server roughly one
// second after the former 120-second mobile recovery window expired. Keep the
// durable task recoverable through transient generation/queue variance without
// starting a duplicate question operation.
const Q2_TASK_RECOVERY_TIMEOUT_MS = 180_000;
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

function normalizeResponse(value: any, request: Q2CandidateProviderRequest): Q2CandidateProviderResponse {
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

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function recoverTimedOutQuestionTask(
  taskId: string,
  request: Q2CandidateProviderRequest,
): Promise<Q2CandidateProviderResponse> {
  const deadline = Date.now() + Q2_TASK_RECOVERY_TIMEOUT_MS;
  let lastError: unknown = null;
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

async function streamLongSources(
  request: Q2CandidateProviderRequest,
  binding: Awaited<ReturnType<typeof ensureRemoteMeetingServiceBinding>>,
): Promise<{ taskId: string; streamId: string }> {
  // Android operation IDs deliberately retain their full predecessor lineage,
  // so they are valid business identities but can exceed transport bounds.
  // Derive compact, deterministic source-stream handles without truncating or
  // weakening the full operation identity used by the local durable task.
  const transportDigest = await digest({
    operation_id: request.operationId ?? null,
    snapshot_id: request.snapshotId,
    source_fingerprint: request.sourceFingerprint,
  });
  const transportSeed = transportDigest.slice('sha256:'.length);
  const taskId = `q2-task:${transportSeed}`;
  const streamId = `q2-source-stream:${transportSeed}`;
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
    try {
      const { cancelDeviceV2SourceStream } = await import('./deviceV2SourceStream');
      await cancelDeviceV2SourceStream(streamId);
    } catch {
      // The durable task remains recoverable when cancellation itself is offline.
    }
    throw error;
  }
}

export class DeviceQ2CandidateProvider implements Q2CandidateProvider {
  async read(request: Q2CandidateProviderRequest): Promise<Q2CandidateProviderResponse> {
    const capabilities = await loadDeviceV2Capabilities();
    if (!capabilities.questionReaderV2) throw new DeviceV2SourceStreamUnavailableError();
    const binding = await ensureRemoteMeetingServiceBinding(request.meetingId);
    const shouldStream = request.sources.length > 0
      && (
        request.sources.length > MAX_DIRECT_SOURCE_ITEMS
        || request.sources.reduce((total, source) => total + source.text.length, 0) > LONG_SOURCE_CHAR_THRESHOLD
      );
    if (shouldStream) {
      if (!capabilities.sourceStreamV2) throw new DeviceV2SourceStreamUnavailableError();
      const stream = await streamLongSources(request, binding);
      try {
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
      } catch (error) {
        // The server owns a durable task before it starts the reader. A long
        // meeting can outlive the ordinary mobile HTTP deadline; recover the
        // same task instead of creating a second model call or losing a result
        // that the server commits after the socket closes.
        if (!(error instanceof RequestTimeoutError)) throw error;
        return recoverTimedOutQuestionTask(stream.taskId, request);
      }
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

export function createDeviceQ2CandidateProvider(): Q2CandidateProvider {
  return new DeviceQ2CandidateProvider();
}
