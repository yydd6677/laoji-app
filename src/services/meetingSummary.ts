import {
  ApiMeetingTaskStatus,
  fetchMeetingSummaryDetail,
  fetchMeetingSummaryTask,
  generateMeetingSummary,
} from './api';
import { MeetingSummary, TranscriptLine } from '../types';
import {
  DEFAULT_MEETING_TEMPLATE,
  type MeetingSummaryAttachmentAuthorization,
  type MeetingSummaryCarryForwardAuthorization,
  type MeetingTemplate,
} from '../domain/meeting';
import { HttpResponseError } from './errors';
import { loadMeetingCapabilities } from '../data/api/v2';
import {
  meetingSummaryToText,
  normalizeRemoteMeetingSummaryResult,
  normalizeMeetingSummaryResult,
} from './meetingSummaryFormat';
import {
  createMeetingSummaryTrace,
  persistMeetingSummaryTrace,
  type MeetingSummaryCallSource,
  type MeetingSummaryTraceContext,
} from './meetingSummaryTrace';
import {
  createDeviceSummary,
  createDeviceSummaryV3,
  getDeviceSummary,
  getDeviceSummaryV3,
  getDeviceTask,
  loadDeviceServiceCapabilities,
  DeviceApiError,
} from './deviceApi';
import { loadGenerationRetentionPreference } from './generationPrivacy';
import * as Crypto from 'expo-crypto';
import {
  meetingFactsV3ToSummary,
  parseMeetingFactsResultV3,
} from './meetingSummaryV3';
import {
  generateMeetingSummaryViaSourceStream,
  summarySourceRevision,
} from './meetingSummaryV3SourceStream';
import { getFeatureFlags } from '../config/featureFlags';
import {
  isMeetingSummaryInputChangedErrorLike,
  isSummaryV3ActivationFenceErrorLike,
} from '../domain/meeting/summaryErrorIdentity';

export {
  meetingSummaryTextToPlainText,
  meetingSummaryToText,
  normalizeRemoteMeetingSummaryResult,
  normalizeMeetingSummaryResult,
} from './meetingSummaryFormat';

const MAX_POLL_DURATION_MS = 10 * 60 * 1_000;
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
  stage: 'queued' | 'preparing' | 'generating' | 'verifying' | 'persisting' | 'reconnecting' | 'resubmitting';
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
  if (progress.stage === 'queued') {
    return '整理任务正在排队';
  }
  if (progress.stage === 'reconnecting') {
    return '网络波动，正在重连';
  }
  if (progress.stage === 'resubmitting') {
    return '原整理任务已失效，正在重新提交';
  }
  if (progress.stage === 'preparing') return '正在准备整理';
  if (progress.stage === 'verifying') return '正在核对整理结果';
  if (progress.stage === 'persisting') return '正在保存整理结果';
  return '正在整理会议记录';
}

export class MeetingSummaryTaskFailureError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MeetingSummaryTaskFailureError';
  }
}

export class MeetingSummaryTaskPendingError extends Error {
  constructor() {
    super('整理任务仍在后台进行，再次打开会议可继续获取。');
    this.name = 'MeetingSummaryTaskPendingError';
  }
}

/**
 * The accountless/device API deliberately does not migrate legacy local-only
 * meetings.  Keep this as a distinct error so the pending-task registry can
 * discard an orphaned task instead of reviving it on every detail open.
 */
export class DeviceMeetingUnavailableError extends Error {
  constructor() {
    super('本机会议尚未建立设备服务记录');
    this.name = 'DeviceMeetingUnavailableError';
  }
}

export class MeetingSummaryInputChangedError extends Error {
  constructor() {
    super('会议内容已更新，本次结果未替换当前整理，请重新整理。');
    this.name = 'MeetingSummaryInputChangedError';
  }
}

function isTerminalPollError(error: unknown): boolean {
  return (error instanceof HttpResponseError || error instanceof DeviceApiError)
    && [400, 401, 403, 404].includes(error.status);
}

function isMissingTaskError(error: unknown): boolean {
  return (error instanceof HttpResponseError || error instanceof DeviceApiError) && error.status === 404;
}

