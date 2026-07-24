import {
  ApiMeetingTaskStatus,
  fetchGuestMeetingSummaryTask,
  fetchMeetingSummaryDetail,
  fetchMeetingSummaryTask,
  generateGuestMeetingSummary,
  generateMeetingSummary,
} from './api';
import { MeetingSummary, TranscriptLine } from '../types';
import {
  DEFAULT_MEETING_TEMPLATE,
  type MeetingSummaryCarryForwardAuthorization,
  type MeetingTemplate,
} from '../domain/meeting';
import { HttpResponseError } from './errors';
import {
  meetingSummaryToText,
  normalizeMeetingSummaryResult,
} from './meetingSummaryFormat';

export {
  meetingSummaryTextToPlainText,
  meetingSummaryToText,
  normalizeMeetingSummaryResult,
} from './meetingSummaryFormat';

const MAX_POLL_DURATION_MS = 180_000;
const SUMMARY_LONG_POLL_MS = 5_000;

export const BRIEF_GREETING_SUMMARY = '本次录音仅包含简短问候，暂无可总结的议题、决定或行动项。';

const BRIEF_GREETING_PATTERN = /^(?:(?:喂+|你(?:们)?好|(?:大家|各位)(?:早上|上午|中午|下午|晚上)?好|早上好|上午好|中午好|下午好|晚上好|哈(?:喽|啰|罗)|hello|hi|测试(?:一下)?|试音|听得到吗|能听到吗|嗯+|啊+|哦+|诶+)[\s，。！？、,.!?啊呀哦吧吗呢哈]*)+$/i;

export function briefGreetingSummaryText(
  transcript: readonly Pick<TranscriptLine, 'text'>[],
): string | null {
  const texts = transcript.map(line => line.text.trim()).filter(Boolean);
  if (texts.length === 0 || texts.length > 8) return null;
  if (texts.reduce((total, text) => total + text.length, 0) > 80) return null;
  return texts.every(text => BRIEF_GREETING_PATTERN.test(text))
    ? BRIEF_GREETING_SUMMARY
    : null;
}

export interface MeetingSummaryProgress {
  attempt: number;
  status: string;
  elapsedMs: number;
  stage: 'queued' | 'generating' | 'reconnecting' | 'resubmitting';
}

type MeetingSummaryProgressListener = (
  progress: MeetingSummaryProgress,
) => void | Promise<void>;

