import { HttpResponseError } from './errors';

export type MeetingAudioUploadFailureCode =
  | 'file_missing'
  | 'file_too_large'
  | 'meeting_missing'
  | 'audio_rejected'
  | 'forbidden'
  | 'temporary';

export interface MeetingAudioUploadFailure {
  retryable: boolean;
  code: MeetingAudioUploadFailureCode;
  message: string;
}

export class LocalMeetingAudioFileMissingError extends Error {
  constructor() {
    super('本机录音文件已不存在，无法继续上传。');
    this.name = 'LocalMeetingAudioFileMissingError';
  }
}

export function classifyMeetingAudioUploadFailure(error: unknown): MeetingAudioUploadFailure {
  if (error instanceof LocalMeetingAudioFileMissingError) {
    return { retryable: false, code: 'file_missing', message: error.message };
  }
  if (error instanceof HttpResponseError) {
    if (error.status === 413) {
      return {
        retryable: false,
        code: 'file_too_large',
        message: '录音文件超过云端上传上限，仍保存在本机。',
      };
    }
    if (error.status === 404) {
      return {
        retryable: false,
        code: 'meeting_missing',
        message: '云端会议已不存在，录音仍保存在本机。',
      };
    }
    if ([400, 415, 422].includes(error.status)) {
      return {
        retryable: false,
        code: 'audio_rejected',
        message: '录音格式或文件内容无法上传，文件仍保存在本机。',
      };
    }
    if (error.status === 409 || error.status === 412) {
      return {
        retryable: false,
        code: 'audio_rejected',
        message: '云端已有不同的录音资产状态，请刷新会议后再处理。本机文件不会被删除。',
      };
    }
    if (error.status === 403) {
      return {
        retryable: false,
        code: 'forbidden',
        message: '当前账号无权上传这段录音，文件仍保存在本机。',
      };
    }
  }
  return {
    retryable: true,
    code: 'temporary',
    message: '暂时无法同步录音，文件仍保存在本机，稍后将自动重试。',
  };
}