export function shouldDiscardPendingMeetingSummaryTask(error: unknown): boolean {
  if (
    error instanceof MeetingSummaryTaskFailureError
    || error instanceof DeviceMeetingUnavailableError
    || error instanceof MeetingSummaryInputChangedError
    || isMeetingSummaryInputChangedErrorLike(error)
    || isSummaryV3ActivationFenceErrorLike(error)
  ) {
    return true;
  }
  // Device-primary meetings use a separate API error class.  A missing
  // device binding (404) is terminal for this local task: retaining its
  // pending registry entry makes every detail open resubmit the same stale
  // task and leaves the UI on "正在提交整理任务" forever.  Authentication,
  // validation, and access failures are terminal for the same reason; the
  // user-visible stage is moved to the retryable error state below.
  if (error instanceof DeviceApiError) {
    return [400, 401, 403, 404].includes(error.status);
  }
  return error instanceof HttpResponseError && [400, 401, 403, 404].includes(error.status);
}

function abortError(): Error {
  const error = new Error('meeting summary cancelled');
  error.name = 'AbortError';
  return error;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortError();
}

async function requireSummaryAttachmentCapability(
  authorization: MeetingSummaryAttachmentAuthorization,
  accessToken?: string | null,
  isGuest = false,
): Promise<void> {
  try {
    const usesText = authorization.items.some(item => item.kind === 'text');
    const usesImage = authorization.items.some(item => item.kind === 'image');
    if (usesImage) {
      if (isGuest || !accessToken) throw new Error('guest image input is unavailable');
    }
    const state = await loadMeetingCapabilities({
      accessToken,
      forceRefresh: true,
      allowStaleOnError: false,
    });
    if (
      state.source !== 'remote'
      || (usesText && !state.capabilities.summaryAttachmentsText)
      || (usesImage && (
        !state.capabilities.meetingAttachmentsV1
        || !state.capabilities.summaryAttachmentsImage
      ))
    ) throw new Error('summary attachment capability is unavailable');
  } catch {
    throw new Error('附件暂时无法用于整理。');
  }
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
  attachmentAuthorization: MeetingSummaryAttachmentAuthorization | null,
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
  const rawAttachmentRequestId = nested?.attachmentRequestId
    ?? nested?.attachment_request_id
    ?? root?.attachmentRequestId
    ?? root?.attachment_request_id;
  const responseAttachmentRequestId = typeof rawAttachmentRequestId === 'string'
    ? rawAttachmentRequestId.trim() || null
    : null;
  const expectedAttachmentRequestId = attachmentAuthorization?.requestId.trim() || null;
  if (responseAttachmentRequestId !== expectedAttachmentRequestId) {
    throw new Error('服务端返回的附件授权与本次请求不一致，未保存本次结果。');
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
      // A submitted task is durable on the service. Transient status fetch
      // failures must not turn a still-running task into a user-visible
      // failure; keep reconnecting until the page wait budget is exhausted.
      continue;
    }
    lastStatus = status.status;
    const elapsedMs = Date.now() - startedAt;
    await options.onProgress?.({
      attempt: attempt + 1,
      status: status.status,
      elapsedMs,
      stage: status.status === 'PENDING'
        ? 'queued'
        : status.stage === 'preparing' || status.stage === 'verifying' || status.stage === 'persisting'
          ? status.stage
          : 'generating',
    });
    if (status.status === 'SUCCESS') return status;
    if (status.status === 'FAILURE') {
      throw new MeetingSummaryTaskFailureError(summaryTaskFailureMessage(status.result));
    }
  }
  void lastFetchError;
  throw new MeetingSummaryTaskPendingError();
}

function deviceTaskStatus(value: any): ApiMeetingTaskStatus {
  const raw = value && typeof value === 'object' ? value : {};
  const status = String(raw.status ?? '').trim().toUpperCase();
  return {
    task_id: typeof raw.task_id === 'string' ? raw.task_id : undefined,
    status: status || 'PENDING',
    result: raw.result,
    long_poll_supported: true,
    stage: typeof raw.stage === 'string' ? raw.stage : undefined,
    source_fingerprint: typeof raw.source_fingerprint === 'string' ? raw.source_fingerprint : undefined,
    model_revision: typeof raw.model_revision === 'string' ? raw.model_revision : undefined,
    prompt_revision: typeof raw.prompt_revision === 'string' ? raw.prompt_revision : undefined,
  };
}

