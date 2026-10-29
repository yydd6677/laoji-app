import type {
  MeetingSummaryActionCandidate,
  MeetingSummaryCitation,
  MeetingSummaryDocument,
  MeetingSummaryRichBlock,
  MeetingSummaryRichEdge,
  MeetingSummaryRichItem,
  MeetingSummarySection,
  MeetingSummarySectionKind,
} from '../domain/meeting';
import { isNormalizedMeetingSummaryActionLabel } from '../domain/meeting/summarySectionClassification';
import { toSimplifiedChinese } from '../utils/simplifiedChinese';

type UnknownRecord = Record<string, unknown>;

const MAX_SECTIONS = 50;
const MAX_CITATIONS_PER_ITEM = 100;
const MAX_ACTIONS = 100;
const MAX_CONTENT_LENGTH = 200_000;
const SECTION_KINDS = new Set<MeetingSummarySectionKind>([
  'paragraph',
  'bullet_group',
  'quote',
  'timeline',
  'flow',
  'comparison',
  'risk_card',
  'stat',
  'action_items',
]);
const RICH_BLOCK_KINDS = new Set<MeetingSummaryRichBlock['kind']>([
  'paragraph', 'bullet_group', 'quote', 'timeline', 'flow', 'comparison', 'risk_card', 'stat',
]);
const RICH_ICON_KEYS = new Set<MeetingSummaryRichBlock['iconKey']>([
  'overview', 'topic', 'quote', 'time', 'flow', 'compare', 'risk', 'stat', 'action',
]);

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
  return toSimplifiedChinese(String(value).replace(/\r\n?/g, '\n').trim().slice(0, maximum));
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
  if (normalized === 'bullet' || normalized === 'list') return 'bullet_group';
  if (normalized === 'decision') return 'bullet_group';
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
      sourceType: ['transcript', 'manual_note', 'attachment'].includes(
        text(firstValue(record, 'sourceType', 'source_type'), 30),
      )
        ? text(firstValue(record, 'sourceType', 'source_type'), 30) as MeetingSummaryCitation['sourceType']
        : undefined,
      sourceLabel: text(firstValue(record, 'sourceLabel', 'source_label'), 120) || null,
      excerpt: text(firstValue(record, 'excerpt', 'quote', 'source_excerpt'), 600) || null,
    });
  });
  return result;
}

function richBlock(value: unknown): MeetingSummaryRichBlock | undefined {
  const record = asRecord(value);
  if (!record) return undefined;
  const kind = text(record.kind, 40) as MeetingSummaryRichBlock['kind'];
  const iconKey = text(firstValue(record, 'iconKey', 'icon_key'), 40) as MeetingSummaryRichBlock['iconKey'];
  if (!RICH_BLOCK_KINDS.has(kind) || !RICH_ICON_KEYS.has(iconKey) || !Array.isArray(record.items)) {
    return undefined;
  }
  const items: MeetingSummaryRichItem[] = [];
  const itemIds = new Set<string>();
  for (const [index, candidate] of record.items.slice(0, 12).entries()) {
    const item = asRecord(candidate);
    if (!item) return undefined;
    const itemText = text(item.text, 2_000);
    if (!itemText) continue;
    let id = text(item.id, 120) || `rich-item:${index}`;
    if (itemIds.has(id)) id = `${id}:${index}`;
    itemIds.add(id);
    items.push({
      id,
      title: text(item.title, 200) || null,
      text: itemText,
      meta: text(item.meta, 200) || null,
      sourceId: text(firstValue(item, 'sourceId', 'source_id'), 240) || null,
      startMs: optionalNonNegativeInteger(firstValue(item, 'startMs', 'start_ms')),
    });
  }
  if (items.length === 0) return undefined;
  const edges: MeetingSummaryRichEdge[] = [];
  if (record.edges !== undefined) {
    if (!Array.isArray(record.edges)) return undefined;
    const validIds = new Set(items.map(item => item.id));
    for (const candidate of record.edges.slice(0, 10)) {
      const edge = asRecord(candidate);
      if (!edge) return undefined;
      const from = text(edge.from, 120);
      const to = text(edge.to, 120);
      if (!from || !to || from === to || !validIds.has(from) || !validIds.has(to)) continue;
      edges.push({ from, to, label: text(edge.label, 80) || null });
    }
  }
  return {
    kind,
    iconKey,
    items,
    ...(edges.length > 0 ? { edges } : {}),
    edited: boolean(record.edited),
    originalSourceLabel: text(
      firstValue(record, 'originalSourceLabel', 'original_source_label'),
      120,
    ) || null,
  };
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
      richBlock: richBlock(firstValue(record, 'richBlock', 'rich_block')),
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
      dueText: text(firstValue(record ?? {}, 'dueText', 'due_text'), 200) || null,
      reminderAtMs: null,
      reminderNotificationId: null,
      followupEventSourceId: null,
      status: actionStatus(record?.status),
      citations: citations(record?.citations, id),
      scheduleFit: ['high', 'medium', 'low'].includes(
        text(firstValue(record ?? {}, 'scheduleFit', 'schedule_fit'), 20),
      )
        ? text(firstValue(record ?? {}, 'scheduleFit', 'schedule_fit'), 20) as MeetingSummaryActionCandidate['scheduleFit']
        : undefined,
      evidenceScore: typeof firstValue(record ?? {}, 'evidenceScore', 'evidence_score') === 'number'
        ? Math.min(1, Math.max(0, Number(firstValue(record ?? {}, 'evidenceScore', 'evidence_score'))))
        : undefined,
    });
  });
  return result;
}

