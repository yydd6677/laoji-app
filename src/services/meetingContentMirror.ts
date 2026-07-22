import * as Crypto from 'expo-crypto';
import type { Meeting, MeetingSummary, TranscriptLine } from '../types';
import type {
  ActionItemRecord,
  SummarySectionRecord,
  SummaryVersionRecord,
  TranscriptRevisionRecord,
  TranscriptSegmentRecord,
} from '../data/repositories';
import { sqliteMeetingNoteRepository } from '../data/repositories';
import type { ScopeKey } from '../domain/meeting';
import { transitionProcessingStage } from '../domain/meeting';
import { getFeatureFlags } from '../config/featureFlags';
import { meetingSummaryToText, normalizeMeetingSummaryResult } from './meetingSummaryFormat';
import { diagnosticAudit, diagnosticWarn } from './diagnostics';

const writeTailByMeeting = new Map<string, Promise<void>>();

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

function enqueueMeetingWrite(scopeKey: ScopeKey, meetingId: string, operation: () => Promise<void>): Promise<void> {
  const key = `${scopeKey}\u0000${meetingId}`;
  const previous = writeTailByMeeting.get(key) ?? Promise.resolve();
  const next = previous.catch(() => undefined).then(operation);
  writeTailByMeeting.set(key, next);
  void next.finally(() => {
    if (writeTailByMeeting.get(key) === next) writeTailByMeeting.delete(key);
  }).catch(() => undefined);
  return next;
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

function reportFailure(kind: 'transcript' | 'summary', scopeKey: ScopeKey, error: unknown): void {
  diagnosticWarn(`[meeting-db] ${kind} shadow write failed`, error);
  diagnosticAudit(`meeting_${kind}_shadow_write`, {
    status: 'failed',
    scope: scopeKey === 'guest' ? 'guest' : 'account',
    error_code: error instanceof Error ? error.name : 'UnknownError',
  });
}

export function mirrorLegacyTranscriptContent(
  scopeKey: ScopeKey,
  legacyMeeting: Meeting,
  transcript: readonly TranscriptLine[],
): Promise<void> {
  if (!getFeatureFlags().localMeetingDbV1) return Promise.resolve();
  return enqueueMeetingWrite(scopeKey, legacyMeeting.id, async () => {
    try {
      if (transcript.length === 0) {
        diagnosticAudit('meeting_transcript_shadow_write', {
          status: 'skipped_empty',
          scope: scopeKey === 'guest' ? 'guest' : 'account',
          segments: 0,
        });
        return;
      }
      const aggregate = await sqliteMeetingNoteRepository.findByNativeSessionId(legacyMeeting.id, scopeKey);
      if (!aggregate || aggregate.note.lifecycle === 'deleted') return;
      const normalizedLines = transcript.map((line, ordinal) => ({
        ordinal,
        sourceId: typeof line.id === 'string' ? line.id.trim() : '',
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
      }));
      const fingerprint = await sha256(normalizedLines);
      const realtimeDraft = legacyMeeting.status === 'recording' || legacyMeeting.status === 'paused';
      const revisionId = realtimeDraft
        ? `${aggregate.note.id}:transcript:legacy-live`
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
        ordinal,
        startMs: line.startMs,
        endMs: line.endMs,
        speakerClusterId: line.speakerId,
        speakerProfileId: null,
        speakerLabel: line.speakerLabel,
        text: line.text,
        normalizedText: normalizeTranscriptText(line.text),
        confidence: line.confidence,
        isFinal: !realtimeDraft,
        createdAtMs: line.createdAtMs,
      }));
      await sqliteMeetingNoteRepository.transaction(async transaction => {
        const note = await transaction.getMeeting(aggregate.note.id, scopeKey);
        if (!note || note.lifecycle === 'deleted') return;
        const current = await transaction.getActiveTranscriptRevision(note.id, scopeKey);
        const activate = !current || current.id === revisionId || isLegacyProvider(current.sourceProvider);
        const revision: TranscriptRevisionRecord = {
          id: revisionId,
          meetingId: note.id,
          kind: realtimeDraft ? 'realtime_draft' : 'final',
          status: realtimeDraft ? 'realtime_draft' : 'ready',
          sourceProvider: 'legacy-cache',
          sourceModel: null,
          isActive: activate,
          createdAtMs,
          finalizedAtMs,
        };
        await transaction.saveTranscriptRevision(revision, segments, scopeKey, {
          activate,
          replaceSegments: realtimeDraft,
        });
        const stage = await transaction.getStage(note.id, scopeKey, 'transcript');
        if (!stage) throw new Error('meeting transcript processing stage is missing');
        const nowMs = Math.max(Date.now(), stage.updatedAtMs, note.updatedAtMs);
        await transaction.upsertStage(transitionProcessingStage(stage, {
          stage: 'transcript',
          status: realtimeDraft ? 'realtime_draft' : 'ready',
          progress: realtimeDraft ? null : 1,
          inputFingerprint: `sha256:${fingerprint}`,
        }, nowMs), scopeKey);
      });
      diagnosticAudit('meeting_transcript_shadow_write', {
        status: 'completed',
        scope: scopeKey === 'guest' ? 'guest' : 'account',
        segments: segments.length,
        revision_kind: realtimeDraft ? 'draft' : 'final',
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
): Promise<void> {
  if (!getFeatureFlags().localMeetingDbV1) return Promise.resolve();
  return enqueueMeetingWrite(scopeKey, legacyMeeting.id, async () => {
    try {
      const normalized = summary ? normalizeMeetingSummaryResult(legacyMeeting.id, summary) : null;
      if (!normalized || !meetingSummaryToText(normalized)) {
        diagnosticAudit('meeting_summary_shadow_write', {
          status: 'skipped_empty',
          scope: scopeKey === 'guest' ? 'guest' : 'account',
          sections: 0,
          actions: 0,
        });
        return;
      }
      const aggregate = await sqliteMeetingNoteRepository.findByNativeSessionId(legacyMeeting.id, scopeKey);
      if (!aggregate || aggregate.note.lifecycle === 'deleted') return;
      const sourceTranscript = await sqliteMeetingNoteRepository.getActiveTranscriptRevision(
        aggregate.note.id,
        scopeKey,
      );
      const generatedAtMs = timestamp(summary?.generated_at, aggregate.note.createdAtMs);
      const summaryPayload = {
        transcriptRevisionId: sourceTranscript?.id ?? null,
        manualNoteRevision: aggregate.manualNote.revision,
        generatedAtMs,
        overview: normalized.overview?.trim() || '',
        decisions: (normalized.key_decisions ?? []).map(item => item.trim()).filter(Boolean),
        actions: (normalized.action_items ?? []).map(item => ({
          content: item.content.trim(),
          assignee: item.assignee?.trim() || null,
          dueDate: item.due_date?.trim() || null,
          status: legacyActionStatus(item.status),
        })).filter(item => item.content),
      };
      const fingerprint = await sha256(summaryPayload);
      const versionId = `${aggregate.note.id}:summary:legacy:${fingerprint}`;
      const sections: SummarySectionRecord[] = [];
      if (summaryPayload.overview) {
        sections.push({
          id: `${versionId}:section:overview`,
          versionId,
          stableKey: 'overview',
          kind: 'paragraph',
          title: '会议概述',
          generatedText: summaryPayload.overview,
          userText: null,
          ordinal: sections.length,
          userEditedAtMs: null,
        });
      }
      if (summaryPayload.decisions.length > 0) {
        sections.push({
          id: `${versionId}:section:decisions`,
          versionId,
          stableKey: 'decisions',
          kind: 'bullets',
          title: '关键决定',
          generatedText: summaryPayload.decisions.join('\n'),
          userText: null,
          ordinal: sections.length,
          userEditedAtMs: null,
        });
      }
      if (summaryPayload.actions.length > 0) {
        sections.push({
          id: `${versionId}:section:action_items`,
          versionId,
          stableKey: 'action_items',
          kind: 'action_items',
          title: '待办事项',
          generatedText: summaryPayload.actions.map(item => item.content).join('\n'),
          userText: null,
          ordinal: sections.length,
          userEditedAtMs: null,
        });
      }
      const actionFingerprints = await Promise.all(summaryPayload.actions.map(action => sha256(action)));
      const actions: ActionItemRecord[] = summaryPayload.actions.map((action, ordinal) => {
        const dueAtMs = timestamp(action.dueDate, 0) || null;
        return {
          id: `${aggregate.note.id}:action:legacy:${actionFingerprints[ordinal]}`,
          meetingId: aggregate.note.id,
          remoteId: null,
          content: action.content,
          status: action.status,
          assigneeText: action.assignee,
          dueAtMs,
          sourceKind: 'generated',
          sourceSummaryVersionId: versionId,
          sourceSegmentId: null,
          sourceStartMs: null,
          generationFingerprint: `sha256:${actionFingerprints[ordinal]}`,
          userEditedAtMs: null,
          completedAtMs: action.status === 'completed' ? generatedAtMs : null,
          createdAtMs: generatedAtMs,
          updatedAtMs: generatedAtMs,
        };
      });
      await sqliteMeetingNoteRepository.transaction(async transaction => {
        const note = await transaction.getMeeting(aggregate.note.id, scopeKey);
        if (!note || note.lifecycle === 'deleted') return;
        const current = await transaction.getCurrentSummaryVersion(note.id, scopeKey);
        const activate = !current || current.id === versionId
          || (!current.userEdited && isLegacyProvider(current.generatedBy));
        const version: SummaryVersionRecord = {
          id: versionId,
          meetingId: note.id,
          templateId: 'legacy',
          templateRevision: 1,
          inputFingerprint: `sha256:${fingerprint}`,
          transcriptRevisionId: sourceTranscript?.id ?? null,
          manualNoteRevision: aggregate.manualNote.revision,
          scheduleSnapshotHash: null,
          status: 'ready',
          generatedBy: 'legacy-cache',
          userEdited: false,
          supersedesVersionId: current && current.id !== versionId && isLegacyProvider(current.generatedBy)
            ? current.id
            : null,
          createdAtMs: generatedAtMs,
          completedAtMs: generatedAtMs,
        };
        await transaction.saveSummaryVersion(version, sections, actions, scopeKey, { activate });
        const stage = await transaction.getStage(note.id, scopeKey, 'summary');
        if (!stage) throw new Error('meeting summary processing stage is missing');
        const nowMs = Math.max(Date.now(), stage.updatedAtMs, note.updatedAtMs);
        await transaction.upsertStage(transitionProcessingStage(stage, {
          stage: 'summary',
          status: 'ready',
          progress: 1,
          inputFingerprint: `sha256:${fingerprint}`,
        }, nowMs), scopeKey);
      });
      diagnosticAudit('meeting_summary_shadow_write', {
        status: 'completed',
        scope: scopeKey === 'guest' ? 'guest' : 'account',
        sections: sections.length,
        actions: actions.length,
      });
    } catch (error) {
      reportFailure('summary', scopeKey, error);
    }
  });
}
