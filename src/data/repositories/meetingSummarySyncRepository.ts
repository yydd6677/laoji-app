import type { SQLiteDatabase } from 'expo-sqlite';
import type {
  RemoteSummaryCatalogV1,
  RemoteSummaryCurrentV1,
  RemoteSummarySectionStateV1,
  RemoteSummaryVersionV1,
} from '../api/v2';
import { openMeetingDatabase, withMeetingDatabaseTransaction } from '../db/openDatabase';
import { assertScopeKey, secureClientIdFactory, type ScopeKey } from '../../domain/meeting';
import { refreshMeetingSyncState } from './sqliteMeetingNoteRepository';

const SECTION_AGGREGATE = 'summary_section';
const CURRENT_AGGREGATE = 'summary_current';
const SECTION_OPERATION = 'summary_section.override';
const CURRENT_OPERATION = 'summary_current.select';

type AccountScopeKey = Exclude<ScopeKey, 'guest'>;

type RemoteVersionRow = {
  scope_key: string;
  meeting_id: string;
  local_version_id: string;
  remote_version_id: string;
  remote_status: 'ready' | 'stale';
  generated_document_sha256: string;
  remote_created_at_ms: number;
  remote_completed_at_ms: number;
  remote_updated_at_ms: number;
};

type RemoteSectionRow = {
  scope_key: string;
  meeting_id: string;
  local_version_id: string;
  local_section_id: string;
  remote_version_id: string;
  remote_section_id: string;
  remote_revision: number;
  remote_user_text: string | null;
  remote_generated_citation_ids_json: string;
  remote_visible_citation_ids_json: string;
  remote_client_updated_at_ms: number;
  remote_updated_at_ms: number;
};

type RemoteCitationRow = {
  local_citation_id: string;
  remote_citation_id: string;
  ordinal: number;
  user_removed_at_ms: number | null;
};

type CurrentSyncRow = {
  scope_key: string;
  meeting_id: string;
  local_version_id: string;
  remote_version_id: string;
  remote_revision: number;
  remote_client_updated_at_ms: number;
  remote_updated_at_ms: number;
};

type LocalSectionRow = {
  id: string;
  version_id: string;
  stable_key: string;
  ordinal: number;
  title: string | null;
  generated_text: string;
  user_text: string | null;
  user_edited_at_ms: number | null;
};

type OutboxRow = {
  operation_id: string;
  scope_key: string;
  aggregate_type: typeof SECTION_AGGREGATE | typeof CURRENT_AGGREGATE;
  aggregate_id: string;
  operation_type: typeof SECTION_OPERATION | typeof CURRENT_OPERATION;
  base_revision: number | null;
  payload_json: string;
  status: string;
  attempt_count: number;
  next_attempt_at_ms: number | null;
  request_payload_json: string | null;
  claim_token: string | null;
  created_at_ms: number;
  updated_at_ms: number;
};

export interface MappedRemoteSummaryVersionV1 {
  localVersionId: string;
  generatedDocumentSha256: string;
  remote: RemoteSummaryVersionV1;
}

export interface SummarySyncClaim {
  scopeKey: AccountScopeKey;
  kind: 'section' | 'current';
  meetingId: string;
  meetingRemoteId: string;
  aggregateId: string;
  operationId: string;
  claimToken: string;
  requestPayloadJson: string;
  attemptCount: number;
}

export interface SummarySyncFailure {
  disposition: 'retry' | 'blocked' | 'permanent_error';
  errorCode: string;
  nextAttemptAtMs: number | null;
  updatedAtMs: number;
}

export interface SummarySyncConflictRecord {
  id: string;
  meetingId: string;
  aggregateType: typeof SECTION_AGGREGATE | typeof CURRENT_AGGREGATE;
  aggregateId: string;
  localRevision: number | null;
  remoteRevision: number | null;
  localPayloadJson: string;
  remotePayloadJson: string;
  createdAtMs: number;
}

function assertAccountScope(scopeKey: ScopeKey): asserts scopeKey is AccountScopeKey {
  assertScopeKey(scopeKey);
  if (scopeKey === 'guest') throw new Error('游客整理结果不能同步');
}