function isDecisionSection(section: Pick<MeetingSummarySection, 'kind' | 'stableKey' | 'title'>): boolean {
  const normalized = [section.kind, section.stableKey, section.title ?? '']
    .map(value => toSimplifiedChinese(String(value)).replace(/[\s:：\-—_（）()【】\[\]]/g, '').toLowerCase());
  return normalized.some(value => value === 'decisions' || value === 'decision' || value === '决定' || value === '关键决定' || value === 'commitments' || value === '双方约定');
}

export function meetingSummarySectionsForPresentation(
  sections: readonly MeetingSummarySection[],
): MeetingSummarySection[] {
  const decisions = sections
    .filter(isDecisionSection)
    .map(section => contentText(section.content))
    .filter(Boolean);
  const kept = sections.filter(section => !isDecisionSection(section));
  if (decisions.length === 0) return kept;
  const overview = kept.find(section => section.stableKey === 'overview' || section.kind === 'paragraph');
  if (!overview) return kept;
  const existing = normalizedActionPart(overview.content);
  const additions = decisions.filter(decision => !existing.includes(normalizedActionPart(decision)));
  if (additions.length === 0) return kept;
  return kept.map(section => section.id === overview.id
    ? {
      ...section,
      content: `${section.content.trim().replace(/[。；;]+$/, '')}。会议明确：${additions.join('；')}。`,
    }
    : section);
}

function normalizedActionPart(value: string): string {
  return toSimplifiedChinese(value)
    .replace(/^\s*(?:[-*+•]|\d+[.)、])\s*/, '')
    .replace(/^\s*(?:待办事项|待办|行动项|行动事项|任务|后续事项|下一步)\s*[：:]\s*/i, '')
    .replace(/\s+/g, '')
    .toLowerCase();
}

/** Returns a stable semantic key so provider duplicates do not render twice. */
function meetingSummaryActionKey(action: MeetingSummaryActionCandidate): string {
  return [
    normalizedActionPart(action.content),
    normalizedActionPart(action.assignee ?? ''),
    action.dueAtMs === null ? '' : String(action.dueAtMs),
  ].join('|');
}

