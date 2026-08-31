import * as Crypto from 'expo-crypto';
import type { Meeting, MeetingSummary } from '../types';
import type { ActionItemRecord, SummaryFactDocumentRecord, SummaryCitationRecord, SummarySectionRecord, SummaryVersionRecord, TranscriptSegmentRecord } from "../data/repositories/meetingNoteRepository";
import { sqliteMeetingNoteRepository } from "../data/repositories/sqliteMeetingNoteRepository";
import type { ScopeKey } from '../domain/meeting';
import { transitionProcessingStage } from '../domain/meeting/processing';
import { meetingSummaryToText, normalizeMeetingSummaryResult } from './meetingSummaryFormat';
import { meetingFactsResultV3ToWire } from './meetingSummaryV3';
import { diagnosticAudit, diagnosticWarn } from './diagnostics';

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

export interface MeetingSummaryPersistResult {
  /** Whether the compatibility cache may replace its currently readable projection. */
  replaceProjection: boolean;
  status: string;
  canonicalRevision: number | null;
  /** Local immutable identity corresponding to the provider version, when materialized. */
  localVersionId?: string | null;
}

export interface PersistMeetingSummaryFactsOptions {
  expectedCanonicalMeetingId?: string;
  canonicalWrite?: boolean;
  throwOnFailure?: boolean;
  /**
   * A catalog pull replays immutable versions that are not necessarily the
   * task currently being watched by the detail page.  Such replay must not
   * close a live task; a directly completed generation keeps the default.
   */
  settleProcessingStage?: boolean;
}

function summaryActionStatus(value: string | undefined): ActionItemRecord['status'] {
  const normalized = value?.trim().toLowerCase();
  if (['completed', 'complete', 'done'].includes(normalized ?? '')) return 'completed';
  if (['dismissed', 'cancelled', 'canceled'].includes(normalized ?? '')) return 'dismissed';
  return 'pending';
}

function normalizedActionIdentityText(value: string | null): string {
  return (value ?? '').normalize('NFKC').trim().replace(/\s+/g, ' ');
}

function reportFailure(error: unknown): void {
  diagnosticWarn('[meeting-db] summary write failed', error);
  diagnosticAudit('meeting_summary_write', {
    status: 'failed',
    scope: 'guest',
    error_code: error instanceof Error ? error.name : 'UnknownError',
  });
}

