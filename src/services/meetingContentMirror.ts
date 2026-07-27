import * as Crypto from 'expo-crypto';
import type { Meeting, MeetingSummary, TranscriptLine } from '../types';
import type {
  ActionItemRecord,
  SummaryCitationRecord,
  SummarySectionRecord,
  SummaryVersionRecord,
  TranscriptRevisionRecord,
  TranscriptSegmentRecord,
} from '../data/repositories';
import { sqliteMeetingNoteRepository } from '../data/repositories';
import type { ScopeKey } from '../domain/meeting';
import { transitionProcessingStage } from '../domain/meeting/processing';
import { getFeatureFlags } from '../config/featureFlags';
import { meetingSummaryToText, normalizeMeetingSummaryResult } from './meetingSummaryFormat';
import { legacyMeetingSummaryToDocument } from './meetingSummaryDocument';
import { diagnosticAudit, diagnosticWarn } from './diagnostics';
import {
  evaluateTranscriptCandidate,
  type TranscriptCandidateKind,
  type TranscriptServerCompleteness,
} from './transcriptCompleteness';

const writeTailByMeeting = new Map<string, Promise<unknown>>();

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

async function sha256(value: unknown): Promise<string> {
  return Crypto.digestStringAsync(
    Crypto.CryptoDigestAlgorithm.SHA256,
    stableJson(value),
  );
}

function timestamp(value: string | null | undefined, fallback: number): number {
  const parsed = value ? Date.parse(value) : Number.NaN;
  return Number.isFinite(parsed) ? Math.max(0, Math.trunc(parsed)) : fallback;
}

function secondsToMs(value: number | null | undefined): number {
  return Number.isFinite(value) ? Math.max(0, Math.round(Number(value) * 1000)) : 0;
}

function normalizeTranscriptText(value: string): string {
  return value.normalize('NFKC').toLocaleLowerCase('zh-CN');
}

function optionalTranscriptIdentity(value: string | null | undefined, field: string): string | null {
  if (value === null || value === undefined) return null;
  const normalized = value.trim();
  if (!normalized) return null;
  if (normalized.length > 512 || /[\u0000-\u001f\u007f]/.test(normalized)) {
    throw new Error(`${field} is invalid`);
  }
  return normalized;
}

function enqueueMeetingWrite<T>(scopeKey: ScopeKey, meetingId: string, operation: () => Promise<T>): Promise<T> {
  const key = `${scopeKey}\u0000${meetingId}`;
  const previous = writeTailByMeeting.get(key) ?? Promise.resolve();
  const next = previous.catch(() => undefined).then(operation);
  writeTailByMeeting.set(key, next);
  void next.finally(() => {
    if (writeTailByMeeting.get(key) === next) writeTailByMeeting.delete(key);
  }).catch(() => undefined);
  return next;
}

export interface SummaryMirrorResult {
  /** Whether the compatibility cache may replace its currently readable projection. */
  replaceLegacyProjection: boolean;
  status: string;
  canonicalRevision: number | null;
}

export interface MirrorLegacySummaryOptions {
  expectedCanonicalMeetingId?: string;
  canonicalWrite?: boolean;
  throwOnFailure?: boolean;
}

function isLegacyProvider(value: string | null): boolean {
  return value === 'legacy' || value === 'legacy-cache';
}

function legacyActionStatus(value: string | undefined): ActionItemRecord['status'] {
  const normalized = value?.trim().toLowerCase();
  if (['completed', 'complete', 'done'].includes(normalized ?? '')) return 'completed';
  if (['dismissed', 'cancelled', 'canceled'].includes(normalized ?? '')) return 'dismissed';
  return 'pending';
}

function normalizedActionIdentityText(value: string | null): string {
  return (value ?? '').normalize('NFKC').trim().replace(/\s+/g, ' ');
}

function reportFailure(kind: 'transcript' | 'summary', scopeKey: ScopeKey, error: unknown): void {
  diagnosticWarn(`[meeting-db] ${kind} shadow write failed`, error);
  diagnosticAudit(`meeting_${kind}_shadow_write`, {
    status: 'failed',
    scope: scopeKey === 'guest' ? 'guest' : 'account',
    error_code: error instanceof Error ? error.name : 'UnknownError',
  });
}

