import * as Crypto from 'expo-crypto';
import type {
  MeetingNoteRepository,
  TranscriptRevisionProjection,
  TranscriptRevisionRecord,
  TranscriptSegmentRecord,
} from '../../data/repositories';
import { projectLegacyTranscriptSegmentRevisions } from '../../services/transcriptSegmentRevision';
import {
  transitionProcessingStage,
  type ProcessingStage,
} from '../../domain/meeting/processing';
import { assertScopeKey, type ScopeKey } from '../../domain/meeting';
import type { TranscriptLine } from '../../types';
import {
  evaluateTranscriptCandidate,
  type TranscriptCandidateDecision,
  type TranscriptCandidateKind,
  type TranscriptServerCompleteness,
} from '../../services/transcriptCompleteness';

interface NormalizedTranscriptLine {
  ordinal: number;
  sourceId: string;
  sourceRecordingAssetId: string | null;
  sourceRecordingAssetRemoteId: string | null;
  sourceTranscriptionJobId: string | null;
  speakerId: string | null;
  speakerLabel: string | null;
  text: string;
  startMs: number;
  endMs: number;
  confidence: number | null;
  createdAtMs: number;
}

export interface SaveMeetingTranscriptInput {
  meetingId: string;
  scopeKey?: ScopeKey;
  transcript: readonly TranscriptLine[];
  candidateKind: TranscriptCandidateKind;
  serverCompleteness?: TranscriptServerCompleteness;
  remoteRevisionId?: string | null;
  canonicalWrite?: boolean;
}

export type SaveGuestMeetingTranscriptInput = SaveMeetingTranscriptInput;

export interface SaveMeetingTranscriptResult {
  activeTranscript: TranscriptRevisionProjection | null;
  decision: TranscriptCandidateDecision;
  canonicalRevision: number | null;
  activeContentChanged: boolean;
}

export type SaveGuestMeetingTranscriptResult = SaveMeetingTranscriptResult;

export interface SaveMeetingTranscriptDependencies {
  repository: MeetingNoteRepository;
  digest?: (value: string) => Promise<string>;
  now?: () => number;
}

export type SaveGuestMeetingTranscriptDependencies = SaveMeetingTranscriptDependencies;

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

async function sha256(value: string): Promise<string> {
  return Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, value);
}

function normalizedId(value: string | null | undefined, field: string): string | null {
  if (value === null || value === undefined) return null;
  const normalized = value.trim();
  if (!normalized) return null;
  if (normalized.length > 512 || /[\u0000-\u001f\u007f]/.test(normalized)) {
    throw new Error(`${field} is invalid`);
  }
  return normalized;
}

function secondsToMs(value: number | null | undefined): number {
  return Number.isFinite(value) ? Math.max(0, Math.round(Number(value) * 1000)) : 0;
}

function timestamp(value: string | null | undefined, fallback: number): number {
  const parsed = value ? Date.parse(value) : Number.NaN;
  return Number.isFinite(parsed) ? Math.max(0, Math.trunc(parsed)) : fallback;
}

function normalizeText(value: string): string {
  return value.normalize('NFKC').toLocaleLowerCase('zh-CN');
}

