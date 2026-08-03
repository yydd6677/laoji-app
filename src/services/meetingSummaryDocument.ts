import type {
  MeetingSummaryActionCandidate,
  MeetingSummaryCitation,
  MeetingSummaryDocument,
  MeetingSummarySection,
  MeetingSummarySectionKind,
} from '../domain/meeting';

type UnknownRecord = Record<string, unknown>;

const MAX_SECTIONS = 50;
const MAX_CITATIONS_PER_ITEM = 100;
const MAX_ACTIONS = 100;
const MAX_CONTENT_LENGTH = 200_000;
const SECTION_KINDS = new Set<MeetingSummarySectionKind>([
  'paragraph',
  'bullets',
  'numbered',
  'decisions',
  'topics',
  'risks',
  'action_items',
  'legacy',
]);

export interface LegacyMeetingSummaryLike {
  id?: string;
  meeting_id?: string;
  overview?: string;
  full_text?: string;
  key_decisions?: readonly string[];
  action_items?: readonly {
    id?: string;
    content: string;
    assignee?: string | null;
    due_date?: string | null;
    status?: string;
  }[];
  generated_at?: string | null;
}

function asRecord(value: unknown): UnknownRecord | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as UnknownRecord
    : null;
}

function parseRecord(value: unknown): UnknownRecord | null {
  const direct = asRecord(value);
  if (direct) return direct;
  if (typeof value !== 'string') return null;
  const clean = value
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim();
  if (!clean.startsWith('{') || !clean.endsWith('}')) return null;
  try {
    return asRecord(JSON.parse(clean));
  } catch {
    return null;
  }
}

function firstValue(record: UnknownRecord, ...keys: readonly string[]): unknown {
  for (const key of keys) {
    if (Object.prototype.hasOwnProperty.call(record, key)) return record[key];
  }
  return undefined;
}

function text(value: unknown, maximum = MAX_CONTENT_LENGTH): string {
  if (typeof value !== 'string' && typeof value !== 'number') return '';
  return String(value).replace(/\r\n?/g, '\n').trim().slice(0, maximum);
}

const SUMMARY_TEXT_KEYS = [
  'overview', 'tldr', 'summary', 'content', 'text', 'description', 'decision',
  'task', 'title', 'name', 'person', 'date', 'due_date', 'deadline', 'question', 'answer',
] as const;

function parseSummaryJsonText(value: string): unknown {
  let clean = value.trim();
  if (clean.startsWith('```')) {
    clean = clean
      .replace(/^```(?:json|javascript|js)?\s*/i, '')
      .replace(/\s*```$/i, '')
      .trim();
  }
  if (!clean || !['{', '[', '"'].includes(clean[0] ?? '')) return undefined;
  try {
    return JSON.parse(clean) as unknown;
  } catch {
    return undefined;
  }
}

