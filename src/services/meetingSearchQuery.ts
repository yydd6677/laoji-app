import type { Meeting } from '../types';

/**
 * Shared parser for the meeting search surface.
 *
 * The parser deliberately keeps filter syntax compact and optional. A plain
 * query remains a full-text query; recognized filters are removed from the
 * content terms so the SQLite FTS and metadata fallback paths agree.
 */

export type MeetingSearchSourceKind =
  | 'title'
  | 'tag'
  | 'manual_note'
  | 'transcript'
  | 'summary'
  | 'action';

export type MeetingSearchFilters = {
  readonly tags: readonly string[];
  readonly people: readonly string[];
  readonly fromDate: string | null;
  readonly toDate: string | null;
  readonly sourceKinds: readonly MeetingSearchSourceKind[];
};

export type MeetingSearchQuery = {
  readonly contentTokens: readonly string[];
  readonly filters: MeetingSearchFilters;
};

const FILTER_ALIASES: Record<string, 'tag' | 'person' | 'date' | 'from' | 'to' | 'source'> = {
  tag: 'tag',
  tags: 'tag',
  标签: 'tag',
  person: 'person',
  people: 'person',
  speaker: 'person',
  人物: 'person',
  说话人: 'person',
  date: 'date',
  日期: 'date',
  from: 'from',
  after: 'from',
  从: 'from',
  to: 'to',
  before: 'to',
  到: 'to',
  source: 'source',
  来源: 'source',
};

const SOURCE_ALIASES: Record<string, MeetingSearchSourceKind> = {
  title: 'title',
  标题: 'title',
  tag: 'tag',
  标签: 'tag',
  manual_note: 'manual_note',
  note: 'manual_note',
  笔记: 'manual_note',
  我的笔记: 'manual_note',
  transcript: 'transcript',
  文字记录: 'transcript',
  summary: 'summary',
  整理结果: 'summary',
  action: 'action',
  待办: 'action',
};

function cleanToken(value: string): string {
  const trimmed = value.trim();
  if (
    trimmed.length >= 2
    && ((trimmed.startsWith('"') && trimmed.endsWith('"'))
      || (trimmed.startsWith("'") && trimmed.endsWith("'")))
  ) {
    return trimmed.slice(1, -1).trim();
  }
  return trimmed;
}

function tokenize(value: string): readonly string[] {
  return value.match(/[^\s:]+:(?:"[^"]*"|'[^']*')|"[^"]*"|'[^']*'|\S+/gu) ?? [];
}

function validDate(value: string): string | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value
    ? null
    : value;
}

function addBound(current: string | null, candidate: string, mode: 'min' | 'max'): string {
  if (!current) return candidate;
  return mode === 'min'
    ? (candidate > current ? candidate : current)
    : (candidate < current ? candidate : current);
}

function sourceKind(value: string): MeetingSearchSourceKind | null {
  return SOURCE_ALIASES[value.toLocaleLowerCase()] ?? null;
}

function emptyFilters(): {
  tags: string[];
  people: string[];
  fromDate: string | null;
  toDate: string | null;
  sourceKinds: MeetingSearchSourceKind[];
} {
  return {
    tags: [],
    people: [],
    fromDate: null,
    toDate: null,
    sourceKinds: [],
  };
}

export function hasMeetingSearchFilters(filters: MeetingSearchFilters): boolean {
  return filters.tags.length > 0
    || filters.people.length > 0
    || filters.fromDate !== null
    || filters.toDate !== null
    || filters.sourceKinds.length > 0;
}

/** Normalize both legacy Chinese display dates and ISO dates for local fallback filtering. */
export function meetingDateKey(value: string | null | undefined): string {
  const raw = value?.trim() ?? '';
  const match = raw.match(/^(\d{4})\s*(?:年|-|\/)\s*(\d{1,2})\s*(?:月|-|\/)\s*(\d{1,2})/u);
  if (match) {
    return `${match[1]}-${match[2].padStart(2, '0')}-${match[3].padStart(2, '0')}`;
  }
  return /^\d{4}-\d{2}-\d{2}$/.test(raw) ? raw : '';
}

