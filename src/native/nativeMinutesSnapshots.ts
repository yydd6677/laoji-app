import {
  MINUTES_SNAPSHOT_SCHEMA_VERSION,
  type MinutesContentPhase,
  type MinutesDetailPageStateSnapshot,
  type MinutesDetailPageStatesSnapshot,
  type MinutesDetailSnapshot,
  type MinutesDetailTab,
  type MinutesMarkerSnapshot,
  type MinutesPlayerSourceSnapshot,
  type MinutesProcessingStage,
  type MinutesRecordingPhase,
  type MinutesRecordingContent,
  type MinutesStatusTone,
  type MinutesSummarySectionSnapshot,
  type MinutesViewSnapshot,
} from 'laoji-native-platform';
import type { MeetingSummaryActionCandidate, MeetingSummaryDocument } from '../domain/meeting';
import type { TranscriptLine } from '../types';
import { formatDuration } from '../utils/meetingMedia';
import { speakerDisplayLabel } from '../utils/speakerLabels';

export type NativeMinutesTranscriptLine = TranscriptLine & {
  isFinal?: boolean;
  active?: boolean;
  searchRanges?: readonly { start: number; end: number }[];
  selectedSearchMatch?: boolean;
  revisionKind?: 'realtimeDraft' | 'final' | 'reprocessed';
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
  location?: string;
  locationLoading?: boolean;
  canEditLocation?: boolean;
  phase: MinutesRecordingPhase;
  elapsedMs: number;
  statusLabel?: string;
  errorMessage?: string;
  canPause?: boolean;
  canStop?: boolean;
  canStart?: boolean;
  canCreateMarker?: boolean;
  followLatest?: boolean;
  activeContent?: MinutesRecordingContent;
  manualNote?: string;
  manualNoteLoading?: boolean;
  manualNoteSaving?: boolean;
  manualNoteEnabled?: boolean;
  manualNoteError?: string;
  manualNoteRetryable?: boolean;
  manualNoteConflict?: boolean;
  transcript: readonly NativeMinutesTranscriptLine[];
}

export interface NativeMinutesMarkerInput {
  id: string;
  positionMs: number;
  nearestSegmentId?: string | null;
  label?: string | null;
  deleting?: boolean;
}

export interface BuildNativeDetailSnapshotInput {
  meetingId: string;
  available?: boolean;
  title: string;
  dateTimeLabel?: string;
  location?: string;
  activeTab: MinutesDetailTab;
  tabGeneration?: number;
  activeTabIsExplicit?: boolean;
  transcript: readonly NativeMinutesTranscriptLine[];
  markers?: readonly NativeMinutesMarkerInput[];
  actionItemCandidates?: readonly MeetingSummaryActionCandidate[];
  conflictedActionIds?: ReadonlySet<string>;
  summaryDocument?: MeetingSummaryDocument | null;
  summaryText?: string;
  transcriptLoading?: boolean;
  transcriptStatusMessage?: string;
  summaryLoading?: boolean;
  transcriptError?: string;
  summaryError?: string;
  summaryProgress?: string;
  canShare?: boolean;
  canManageSpeakers?: boolean;
  canGenerateSummary?: boolean;
  canEditSummary?: boolean;
  canCreateAction?: boolean;
  canShareActions?: boolean;
  canCreateClip?: boolean;
  summaryGenerating?: boolean;
  updatingActionId?: string | null;
  focusActionId?: string;
  focusActionRequestId?: number;
  focusTranscriptSegmentId?: string;
  focusTranscriptPositionMs?: number;
  focusTranscriptRequestId?: number;
  titleEditRequestId?: number;
  manualNote?: string;
  manualNoteLoading?: boolean;
  manualNoteSaving?: boolean;
  manualNoteEnabled?: boolean;
  manualNoteError?: string;
  manualNoteRetryable?: boolean;
  manualNoteConflict?: boolean;
  pageGenerations?: Partial<Record<MinutesDetailTab, number>>;
  pageCached?: Partial<Record<MinutesDetailTab, boolean>>;
  playerSource?: MinutesPlayerSourceSnapshot | null;
  playerSources?: readonly MinutesPlayerSourceSnapshot[];
  audioStatusMessage?: string;
  audioErrorMessage?: string;
  processingStatusLabel?: string;
  processingStatusTone?: MinutesStatusTone;
  rootSyncConflict?: boolean;
  processingRetryStage?: MinutesProcessingStage;
  processingRetrying?: boolean;
  recordingMergeStatusLabel?: string;
  recordingMergeActionLabel?: string;
  recordingMergeActionEnabled?: boolean;
}

