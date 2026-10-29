import * as Crypto from 'expo-crypto';
import type { NativeProjectionEnvelope } from 'laoji-native-platform';

/** Deterministic JSON used for projection payload hashes and replay tests. */
export function stableProjectionJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stableProjectionJson).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .filter(key => record[key] !== undefined)
    .sort()
    .map(key => `${JSON.stringify(key)}:${stableProjectionJson(record[key])}`)
    .join(',')}}`;
}

export async function projectionPayloadSha256(payload: unknown): Promise<string> {
  const digest = await Crypto.digestStringAsync(
    Crypto.CryptoDigestAlgorithm.SHA256,
    stableProjectionJson(payload),
  );
  return `sha256:${digest.toLowerCase()}`;
}

export async function createProjectionEnvelope(input: {
  deviceEpoch: string;
  entityId: string;
  entityRevision: number;
  viewRevision: number;
  surfaceInstanceId: string;
  payloadSha256?: string;
}, payload: unknown): Promise<NativeProjectionEnvelope> {
  if (!input.deviceEpoch.trim() || !input.entityId.trim() || !input.surfaceInstanceId.trim()) {
    throw new Error('投影身份不能为空');
  }
  if (!Number.isSafeInteger(input.entityRevision) || input.entityRevision < 1
    || !Number.isSafeInteger(input.viewRevision) || input.viewRevision < 1) {
    throw new Error('投影版本无效');
  }
  return {
    ...input,
    payloadSha256: input.payloadSha256 ?? await projectionPayloadSha256(payload),
  };
}

export function projectionPayload(snapshot: NativeProjectionEnvelope): Record<string, unknown> {
  return {
    deviceEpoch: snapshot.deviceEpoch,
    entityId: snapshot.entityId,
    entityRevision: snapshot.entityRevision,
    viewRevision: snapshot.viewRevision,
    surfaceInstanceId: snapshot.surfaceInstanceId,
    payloadSha256: snapshot.payloadSha256,
  };
}