export function summaryPollDelayMs(elapsedMs: number, lastStatus = ''): number {
  if (lastStatus === 'RECONNECTING') {
    if (elapsedMs < 5_000) return 500;
    if (elapsedMs < 30_000) return 1_000;
    return 2_000;
  }
  if (elapsedMs < 5_000) return 250;
  if (elapsedMs < 30_000) return lastStatus === 'PENDING' ? 1_000 : 500;
  return lastStatus === 'PENDING' ? 2_000 : 1_000;
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

export const normalizeGuestSummaryResult = normalizeMeetingSummaryResult;

function normalizeSummaryForTemplate(
  meetingId: string,
  value: unknown,
  template: Pick<MeetingTemplate, 'id' | 'revision'>,
  carryForward: MeetingSummaryCarryForwardAuthorization | null,
): MeetingSummary | null {
  const root = value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
  const nested = root?.structured_document && typeof root.structured_document === 'object'
    && !Array.isArray(root.structured_document)
    ? root.structured_document as Record<string, unknown>
    : null;
  const rawCarryRequestId = nested?.carryForwardRequestId
    ?? nested?.carry_forward_request_id
    ?? root?.carryForwardRequestId
    ?? root?.carry_forward_request_id;
  const responseCarryRequestId = typeof rawCarryRequestId === 'string'
    ? rawCarryRequestId.trim() || null
    : null;
  const expectedCarryRequestId = carryForward?.requestId.trim() || null;
  if (responseCarryRequestId !== expectedCarryRequestId) {
    throw new Error('服务端返回的历史参考授权与本次请求不一致，未保存本次结果。');
  }
  const summary = normalizeMeetingSummaryResult(meetingId, value);
  if (!summary) return null;
  const document = summary.structured_document;
  if (
    !document
    || document.templateId !== template.id
    || document.templateRevision !== template.revision
  ) {
    throw new Error('服务端返回的整理模板与所选模板不一致，未保存本次结果。');
  }
  return summary;
}

async function waitForTask(
  fetchStatus: (waitMs: number) => Promise<ApiMeetingTaskStatus>,
  options: { signal?: AbortSignal; onProgress?: MeetingSummaryProgressListener } = {},
): Promise<ApiMeetingTaskStatus> {
  const startedAt = Date.now();
  let consecutiveFetchFailures = 0;
  let lastFetchError: unknown;
  let lastStatus = '';
  let supportsLongPoll = false;
  for (let attempt = 0; Date.now() - startedAt <= MAX_POLL_DURATION_MS; attempt += 1) {
    throwIfAborted(options.signal);
    if (attempt > 0 && !supportsLongPoll) {
      await delay(summaryPollDelayMs(Date.now() - startedAt, lastStatus), options.signal);
    }
    let status: ApiMeetingTaskStatus;
    try {
      status = await fetchStatus(attempt === 0 ? 0 : SUMMARY_LONG_POLL_MS);
      consecutiveFetchFailures = 0;
      lastFetchError = undefined;
      supportsLongPoll = status.long_poll_supported === true;
    } catch (error) {
      if (isTerminalPollError(error)) throw error;
      consecutiveFetchFailures += 1;
      lastFetchError = error;
      lastStatus = 'RECONNECTING';
      supportsLongPoll = false;
      await options.onProgress?.({
        attempt: attempt + 1,
        status: 'RECONNECTING',
        elapsedMs: Date.now() - startedAt,
        stage: 'reconnecting',
      });
      if (consecutiveFetchFailures < 5) continue;
      throw error;
    }
    lastStatus = status.status;
    const elapsedMs = Date.now() - startedAt;
    await options.onProgress?.({
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
  template?: Pick<MeetingTemplate, 'id' | 'revision'>;
  carryForward?: MeetingSummaryCarryForwardAuthorization | null;
  isGuest: boolean;
  accessToken?: string | null;
  resumeTaskId?: string;
  forceRegenerate?: boolean;
  signal?: AbortSignal;
  onProgress?: MeetingSummaryProgressListener;
  onTaskSubmitted?: (taskId: string) => void | Promise<void>;
}): Promise<MeetingSummary> {
  const {
    meetingId,
    title,
    meetingDate,
    transcriptLines,
    template = DEFAULT_MEETING_TEMPLATE,
    carryForward = null,
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
        template,
        carryForward,
      );
      if (onTaskSubmitted) await onTaskSubmitted(task.task_id);
      return task.task_id;
    };
    let taskId = resumeTaskId || await submitTask(forceRegenerate);
    let status: ApiMeetingTaskStatus;
    try {
      status = await waitForTask(
        waitMs => fetchGuestMeetingSummaryTask(taskId, signal, waitMs),
        { signal, onProgress },
      );
    } catch (error) {
      if (!isMissingTaskError(error)) throw error;
      throwIfAborted(signal);
      await reportResubmission();
      taskId = await submitTask(false);
      status = await waitForTask(
        waitMs => fetchGuestMeetingSummaryTask(taskId, signal, waitMs),
        { signal, onProgress },
      );
    }
    const summary = normalizeSummaryForTemplate(meetingId, status.result, template, carryForward);
    if (!summary) throw new Error('guest meeting summary is empty');
    return summary;
  }

  if (!accessToken) throw new Error('not authenticated');
  const submitTask = async (force: boolean): Promise<string> => {
    const task = await generateMeetingSummary(
      meetingId,
      accessToken,
      signal,
      force,
      template,
      carryForward,
    );
    if (onTaskSubmitted) await onTaskSubmitted(task.task_id);
    return task.task_id;
  };
  let taskId = resumeTaskId || await submitTask(forceRegenerate);
  let completedStatus: ApiMeetingTaskStatus | null = null;
  if (taskId) {
    try {
      completedStatus = await waitForTask(
        waitMs => fetchMeetingSummaryTask(meetingId, taskId, accessToken, signal, waitMs),
        { signal, onProgress },
      );
    } catch (error) {
      // A polling request can fail after the worker has already committed the
      // summary. Check the durable result once before showing a terminal error.
      throwIfAborted(signal);
      const completed = await fetchMeetingSummaryDetail(meetingId, accessToken, signal).catch(() => null);
      let normalizedCompleted: MeetingSummary | null = null;
      if (completed) {
        try {
          normalizedCompleted = normalizeSummaryForTemplate(meetingId, completed, template, carryForward);
        } catch {
          // The durable endpoint may still expose the previous template while a missing task is
          // being recovered. Only a matching version can satisfy this request.
        }
      }
      if (normalizedCompleted) return normalizedCompleted;
      if (isMissingTaskError(error)) {
        await reportResubmission();
        taskId = await submitTask(false);
        completedStatus = await waitForTask(
          waitMs => fetchMeetingSummaryTask(meetingId, taskId, accessToken, signal, waitMs),
          { signal, onProgress },
        );
      } else {
        throw error;
      }
    }
  }
  throwIfAborted(signal);
  if (completedStatus?.result) {
    const taskSummary = normalizeSummaryForTemplate(
      meetingId,
      completedStatus.result,
      template,
      carryForward,
    );
    if (taskSummary) return taskSummary;
  }
  const summary = normalizeSummaryForTemplate(
    meetingId,
    await fetchMeetingSummaryDetail(meetingId, accessToken, signal),
    template,
    carryForward,
  );
  if (!summary) throw new Error('meeting summary is empty');
  return summary;
}