export interface MirrorLegacyTranscriptOptions {
  candidateKind?: TranscriptCandidateKind;
  serverCompleteness?: TranscriptServerCompleteness;
  remoteRevisionId?: string | null;
}

export function mirrorLegacyTranscriptContent(
  scopeKey: ScopeKey,
  legacyMeeting: Meeting,
  transcript: readonly TranscriptLine[],
  options: MirrorLegacyTranscriptOptions = {},
): Promise<void> {
  if (!getFeatureFlags().localMeetingDbV1) return Promise.resolve();
  return enqueueMeetingWrite(scopeKey, legacyMeeting.id, async () => {
    try {
      const aggregate = await sqliteMeetingNoteRepository.findByNativeSessionId(legacyMeeting.id, scopeKey);
      if (!aggregate || aggregate.note.lifecycle === 'deleted') return;
      const meaningfulTranscript = transcript.filter(line => (
        typeof line.text === 'string' && line.text.trim().length > 0
      ));
      if (meaningfulTranscript.length === 0) {
        let status = 'unchanged_empty';
        await sqliteMeetingNoteRepository.transaction(async transaction => {
          const note = await transaction.getMeeting(aggregate.note.id, scopeKey);
          if (!note || note.lifecycle === 'deleted') return;
          const current = await transaction.getActiveTranscriptRevision(note.id, scopeKey);
          if (current && !isLegacyProvider(current.sourceProvider)) {
            status = 'preserved_canonical';
            return;
          }
          const stage = await transaction.getStage(note.id, scopeKey, 'transcript');
          if (!stage) throw new Error('meeting transcript processing stage is missing');
          const nowMs = Math.max(Date.now(), stage.updatedAtMs, note.updatedAtMs);
          const stillCompleting = options.serverCompleteness === 'incomplete'
            || legacyMeeting.status === 'processing';
          const retainedStatus = !current
            ? stillCompleting ? 'finalizing' : 'none'
            : current.kind === 'realtime_draft'
              ? stillCompleting ? 'finalizing' : 'realtime_draft'
              : current.status === 'ready' ? 'ready' : 'finalizing';
          await transaction.upsertStage(transitionProcessingStage(stage, {
            stage: 'transcript',
            status: retainedStatus,
            progress: null,
            inputFingerprint: null,
          }, nowMs), scopeKey);
          await transaction.updateMeeting(note.id, scopeKey, { updatedAtMs: nowMs });
          status = current ? 'preserved_nonempty_active' : 'unchanged_empty';
        });
        diagnosticAudit('meeting_transcript_shadow_write', {
          status,
          scope: scopeKey === 'guest' ? 'guest' : 'account',
          segments: 0,
        });
        return;
      }
      const assetById = new Map(aggregate.recordingAssets.map(asset => [asset.id, asset]));
      const assetByRemoteId = new Map(aggregate.recordingAssets
        .filter(asset => Boolean(asset.remoteAssetId))
        .map(asset => [asset.remoteAssetId!, asset]));
      const soleAsset = aggregate.recordingAssets.length === 1 ? aggregate.recordingAssets[0] : null;
      const normalizedLines = meaningfulTranscript.map((line, ordinal) => {
        const localAssetId = optionalTranscriptIdentity(
          line.recordingAssetId,
          'transcript recording asset ID',
        );
        const wireRemoteAssetId = optionalTranscriptIdentity(
          line.recording_asset_id,
          'transcript recording asset remote ID',
        );
        const compatibilityRemoteAssetId = optionalTranscriptIdentity(
          line.recordingAssetRemoteId,
          'transcript recording asset remote ID',
        );
        if (
          wireRemoteAssetId
          && compatibilityRemoteAssetId
          && wireRemoteAssetId !== compatibilityRemoteAssetId
        ) throw new Error('transcript recording asset remote identity is inconsistent');
        const remoteAssetId = wireRemoteAssetId ?? compatibilityRemoteAssetId;
        const localAsset = localAssetId ? assetById.get(localAssetId) : null;
        if (localAssetId && !localAsset) {
          throw new Error('transcript recording asset does not belong to the meeting');
        }
        const remoteAsset = remoteAssetId ? assetByRemoteId.get(remoteAssetId) : null;
        if (localAsset && remoteAsset && localAsset.id !== remoteAsset.id) {
          throw new Error('transcript recording asset identity is inconsistent');
        }
        const resolvedAsset = localAsset ?? remoteAsset ?? (!localAssetId && !remoteAssetId ? soleAsset : null);
        return {
          ordinal,
          sourceId: typeof line.id === 'string' ? line.id.trim() : '',
          sourceRecordingAssetId: resolvedAsset?.id ?? localAssetId,
          sourceRecordingAssetRemoteId: remoteAssetId ?? resolvedAsset?.remoteAssetId ?? null,
          sourceTranscriptionJobId: optionalTranscriptIdentity(
            line.transcription_job_id ?? line.transcriptionJobId,
            'transcript source job ID',
          ),
          speakerId: line.speaker_id?.trim() || null,
          speakerLabel: line.speaker_label?.trim() || null,
          text: typeof line.text === 'string' ? line.text : '',
          startMs: secondsToMs(line.start_time),
          endMs: Math.max(secondsToMs(line.start_time), secondsToMs(line.end_time)),
          confidence: Number.isFinite(line.confidence)
            && Number(line.confidence) >= 0 && Number(line.confidence) <= 1
            ? Number(line.confidence)
            : null,
          createdAtMs: timestamp(line.created_at, aggregate.note.createdAtMs),
        };
      });
      const fingerprint = await sha256(normalizedLines);
      const derivedKind: TranscriptCandidateKind = legacyMeeting.status === 'recording'
        || legacyMeeting.status === 'paused'
        ? 'realtime_draft'
        : 'final';
      const requestedKind = options.candidateKind ?? derivedKind;
      const revisionKind: TranscriptCandidateKind = options.serverCompleteness === 'incomplete'
        && requestedKind === 'final'
        ? 'realtime_draft'
        : requestedKind;
      const realtimeDraft = revisionKind === 'realtime_draft';
      const revisionId = realtimeDraft
        ? `${aggregate.note.id}:transcript:legacy-live`
        : revisionKind === 'reprocessed'
          ? `${aggregate.note.id}:transcript:legacy-reprocessed:${fingerprint}`
          : `${aggregate.note.id}:transcript:legacy-final:${fingerprint}`;
      const createdAtMs = normalizedLines.reduce(
        (minimum, line) => Math.min(minimum, line.createdAtMs),
        normalizedLines[0]?.createdAtMs ?? aggregate.note.createdAtMs,
      );
      const finalizedAtMs = realtimeDraft
        ? null
        : normalizedLines.reduce(
          (maximum, line) => Math.max(maximum, line.createdAtMs),
          aggregate.note.endedAtMs ?? aggregate.note.createdAtMs,
        );
      const segmentFingerprints = await Promise.all(normalizedLines.map(line => sha256(line)));
      const segments: TranscriptSegmentRecord[] = normalizedLines.map((line, ordinal) => ({
        id: `${revisionId}:segment:${ordinal}:${segmentFingerprints[ordinal]}`,
        meetingId: aggregate.note.id,
        sourceId: line.sourceId || null,
        sourceRecordingAssetId: line.sourceRecordingAssetId,
        sourceRecordingAssetRemoteId: line.sourceRecordingAssetRemoteId,
        sourceTranscriptionJobId: line.sourceTranscriptionJobId,
        ordinal,
        startMs: line.startMs,
        endMs: line.endMs,
        speakerClusterId: line.speakerId,
        speakerProfileId: null,
        speakerLabel: line.speakerLabel,
        speakerLabelOverride: null,
        text: line.text,
        normalizedText: normalizeTranscriptText(line.text),
        confidence: line.confidence,
        isFinal: !realtimeDraft,
        createdAtMs: line.createdAtMs,
      }));
      const auditState: {
        writeStatus: string;
        activationDecision?: ReturnType<typeof evaluateTranscriptCandidate>;
      } = { writeStatus: 'completed' };
      await sqliteMeetingNoteRepository.transaction(async transaction => {
        const note = await transaction.getMeeting(aggregate.note.id, scopeKey);
        if (!note || note.lifecycle === 'deleted') return;
        const currentContent = await transaction.getActiveTranscriptContent(note.id, scopeKey);
        const current = currentContent?.revision ?? null;
        const preservedCanonical = Boolean(current && !isLegacyProvider(current.sourceProvider));
        const activationDecision = evaluateTranscriptCandidate(
          currentContent?.segments ?? [],
          segments,
          {
            candidateKind: revisionKind,
            serverCompleteness: options.serverCompleteness,
          },
        );
        auditState.activationDecision = activationDecision;
        const activate = !preservedCanonical && activationDecision.useCandidate;
        const revision: TranscriptRevisionRecord = {
          id: revisionId,
          meetingId: note.id,
          remoteId: options.remoteRevisionId?.trim() || null,
          kind: revisionKind,
          status: realtimeDraft ? 'realtime_draft' : 'ready',
          sourceProvider: 'legacy-cache',
          sourceModel: null,
          isActive: activate,
          createdAtMs,
          finalizedAtMs,
        };
        const replacingActiveDraftWithShorterCandidate = Boolean(
          current?.id === revisionId && realtimeDraft && !activationDecision.useCandidate,
        );
        if (!replacingActiveDraftWithShorterCandidate) {
          await transaction.saveTranscriptRevision(revision, segments, scopeKey, {
            activate,
            replaceSegments: realtimeDraft,
          });
        }
        const stage = await transaction.getStage(note.id, scopeKey, 'transcript');
        if (!stage) throw new Error('meeting transcript processing stage is missing');
        if (!preservedCanonical) {
          const nowMs = Math.max(Date.now(), stage.updatedAtMs, note.updatedAtMs);
          const stageStatus = activate
            ? realtimeDraft
              ? options.serverCompleteness === 'incomplete'
                && legacyMeeting.status !== 'recording'
                && legacyMeeting.status !== 'paused'
                ? 'finalizing'
                : 'realtime_draft'
              : 'ready'
            : 'finalizing';
          await transaction.upsertStage(transitionProcessingStage(stage, {
            stage: 'transcript',
            status: stageStatus,
            progress: stageStatus === 'ready' ? 1 : null,
            inputFingerprint: `sha256:${fingerprint}`,
          }, nowMs), scopeKey);
        }
        auditState.writeStatus = preservedCanonical
          ? 'preserved_canonical'
          : activate
            ? 'completed'
            : activationDecision.reason === 'candidate_clearly_shorter'
              ? 'preserved_more_complete_active'
              : 'saved_inactive';
      });
      const activationDecision = auditState.activationDecision;
      diagnosticAudit('meeting_transcript_shadow_write', {
        status: auditState.writeStatus,
        scope: scopeKey === 'guest' ? 'guest' : 'account',
        segments: segments.length,
        revision_kind: revisionKind,
        completeness: options.serverCompleteness ?? 'unknown',
        baseline_latest_ms: activationDecision?.baseline.latestTimeMs ?? 0,
        candidate_latest_ms: activationDecision?.candidate.latestTimeMs ?? 0,
        baseline_text: activationDecision?.baseline.textCodePoints ?? 0,
        candidate_text: activationDecision?.candidate.textCodePoints ?? 0,
        regression_signals: activationDecision?.regressionSignals.join(',') ?? '',
      });
    } catch (error) {
      reportFailure('transcript', scopeKey, error);
    }
  });
}

