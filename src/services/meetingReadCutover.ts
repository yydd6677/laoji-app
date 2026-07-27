import type { Meeting, MeetingSummary, TranscriptLine } from '../types';
import {
  deriveMeetingPresentationState,
  processingStatusesFromStages,
  type MeetingPresentationState,
  type ScopeKey,
} from '../domain/meeting';
import type {
  MeetingDualReadReport,
  MeetingListProjectionItem,
  MeetingNoteRepository,
} from '../data/repositories';
import {
  MeetingRepositoryFacade,
  legacyIdentityForRepositoryItem,
} from '../data/repositories/meetingRepositoryFacade';
import { Colors as C } from '../theme/colors';
import { formatDuration } from '../utils/meetingMedia';
import {
  summaryProjectionToLegacySummary,
  transcriptProjectionToLegacyLines,
} from './meetingContentProjection';
import { meetingSummaryToText } from './meetingSummaryFormat';
import { sortMeetingDisplayItems } from './meetingDisplayOrder';

export interface MeetingReadSnapshot {
  meetings: readonly Meeting[];
  transcripts: Readonly<Record<string, readonly TranscriptLine[]>>;
  summaries: Readonly<Record<string, MeetingSummary | null>>;
}

export interface MeetingReadProjection {
  meetings: Meeting[];
  transcripts: Record<string, TranscriptLine[]>;
  summaries: Record<string, MeetingSummary | null>;
  canonicalIdByLegacyId: Readonly<Record<string, string>>;
}

export type MeetingReadCutoverReason =
  | 'disabled'
  | 'preflight_mismatch'
  | 'canonical_projection_ready'
  | 'canonical_projection_mismatch'
  | 'projection_failed';

export interface MeetingReadCompatibilityReport {
  meetingMismatches: number;
  transcriptContentMismatches: number;
  summaryContentMismatches: number;
}

export interface MeetingReadCutoverResult {
  source: 'legacy' | 'sqlite';
  reason: MeetingReadCutoverReason;
  projection: MeetingReadProjection;
  preflight: MeetingDualReadReport | null;
  compatibility: MeetingReadCompatibilityReport | null;
  errorCode: string | null;
}

export interface ResolveMeetingReadCutoverInput {
  enabled: boolean;
  repository: MeetingNoteRepository;
  scopeKey: ScopeKey;
  legacy: MeetingReadSnapshot;
  preflight?: MeetingDualReadReport | null;
}

