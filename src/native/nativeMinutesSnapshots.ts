import {
  MINUTES_SNAPSHOT_SCHEMA_VERSION,
  type MinutesContentPhase,
  type MinutesDetailPageStateSnapshot,
  type MinutesDetailPageStatesSnapshot,
  type MinutesDetailSnapshot,
  type MinutesDetailTab,
  type MinutesPlayerSourceSnapshot,
  type MinutesRecordingPhase,
  type MinutesSummaryBlockSnapshot,
  type MinutesViewSnapshot,
} from 'laoji-native-platform';
import type { TranscriptLine } from '../types';
import { formatDuration } from '../utils/meetingMedia';

export type NativeMinutesTranscriptLine = TranscriptLine & {
  isFinal?: boolean;
};

export interface NativeMinutesTranscriptEventLike {
  sessionId: string;
  segmentId: string;
  kind: 'partial' | 'final';
  isFinal: boolean;
  text: string;
  speakerId: string | null;
  speakerName: string | null;
  startMs: number | null;
  endMs: number | null;
  source?: string | null;
  purpose?: 'schedule' | 'meeting';
  receivedAtMs: number;
}

export interface BuildNativeRecordingSnapshotInput {
  meetingId: string;
  title: string;
  startedAtLabel?: string;
  phase: MinutesRecordingPhase;
  elapsedMs: number;
  statusLabel?: string;
  errorMessage?: string;
  canPause?: boolean;
  canStop?: boolean;
  canStart?: boolean;
  followLatest?: boolean;
  transcript: readonly NativeMinutesTranscriptLine[];
}

export interface BuildNativeDetailSnapshotInput {
  meetingId: string;
  available?: boolean;
  title: string;
  dateTimeLabel?: string;
  activeTab: MinutesDetailTab;
  tabGeneration?: number;
  activeTabIsExplicit?: boolean;
  transcript: readonly NativeMinutesTranscriptLine[];
  summaryText?: string;
  transcriptLoading?: boolean;
  summaryLoading?: boolean;
  transcriptError?: string;
  summaryError?: string;
  summaryProgress?: string;
  canShare?: boolean;
  canManageSpeakers?: boolean;
  canGenerateSummary?: boolean;
  summaryGenerating?: boolean;
  titleEditRequestId?: number;
  pageGenerations?: Partial<Record<MinutesDetailTab, number>>;
  pageCached?: Partial<Record<MinutesDetailTab, boolean>>;
  playerSource?: MinutesPlayerSourceSnapshot | null;
  audioStatusMessage?: string;
  audioErrorMessage?: string;
}

export type NativeMinutesPageGenerations = Record<MinutesDetailTab, number>;

/** MIN-DETAIL-PAGER-001: one monotonic request clock per detail page. */
export class NativeMinutesPageGenerationClock {
  private values: NativeMinutesPageGenerations;

  constructor(initial: Partial<NativeMinutesPageGenerations> = {}) {
    this.values = {
      transcript: pageGeneration(initial.transcript),
      summary: pageGeneration(initial.summary),
      speakers: pageGeneration(initial.speakers),
    };
  }

  advance(...tabs: readonly MinutesDetailTab[]): NativeMinutesPageGenerations {
    const next = { ...this.values };
    new Set(tabs).forEach(tab => {
      next[tab] = Math.min(2_147_483_647, next[tab] + 1);
    });
    this.values = next;
    return this.snapshot();
  }

  snapshot(): NativeMinutesPageGenerations {
    return { ...this.values };
  }
}

/** MIN-DETAIL-PAGER-001: a cached summary error retries generation, never a plain reload. */
export function nativeMinutesDetailRetryPlan(
  tab: MinutesDetailTab,
  hasSummary: boolean,
): { kind: 'generateSummary'; forceRegenerate: boolean } | { kind: 'reload' } {
  return tab === 'summary'
    ? { kind: 'generateSummary', forceRegenerate: hasSummary }
    : { kind: 'reload' };
}

function finiteSeconds(value: number | undefined): number {
  return Number.isFinite(value) ? Math.max(0, value ?? 0) : 0;
}

