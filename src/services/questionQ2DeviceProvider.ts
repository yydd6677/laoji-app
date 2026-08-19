import {
  DeviceV2SourceStreamUnavailableError,
  appendDeviceV2SourceBundle,
  appendDeviceV2SourceManifestPage,
  commitDeviceV2SourceBundleGroup,
  createDeviceV2SourceBundleGroup,
  createDeviceV2SourceStream,
  type SourceStreamSourceType,
} from './deviceV2SourceStream';
import { deviceV2Request, loadDeviceV2Capabilities } from './deviceV2Api';
import { ensureRemoteMeetingServiceBinding } from './deviceAuthority';
import type {
  Q2CandidateProvider,
  Q2CandidateProviderRequest,
  Q2CandidateProviderResponse,
} from './questionQ2Candidate';
import * as Crypto from 'expo-crypto';

export const Q2_READER_PROVIDER_REVISION = 'q2-reader-v1';
const LONG_SOURCE_CHAR_THRESHOLD = 40_000;
const MAX_STREAM_BUNDLES = 8;

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

async function streamLongSources(
  request: Q2CandidateProviderRequest,
  binding: Awaited<ReturnType<typeof ensureRemoteMeetingServiceBinding>>,
): Promise<{ taskId: string; streamId: string }> {
  const seed = request.operationId ?? `${request.snapshotId}:${request.sourceFingerprint.slice(-20)}`;
  const taskId = `q2-task:${seed}`;
  const streamId = `q2-source-stream:${seed}`;
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
    clientOperationId: request.operationId ?? streamId,
    generationId: `${seed}:generation`,
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
      && request.sources.reduce((total, source) => total + source.text.length, 0) > LONG_SOURCE_CHAR_THRESHOLD;
    if (shouldStream && capabilities.sourceStreamV2) {
      const stream = await streamLongSources(request, binding);
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