function mutableLegacyProjection(snapshot: MeetingReadSnapshot): MeetingReadProjection {
  return {
    meetings: snapshot.meetings.map(meeting => ({ ...meeting })),
    transcripts: Object.fromEntries(
      Object.entries(snapshot.transcripts).map(([id, lines]) => [id, [...lines]]),
    ),
    summaries: { ...snapshot.summaries },
    canonicalIdByLegacyId: {},
  };
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
  item: MeetingListProjectionItem,
  scopeKey: ScopeKey,
  presentation: MeetingPresentationState,
  uploadPending: boolean,
  uploadBlocked: boolean,
): Meeting['tags'] {
  const tags: Meeting['tags'] = [presentationTag(presentation)];
  if (scopeKey === 'guest') tags.push({ label: '本机', color: C.teal });
  if (scopeKey !== 'guest' && item.mode) {
    tags.push({ label: item.mode === 'offline' ? '离线' : '实时', color: C.blue });
  }
  if (item.syncState === 'pending') tags.push({ label: '待同步', color: C.orange });
  if (item.syncState === 'conflicted') tags.push({ label: '同步冲突', color: C.red });
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
  const id = legacyIdentityForRepositoryItem(item, scopeKey);
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
    remoteId: item.remoteId,
    title: item.title,
    ...dateTime,
    duration: formatDuration(durationSec),
    tags: compatibilityTags(item, scopeKey, presentation, uploadPending, uploadBlocked),
    participants: [...item.participants],
    hasTranscript: item.activeTranscriptSegmentCount > 0 || stageStatus(item, 'transcript') === 'ready',
    hasSummary: item.currentSummaryReady || stageStatus(item, 'summary') === 'ready',
    status,
    statusSyncPending: item.syncState === 'pending',
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
    source: scopeKey === 'guest' ? 'guest' : 'cloud',
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
      const legacyId = legacyIdentityForRepositoryItem(item, scopeKey);
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

function normalizedTimestamp(value: string | undefined): number | null {
  const parsed = value ? Date.parse(value) : Number.NaN;
  return Number.isFinite(parsed) ? Math.trunc(parsed) : null;
}

function normalizedStatus(value: string | undefined): string {
  const status = value?.toLowerCase();
  if (['completed', 'ended', 'done', 'processed'].includes(status ?? '')) return 'completed';
  return status || 'created';
}

function normalizedDurationSeconds(value: number | undefined): number | null {
  return Number.isFinite(value) ? Math.round(Number(value) * 1000) : null;
}

function normalizedMeetingCompatibility(meeting: Meeting, scopeKey: ScopeKey): unknown {
  return {
    id: meeting.id,
    title: meeting.title,
    date: meeting.date,
    time: meeting.time ?? null,
    duration: meeting.duration,
    // The first tag is a derived presentation state. Canonical stages use the
    // more precise Chinese label (for example, legacy “失败” becomes
    // “录音中断”), while `status` below already verifies the same lifecycle.
    // Compare only durable secondary tags so a wording improvement does not
    // block an otherwise lossless read cutover.
    tags: meeting.tags.slice(1).map(tag => ({ label: tag.label, color: tag.color })),
    participants: (meeting.participants ?? []).map(value => value.trim()).filter(Boolean),
    hasTranscript: Boolean(meeting.hasTranscript),
    hasSummary: Boolean(meeting.hasSummary),
    status: normalizedStatus(meeting.status),
    statusSyncPending: Boolean(meeting.statusSyncPending),
    mode: meeting.mode ?? 'realtime',
    description: meeting.description ?? null,
    location: meeting.location?.trim() || null,
    createdAtMs: normalizedTimestamp(meeting.createdAt),
    audioAvailable: Boolean(meeting.audioAvailable),
    audioSyncPending: Boolean(meeting.audioSyncPending),
    audioSyncBlocked: Boolean(meeting.audioSyncBlocked),
    audioLocalUri: meeting.audioLocalUri ?? null,
    audioDurationMs: normalizedDurationSeconds(meeting.audioDurationSec),
    audioBars: meeting.audioBars ?? [],
    clientRequestId: meeting.clientRequestId?.trim() || null,
    source: meeting.source ?? (scopeKey === 'guest' ? 'guest' : 'cloud'),
  };
}

function normalizedTranscriptCompatibility(lines: readonly TranscriptLine[]): unknown {
  return lines.map(line => ({
    recordingAssetId: line.recordingAssetId ?? null,
    recordingAssetRemoteId: line.recording_asset_id ?? line.recordingAssetRemoteId ?? null,
    transcriptionJobId: line.transcription_job_id ?? line.transcriptionJobId ?? null,
    speakerId: line.speaker_id ?? null,
    speakerLabel: line.speaker_label ?? null,
    text: line.text,
    startMs: Number.isFinite(line.start_time) ? Math.round(Number(line.start_time) * 1000) : 0,
    endMs: Number.isFinite(line.end_time) ? Math.round(Number(line.end_time) * 1000) : 0,
    confidence: Number.isFinite(line.confidence) ? Number(line.confidence) : null,
  }));
}

export function compareMeetingReadCompatibility(
  legacy: MeetingReadSnapshot,
  canonical: MeetingReadProjection,
  scopeKey: ScopeKey,
): MeetingReadCompatibilityReport {
  let meetingMismatches = Math.abs(legacy.meetings.length - canonical.meetings.length);
  for (let index = 0; index < Math.min(legacy.meetings.length, canonical.meetings.length); index += 1) {
    const legacyMeeting = legacy.meetings[index];
    const canonicalMeeting = canonical.meetings[index];
    if (
      JSON.stringify(normalizedMeetingCompatibility(legacyMeeting, scopeKey))
      !== JSON.stringify(normalizedMeetingCompatibility(canonicalMeeting, scopeKey))
    ) meetingMismatches += 1;
  }

  const identities = new Set([
    ...legacy.meetings.map(meeting => meeting.id),
    ...canonical.meetings.map(meeting => meeting.id),
  ]);
  let transcriptContentMismatches = 0;
  let summaryContentMismatches = 0;
  identities.forEach(id => {
    if (
      JSON.stringify(normalizedTranscriptCompatibility(legacy.transcripts[id] ?? []))
      !== JSON.stringify(normalizedTranscriptCompatibility(canonical.transcripts[id] ?? []))
    ) transcriptContentMismatches += 1;
    if (
      meetingSummaryToText(legacy.summaries[id] ?? null)
      !== meetingSummaryToText(canonical.summaries[id] ?? null)
    ) summaryContentMismatches += 1;
  });
  return { meetingMismatches, transcriptContentMismatches, summaryContentMismatches };
}

export async function resolveMeetingReadCutover(
  input: ResolveMeetingReadCutoverInput,
): Promise<MeetingReadCutoverResult> {
  const fallback = mutableLegacyProjection(input.legacy);
  if (!input.enabled) {
    return {
      source: 'legacy',
      reason: 'disabled',
      projection: fallback,
      preflight: null,
      compatibility: null,
      errorCode: null,
    };
  }

  try {
    const preflight = input.preflight ?? await new MeetingRepositoryFacade(input.repository)
      .compareLegacySnapshot(input.scopeKey, input.legacy.meetings, {
        transcriptLineCounts: Object.fromEntries(
          Object.entries(input.legacy.transcripts).map(([id, lines]) => [id, lines.length]),
        ),
        summaryReady: Object.fromEntries(
          Object.entries(input.legacy.summaries)
            .map(([id, summary]) => [id, Boolean(meetingSummaryToText(summary))]),
        ),
      });
    if (preflight.status !== 'consistent') {
      return {
        source: 'legacy',
        reason: 'preflight_mismatch',
        projection: fallback,
        preflight,
        compatibility: null,
        errorCode: null,
      };
    }
    const projection = await buildCanonicalMeetingReadProjection(input.repository, input.scopeKey);
    if (projection.meetings.length !== preflight.repositoryMeetings) {
      throw new Error('meeting canonical projection changed during pagination');
    }
    const compatibility = compareMeetingReadCompatibility(input.legacy, projection, input.scopeKey);
    if (
      compatibility.meetingMismatches > 0
      || compatibility.transcriptContentMismatches > 0
      || compatibility.summaryContentMismatches > 0
    ) {
      return {
        source: 'legacy',
        reason: 'canonical_projection_mismatch',
        projection: fallback,
        preflight,
        compatibility,
        errorCode: null,
      };
    }
    return {
      source: 'sqlite',
      reason: 'canonical_projection_ready',
      projection,
      preflight,
      compatibility,
      errorCode: null,
    };
  } catch (error) {
    return {
      source: 'legacy',
      reason: 'projection_failed',
      projection: fallback,
      preflight: input.preflight ?? null,
      compatibility: null,
      errorCode: error instanceof Error ? error.name : 'UnknownError',
    };
  }
}