function normalizeDeviceSummaryPayload(
  meetingId: string,
  value: unknown,
  template: Pick<MeetingTemplate, 'id' | 'revision'>,
): MeetingSummary | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const root = value as Record<string, unknown>;
  const nested = root.structured_document && typeof root.structured_document === 'object'
    && !Array.isArray(root.structured_document)
    ? root.structured_document
    : root.structuredDocument && typeof root.structuredDocument === 'object'
      && !Array.isArray(root.structuredDocument)
      ? root.structuredDocument
      : typeof root.template_id === 'string' ? root : null;
  if (!nested) return null;
  return normalizeSummaryForTemplate(meetingId, {
    ...root,
    meeting_id: meetingId,
    markdown: root.markdown ?? root.full_text ?? null,
    structured_document: nested,
  }, template, null, null);
}

async function generateDeviceMeetingSummaryV2(options: {
  meetingId: string;
  transcriptLines: TranscriptLine[];
  template: Pick<MeetingTemplate, 'id' | 'revision'>;
  force: boolean;
  resumeTaskId?: string;
  inputFingerprint?: string;
  signal?: AbortSignal;
  onProgress?: MeetingSummaryProgressListener;
  onTaskSubmitted?: (taskId: string) => void | Promise<void>;
}): Promise<MeetingSummary> {
  let taskId = options.resumeTaskId?.trim() || '';
  const retainGeneratedResult = await loadGenerationRetentionPreference();

  const submit = async (): Promise<string> => {
    const requestId = `device-summary:${options.meetingId}:${options.template.id}:${options.template.revision}:${options.force ? `force-${Date.now()}` : options.inputFingerprint ?? 'current'}`
      .replace(/[^A-Za-z0-9._:-]/g, '_')
      .slice(0, 480);
    let task: any;
    try {
      task = await createDeviceSummary(
        options.meetingId,
        {
          template_id: options.template.id,
          template_revision: options.template.revision,
          force: options.force,
          retain_generated_result: retainGeneratedResult,
        },
        requestId,
        options.signal,
      );
    } catch (error) {
      if (error instanceof DeviceApiError && error.status === 404) {
        throw new DeviceMeetingUnavailableError();
      }
      throw error;
    }
    const submittedId = typeof task?.task_id === 'string' ? task.task_id.trim() : '';
    if (!submittedId) throw new Error('设备整理服务未返回任务标识');
    await options.onTaskSubmitted?.(submittedId);
    return submittedId;
  };

  // A detail page may be unmounted while a device task is still running.  A
  // saved task ID is a durable resume pointer, not a reason to submit another
  // task.  Poll it first so the next page observes the same completion and
  // creates one corresponding local summary version.
  if (!taskId) taskId = await submit();
  let status: ApiMeetingTaskStatus;
  try {
    status = await waitForTask(
      waitMs => getDeviceTask(taskId, waitMs, options.signal).then(deviceTaskStatus),
      { signal: options.signal, onProgress: options.onProgress },
    );
  } catch (error) {
    if (!(error instanceof DeviceApiError) || error.status !== 404 || options.force) throw error;
    // The task row can expire while its result remains readable. Prefer the
    // durable result before creating a replacement task.
    const recovered = await getDeviceSummary(options.meetingId, options.signal)
      .then(value => normalizeDeviceSummaryPayload(options.meetingId, value, options.template))
      .catch(() => null);
    if (recovered) return recovered;
    taskId = await submit();
    status = await waitForTask(
      waitMs => getDeviceTask(taskId, waitMs, options.signal).then(deviceTaskStatus),
      { signal: options.signal, onProgress: options.onProgress },
    );
  }
  if (status.status === 'SUCCESS') {
    const remote = await getDeviceSummary(options.meetingId, options.signal);
    const normalized = normalizeDeviceSummaryPayload(options.meetingId, remote, options.template)
      ?? normalizeDeviceSummaryPayload(options.meetingId, status.result, options.template);
    if (normalized) return normalized;
  }
  throw new Error('设备整理服务返回的结果格式无效');
}

async function sha256Text(value: string): Promise<string> {
  const digest = await Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, value);
  return `sha256:${digest.toLowerCase()}`;
}

