import {
  DeviceV2SourceStreamUnavailableError,
  type SourceStreamSourceType,
} from './deviceV2SourceStream';
import { deviceV2Request, loadDeviceV2Capabilities } from './deviceV2Api';
import { ensureRemoteMeetingServiceBinding } from './deviceAuthority';
import type {
  Q2CandidateProvider,
  Q2CandidateProviderRequest,
  Q2CandidateProviderResponse,
} from './questionQ2Candidate';

export const Q2_READER_PROVIDER_REVISION = 'q2-reader-v1';

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
        sourceId: required(citation?.source_id, 'source_id', 180),
        sourceRevisionId: required(citation?.source_revision_id, 'source_revision_id', 180),
        contentSha256: required(citation?.content_sha256, 'content_sha256', 71),
        sourceStartUtf8: Number(citation?.source_start_utf8),
        sourceEndUtf8: Number(citation?.source_end_utf8),
        quote: required(citation?.quote, 'quote', 600),
      })) : [],
    })),
  };
}

export class DeviceQ2CandidateProvider implements Q2CandidateProvider {
  async read(request: Q2CandidateProviderRequest): Promise<Q2CandidateProviderResponse> {
    const capabilities = await loadDeviceV2Capabilities();
    if (!capabilities.questionReaderV2) throw new DeviceV2SourceStreamUnavailableError();
    const binding = await ensureRemoteMeetingServiceBinding(request.meetingId);
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