function time(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${label}无效`);
  return value;
}

function identifier(value: string, label: string, maximum = 512): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > maximum || /[\u0000-\u001f\u007f]/.test(normalized)) {
    throw new Error(`${label}无效`);
  }
  return normalized;
}

function parseIds(value: string, label: string): readonly string[] {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed) || parsed.length > 100) throw new Error();
    const ids = parsed.map(item => identifier(String(item), label));
    if (new Set(ids).size !== ids.length) throw new Error();
    return ids;
  } catch {
    throw new Error(`${label}无效`);
  }
}

function sameIds(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((item, index) => item === right[index]);
}

function readyAt(row: OutboxRow, staleClaimAfterMs: number): number {
  if (row.status === 'pending') return 0;
  if (row.status === 'retry') return row.next_attempt_at_ms ?? 0;
  if (row.status === 'in_flight') {
    return Math.min(Number.MAX_SAFE_INTEGER, row.updated_at_ms + staleClaimAfterMs);
  }
  return Number.MAX_SAFE_INTEGER;
}

async function localSectionState(
  database: SQLiteDatabase,
  scopeKey: AccountScopeKey,
  localSectionId: string,
): Promise<{
  section: LocalSectionRow;
  mapping: RemoteSectionRow;
  generatedRemoteCitationIds: readonly string[];
  visibleRemoteCitationIds: readonly string[];
} | null> {
  const mapping = await database.getFirstAsync<RemoteSectionRow>(
    `SELECT remote.* FROM meeting_summary_remote_sections remote
     INNER JOIN meeting_notes meeting
       ON meeting.id = remote.meeting_id AND meeting.scope_key = remote.scope_key
     WHERE remote.scope_key = ? AND remote.local_section_id = ?
       AND meeting.lifecycle <> 'deleted'`,
    scopeKey,
    localSectionId,
  );
  if (!mapping) return null;
  const section = await database.getFirstAsync<LocalSectionRow>(
    `SELECT section.id, section.version_id, section.stable_key, section.ordinal,
       section.title, section.generated_text, section.user_text, section.user_edited_at_ms
     FROM summary_sections section
     INNER JOIN summary_versions version ON version.id = section.version_id
     INNER JOIN meeting_notes meeting ON meeting.id = version.meeting_id
     WHERE section.id = ? AND meeting.scope_key = ?`,
    localSectionId,
    scopeKey,
  );
  if (!section || section.version_id !== mapping.local_version_id) {
    throw new Error('整理内容本机映射已变化');
  }
  const citations = await database.getAllAsync<RemoteCitationRow>(
    `SELECT map.local_citation_id, map.remote_citation_id, map.ordinal,
       citation.user_removed_at_ms
     FROM meeting_summary_remote_citations map
     INNER JOIN summary_citations citation ON citation.id = map.local_citation_id
     WHERE map.scope_key = ? AND map.local_section_id = ?
     ORDER BY map.ordinal, map.local_citation_id`,
    scopeKey,
    localSectionId,
  );
  const generatedRemoteCitationIds = parseIds(
    mapping.remote_generated_citation_ids_json,
    '整理结果生成引用标识',
  );
  const cachedVisible = new Set(parseIds(
    mapping.remote_visible_citation_ids_json,
    '整理结果云端引用标识',
  ));
  const localByRemote = new Map(citations.map(citation => [citation.remote_citation_id, citation]));
  const visibleRemoteCitationIds = generatedRemoteCitationIds.filter(remoteId => {
    const local = localByRemote.get(remoteId);
    return local ? local.user_removed_at_ms === null : cachedVisible.has(remoteId);
  });
  return { section, mapping, generatedRemoteCitationIds, visibleRemoteCitationIds };
}

function sectionPayload(state: NonNullable<Awaited<ReturnType<typeof localSectionState>>>): string {
  return JSON.stringify({
    schema_version: 1,
    meeting_id: state.mapping.meeting_id,
    remote_version_id: state.mapping.remote_version_id,
    remote_section_id: state.mapping.remote_section_id,
    stable_key: state.section.stable_key,
    ordinal: state.section.ordinal,
    title: state.section.title,
    generated_text: state.section.generated_text,
    expected_remote_revision: state.mapping.remote_revision,
    user_text: state.section.user_text,
    visible_citation_ids: state.visibleRemoteCitationIds,
    generated_citation_ids: state.generatedRemoteCitationIds,
    client_updated_at_ms: Math.max(
      state.mapping.remote_client_updated_at_ms,
      state.section.user_edited_at_ms ?? 0,
    ),
  });
}

async function currentPayload(
  database: SQLiteDatabase,
  scopeKey: AccountScopeKey,
  meetingId: string,
): Promise<string | null> {
  const row = await database.getFirstAsync<CurrentSyncRow & {
    current_local_version_id: string | null;
    target_remote_version_id: string | null;
  }>(
    `SELECT current.*, meeting.current_summary_version_id AS current_local_version_id,
       target.remote_version_id AS target_remote_version_id
     FROM meeting_summary_current_sync current
     INNER JOIN meeting_notes meeting
       ON meeting.id = current.meeting_id AND meeting.scope_key = current.scope_key
     LEFT JOIN meeting_summary_remote_versions target
       ON target.scope_key = current.scope_key
      AND target.local_version_id = meeting.current_summary_version_id
     WHERE current.scope_key = ? AND current.meeting_id = ?
       AND meeting.lifecycle <> 'deleted'`,
    scopeKey,
    meetingId,
  );
  if (!row || !row.current_local_version_id || !row.target_remote_version_id) return null;
  return JSON.stringify({
    schema_version: 1,
    meeting_id: meetingId,
    remote_version_id: row.target_remote_version_id,
    expected_remote_revision: row.remote_revision,
    client_updated_at_ms: Math.max(Date.now(), row.remote_client_updated_at_ms + 1),
  });
}

async function hasOutstanding(
  database: SQLiteDatabase,
  scopeKey: AccountScopeKey,
  aggregateType: string,
  aggregateId: string,
): Promise<boolean> {
  return Boolean(await database.getFirstAsync<{ found: number }>(
    `SELECT 1 AS found FROM sync_outbox
     WHERE scope_key = ? AND aggregate_type = ? AND aggregate_id = ?
       AND status <> 'completed' LIMIT 1`,
    scopeKey,
    aggregateType,
    aggregateId,
  ));
}

async function hasConflict(
  database: SQLiteDatabase,
  scopeKey: AccountScopeKey,
  aggregateType: string,
  aggregateId: string,
): Promise<boolean> {
  return Boolean(await database.getFirstAsync<{ found: number }>(
    `SELECT 1 AS found FROM sync_conflicts
     WHERE scope_key = ? AND aggregate_type = ? AND aggregate_id = ?
       AND status = 'unresolved' LIMIT 1`,
    scopeKey,
    aggregateType,
    aggregateId,
  ));
}

async function insertOperation(
  database: SQLiteDatabase,
  input: {
    scopeKey: AccountScopeKey;
    aggregateType: typeof SECTION_AGGREGATE | typeof CURRENT_AGGREGATE;
    aggregateId: string;
    operationType: typeof SECTION_OPERATION | typeof CURRENT_OPERATION;
    baseRevision: number;
    payloadJson: string;
    createdAtMs: number;
  },
): Promise<boolean> {
  if (
    await hasOutstanding(
      database,
      input.scopeKey,
      input.aggregateType,
      input.aggregateId,
    )
  ) return false;
  const inserted = await database.runAsync(
    `INSERT INTO sync_outbox (
       operation_id, scope_key, aggregate_type, aggregate_id,
       operation_type, base_revision, payload_json, status,
       attempt_count, next_attempt_at_ms, last_error_code,
       request_payload_json, claim_token, created_at_ms, updated_at_ms
     ) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', 0, NULL, NULL, NULL, NULL, ?, ?)`,
    secureClientIdFactory.create(),
    input.scopeKey,
    input.aggregateType,
    input.aggregateId,
    input.operationType,
    input.baseRevision,
    input.payloadJson,
    input.createdAtMs,
    input.createdAtMs,
  );
  return inserted.changes === 1;
}

async function markAggregateSatisfied(
  database: SQLiteDatabase,
  scopeKey: AccountScopeKey,
  aggregateType: string,
  aggregateId: string,
  updatedAtMs: number,
): Promise<void> {
  await database.runAsync(
    `UPDATE sync_outbox SET status = 'completed', next_attempt_at_ms = NULL,
       last_error_code = 'satisfied_by_pull', request_payload_json = NULL,
       claim_token = NULL, updated_at_ms = ?
     WHERE scope_key = ? AND aggregate_type = ? AND aggregate_id = ?
       AND status <> 'completed'`,
    updatedAtMs,
    scopeKey,
    aggregateType,
    aggregateId,
  );
  await database.runAsync(
    `UPDATE sync_conflicts SET status = 'resolved', resolved_at_ms = ?
     WHERE scope_key = ? AND aggregate_type = ? AND aggregate_id = ?
       AND status = 'unresolved'`,
    updatedAtMs,
    scopeKey,
    aggregateType,
    aggregateId,
  );
}

async function recordPullConflict(
  database: SQLiteDatabase,
  input: {
    scopeKey: AccountScopeKey;
    meetingId: string;
    aggregateType: typeof SECTION_AGGREGATE | typeof CURRENT_AGGREGATE;
    aggregateId: string;
    localRevision: number | null;
    remoteRevision: number;
    localPayloadJson: string;
    remotePayloadJson: string;
    createdAtMs: number;
  },
): Promise<void> {
  const existing = await database.getFirstAsync<{ id: string; remote_revision: number | null }>(
    `SELECT id, remote_revision FROM sync_conflicts
     WHERE scope_key = ? AND aggregate_type = ? AND aggregate_id = ?
       AND status = 'unresolved'
     ORDER BY created_at_ms DESC, id DESC LIMIT 1`,
    input.scopeKey,
    input.aggregateType,
    input.aggregateId,
  );
  if (existing && (existing.remote_revision ?? 0) > input.remoteRevision) return;
  if (existing) {
    await database.runAsync(
      `UPDATE sync_conflicts SET local_revision = ?, remote_revision = ?,
         local_payload_json = ?, remote_payload_json = ?, created_at_ms = ?
       WHERE id = ?`,
      input.localRevision,
      input.remoteRevision,
      input.localPayloadJson,
      input.remotePayloadJson,
      input.createdAtMs,
      existing.id,
    );
  } else {
    await database.runAsync(
      `INSERT INTO sync_conflicts (
         id, scope_key, aggregate_type, aggregate_id,
         local_revision, remote_revision, local_payload_json,
         remote_payload_json, status, created_at_ms
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'unresolved', ?)`,
      `summary-pull:${secureClientIdFactory.create()}`,
      input.scopeKey,
      input.aggregateType,
      input.aggregateId,
      input.localRevision,
      input.remoteRevision,
      input.localPayloadJson,
      input.remotePayloadJson,
      input.createdAtMs,
    );
  }
  await database.runAsync(
    `UPDATE sync_outbox SET status = 'blocked', next_attempt_at_ms = NULL,
       last_error_code = 'remote_pull_conflict', claim_token = NULL, updated_at_ms = ?
     WHERE scope_key = ? AND aggregate_type = ? AND aggregate_id = ?
       AND status <> 'completed'`,
    input.createdAtMs,
    input.scopeKey,
    input.aggregateType,
    input.aggregateId,
  );
}