async function generateDeviceMeetingSummaryV3(options: {
  meetingId: string;
  transcriptLines: TranscriptLine[];
  template: MeetingTemplate;
  manualNote: { content: string; revision: number };
  attachmentAuthorization: MeetingSummaryAttachmentAuthorization | null;
  force: boolean;
  resumeTaskId?: string;
  inputFingerprint?: string;
  signal?: AbortSignal;
  onProgress?: MeetingSummaryProgressListener;
  onTaskSubmitted?: (taskId: string) => void | Promise<void>;
}): Promise<MeetingSummary> {
  if (getFeatureFlags().meetingSummarySourceStreamCandidate) {
    try {
      const summary = await generateMeetingSummaryViaSourceStream({
        meetingId: options.meetingId,
        transcriptLines: options.transcriptLines,
        transcriptRevision: await summarySourceRevision({
          meetingId: options.meetingId,
          transcriptLines: options.transcriptLines,
          manualNote: options.manualNote,
          attachmentAuthorization: options.attachmentAuthorization,
        }),
        manualNote: options.manualNote,
        attachmentAuthorization: options.attachmentAuthorization,
        template: options.template,
        force: options.force,
        resumeTaskId: options.resumeTaskId,
        signal: options.signal,
        onTaskSubmitted: options.onTaskSubmitted,
        onProgress: stage => options.onProgress?.({
          attempt: 0,
          status: stage.toUpperCase(),
          elapsedMs: 0,
          stage,
        }),
      });
      return summary;
    } catch (error) {
      // The candidate is opt-in and must fail closed. Never fall through to
      // the stable v3 endpoint after a source-stream task has been created,
      // because that would produce two independent owners for one request.
      if (error instanceof Error && /来源流整理能力尚未启用/.test(error.message)) throw error;
      throw error;
    }
  }
  const attachments = (options.attachmentAuthorization?.items ?? []).map(item => {
    if (item.kind !== 'text') {
      throw new Error('所选照片暂时无法用于新版整理，请仅选择文字附件。');
    }
    return {
      attachment_id: item.attachmentId,
      revision: item.updatedAtMs,
      position_ms: item.positionMs,
      content_sha256: item.contentSha256,
      content: item.content,
    };
  });
  let taskId = options.resumeTaskId?.trim() || '';
  let expectedSourceFingerprint: string | null = null;
  let expectedModelRevision: string | null = null;
  let expectedPromptRevision: string | null = null;
  const submit = async (): Promise<string> => {
    const requestId = `device-summary-v3:${options.meetingId}:${options.inputFingerprint ?? 'current'}`
      .replace(/[^A-Za-z0-9._:-]/g, '_')
      .slice(0, 480);
    let task: any;
    try {
      task = await createDeviceSummaryV3(
        options.meetingId,
        {
          transcript_revision: options.inputFingerprint ?? `local:${options.transcriptLines.length}`,
          manual_note: {
            revision: options.manualNote.revision,
            content_sha256: await sha256Text(options.manualNote.content),
            content: options.manualNote.content,
          },
          attachments,
          force: options.force,
        },
        requestId,
        options.signal,
      );
    } catch (error) {
      if (error instanceof DeviceApiError && error.status === 404) {
        throw new DeviceMeetingUnavailableError();
      }
      throw error;
    }
    const submittedId = typeof task?.task_id === 'string' ? task.task_id.trim() : '';
    if (!submittedId) throw new Error('设备整理服务未返回任务标识');
    expectedSourceFingerprint = typeof task?.source_fingerprint === 'string'
      ? task.source_fingerprint.trim() || null
      : null;
    expectedModelRevision = typeof task?.model_revision === 'string'
      ? task.model_revision.trim() || null
      : null;
    expectedPromptRevision = typeof task?.prompt_revision === 'string'
      ? task.prompt_revision.trim() || null
      : null;
    await options.onTaskSubmitted?.(submittedId);
    return submittedId;
  };

  if (!taskId) taskId = await submit();
  let status: ApiMeetingTaskStatus;
  try {
    status = await waitForTask(
      waitMs => getDeviceTask(taskId, waitMs, options.signal).then(deviceTaskStatus),
      { signal: options.signal, onProgress: options.onProgress },
    );
    expectedSourceFingerprint = status.source_fingerprint ?? expectedSourceFingerprint;
    expectedModelRevision = status.model_revision ?? expectedModelRevision;
    expectedPromptRevision = status.prompt_revision ?? expectedPromptRevision;
  } catch (error) {
    if (!(error instanceof DeviceApiError) || error.status !== 404) throw error;
    const recovered = await getDeviceSummaryV3(options.meetingId, options.signal)
      .then(parseMeetingFactsResultV3)
      .catch(() => null);
    // A missing task is not proof that the meeting's latest result belongs to
    // this request. Only reconcile a durable result when the task identity was
    // observed and all available revisions match. Otherwise resubmit the same
    // logical request and let server-side dedupe decide.
    if (recovered && expectedSourceFingerprint
      && recovered.sourceFingerprint === expectedSourceFingerprint
      && (!expectedModelRevision || recovered.modelRevision === expectedModelRevision)
      && (!expectedPromptRevision || recovered.promptRevision === expectedPromptRevision)) {
      return meetingFactsV3ToSummary(
        recovered,
        options.template,
        options.manualNote.revision,
        options.transcriptLines,
      );
    }
    taskId = await submit();
    status = await waitForTask(
      waitMs => getDeviceTask(taskId, waitMs, options.signal).then(deviceTaskStatus),
      { signal: options.signal, onProgress: options.onProgress },
    );
    expectedSourceFingerprint = status.source_fingerprint ?? expectedSourceFingerprint;
    expectedModelRevision = status.model_revision ?? expectedModelRevision;
    expectedPromptRevision = status.prompt_revision ?? expectedPromptRevision;
  }
  if (status.status !== 'SUCCESS') throw new Error('设备整理服务未完成本次任务');
  const remote = await getDeviceSummaryV3(options.meetingId, options.signal).catch(() => null);
  const remoteResult = parseMeetingFactsResultV3(remote);
  const statusResult = parseMeetingFactsResultV3(status.result);
  // Older task responses may omit the explicit identity fields, but a valid
  // v3 terminal result carries the same identity. Seed the matcher from that
  // result before considering the meeting-level latest endpoint.
  if (!expectedSourceFingerprint && statusResult) expectedSourceFingerprint = statusResult.sourceFingerprint;
  if (!expectedModelRevision && statusResult) expectedModelRevision = statusResult.modelRevision;
  if (!expectedPromptRevision && statusResult) expectedPromptRevision = statusResult.promptRevision;
  const matchesExpected = (candidate: ReturnType<typeof parseMeetingFactsResultV3>): candidate is NonNullable<ReturnType<typeof parseMeetingFactsResultV3>> => {
    if (!candidate) return false;
    return Boolean(expectedSourceFingerprint)
      && candidate.sourceFingerprint === expectedSourceFingerprint
      && (!expectedModelRevision || candidate.modelRevision === expectedModelRevision)
      && (!expectedPromptRevision || candidate.promptRevision === expectedPromptRevision);
  };
  const result = (matchesExpected(remoteResult) ? remoteResult : null)
    ?? (matchesExpected(statusResult) ? statusResult : null);
  if (!result) throw new Error('设备整理服务返回的新版结果格式无效');
  return meetingFactsV3ToSummary(
    result,
    options.template,
    options.manualNote.revision,
    options.transcriptLines,
  );
}

