import * as Crypto from 'expo-crypto';
import { getMeetingSummaryCatalogV1, loadMeetingCapabilities } from '../data/api/v2';
import {
  mergeMeetingSummaryCatalogMappings,
  type MappedRemoteSummaryVersionV1,
} from '../data/repositories';
import type { MeetingSummaryDocument, ScopeKey } from '../domain/meeting';
import type { Meeting, MeetingSummary } from '../types';
import {
  notifyMeetingSummaryChanged,
  requestMeetingSummarySync,
} from '../application/meeting/summarySyncTrigger';
import { getFeatureFlags } from '../config/featureFlags';
import { mirrorLegacySummaryContent } from './meetingContentMirror';
import { diagnosticAudit } from './diagnostics';
import { normalizeRemoteMeetingSummaryResult } from './meetingSummaryFormat';

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

function generatedSummaryContent(document: MeetingSummaryDocument): unknown {
  return {
    schemaVersion: document.schemaVersion,
    templateId: document.templateId,
    templateRevision: document.templateRevision,
    transcriptRevisionId: document.transcriptRevisionId,
    manualNoteRevision: document.manualNoteRevision,
    scheduleSnapshotHash: document.scheduleSnapshotHash,
    sections: document.sections.map(section => ({
      id: section.id,
      stableKey: section.stableKey,
      kind: section.kind,
      title: section.title,
      content: section.content,
      citations: section.citations,
    })),
    actionItemCandidates: document.actionItemCandidates,
  };
}

async function generatedSummaryContentSha256(document: MeetingSummaryDocument): Promise<string> {
  return `sha256:v2:${await sha256(generatedSummaryContent(document))}`;
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

function pullFailureCode(reason: unknown): string {
  if (!(reason instanceof Error)) return 'unknown';
  const message = reason.message.trim().toLowerCase();
  if (!message) return reason.name || 'error_without_message';
  if (message.includes('响应格式')) return 'response_contract_invalid';
  if (message.includes('模板身份')) return 'template_identity_mismatch';
  if (message.includes('远端会议身份')) return 'remote_meeting_identity_invalid';
  if (message.includes('同步身份')) return 'summary_section_identity_invalid';
  if (message.includes('section 数量')) return 'summary_section_count_invalid';
  if (message.includes('section 本机映射数量')) return 'summary_section_local_count_invalid';
  if (message.includes('section 本机映射身份')) return 'summary_section_local_identity_invalid';
  if (message.includes('section 云端身份')) return 'summary_section_remote_binding_invalid';
  if (message.includes('目录会议身份')) return 'summary_catalog_meeting_identity_changed';
  if (message.includes('本机映射数量')) return 'summary_local_mapping_count_invalid';
  if (message.includes('合并会议身份')) return 'summary_merge_meeting_identity_changed';
  if (message.includes('版本映射身份')) return 'summary_version_identity_invalid';
  if (message.includes('版本映射存在歧义')) return 'summary_version_mapping_ambiguous';
  if (message.includes('生成内容被云端改写')) return 'summary_generated_content_changed';
  if (message.includes('版本映射')) return 'summary_version_mapping_invalid';
  if (message.includes('本机版本不存在')) return 'local_summary_version_missing';
  if (message.includes('section')) return 'summary_section_mapping_invalid';
  if (message.includes('引用')) return 'summary_citation_mapping_invalid';
  if (message.includes('当前整理结果')) return 'summary_current_mapping_invalid';
  if (message.includes('constraint')) return 'sqlite_constraint';
  if (message.includes('database is locked')) return 'sqlite_locked';
  return reason.name || 'error';
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
  let phase = 'capability';
  let versionIndex = -1;
  try {
  const capability = await loadMeetingCapabilities({
    accessToken: input.accessToken,
    forceRefresh: true,
    allowStaleOnError: false,
  });
  if (input.signal?.aborted) return { outcome: 'stale', versionCount: 0, conflictCount: 0 };
  if (capability.source !== 'remote' || !capability.capabilities.summaryVersionsV1) {
    return { outcome: 'disabled', versionCount: 0, conflictCount: 0 };
  }
  phase = 'catalog';
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
  for (const [index, remote] of ascending.entries()) {
    versionIndex = index;
    phase = 'normalize';
    const summary: MeetingSummary = {
      id: remote.remoteId,
      meeting_id: input.meetingRemoteId,
      generated_at: new Date(remote.serverCompletedAtMs).toISOString(),
      structured_document: remote.document,
    };
    const rebound = normalizeRemoteMeetingSummaryResult(
      input.meeting.id,
      input.meetingRemoteId,
      summary,
    );
    if (!rebound) throw new Error('整理结果远端会议身份无效');
    phase = 'mirror';
    const mirror = await mirrorLegacySummaryContent(input.scopeKey, input.meeting, rebound, {
      expectedCanonicalMeetingId: input.canonicalMeetingId,
      canonicalWrite: true,
      throwOnFailure: true,
    });
    if (!mirror.localVersionId) throw new Error('整理结果云端版本未能建立本机映射');
    phase = 'hash';
    mapped.push({
      localVersionId: mirror.localVersionId,
      generatedDocumentSha256: await generatedSummaryContentSha256(remote.document),
      remote,
    });
  }
  versionIndex = -1;
  phase = 'merge';
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
  } catch (reason) {
    const mergeContext = reason && typeof reason === 'object'
      ? reason as {
          mergePhase?: unknown;
          versionIndex?: unknown;
          sectionIndex?: unknown;
          schemaTableCount?: unknown;
          schemaVersion?: unknown;
          remoteVersionColumnCount?: unknown;
          remoteVersionColumnMask?: unknown;
          remoteVersionRowCount?: unknown;
          localVersionIdLength?: unknown;
        }
      : null;
    diagnosticAudit('summary_versions_pull_failure', {
      phase,
      version_index: versionIndex,
      merge_phase: typeof mergeContext?.mergePhase === 'string'
        ? mergeContext.mergePhase
        : 'none',
      merge_version_index: typeof mergeContext?.versionIndex === 'number'
        ? mergeContext.versionIndex
        : -1,
      merge_section_index: typeof mergeContext?.sectionIndex === 'number'
        ? mergeContext.sectionIndex
        : -1,
      merge_schema_tables: typeof mergeContext?.schemaTableCount === 'number'
        ? mergeContext.schemaTableCount
        : -1,
      merge_schema_version: typeof mergeContext?.schemaVersion === 'number'
        ? mergeContext.schemaVersion
        : -1,
      merge_version_columns: typeof mergeContext?.remoteVersionColumnCount === 'number'
        ? mergeContext.remoteVersionColumnCount
        : -1,
      merge_version_column_mask: typeof mergeContext?.remoteVersionColumnMask === 'number'
        ? mergeContext.remoteVersionColumnMask
        : -1,
      merge_version_rows: typeof mergeContext?.remoteVersionRowCount === 'number'
        ? mergeContext.remoteVersionRowCount
        : -1,
      merge_local_version_id_length: typeof mergeContext?.localVersionIdLength === 'number'
        ? mergeContext.localVersionIdLength
        : -1,
      reason: pullFailureCode(reason),
    });
    throw reason;
  }
}
