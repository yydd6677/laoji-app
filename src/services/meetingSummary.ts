import {
  ApiMeetingTaskStatus,
  fetchGuestMeetingSummaryTask,
  fetchMeetingSummaryDetail,
  fetchMeetingSummaryTask,
  generateGuestMeetingSummary,
  generateMeetingSummary,
} from './api';
import { MeetingSummary, TranscriptLine } from '../types';
import { HttpResponseError } from './errors';

const MAX_POLL_DURATION_MS = 180_000;

export interface MeetingSummaryProgress {
  attempt: number;
  status: string;
  elapsedMs: number;
  stage: 'queued' | 'generating' | 'reconnecting' | 'resubmitting';
}

export function summaryPollDelayMs(elapsedMs: number): number {
  if (elapsedMs < 5_000) return 500;
  if (elapsedMs < 30_000) return 1_000;
  return 2_000;
}

export function meetingSummaryProgressLabel(progress: MeetingSummaryProgress): string {
  const seconds = Math.max(0, Math.round(progress.elapsedMs / 1_000));
  if (progress.stage === 'queued') {
    return seconds > 0 ? `总结任务排队中 · ${seconds} 秒` : '总结任务正在排队';
  }
  if (progress.stage === 'reconnecting') {
    return seconds > 0 ? `网络波动，正在重连 · ${seconds} 秒` : '网络波动，正在重连';
  }
  if (progress.stage === 'resubmitting') {
    return '原总结任务已失效，正在重新提交';
  }
  return seconds > 0 ? `正在生成总结 · ${seconds} 秒` : '正在生成总结';
}

export class MeetingSummaryTaskFailureError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MeetingSummaryTaskFailureError';
  }
}

function isTerminalPollError(error: unknown): boolean {
  return error instanceof HttpResponseError && [400, 401, 403, 404].includes(error.status);
}

function isMissingTaskError(error: unknown): boolean {
  return error instanceof HttpResponseError && error.status === 404;
}

export function shouldDiscardPendingMeetingSummaryTask(error: unknown): boolean {
  if (error instanceof MeetingSummaryTaskFailureError) return true;
  return error instanceof HttpResponseError && [400, 401, 403].includes(error.status);
}

function abortError(): Error {
  const error = new Error('meeting summary cancelled');
  error.name = 'AbortError';
  return error;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortError();
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortError());
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortError());
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

export function meetingSummaryToText(summary: MeetingSummary | null): string {
  if (!summary) return '';
  return (summary.markdown || summary.full_text || summary.overview || '').trim();
}

export function meetingDateForSummary(dateLabel?: string, createdAt?: string): string | undefined {
  const label = /^(\d{4})年(\d{1,2})月(\d{1,2})日$/.exec((dateLabel ?? '').trim());
  if (label) {
    return `${label[1]}-${label[2].padStart(2, '0')}-${label[3].padStart(2, '0')}`;
  }
  if (!createdAt) return undefined;
  const value = new Date(createdAt);
  if (Number.isNaN(value.getTime())) return undefined;
  return `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, '0')}-${String(value.getDate()).padStart(2, '0')}`;
}

export function normalizeGuestSummaryResult(meetingId: string, value: unknown): MeetingSummary | null {
  if (!value || typeof value !== 'object') return null;
  const result = value as Record<string, unknown>;
  const overview = typeof result.overview === 'string' ? result.overview : '';
  const fullText = typeof result.full_text === 'string' ? result.full_text : overview;
  const markdown = typeof result.markdown === 'string' ? result.markdown : fullText;
  if (!(overview || fullText || markdown)) return null;
  return {
    meeting_id: typeof result.meeting_id === 'string' ? result.meeting_id : meetingId,
    overview,
    full_text: fullText,
    markdown,
    key_decisions: Array.isArray(result.key_decisions) ? result.key_decisions.filter(item => typeof item === 'string') as string[] : [],
    action_items: Array.isArray(result.action_items) ? result.action_items as MeetingSummary['action_items'] : [],
    generated_at: typeof result.generated_at === 'string' ? result.generated_at : new Date().toISOString(),
  };
}

