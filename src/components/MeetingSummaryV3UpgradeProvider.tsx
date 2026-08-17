import React, { useEffect, useRef } from 'react';
import { AppState } from 'react-native';
import { SelectMeetingSummaryVersionUseCase } from '../application/meeting';
import {
  claimNextSummaryV3UpgradeTask,
  deferSummaryV3UpgradeTask,
  enqueueMissingSummaryV3UpgradeTasks,
  hasInteractiveMeetingWork,
  linkMeetingFactsToSummaryVersion,
  loadSummaryV3UpgradeMeetingContext,
  recoverInterruptedSummaryV3UpgradeTasks,
  saveMeetingFactsResultV3,
  saveSummaryV3UpgradeRemoteTaskId,
  settleSummaryV3UpgradeTask,
  sqliteMeetingNoteRepository,
} from '../data/repositories';
import { DEFAULT_MEETING_TEMPLATE } from '../domain/meeting';
import { useAuth } from '../store/AuthStore';
import { useMeetings } from '../store/MeetingsStore';
import { loadDeviceServiceCapabilities } from '../services/deviceApi';
import { diagnosticAudit, diagnosticWarn } from '../services/diagnostics';
import {
  generateSummaryForMeeting,
  meetingDateForSummary,
} from '../services/meetingSummary';
import { meetingSummaryInputFingerprint } from '../services/meetingSummaryTasks';
import {
  hasSummaryV3InteractiveWork,
  notifySummaryV3UpgradeChanged,
} from '../services/meetingSummaryV3Upgrade';
import type { TranscriptLine } from '../types';

const IDLE_POLL_MS = 5 * 60_000;
const NEXT_TASK_DELAY_MS = 15_000;
const YIELD_CHECK_MS = 1_000;
const selectSummaryVersion = new SelectMeetingSummaryVersionUseCase(sqliteMeetingNoteRepository);

function errorCode(reason: unknown): string {
  const value = reason instanceof Error ? reason.name || reason.message : 'unknown';
  return value.replace(/[^A-Za-z0-9_.-]/g, '_').slice(0, 120) || 'unknown';
}