export function persistMeetingSummaryFacts(
  scopeKey: ScopeKey,
  meeting: Meeting,
  summary: MeetingSummary,
  options: PersistMeetingSummaryFactsOptions = {},
): Promise<MeetingSummaryPersistResult> {
  return enqueueMeetingWrite(scopeKey, meeting.id, async () => {
    let canonicalRevision: number | null = null;
    try {
      const normalized = normalizeMeetingSummaryResult(meeting.id, summary);
      const factsResult = summary.facts_document_v3 ?? null;
      const activationFenceV3 = summary.activation_fence_v3;
      const document = normalized?.structured_document ?? null;
      if (
        !normalized
        || !document
        || !factsResult
        || !meetingSummaryToText(normalized)
        || document.templateId !== 'general'
        || document.templateRevision !== 3
      ) {
        throw new Error('summary facts v3 payload is required');
      }
      const aggregate = await sqliteMeetingNoteRepository.findByNativeSessionId(meeting.id, scopeKey);
      if (options.expectedCanonicalMeetingId && aggregate?.note.id !== options.expectedCanonicalMeetingId) {
        throw new Error('summary canonical meeting identity changed');
      }
      if (!aggregate || aggregate.note.lifecycle === 'deleted') {
        return {
          replaceProjection: true,
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
      const generatedAtMs = document.completedAtMs || timestamp(summary.generated_at, aggregate.note.createdAtMs);
      const summaryPayload = {
        remoteVersionId: document.remoteVersionId,
        templateId: document.templateId,
        templateRevision: document.templateRevision,
        transcriptRevisionId: sourceTranscript?.id ?? null,
        manualNoteRevision: document.manualNoteRevision,
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
          status: summaryActionStatus(item.status),
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
      if (
        document.remoteVersionId !== factsResult.documentId
        || document.scheduleSnapshotHash !== factsResult.sourceFingerprint
        || document.remoteTranscriptRevisionId !== factsResult.transcriptRevision
      ) throw new Error('summary fact document does not match its projected version');
      const wire = meetingFactsResultV3ToWire(factsResult);
      const factGeneratedAtMs = Date.parse(factsResult.generatedAt);
      if (!Number.isFinite(factGeneratedAtMs)) throw new Error('summary fact generation time is invalid');
      const factDocument: SummaryFactDocumentRecord = {
        id: factsResult.documentId,
        meetingId: aggregate.note.id,
        summaryVersionId: versionId,
        sourceFingerprint: factsResult.sourceFingerprint,
        transcriptRevision: factsResult.transcriptRevision,
        modelRevision: factsResult.modelRevision,
        promptRevision: factsResult.promptRevision,
        documentJson: JSON.stringify(wire),
        coverageJson: JSON.stringify(wire.coverage),
        generatedAtMs: factGeneratedAtMs,
        createdAtMs: Date.now(),
      };
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
            userRemovedAtMs: null,
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
      let replaceProjection = true;
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
        const activeManualNote = await transaction.getManualNote(note.id, scopeKey);
        const sourceTranscriptStillActive = (sourceTranscript?.id ?? null) === (activeTranscript?.id ?? null);
        const sourceManualNoteStillActive = activeManualNote?.revision === summaryPayload.manualNoteRevision;
        const sourceInputsStillActive = sourceTranscriptStillActive && sourceManualNoteStillActive;
        const currentProtected = current
          ? await transaction.hasUserProtectedSummaryState(current.id, scopeKey)
          : false;
        let canonicalChanged = false;

        // A summary task can finish after the detail page has been unmounted.
        // Its immutable version may already exist (for example, a repeated
        // regeneration with the same input), so there is no INSERT to trigger
        // the usual terminal-stage write below.  Always close the durable
        // processing stage from the version/pointer that is actually readable;
        // otherwise the list keeps saying "正在整理" while the detail page
        // displays a completed result, or the next open starts a duplicate
        // recovery run.
        const reconcileSummaryStage = async (
          targetStatus: 'none' | 'ready' | 'stale',
          inputFingerprint: string | null,
          updatedAtHint: number,
        ) => {
          const stage = await transaction.getStage(note.id, scopeKey, 'summary');
          if (!stage) throw new Error('meeting summary processing stage is missing');
          if (options.settleProcessingStage === false) return;
          const nowMs = Math.max(
            Date.now(),
            updatedAtHint,
            stage.updatedAtMs,
            note.updatedAtMs,
          );
          const next = transitionProcessingStage(stage, {
            stage: 'summary',
            status: targetStatus,
            progress: targetStatus === 'ready' ? 1 : null,
            jobId: null,
            inputFingerprint,
          }, nowMs);
          const changed = next.status !== stage.status
            || next.progress !== stage.progress
            || next.jobId !== stage.jobId
            || next.inputFingerprint !== stage.inputFingerprint
            || next.errorCode !== stage.errorCode
            || next.userMessageKey !== stage.userMessageKey
            || next.retryable !== stage.retryable
            || next.nextRetryAtMs !== stage.nextRetryAtMs;
          if (!changed) return;
          await transaction.upsertStage(next, scopeKey);
          await transaction.updateMeeting(note.id, scopeKey, { updatedAtMs: nowMs });
          canonicalChanged = true;
        };

        const currentSummaryStatus = (): 'none' | 'ready' | 'stale' => (
          current?.status === 'stale'
            ? 'stale'
            : current?.status === 'ready'
              ? 'ready'
              : 'none'
        );
        let currentMatchesUndeclaredSource = false;
        if (current && !declaredTranscriptRevisionId) {
          const currentSourceFingerprint = await sha256({
            ...fingerprintPayload,
            transcriptRevisionId: current.transcriptRevisionId,
          });
          currentMatchesUndeclaredSource = current.id
            === `${note.id}:summary:${document.templateId}:${currentSourceFingerprint}`;
        }
        if (current && currentMatchesUndeclaredSource) {
          await transaction.saveSummaryVersion(current, sections, actions, scopeKey, {
            activate: false,
            citations,
            factDocument: { ...factDocument, summaryVersionId: current.id },
            activationFenceV3,
          });
          replaceProjection = !currentProtected;
          if (
            current.status === 'stale'
            && !currentProtected
            && sourceInputsStillActive
            && current.transcriptRevisionId === (sourceTranscript?.id ?? null)
            && current.manualNoteRevision === summaryPayload.manualNoteRevision
          ) {
              const restored = options.settleProcessingStage === false
                ? false
                : await transaction.restoreCurrentSummaryReady(
                  note.id,
                  scopeKey,
                  current.id,
                );
            if (restored) {
              const stage = await transaction.getStage(note.id, scopeKey, 'summary');
              if (!stage) throw new Error('meeting summary processing stage is missing');
              const nowMs = Math.max(Date.now(), stage.updatedAtMs, note.updatedAtMs);
              await transaction.upsertStage(transitionProcessingStage(stage, {
                stage: 'summary',
                status: 'ready',
                progress: 1,
                jobId: null,
                inputFingerprint: current.inputFingerprint,
              }, nowMs), scopeKey);
              await transaction.updateMeeting(note.id, scopeKey, { updatedAtMs: nowMs });
              if (options.canonicalWrite) {
                canonicalRevision = await transaction.advanceCanonicalWrite(scopeKey, nowMs);
              }
              canonicalChanged = true;
              mirrorStatus = 'restored_ready';
              return;
            }
          }
          if (options.settleProcessingStage !== false) {
            await reconcileSummaryStage(
              currentSummaryStatus(),
              current.inputFingerprint,
              current.completedAtMs ?? current.createdAtMs,
            );
          }
          if (options.canonicalWrite && canonicalChanged) {
            canonicalRevision = await transaction.advanceCanonicalWrite(scopeKey, Math.max(
              Date.now(),
              current.completedAtMs ?? current.createdAtMs,
            ));
          }
          mirrorStatus = 'unchanged';
          return;
        }
        if (existingVersion) {
          await transaction.saveSummaryVersion(existingVersion, sections, actions, scopeKey, {
            activate: false,
            citations,
            factDocument: { ...factDocument, summaryVersionId: existingVersion.id },
            activationFenceV3,
          });
          const remainsCurrent = current?.id === versionId;
          const existingProtected = await transaction.hasUserProtectedSummaryState(
            existingVersion.id,
            scopeKey,
          );
          const activateExisting = sourceInputsStillActive
            && !currentProtected
            && !existingProtected;
          if (activateExisting && !remainsCurrent) {
            await transaction.updateMeeting(note.id, scopeKey, {
              currentSummaryVersionId: versionId,
              updatedAtMs: Math.max(
                Date.now(),
                existingVersion.completedAtMs ?? existingVersion.createdAtMs,
                note.updatedAtMs,
              ),
            });
            canonicalChanged = true;
          }
          replaceProjection = (remainsCurrent || activateExisting) && !currentProtected;
          if (
            remainsCurrent
            && current?.status === 'stale'
            && !currentProtected
            && sourceInputsStillActive
            && current.transcriptRevisionId === (sourceTranscript?.id ?? null)
            && current.manualNoteRevision === summaryPayload.manualNoteRevision
          ) {
            const restored = options.settleProcessingStage === false
              ? false
              : await transaction.restoreCurrentSummaryReady(
                note.id,
                scopeKey,
                current.id,
              );
            if (restored) {
              const stage = await transaction.getStage(note.id, scopeKey, 'summary');
              if (!stage) throw new Error('meeting summary processing stage is missing');
              const nowMs = Math.max(Date.now(), stage.updatedAtMs, note.updatedAtMs);
              await transaction.upsertStage(transitionProcessingStage(stage, {
                stage: 'summary',
                status: 'ready',
                progress: 1,
                jobId: null,
                inputFingerprint: current.inputFingerprint,
              }, nowMs), scopeKey);
              await transaction.updateMeeting(note.id, scopeKey, { updatedAtMs: nowMs });
              if (options.canonicalWrite) {
                canonicalRevision = await transaction.advanceCanonicalWrite(scopeKey, nowMs);
              }
              canonicalChanged = true;
              mirrorStatus = 'restored_ready';
              return;
            }
          }
          const activeVersion = activateExisting
            ? existingVersion
            : current;
          if (activeVersion && options.settleProcessingStage !== false) {
            await reconcileSummaryStage(
              activeVersion.status === 'stale' ? 'stale' : 'ready',
              activateExisting ? existingVersion.inputFingerprint : activeVersion.inputFingerprint,
              activeVersion.completedAtMs ?? activeVersion.createdAtMs,
            );
          }
          if (options.canonicalWrite && canonicalChanged) {
            canonicalRevision = await transaction.advanceCanonicalWrite(scopeKey, Math.max(
              Date.now(),
              activeVersion?.completedAtMs ?? activeVersion?.createdAtMs ?? 0,
            ));
          }
          mirrorStatus = activateExisting && !remainsCurrent
            ? 'activated_existing'
            : remainsCurrent
              ? 'unchanged'
              : 'preserved_existing_candidate';
          return;
        }
        const activate = sourceInputsStillActive && (
          !current
          || current.id === versionId
          || !currentProtected
        );
        replaceProjection = activate && !currentProtected;
        mirrorStatus = !sourceInputsStillActive
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
          generatedBy: document.generatedBy ?? 'facts-v3',
          userEdited: false,
          supersedesVersionId: current && current.id !== versionId
            ? current.id
            : null,
          createdAtMs: document.createdAtMs,
          completedAtMs: generatedAtMs,
        };
        await transaction.saveSummaryVersion(newVersion, sections, actions, scopeKey, {
          activate,
          citations,
          factDocument,
          activationFenceV3,
        });
        if (options.settleProcessingStage !== false) {
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
        }
        if (options.canonicalWrite) {
          canonicalRevision = await transaction.advanceCanonicalWrite(scopeKey, Math.max(Date.now(), generatedAtMs, note.updatedAtMs));
        }
      });
      diagnosticAudit('meeting_summary_write', {
        status: mirrorStatus,
        scope: 'guest',
        sections: sections.length,
        citations: citations.length,
        rejected_citations: rejectedCitationCount,
        actions: actions.length,
      });
      return {
        replaceProjection,
        status: mirrorStatus,
        canonicalRevision,
        localVersionId: versionId,
      };
    } catch (error) {
      reportFailure(error);
      if (options.throwOnFailure) throw error;
      return { replaceProjection: true, status: 'failed', canonicalRevision: null };
    }
  });
}
