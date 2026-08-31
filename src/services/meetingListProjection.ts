import type { Meeting, MeetingSummary, TranscriptLine } from '../types';
import {
  deriveMeetingPresentationState,
  processingStatusesFromStages,
  type MeetingPresentationState,
  type ScopeKey,
} from '../domain/meeting';
import type {
  MeetingListProjectionItem,
  MeetingNoteRepository,
} from '../data/repositories/meetingNoteRepository';
import { Colors as C } from '../theme/colors';
import { formatDuration } from '../utils/meetingMedia';
import {
  summaryProjectionToLegacySummary,
  transcriptProjectionToLegacyLines,
} from './meetingContentProjection';
import { sortMeetingDisplayItems } from './meetingDisplayOrder';

export interface MeetingReadProjection {
  meetings: Meeting[];
  transcripts: Record<string, TranscriptLine[]>;
  summaries: Record<string, MeetingSummary | null>;
  canonicalIdByLegacyId: Readonly<Record<string, string>>;
}

function projectionIdentityForItem(
  item: MeetingListProjectionItem,
  scopeKey: ScopeKey,
): string {
  if (item.legacySourceId) return item.legacySourceId;
  const prefix = `legacy:${encodeURIComponent(scopeKey)}:`;
  if (item.id.startsWith(prefix)) {
    try {
      return decodeURIComponent(item.id.slice(prefix.length));
    } catch {
      return item.id;
    }
  }
  return item.id;
}

function stageStatus(item: MeetingListProjectionItem, stage: string): string | null {
  return item.stages.find(candidate => candidate.stage === stage)?.status ?? null;
}

function compatibilityStatus(item: MeetingListProjectionItem): string {
  const capture = stageStatus(item, 'capture');
  if (item.lifecycle === 'deleted') return 'deleted';
  if (capture === 'recording') return 'recording';
  if (capture === 'paused') return 'paused';
  if (capture === 'failed_recoverable' || capture === 'failed_terminal') return 'failed';
  if (
    capture === 'preparing'
    || capture === 'finalizing'
    || item.lifecycle === 'active'
    || stageStatus(item, 'transcript') === 'finalizing'
    || ['queued', 'generating'].includes(stageStatus(item, 'summary') ?? '')
  ) return 'processing';
  if (item.lifecycle === 'ended') return 'completed';
  return 'created';
}

function presentationTag(presentation: MeetingPresentationState): { label: string; color: string } {
  const color = presentation.tone === 'danger'
    ? C.red
    : presentation.tone === 'warning'
      ? C.orange
      : presentation.tone === 'success'
        ? C.green
        : presentation.tone === 'primary'
          ? C.blue
          : C.faint;
  return { label: presentation.label, color };
}

function compatibilityTags(
  presentation: MeetingPresentationState,
  uploadPending: boolean,
  uploadBlocked: boolean,
): Meeting['tags'] {
  const tags: Meeting['tags'] = [presentationTag(presentation)];
  tags.push({ label: '本机', color: C.teal });
  if (uploadBlocked) tags.push({ label: '上传受阻', color: C.red });
  else if (uploadPending) tags.push({ label: '待上传', color: C.orange });
  return tags;
}

function dateTimeFromMs(value: number): { date: string; time: string } {
  const date = new Date(value);
  return {
    date: `${date.getFullYear()}年${date.getMonth() + 1}月${date.getDate()}日`,
    time: `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`,
  };
}

function waveformFromJson(value: string | null): number[] | undefined {
  if (!value) return undefined;
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed)) return undefined;
    const waveform = parsed.filter((sample): sample is number => (
      typeof sample === 'number' && Number.isFinite(sample) && sample >= 0
    ));
    return waveform.length > 0 ? waveform : undefined;
  } catch {
    return undefined;
  }
}