export function mirrorLegacySummaryContent(
  scopeKey: ScopeKey,
  legacyMeeting: Meeting,
  summary: MeetingSummary | null,
  options: MirrorLegacySummaryOptions = {},
): Promise<SummaryMirrorResult> {
  if (!getFeatureFlags().localMeetingDbV1) {
    return Promise.resolve({
      replaceLegacyProjection: true,
      status: 'canonical_disabled',
      canonicalRevision: null,
    });
  }
  return enqueueMeetingWrite(scopeKey, legacyMeeting.id, async () => {
    let canonicalRevision: number | null = null;
    try {
      const normalized = summary ? normalizeMeetingSummaryResult(legacyMeeting.id, summary) : null;
      const document = normalized?.structured_document
        ?? (normalized ? legacyMeetingSummaryToDocument(legacyMeeting.id, normalized) : null);
      if (!normalized || !document || !meetingSummaryToText(normalized)) {
        const aggregate = await sqliteMeetingNoteRepository.findByNativeSessionId(legacyMeeting.id, scopeKey);
        if (options.expectedCanonicalMeetingId && aggregate?.note.id !== options.expectedCanonicalMeetingId) {
          throw new Error('summary canonical meeting identity changed');
        }
        let status = 'unchanged_empty';
        if (aggregate && aggregate.note.lifecycle !== 'deleted') {
          await sqliteMeetingNoteRepository.transaction(async transaction => {
            const note = await transaction.getMeeting(aggregate.note.id, scopeKey);
            if (!note || note.lifecycle === 'deleted') return;
            const current = await transaction.getCurrentSummaryVersion(note.id, scopeKey);
            if (!current) return;
            const currentProtected = await transaction.hasUserProtectedSummaryState(current.id, scopeKey);
            if (!isLegacyProvider(current.generatedBy) || currentProtected) {
              status = 'preserved_canonical';
              return;
            }
            const stage = await transaction.getStage(note.id, scopeKey, 'summary');
            if (!stage) throw new Error('meeting summary processing stage is missing');
            const nowMs = Math.max(Date.now(), stage.updatedAtMs, note.updatedAtMs);
            await transaction.updateMeeting(note.id, scopeKey, {
              currentSummaryVersionId: null,
              updatedAtMs: nowMs,
            });
            await transaction.upsertStage(transitionProcessingStage(stage, {
              stage: 'summary',
              status: 'none',
              progress: null,
              inputFingerprint: null,
            }, nowMs), scopeKey);
            if (options.canonicalWrite) {
              canonicalRevision = await transaction.advanceCanonicalWrite(scopeKey, nowMs);
            }
            status = 'cleared_legacy_projection';
          });
        }
        diagnosticAudit('meeting_summary_shadow_write', {
          status,
          scope: scopeKey === 'guest' ? 'guest' : 'account',
          sections: 0,
          actions: 0,
        });
        return {
          replaceLegacyProjection: status !== 'preserved_canonical',
          status,
          canonicalRevision,
        };
      }
      const aggregate = await sqliteMeetingNoteRepository.findByNativeSessionId(legacyMeeting.id, scopeKey);
      if (options.expectedCanonicalMeetingId && aggregate?.note.id !== options.expectedCanonicalMeetingId) {
        throw new Error('summary canonical meeting identity changed');
      }
      if (!aggregate || aggregate.note.lifecycle === 'deleted') {
        return {
          replaceLegacyProjection: true,
          status: 'canonical_meeting_unavailable',
          canonicalRevision: null,
        };
      }
      const sourceTranscriptContent = await sqliteMeetingNoteRepository.getActiveTranscriptContent(
        aggregate.note.id,
        scopeKey,
      );
      const sourceTranscript = sourceTranscriptContent?.revision ?? null;
      if (options.canonicalWrite && sourceTranscript?.kind === 'realtime_draft') {
        throw new Error('summary requires a stable canonical transcript revision');
      }
      const declaredTranscriptRevisionId = document.transcriptRevisionId?.trim() || null;
      if (
        options.canonicalWrite
        && declaredTranscriptRevisionId
        && declaredTranscriptRevisionId !== sourceTranscript?.id
        && declaredTranscriptRevisionId !== sourceTranscript?.remoteId
      ) {
        throw new Error('summary transcript revision is not the active canonical revision');
      }
      const generatedAtMs = document.completedAtMs || timestamp(summary?.generated_at, aggregate.note.createdAtMs);
      const summaryPayload = {
        remoteVersionId: document.remoteVersionId,
        templateId: document.templateId,
        templateRevision: document.templateRevision,
        transcriptRevisionId: sourceTranscript?.id ?? null,
        manualNoteRevision: document.templateId === 'legacy'
          ? aggregate.manualNote.revision
          : document.manualNoteRevision,
        scheduleSnapshotHash: document.scheduleSnapshotHash,
        generatedAtMs,
        sections: document.sections.map(section => ({
          stableKey: section.stableKey,
          kind: section.kind,
          title: section.title,
          content: section.content,
          citations: section.citations,
        })),
        actions: document.actionItemCandidates.map(item => ({
          remoteId: item.id,
          content: item.content.trim(),
          assignee: item.assignee?.trim() || null,
          dueAtMs: item.dueAtMs,
          status: legacyActionStatus(item.status),
          citations: item.citations,
        })).filter(item => item.content),
      };
      if (summaryPayload.sections.length === 0 && summaryPayload.actions.length > 0) {
        summaryPayload.sections.push({
          stableKey: 'action_items',
          kind: 'action_items',
          title: '待办事项',
          content: summaryPayload.actions.map(item => item.content).join('\n'),
          citations: [],
        });
      }
      const fingerprintPayload = {
        ...summaryPayload,
        sections: summaryPayload.sections.map(section => ({
          ...section,
          citations: section.citations.map(({ id: _id, ...citation }) => citation),
        })),
        actions: summaryPayload.actions.map(({ remoteId: _remoteId, ...action }) => ({
          ...action,
          citations: action.citations.map(({ id: _id, ...citation }) => citation),
        })),
      };
      const fingerprint = await sha256(fingerprintPayload);
      const versionId = `${aggregate.note.id}:summary:${document.templateId}:${fingerprint}`;
      const sectionFingerprints = await Promise.all(fingerprintPayload.sections.map(section => sha256(section)));
      const sections: SummarySectionRecord[] = summaryPayload.sections.map((section, ordinal) => ({
        id: `${versionId}:section:${ordinal}:${sectionFingerprints[ordinal]}`,
        versionId,
        stableKey: section.stableKey,
        kind: section.kind,
        title: section.title,
        generatedText: section.content,
        userText: null,
        ordinal,
        userEditedAtMs: null,
      }));
      const segmentBySourceId = new Map<string, TranscriptSegmentRecord>();
      sourceTranscriptContent?.segments.forEach(segment => {
        segmentBySourceId.set(segment.id, segment);
        if (segment.sourceId) segmentBySourceId.set(segment.sourceId, segment);
      });
      let rejectedCitationCount = 0;
      const citations: SummaryCitationRecord[] = [];
      summaryPayload.sections.forEach((section, sectionOrdinal) => {
        const sectionRecord = sections[sectionOrdinal];
        let citationOrdinal = 0;
        section.citations.forEach(citation => {
          const segment = segmentBySourceId.get(citation.segmentId);
          const segmentEndMs = segment ? Math.max(segment.startMs, segment.endMs) : -1;
          if (
            !segment
            || !sourceTranscript
            || citation.startMs < segment.startMs
            || citation.endMs < citation.startMs
            || citation.endMs > segmentEndMs
          ) {
            rejectedCitationCount += 1;
            return;
          }
          citations.push({
            id: `${sectionRecord.id}:citation:${citationOrdinal}:${segment.id}`,
            sectionId: sectionRecord.id,
            segmentId: segment.id,
            sourceSegmentId: segment.sourceId,
            startMs: citation.startMs,
            endMs: citation.endMs,
            quoteHash: citation.quoteHash,
            ordinal: citationOrdinal,
          });
          citationOrdinal += 1;
        });
      });
      const actionFingerprints = await Promise.all(summaryPayload.actions.map(action => sha256({
        templateKey: document.templateId,
        content: normalizedActionIdentityText(action.content),
        assignee: normalizedActionIdentityText(action.assignee),
        dueAtMs: action.dueAtMs,
        sourceSegmentIds: [...new Set(action.citations.map(citation => citation.segmentId))].sort(),
      })));
      const actions: ActionItemRecord[] = summaryPayload.actions.map((action, ordinal) => {
        const sourceCitation = action.citations
          .map(citation => {
            const segment = segmentBySourceId.get(citation.segmentId);
            const segmentEndMs = segment ? Math.max(segment.startMs, segment.endMs) : -1;
            const valid = Boolean(
              segment
              && citation.startMs >= segment.startMs
              && citation.endMs >= citation.startMs
              && citation.endMs <= segmentEndMs,
            );
            return { citation, segment, valid };
          })
          .find(candidate => candidate.valid);
        return {
          id: `${aggregate.note.id}:action:generated:${actionFingerprints[ordinal]}`,
          meetingId: aggregate.note.id,
          remoteId: action.remoteId,
          remoteRevision: null,
          content: action.content,
          status: action.status,
          assigneeText: action.assignee,
          dueAtMs: action.dueAtMs,
          reminderAtMs: null,
          reminderNotificationId: null,
          followupEventSourceId: null,
          sourceKind: 'generated',
          sourceMarkerId: null,
          sourceSummaryVersionId: versionId,
          sourceSegmentId: sourceCitation?.segment?.id ?? null,
          sourceStartMs: sourceCitation?.citation.startMs ?? null,
          generationFingerprint: `sha256:${actionFingerprints[ordinal]}`,
          userEditedAtMs: null,
          completedAtMs: action.status === 'completed' ? generatedAtMs : null,
          createdAtMs: generatedAtMs,
          updatedAtMs: generatedAtMs,
        };
      });
      let replaceLegacyProjection = true;
      let mirrorStatus = 'completed';
      await sqliteMeetingNoteRepository.transaction(async transaction => {
        const note = await transaction.getMeeting(aggregate.note.id, scopeKey);
        if (!note || note.lifecycle === 'deleted') {
          if (options.expectedCanonicalMeetingId) {
            throw new Error('summary canonical meeting became unavailable');
          }
          mirrorStatus = 'canonical_meeting_unavailable';
          return;
        }
        const current = await transaction.getCurrentSummaryVersion(note.id, scopeKey);
        const existingVersion = await transaction.getSummaryVersion(versionId, scopeKey);
        const activeTranscript = await transaction.getActiveTranscriptRevision(note.id, scopeKey);
        const sourceTranscriptStillActive = (sourceTranscript?.id ?? null) === (activeTranscript?.id ?? null);
        const currentProtected = current
          ? await transaction.hasUserProtectedSummaryState(current.id, scopeKey)
          : false;
        if (existingVersion) {
          const remainsCurrent = current?.id === versionId;
          replaceLegacyProjection = remainsCurrent && !currentProtected;
          mirrorStatus = remainsCurrent ? 'unchanged' : 'preserved_existing_candidate';
          return;
        }
        const incomingLegacyCanReplace = document.templateId !== 'legacy'
          || !current
          || isLegacyProvider(current.generatedBy);
        const activate = sourceTranscriptStillActive && (
          !current
          || current.id === versionId
          || (incomingLegacyCanReplace && !currentProtected)
        );
        replaceLegacyProjection = activate && !currentProtected;
        mirrorStatus = !sourceTranscriptStillActive
          ? 'saved_stale_input_candidate'
          : activate
            ? currentProtected ? 'preserved_user_projection' : 'activated'
            : 'saved_candidate';
        const newVersion: SummaryVersionRecord = {
          id: versionId,
          meetingId: note.id,
          templateId: document.templateId,
          templateRevision: document.templateRevision,
          inputFingerprint: `sha256:${fingerprint}`,
          transcriptRevisionId: sourceTranscript?.id ?? null,
          manualNoteRevision: summaryPayload.manualNoteRevision,
          scheduleSnapshotHash: summaryPayload.scheduleSnapshotHash,
          status: document.status,
          generatedBy: document.templateId === 'legacy'
            ? 'legacy-cache'
            : document.generatedBy ?? 'server-v2',
          userEdited: false,
          supersedesVersionId: current && current.id !== versionId
            ? current.id
            : null,
          createdAtMs: document.createdAtMs,
          completedAtMs: generatedAtMs,
        };
        await transaction.saveSummaryVersion(newVersion, sections, actions, scopeKey, { activate, citations });
        const stage = await transaction.getStage(note.id, scopeKey, 'summary');
        if (!stage) throw new Error('meeting summary processing stage is missing');
        const nowMs = Math.max(Date.now(), generatedAtMs, stage.updatedAtMs, note.updatedAtMs);
        const retainedStatus = current?.status === 'stale'
          ? 'stale'
          : current
            ? 'ready'
            : 'none';
        await transaction.upsertStage(transitionProcessingStage(stage, {
          stage: 'summary',
          status: activate ? document.status : retainedStatus,
          progress: activate || current ? 1 : null,
          inputFingerprint: activate ? `sha256:${fingerprint}` : stage.inputFingerprint,
        }, nowMs), scopeKey);
        if (options.canonicalWrite) {
          canonicalRevision = await transaction.advanceCanonicalWrite(scopeKey, nowMs);
        }
      });
      diagnosticAudit('meeting_summary_shadow_write', {
        status: mirrorStatus,
        scope: scopeKey === 'guest' ? 'guest' : 'account',
        sections: sections.length,
        citations: citations.length,
        rejected_citations: rejectedCitationCount,
        actions: actions.length,
      });
      return { replaceLegacyProjection, status: mirrorStatus, canonicalRevision };
    } catch (error) {
      reportFailure('summary', scopeKey, error);
      if (options.throwOnFailure) throw error;
      return { replaceLegacyProjection: true, status: 'failed', canonicalRevision: null };
    }
  });
}