async function applyRemoteSectionToLocal(
  database: SQLiteDatabase,
  input: {
    localVersionId: string;
    localSectionId: string;
    remote: RemoteSummarySectionStateV1;
    citationMap: ReadonlyMap<string, string>;
  },
): Promise<void> {
  const editedAtMs = input.remote.userText === null ? null : input.remote.clientUpdatedAtMs;
  await database.runAsync(
    `UPDATE summary_sections SET user_text = ?, user_edited_at_ms = ?
     WHERE id = ? AND version_id = ?`,
    input.remote.userText,
    editedAtMs,
    input.localSectionId,
    input.localVersionId,
  );
  const visible = new Set(input.remote.visibleCitationIds);
  for (const [remoteCitationId, localCitationId] of input.citationMap) {
    await database.runAsync(
      `UPDATE summary_citations SET user_removed_at_ms = ? WHERE id = ? AND section_id = ?`,
      visible.has(remoteCitationId) ? null : input.remote.clientUpdatedAtMs,
      localCitationId,
      input.localSectionId,
    );
  }
  await database.runAsync(
    `UPDATE summary_versions SET user_edited = CASE WHEN
       EXISTS (
         SELECT 1 FROM summary_sections section
         WHERE section.version_id = summary_versions.id
           AND section.user_text IS NOT NULL
       ) OR EXISTS (
         SELECT 1 FROM summary_citations citation
         INNER JOIN summary_sections section ON section.id = citation.section_id
         WHERE section.version_id = summary_versions.id
           AND citation.user_removed_at_ms IS NOT NULL
       ) THEN 1 ELSE 0 END
     WHERE id = ?`,
    input.localVersionId,
  );
}