/** Runs one resumable legacy-to-v3 upgrade at a time and yields before user work. */
export function MeetingSummaryV3UpgradeProvider(): null {
  const { mode } = useAuth();
  const { meetings, loading, saveCachedSummary } = useMeetings();
  const meetingsRef = useRef(meetings);
  meetingsRef.current = meetings;

  useEffect(() => {
    if (mode !== 'guest' || loading) return undefined;
    let active = true;
    let running = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const schedule = (delayMs: number) => {
      if (!active) return;
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        void run();
      }, delayMs);
    };

    const run = async () => {
      if (!active || running || AppState.currentState !== 'active') return;
      running = true;
      let nextDelay = IDLE_POLL_MS;
      try {
        const capabilities = await loadDeviceServiceCapabilities().catch(() => null);
        if (!capabilities?.summaryContractV3) return;
        await enqueueMissingSummaryV3UpgradeTasks();
        if (hasSummaryV3InteractiveWork() || await hasInteractiveMeetingWork()) {
          nextDelay = NEXT_TASK_DELAY_MS;
          return;
        }
        const task = await claimNextSummaryV3UpgradeTask();
        if (!task) return;
        notifySummaryV3UpgradeChanged(task.meetingId);
        nextDelay = NEXT_TASK_DELAY_MS;

        const context = await loadSummaryV3UpgradeMeetingContext(task.meetingId);
        const meeting = context
          ? meetingsRef.current.find(candidate => candidate.id === context.legacyMeetingId)
          : null;
        if (!context || !meeting) {
          await settleSummaryV3UpgradeTask(task.meetingId, {
            success: false,
            errorCode: 'meeting_projection_unavailable',
            attemptCount: task.attemptCount,
          });
          notifySummaryV3UpgradeChanged(task.meetingId);
          return;
        }
        if (hasSummaryV3InteractiveWork() || await hasInteractiveMeetingWork()) {
          await deferSummaryV3UpgradeTask(task.meetingId, task.attemptCount);
          notifySummaryV3UpgradeChanged(task.meetingId);
          return;
        }

        const [transcriptProjection, aggregate] = await Promise.all([
          sqliteMeetingNoteRepository.getActiveTranscriptContent(context.canonicalMeetingId, 'guest'),
          sqliteMeetingNoteRepository.get(context.canonicalMeetingId, 'guest'),
        ]);
        if (!transcriptProjection || transcriptProjection.revision.status !== 'ready') {
          await settleSummaryV3UpgradeTask(task.meetingId, {
            success: false,
            errorCode: 'transcript_not_ready',
            attemptCount: task.attemptCount,
          });
          notifySummaryV3UpgradeChanged(task.meetingId);
          return;
        }
        const transcriptLines: TranscriptLine[] = transcriptProjection.segments.map(segment => ({
          id: segment.id,
          meeting_id: context.legacyMeetingId,
          speaker_id: segment.speakerProfileId ?? segment.speakerClusterId ?? 'unknown',
          speaker_label: segment.speakerLabelOverride ?? segment.speakerLabel ?? '讲话人',
          text: segment.text,
          start_time: segment.startMs / 1_000,
          end_time: segment.endMs / 1_000,
          confidence: segment.confidence ?? undefined,
          isFinal: true,
          revisionKind: 'final',
          script: 'zh-Hans',
        }));
        const noteSnapshot = {
          content: aggregate?.manualNote.content ?? '',
          revision: aggregate?.manualNote.revision ?? 0,
        };
        const fingerprint = meetingSummaryInputFingerprint(
          transcriptLines,
          meeting.title,
          meetingDateForSummary(meeting.date, meeting.createdAt),
          DEFAULT_MEETING_TEMPLATE,
          null,
          null,
          noteSnapshot,
        );
        const controller = new AbortController();
        let yielded = false;
        const monitor = setInterval(() => {
          if (!active || AppState.currentState !== 'active') {
            yielded = true;
            controller.abort();
            return;
          }
          void hasInteractiveMeetingWork().then(hasWork => {
            if ((hasWork || hasSummaryV3InteractiveWork()) && !controller.signal.aborted) {
              yielded = true;
              controller.abort();
            }
          }).catch(() => undefined);
        }, YIELD_CHECK_MS);
        try {
          const generated = await generateSummaryForMeeting({
            meetingId: context.legacyMeetingId,
            localMeetingId: context.legacyMeetingId,
            title: meeting.title,
            meetingDate: meetingDateForSummary(meeting.date, meeting.createdAt),
            transcriptLines,
            template: DEFAULT_MEETING_TEMPLATE,
            manualNote: noteSnapshot,
            carryForward: null,
            attachmentAuthorization: null,
            isGuest: true,
            forceRegenerate: false,
            resumeTaskId: task.remoteTaskId ?? undefined,
            inputFingerprint: fingerprint,
            signal: controller.signal,
            traceSource: 'automatic_resume',
            onTaskSubmitted: remoteTaskId => saveSummaryV3UpgradeRemoteTaskId(
              task.meetingId,
              remoteTaskId,
            ),
          });
          const facts = generated.facts_document_v3;
          if (!facts) throw new Error('summary_v3_result_missing');
          await saveMeetingFactsResultV3(context.canonicalMeetingId, facts);
          const cached = await saveCachedSummary(context.legacyMeetingId, generated);
          if (!cached.localVersionId) throw new Error('summary_v3_local_version_missing');
          await linkMeetingFactsToSummaryVersion(
            context.canonicalMeetingId,
            facts.documentId,
            cached.localVersionId,
          );
          const current = await sqliteMeetingNoteRepository.getCurrentSummaryVersion(
            context.canonicalMeetingId,
            'guest',
          );
          if (current?.id !== cached.localVersionId) {
            await selectSummaryVersion.execute({
              meetingId: context.canonicalMeetingId,
              versionId: cached.localVersionId,
              expectedCurrentVersionId: current?.id ?? null,
              scopeKey: 'guest',
            });
          }
          await settleSummaryV3UpgradeTask(task.meetingId, { success: true });
          diagnosticAudit('meeting_summary_v3_upgrade', { status: 'success' });
        } catch (reason) {
          if (yielded || controller.signal.aborted) {
            await deferSummaryV3UpgradeTask(task.meetingId, task.attemptCount);
          } else {
            await settleSummaryV3UpgradeTask(task.meetingId, {
              success: false,
              errorCode: errorCode(reason),
              attemptCount: task.attemptCount,
            });
            diagnosticWarn('[meeting-summary-v3] background upgrade deferred', {
              error_code: errorCode(reason),
            });
          }
        } finally {
          clearInterval(monitor);
          notifySummaryV3UpgradeChanged(task.meetingId);
        }
      } finally {
        running = false;
        schedule(nextDelay);
      }
    };

    void (async () => {
      await recoverInterruptedSummaryV3UpgradeTasks().catch(() => 0);
      await enqueueMissingSummaryV3UpgradeTasks().catch(() => 0);
      schedule(20_000);
    })();
    const subscription = AppState.addEventListener('change', state => {
      if (state === 'active') schedule(2_000);
    });
    return () => {
      active = false;
      if (timer) clearTimeout(timer);
      subscription.remove();
    };
  }, [loading, mode, saveCachedSummary]);

  return null;
}
