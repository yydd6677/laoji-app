import * as FileSystem from 'expo-file-system/legacy';
import * as Sharing from 'expo-sharing';
import { BEST_SPEED, zip } from 'react-native-zip-archive';
import { Meeting, TranscriptLine } from '../types';
import { ApiMeetingAudioInfo, fetchMeetingAudioInfo } from './api';
import { meetingAudioUrlErrorMessage, validateMeetingAudioUrl } from './meetingAudioSecurity';
import { meetingSummaryTextToPlainText } from './meetingSummaryFormat';
import { speakerDisplayLabel } from '../utils/speakerLabels';

export type MeetingShareKind = 'bundle' | 'document' | 'audio';
export type MeetingShareErrorCode = 'NO_AUDIO' | 'NO_MEETING_CONTENT' | 'SHARING_UNAVAILABLE';
export const MEETING_SHARE_RETENTION_MS = 10 * 60 * 1000;

export class MeetingShareError extends Error {
  constructor(public readonly code: MeetingShareErrorCode, message: string) {
    super(message);
    this.name = 'MeetingShareError';
  }
}

export interface MeetingShareInput {
  meeting: Meeting;
  transcriptLines: TranscriptLine[];
  summaryText?: string | null;
  isGuest: boolean;
  accessToken?: string | null;
  audioInfo?: ApiMeetingAudioInfo | null;
}

