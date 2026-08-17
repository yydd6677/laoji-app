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
      recoverable: boolean;
      retentionDays: number | null;
    };

export function isMeetingDeletionBlocked(meeting: Meeting): boolean {
  return ACTIVE_DELETION_BLOCKING_STATUSES.has(meeting.status?.trim().toLowerCase() ?? '');
}

function isLocalOnlyMeeting(meeting: Meeting): boolean {
  // Device-primary guest meetings are backed by the local canonical note
  // repository and its tombstone/restore flow.  They do not need a cloud
  // remoteId in order to use the device recycle bin.  Only account-scoped
  // rows without a remote identity (or with a still-pending identity) are
  // truly permanent local-only records.
  if (meeting.source === 'guest') return false;
  if (meeting.source !== 'cloud') return true;
  const clientRequestId = meeting.clientRequestId?.trim();
  return Boolean(meeting.statusSyncPending && clientRequestId && clientRequestId === meeting.id);
}

export function isMeetingEligibleForRecycleBin(meeting: Meeting): boolean {
  if (isMeetingDeletionBlocked(meeting)) return false;

  // The accountless product owns guest meetings in the device canonical
  // database. They intentionally have no cloud identity, so requiring a
  // remoteId here makes the recycle-bin UI unreachable for the normal path.
  // The guest tombstone/restore implementation is local and can preserve a
  // pending upload just as safely as a completed recording.
  if (meeting.source === 'guest') return true;

  return !isLocalOnlyMeeting(meeting)
    && Boolean(meeting.remoteId?.trim())
    && !meeting.statusSyncPending
    && !meeting.audioSyncPending
    && !meeting.audioSyncBlocked;
}

export function meetingDeletionPresentation(
  meeting: Meeting,
  options: { softDeleteDays?: number | null } = {},
): MeetingDeletionPresentation {
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
        ? '此会议记录、本机录音和已生成的音频片段将被永久删除，无法恢复。'
        : '此会议记录及相关本机文件将被永久删除，无法恢复。',
      confirmText: '永久删除',
      recoverable: false,
      retentionDays: null,
    };
  }

  const softDeleteDays = options.softDeleteDays ?? null;
  if (
    Number.isSafeInteger(softDeleteDays)
    && Number(softDeleteDays) > 0
    && isMeetingEligibleForRecycleBin(meeting)
  ) {
    return {
      blocked: false,
      title: '移到回收站？',
      message: `此会议记录将在回收站保留${softDeleteDays}天，期间可以恢复。`,
      confirmText: '移到回收站',
      recoverable: true,
      retentionDays: Number(softDeleteDays),
    };
  }

  return {
    blocked: false,
    title: '永久删除会议？',
    message: '此会议记录及相关录音、音频片段、文字记录和整理结果将被永久删除，无法恢复。',
    confirmText: '永久删除',
    recoverable: false,
    retentionDays: null,
  };
}

export async function resolveMeetingDeletionPresentation(
  meeting: Meeting,
  loadSoftDeleteDays: () => Promise<number | null>,
): Promise<MeetingDeletionPresentation> {
  if (!isMeetingEligibleForRecycleBin(meeting)) {
    return meetingDeletionPresentation(meeting);
  }
  return meetingDeletionPresentation(meeting, {
    softDeleteDays: await loadSoftDeleteDays(),
  });
}