export function formatNativeMinutesTimestamp(seconds?: number): string {
  const total = Math.floor(finiteSeconds(seconds));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const remainder = total % 60;
  return hours > 0
    ? `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(remainder).padStart(2, '0')}`
    : `${String(minutes).padStart(2, '0')}:${String(remainder).padStart(2, '0')}`;
}

export function mergeNativeMinutesTranscript(
  current: readonly NativeMinutesTranscriptLine[],
  event: NativeMinutesTranscriptEventLike,
  meetingId: string,
): NativeMinutesTranscriptLine[] {
  if (event.sessionId !== meetingId) return [...current];
  const id = `native:${meetingId}:${event.segmentId}`;
  const existingIndex = current.findIndex(line => line.id === id);
  const existing = existingIndex >= 0 ? current[existingIndex] : null;
  if (existing?.isFinal && !event.isFinal) return [...current];

  const text = event.text.trim();
  if (!text) {
    return existingIndex >= 0
      ? current.filter((_, index) => index !== existingIndex)
      : [...current];
  }

  const next: NativeMinutesTranscriptLine = {
    id,
    meeting_id: meetingId,
    speaker_id: event.speakerId ?? existing?.speaker_id ?? 'unknown',
    speaker_label: event.speakerName ?? existing?.speaker_label ?? '发言人',
    text,
    start_time: event.startMs == null ? existing?.start_time : event.startMs / 1000,
    end_time: event.endMs == null ? existing?.end_time : event.endMs / 1000,
    created_at: existing?.created_at ?? new Date(event.receivedAtMs).toISOString(),
    isFinal: event.isFinal || event.kind === 'final',
  };
  if (existingIndex < 0) return [...current, next];
  return current.map((line, index) => index === existingIndex ? next : line);
}

export function finalizedNativeMinutesTranscript(
  lines: readonly NativeMinutesTranscriptLine[],
): TranscriptLine[] {
  return lines
    .filter(line => line.isFinal !== false && line.text.trim())
    .map(({ isFinal: _isFinal, ...line }) => ({ ...line, text: line.text.trim() }));
}

function transcriptFingerprint(line: TranscriptLine): string {
  const start = Number.isFinite(line.start_time) ? Math.round((line.start_time ?? 0) * 100) : -1;
  const end = Number.isFinite(line.end_time) ? Math.round((line.end_time ?? 0) * 100) : -1;
  return [
    start,
    end,
    line.speaker_id?.trim() || line.speaker_label?.trim() || 'unknown',
    line.text.trim(),
  ].join('\u001f');
}

/** MIN-ASR-001: persisted server rows win while unique local final rows remain available. */
export function mergePersistedMinutesTranscript(
  local: readonly TranscriptLine[],
  remote: readonly TranscriptLine[],
): TranscriptLine[] {
  const rows: TranscriptLine[] = [];
  const ids = new Set<string>();
  const fingerprints = new Set<string>();
  const append = (line: TranscriptLine) => {
    const text = line.text.trim();
    if (!text) return;
    const id = line.id?.trim();
    const fingerprint = transcriptFingerprint({ ...line, text });
    if ((id && ids.has(id)) || fingerprints.has(fingerprint)) return;
    if (id) ids.add(id);
    fingerprints.add(fingerprint);
    rows.push({ ...line, text });
  };
  remote.forEach(append);
  local.forEach(append);
  return rows
    .map((line, index) => ({ line, index }))
    .sort((left, right) => (
      (left.line.start_time ?? Number.MAX_SAFE_INTEGER)
      - (right.line.start_time ?? Number.MAX_SAFE_INTEGER)
      || left.index - right.index
    ))
    .map(item => item.line);
}

export function toNativeMinutesTranscript(
  lines: readonly NativeMinutesTranscriptLine[],
) {
  return lines
    .filter(line => line.text.trim())
    .map((line, index) => ({
      id: line.id || `line-${index}`,
      speakerId: line.speaker_id || 'unknown',
      speakerLabel: line.speaker_label || '发言人',
      timestampLabel: formatNativeMinutesTimestamp(line.start_time),
      startMs: Math.round(finiteSeconds(line.start_time) * 1000),
      text: line.text.trim(),
      isFinal: line.isFinal !== false,
    }));
}