export async function mergeMeetingSummaryCatalogMappings(input: {
  scopeKey: ScopeKey;
  meetingId: string;
  meetingRemoteId: string;
  catalog: RemoteSummaryCatalogV1;
  versions: readonly MappedRemoteSummaryVersionV1[];
  mergedAtMs: number;
}): Promise<{ outcome: 'updated' | 'conflicted' | 'unchanged'; conflictCount: number }> {
  const scopeKey = input.scopeKey;
  assertAccountScope(scopeKey);
  identifier(input.meetingId, '整理结果会议本机标识');
  identifier(input.meetingRemoteId, '整理结果会议云端标识', 160);
  time(input.mergedAtMs, '整理结果合并时间');
  if (input.catalog.meetingRemoteId !== input.meetingRemoteId) {
    throw new Error('整理结果目录会议身份已变化');
  }
  if (input.versions.length !== input.catalog.versions.length) {
    throw new Error('整理结果本机映射数量不一致');
  }
  return withMeetingDatabaseTransaction(async database => {
    const meeting = await database.getFirstAsync<{
      id: string;
      remote_id: string | null;
      current_summary_version_id: string | null;
    }>(
      `SELECT id, remote_id, current_summary_version_id FROM meeting_notes
       WHERE id = ? AND scope_key = ? AND lifecycle <> 'deleted'`,
      input.meetingId,
      scopeKey,
    );
    if (!meeting || meeting.remote_id !== input.meetingRemoteId) {
      throw new Error('整理结果合并会议身份已变化');
    }
    let changed = false;
    let conflictCount = 0;
    for (const mapped of input.versions) {
      const remote = mapped.remote;
      if (
        remote.meetingRemoteId !== input.meetingRemoteId
        || remote.document.remoteVersionId !== remote.remoteId
      ) throw new Error('整理结果版本映射身份无效');
      const localVersion = await database.getFirstAsync<{ id: string; meeting_id: string }>(
        'SELECT id, meeting_id FROM summary_versions WHERE id = ?',
        mapped.localVersionId,
      );
      if (!localVersion || localVersion.meeting_id !== input.meetingId) {
        throw new Error('整理结果本机版本不存在');
      }
      const existingRemote = await database.getFirstAsync<RemoteVersionRow>(
        `SELECT * FROM meeting_summary_remote_versions
         WHERE scope_key = ? AND remote_version_id = ?`,
        scopeKey,
        remote.remoteId,
      );
      const existingLocal = await database.getFirstAsync<RemoteVersionRow>(
        `SELECT * FROM meeting_summary_remote_versions
         WHERE scope_key = ? AND local_version_id = ?`,
        scopeKey,
        mapped.localVersionId,
      );
      if (
        (existingRemote && existingRemote.local_version_id !== mapped.localVersionId)
        || (existingLocal && existingLocal.remote_version_id !== remote.remoteId)
      ) throw new Error('整理结果版本映射存在歧义');
      if (existingRemote && existingRemote.generated_document_sha256 !== mapped.generatedDocumentSha256) {
        throw new Error('整理结果生成内容被云端改写');
      }
      await database.runAsync(
        `INSERT INTO meeting_summary_remote_versions (
           scope_key, meeting_id, local_version_id, remote_version_id,
           remote_status, generated_document_sha256,
           remote_created_at_ms, remote_completed_at_ms, remote_updated_at_ms
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(scope_key, remote_version_id) DO UPDATE SET
           remote_status = excluded.remote_status,
           remote_updated_at_ms = MAX(
             meeting_summary_remote_versions.remote_updated_at_ms,
             excluded.remote_updated_at_ms
           )`,
        scopeKey,
        input.meetingId,
        mapped.localVersionId,
        remote.remoteId,
        remote.status,
        mapped.generatedDocumentSha256,
        remote.serverCreatedAtMs,
        remote.serverCompletedAtMs,
        remote.serverUpdatedAtMs,
      );
      const localSections = await database.getAllAsync<LocalSectionRow>(
        `SELECT id, version_id, stable_key, ordinal, title, generated_text,
           user_text, user_edited_at_ms
         FROM summary_sections WHERE version_id = ? ORDER BY ordinal, id`,
        mapped.localVersionId,
      );
      if (localSections.length !== remote.sections.length) {
        throw new Error('整理结果 section 本机映射数量不一致');
      }
      for (let index = 0; index < remote.sections.length; index += 1) {
        const remoteSection = remote.sections[index];
        const generatedSection = remote.document.sections[index];
        const localSection = localSections[index];
        if (
          localSection.stable_key !== remoteSection.stableKey
          || localSection.ordinal !== remoteSection.ordinal
          || generatedSection.id !== remoteSection.remoteSectionId
          || generatedSection.stableKey !== localSection.stable_key
        ) throw new Error('整理结果 section 本机映射身份不一致');
        const prior = await database.getFirstAsync<RemoteSectionRow>(
          `SELECT * FROM meeting_summary_remote_sections
           WHERE scope_key = ? AND remote_version_id = ? AND remote_section_id = ?`,
          scopeKey,
          remote.remoteId,
          remoteSection.remoteSectionId,
        );
        if (prior && prior.local_section_id !== localSection.id) {
          throw new Error('整理结果 section 云端身份已绑定其他内容');
        }
        if (prior && remoteSection.revision < prior.remote_revision) continue;
        const generatedCitationIds = generatedSection.citations.map(citation => citation.id);
        await database.runAsync(
          `INSERT INTO meeting_summary_remote_sections (
             scope_key, meeting_id, local_version_id, local_section_id,
             remote_version_id, remote_section_id, remote_revision,
             remote_user_text, remote_generated_citation_ids_json,
             remote_visible_citation_ids_json, remote_client_updated_at_ms,
             remote_updated_at_ms
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(scope_key, remote_version_id, remote_section_id) DO UPDATE SET
             remote_revision = excluded.remote_revision,
             remote_user_text = excluded.remote_user_text,
             remote_generated_citation_ids_json = excluded.remote_generated_citation_ids_json,
             remote_visible_citation_ids_json = excluded.remote_visible_citation_ids_json,
             remote_client_updated_at_ms = excluded.remote_client_updated_at_ms,
             remote_updated_at_ms = excluded.remote_updated_at_ms`,
          scopeKey,
          input.meetingId,
          mapped.localVersionId,
          localSection.id,
          remote.remoteId,
          remoteSection.remoteSectionId,
          remoteSection.revision,
          remoteSection.userText,
          JSON.stringify(generatedCitationIds),
          JSON.stringify(remoteSection.visibleCitationIds),
          remoteSection.clientUpdatedAtMs,
          remoteSection.serverUpdatedAtMs,
        );
        const localCitations = await database.getAllAsync<{
          id: string;
          ordinal: number;
          start_ms: number;
          end_ms: number;
          quote_hash: string | null;
        }>(
          `SELECT id, ordinal, start_ms, end_ms, quote_hash
           FROM summary_citations WHERE section_id = ? ORDER BY ordinal, id`,
          localSection.id,
        );
        const citationMap = new Map<string, string>();
        for (const localCitation of localCitations) {
          const remoteCitation = generatedSection.citations[localCitation.ordinal];
          if (
            !remoteCitation
            || remoteCitation.startMs !== localCitation.start_ms
            || remoteCitation.endMs !== localCitation.end_ms
            || remoteCitation.quoteHash !== localCitation.quote_hash
          ) continue;
          citationMap.set(remoteCitation.id, localCitation.id);
          const byLocal = await database.getFirstAsync<{ remote_citation_id: string }>(
            `SELECT remote_citation_id FROM meeting_summary_remote_citations
             WHERE scope_key = ? AND local_citation_id = ?`,
            scopeKey,
            localCitation.id,
          );
          if (byLocal && byLocal.remote_citation_id !== remoteCitation.id) {
            throw new Error('整理结果引用本机映射存在歧义');
          }
          await database.runAsync(
            `INSERT INTO meeting_summary_remote_citations (
               scope_key, meeting_id, local_section_id, local_citation_id,
               remote_version_id, remote_section_id, remote_citation_id, ordinal
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(scope_key, remote_version_id, remote_section_id, remote_citation_id)
             DO NOTHING`,
            scopeKey,
            input.meetingId,
            localSection.id,
            localCitation.id,
            remote.remoteId,
            remoteSection.remoteSectionId,
            remoteCitation.id,
            localCitation.ordinal,
          );
        }
        const remotePayload = JSON.stringify({
          schema_version: 1,
          ...remoteSection,
          generatedCitationIds,
        });
        const pending = await hasOutstanding(
          database,
          scopeKey,
          SECTION_AGGREGATE,
          localSection.id,
        );
        const unresolved = await hasConflict(
          database,
          scopeKey,
          SECTION_AGGREGATE,
          localSection.id,
        );
        const currentLocal = await localSectionState(database, scopeKey, localSection.id);
        const localMatchesRemote = Boolean(
          currentLocal
          && currentLocal.section.user_text === remoteSection.userText
          && sameIds(currentLocal.visibleRemoteCitationIds, remoteSection.visibleCitationIds),
        );
        if (localMatchesRemote) {
          await markAggregateSatisfied(
            database,
            scopeKey,
            SECTION_AGGREGATE,
            localSection.id,
            input.mergedAtMs,
          );
        } else if ((pending || unresolved) && prior && remoteSection.revision > prior.remote_revision) {
          const localPayload = currentLocal ? sectionPayload(currentLocal) : '{}';
          await recordPullConflict(database, {
            scopeKey,
            meetingId: input.meetingId,
            aggregateType: SECTION_AGGREGATE,
            aggregateId: localSection.id,
            localRevision: prior.remote_revision,
            remoteRevision: remoteSection.revision,
            localPayloadJson: localPayload,
            remotePayloadJson: remotePayload,
            createdAtMs: input.mergedAtMs,
          });
          conflictCount += 1;
        } else if (!pending && !unresolved) {
          await applyRemoteSectionToLocal(database, {
            localVersionId: mapped.localVersionId,
            localSectionId: localSection.id,
            remote: remoteSection,
            citationMap,
          });
          changed = true;
        }
      }
    }

    const remoteCurrent = input.catalog.current;
    if (remoteCurrent) {
      const target = await database.getFirstAsync<RemoteVersionRow>(
        `SELECT * FROM meeting_summary_remote_versions
         WHERE scope_key = ? AND remote_version_id = ?`,
        scopeKey,
        remoteCurrent.remoteVersionId,
      );
      if (!target || target.meeting_id !== input.meetingId) {
        throw new Error('当前整理结果缺少本机映射');
      }
      const prior = await database.getFirstAsync<CurrentSyncRow>(
        `SELECT * FROM meeting_summary_current_sync
         WHERE scope_key = ? AND meeting_id = ?`,
        scopeKey,
        input.meetingId,
      );
      if (!prior || remoteCurrent.revision >= prior.remote_revision) {
        const pending = await hasOutstanding(
          database,
          scopeKey,
          CURRENT_AGGREGATE,
          input.meetingId,
        );
        const unresolved = await hasConflict(
          database,
          scopeKey,
          CURRENT_AGGREGATE,
          input.meetingId,
        );
        const localMatchesRemote = meeting.current_summary_version_id === target.local_version_id;
        if (localMatchesRemote) {
          await markAggregateSatisfied(
            database,
            scopeKey,
            CURRENT_AGGREGATE,
            input.meetingId,
            input.mergedAtMs,
          );
        } else if ((pending || unresolved) && prior && remoteCurrent.revision > prior.remote_revision) {
          const localPayload = await currentPayload(database, scopeKey, input.meetingId) ?? '{}';
          await recordPullConflict(database, {
            scopeKey,
            meetingId: input.meetingId,
            aggregateType: CURRENT_AGGREGATE,
            aggregateId: input.meetingId,
            localRevision: prior.remote_revision,
            remoteRevision: remoteCurrent.revision,
            localPayloadJson: localPayload,
            remotePayloadJson: JSON.stringify(remoteCurrent),
            createdAtMs: input.mergedAtMs,
          });
          conflictCount += 1;
        } else if (!pending && !unresolved) {
          await database.runAsync(
            `UPDATE meeting_notes SET current_summary_version_id = ?,
               updated_at_ms = MAX(updated_at_ms, ?)
             WHERE id = ? AND scope_key = ?`,
            target.local_version_id,
            remoteCurrent.clientUpdatedAtMs,
            input.meetingId,
            scopeKey,
          );
          changed = true;
        }
        await database.runAsync(
          `INSERT INTO meeting_summary_current_sync (
             scope_key, meeting_id, local_version_id, remote_version_id,
             remote_revision, remote_client_updated_at_ms, remote_updated_at_ms
           ) VALUES (?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(scope_key, meeting_id) DO UPDATE SET
             local_version_id = excluded.local_version_id,
             remote_version_id = excluded.remote_version_id,
             remote_revision = excluded.remote_revision,
             remote_client_updated_at_ms = excluded.remote_client_updated_at_ms,
             remote_updated_at_ms = excluded.remote_updated_at_ms`,
          scopeKey,
          input.meetingId,
          target.local_version_id,
          target.remote_version_id,
          remoteCurrent.revision,
          remoteCurrent.clientUpdatedAtMs,
          remoteCurrent.serverUpdatedAtMs,
        );
      }
    }
    await refreshMeetingSyncState(database, input.meetingId, scopeKey);
    return {
      outcome: conflictCount > 0 ? 'conflicted' : changed ? 'updated' : 'unchanged',
      conflictCount,
    };
  });
}