function looksLikeSummaryJsonContainer(value: string): boolean {
  const clean = value.trim();
  if (clean.startsWith('{')) return /^\{\s*(?:"[^"]+"|[A-Za-z_][A-Za-z0-9_-]*)\s*:/.test(clean);
  if (clean.startsWith('[')) return /^\[\s*(?:\{|"|\[)/.test(clean);
  return false;
}

function contentText(value: unknown, depth = 0): string {
  if (depth > 3) return '';
  if (Array.isArray(value)) {
    return value
      .map(item => contentText(item, depth + 1))
      .filter(Boolean)
      .join('\n')
      .slice(0, MAX_CONTENT_LENGTH);
  }
  if (typeof value === 'string') {
    const decoded = parseSummaryJsonText(value);
    if (decoded !== undefined && decoded !== value) {
      return contentText(decoded, depth + 1);
    }
    if (looksLikeSummaryJsonContainer(value)) return '';
    return text(value);
  }
  if (typeof value === 'number') return text(value);
  const record = asRecord(value);
  if (!record) return '';
  for (const key of SUMMARY_TEXT_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(record, key)) continue;
    const result = contentText(record[key], depth + 1);
    if (result) return result;
  }
  // Metadata-only objects must not be stringified into user-visible content.
  return '';
}

function nonNegativeInteger(value: unknown, fallback = 0): number {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.max(0, Math.trunc(value))
    : fallback;
}

function optionalNonNegativeInteger(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? Math.trunc(value)
    : null;
}

function boolean(value: unknown): boolean {
  return value === true || value === 1 || value === '1' || value === 'true';
}

function timestamp(value: unknown, fallback: number): number {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.max(0, Math.trunc(value));
  const parsed = typeof value === 'string' ? Date.parse(value) : Number.NaN;
  return Number.isFinite(parsed) ? Math.max(0, Math.trunc(parsed)) : fallback;
}

function summaryKind(value: unknown): MeetingSummarySectionKind {
  const normalized = text(value, 40).toLowerCase().replace(/-/g, '_');
  if (SECTION_KINDS.has(normalized as MeetingSummarySectionKind)) {
    return normalized as MeetingSummarySectionKind;
  }
  if (normalized === 'bullet' || normalized === 'list') return 'bullets';
  if (normalized === 'decision') return 'decisions';
  if (normalized === 'overview' || normalized === 'summary') return 'paragraph';
  return 'paragraph';
}

function actionStatus(value: unknown): MeetingSummaryActionCandidate['status'] {
  const normalized = text(value, 30).toLowerCase();
  if (['completed', 'complete', 'done'].includes(normalized)) return 'completed';
  if (['dismissed', 'cancelled', 'canceled'].includes(normalized)) return 'dismissed';
  return 'pending';
}

function citations(
  value: unknown,
  fallbackPrefix: string,
): MeetingSummaryCitation[] {
  if (!Array.isArray(value)) return [];
  const ids = new Set<string>();
  const result: MeetingSummaryCitation[] = [];
  value.slice(0, MAX_CITATIONS_PER_ITEM).forEach((candidate, index) => {
    const record = asRecord(candidate);
    if (!record) return;
    const segmentId = text(firstValue(record, 'segmentId', 'segment_id'), 240);
    if (!segmentId) return;
    const startMs = optionalNonNegativeInteger(firstValue(record, 'startMs', 'start_ms'));
    if (startMs === null) return;
    const rawEndMs = firstValue(record, 'endMs', 'end_ms');
    const endMs = rawEndMs === undefined ? startMs : optionalNonNegativeInteger(rawEndMs);
    if (endMs === null || endMs < startMs) return;
    let id = text(record.id, 240) || `${fallbackPrefix}:citation:${index}`;
    if (ids.has(id)) id = `${id}:${index}`;
    ids.add(id);
    result.push({
      id,
      segmentId,
      startMs,
      endMs,
      quoteHash: text(firstValue(record, 'quoteHash', 'quote_hash'), 200) || null,
    });
  });
  return result;
}

function parseSections(value: unknown): MeetingSummarySection[] | null {
  if (!Array.isArray(value)) return null;
  const ids = new Set<string>();
  const keys = new Set<string>();
  const result: MeetingSummarySection[] = [];
  for (const [index, candidate] of value.slice(0, MAX_SECTIONS).entries()) {
    const record = asRecord(candidate);
    if (!record) return null;
    const stableKey = text(firstValue(record, 'stableKey', 'stable_key', 'key'), 120)
      || `section_${index}`;
    if (keys.has(stableKey)) return null;
    keys.add(stableKey);
    let id = text(record.id, 240) || `summary-section:${stableKey}`;
    if (ids.has(id)) id = `${id}:${index}`;
    ids.add(id);
    const content = contentText(firstValue(record, 'content', 'text', 'generatedText', 'generated_text'));
    const title = text(record.title, 200) || null;
    if (!content && !title) continue;
    result.push({
      id,
      stableKey,
      kind: summaryKind(record.kind),
      title,
      content,
      userEdited: boolean(firstValue(record, 'userEdited', 'user_edited')),
      userEditedAtMs: optionalNonNegativeInteger(firstValue(record, 'userEditedAtMs', 'user_edited_at_ms')),
      citations: citations(record.citations, id),
    });
  }
  return result;
}

function parseActions(value: unknown): MeetingSummaryActionCandidate[] {
  if (!Array.isArray(value)) return [];
  const ids = new Set<string>();
  const result: MeetingSummaryActionCandidate[] = [];
  value.slice(0, MAX_ACTIONS).forEach((candidate, index) => {
    const record = asRecord(candidate);
    const content = record
      ? contentText(firstValue(record, 'content', 'task', 'description', 'text', 'title'))
      : contentText(candidate);
    if (!content) return;
    let id = text(record?.id, 240) || `summary-action:${index}`;
    if (ids.has(id)) id = `${id}:${index}`;
    ids.add(id);
    const due = firstValue(record ?? {}, 'dueAtMs', 'due_at_ms', 'due_at', 'due_date', 'due', 'deadline');
    const dueAtMs = timestamp(due, 0) || null;
    result.push({
      id,
      content,
      assignee: contentText(firstValue(record ?? {}, 'assignee', 'owner', 'responsible_person')).slice(0, 200) || null,
      dueAtMs,
      reminderAtMs: null,
      reminderNotificationId: null,
      followupEventSourceId: null,
      status: actionStatus(record?.status),
      citations: citations(record?.citations, id),
    });
  });
  return result;
}

/** Strictly normalizes the additive v2 API or a previously cached camelCase document. */
export function normalizeMeetingSummaryDocument(
  meetingId: string,
  value: unknown,
): MeetingSummaryDocument | null {
  const outer = parseRecord(value);
  if (!outer) return null;
  const nested = asRecord(firstValue(outer, 'structured_document', 'structuredDocument'));
  const root = nested ?? outer;
  const schemaVersion = nonNegativeInteger(firstValue(root, 'schemaVersion', 'schema_version'));
  if (schemaVersion !== 2) return null;
  const sections = parseSections(root.sections);
  if (sections === null) return null;
  const actions = parseActions(firstValue(root, 'actionItemCandidates', 'action_item_candidates'));
  if (sections.length === 0 && actions.length === 0) return null;
  const payloadMeetingId = text(firstValue(root, 'meetingId', 'meeting_id'), 240);
  if (payloadMeetingId && payloadMeetingId !== meetingId) return null;
  const createdAtMs = timestamp(
    firstValue(root, 'createdAtMs', 'created_at', 'generated_at'),
    0,
  );
  const completedAtMs = Math.max(
    createdAtMs,
    timestamp(firstValue(root, 'completedAtMs', 'completed_at', 'generated_at'), createdAtMs),
  );
  return {
    schemaVersion: 2,
    remoteVersionId: text(firstValue(root, 'remoteVersionId', 'version_id', 'id'), 240) || null,
    meetingId,
    templateId: text(firstValue(root, 'templateId', 'template_id'), 120) || 'general',
    templateRevision: nonNegativeInteger(firstValue(root, 'templateRevision', 'template_revision'), 1),
    transcriptRevisionId: text(firstValue(root, 'transcriptRevisionId', 'transcript_revision_id'), 240) || null,
    manualNoteRevision: nonNegativeInteger(firstValue(root, 'manualNoteRevision', 'manual_note_revision')),
    scheduleSnapshotHash: text(firstValue(root, 'scheduleSnapshotHash', 'schedule_snapshot_hash'), 200) || null,
    status: text(root.status, 30).toLowerCase() === 'stale' ? 'stale' : 'ready',
    generatedBy: text(firstValue(root, 'generatedBy', 'generated_by'), 120) || null,
    supersedesVersionId: text(firstValue(root, 'supersedesVersionId', 'supersedes_version_id'), 240) || null,
    createdAtMs,
    completedAtMs,
    sections,
    actionItemCandidates: actions,
  };
}

/** Compatibility adapter used only until every server and cache emits schema v2. */
export function legacyMeetingSummaryToDocument(
  meetingId: string,
  summary: LegacyMeetingSummaryLike,
): MeetingSummaryDocument | null {
  const overview = contentText(summary.overview || summary.full_text);
  const decisions = (summary.key_decisions ?? []).map(item => contentText(item)).filter(Boolean);
  const actions = parseActions(summary.action_items ?? []);
  const sections: MeetingSummarySection[] = [];
  if (overview) {
    sections.push({
      id: 'legacy-section:overview',
      stableKey: 'overview',
      kind: 'paragraph',
      title: '会议概述',
      content: overview,
      citations: [],
    });
  }
  if (decisions.length > 0) {
    sections.push({
      id: 'legacy-section:decisions',
      stableKey: 'decisions',
      kind: 'decisions',
      title: '关键决定',
      content: decisions.join('\n'),
      citations: [],
    });
  }
  if (sections.length === 0 && actions.length === 0) return null;
  const createdAtMs = timestamp(summary.generated_at, Date.now());
  return {
    schemaVersion: 2,
    remoteVersionId: text(summary.id, 240) || null,
    meetingId: text(summary.meeting_id, 240) || meetingId,
    templateId: 'legacy',
    templateRevision: 1,
    transcriptRevisionId: null,
    manualNoteRevision: 0,
    scheduleSnapshotHash: null,
    status: 'ready',
    generatedBy: 'legacy-adapter',
    supersedesVersionId: null,
    createdAtMs,
    completedAtMs: createdAtMs,
    sections,
    actionItemCandidates: actions,
  };
}

export function meetingSummaryDocumentForLegacy(
  meetingId: string,
  summary: LegacyMeetingSummaryLike,
): MeetingSummaryDocument | null {
  return normalizeMeetingSummaryDocument(meetingId, summary)
    ?? legacyMeetingSummaryToDocument(meetingId, summary);
}

function actionText(action: MeetingSummaryActionCandidate): string {
  const details: string[] = [];
  if (action.assignee && !action.content.includes(action.assignee)) details.push(`负责人：${action.assignee}`);
  if (action.dueAtMs !== null) {
    const date = new Date(action.dueAtMs);
    if (!Number.isNaN(date.getTime())) {
      details.push(`截止：${date.getFullYear()}年${date.getMonth() + 1}月${date.getDate()}日`);
    }
  }
  const content = action.status === 'completed'
    ? `已完成：${action.content}`
    : action.status === 'dismissed'
      ? `已忽略：${action.content}`
      : action.content;
  return details.length > 0 ? `${content}（${details.join('，')}）` : content;
}

export function meetingSummaryDocumentToText(document: MeetingSummaryDocument): string {
  const sections = document.sections.map(section => {
    const heading = section.title ? `## ${section.title}\n` : '';
    const body = ['bullets', 'decisions', 'topics', 'risks', 'action_items'].includes(section.kind)
      ? contentText(section.content).split(/\r?\n/).map(item => item.trim()).filter(Boolean).map(item => `- ${item}`).join('\n')
      : contentText(section.content);
    return `${heading}${body}`.trim();
  }).filter(Boolean);
  if (document.actionItemCandidates.length > 0) {
    sections.push(`## 待办事项\n${document.actionItemCandidates.map(item => `- ${actionText(item)}`).join('\n')}`);
  }
  return sections.join('\n\n');
}
