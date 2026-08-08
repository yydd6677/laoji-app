import { getApiConfig } from '../../../services/config';
import {
  HttpResponseError,
  readResponseData,
  readResponseError,
} from '../../../services/errors';
import { fetchWithTimeout } from '../../../services/http';
import type {
  SpeakerCorrectionV2Mutation,
  SpeakerCorrectionV2Response,
} from './contracts';

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function normalizedIdentifier(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim();
  return normalized && normalized.length <= 512 && !/[\u0000-\u001f\u007f]/.test(normalized)
    ? normalized
    : null;
}

function revisionFrom(value: unknown): number | null {
  const revision = typeof value === 'number' ? value : Number(value);
  return Number.isSafeInteger(revision) && revision >= 0 ? revision : null;
}

function revisionFromEtag(response: Response): number | null {
  const raw = response.headers?.get?.('ETag')?.trim();
  if (!raw) return null;
  return revisionFrom(raw.replace(/^W\//, '').replace(/^"|"$/g, ''));
}

function remoteRevision(data: unknown, response: Response): number | null {
  if (isRecord(data)) {
    const direct = revisionFrom(data.assignment_revision ?? data.revision);
    if (direct !== null) return direct;
    const conflict = isRecord(data.conflict) ? data.conflict : null;
    const nested = revisionFrom(conflict?.assignment_revision ?? conflict?.remote_revision);
    if (nested !== null) return nested;
    const current = isRecord(data.current) ? data.current : null;
    const currentRevision = revisionFrom(current?.assignment_revision ?? current?.revision);
    if (currentRevision !== null) return currentRevision;
  }
  return revisionFromEtag(response);
}

function conflictPayload(data: unknown): unknown {
  if (!isRecord(data)) return data;
  if (isRecord(data.remote_correction)) return data.remote_correction;
  if (isRecord(data.current)) return data.current;
  if (isRecord(data.conflict)) {
    const conflict = data.conflict;
    if (isRecord(conflict.remote)) return conflict.remote;
    if (isRecord(conflict.current)) return conflict.current;
  }
  return data;
}

export class SpeakerCorrectionConflictResponseError extends HttpResponseError {
  constructor(
    status: 409 | 412,
    public readonly remoteRevision: number | null,
    public readonly remotePayload: unknown,
  ) {
    super('讲话人修正的云端版本已变化', status);
    this.name = 'SpeakerCorrectionConflictResponseError';
  }
}

export interface SubmitSpeakerCorrectionV2Input {
  accessToken: string;
  meetingRemoteId: string;
  idempotencyKey: string;
  mutation: SpeakerCorrectionV2Mutation;
  signal?: AbortSignal;
}

export async function submitSpeakerCorrectionV2(
  input: SubmitSpeakerCorrectionV2Input,
): Promise<SpeakerCorrectionV2Response> {
  const base = getApiConfig().apiBase.replace(/\/+$/, '');
  const meetingId = encodeURIComponent(input.meetingRemoteId);
  const response = await fetchWithTimeout(
    `${base}/api/laoji/v2/meeting-notes/${meetingId}/speaker-corrections`,
    {
      method: 'POST',
      signal: input.signal,
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${input.accessToken}`,
        'Content-Type': 'application/json',
        'Idempotency-Key': input.idempotencyKey,
      },
      body: JSON.stringify(input.mutation),
    },
  );
  if (response.status === 409 || response.status === 412) {
    const data = await readResponseData(response);
    throw new SpeakerCorrectionConflictResponseError(
      response.status,
      remoteRevision(data, response),
      conflictPayload(data),
    );
  }
  if (!response.ok) {
    throw await readResponseError('讲话人修正同步失败', response, {
      unauthorizedToken: input.accessToken,
    });
  }
  const data = await readResponseData(response);
  if (!isRecord(data)) throw new Error('讲话人修正同步响应格式无效');
  const clientRequestId = normalizedIdentifier(
    data.client_request_id ?? data.clientRequestId,
  );
  const assignmentRevision = remoteRevision(data, response);
  if (clientRequestId !== input.mutation.client_request_id || assignmentRevision === null) {
    throw new Error('讲话人修正同步响应缺少有效版本');
  }
  return { clientRequestId, assignmentRevision };
}