export function dedupeMeetingSummaryActions(
  actions: readonly MeetingSummaryActionCandidate[],
): MeetingSummaryActionCandidate[] {
  const byKey = new Map<string, MeetingSummaryActionCandidate>();
  actions.forEach(action => {
    if (!action.content.trim()) return;
    const key = meetingSummaryActionKey(action);
    const previous = byKey.get(key);
    if (!previous) {
      byKey.set(key, {
        ...action,
        content: toSimplifiedChinese(action.content.trim()),
        assignee: action.assignee ? toSimplifiedChinese(action.assignee.trim()) : null,
      });
      return;
    }
    // Keep the first stable order, but retain richer metadata from a duplicate.
    byKey.set(key, {
      ...previous,
      canonicalId: previous.canonicalId ?? action.canonicalId ?? null,
      assignee: previous.assignee || action.assignee || null,
      dueAtMs: previous.dueAtMs ?? action.dueAtMs,
      reminderAtMs: previous.reminderAtMs ?? action.reminderAtMs,
      reminderNotificationId: previous.reminderNotificationId ?? action.reminderNotificationId,
      followupEventSourceId: previous.followupEventSourceId ?? action.followupEventSourceId,
      status: previous.status === 'pending' && action.status !== 'pending'
        ? action.status
        : previous.status,
      citations: previous.citations.length > 0 ? previous.citations : action.citations,
      sourceSegmentId: previous.sourceSegmentId ?? action.sourceSegmentId,
      sourceStartMs: previous.sourceStartMs ?? action.sourceStartMs,
      updatedAtMs: Math.max(previous.updatedAtMs ?? 0, action.updatedAtMs ?? 0) || null,
      dueText: previous.dueText ?? action.dueText ?? null,
      scheduleFit: previous.scheduleFit ?? action.scheduleFit,
      evidenceScore: Math.max(previous.evidenceScore ?? 0, action.evidenceScore ?? 0) || undefined,
    });
  });
  return [...byKey.values()];
}

function normalizedSectionLabel(value: string): string {
  return toSimplifiedChinese(value)
    .trim()
    .replace(/[\s:：\-—_（）()【】\[\]]/g, '')
    .toLowerCase();
}

/** Recognizes action sections even when a provider uses a non-standard kind. */
export function isMeetingSummaryActionSection(section: Pick<MeetingSummarySection, 'kind' | 'stableKey' | 'title'>): boolean {
  if (section.kind === 'action_items') return true;
  const labels = [section.stableKey, section.title ?? ''].map(normalizedSectionLabel);
  // “后续问题” is evidence for the next conversation, not an action list.
  return labels.some(isNormalizedMeetingSummaryActionLabel);
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
  const templateId = text(firstValue(root, 'templateId', 'template_id'), 120);
  const templateRevision = nonNegativeInteger(firstValue(root, 'templateRevision', 'template_revision'));
  if (templateId !== 'general' || templateRevision !== 3) return null;
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
    templateId: 'general',
    templateRevision: 3,
    transcriptRevisionId: text(firstValue(root, 'transcriptRevisionId', 'transcript_revision_id'), 240) || null,
    remoteTranscriptRevisionId: text(firstValue(root, 'remoteTranscriptRevisionId', 'remote_transcript_revision_id'), 240) || null,
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
  const actions = dedupeMeetingSummaryActions(document.actionItemCandidates);
  let keptFallbackActionSection = false;
  const sections = meetingSummarySectionsForPresentation(document.sections).map(section => {
    if (isDecisionSection(section)) return '';
    const actionSection = isMeetingSummaryActionSection(section);
    if (actionSection && actions.length > 0) return '';
    if (actionSection) {
      if (keptFallbackActionSection) return '';
      keptFallbackActionSection = true;
    }
    const heading = section.title ? `## ${toSimplifiedChinese(section.title)}\n` : '';
    const body = ['bullet_group', 'timeline', 'flow', 'comparison', 'risk_card', 'stat', 'action_items'].includes(section.kind)
      ? contentText(section.content).split(/\r?\n/).map(item => item.trim()).filter(Boolean).map(item => `- ${item}`).join('\n')
      : contentText(section.content);
    return `${heading}${body}`.trim();
  }).filter(Boolean);
  if (actions.length > 0) {
    sections.push(`## 待办事项\n${actions.map(item => `- ${actionText(item)}`).join('\n')}`);
  }
  return sections.join('\n\n');
}
