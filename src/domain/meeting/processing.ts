export type ProcessingStageName = 'capture' | 'upload' | 'transcript' | 'summary' | 'speaker';

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