function normalizeLines(
  transcript: readonly TranscriptLine[],
  fallbackCreatedAtMs: number,
): NormalizedTranscriptLine[] {
  return transcript
    .filter(line => typeof line.text === 'string' && line.text.trim().length > 0)
    .map((line, ordinal) => {
      const startMs = secondsToMs(line.start_time);
      const wireRecordingAssetId = normalizedId(
        line.recording_asset_id,
        'transcript recording asset remote ID',
      );
      const compatibilityRemoteId = normalizedId(
        line.recordingAssetRemoteId,
        'transcript recording asset remote ID',
      );
      if (
        wireRecordingAssetId
        && compatibilityRemoteId
        && wireRecordingAssetId !== compatibilityRemoteId
      ) throw new Error('transcript recording asset remote identity is inconsistent');
      return {
        ordinal,
        sourceId: typeof line.id === 'string' ? line.id.trim() : '',
        sourceRecordingAssetId: normalizedId(
          line.recordingAssetId,
          'transcript recording asset ID',
        ),
        sourceRecordingAssetRemoteId: wireRecordingAssetId ?? compatibilityRemoteId,
        sourceTranscriptionJobId: normalizedId(
          line.transcription_job_id ?? line.transcriptionJobId,
          'transcript source job ID',
        ),
        speakerId: line.speaker_id?.trim() || null,
        speakerLabel: line.speaker_label?.trim() || null,
        text: line.text,
        startMs,
        endMs: Math.max(startMs, secondsToMs(line.end_time)),
        confidence: Number.isFinite(line.confidence)
          && Number(line.confidence) >= 0
          && Number(line.confidence) <= 1
          ? Number(line.confidence)
          : null,
        createdAtMs: timestamp(line.created_at, fallbackCreatedAtMs),
      };
    });
}

function mergeRemoteIdentity(
  current: string | null,
  incoming: string | null,
  field: string,
): string | null {
  if (current && incoming && current !== incoming) {
    throw new Error(`transcript remote revision ${field} changed`);
  }
  return current ?? incoming;
}

function sameSemanticSegment(
  segment: TranscriptSegmentRecord,
  line: NormalizedTranscriptLine,
): boolean {
  return segment.ordinal === line.ordinal
    && segment.speakerClusterId === line.speakerId
    && segment.speakerLabel === line.speakerLabel
    && segment.text === line.text
    && segment.startMs === line.startMs
    && segment.endMs === line.endMs
    && segment.confidence === line.confidence;
}

function reuseRemoteRevisionLines(
  remoteRevision: TranscriptRevisionProjection,
  lines: readonly NormalizedTranscriptLine[],
): NormalizedTranscriptLine[] {
  if (
    remoteRevision.segments.length !== lines.length
    || remoteRevision.segments.some((segment, index) => !sameSemanticSegment(segment, lines[index]))
  ) {
    throw new Error('transcript remote revision content changed');
  }
  return lines.map((line, index) => {
    const segment = remoteRevision.segments[index];
    return {
      ...line,
      sourceId: mergeRemoteIdentity(segment.sourceId, line.sourceId || null, 'source segment identity') ?? '',
      sourceRecordingAssetId: mergeRemoteIdentity(
        segment.sourceRecordingAssetId,
        line.sourceRecordingAssetId,
        'recording asset identity',
      ),
      sourceRecordingAssetRemoteId: mergeRemoteIdentity(
        segment.sourceRecordingAssetRemoteId,
        line.sourceRecordingAssetRemoteId,
        'remote recording asset identity',
      ),
      sourceTranscriptionJobId: mergeRemoteIdentity(
        segment.sourceTranscriptionJobId,
        line.sourceTranscriptionJobId,
        'source job identity',
      ),
      createdAtMs: segment.createdAtMs,
    };
  });
}

function sameSemanticContent(
  current: TranscriptRevisionProjection | null,
  lines: readonly NormalizedTranscriptLine[],
): boolean {
  return Boolean(
    current
    && current.segments.length === lines.length
    && current.segments.every((segment, index) => sameSemanticSegment(segment, lines[index])),
  );
}

function sameActiveContent(
  current: TranscriptRevisionProjection | null,
  revisionId: string,
  lines: readonly NormalizedTranscriptLine[],
): boolean {
  if (!current || current.revision.id !== revisionId || current.segments.length !== lines.length) {
    return false;
  }
  return current.segments.every((segment, index) => {
    const line = lines[index];
    return segment.ordinal === line.ordinal
      && (segment.sourceId ?? '') === line.sourceId
      && segment.sourceRecordingAssetId === line.sourceRecordingAssetId
      && segment.sourceRecordingAssetRemoteId === line.sourceRecordingAssetRemoteId
      && segment.sourceTranscriptionJobId === line.sourceTranscriptionJobId
      && segment.speakerClusterId === line.speakerId
      && segment.speakerLabel === line.speakerLabel
      && segment.text === line.text
      && segment.startMs === line.startMs
      && segment.endMs === line.endMs
      && segment.confidence === line.confidence
      && segment.createdAtMs === line.createdAtMs;
  });
}

