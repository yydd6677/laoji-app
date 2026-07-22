import type { Meeting, MeetingSummary, TranscriptLine } from '../types';
import type { ScopeKey } from '../domain/meeting';
import type {
  MeetingDualReadReport,
  MeetingListProjectionItem,
  MeetingNoteRepository,
} from '../data/repositories';
import {
  MeetingRepositoryFacade,
  legacyIdentityForRepositoryItem,
} from '../data/repositories';
import { Colors as C } from '../theme/colors';
import { formatDuration } from '../utils/meetingMedia';
import {
  summaryProjectionToLegacySummary,
  transcriptProjectionToLegacyLines,
} from './meetingContentProjection';
import { meetingSummaryToText } from './meetingSummaryFormat';

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
  | 'projection_failed';

export interface MeetingReadCutoverResult {
  source: 'legacy' | 'sqlite';
  reason: MeetingReadCutoverReason;
  projection: MeetingReadProjection;
  preflight: MeetingDualReadReport | null;
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

function statusTag(status: string): { label: string; color: string } {
  if (status === 'recording') return { label: '录音中', color: C.red };
  if (status === 'processing') return { label: '处理中', color: C.orange };
  if (status === 'failed') return { label: '失败', color: C.red };
  if (status === 'completed') return { label: '已完成', color: C.green };
  return { label: '未开始', color: C.purple };
}

function compatibilityTags(
  item: MeetingListProjectionItem,
  scopeKey: ScopeKey,
  status: string,
  uploadPending: boolean,
  uploadBlocked: boolean,
): Meeting['tags'] {
  const tags: Meeting['tags'] = [statusTag(status)];
  if (scopeKey === 'guest') tags.push({ label: '本机', color: C.teal });
  if (item.mode) {
    tags.push({ label: item.mode === 'offline' ? '离线' : '实时', color: C.blue });
  }
  if (item.syncState === 'pending') tags.push({ label: '待同步', color: C.orange });
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
    tags: compatibilityTags(item, scopeKey, status, uploadPending, uploadBlocked),
    participants: [...item.participants],
    hasTranscript: item.activeTranscriptSegmentCount > 0,
    hasSummary: item.currentSummaryReady,
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

async function canonicalProjection(
  repository: MeetingNoteRepository,
  scopeKey: ScopeKey,
): Promise<MeetingReadProjection> {
  const items = await listAllMeetings(repository, scopeKey);
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
        errorCode: null,
      };
    }
    const projection = await canonicalProjection(input.repository, input.scopeKey);
    if (projection.meetings.length !== preflight.repositoryMeetings) {
      throw new Error('meeting canonical projection changed during pagination');
    }
    return {
      source: 'sqlite',
      reason: 'canonical_projection_ready',
      projection,
      preflight,
      errorCode: null,
    };
  } catch (error) {
    return {
      source: 'legacy',
      reason: 'projection_failed',
      projection: fallback,
      preflight: input.preflight ?? null,
      errorCode: error instanceof Error ? error.name : 'UnknownError',
    };
  }
}
