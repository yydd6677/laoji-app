import * as Crypto from 'expo-crypto';
import { getMeetingSummaryCatalogV1, loadMeetingCapabilities } from '../data/api/v2';
import {
  mergeMeetingSummaryCatalogMappings,
  type MappedRemoteSummaryVersionV1,
} from '../data/repositories';
import type { ScopeKey } from '../domain/meeting';
import type { Meeting, MeetingSummary } from '../types';
import {
  notifyMeetingSummaryChanged,
  requestMeetingSummarySync,
} from '../application/meeting/summarySyncTrigger';
import { getFeatureFlags } from '../config/featureFlags';
import { mirrorLegacySummaryContent } from './meetingContentMirror';
import { diagnosticAudit } from './diagnostics';

function stableJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .filter(key => record[key] !== undefined)
    .sort()
    .map(key => `${JSON.stringify(key)}:${stableJson(record[key])}`)
    .join(',')}}`;
}

async function sha256(value: unknown): Promise<string> {
  return Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, stableJson(value));
}

export interface PullMeetingSummaryVersionsInput {
  scopeKey: ScopeKey;
  canonicalMeetingId: string;
  meeting: Meeting;
  meetingRemoteId: string;
  accessToken: string;
  signal?: AbortSignal;
}

export interface PullMeetingSummaryVersionsResult {
  outcome: 'updated' | 'conflicted' | 'unchanged' | 'disabled' | 'stale';
  versionCount: number;
  conflictCount: number;
}

export async function pullMeetingSummaryVersions(
  input: PullMeetingSummaryVersionsInput,
): Promise<PullMeetingSummaryVersionsResult> {
  if (
    input.scopeKey === 'guest'
    || !input.accessToken
    || input.signal?.aborted
    || !getFeatureFlags().meetingSummarySyncV1
  ) return { outcome: 'disabled', versionCount: 0, conflictCount: 0 };
  const capability = await loadMeetingCapabilities({
    accessToken: input.accessToken,
    forceRefresh: true,
    allowStaleOnError: false,
  });
  if (input.signal?.aborted) return { outcome: 'stale', versionCount: 0, conflictCount: 0 };
  if (capability.source !== 'remote' || !capability.capabilities.summaryVersionsV1) {
    return { outcome: 'disabled', versionCount: 0, conflictCount: 0 };
  }
  const catalog = await getMeetingSummaryCatalogV1({
    accessToken: input.accessToken,
    meetingRemoteId: input.meetingRemoteId,
    signal: input.signal,
  });
  if (input.signal?.aborted) return { outcome: 'stale', versionCount: 0, conflictCount: 0 };
  const mapped: MappedRemoteSummaryVersionV1[] = [];
  const ascending = [...catalog.versions].sort((left, right) => (
    left.serverCreatedAtMs - right.serverCreatedAtMs || left.remoteId.localeCompare(right.remoteId)
  ));
  for (const remote of ascending) {
    const summary: MeetingSummary = {
      id: remote.remoteId,
      meeting_id: input.meetingRemoteId,
      generated_at: new Date(remote.serverCompletedAtMs).toISOString(),
      structured_document: remote.document,
    };
    const mirror = await mirrorLegacySummaryContent(input.scopeKey, input.meeting, summary, {
      expectedCanonicalMeetingId: input.canonicalMeetingId,
      canonicalWrite: true,
      throwOnFailure: true,
    });
    if (!mirror.localVersionId) throw new Error('整理结果云端版本未能建立本机映射');
    mapped.push({
      localVersionId: mirror.localVersionId,
      generatedDocumentSha256: `sha256:${await sha256(remote.document)}`,
      remote,
    });
  }
  const merged = await mergeMeetingSummaryCatalogMappings({
    scopeKey: input.scopeKey,
    meetingId: input.canonicalMeetingId,
    meetingRemoteId: input.meetingRemoteId,
    catalog,
    versions: mapped,
    mergedAtMs: Date.now(),
  });
  notifyMeetingSummaryChanged(input.scopeKey);
  requestMeetingSummarySync(input.scopeKey);
  diagnosticAudit('summary_versions_pull', {
    status: merged.outcome,
    versions: mapped.length,
    conflicts: merged.conflictCount,
  });
  return {
    outcome: merged.outcome,
    versionCount: mapped.length,
    conflictCount: merged.conflictCount,
  };
}
