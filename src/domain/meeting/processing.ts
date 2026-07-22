export type ProcessingStageName = 'capture' | 'upload' | 'transcript' | 'summary' | 'speaker';

export const PROCESSING_STAGE_NAMES: readonly ProcessingStageName[] = [
  'capture',
  'upload',
  'transcript',
  'summary',
  'speaker',
];

export type CaptureStatus =
  | 'not_started'
  | 'preparing'
  | 'recording'
  | 'paused'
  | 'finalizing'
  | 'local_ready'
  | 'failed_recoverable'
  | 'failed_terminal';

export type UploadStatus =
  | 'not_required'
  | 'queued'
  | 'uploading'
  | 'uploaded'
  | 'failed_retryable'
  | 'blocked';

export type TranscriptStatus =
  | 'none'
  | 'realtime_draft'
  | 'finalizing'
  | 'ready'
  | 'failed_retryable'
  | 'unavailable';

export type SummaryStatus =
  | 'none'
  | 'queued'
  | 'generating'
  | 'ready'
  | 'stale'
  | 'failed_retryable';

export type SpeakerStatus = 'none' | 'processing' | 'ready' | 'partial' | 'failed_retryable';

export interface ProcessingStatusByStage {
  capture: CaptureStatus;
  upload: UploadStatus;
  transcript: TranscriptStatus;
  summary: SummaryStatus;
  speaker: SpeakerStatus;
}

export interface MeetingProcessingStatuses {
  capture: CaptureStatus;
  upload: UploadStatus;
  transcript: TranscriptStatus;
  summary: SummaryStatus;
  speaker: SpeakerStatus;
}

export interface ProcessingStage<Status extends string = string> {
  meetingId: string;
  stage: ProcessingStageName;
  status: Status;
  attemptCount: number;
  progress: number | null;
  jobId: string | null;
  inputFingerprint: string | null;
  errorCode: string | null;
  userMessageKey: string | null;
  retryable: boolean;
  nextRetryAtMs: number | null;
  updatedAtMs: number;
}

export type TypedProcessingStage = {
  [Stage in ProcessingStageName]: ProcessingStage<ProcessingStatusByStage[Stage]> & { stage: Stage };
}[ProcessingStageName];

export type ProcessingStageTransition = {
  [Stage in ProcessingStageName]: {
    stage: Stage;
    status: ProcessingStatusByStage[Stage];
    attemptStarted?: boolean;
    progress?: number | null;
    jobId?: string | null;
    inputFingerprint?: string | null;
    errorCode?: string | null;
    userMessageKey?: string | null;
    retryable?: boolean;
    nextRetryAtMs?: number | null;
  };
}[ProcessingStageName];

const STATUS_VALUES: { [Stage in ProcessingStageName]: ReadonlySet<ProcessingStatusByStage[Stage]> } = {
  capture: new Set<CaptureStatus>([
    'not_started', 'preparing', 'recording', 'paused', 'finalizing',
    'local_ready', 'failed_recoverable', 'failed_terminal',
  ]),
  upload: new Set<UploadStatus>([
    'not_required', 'queued', 'uploading', 'uploaded', 'failed_retryable', 'blocked',
  ]),
  transcript: new Set<TranscriptStatus>([
    'none', 'realtime_draft', 'finalizing', 'ready', 'failed_retryable', 'unavailable',
  ]),
  summary: new Set<SummaryStatus>([
    'none', 'queued', 'generating', 'ready', 'stale', 'failed_retryable',
  ]),
  speaker: new Set<SpeakerStatus>([
    'none', 'processing', 'ready', 'partial', 'failed_retryable',
  ]),
};

export function isProcessingStageName(value: string): value is ProcessingStageName {
  return (PROCESSING_STAGE_NAMES as readonly string[]).includes(value);
}

export function isProcessingStatusForStage<Stage extends ProcessingStageName>(
  stage: Stage,
  status: string,
): status is ProcessingStatusByStage[Stage] {
  return (STATUS_VALUES[stage] as ReadonlySet<string>).has(status);
}

export function assertProcessingStage(stage: ProcessingStage): asserts stage is TypedProcessingStage {
  if (!isProcessingStageName(stage.stage) || !isProcessingStatusForStage(stage.stage, stage.status)) {
    throw new Error('meeting processing stage is invalid');
  }
  if (!Number.isSafeInteger(stage.attemptCount) || stage.attemptCount < 0) {
    throw new Error('meeting processing attempt count is invalid');
  }
  if (stage.progress !== null && (!Number.isFinite(stage.progress) || stage.progress < 0 || stage.progress > 1)) {
    throw new Error('meeting processing progress is invalid');
  }
  if (!Number.isSafeInteger(stage.updatedAtMs) || stage.updatedAtMs < 0) {
    throw new Error('meeting processing update time is invalid');
  }
}

export function initialMeetingProcessingStatuses(
  scopeKey: 'guest' | `user:${string}`,
): MeetingProcessingStatuses {
  return {
    capture: 'not_started',
    upload: 'not_required',
    transcript: 'none',
    summary: 'none',
    speaker: 'none',
  };
}