export async function ensureMeetingSummarySyncOperations(
  scopeKey: ScopeKey,
  nowMs: number,
): Promise<number> {
  assertAccountScope(scopeKey);
  time(nowMs, '整理结果同步修复时间');
  return withMeetingDatabaseTransaction(async database => {
    const sections = await database.getAllAsync<{ local_section_id: string; meeting_id: string }>(
      `SELECT local_section_id, meeting_id FROM meeting_summary_remote_sections
       WHERE scope_key = ? ORDER BY remote_updated_at_ms, local_section_id`,
      scopeKey,
    );
    let inserted = 0;
    const touched = new Set<string>();
    for (const row of sections) {
      if (await hasConflict(database, scopeKey, SECTION_AGGREGATE, row.local_section_id)) continue;
      const state = await localSectionState(database, scopeKey, row.local_section_id);
      if (!state) continue;
      const remoteVisible = parseIds(
        state.mapping.remote_visible_citation_ids_json,
        '整理结果云端引用标识',
      );
      if (
        state.section.user_text === state.mapping.remote_user_text
        && sameIds(state.visibleRemoteCitationIds, remoteVisible)
      ) {
        await markAggregateSatisfied(
          database,
          scopeKey,
          SECTION_AGGREGATE,
          row.local_section_id,
          nowMs,
        );
        continue;
      }
      if (await insertOperation(database, {
        scopeKey,
        aggregateType: SECTION_AGGREGATE,
        aggregateId: row.local_section_id,
        operationType: SECTION_OPERATION,
        baseRevision: state.mapping.remote_revision,
        payloadJson: sectionPayload(state),
        createdAtMs: nowMs,
      })) inserted += 1;
      touched.add(row.meeting_id);
    }
    const currents = await database.getAllAsync<CurrentSyncRow & {
      current_summary_version_id: string | null;
      target_remote_version_id: string | null;
    }>(
      `SELECT current.*, meeting.current_summary_version_id,
         target.remote_version_id AS target_remote_version_id
       FROM meeting_summary_current_sync current
       INNER JOIN meeting_notes meeting
         ON meeting.id = current.meeting_id AND meeting.scope_key = current.scope_key
       LEFT JOIN meeting_summary_remote_versions target
         ON target.scope_key = current.scope_key
        AND target.local_version_id = meeting.current_summary_version_id
       WHERE current.scope_key = ? AND meeting.lifecycle <> 'deleted'`,
      scopeKey,
    );
    for (const row of currents) {
      if (!row.target_remote_version_id || row.target_remote_version_id === row.remote_version_id) {
        if (row.target_remote_version_id === row.remote_version_id) {
          await markAggregateSatisfied(
            database,
            scopeKey,
            CURRENT_AGGREGATE,
            row.meeting_id,
            nowMs,
          );
        }
        continue;
      }
      if (await hasConflict(database, scopeKey, CURRENT_AGGREGATE, row.meeting_id)) continue;
      const payload = await currentPayload(database, scopeKey, row.meeting_id);
      if (!payload) continue;
      if (await insertOperation(database, {
        scopeKey,
        aggregateType: CURRENT_AGGREGATE,
        aggregateId: row.meeting_id,
        operationType: CURRENT_OPERATION,
        baseRevision: row.remote_revision,
        payloadJson: payload,
        createdAtMs: nowMs,
      })) inserted += 1;
      touched.add(row.meeting_id);
    }
    for (const meetingId of touched) await refreshMeetingSyncState(database, meetingId, scopeKey);
    return inserted;
  });
}

export async function claimMeetingSummarySyncOperations(
  scopeKey: ScopeKey,
  options: { nowMs: number; staleClaimAfterMs: number; limit: number },
): Promise<readonly SummarySyncClaim[]> {
  assertAccountScope(scopeKey);
  time(options.nowMs, '整理结果同步认领时间');
  time(options.staleClaimAfterMs, '整理结果同步失效间隔');
  if (!Number.isSafeInteger(options.limit) || options.limit < 1 || options.limit > 20) {
    throw new Error('整理结果同步批量大小无效');
  }
  return withMeetingDatabaseTransaction(async database => {
    const rows = await database.getAllAsync<OutboxRow & {
      meeting_id: string;
      meeting_remote_id: string | null;
    }>(
      `SELECT outbox.*, CASE
         WHEN outbox.aggregate_type = ? THEN section.meeting_id
         ELSE outbox.aggregate_id END AS meeting_id,
         meeting.remote_id AS meeting_remote_id
       FROM sync_outbox outbox
       LEFT JOIN meeting_summary_remote_sections section
         ON outbox.aggregate_type = ?
        AND section.scope_key = outbox.scope_key
        AND section.local_section_id = outbox.aggregate_id
       INNER JOIN meeting_notes meeting ON meeting.id = CASE
         WHEN outbox.aggregate_type = ? THEN section.meeting_id
         ELSE outbox.aggregate_id END
        AND meeting.scope_key = outbox.scope_key
       WHERE outbox.scope_key = ?
         AND outbox.aggregate_type IN (?, ?)
         AND outbox.operation_type IN (?, ?)
         AND outbox.status IN ('pending','retry','in_flight')
         AND meeting.lifecycle <> 'deleted' AND meeting.remote_id IS NOT NULL
       ORDER BY outbox.created_at_ms, outbox.operation_id`,
      SECTION_AGGREGATE,
      SECTION_AGGREGATE,
      SECTION_AGGREGATE,
      scopeKey,
      SECTION_AGGREGATE,
      CURRENT_AGGREGATE,
      SECTION_OPERATION,
      CURRENT_OPERATION,
    );
    const claims: SummarySyncClaim[] = [];
    const seen = new Set<string>();
    for (const row of rows) {
      if (claims.length >= options.limit) break;
      const aggregateKey = `${row.aggregate_type}:${row.aggregate_id}`;
      if (seen.has(aggregateKey)) continue;
      seen.add(aggregateKey);
      if (readyAt(row, options.staleClaimAfterMs) > options.nowMs) continue;
      const latestPayload = row.aggregate_type === SECTION_AGGREGATE
        ? await localSectionState(database, scopeKey, row.aggregate_id).then(state => (
          state ? sectionPayload(state) : null
        ))
        : await currentPayload(database, scopeKey, row.aggregate_id);
      if (!latestPayload) {
        await database.runAsync(
          `UPDATE sync_outbox SET status = 'blocked', last_error_code = 'summary_mapping_missing',
             next_attempt_at_ms = NULL, claim_token = NULL, updated_at_ms = ?
           WHERE operation_id = ?`,
          options.nowMs,
          row.operation_id,
        );
        continue;
      }
      const claimToken = secureClientIdFactory.create();
      const requestPayload = row.request_payload_json ?? latestPayload;
      const claimed = await database.runAsync(
        `UPDATE sync_outbox SET status = 'in_flight', request_payload_json = ?,
           claim_token = ?, attempt_count = attempt_count + 1,
           next_attempt_at_ms = NULL, last_error_code = NULL, updated_at_ms = ?
         WHERE operation_id = ? AND status IN ('pending','retry','in_flight')`,
        requestPayload,
        claimToken,
        options.nowMs,
        row.operation_id,
      );
      if (claimed.changes !== 1) continue;
      claims.push({
        scopeKey,
        kind: row.aggregate_type === SECTION_AGGREGATE ? 'section' : 'current',
        meetingId: row.meeting_id,
        meetingRemoteId: identifier(row.meeting_remote_id ?? '', '整理结果会议云端标识', 160),
        aggregateId: row.aggregate_id,
        operationId: row.operation_id,
        claimToken,
        requestPayloadJson: requestPayload,
        attemptCount: row.attempt_count + 1,
      });
    }
    return claims;
  });
}