async function waitForTask(
  fetchStatus: () => Promise<ApiMeetingTaskStatus>,
  options: { signal?: AbortSignal; onProgress?: (progress: MeetingSummaryProgress) => void } = {},
): Promise<ApiMeetingTaskStatus> {
  const startedAt = Date.now();
  let consecutiveFetchFailures = 0;
  let lastFetchError: unknown;
  for (let attempt = 0; Date.now() - startedAt <= MAX_POLL_DURATION_MS; attempt += 1) {
    throwIfAborted(options.signal);
    if (attempt > 0) {
      await delay(summaryPollDelayMs(Date.now() - startedAt), options.signal);
    }
    let status: ApiMeetingTaskStatus;
    try {
      status = await fetchStatus();
      consecutiveFetchFailures = 0;
      lastFetchError = undefined;
    } catch (error) {
      if (isTerminalPollError(error)) throw error;
      consecutiveFetchFailures += 1;
      lastFetchError = error;
      options.onProgress?.({
        attempt: attempt + 1,
        status: 'RECONNECTING',
        elapsedMs: Date.now() - startedAt,
        stage: 'reconnecting',
      });
      if (consecutiveFetchFailures < 5) continue;
      throw error;
    }
    const elapsedMs = Date.now() - startedAt;
    options.onProgress?.({
      attempt: attempt + 1,
      status: status.status,
      elapsedMs,
      stage: status.status === 'PENDING' ? 'queued' : 'generating',
    });
    if (status.status === 'SUCCESS') return status;
    if (status.status === 'FAILURE') {
      throw new MeetingSummaryTaskFailureError(summaryTaskFailureMessage(status.result));
    }
  }
  if (lastFetchError instanceof Error) throw lastFetchError;
  throw new Error('meeting summary task timed out');
}

export function summaryTaskFailureMessage(result: unknown): string {
  if (typeof result === 'string' && result.trim()) return result.trim();
  if (result && typeof result === 'object') {
    const value = result as Record<string, unknown>;
    for (const key of ['message', 'detail', 'error', 'reason']) {
      const nested = value[key];
      if (typeof nested === 'string' && nested.trim()) return nested.trim();
    }
  }
  return '会议总结任务执行失败';
}

export async function generateSummaryForMeeting(options: {
  meetingId: string;
  title?: string;
  meetingDate?: string;
  transcriptLines: TranscriptLine[];
  isGuest: boolean;
  accessToken?: string | null;
  resumeTaskId?: string;
  forceRegenerate?: boolean;
  signal?: AbortSignal;
  onProgress?: (progress: MeetingSummaryProgress) => void;
  onTaskSubmitted?: (taskId: string) => void | Promise<void>;
}): Promise<MeetingSummary> {
  const {
    meetingId,
    title,
    meetingDate,
    transcriptLines,
    isGuest,
    accessToken,
    resumeTaskId,
    forceRegenerate = false,
    signal,
    onProgress,
    onTaskSubmitted,
  } = options;
  if (transcriptLines.length === 0) throw new Error('meeting transcript is empty');
  throwIfAborted(signal);

  const reportResubmission = () => onProgress?.({
    attempt: 0,
    status: 'RESUBMITTING',
    elapsedMs: 0,
    stage: 'resubmitting',
  });

  if (isGuest) {
    const submitTask = async (force: boolean): Promise<string> => {
      const task = await generateGuestMeetingSummary(
        meetingId,
        transcriptLines,
        title,
        signal,
        meetingDate,
        force,
      );
      if (onTaskSubmitted) await onTaskSubmitted(task.task_id);
      return task.task_id;
    };
    let taskId = resumeTaskId || await submitTask(forceRegenerate);
    let status: ApiMeetingTaskStatus;
    try {
      status = await waitForTask(
        () => fetchGuestMeetingSummaryTask(taskId, signal),
        { signal, onProgress },
      );
    } catch (error) {
      if (!resumeTaskId || !isMissingTaskError(error)) throw error;
      throwIfAborted(signal);
      reportResubmission();
      taskId = await submitTask(false);
      status = await waitForTask(
        () => fetchGuestMeetingSummaryTask(taskId, signal),
        { signal, onProgress },
      );
    }
    const summary = normalizeGuestSummaryResult(meetingId, status.result);
    if (!summary) throw new Error('guest meeting summary is empty');
    return summary;
  }

  if (!accessToken) throw new Error('not authenticated');
  const submitTask = async (force: boolean): Promise<string> => {
    const task = await generateMeetingSummary(meetingId, accessToken, signal, force);
    if (onTaskSubmitted) await onTaskSubmitted(task.task_id);
    return task.task_id;
  };
  let taskId = resumeTaskId || await submitTask(forceRegenerate);
  if (taskId) {
    try {
      await waitForTask(
        () => fetchMeetingSummaryTask(meetingId, taskId, accessToken, signal),
        { signal, onProgress },
      );
    } catch (error) {
      // A polling request can fail after the worker has already committed the
      // summary. Check the durable result once before showing a terminal error.
      throwIfAborted(signal);
      const completed = await fetchMeetingSummaryDetail(meetingId, accessToken, signal).catch(() => null);
      if (completed) return completed;
      if (resumeTaskId && isMissingTaskError(error)) {
        reportResubmission();
        taskId = await submitTask(false);
        await waitForTask(
          () => fetchMeetingSummaryTask(meetingId, taskId, accessToken, signal),
          { signal, onProgress },
        );
      } else {
        throw error;
      }
    }
  }
  throwIfAborted(signal);
  const summary = await fetchMeetingSummaryDetail(meetingId, accessToken, signal);
  if (!summary) throw new Error('meeting summary is empty');
  return summary;
}