export function safeMeetingFileName(value: string): string {
  return value
    .trim()
    .replace(/[\\/:*?"<>|／：＊？＂＜＞｜\r\n]+/g, '_')
    .replace(/\s+/g, '_')
    .slice(0, 48) || '老记会议';
}

function formatTranscriptTime(seconds?: number): string {
  if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds < 0) return '';
  const whole = Math.floor(seconds);
  const hours = Math.floor(whole / 3600);
  const minutes = Math.floor((whole % 3600) / 60);
  const secs = whole % 60;
  return hours > 0
    ? `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')}`
    : `${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
}

export function buildMeetingInfoText(meeting: Meeting): string {
  const participants = meeting.participants?.filter(Boolean).join('、') || '未记录';
  const status = meeting.tags.map(tag => tag.label).filter(Boolean).join('、') || meeting.status || '未记录';
  const location = meeting.location?.trim() || '未记录';
  return [
    `会议标题：${meeting.title}`,
    `会议日期：${meeting.date}`,
    `会议时间：${meeting.time || '未记录'}`,
    `会议时长：${meeting.duration || '未记录'}`,
    `会议地址：${location}`,
    `参与人员：${participants}`,
    `会议状态：${status}`,
  ].join('\n');
}

export function buildMeetingTranscriptText(lines: TranscriptLine[]): string {
  return lines
    .filter(line => line.text.trim())
    .map(line => {
      const time = formatTranscriptTime(line.start_time);
      const speaker = speakerDisplayLabel(line.speaker_label, line.speaker_id);
      return `${time ? `[${time}] ` : ''}${speaker}：${line.text.trim()}`;
    })
    .join('\n');
}

export function buildMeetingDocumentText(
  meeting: Meeting,
  transcriptLines: TranscriptLine[],
  summaryText?: string | null,
): string {
  const transcript = buildMeetingTranscriptText(transcriptLines);
  const summary = meetingSummaryTextToPlainText(summaryText?.trim() ?? '');
  return [
    '老记会议文档',
    buildMeetingInfoText(meeting),
    summary ? `会议总结\n${summary}` : '',
    transcript ? `会议转写\n${transcript}` : '',
  ].filter(Boolean).join('\n\n--------------------\n\n');
}

function requireCacheDirectory(): string {
  if (!FileSystem.cacheDirectory) throw new Error('meeting share cache unavailable');
  return FileSystem.cacheDirectory;
}

function meetingShareRoot(): string {
  return `${requireCacheDirectory()}meeting-shares/`;
}

function timestampFromShareEntry(name: string): number | null {
  const match = name.match(/(?:-|_)(\d{13})(?:\.zip)?$/);
  if (!match) return null;
  const value = Number(match[1]);
  return Number.isSafeInteger(value) ? value : null;
}

function scheduleShareArtifactCleanup(uri: string, delayMs = MEETING_SHARE_RETENTION_MS): void {
  setTimeout(() => {
    void FileSystem.deleteAsync(uri, { idempotent: true }).catch(() => {});
  }, Math.max(0, delayMs));
}

export async function cleanupStaleMeetingShareCache(
  now = Date.now(),
  retentionMs = MEETING_SHARE_RETENTION_MS,
): Promise<void> {
  const root = meetingShareRoot();
  let entries: string[];
  try {
    entries = await FileSystem.readDirectoryAsync(root);
  } catch {
    return;
  }

  const expired: string[] = [];
  entries.forEach(name => {
    const createdAt = timestampFromShareEntry(name);
    if (createdAt === null) return;
    const uri = `${root}${name}`;
    const remaining = retentionMs - Math.max(0, now - createdAt);
    if (remaining <= 0) expired.push(uri);
    else scheduleShareArtifactCleanup(uri, remaining);
  });

  const results = await Promise.allSettled(
    expired.map(uri => FileSystem.deleteAsync(uri, { idempotent: true })),
  );
  const failures = results.filter(result => result.status === 'rejected').length;
  if (failures > 0) throw new Error(`${failures} meeting share cache entries could not be deleted`);
}

function fileUriToPath(uri: string): string {
  return decodeURIComponent(uri.replace(/^file:\/\//, ''));
}

function pathToFileUri(path: string): string {
  return path.startsWith('file://') ? path : `file://${path}`;
}

function audioExtension(info: ApiMeetingAudioInfo): string {
  const source = info.file_name || info.url.split(/[?#]/)[0];
  const match = source.match(/\.([A-Za-z0-9]{2,6})$/);
  if (match) return `.${match[1].toLowerCase()}`;
  const mime = info.mime_type?.toLowerCase();
  if (mime?.includes('mpeg')) return '.mp3';
  if (mime?.includes('mp4') || mime?.includes('m4a')) return '.m4a';
  if (mime?.includes('aac')) return '.aac';
  if (mime?.includes('ogg')) return '.ogg';
  if (mime?.includes('webm')) return '.webm';
  return '.wav';
}

async function createShareDirectory(meeting: Meeting): Promise<{ directoryUri: string; baseName: string }> {
  const root = meetingShareRoot();
  const baseName = safeMeetingFileName(meeting.title);
  const directoryUri = `${root}${safeMeetingFileName(meeting.id)}-${Date.now()}/`;
  await FileSystem.makeDirectoryAsync(directoryUri, { intermediates: true });
  return { directoryUri, baseName };
}

async function writeTextFile(uri: string, content: string): Promise<string> {
  await FileSystem.writeAsStringAsync(uri, content, { encoding: FileSystem.EncodingType.UTF8 });
  return uri;
}

async function resolveAudioInfo(input: MeetingShareInput): Promise<ApiMeetingAudioInfo | null> {
  if (input.audioInfo) return input.audioInfo;
  const localUri = input.meeting.audioLocalUri;
  if (localUri) {
    try {
      const info = await FileSystem.getInfoAsync(localUri);
      if (info.exists) {
        return {
          url: localUri,
          mime_type: 'audio/wav',
          file_name: localUri.split('/').pop() ?? 'meeting.wav',
        };
      }
    } catch {
      // Fall through to the cloud copy when a stale local URI is unavailable.
    }
  }
  if (input.isGuest || !input.accessToken) return null;
  return fetchMeetingAudioInfo(input.meeting.id, input.accessToken);
}

async function materializeAudio(
  input: MeetingShareInput,
  directoryUri: string,
  baseName: string,
): Promise<{ uri: string; mimeType: string } | null> {
  const audio = await resolveAudioInfo(input);
  if (!audio) return null;
  const targetUri = `${directoryUri}${baseName}_录音${audioExtension(audio)}`;
  if (audio.url.startsWith('file://') || audio.url.startsWith('content://')) {
    await FileSystem.copyAsync({ from: audio.url, to: targetUri });
  } else {
    if (audio.requires_auth && !input.accessToken) throw new Error('meeting audio authentication required');
    const remoteUrl = validateMeetingAudioUrl(audio.url, {
      requiresAuth: audio.requires_auth,
      expiresAt: audio.expires_at,
    });
    const result = await FileSystem.downloadAsync(remoteUrl, targetUri, {
      headers: audio.requires_auth && input.accessToken
        ? { Authorization: `Bearer ${input.accessToken}` }
        : undefined,
    });
    if (result.status < 200 || result.status >= 300) {
      throw new Error(`meeting audio download failed: ${result.status}`);
    }
  }
  return { uri: targetUri, mimeType: audio.mime_type || 'audio/wav' };
}

async function shareFile(uri: string, mimeType: string, dialogTitle: string, UTI?: string): Promise<void> {
  if (!(await Sharing.isAvailableAsync())) {
    throw new MeetingShareError('SHARING_UNAVAILABLE', 'system sharing is unavailable');
  }
  await Sharing.shareAsync(uri, { mimeType, dialogTitle, UTI });
}

export async function shareMeetingArtifact(kind: MeetingShareKind, input: MeetingShareInput): Promise<void> {
  await cleanupStaleMeetingShareCache().catch(() => {});
  const { directoryUri, baseName } = await createShareDirectory(input.meeting);
  const summary = meetingSummaryTextToPlainText(input.summaryText?.trim() ?? '');
  const transcript = buildMeetingTranscriptText(input.transcriptLines);
  let archiveUri: string | null = null;
  let shareCompleted = false;

  try {
    if (kind === 'document') {
      const uri = await writeTextFile(
        `${directoryUri}${baseName}_会议文档.txt`,
        buildMeetingDocumentText(input.meeting, input.transcriptLines, summary),
      );
      await shareFile(uri, 'text/plain', '分享会议文档', 'public.plain-text');
      shareCompleted = true;
      return;
    }

    if (kind === 'audio') {
      const audio = await materializeAudio(input, directoryUri, baseName);
      if (!audio) throw new MeetingShareError('NO_AUDIO', 'meeting audio is unavailable');
      await shareFile(audio.uri, audio.mimeType, '分享会议录音', 'public.audio');
      shareCompleted = true;
      return;
    }

    const files = [
      await writeTextFile(`${directoryUri}${baseName}_会议信息.txt`, buildMeetingInfoText(input.meeting)),
    ];
    if (summary) {
      files.push(await writeTextFile(`${directoryUri}${baseName}_会议总结.txt`, summary));
    }
    if (transcript) {
      files.push(await writeTextFile(`${directoryUri}${baseName}_会议转写.txt`, transcript));
    }
    const audio = await materializeAudio(input, directoryUri, baseName);
    if (audio) files.push(audio.uri);
    if (!summary && !transcript && !audio) {
      throw new MeetingShareError('NO_MEETING_CONTENT', 'meeting package has no transcript, summary, or audio');
    }

    archiveUri = `${requireCacheDirectory()}meeting-shares/${baseName}_完整资料_${Date.now()}.zip`;
    const result = await zip(files.map(fileUriToPath), fileUriToPath(archiveUri), BEST_SPEED);
    await shareFile(pathToFileUri(result), 'application/zip', '分享会议完整资料', 'com.pkware.zip-archive');
    shareCompleted = true;
  } finally {
    const artifacts = [directoryUri, archiveUri].filter((uri): uri is string => Boolean(uri));
    if (shareCompleted) {
      artifacts.forEach(uri => scheduleShareArtifactCleanup(uri));
    } else {
      await Promise.allSettled(
        artifacts.map(uri => FileSystem.deleteAsync(uri, { idempotent: true })),
      );
    }
  }
}

export function meetingShareErrorMessage(error: unknown): string {
  const audioSecurityMessage = meetingAudioUrlErrorMessage(error);
  if (audioSecurityMessage) return audioSecurityMessage;
  if (error instanceof MeetingShareError) {
    if (error.code === 'NO_AUDIO') return '当前会议没有可分享的录音文件。';
    if (error.code === 'NO_MEETING_CONTENT') return '当前会议还没有录音、转写或总结，无法生成完整资料包。';
    if (error.code === 'SHARING_UNAVAILABLE') return '当前设备暂不支持系统文件分享。';
  }
  return '分享文件准备失败，请稍后重试。';
}