export function createInitialProcessingStages(
  meetingId: string,
  scopeKey: 'guest' | `user:${string}`,
  updatedAtMs: number,
  overrides: Partial<MeetingProcessingStatuses> = {},
): readonly TypedProcessingStage[] {
  const statuses = { ...initialMeetingProcessingStatuses(scopeKey), ...overrides };
  return PROCESSING_STAGE_NAMES.map(stage => {
    const record: ProcessingStage = {
      meetingId,
      stage,
      status: statuses[stage],
      attemptCount: 0,
      progress: null,
      jobId: null,
      inputFingerprint: null,
      errorCode: null,
      userMessageKey: null,
      retryable: false,
      nextRetryAtMs: null,
      updatedAtMs,
    };
    assertProcessingStage(record);
    return record;
  });
}

function retryableByStatus(stage: ProcessingStageName, status: string): boolean {
  return status === 'failed_retryable' || (stage === 'capture' && status === 'failed_recoverable');
}

function failureLikeStatus(status: string): boolean {
  return status.startsWith('failed_') || status === 'blocked';
}

export function transitionProcessingStage(
  current: ProcessingStage,
  transition: ProcessingStageTransition,
  updatedAtMs: number,
): TypedProcessingStage {
  assertProcessingStage(current);
  if (current.stage !== transition.stage) throw new Error('meeting processing stage transition mismatch');
  if (!Number.isSafeInteger(updatedAtMs) || updatedAtMs < current.updatedAtMs) {
    throw new Error('meeting processing transition time is invalid');
  }
  const progress = transition.progress === undefined ? current.progress : transition.progress;
  if (progress !== null && (!Number.isFinite(progress) || progress < 0 || progress > 1)) {
    throw new Error('meeting processing progress is invalid');
  }
  const failed = failureLikeStatus(transition.status);
  const next: ProcessingStage = {
    ...current,
    status: transition.status,
    attemptCount: current.attemptCount + (transition.attemptStarted ? 1 : 0),
    progress,
    jobId: transition.jobId === undefined ? current.jobId : transition.jobId,
    inputFingerprint: transition.inputFingerprint === undefined
      ? current.inputFingerprint
      : transition.inputFingerprint,
    errorCode: failed
      ? transition.errorCode === undefined ? current.errorCode : transition.errorCode
      : null,
    userMessageKey: failed
      ? transition.userMessageKey === undefined ? current.userMessageKey : transition.userMessageKey
      : null,
    retryable: failed
      ? transition.retryable ?? retryableByStatus(transition.stage, transition.status)
      : false,
    nextRetryAtMs: failed
      ? transition.nextRetryAtMs === undefined ? current.nextRetryAtMs : transition.nextRetryAtMs
      : null,
    updatedAtMs,
  };
  assertProcessingStage(next);
  return next;
}

export type MeetingPresentationTone = 'neutral' | 'primary' | 'success' | 'warning' | 'danger';

export interface MeetingPresentationState {
  key:
    | 'recording'
    | 'paused'
    | 'finalizing'
    | 'uploading'
    | 'upload_failed'
    | 'transcribing'
    | 'transcript_failed'
    | 'summarizing'
    | 'summary_failed'
    | 'ready';
  label: string;
  tone: MeetingPresentationTone;
  retryStage: ProcessingStageName | null;
}

export function deriveMeetingPresentationState(
  stages: MeetingProcessingStatuses,
): MeetingPresentationState {
  if (stages.capture === 'recording') {
    return { key: 'recording', label: '正在录音', tone: 'danger', retryStage: null };
  }
  if (stages.capture === 'paused') {
    return { key: 'paused', label: '录音已暂停', tone: 'warning', retryStage: null };
  }
  if (stages.capture === 'finalizing') {
    return { key: 'finalizing', label: '正在安全保存录音', tone: 'neutral', retryStage: null };
  }
  if (stages.upload === 'queued' || stages.upload === 'uploading') {
    return {
      key: 'uploading',
      label: stages.upload === 'queued' ? '录音已保存在本机，等待上传' : '录音已保存在本机，正在上传',
      tone: 'neutral',
      retryStage: null,
    };
  }
  if (stages.upload === 'failed_retryable' || stages.upload === 'blocked') {
    return {
      key: 'upload_failed',
      label: stages.upload === 'blocked' ? '上传受阻' : '上传失败，可重试',
      tone: 'danger',
      retryStage: 'upload',
    };
  }
  if (stages.transcript === 'finalizing') {
    return { key: 'transcribing', label: '正在生成文字记录', tone: 'neutral', retryStage: null };
  }
  if (stages.transcript === 'failed_retryable') {
    return {
      key: 'transcript_failed',
      label: '文字处理失败，可重试',
      tone: 'danger',
      retryStage: 'transcript',
    };
  }
  if (stages.summary === 'queued' || stages.summary === 'generating') {
    return { key: 'summarizing', label: '正在整理会议记录', tone: 'neutral', retryStage: null };
  }
  if (stages.summary === 'failed_retryable') {
    return {
      key: 'summary_failed',
      label: '整理失败，可重试',
      tone: 'danger',
      retryStage: 'summary',
    };
  }
  return {
    key: 'ready',
    label: stages.summary === 'stale' ? '整理结果可更新' : '已完成',
    tone: stages.summary === 'stale' ? 'warning' : 'success',
    retryStage: null,
  };
}