export async function nextMeetingSummarySyncAttemptAt(
  scopeKey: ScopeKey,
  staleClaimAfterMs: number,
): Promise<number | null> {
  assertAccountScope(scopeKey);
  time(staleClaimAfterMs, '整理结果同步失效间隔');
  const database = await openMeetingDatabase();
  const rows = await database.getAllAsync<OutboxRow>(
    `SELECT * FROM sync_outbox WHERE scope_key = ?
       AND aggregate_type IN (?, ?)
       AND status IN ('pending','retry','in_flight')`,
    scopeKey,
    SECTION_AGGREGATE,
    CURRENT_AGGREGATE,
  );
  const values = rows.map(row => readyAt(row, staleClaimAfterMs)).filter(Number.isFinite);
  return values.length > 0 ? Math.min(...values) : null;
}

export async function completeMeetingSummarySectionSyncClaim(
  claim: SummarySyncClaim,
  remote: RemoteSummarySectionStateV1,
  completedAtMs: number,
): Promise<boolean> {
  if (claim.kind !== 'section') throw new Error('整理内容同步认领类型无效');
  time(completedAtMs, '整理内容同步完成时间');
  return withMeetingDatabaseTransaction(async database => {
    const mapping = await database.getFirstAsync<RemoteSectionRow>(
      `SELECT * FROM meeting_summary_remote_sections
       WHERE scope_key = ? AND local_section_id = ?`,
      claim.scopeKey,
      claim.aggregateId,
    );
    if (
      !mapping
      || mapping.meeting_id !== claim.meetingId
      || mapping.remote_version_id !== remote.remoteVersionId
      || mapping.remote_section_id !== remote.remoteSectionId
      || remote.meetingRemoteId !== claim.meetingRemoteId
    ) return false;
    const acknowledged = await database.runAsync(
      `UPDATE sync_outbox SET status = 'completed', next_attempt_at_ms = NULL,
         last_error_code = NULL, request_payload_json = NULL, claim_token = NULL,
         updated_at_ms = ?
       WHERE operation_id = ? AND scope_key = ? AND aggregate_type = ?
         AND aggregate_id = ? AND status = 'in_flight' AND claim_token = ?`,
      completedAtMs,
      claim.operationId,
      claim.scopeKey,
      SECTION_AGGREGATE,
      claim.aggregateId,
      claim.claimToken,
    );
    if (acknowledged.changes !== 1) return false;
    await database.runAsync(
      `UPDATE meeting_summary_remote_sections SET remote_revision = ?,
         remote_user_text = ?, remote_visible_citation_ids_json = ?,
         remote_client_updated_at_ms = ?, remote_updated_at_ms = ?
       WHERE scope_key = ? AND local_section_id = ?`,
      remote.revision,
      remote.userText,
      JSON.stringify(remote.visibleCitationIds),
      remote.clientUpdatedAtMs,
      remote.serverUpdatedAtMs,
      claim.scopeKey,
      claim.aggregateId,
    );
    await refreshMeetingSyncState(database, claim.meetingId, claim.scopeKey);
    return true;
  });
}

export async function completeMeetingSummaryCurrentSyncClaim(
  claim: SummarySyncClaim,
  remote: RemoteSummaryCurrentV1,
  completedAtMs: number,
): Promise<boolean> {
  if (claim.kind !== 'current') throw new Error('当前整理结果同步认领类型无效');
  time(completedAtMs, '当前整理结果同步完成时间');
  return withMeetingDatabaseTransaction(async database => {
    const target = await database.getFirstAsync<RemoteVersionRow>(
      `SELECT * FROM meeting_summary_remote_versions
       WHERE scope_key = ? AND remote_version_id = ?`,
      claim.scopeKey,
      remote.remoteVersionId,
    );
    if (!target || target.meeting_id !== claim.meetingId || remote.meetingRemoteId !== claim.meetingRemoteId) {
      return false;
    }
    const acknowledged = await database.runAsync(
      `UPDATE sync_outbox SET status = 'completed', next_attempt_at_ms = NULL,
         last_error_code = NULL, request_payload_json = NULL, claim_token = NULL,
         updated_at_ms = ?
       WHERE operation_id = ? AND scope_key = ? AND aggregate_type = ?
         AND aggregate_id = ? AND status = 'in_flight' AND claim_token = ?`,
      completedAtMs,
      claim.operationId,
      claim.scopeKey,
      CURRENT_AGGREGATE,
      claim.aggregateId,
      claim.claimToken,
    );
    if (acknowledged.changes !== 1) return false;
    await database.runAsync(
      `UPDATE meeting_summary_current_sync SET local_version_id = ?,
         remote_version_id = ?, remote_revision = ?,
         remote_client_updated_at_ms = ?, remote_updated_at_ms = ?
       WHERE scope_key = ? AND meeting_id = ?`,
      target.local_version_id,
      target.remote_version_id,
      remote.revision,
      remote.clientUpdatedAtMs,
      remote.serverUpdatedAtMs,
      claim.scopeKey,
      claim.meetingId,
    );
    await refreshMeetingSyncState(database, claim.meetingId, claim.scopeKey);
    return true;
  });
}

export async function failMeetingSummarySyncClaim(
  claim: SummarySyncClaim,
  failure: SummarySyncFailure,
): Promise<boolean> {
  return withMeetingDatabaseTransaction(async database => {
    const status = failure.disposition === 'retry'
      ? 'retry'
      : failure.disposition === 'blocked' ? 'blocked' : 'permanent_error';
    const updated = await database.runAsync(
      `UPDATE sync_outbox SET status = ?, next_attempt_at_ms = ?,
         last_error_code = ?, claim_token = NULL, updated_at_ms = ?
       WHERE operation_id = ? AND scope_key = ? AND aggregate_id = ?
         AND status = 'in_flight' AND claim_token = ?`,
      status,
      failure.nextAttemptAtMs,
      failure.errorCode,
      failure.updatedAtMs,
      claim.operationId,
      claim.scopeKey,
      claim.aggregateId,
      claim.claimToken,
    );
    if (updated.changes !== 1) return false;
    await refreshMeetingSyncState(database, claim.meetingId, claim.scopeKey);
    return true;
  });
}

