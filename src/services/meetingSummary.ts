import { MeetingSummary, TranscriptLine } from '../types';
import {
  DEFAULT_MEETING_TEMPLATE,
  type MeetingSummaryAttachmentAuthorization,
  type MeetingSummaryCarryForwardAuthorization,
  type MeetingTemplate,
} from '../domain/meeting';
import {
  normalizeMeetingSummaryResult,
} from './meetingSummaryFormat';
import {
  createMeetingSummaryTrace,
  persistMeetingSummaryTrace,
  type MeetingSummaryCallSource,
  type MeetingSummaryTraceContext,
} from './meetingSummaryTrace';
import {
  DeviceApiError,
} from './deviceApi';
import {
  generateMeetingSummaryViaSourceStream,
  summarySourceRevision,
} from './meetingSummaryV3SourceStream';
import {
  isMeetingSummaryInputChangedErrorLike,
  isSummaryV3ActivationFenceErrorLike,
} from '../domain/meeting/summaryErrorIdentity';

export {
  meetingSummaryTextToPlainText,
  meetingSummaryToText,
  normalizeMeetingSummaryResult,
} from './meetingSummaryFormat';


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
  // Queue, reconnect, verification and persistence are implementation stages,
  // not separate user tasks. Keep one stable phrase while the same operation
  // advances so the detail header does not chatter or reflow.
  void progress;
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
    super('正在整理会议记录');
    this.name = 'MeetingSummaryTaskPendingError';
  }
}

export function isMeetingSummaryTaskPendingError(error: unknown): boolean {
  return error instanceof MeetingSummaryTaskPendingError
    || Boolean(
      error
      && typeof error === 'object'
      && (error as { name?: unknown }).name === 'MeetingSummaryTaskPendingError',
    );
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
  // task and leaves the UI in its active state forever. Authentication,
  // validation, and access failures are terminal for the same reason; the
  // user-visible stage is moved to the retryable error state below.
  if (error instanceof DeviceApiError) {
    return [400, 401, 403, 404].includes(error.status);
  }
  return false;
}

function abortError(): Error {
  const error = new Error('meeting summary cancelled');
  error.name = 'AbortError';
  return error;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortError();
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
  onTaskPrepared?: (taskId: string) => void | Promise<void>;
  onTaskSubmitted?: (taskId: string) => void | Promise<void>;
}): Promise<MeetingSummary> {
  return generateMeetingSummaryViaSourceStream({
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
    onTaskPrepared: options.onTaskPrepared,
    onTaskSubmitted: options.onTaskSubmitted,
    onProgress: stage => options.onProgress?.({
      attempt: 0,
      status: stage.toUpperCase(),
      elapsedMs: 0,
      stage,
    }),
  });
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
  onTaskPrepared?: (taskId: string) => void | Promise<void>;
  onTaskSubmitted?: (taskId: string) => void | Promise<void>;
}): Promise<MeetingSummary> {
  return generateDeviceMeetingSummaryV3(options);
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
  title?: string;
  meetingDate?: string;
  transcriptLines: TranscriptLine[];
  template?: MeetingTemplate;
  manualNote?: { content: string; revision: number };
  carryForward?: MeetingSummaryCarryForwardAuthorization | null;
  attachmentAuthorization?: MeetingSummaryAttachmentAuthorization | null;
  resumeTaskId?: string;
  forceRegenerate?: boolean;
  signal?: AbortSignal;
  onProgress?: MeetingSummaryProgressListener;
  onTaskPrepared?: (taskId: string) => void | Promise<void>;
  onTaskSubmitted?: (taskId: string) => void | Promise<void>;
  traceSource?: MeetingSummaryCallSource;
  inputFingerprint?: string;
}): Promise<MeetingSummary> {
  const {
    meetingId,
    title,
    meetingDate,
    transcriptLines,
    template = DEFAULT_MEETING_TEMPLATE,
    manualNote = { content: '', revision: 0 },
    carryForward = null,
    attachmentAuthorization = null,
    resumeTaskId,
    forceRegenerate = false,
    signal,
    onProgress,
    onTaskPrepared,
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
    return completedSummary;
  };
  try {
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
        onTaskPrepared,
        onTaskSubmitted,
      });
    void persistMeetingSummaryTrace(trace, { phase: 'completed', taskId: traceTaskId });
    return bindSummaryToLocalMeeting(generated);
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