function sameActiveRevision(
  current: TranscriptRevisionProjection | null,
  revision: TranscriptRevisionRecord,
  lines: readonly NormalizedTranscriptLine[],
): boolean {
  if (!sameActiveContent(current, revision.id, lines) || !current) return false;
  const active = current.revision;
  return active.remoteId === revision.remoteId
    && active.kind === revision.kind
    && active.status === revision.status
    && active.sourceProvider === revision.sourceProvider
    && active.sourceModel === revision.sourceModel
    && active.isActive === revision.isActive
    && active.createdAtMs === revision.createdAtMs
    && active.finalizedAtMs === revision.finalizedAtMs;
}

function sameProcessingStageState(current: ProcessingStage, next: ProcessingStage): boolean {
  return current.status === next.status
    && current.attemptCount === next.attemptCount
    && current.progress === next.progress
    && current.jobId === next.jobId
    && current.inputFingerprint === next.inputFingerprint
    && current.errorCode === next.errorCode
    && current.userMessageKey === next.userMessageKey
    && current.retryable === next.retryable
    && current.nextRetryAtMs === next.nextRetryAtMs;
}

function transcriptStageStatus(
  meetingLifecycle: 'draft' | 'active' | 'ended' | 'deleted',
  current: TranscriptRevisionRecord | null,
  candidateKind: TranscriptCandidateKind,
  completeness: TranscriptServerCompleteness,
  hasCandidate: boolean,
  activate: boolean,
  decision: TranscriptCandidateDecision,
): 'none' | 'realtime_draft' | 'finalizing' | 'ready' {
  if (!hasCandidate) {
    if (current?.kind === 'realtime_draft') {
      return meetingLifecycle === 'active' ? 'realtime_draft' : 'finalizing';
    }
    if (current?.status === 'ready') return 'ready';
    if (candidateKind === 'realtime_draft' && meetingLifecycle === 'active') return 'realtime_draft';
    return completeness === 'incomplete' ? 'finalizing' : 'none';
  }
  if (activate) {
    if (candidateKind !== 'realtime_draft') return 'ready';
    return completeness === 'incomplete' && meetingLifecycle !== 'active'
      ? 'finalizing'
      : 'realtime_draft';
  }
  if (candidateKind !== 'realtime_draft' && decision.clearlyShorter) return 'finalizing';
  if (current?.kind === 'realtime_draft') {
    return meetingLifecycle === 'active' ? 'realtime_draft' : 'finalizing';
  }
  return current?.status === 'ready' ? 'ready' : 'finalizing';
}

export class SaveGuestMeetingTranscriptUseCase {
  private readonly repository: MeetingNoteRepository;
  private readonly digest: (value: string) => Promise<string>;
  private readonly now: () => number;

  constructor(dependencies: SaveMeetingTranscriptDependencies) {
    this.repository = dependencies.repository;
    this.digest = dependencies.digest ?? sha256;
    this.now = dependencies.now ?? Date.now;
  }