function compatibilityMeeting(
  item: MeetingListProjectionItem,
  scopeKey: ScopeKey,
): Meeting {
  const id = projectionIdentityForItem(item, scopeKey);
  const recordedAtMs = item.recordedAtMs ?? item.startedAtMs ?? item.createdAtMs;
  const dateTime = dateTimeFromMs(recordedAtMs);
  const recording = item.primaryRecording;
  const durationSec = recording?.durationMs !== null && recording?.durationMs !== undefined
    ? recording.durationMs / 1000
    : undefined;
  const upload = stageStatus(item, 'upload');
  const uploadPending = ['queued', 'uploading', 'failed_retryable'].includes(upload ?? '');
  const uploadBlocked = upload === 'blocked';
  const status = compatibilityStatus(item);
  const presentation = deriveMeetingPresentationState(processingStatusesFromStages(item.stages));
  const audioAvailable = Boolean(
    recording
    && (recording.localState === 'local_ready'
      || recording.localState === 'remote_only'
      || recording.remoteAssetId),
  );
  return {
    id,
    title: item.title,
    ...dateTime,
    duration: formatDuration(durationSec),
    tags: compatibilityTags(presentation, uploadPending, uploadBlocked),
    participants: [...item.participants],
    hasTranscript: item.activeTranscriptSegmentCount > 0 || stageStatus(item, 'transcript') === 'ready',
    hasSummary: item.currentSummaryReady || stageStatus(item, 'summary') === 'ready',
    summaryCoverText: item.currentSummaryPreview ?? undefined,
    status,
    mode: item.mode ?? 'realtime',
    description: item.description,
    location: item.location,
    createdAt: new Date(recordedAtMs).toISOString(),
    updatedAt: new Date(item.updatedAtMs).toISOString(),
    audioAvailable,
    audioSyncPending: uploadPending,
    audioSyncBlocked: uploadBlocked,
    audioLocalUri: recording?.localUri ?? null,
    audioDurationSec: durationSec,
    audioBars: waveformFromJson(recording?.waveformJson ?? null),
    clientRequestId: item.clientRequestId ?? undefined,
    source: 'guest',
  };
}

async function listAllMeetings(
  repository: MeetingNoteRepository,
  scopeKey: ScopeKey,
): Promise<MeetingListProjectionItem[]> {
  const items: MeetingListProjectionItem[] = [];
  let before: { updatedAtMs: number; id: string } | null = null;
  for (let page = 0; page < 100; page += 1) {
    const projection = await repository.listProjection(scopeKey, {
      limit: 200,
      before,
      includeDeleted: false,
    });
    items.push(...projection.items);
    if (!projection.hasMore || projection.items.length === 0) return items;
    const last = projection.items.at(-1)!;
    before = { updatedAtMs: last.updatedAtMs, id: last.id };
  }
  throw new Error('meeting canonical projection exceeds read limit');
}

export async function buildCanonicalMeetingReadProjection(
  repository: MeetingNoteRepository,
  scopeKey: ScopeKey,
): Promise<MeetingReadProjection> {
  const rawItems = await listAllMeetings(repository, scopeKey);
  const items = sortMeetingDisplayItems(
    rawItems,
    await repository.listMeetingDisplayOrder(scopeKey),
  );
  const meetings = items.map(item => compatibilityMeeting(item, scopeKey));
  const transcripts: Record<string, TranscriptLine[]> = {};
  const summaries: Record<string, MeetingSummary | null> = {};
  const canonicalIdByLegacyId: Record<string, string> = {};

  for (let offset = 0; offset < items.length; offset += 8) {
    await Promise.all(items.slice(offset, offset + 8).map(async item => {
      const legacyId = projectionIdentityForItem(item, scopeKey);
      if (canonicalIdByLegacyId[legacyId]) {
        throw new Error('meeting canonical projection has duplicate compatibility identity');
      }
      canonicalIdByLegacyId[legacyId] = item.id;
      const [transcriptProjection, summaryProjection] = await Promise.all([
        repository.getActiveTranscriptContent(item.id, scopeKey),
        repository.getCurrentSummaryContent(item.id, scopeKey),
      ]);
      const lines = transcriptProjectionToLegacyLines(transcriptProjection, legacyId);
      if (lines.length !== item.activeTranscriptSegmentCount) {
        throw new Error('meeting canonical transcript projection changed during read');
      }
      const summary = summaryProjectionToLegacySummary(summaryProjection, legacyId);
      if (Boolean(summary) !== item.currentSummaryReady) {
        throw new Error('meeting canonical summary projection changed during read');
      }
      if (lines.length > 0) transcripts[legacyId] = lines;
      if (summary) summaries[legacyId] = summary;
    }));
  }
  return { meetings, transcripts, summaries, canonicalIdByLegacyId };
}

/**
 * Fast cold-start projection for the list surface. Root rows and processing
 * stages are enough to render cards. Transcript and summary bodies remain in
 * SQLite until a detail surface or an operation explicitly asks for them.
 */
export async function buildCanonicalMeetingListProjection(
  repository: MeetingNoteRepository,
  scopeKey: ScopeKey,
): Promise<MeetingReadProjection> {
  const rawItems = await listAllMeetings(repository, scopeKey);
  const items = sortMeetingDisplayItems(
    rawItems,
    await repository.listMeetingDisplayOrder(scopeKey),
  );
  const meetings = items.map(item => compatibilityMeeting(item, scopeKey));
  const canonicalIdByLegacyId: Record<string, string> = {};
  items.forEach(item => {
    const legacyId = projectionIdentityForItem(item, scopeKey);
    if (canonicalIdByLegacyId[legacyId]) {
      throw new Error('meeting canonical list projection has duplicate compatibility identity');
    }
    canonicalIdByLegacyId[legacyId] = item.id;
  });
  return { meetings, transcripts: {}, summaries: {}, canonicalIdByLegacyId };
}