function stripSummaryMarkdown(value: string): string {
  return value
    .replace(/!\[([^\]]*)\]\([^)]+\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/(\*\*|__|~~|`)(.*?)\1/g, '$2')
    .trim();
}

type NativeSummaryKind = NonNullable<MinutesSummaryBlockSnapshot['kind']>;

function summaryBlocks(markdown: string) {
  const blocks: Array<{ kind: NativeSummaryKind; text: string; checked?: boolean }> = [];
  const paragraph: string[] = [];
  const code: string[] = [];
  let inCode = false;
  const flushParagraph = () => {
    const text = stripSummaryMarkdown(paragraph.join('\n'));
    if (text) blocks.push({ kind: 'paragraph', text });
    paragraph.length = 0;
  };
  const flushCode = () => {
    const text = code.join('\n').trimEnd();
    if (text) blocks.push({ kind: 'code', text });
    code.length = 0;
  };
  markdown.replace(/\r\n?/g, '\n').split('\n').forEach(rawLine => {
    const line = rawLine.trimEnd();
    if (/^\s*```/.test(line)) {
      if (inCode) flushCode();
      else flushParagraph();
      inCode = !inCode;
      return;
    }
    if (inCode) {
      code.push(rawLine);
      return;
    }
    if (!line.trim() || /^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
      flushParagraph();
      return;
    }
    const normalized = line.trim();
    const heading = /^\s*(#{1,6})\s+(.+)$/.exec(normalized);
    const task = /^\s*[-*+]\s+\[([ xX])\]\s+(.+)$/.exec(normalized);
    const bullet = /^\s*[-*+]\s+(.+)$/.exec(normalized);
    const ordered = /^\s*\d+[.)]\s+(.+)$/.exec(normalized);
    const quote = /^\s*>\s?(.*)$/.exec(normalized);
    const matched = heading || task || bullet || ordered || quote;
    if (!matched) {
      paragraph.push(normalized);
      return;
    }
    flushParagraph();
    if (heading) blocks.push({ kind: 'heading', text: stripSummaryMarkdown(heading[2]) });
    else if (task) blocks.push({ kind: 'task', checked: task[1].toLowerCase() === 'x', text: stripSummaryMarkdown(task[2]) });
    else if (bullet) blocks.push({ kind: 'bullet', text: stripSummaryMarkdown(bullet[1]) });
    else if (ordered) blocks.push({ kind: 'ordered', text: stripSummaryMarkdown(ordered[1]) });
    else if (quote) blocks.push({ kind: 'quote', text: stripSummaryMarkdown(quote[1]) });
  });
  if (inCode) flushCode();
  flushParagraph();
  return blocks.map((block, index) => ({
    id: `summary-${index}`,
    kind: block.kind === 'task' ? 'bullet' as const : block.kind,
    text: block.kind === 'task'
      ? `${block.checked ? '已完成' : '待办'}：${block.text}`
      : block.text,
    checked: undefined,
  }));
}

export function nativeMinutesSpeakers(
  transcript: readonly NativeMinutesTranscriptLine[],
  canManage: boolean,
) {
  const grouped = new Map<string, { label: string; count: number; durationSec: number }>();
  transcript.forEach(line => {
    if (!line.text.trim()) return;
    const id = line.speaker_id?.trim() || line.speaker_label?.trim() || 'unknown';
    const label = line.speaker_label?.trim() || (id === 'unknown' ? '发言人' : id);
    const previous = grouped.get(id) ?? { label, count: 0, durationSec: 0 };
    const start = finiteSeconds(line.start_time);
    const end = finiteSeconds(line.end_time);
    grouped.set(id, {
      label,
      count: previous.count + 1,
      durationSec: previous.durationSec + Math.max(0, end - start),
    });
  });
  return [...grouped.entries()].map(([id, value]) => ({
    id,
    label: value.label,
    segmentCount: value.count,
    durationLabel: value.durationSec > 0 ? formatDuration(value.durationSec) : '',
    canManage: canManage && id !== 'unknown',
  }));
}

const DETAIL_TABS: readonly MinutesDetailTab[] = ['transcript', 'summary', 'speakers'];

function objectRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function minutesDetailTab(value: unknown): MinutesDetailTab {
  return DETAIL_TABS.includes(value as MinutesDetailTab)
    ? value as MinutesDetailTab
    : 'transcript';
}

function minutesContentPhase(value: unknown): MinutesContentPhase {
  return value === 'loading' || value === 'empty' || value === 'error'
    ? value
    : 'ready';
}

function pageGeneration(value: unknown, fallback = 0): number {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.min(2_147_483_647, Math.max(0, Math.floor(value)))
    : fallback;
}

function contentBackedPageState(
  hasContent: boolean,
  emptyMessage: string,
): MinutesDetailPageStateSnapshot {
  return hasContent
    ? { phase: 'ready', message: '', generation: 0, cached: false }
    : { phase: 'empty', message: emptyMessage, generation: 0, cached: false };
}

function hasTextRows(items: readonly unknown[]): boolean {
  return items.some(item => {
    const row = objectRecord(item);
    const text = row?.text;
    return typeof text === 'string' && text.trim().length > 0;
  });
}

function hasObjectRows(items: readonly unknown[]): boolean {
  return items.some(item => objectRecord(item) !== null);
}

function normalizedPageState(
  value: unknown,
  fallback: MinutesDetailPageStateSnapshot,
): MinutesDetailPageStateSnapshot {
  const raw = objectRecord(value);
  if (!raw) return fallback;
  return {
    phase: Object.prototype.hasOwnProperty.call(raw, 'phase')
      ? minutesContentPhase(raw.phase)
      : fallback.phase,
    message: Object.prototype.hasOwnProperty.call(raw, 'message')
      ? (typeof raw.message === 'string' ? raw.message : '')
      : fallback.message,
    generation: Object.prototype.hasOwnProperty.call(raw, 'generation')
      ? pageGeneration(raw.generation)
      : fallback.generation,
    cached: Object.prototype.hasOwnProperty.call(raw, 'cached')
      ? raw.cached === true
      : fallback.cached,
  };
}

/** MIN-DETAIL-PAGER-001 / MIN-DETAIL-STICKY-001: migrate legacy active-page state without contaminating sibling pages. */
export function normalizeNativeMinutesDetailPageStates(
  snapshot: unknown,
): MinutesDetailPageStatesSnapshot {
  const detail = objectRecord(snapshot) ?? {};
  const transcript = Array.isArray(detail.transcript) ? detail.transcript : [];
  const summary = Array.isArray(detail.summary) ? detail.summary : [];
  const speakers = Array.isArray(detail.speakers) ? detail.speakers : [];
  const activeTab = minutesDetailTab(detail.activeTab);
  const legacy: MinutesDetailPageStatesSnapshot = {
    transcript: contentBackedPageState(hasTextRows(transcript), '暂无文字记录'),
    summary: contentBackedPageState(hasTextRows(summary), '该会议暂未生成纪要'),
    speakers: contentBackedPageState(hasObjectRows(speakers), '暂无发言人信息'),
  };
  legacy[activeTab] = {
    phase: minutesContentPhase(detail.contentPhase),
    message: typeof detail.contentMessage === 'string' ? detail.contentMessage : '',
    generation: 0,
    cached: false,
  };

  const pageStates = objectRecord(detail.pageStates);
  return {
    transcript: normalizedPageState(pageStates?.transcript, legacy.transcript),
    summary: normalizedPageState(pageStates?.summary, legacy.summary),
    speakers: normalizedPageState(pageStates?.speakers, legacy.speakers),
  };
}