  async execute(input: SaveMeetingTranscriptInput): Promise<SaveMeetingTranscriptResult> {
    const meetingId = normalizedId(input.meetingId, 'meeting ID');
    if (!meetingId) throw new Error('meeting ID is invalid');
    const scopeKey = input.scopeKey ?? 'guest';
    assertScopeKey(scopeKey);
    if (!['realtime_draft', 'final', 'reprocessed'].includes(input.candidateKind)) {
      throw new Error('transcript candidate kind is invalid');
    }
    const serverCompleteness = input.serverCompleteness ?? 'unknown';
    if (!['complete', 'incomplete', 'unknown'].includes(serverCompleteness)) {
      throw new Error('transcript completeness is invalid');
    }
    const remoteRevisionId = normalizedId(input.remoteRevisionId, 'transcript remote revision ID');
    const aggregate = await this.repository.get(meetingId, scopeKey);
    if (!aggregate || aggregate.note.lifecycle === 'deleted') {
      throw new Error('meeting does not accept transcript content in active scope');
    }
    const recordingAssetById = new Map(aggregate.recordingAssets.map(asset => [asset.id, asset]));
    const recordingAssetByRemoteId = new Map(aggregate.recordingAssets
      .filter(asset => Boolean(asset.remoteAssetId))
      .map(asset => [asset.remoteAssetId!, asset]));
    const soleRecordingAsset = aggregate.recordingAssets.length === 1
      ? aggregate.recordingAssets[0]
      : null;
    let lines = normalizeLines(input.transcript, aggregate.note.createdAtMs).map(line => {
      const explicitLocalAsset = line.sourceRecordingAssetId
        ? recordingAssetById.get(line.sourceRecordingAssetId)
        : null;
      if (line.sourceRecordingAssetId && !explicitLocalAsset) {
        throw new Error('transcript recording asset does not belong to the meeting');
      }
      const remoteAsset = line.sourceRecordingAssetRemoteId
        ? recordingAssetByRemoteId.get(line.sourceRecordingAssetRemoteId)
        : null;
      if (explicitLocalAsset && remoteAsset && explicitLocalAsset.id !== remoteAsset.id) {
        throw new Error('transcript recording asset identity is inconsistent');
      }
      if (
        explicitLocalAsset?.remoteAssetId
        && line.sourceRecordingAssetRemoteId
        && explicitLocalAsset.remoteAssetId !== line.sourceRecordingAssetRemoteId
      ) throw new Error('transcript recording asset remote identity changed');
      const resolvedAsset = explicitLocalAsset ?? remoteAsset ?? (
        !line.sourceRecordingAssetId && !line.sourceRecordingAssetRemoteId
          ? soleRecordingAsset
          : null
      );
      return {
        ...line,
        sourceRecordingAssetId: resolvedAsset?.id ?? line.sourceRecordingAssetId,
        sourceRecordingAssetRemoteId: line.sourceRecordingAssetRemoteId
          ?? resolvedAsset?.remoteAssetId
          ?? null,
      };
    });
    const matchingRemoteRevision = remoteRevisionId
      ? await this.repository.getTranscriptRevisionContentByRemoteId(
          meetingId,
          remoteRevisionId,
          scopeKey,
        )
      : null;
    if (matchingRemoteRevision) {
      lines = reuseRemoteRevisionLines(matchingRemoteRevision, lines);
    }
    const candidateKind = matchingRemoteRevision?.revision.kind ?? input.candidateKind;
    const fingerprint = await this.digest(stableJson(lines));
    const reprocessedIdentity = candidateKind === 'reprocessed' && remoteRevisionId
      ? await this.digest(stableJson({ fingerprint, remoteRevisionId }))
      : fingerprint;
    const realtimeDraft = candidateKind === 'realtime_draft';
    const revisionId = matchingRemoteRevision?.revision.id ?? (realtimeDraft
      ? `${meetingId}:transcript:canonical-live`
      : candidateKind === 'reprocessed'
        ? `${meetingId}:transcript:canonical-reprocessed:${reprocessedIdentity}`
        : `${meetingId}:transcript:canonical-final:${fingerprint}`);
    const segmentFingerprints = await Promise.all(lines.map(line => this.digest(stableJson(line))));
    const segments: TranscriptSegmentRecord[] = lines.map((line, ordinal) => {
      const previous = matchingRemoteRevision?.segments[ordinal] ?? null;
      const isFinal = previous?.isFinal ?? !realtimeDraft;
      const textState: TranscriptSegmentRecord['textState'] = isFinal ? 'final' : 'partial';
      const unchanged = previous
        && previous.text === line.text
        && previous.startMs === line.startMs
        && previous.endMs === line.endMs
        && previous.textState === textState;
      return {
        id: previous?.id ?? `${revisionId}:segment:${ordinal}:${segmentFingerprints[ordinal]}`,
        meetingId,
        sourceId: line.sourceId || null,
        sourceRecordingAssetId: line.sourceRecordingAssetId,
        sourceRecordingAssetRemoteId: line.sourceRecordingAssetRemoteId,
        sourceTranscriptionJobId: line.sourceTranscriptionJobId,
        stableSegmentKey: previous?.stableSegmentKey
          ?? line.sourceId
          ?? `${revisionId}:stable:${ordinal}`,
        segmentRevision: previous ? previous.segmentRevision + (unchanged ? 0 : 1) : 1,
        textState,
        ordinal,
        startMs: line.startMs,
        endMs: line.endMs,
        speakerClusterId: line.speakerId,
        speakerProfileId: previous?.speakerProfileId ?? null,
        speakerLabel: line.speakerLabel,
        speakerLabelOverride: previous?.speakerLabelOverride ?? null,
        text: line.text,
        normalizedText: normalizeText(line.text),
        confidence: line.confidence,
        isFinal,
        createdAtMs: line.createdAtMs,
      };
    });
    const createdAtMs = matchingRemoteRevision?.revision.createdAtMs ?? lines.reduce(
      (minimum, line) => Math.min(minimum, line.createdAtMs),
      aggregate.note.createdAtMs,
    );
    const finalizedAtMs = matchingRemoteRevision
      ? matchingRemoteRevision.revision.finalizedAtMs
      : realtimeDraft
        ? null
        : lines.reduce(
            (maximum, line) => Math.max(maximum, line.createdAtMs),
            createdAtMs,
          );
    let canonicalRevision: number | null = null;
    let decision: TranscriptCandidateDecision | null = null;
    let activeContentChanged = false;

    await this.repository.transaction(async transaction => {
      const meeting = await transaction.getMeeting(meetingId, scopeKey);
      if (!meeting || meeting.lifecycle === 'deleted') {
        throw new Error('meeting does not accept transcript content in active scope');
      }
      const stage = await transaction.getStage(meetingId, scopeKey, 'transcript');
      if (!stage) throw new Error('meeting transcript processing stage is missing');
      const clockMs = this.now();
      if (!Number.isSafeInteger(clockMs) || clockMs < 0) {
        throw new Error('meeting clock is invalid');
      }
      let updatedAtMs = Math.max(clockMs, meeting.updatedAtMs, stage.updatedAtMs);
      const currentContent = await transaction.getActiveTranscriptContent(meetingId, scopeKey);
      const current = currentContent?.revision ?? null;
      const versionedSegments = current?.id === revisionId && realtimeDraft
        ? projectLegacyTranscriptSegmentRevisions(currentContent?.segments ?? [], segments)
        : segments;
      decision = evaluateTranscriptCandidate(currentContent?.segments ?? [], versionedSegments, {
        candidateKind,
        serverCompleteness,
      });
      const stableFinalBlocksLateDraft = Boolean(
        current && current.kind !== 'realtime_draft' && realtimeDraft,
      );
      const activate = lines.length > 0
        && decision.useCandidate
        && !stableFinalBlocksLateDraft;
      const replacingDraftWithShorterCandidate = Boolean(
        current?.id === revisionId && realtimeDraft && !decision.useCandidate,
      );
      const revision: TranscriptRevisionRecord | null = lines.length > 0 ? {
        id: revisionId,
        meetingId,
        remoteId: remoteRevisionId,
        kind: candidateKind,
        status: matchingRemoteRevision?.revision.status ?? (realtimeDraft ? 'realtime_draft' : 'ready'),
        sourceProvider: matchingRemoteRevision?.revision.sourceProvider
          ?? (scopeKey === 'guest' ? 'canonical-guest' : 'canonical-account'),
        sourceModel: matchingRemoteRevision?.revision.sourceModel ?? null,
        sourceManifestSha256: matchingRemoteRevision?.revision.sourceManifestSha256 ?? null,
        isActive: activate,
        createdAtMs,
        finalizedAtMs,
        textFinalAtMs: matchingRemoteRevision?.revision.textFinalAtMs ?? finalizedAtMs,
      } : null;
      activeContentChanged = activate && !sameSemanticContent(currentContent, lines);
      const revisionNeedsWrite = Boolean(
        revision
        && !replacingDraftWithShorterCandidate
        && !(activate && sameActiveRevision(currentContent, revision, lines)),
      );
      const stageStatus = transcriptStageStatus(
        meeting.lifecycle,
        current,
        candidateKind,
        serverCompleteness,
        lines.length > 0,
        activate,
        decision,
      );
      const stageTransition = {
        stage: 'transcript' as const,
        status: stageStatus,
        progress: stageStatus === 'ready' ? 1 : null,
        inputFingerprint: lines.length > 0 ? `sha256:${fingerprint}` : null,
      };
      const initialNextStage = transitionProcessingStage(stage, stageTransition, updatedAtMs);
      const stageChanged = !sameProcessingStageState(stage, initialNextStage);
      const meetingSyncStateChanged = scopeKey === 'guest' && meeting.syncState !== 'local';

      // Detail loading may replay the already-active transcript. Keep that a
      // true no-op: no revision upsert, stage timestamp, meeting timestamp, or
      // canonical revision is allowed to change.
      if (!revisionNeedsWrite && !stageChanged && !meetingSyncStateChanged) return;

      if (revisionNeedsWrite && revision) {
        await transaction.saveTranscriptRevision(revision, versionedSegments, scopeKey, {
          activate,
          replaceSegments: realtimeDraft,
        });
        // A final/replayed transcript can receive a new revision identity
        // without changing any user-visible words. A summary is invalidated
        // only when the active semantic content changes; revision identity
        // alone must not produce "整理结果可更新" after stopping a meeting.
        if (
          activeContentChanged
          && await transaction.markCurrentSummaryStale(meetingId, scopeKey)
        ) {
          const summaryStage = await transaction.getStage(meetingId, scopeKey, 'summary');
          if (!summaryStage) throw new Error('meeting summary processing stage is missing');
          updatedAtMs = Math.max(updatedAtMs, summaryStage.updatedAtMs);
          await transaction.upsertStage(transitionProcessingStage(summaryStage, {
            stage: 'summary',
            status: 'stale',
            progress: null,
          }, updatedAtMs), scopeKey);
        }
      }
      if (stageChanged) {
        await transaction.upsertStage(
          transitionProcessingStage(stage, stageTransition, updatedAtMs),
          scopeKey,
        );
      }
      await transaction.updateMeeting(meetingId, scopeKey, {
        syncState: scopeKey === 'guest' ? 'local' : meeting.syncState,
        updatedAtMs,
      });
      if (input.canonicalWrite) {
        canonicalRevision = await transaction.advanceCanonicalWrite(scopeKey, updatedAtMs);
      }
    });

    if (!decision) throw new Error('transcript transaction did not evaluate candidate');
    const activeTranscript = await this.repository.getActiveTranscriptContent(meetingId, scopeKey);
    return { activeTranscript, decision, canonicalRevision, activeContentChanged };
  }
}

export { SaveGuestMeetingTranscriptUseCase as SaveMeetingTranscriptUseCase };