export type NativeMinutesPageGenerations = Record<MinutesDetailTab, number>;

/** MIN-DETAIL-PAGER-001: one monotonic request clock per detail page. */
export class NativeMinutesPageGenerationClock {
  private values: NativeMinutesPageGenerations;

  constructor(initial: Partial<NativeMinutesPageGenerations> = {}) {
    this.values = {
      notes: pageGeneration(initial.notes),
      transcript: pageGeneration(initial.transcript),
      summary: pageGeneration(initial.summary),
      speakers: pageGeneration(initial.speakers),
      info: pageGeneration(initial.info),
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
    speaker_label: event.speakerName ?? existing?.speaker_label ?? '讲话人',
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

export function toNativeMinutesTranscript(
  lines: readonly NativeMinutesTranscriptLine[],
  playerSources: readonly MinutesPlayerSourceSnapshot[] = [],
) {
  const sourceByLocalAssetId = new Map(playerSources
    .filter(source => Boolean(source.recordingAssetId))
    .map(source => [source.recordingAssetId!, source.sourceId]));
  const sourceByRemoteAssetId = new Map(playerSources
    .filter(source => Boolean(source.recordingAssetRemoteId))
    .map(source => [source.recordingAssetRemoteId!, source.sourceId]));
  return lines
    .filter(line => line.text.trim())
    .map((line, index) => {
      const text = line.text.trim();
      const leadingTrim = line.text.length - line.text.trimStart().length;
      const searchRanges = line.searchRanges
        ?.map(range => ({ start: range.start - leadingTrim, end: range.end - leadingTrim }))
        .filter(range => (
          Number.isInteger(range.start)
          && Number.isInteger(range.end)
          && range.start >= 0
          && range.end > range.start
          && range.end <= text.length
        ))
        .slice(0, 1_000);
      return {
        id: line.id || `line-${index}`,
        playerSourceId: (
          (line.recordingAssetId ? sourceByLocalAssetId.get(line.recordingAssetId) : undefined)
          ?? ((line.recording_asset_id ?? line.recordingAssetRemoteId)
            ? sourceByRemoteAssetId.get(line.recording_asset_id ?? line.recordingAssetRemoteId!)
            : undefined)
        ),
        speakerId: line.speaker_id || 'unknown',
        speakerClusterId: line.speakerClusterId,
        speakerLabel: speakerDisplayLabel(line.speaker_label, line.speaker_id),
        timestampLabel: formatNativeMinutesTimestamp(line.start_time),
        startMs: Math.round(finiteSeconds(line.start_time) * 1000),
        endMs: Math.round(Math.max(finiteSeconds(line.start_time), finiteSeconds(line.end_time)) * 1000),
        text,
        isFinal: line.isFinal !== false,
        active: line.active === true,
        searchRanges,
        selectedSearchMatch: line.selectedSearchMatch === true,
        revisionKind: line.revisionKind
          ?? (line.isFinal === false ? 'realtimeDraft' : 'final'),
      };
    });
}

function stripSummaryMarkdown(value: string): string {
  return value
    .replace(/!\[([^\]]*)\]\([^)]+\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/(\*\*|__|~~|`)(.*?)\1/g, '$2')
    .trim();
}

type NativeSummaryKind = NonNullable<import('laoji-native-platform').MinutesSummaryBlockSnapshot['kind']>;

function legacySummarySections(markdown: string): MinutesSummarySectionSnapshot[] {
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
    stableKey: `legacy_${index}`,
    kind: block.kind === 'task' ? 'bullet' as const : block.kind,
    title: null,
    text: block.kind === 'task'
      ? `${block.checked ? '已完成' : '待办'}：${block.text}`
      : block.text,
    citations: [],
  }));
}

function structuredSummarySections(
  document: MeetingSummaryDocument,
  hasActions: boolean,
  editable: boolean,
): MinutesSummarySectionSnapshot[] {
  return document.sections
    .filter(section => !hasActions
      || (section.stableKey !== 'action_items' && section.kind !== 'action_items'))
    .map(section => ({
    id: section.id,
    stableKey: section.stableKey,
    kind: section.kind,
    title: section.title,
    text: section.content,
    editable,
    userEdited: section.userEdited === true,
    citations: section.citations.map(citation => ({
      id: citation.id,
      segmentId: citation.segmentId,
      startMs: citation.startMs,
      endMs: citation.endMs,
      label: formatNativeMinutesTimestamp(citation.startMs / 1000),
    })),
  }));
}

function structuredSummaryActions(
  actions: readonly MeetingSummaryActionCandidate[],
  updatingActionId?: string | null,
  conflictedActionIds: ReadonlySet<string> = new Set<string>(),
  canShare = false,
) {
  return actions.map(action => {
    const actionId = action.canonicalId ?? action.id;
    const source = action.citations[0];
    const sourceSegmentId = source?.segmentId ?? action.sourceSegmentId ?? undefined;
    const sourceStartMs = source?.startMs ?? action.sourceStartMs ?? undefined;
    const due = action.dueAtMs === null ? null : new Date(action.dueAtMs);
    const reminder = action.reminderAtMs === null ? null : new Date(action.reminderAtMs);
    return {
      id: actionId,
      content: action.content,
      status: action.status,
      assigneeLabel: action.assignee ?? undefined,
      dueLabel: due && !Number.isNaN(due.getTime())
        ? `${due.getFullYear()}年${due.getMonth() + 1}月${due.getDate()}日`
        : undefined,
      reminderLabel: reminder && !Number.isNaN(reminder.getTime())
        ? reminder.getTime() <= Date.now()
          ? '已提醒'
          : `${reminder.getMonth() + 1}月${reminder.getDate()}日 ${String(reminder.getHours()).padStart(2, '0')}:${String(reminder.getMinutes()).padStart(2, '0')}`
        : undefined,
      followupEventSourceId: action.followupEventSourceId ?? undefined,
      hasSource: sourceStartMs !== undefined,
      sourceSegmentId,
      sourceStartMs,
      updatedAtMs: action.updatedAtMs ?? 0,
      updating: actionId === updatingActionId,
      syncConflict: conflictedActionIds.has(actionId),
      canShare: canShare && !conflictedActionIds.has(actionId),
    } as const;
  });
}

export function nativeMinutesSpeakers(
  transcript: readonly NativeMinutesTranscriptLine[],
  canManage: boolean,
) {
  const grouped = new Map<string, { label: string; count: number; durationSec: number }>();
  transcript.forEach(line => {
    if (!line.text.trim()) return;
    const id = line.speaker_id?.trim() || line.speaker_label?.trim() || 'unknown';
    const label = speakerDisplayLabel(line.speaker_label, line.speaker_id);
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

const DETAIL_TABS: readonly MinutesDetailTab[] = ['notes', 'transcript', 'summary', 'speakers', 'info'];

function objectRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function minutesDetailTab(value: unknown): MinutesDetailTab {
  return DETAIL_TABS.includes(value as MinutesDetailTab)
    ? value as MinutesDetailTab
    : 'notes';
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
  const markers = Array.isArray(detail.markers) ? detail.markers : [];
  const summary = Array.isArray(detail.summary) ? detail.summary : [];
  const speakers = Array.isArray(detail.speakers) ? detail.speakers : [];
  const activeTab = minutesDetailTab(detail.activeTab);
  const legacy: MinutesDetailPageStatesSnapshot = {
    notes: { phase: 'ready', message: '', generation: 0, cached: true },
    transcript: contentBackedPageState(hasTextRows(transcript) || hasObjectRows(markers), '暂无文字记录'),
    summary: contentBackedPageState(hasTextRows(summary), '该会议暂未生成整理结果'),
    speakers: contentBackedPageState(hasObjectRows(speakers), '暂无讲话人信息'),
    info: { phase: 'ready', message: '', generation: 0, cached: false },
  };
  legacy[activeTab] = {
    phase: minutesContentPhase(detail.contentPhase),
    message: typeof detail.contentMessage === 'string' ? detail.contentMessage : '',
    generation: 0,
    cached: false,
  };

  const pageStates = objectRecord(detail.pageStates);
  return {
    notes: normalizedPageState(pageStates?.notes, legacy.notes),
    transcript: normalizedPageState(pageStates?.transcript, legacy.transcript),
    summary: normalizedPageState(pageStates?.summary, legacy.summary),
    speakers: normalizedPageState(pageStates?.speakers, legacy.speakers),
    info: normalizedPageState(pageStates?.info, legacy.info),
  };
}

function detailContentState(
  input: BuildNativeDetailSnapshotInput,
  detail: Pick<MinutesDetailSnapshot, 'summary' | 'actions' | 'speakers'>,
  tab: MinutesDetailTab,
): { phase: MinutesContentPhase; message: string } {
  if (tab === 'notes') {
    if (input.manualNoteLoading) return { phase: 'loading', message: '正在读取我的笔记' };
    if (input.manualNoteError) return { phase: 'error', message: input.manualNoteError };
    return { phase: 'ready', message: '' };
  }
  if (tab === 'transcript') {
    if (input.transcriptLoading && input.transcript.length === 0 && !input.markers?.length) {
      return { phase: 'loading', message: '正在同步文字记录' };
    }
    if (input.transcriptError) return { phase: 'error', message: input.transcriptError };
    if (input.transcriptStatusMessage && input.transcript.length > 0) {
      return { phase: 'loading', message: input.transcriptStatusMessage };
    }
    return input.transcript.length > 0 || Boolean(input.markers?.length)
      ? { phase: 'ready', message: '' }
      : { phase: 'empty', message: '暂无文字记录' };
  }
  if (tab === 'summary') {
    if (input.summaryLoading) {
      return { phase: 'loading', message: input.summaryProgress || '正在生成整理结果' };
    }
    if (input.summaryError) return { phase: 'error', message: input.summaryError };
    return detail.summary.length > 0 || (detail.actions?.length ?? 0) > 0
      ? { phase: 'ready', message: '' }
      : { phase: 'empty', message: '该会议暂未生成整理结果' };
  }
  if (tab === 'info') return { phase: 'ready', message: '' };
  return detail.speakers.length > 0
    ? { phase: 'ready', message: '' }
    : { phase: 'empty', message: '暂无讲话人信息' };
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
      location: input.location,
      locationLoading: input.locationLoading ?? false,
      canEditLocation: input.canEditLocation ?? true,
      phase: input.phase,
      elapsedMs: Math.max(0, input.elapsedMs),
      statusLabel: input.statusLabel,
      errorMessage: input.errorMessage,
      canPause: input.canPause ?? false,
      canStop: input.canStop ?? false,
      canStart: input.canStart ?? false,
      canCreateMarker: input.canCreateMarker ?? false,
      followLatest: input.followLatest ?? true,
      activeContent: input.activeContent ?? 'transcript',
      manualNote: input.manualNote ?? '',
      manualNoteLoading: input.manualNoteLoading ?? false,
      manualNoteSaving: input.manualNoteSaving ?? false,
      manualNoteEnabled: input.manualNoteEnabled ?? false,
      manualNoteError: input.manualNoteError ?? '',
      manualNoteRetryable: input.manualNoteRetryable ?? true,
      manualNoteConflict: input.manualNoteConflict ?? false,
      transcript: toNativeMinutesTranscript(input.transcript),
    },
  };
}

/** MIN-DETAIL-001 / MIN-DETAIL-PAGER-001 / MIN-DETAIL-STICKY-001 / MIN-SUMMARY-001 / MIN-GUEST-001 / MIN-PLAYER-001. */
export function buildNativeMinutesDetailSnapshot(
  input: BuildNativeDetailSnapshotInput,
): MinutesViewSnapshot {
  const actionItemCandidates = input.actionItemCandidates
    ?? input.summaryDocument?.actionItemCandidates
    ?? [];
  const summary = input.summaryDocument
    ? structuredSummarySections(
      input.summaryDocument,
      actionItemCandidates.length > 0 || input.summaryDocument.actionItemCandidates.length > 0,
      input.canEditSummary === true,
    )
    : legacySummarySections(input.summaryText?.trim() ?? '');
  const actions = structuredSummaryActions(
    actionItemCandidates,
    input.updatingActionId,
    input.conflictedActionIds,
    input.canShareActions ?? false,
  );
  const speakers = nativeMinutesSpeakers(input.transcript, Boolean(input.canManageSpeakers));
  const markers: MinutesMarkerSnapshot[] = (input.markers ?? [])
    .filter(marker => marker.id.trim() && Number.isSafeInteger(marker.positionMs) && marker.positionMs >= 0)
    .map(marker => ({
      id: marker.id,
      positionMs: marker.positionMs,
      timestampLabel: formatNativeMinutesTimestamp(marker.positionMs / 1_000),
      segmentId: marker.nearestSegmentId?.trim() || undefined,
      label: marker.label?.trim() || undefined,
      deleting: marker.deleting === true,
    }))
    .sort((left, right) => left.positionMs - right.positionMs || left.id.localeCompare(right.id));
  const detail: MinutesDetailSnapshot = {
    meetingId: input.meetingId,
    available: input.available ?? true,
    title: input.title,
    dateTimeLabel: input.dateTimeLabel,
    location: input.location,
    activeTab: input.activeTab,
    tabGeneration: pageGeneration(input.tabGeneration),
    activeTabIsExplicit: input.activeTabIsExplicit ?? false,
    canShare: input.canShare ?? false,
    canManageSpeakers: input.canManageSpeakers ?? false,
    canGenerateSummary: input.canGenerateSummary ?? false,
    canCreateAction: input.canCreateAction ?? false,
    canCreateClip: input.canCreateClip ?? false,
    summaryGenerating: input.summaryGenerating ?? false,
    summaryActionLabel: summary.length > 0 ? '重新生成' : '生成整理结果',
    titleEditRequestId: Math.max(0, input.titleEditRequestId ?? 0),
    focusActionId: input.focusActionId,
    focusActionRequestId: Math.max(0, input.focusActionRequestId ?? 0),
    focusTranscriptSegmentId: input.focusTranscriptSegmentId,
    focusTranscriptPositionMs: Math.max(0, input.focusTranscriptPositionMs ?? 0),
    focusTranscriptRequestId: Math.max(0, input.focusTranscriptRequestId ?? 0),
    manualNote: input.manualNote ?? '',
    manualNoteLoading: input.manualNoteLoading ?? false,
    manualNoteSaving: input.manualNoteSaving ?? false,
    manualNoteEnabled: input.manualNoteEnabled ?? false,
    manualNoteError: input.manualNoteError ?? '',
    manualNoteRetryable: input.manualNoteRetryable ?? true,
    manualNoteConflict: input.manualNoteConflict ?? false,
    transcript: toNativeMinutesTranscript(
      input.transcript,
      input.playerSources ?? (input.playerSource ? [input.playerSource] : []),
    ),
    markers,
    summary,
    actions,
    speakers,
    playerSource: input.playerSource ?? null,
    playerSources: input.playerSources ?? (input.playerSource ? [input.playerSource] : []),
    audioStatusMessage: input.audioStatusMessage ?? '',
    audioErrorMessage: input.audioErrorMessage ?? '',
    processingStatusLabel: input.processingStatusLabel ?? '',
    processingStatusTone: input.processingStatusTone ?? 'neutral',
    rootSyncConflict: input.rootSyncConflict ?? false,
    processingRetryStage: input.processingRetryStage,
    processingRetrying: input.processingRetrying ?? false,
    recordingMergeStatusLabel: input.recordingMergeStatusLabel ?? '',
    recordingMergeActionLabel: input.recordingMergeActionLabel ?? '',
    recordingMergeActionEnabled: input.recordingMergeActionEnabled ?? false,
  };
  const pageStates = normalizeNativeMinutesDetailPageStates({
    ...detail,
    pageStates: {
      notes: {
        ...detailContentState(input, detail, 'notes'),
        generation: pageGeneration(input.pageGenerations?.notes),
        cached: true,
      },
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
      info: {
        ...detailContentState(input, detail, 'info'),
        generation: pageGeneration(input.pageGenerations?.info),
        cached: input.pageCached?.info === true,
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
