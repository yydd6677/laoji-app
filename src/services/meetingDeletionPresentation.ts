import type { Meeting } from '../types';

const ACTIVE_DELETION_BLOCKING_STATUSES = new Set([
  'preparing',
  'recording',
  'paused',
  'stopping',
  'saving',
  'finalizing',
]);

export type MeetingDeletionPresentation =
  | {
      blocked: true;
      title: string;
      message: string;
    }
  | {
      blocked: false;
      title: string;
      message: string;
      confirmText: string;
    };

export function isMeetingDeletionBlocked(meeting: Meeting): boolean {
  return ACTIVE_DELETION_BLOCKING_STATUSES.has(meeting.status?.trim().toLowerCase() ?? '');
}

function isLocalOnlyMeeting(meeting: Meeting): boolean {
  if (meeting.source !== 'cloud') return true;
  const clientRequestId = meeting.clientRequestId?.trim();
  return Boolean(meeting.statusSyncPending && clientRequestId && clientRequestId === meeting.id);
}

export function meetingDeletionPresentation(meeting: Meeting): MeetingDeletionPresentation {
  if (isMeetingDeletionBlocked(meeting)) {
    return {
      blocked: true,
      title: '无法删除会议',
      message: '请先结束并保存当前会议录音，再删除。',
    };
  }

  if (isLocalOnlyMeeting(meeting)) {
    const ownsLocalRecording = Boolean(meeting.audioLocalUri || meeting.audioAvailable);
    return {
      blocked: false,
      title: '永久删除本机会议？',
      message: ownsLocalRecording
        ? '此会议记录和本机录音将被永久删除，无法恢复。'
        : '此会议记录将从本机永久删除，无法恢复。',
      confirmText: '永久删除',
    };
  }

  return {
    blocked: false,
    title: '永久删除会议？',
    message: '此会议记录及相关录音、文字记录和整理结果将被永久删除，无法恢复。',
    confirmText: '永久删除',
  };
}