async function generateDeviceMeetingSummary(options: {
  meetingId: string;
  transcriptLines: TranscriptLine[];
  template: MeetingTemplate;
  manualNote: { content: string; revision: number };
  attachmentAuthorization: MeetingSummaryAttachmentAuthorization | null;
  force: boolean;
  resumeTaskId?: string;
  inputFingerprint?: string;
  signal?: AbortSignal;
  onProgress?: MeetingSummaryProgressListener;
  onTaskSubmitted?: (taskId: string) => void | Promise<void>;
}): Promise<MeetingSummary> {
  // The source-stream candidate is a complete device-v2 transport and task
  // owner. Do not probe device-v1 before entering it: a restored candidate
  // database may intentionally contain no legacy v1 device registration, and
  // probing v1 here can both reject a valid v2 device and route the same
  // generation to the legacy summary owner. The v3 source-stream path performs
  // its own fail-closed device-v2 capability check.
  if (getFeatureFlags().meetingSummarySourceStreamCandidate) {
    return generateDeviceMeetingSummaryV3(options);
  }
  const capabilities = await loadDeviceServiceCapabilities().catch(() => null);
  if (capabilities?.summaryContractV3) return generateDeviceMeetingSummaryV3(options);
  if (options.attachmentAuthorization) throw new DeviceMeetingUnavailableError();
  return generateDeviceMeetingSummaryV2(options);
}