function detailContentState(
  input: BuildNativeDetailSnapshotInput,
  detail: Pick<MinutesDetailSnapshot, 'summary' | 'speakers'>,
  tab: MinutesDetailTab,
): { phase: MinutesContentPhase; message: string } {
  if (tab === 'transcript') {
    if (input.transcriptLoading && input.transcript.length === 0) {
      return { phase: 'loading', message: '正在同步文字记录' };
    }
    if (input.transcriptError) return { phase: 'error', message: input.transcriptError };
    return input.transcript.length > 0
      ? { phase: 'ready', message: '' }
      : { phase: 'empty', message: '暂无文字记录' };
  }
  if (tab === 'summary') {
    if (input.summaryLoading) {
      return { phase: 'loading', message: input.summaryProgress || '正在生成会议纪要' };
    }
    if (input.summaryError) return { phase: 'error', message: input.summaryError };
    return detail.summary.length > 0
      ? { phase: 'ready', message: '' }
      : { phase: 'empty', message: '该会议暂未生成纪要' };
  }
  return detail.speakers.length > 0
    ? { phase: 'ready', message: '' }
    : { phase: 'empty', message: '暂无发言人信息' };
}

/** MIN-REC-BRIDGE-001: snapshots carry low-frequency state; native Flow owns levels. */
export function buildNativeMinutesRecordingSnapshot(
  input: BuildNativeRecordingSnapshotInput,
): MinutesViewSnapshot {
  return {
    schemaVersion: MINUTES_SNAPSHOT_SCHEMA_VERSION,
    surface: 'recording',
    recording: {
      meetingId: input.meetingId,
      title: input.title,
      startedAtLabel: input.startedAtLabel,
      phase: input.phase,
      elapsedMs: Math.max(0, input.elapsedMs),
      statusLabel: input.statusLabel,
      errorMessage: input.errorMessage,
      canPause: input.canPause ?? false,
      canStop: input.canStop ?? false,
      canStart: input.canStart ?? false,
      followLatest: input.followLatest ?? true,
      transcript: toNativeMinutesTranscript(input.transcript),
    },
  };
}

/** MIN-DETAIL-001 / MIN-DETAIL-PAGER-001 / MIN-DETAIL-STICKY-001 / MIN-SUMMARY-001 / MIN-GUEST-001 / MIN-PLAYER-001. */
export function buildNativeMinutesDetailSnapshot(
  input: BuildNativeDetailSnapshotInput,
): MinutesViewSnapshot {
  const summary = summaryBlocks(input.summaryText?.trim() ?? '');
  const speakers = nativeMinutesSpeakers(input.transcript, Boolean(input.canManageSpeakers));
  const detail: MinutesDetailSnapshot = {
    meetingId: input.meetingId,
    available: input.available ?? true,
    title: input.title,
    dateTimeLabel: input.dateTimeLabel,
    activeTab: input.activeTab,
    tabGeneration: pageGeneration(input.tabGeneration),
    activeTabIsExplicit: input.activeTabIsExplicit ?? false,
    canShare: input.canShare ?? false,
    canManageSpeakers: input.canManageSpeakers ?? false,
    canGenerateSummary: input.canGenerateSummary ?? false,
    summaryGenerating: input.summaryGenerating ?? false,
    summaryActionLabel: input.summaryText?.trim() ? '重新生成' : '生成总结',
    titleEditRequestId: Math.max(0, input.titleEditRequestId ?? 0),
    transcript: toNativeMinutesTranscript(input.transcript),
    summary,
    speakers,
    playerSource: input.playerSource ?? null,
    audioStatusMessage: input.audioStatusMessage ?? '',
    audioErrorMessage: input.audioErrorMessage ?? '',
  };
  const pageStates = normalizeNativeMinutesDetailPageStates({
    ...detail,
    pageStates: {
      transcript: {
        ...detailContentState(input, detail, 'transcript'),
        generation: pageGeneration(input.pageGenerations?.transcript),
        cached: input.pageCached?.transcript === true,
      },
      summary: {
        ...detailContentState(input, detail, 'summary'),
        generation: pageGeneration(input.pageGenerations?.summary),
        cached: input.pageCached?.summary === true,
      },
      speakers: {
        ...detailContentState(input, detail, 'speakers'),
        generation: pageGeneration(input.pageGenerations?.speakers),
        cached: input.pageCached?.speakers === true,
      },
    },
  });
  const content = pageStates[input.activeTab];
  detail.pageStates = pageStates;
  detail.contentPhase = content.phase;
  detail.contentMessage = content.message;
  return {
    schemaVersion: MINUTES_SNAPSHOT_SCHEMA_VERSION,
    surface: 'detail',
    detail,
  };
}
