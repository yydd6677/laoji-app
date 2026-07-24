import type {
  PendingMeetingMediaImportIntent,
} from 'laoji-native-platform';

export const LOCAL_MEETING_MEDIA_IMPORT_MAX_BYTES = 1024 * 1024 * 1024;

export function suggestedMeetingTitleFromFileName(fileName: string | null | undefined): string {
  const normalized = fileName
    ?.replace(/[\\/\u0000-\u001f\u007f]/g, ' ')
    .trim()
    .replace(/\.(?:wav|mp3|m4a|aac|ogg|webm|flac)$/i, '')
    .trim()
    .slice(0, 500)
    ?? '';
  return normalized;
}

function errorCode(reason: unknown): string {
  if (!reason || typeof reason !== 'object') return '';
  const code = (reason as { code?: unknown }).code;
  return typeof code === 'string' ? code : '';
}

export function isMeetingMediaPickerCancellation(reason: unknown): boolean {
  return errorCode(reason) === 'ERR_PICKER_CANCELLED';
}

export function meetingMediaImportErrorMessage(reason: unknown): string {
  switch (errorCode(reason)) {
    case 'ERR_MEDIA_IMPORT_UNAVAILABLE':
      return '当前设备暂不支持导入会议录音。';
    case 'ERR_MEDIA_IMPORT_UNSUPPORTED_TYPE':
      return '这个文件不是受支持的会议录音格式。';
    case 'ERR_MEDIA_IMPORT_EMPTY':
      return '这个文件没有可导入的音频内容。';
    case 'ERR_MEDIA_IMPORT_TOO_LARGE':
      return '这个文件超过当前允许的导入大小。';
    case 'ERR_MEDIA_IMPORT_NO_SPACE':
      return '本机存储空间不足，暂时无法导入这个文件。';
    case 'ERR_MEDIA_IMPORT_UNREADABLE':
    case 'ERR_MEDIA_IMPORT_CHANGED':
      return '无法读取这个文件，请重新选择。';
    case 'ERR_MEDIA_IMPORT_IDENTITY_CONFLICT':
      return '这次导入已存在，请返回会议列表查看。';
    case 'ERR_MEDIA_IMPORT_STORAGE':
      return '文件暂时无法保存到本机，请检查存储空间后重试。';
    default:
      return '会议录音导入失败，请稍后重试。';
  }
}

export function meetingMediaIntentErrorMessage(
  intent: PendingMeetingMediaImportIntent,
): string | null {
  switch (intent.errorCode) {
    case 'multiple_not_supported':
      return '一次只能导入一个会议录音文件。';
    case 'missing_file':
      return '分享内容中没有可导入的录音文件。';
    case 'unreadable_uri':
      return '无法读取分享的录音文件。';
    case 'unsupported_type':
      return '分享的文件不是受支持的会议录音格式。';
    default:
      return null;
  }
}