export function summaryTaskFailureMessage(result: unknown): string {
  let raw = typeof result === 'string' ? result.trim() : '';
  if (result && typeof result === 'object') {
    const value = result as Record<string, unknown>;
    for (const key of ['message', 'detail', 'error', 'reason', 'error_code']) {
      const nested = value[key];
      if (typeof nested === 'string' && nested.trim()) {
        raw = nested.trim();
        break;
      }
    }
  }
  if (/SUMMARY_EVIDENCE_INCOMPLETE|evidence.*incomplete/i.test(raw)) {
    return '会议内容过长，暂未完整整理。';
  }
  if (/SUMMARY_V3_NO_VERIFIED_FACTS|NO_VERIFIED_FACTS/i.test(raw)) {
    return '整理结果缺少可核对的依据，请重试。';
  }
  if (/SUMMARY_V3.*(?:JSON|SCHEMA|FORMAT)|validation/i.test(raw)) {
    return '整理结果格式异常，可重试。';
  }
  if (/照片|image/i.test(raw)) return '所选照片暂时无法用于整理，请重新选择后重试。';
  if (/timeout|timed out|超时/i.test(raw)) return '会议整理超时，请稍后重试。';
  if (raw && !/[A-Za-z]{2,}/.test(raw)) return raw;
  return '会议整理任务执行失败';
}

function summaryTraceErrorCode(error: unknown): string {
  const name = error instanceof Error && error.name.trim() ? error.name.trim() : 'Error';
  const message = error instanceof Error ? error.message : String(error ?? '');
  const hint = message
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 96);
  return hint ? `${name}:${hint}`.slice(0, 120) : name.slice(0, 120);
}

