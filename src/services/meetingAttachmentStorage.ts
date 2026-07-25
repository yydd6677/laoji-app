import * as FileSystem from 'expo-file-system/legacy';

const ROOT_NAME = 'meeting-attachments/';
const MAX_IMAGE_BYTES = 25 * 1024 * 1024;

function requireDocumentDirectory(): string {
  if (!FileSystem.documentDirectory) throw new Error('附件存储暂时不可用。');
  return `${FileSystem.documentDirectory}${ROOT_NAME}`;
}

export function isStoredMeetingAttachmentUri(uri: string | null | undefined): uri is string {
  if (!uri || uri.includes('..')) return false;
  try {
    return uri.startsWith(requireDocumentDirectory());
  } catch {
    return false;
  }
}

function stableHash(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

function meetingDirectoryName(meetingId: string): string {
  const prefix = meetingId.replace(/[^A-Za-z0-9_.-]/g, '_').slice(0, 40) || 'meeting';
  return `${prefix}-${stableHash(meetingId)}`;
}

function normalizedImageType(mimeType: string | null | undefined, fileName: string | null | undefined) {
  const normalized = mimeType?.trim().toLocaleLowerCase() ?? '';
  const extension = fileName?.trim().toLocaleLowerCase().match(/\.([a-z0-9]{2,5})$/)?.[1] ?? '';
  if (['image/jpeg', 'image/jpg'].includes(normalized) || ['jpg', 'jpeg'].includes(extension)) {
    return { mimeType: 'image/jpeg', extension: 'jpg' };
  }
  if (normalized === 'image/png' || extension === 'png') return { mimeType: 'image/png', extension: 'png' };
  if (normalized === 'image/webp' || extension === 'webp') return { mimeType: 'image/webp', extension: 'webp' };
  if (['image/heic', 'image/heif'].includes(normalized) || ['heic', 'heif'].includes(extension)) {
    return { mimeType: normalized === 'image/heif' || extension === 'heif' ? 'image/heif' : 'image/heic', extension: extension === 'heif' ? 'heif' : 'heic' };
  }
  throw new Error('请选择 JPG、PNG、WebP 或 HEIC 图片。');
}

export interface StoredMeetingAttachmentImage {
  localUri: string;
  mimeType: string;
  fileName: string;
  byteSize: number;
}

export async function storeMeetingAttachmentImage(input: {
  navigationMeetingId: string;
  attachmentId: string;
  sourceUri: string;
  fileName?: string | null;
  mimeType?: string | null;
  byteSize?: number | null;
}): Promise<StoredMeetingAttachmentImage> {
  if (!input.sourceUri.startsWith('file://')) throw new Error('无法读取所选图片，请重新选择。');
  if (input.byteSize !== null && input.byteSize !== undefined && (
    !Number.isSafeInteger(input.byteSize) || input.byteSize < 1 || input.byteSize > MAX_IMAGE_BYTES
  )) throw new Error('图片不能超过 25 MB。');
  const type = normalizedImageType(input.mimeType, input.fileName);
  const root = requireDocumentDirectory();
  const directory = `${root}${meetingDirectoryName(input.navigationMeetingId)}/`;
  const destination = `${directory}${input.attachmentId}.${type.extension}`;
  await FileSystem.makeDirectoryAsync(directory, { intermediates: true });
  try {
    await FileSystem.copyAsync({ from: input.sourceUri, to: destination });
    const info = await FileSystem.getInfoAsync(destination);
    const byteSize = info.exists && typeof info.size === 'number' ? info.size : 0;
    if (byteSize < 1 || byteSize > MAX_IMAGE_BYTES) {
      throw new Error(byteSize > MAX_IMAGE_BYTES ? '图片不能超过 25 MB。' : '所选图片为空或无法读取。');
    }
    const sourceName = input.fileName?.trim().replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 240);
    return {
      localUri: destination,
      mimeType: type.mimeType,
      fileName: sourceName || `照片.${type.extension}`,
      byteSize,
    };
  } catch (reason) {
    await FileSystem.deleteAsync(destination, { idempotent: true }).catch(() => {});
    throw reason;
  }
}

export async function deleteMeetingAttachmentFile(uri: string | null): Promise<void> {
  if (!uri) return;
  const root = requireDocumentDirectory();
  if (!uri.startsWith(root)) throw new Error('附件文件路径无效。');
  await FileSystem.deleteAsync(uri, { idempotent: true });
}

export async function deleteMeetingAttachmentFiles(navigationMeetingId: string): Promise<void> {
  const directory = `${requireDocumentDirectory()}${meetingDirectoryName(navigationMeetingId)}/`;
  await FileSystem.deleteAsync(directory, { idempotent: true });
}