/**
 * Match the fields available in the legacy/native meeting projection.
 *
 * The canonical FTS path contains transcript, summary, note and action text;
 * this matcher intentionally stays metadata-only so it can be used as a
 * bounded fallback while an index is unavailable or only partially rebuilt.
 */
export function meetingMatchesSearchMetadata(meeting: Meeting, query: string): boolean {
  if (!query.trim()) return true;
  const parsed = parseMeetingSearchQuery(query);
  if (!parsed) return false;
  const searchable = [
    meeting.title,
    meeting.date,
    meeting.time,
    meeting.duration,
    meeting.description,
    meeting.status,
    meeting.location,
    ...(meeting.participants ?? []),
    ...meeting.tags.map(tag => tag.label),
  ].filter(Boolean).join(' ').normalize('NFKC').toLocaleLowerCase();
  if (!parsed.contentTokens.every(term => searchable.includes(term))) return false;
  const filters = parsed.filters;
  if (!filters.tags.every(tag => meeting.tags.some(item => (
    item.label.normalize('NFKC').toLocaleLowerCase().includes(tag)
  )))) return false;
  if (!filters.people.every(person => (meeting.participants ?? []).some(item => (
    item.normalize('NFKC').toLocaleLowerCase().includes(person)
  )))) return false;
  const meetingDate = meetingDateKey(meeting.date);
  if (filters.fromDate && meetingDate < filters.fromDate) return false;
  if (filters.toDate && meetingDate > filters.toDate) return false;
  if (filters.sourceKinds.length > 0) {
    const sourceMatches = filters.sourceKinds.some(source => {
      if (source === 'title') return meeting.title.trim().length > 0;
      if (source === 'tag') return meeting.tags.length > 0;
      if (source === 'transcript') return meeting.hasTranscript === true;
      if (source === 'summary') return meeting.hasSummary === true;
      if (source === 'manual_note') return Boolean(meeting.description?.trim());
      // Action contents are not part of the legacy Meeting projection. The
      // canonical index remains the authority for source:action queries.
      return false;
    });
    if (!sourceMatches) return false;
  }
  return true;
}

export function parseMeetingSearchQuery(value: string): MeetingSearchQuery | null {
  const normalized = value.normalize('NFKC').trim().toLocaleLowerCase();
  if (!normalized || normalized.length > 200 || /[\u0000-\u001f\u007f]/.test(normalized)) return null;

  const filters = emptyFilters();
  const contentTokens: string[] = [];
  for (const rawToken of tokenize(normalized)) {
    const separator = rawToken.indexOf(':');
    if (separator <= 0) {
      contentTokens.push(cleanToken(rawToken));
      continue;
    }
    const alias = FILTER_ALIASES[rawToken.slice(0, separator)];
    const rawValue = cleanToken(rawToken.slice(separator + 1));
    if (!alias || !rawValue || rawValue.length > 80) {
      contentTokens.push(cleanToken(rawToken));
      continue;
    }
    if (alias === 'tag') {
      filters.tags.push(rawValue);
      continue;
    }
    if (alias === 'person') {
      filters.people.push(rawValue);
      continue;
    }
    if (alias === 'source') {
      const valueKind = sourceKind(rawValue);
      if (valueKind) filters.sourceKinds.push(valueKind);
      else contentTokens.push(cleanToken(rawToken));
      continue;
    }
    const date = validDate(rawValue);
    if (!date) {
      contentTokens.push(cleanToken(rawToken));
      continue;
    }
    if (alias === 'date') {
      filters.fromDate = addBound(filters.fromDate, date, 'min');
      filters.toDate = addBound(filters.toDate, date, 'max');
    } else if (alias === 'from') {
      filters.fromDate = addBound(filters.fromDate, date, 'min');
    } else {
      filters.toDate = addBound(filters.toDate, date, 'max');
    }
  }

  const hasContent = contentTokens.some(token => token.length > 0);
  if (!hasContent && !hasMeetingSearchFilters(filters)) return null;
  return {
    contentTokens: contentTokens.filter(Boolean),
    filters: {
      tags: [...new Set(filters.tags)],
      people: [...new Set(filters.people)],
      fromDate: filters.fromDate,
      toDate: filters.toDate,
      sourceKinds: [...new Set(filters.sourceKinds)],
    },
  };
}