export async function generateSummaryForMeeting(options: {
  meetingId: string;
  localMeetingId?: string;
  title?: string;
  meetingDate?: string;
  transcriptLines: TranscriptLine[];
  template?: MeetingTemplate;
  manualNote?: { content: string; revision: number };
  carryForward?: MeetingSummaryCarryForwardAuthorization | null;
  attachmentAuthorization?: MeetingSummaryAttachmentAuthorization | null;
  isGuest: boolean;
  accessToken?: string | null;
  resumeTaskId?: string;
  forceRegenerate?: boolean;
  signal?: AbortSignal;
  onProgress?: MeetingSummaryProgressListener;
  onTaskSubmitted?: (taskId: string) => void | Promise<void>;
  traceSource?: MeetingSummaryCallSource;
  inputFingerprint?: string;
}): Promise<MeetingSummary> {
  const {
    meetingId,
    localMeetingId,
    title,
    meetingDate,
    transcriptLines,
    template = DEFAULT_MEETING_TEMPLATE,
    manualNote = { content: '', revision: 0 },
    carryForward = null,
    attachmentAuthorization = null,
    isGuest,
    accessToken,
    resumeTaskId,
    forceRegenerate = false,
    signal,
    onProgress,
    onTaskSubmitted,
    traceSource = 'manual',
    inputFingerprint,
  } = options;
  if (transcriptLines.length === 0) throw new Error('meeting transcript is empty');
  throwIfAborted(signal);

  const trace: MeetingSummaryTraceContext = await createMeetingSummaryTrace({
    meetingId,
    title,
    meetingDate,
    transcriptLines,
    template,
    carryForward,
    attachmentAuthorization,
    source: traceSource,
    authMode: isGuest ? 'guest' : 'authenticated',
    inputFingerprint,
  });
  void persistMeetingSummaryTrace(trace, {
    phase: 'started',
    taskId: resumeTaskId ?? null,
  });

  let traceTaskId = resumeTaskId ?? null;
  const bindSummaryToLocalMeeting = (summary: MeetingSummary): MeetingSummary => {
    // A response returned from this generation call is terminal for the input
    // represented by `trace`. Some durable endpoints can still project an old
    // `stale` bit while a resumed task is settling. Carrying that bit into the
    // local cache falsely renders “整理结果可更新” immediately after success.
    const completedSummary = summary.structured_document?.status === 'stale'
      ? {
        ...summary,
        structured_document: {
          ...summary.structured_document,
          status: 'ready' as const,
        },
      }
      : summary;
    const localId = localMeetingId?.trim();
    if (isGuest || !localId || localId === meetingId) return completedSummary;
    const rebound = normalizeRemoteMeetingSummaryResult(localId, meetingId, completedSummary);
    if (!rebound) {
      throw new Error('云端整理结果与本机会议身份不一致，未保存本次结果。');
    }
    return completedSummary.facts_document_v3
      ? { ...rebound, facts_document_v3: completedSummary.facts_document_v3 }
      : rebound;
  };
  try {
    const reportResubmission = () => onProgress?.({
      attempt: 0,
      status: 'RESUBMITTING',
      elapsedMs: 0,
      stage: 'resubmitting',
    });

  if (isGuest) {
    // New device-primary meetings already have their transcript in the
    // device/epoch store. Keep the normal no-authorization path there so the
    // generated result is tied to the same meeting binding and survives API
    // restarts. There is deliberately no fallback to the old guest-summary
    // endpoint: that path would upload the complete local transcript outside
    // the device/epoch boundary. Historical local-only meetings and
    // carry-forward/attachment requests are not migrated by the accountless
    // product and remain unavailable until a device-bound recording exists.
    if (carryForward) {
      throw new DeviceMeetingUnavailableError();
    }
    const generated = await generateDeviceMeetingSummary({
        meetingId,
        transcriptLines,
        template,
        manualNote,
        attachmentAuthorization,
        force: forceRegenerate,
        resumeTaskId,
        inputFingerprint,
        signal,
        onProgress,
        onTaskSubmitted,
      });
    void persistMeetingSummaryTrace(trace, { phase: 'completed', taskId: traceTaskId });
    return bindSummaryToLocalMeeting(generated);
  }

  if (!accessToken) throw new Error('not authenticated');
  const submitTask = async (force: boolean): Promise<string> => {
    if (attachmentAuthorization) {
      await requireSummaryAttachmentCapability(attachmentAuthorization, accessToken);
    }
    const task = await generateMeetingSummary(
      meetingId,
      accessToken,
      signal,
      force,
      template,
      carryForward,
      attachmentAuthorization,
      trace,
    );
    void persistMeetingSummaryTrace(trace, { phase: 'submitted', taskId: task.task_id });
    if (onTaskSubmitted) await onTaskSubmitted(task.task_id);
    return task.task_id;
  };
  let taskId = resumeTaskId || await submitTask(forceRegenerate);
  traceTaskId = taskId;
  let completedStatus: ApiMeetingTaskStatus | null = null;
  if (taskId) {
    try {
      completedStatus = await waitForTask(
        waitMs => fetchMeetingSummaryTask(meetingId, taskId, accessToken, signal, waitMs, trace),
        { signal, onProgress },
      );
    } catch (error) {
      // A polling request can fail after the worker has already committed the
      // summary. Check the durable result once before showing a terminal error.
      throwIfAborted(signal);
      const completed = await fetchMeetingSummaryDetail(meetingId, accessToken, signal, trace).catch(() => null);
      let normalizedCompleted: MeetingSummary | null = null;
      if (completed) {
        try {
          normalizedCompleted = normalizeSummaryForTemplate(
            meetingId,
            completed,
            template,
            carryForward,
            attachmentAuthorization,
          );
        } catch {
          // The durable endpoint may still expose the previous template while a missing task is
          // being recovered. Only a matching version can satisfy this request.
        }
      }
      if (normalizedCompleted) {
        void persistMeetingSummaryTrace(trace, { phase: 'completed', taskId });
        return bindSummaryToLocalMeeting(normalizedCompleted);
      }
      if (isMissingTaskError(error)) {
        await reportResubmission();
        taskId = await submitTask(false);
        traceTaskId = taskId;
        completedStatus = await waitForTask(
          waitMs => fetchMeetingSummaryTask(meetingId, taskId, accessToken, signal, waitMs, trace),
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
      attachmentAuthorization,
    );
    if (taskSummary) {
      void persistMeetingSummaryTrace(trace, { phase: 'completed', taskId });
      return bindSummaryToLocalMeeting(taskSummary);
    }
  }
  const summary = normalizeSummaryForTemplate(
    meetingId,
    await fetchMeetingSummaryDetail(meetingId, accessToken, signal, trace),
    template,
    carryForward,
    attachmentAuthorization,
  );
  if (!summary) throw new Error('meeting summary is empty');
  void persistMeetingSummaryTrace(trace, { phase: 'completed', taskId });
  return bindSummaryToLocalMeeting(summary);
  } catch (error) {
    const aborted = error instanceof Error && error.name === 'AbortError';
    void persistMeetingSummaryTrace(trace, {
      phase: aborted ? 'background' : 'failed',
      taskId: traceTaskId,
      errorCode: aborted ? null : summaryTraceErrorCode(error),
    });
    throw error;
  }
}