export async function recordMeetingSummarySyncConflict(
  claim: SummarySyncClaim,
  input: { remoteRevision: number | null; remotePayloadJson: string; createdAtMs: number },
): Promise<boolean> {
  return withMeetingDatabaseTransaction(async database => {
    const row = await database.getFirstAsync<OutboxRow>(
      `SELECT * FROM sync_outbox WHERE operation_id = ? AND scope_key = ?
       AND aggregate_id = ? AND status = 'in_flight' AND claim_token = ?`,
      claim.operationId,
      claim.scopeKey,
      claim.aggregateId,
      claim.claimToken,
    );
    if (!row) return false;
    await recordPullConflict(database, {
      scopeKey: claim.scopeKey,
      meetingId: claim.meetingId,
      aggregateType: claim.kind === 'section' ? SECTION_AGGREGATE : CURRENT_AGGREGATE,
      aggregateId: claim.aggregateId,
      localRevision: row.base_revision,
      remoteRevision: input.remoteRevision ?? 0,
      localPayloadJson: claim.requestPayloadJson,
      remotePayloadJson: input.remotePayloadJson,
      createdAtMs: input.createdAtMs,
    });
    await refreshMeetingSyncState(database, claim.meetingId, claim.scopeKey);
    return true;
  });
}

export async function listMeetingSummarySyncConflicts(
  scopeKey: ScopeKey,
  meetingId: string,
): Promise<readonly SummarySyncConflictRecord[]> {
  assertAccountScope(scopeKey);
  const database = await openMeetingDatabase();
  const rows = await database.getAllAsync<{
    id: string;
    aggregate_type: SummarySyncConflictRecord['aggregateType'];
    aggregate_id: string;
    local_revision: number | null;
    remote_revision: number | null;
    local_payload_json: string;
    remote_payload_json: string;
    created_at_ms: number;
  }>(
    `SELECT conflict.id, conflict.aggregate_type, conflict.aggregate_id,
       conflict.local_revision, conflict.remote_revision,
       conflict.local_payload_json, conflict.remote_payload_json,
       conflict.created_at_ms
     FROM sync_conflicts conflict
     LEFT JOIN meeting_summary_remote_sections section
       ON conflict.aggregate_type = ?
      AND section.scope_key = conflict.scope_key
      AND section.local_section_id = conflict.aggregate_id
     WHERE conflict.scope_key = ? AND conflict.status = 'unresolved'
       AND conflict.aggregate_type IN (?, ?)
       AND CASE WHEN conflict.aggregate_type = ?
         THEN section.meeting_id ELSE conflict.aggregate_id END = ?
     ORDER BY conflict.created_at_ms, conflict.id`,
    SECTION_AGGREGATE,
    scopeKey,
    SECTION_AGGREGATE,
    CURRENT_AGGREGATE,
    SECTION_AGGREGATE,
    meetingId,
  );
  return rows.map(row => ({
    id: row.id,
    meetingId,
    aggregateType: row.aggregate_type,
    aggregateId: row.aggregate_id,
    localRevision: row.local_revision,
    remoteRevision: row.remote_revision,
    localPayloadJson: row.local_payload_json,
    remotePayloadJson: row.remote_payload_json,
    createdAtMs: row.created_at_ms,
  }));
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function conflictCurrent(value: string): Record<string, unknown> {
  const root = record(JSON.parse(value));
  if (!root) throw new Error('整理结果云端冲突内容无效');
  return record(root.current) ?? root;
}

function field(root: Record<string, unknown>, camel: string, snake: string): unknown {
  return root[camel] ?? root[snake];
}

function conflictInteger(
  root: Record<string, unknown>,
  camel: string,
  snake: string,
  label: string,
  minimum = 0,
): number {
  const value = field(root, camel, snake);
  if (!Number.isSafeInteger(value) || Number(value) < minimum) throw new Error(`${label}无效`);
  return Number(value);
}

function conflictServerTime(root: Record<string, unknown>, camel: string, snake: string): number {
  const value = field(root, camel, snake);
  if (Number.isSafeInteger(value) && Number(value) >= 0) return Number(value);
  if (typeof value === 'string') {
    const parsed = Date.parse(value);
    if (Number.isSafeInteger(parsed) && parsed >= 0) return parsed;
  }
  throw new Error('整理结果云端更新时间无效');
}

function conflictString(
  root: Record<string, unknown>,
  camel: string,
  snake: string,
  label: string,
  maximum = 512,
): string {
  const value = field(root, camel, snake);
  return identifier(typeof value === 'string' ? value : '', label, maximum);
}

function conflictNullableText(root: Record<string, unknown>): string | null {
  const value = field(root, 'userText', 'user_text');
  if (value === null) return null;
  if (typeof value !== 'string' || !value.trim() || value.length > 20_000 || value.includes('\u0000')) {
    throw new Error('整理内容云端人工修改无效');
  }
  return value.replace(/\r\n?/g, '\n').trim();
}

function conflictIds(root: Record<string, unknown>, camel: string, snake: string): readonly string[] {
  const value = field(root, camel, snake);
  if (!Array.isArray(value) || value.length > 100) throw new Error('整理结果云端引用无效');
  const result = value.map(item => identifier(typeof item === 'string' ? item : '', '整理结果云端引用标识'));
  if (new Set(result).size !== result.length) throw new Error('整理结果云端引用重复');
  return result;
}

export async function resolveMeetingSummarySyncConflict(input: {
  scopeKey: ScopeKey;
  meetingId: string;
  conflictId: string;
  resolution: 'keep_local' | 'use_remote';
  resolvedAtMs: number;
}): Promise<boolean> {
  const scopeKey = input.scopeKey;
  assertAccountScope(scopeKey);
  identifier(input.meetingId, '整理结果冲突会议标识');
  identifier(input.conflictId, '整理结果冲突标识');
  time(input.resolvedAtMs, '整理结果冲突处理时间');
  return withMeetingDatabaseTransaction(async database => {
    const conflict = await database.getFirstAsync<{
      id: string;
      aggregate_type: typeof SECTION_AGGREGATE | typeof CURRENT_AGGREGATE;
      aggregate_id: string;
      local_payload_json: string;
      remote_payload_json: string;
    }>(
      `SELECT id, aggregate_type, aggregate_id, local_payload_json, remote_payload_json
       FROM sync_conflicts WHERE id = ? AND scope_key = ?
         AND aggregate_type IN (?, ?) AND status = 'unresolved'`,
      input.conflictId,
      scopeKey,
      SECTION_AGGREGATE,
      CURRENT_AGGREGATE,
    );
    if (!conflict) return false;
    const remoteRoot = conflictCurrent(conflict.remote_payload_json);
    if (conflict.aggregate_type === SECTION_AGGREGATE) {
      const state = await localSectionState(database, scopeKey, conflict.aggregate_id);
      if (!state || state.mapping.meeting_id !== input.meetingId) return false;
      const localAtConflict = record(JSON.parse(conflict.local_payload_json));
      const localNow = record(JSON.parse(sectionPayload(state)));
      if (
        !localAtConflict
        || !localNow
        || localAtConflict.user_text !== localNow.user_text
        || JSON.stringify(localAtConflict.visible_citation_ids)
          !== JSON.stringify(localNow.visible_citation_ids)
      ) return false;
      const remoteVersionId = conflictString(
        remoteRoot,
        'remoteVersionId',
        'version_id',
        '整理结果云端标识',
        160,
      );
      const remoteSectionId = conflictString(
        remoteRoot,
        'remoteSectionId',
        'section_id',
        '整理内容云端标识',
      );
      if (
        remoteVersionId !== state.mapping.remote_version_id
        || remoteSectionId !== state.mapping.remote_section_id
      ) throw new Error('整理内容冲突身份已变化');
      const remoteRevision = conflictInteger(
        remoteRoot,
        'revision',
        'revision',
        '整理内容云端版本',
        1,
      );
      const remoteUserText = conflictNullableText(remoteRoot);
      const remoteVisible = conflictIds(remoteRoot, 'visibleCitationIds', 'visible_citation_ids');
      const generatedIds = parseIds(
        state.mapping.remote_generated_citation_ids_json,
        '整理结果生成引用标识',
      );
      if (remoteVisible.some(id => !generatedIds.includes(id))) {
        throw new Error('整理内容云端引用身份已变化');
      }
      const remoteClientUpdatedAtMs = conflictInteger(
        remoteRoot,
        'clientUpdatedAtMs',
        'client_updated_at_ms',
        '整理内容云端更新时间',
      );
      const remoteUpdatedAtMs = conflictServerTime(
        remoteRoot,
        'serverUpdatedAtMs',
        'updated_at',
      );
      await database.runAsync(
        `UPDATE meeting_summary_remote_sections SET remote_revision = ?,
           remote_user_text = ?, remote_visible_citation_ids_json = ?,
           remote_client_updated_at_ms = ?, remote_updated_at_ms = ?
         WHERE scope_key = ? AND local_section_id = ?`,
        remoteRevision,
        remoteUserText,
        JSON.stringify(remoteVisible),
        remoteClientUpdatedAtMs,
        remoteUpdatedAtMs,
        scopeKey,
        conflict.aggregate_id,
      );
      await markAggregateSatisfied(
        database,
        scopeKey,
        SECTION_AGGREGATE,
        conflict.aggregate_id,
        input.resolvedAtMs,
      );
      if (input.resolution === 'use_remote') {
        const citations = await database.getAllAsync<{
          remote_citation_id: string;
          local_citation_id: string;
        }>(
          `SELECT remote_citation_id, local_citation_id
           FROM meeting_summary_remote_citations
           WHERE scope_key = ? AND local_section_id = ?`,
          scopeKey,
          conflict.aggregate_id,
        );
        await applyRemoteSectionToLocal(database, {
          localVersionId: state.mapping.local_version_id,
          localSectionId: conflict.aggregate_id,
          remote: {
            meetingRemoteId: '',
            remoteVersionId,
            remoteSectionId,
            stableKey: state.section.stable_key,
            ordinal: state.section.ordinal,
            revision: remoteRevision,
            userText: remoteUserText,
            visibleCitationIds: remoteVisible,
            clientUpdatedAtMs: remoteClientUpdatedAtMs,
            serverCreatedAtMs: 0,
            serverUpdatedAtMs: remoteUpdatedAtMs,
          },
          citationMap: new Map(citations.map(item => [
            item.remote_citation_id,
            item.local_citation_id,
          ])),
        });
      } else {
        const refreshed = await localSectionState(database, scopeKey, conflict.aggregate_id);
        if (!refreshed) return false;
        await insertOperation(database, {
          scopeKey,
          aggregateType: SECTION_AGGREGATE,
          aggregateId: conflict.aggregate_id,
          operationType: SECTION_OPERATION,
          baseRevision: remoteRevision,
          payloadJson: sectionPayload(refreshed),
          createdAtMs: input.resolvedAtMs,
        });
      }
    } else {
      if (conflict.aggregate_id !== input.meetingId) return false;
      const sync = await database.getFirstAsync<CurrentSyncRow>(
        `SELECT * FROM meeting_summary_current_sync
         WHERE scope_key = ? AND meeting_id = ?`,
        scopeKey,
        input.meetingId,
      );
      if (!sync) return false;
      const localAtConflict = record(JSON.parse(conflict.local_payload_json));
      const localNowJson = await currentPayload(database, scopeKey, input.meetingId);
      const localNow = localNowJson ? record(JSON.parse(localNowJson)) : null;
      if (
        !localAtConflict
        || !localNow
        || localAtConflict.remote_version_id !== localNow.remote_version_id
      ) return false;
      const remoteVersionId = conflictString(
        remoteRoot,
        'remoteVersionId',
        'version_id',
        '当前整理结果云端标识',
        160,
      );
      const target = await database.getFirstAsync<RemoteVersionRow>(
        `SELECT * FROM meeting_summary_remote_versions
         WHERE scope_key = ? AND remote_version_id = ?`,
        scopeKey,
        remoteVersionId,
      );
      if (!target || target.meeting_id !== input.meetingId) {
        throw new Error('当前整理结果冲突版本无法映射');
      }
      const remoteRevision = conflictInteger(
        remoteRoot,
        'revision',
        'revision',
        '当前整理结果云端版本',
        1,
      );
      const remoteClientUpdatedAtMs = conflictInteger(
        remoteRoot,
        'clientUpdatedAtMs',
        'client_updated_at_ms',
        '当前整理结果云端更新时间',
      );
      const remoteUpdatedAtMs = conflictServerTime(
        remoteRoot,
        'serverUpdatedAtMs',
        'updated_at',
      );
      await database.runAsync(
        `UPDATE meeting_summary_current_sync SET local_version_id = ?,
           remote_version_id = ?, remote_revision = ?,
           remote_client_updated_at_ms = ?, remote_updated_at_ms = ?
         WHERE scope_key = ? AND meeting_id = ?`,
        target.local_version_id,
        target.remote_version_id,
        remoteRevision,
        remoteClientUpdatedAtMs,
        remoteUpdatedAtMs,
        scopeKey,
        input.meetingId,
      );
      await markAggregateSatisfied(
        database,
        scopeKey,
        CURRENT_AGGREGATE,
        input.meetingId,
        input.resolvedAtMs,
      );
      if (input.resolution === 'use_remote') {
        await database.runAsync(
          `UPDATE meeting_notes SET current_summary_version_id = ?,
             updated_at_ms = MAX(updated_at_ms, ?)
           WHERE id = ? AND scope_key = ?`,
          target.local_version_id,
          remoteClientUpdatedAtMs,
          input.meetingId,
          scopeKey,
        );
      } else {
        const refreshed = await currentPayload(database, scopeKey, input.meetingId);
        if (!refreshed) return false;
        await insertOperation(database, {
          scopeKey,
          aggregateType: CURRENT_AGGREGATE,
          aggregateId: input.meetingId,
          operationType: CURRENT_OPERATION,
          baseRevision: remoteRevision,
          payloadJson: refreshed,
          createdAtMs: input.resolvedAtMs,
        });
      }
    }
    await refreshMeetingSyncState(database, input.meetingId, scopeKey);
    return true;
  });
}
