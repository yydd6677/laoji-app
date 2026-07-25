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
    | 'not_started'
    | 'preparing'
    | 'recording'
    | 'paused'
    | 'finalizing'
    | 'capture_failed'
    | 'uploading'
    | 'upload_failed'
    | 'transcribing'
    | 'transcript_failed'
    | 'summarizing'
    | 'summary_failed'
    | 'speaker_processing'
    | 'speaker_partial'
    | 'speaker_failed'
    | 'ready';
  label: string;
  tone: MeetingPresentationTone;
  retryStage: ProcessingStageName | null;
}

const PRESENTATION_STATES_BY_LABEL: Readonly<Record<string, MeetingPresentationState>> = {
  '未开始': { key: 'not_started', label: '未开始', tone: 'neutral', retryStage: null },
  '正在准备录音': { key: 'preparing', label: '正在准备录音', tone: 'primary', retryStage: null },
  '正在录音': { key: 'recording', label: '正在录音', tone: 'danger', retryStage: null },
  '录音已暂停': { key: 'paused', label: '录音已暂停', tone: 'warning', retryStage: null },
  '正在安全保存录音': { key: 'finalizing', label: '正在安全保存录音', tone: 'neutral', retryStage: null },
  '录音中断': { key: 'capture_failed', label: '录音中断', tone: 'danger', retryStage: 'capture' },
  '录音失败': { key: 'capture_failed', label: '录音失败', tone: 'danger', retryStage: null },
  '录音已保存在本机，等待上传': { key: 'uploading', label: '录音已保存在本机，等待上传', tone: 'neutral', retryStage: null },
  '录音已保存在本机，正在上传': { key: 'uploading', label: '录音已保存在本机，正在上传', tone: 'neutral', retryStage: null },
  '上传受阻': { key: 'upload_failed', label: '上传受阻', tone: 'danger', retryStage: 'upload' },
  '上传失败，可重试': { key: 'upload_failed', label: '上传失败，可重试', tone: 'danger', retryStage: 'upload' },
  '正在生成文字记录': { key: 'transcribing', label: '正在生成文字记录', tone: 'neutral', retryStage: null },
  '文字记录仍在补全': { key: 'transcribing', label: '文字记录仍在补全', tone: 'neutral', retryStage: null },
  '文字处理失败，可重试': { key: 'transcript_failed', label: '文字处理失败，可重试', tone: 'danger', retryStage: 'transcript' },
  '正在整理会议记录': { key: 'summarizing', label: '正在整理会议记录', tone: 'neutral', retryStage: null },
  '整理失败，可重试': { key: 'summary_failed', label: '整理失败，可重试', tone: 'danger', retryStage: 'summary' },
  '整理结果可更新': { key: 'ready', label: '整理结果可更新', tone: 'warning', retryStage: null },
  '正在同步讲话人修改': { key: 'speaker_processing', label: '正在同步讲话人修改', tone: 'neutral', retryStage: null },
  '讲话人修改已保存在本机': { key: 'speaker_partial', label: '讲话人修改已保存在本机', tone: 'warning', retryStage: null },
  '讲话人修改同步失败，可重试': { key: 'speaker_failed', label: '讲话人修改同步失败，可重试', tone: 'danger', retryStage: 'speaker' },
  '已完成': { key: 'ready', label: '已完成', tone: 'success', retryStage: null },
};

export const MEETING_PRESENTATION_LABELS = Object.freeze(Object.keys(PRESENTATION_STATES_BY_LABEL));

export function meetingPresentationStateFromLabel(label: string): MeetingPresentationState | null {
  const state = PRESENTATION_STATES_BY_LABEL[label];
  return state ? { ...state } : null;
}

export function processingStatusesFromStages(
  stages: readonly ProcessingStage[],
): MeetingProcessingStatuses {
  const byStage = new Map<ProcessingStageName, string>();
  stages.forEach(stage => {
    assertProcessingStage(stage);
    if (byStage.has(stage.stage)) throw new Error('meeting processing stage is duplicated');
    byStage.set(stage.stage, stage.status);
  });
  for (const stage of PROCESSING_STAGE_NAMES) {
    if (!byStage.has(stage)) throw new Error('meeting processing stage is missing');
  }
  return {
    capture: byStage.get('capture') as CaptureStatus,
    upload: byStage.get('upload') as UploadStatus,
    transcript: byStage.get('transcript') as TranscriptStatus,
    summary: byStage.get('summary') as SummaryStatus,
    speaker: byStage.get('speaker') as SpeakerStatus,
  };
}

export function deriveMeetingPresentationState(
  stages: MeetingProcessingStatuses,
): MeetingPresentationState {
  if (stages.capture === 'preparing') {
    return meetingPresentationStateFromLabel('正在准备录音')!;
  }
  if (stages.capture === 'recording') {
    return meetingPresentationStateFromLabel('正在录音')!;
  }
  if (stages.capture === 'paused') {
    return meetingPresentationStateFromLabel('录音已暂停')!;
  }
  if (stages.capture === 'finalizing') {
    return meetingPresentationStateFromLabel('正在安全保存录音')!;
  }
  if (stages.capture === 'failed_recoverable') {
    return meetingPresentationStateFromLabel('录音中断')!;
  }
  if (stages.capture === 'failed_terminal') {
    return meetingPresentationStateFromLabel('录音失败')!;
  }
  if (stages.upload === 'queued' || stages.upload === 'uploading') {
    return meetingPresentationStateFromLabel(
      stages.upload === 'queued'
        ? '录音已保存在本机，等待上传'
        : '录音已保存在本机，正在上传',
    )!;
  }
  if (stages.upload === 'failed_retryable' || stages.upload === 'blocked') {
    return meetingPresentationStateFromLabel(
      stages.upload === 'blocked' ? '上传受阻' : '上传失败，可重试',
    )!;
  }
  if (stages.transcript === 'finalizing') {
    return meetingPresentationStateFromLabel('正在生成文字记录')!;
  }
  if (stages.transcript === 'realtime_draft') {
    return meetingPresentationStateFromLabel('文字记录仍在补全')!;
  }
  if (stages.transcript === 'failed_retryable') {
    return meetingPresentationStateFromLabel('文字处理失败，可重试')!;
  }
  if (stages.summary === 'queued' || stages.summary === 'generating') {
    return meetingPresentationStateFromLabel('正在整理会议记录')!;
  }
  if (stages.summary === 'failed_retryable') {
    return meetingPresentationStateFromLabel('整理失败，可重试')!;
  }
  if (stages.speaker === 'processing') {
    return meetingPresentationStateFromLabel('正在同步讲话人修改')!;
  }
  if (stages.speaker === 'failed_retryable') {
    return meetingPresentationStateFromLabel('讲话人修改同步失败，可重试')!;
  }
  if (stages.summary === 'stale') {
    return meetingPresentationStateFromLabel('整理结果可更新')!;
  }
  if (stages.speaker === 'partial') {
    return meetingPresentationStateFromLabel('讲话人修改已保存在本机')!;
  }
  if (
    stages.capture === 'not_started'
    && stages.upload === 'not_required'
    && stages.transcript === 'none'
    && stages.summary === 'none'
    && stages.speaker === 'none'
  ) {
    return meetingPresentationStateFromLabel('未开始')!;
  }
  return meetingPresentationStateFromLabel('已完成')!;
}
