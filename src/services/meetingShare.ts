import * as Crypto from 'expo-crypto';
import * as FileSystem from 'expo-file-system/legacy';
import * as Sharing from 'expo-sharing';
import { BEST_SPEED, zip } from 'react-native-zip-archive';
import type {
  MeetingSummaryActionCandidate,
  MeetingSummaryDocument,
  MeetingFactsResultV3,
  MeetingTemplate,
} from '../domain/meeting';
import type { MarkerRecord, MeetingAttachmentRecord } from "../data/repositories/meetingNoteRepository";
import { Meeting, TranscriptLine } from '../types';
import type { MeetingAudioInfo } from './meetingAudioInfo';
import { meetingAudioUrlErrorMessage, validateMeetingAudioUrl } from './meetingAudioSecurity';
import { meetingSummaryTextToPlainText } from './meetingSummaryFormat';
import {
  dedupeMeetingSummaryActions,
  isMeetingSummaryActionSection,
  meetingSummarySectionsForPresentation,
} from './meetingSummaryDocument';
import { diagnosticAudit } from './diagnostics';
import { speakerDisplayLabel } from '../utils/speakerLabels';
import { isStoredMeetingAttachmentUri } from './meetingAttachmentStorage';
import { toSimplifiedChinese } from '../utils/simplifiedChinese';
import { meetingFactsV3Markdown, meetingSummaryV3DocumentMarkdown } from './meetingSummaryV3';

export type MeetingShareContentKey =
  | 'info'
  | 'summary'
  | 'actions'
  | 'transcript'
  | 'markers'
  | 'attachments'
  | 'audio'
  | 'manualNote';

export interface MeetingShareSelection extends Record<MeetingShareContentKey, boolean> {}

export interface MeetingShareAvailability extends Record<MeetingShareContentKey, boolean> {}

export type MeetingShareErrorCode =
  | 'NO_AUDIO'
  | 'NO_MARKERS'
  | 'NO_ATTACHMENTS'
  | 'NO_MEETING_CONTENT'
  | 'SHARING_UNAVAILABLE';
export const MEETING_SHARE_RETENTION_MS = 10 * 60 * 1000;
export const MEETING_SHARE_MANIFEST_SCHEMA_VERSION = 1;

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
  summaryDocument?: MeetingSummaryDocument | null;
  summaryFactsV3?: MeetingFactsResultV3 | null;
  summaryTemplate?: MeetingTemplate | null;
  actionItems?: readonly MeetingSummaryActionCandidate[];
  manualNoteText?: string | null;
  markers?: readonly MarkerRecord[];
  attachments?: readonly MeetingAttachmentRecord[];
  transcriptRevisionId?: string | null;
  summaryVersionId?: string | null;
  audioInfo?: MeetingAudioInfo | null;
}

export interface MeetingShareManifest {
  schema_version: typeof MEETING_SHARE_MANIFEST_SCHEMA_VERSION;
  meeting_ref: string;
  exported_at: string;
  included_contents: MeetingShareContentKey[];
  transcript_revision_id: string | null;
  summary_version_id: string | null;
}

const SHARE_CONTENT_ORDER: readonly MeetingShareContentKey[] = [
  'info',
  'summary',
  'actions',
  'transcript',
  'markers',
  'attachments',
  'audio',
  'manualNote',
];

export function defaultMeetingShareSelection(
  availability: MeetingShareAvailability,
): MeetingShareSelection {
  return {
    info: availability.info,
    summary: availability.summary,
    actions: availability.actions,
    transcript: false,
    markers: false,
    attachments: false,
    audio: false,
    manualNote: false,
  };
}

export function selectedMeetingShareContents(
  selection: MeetingShareSelection,
  availability: MeetingShareAvailability,
): MeetingShareContentKey[] {
  return SHARE_CONTENT_ORDER.filter(key => selection[key] && availability[key]);
}

export function safeMeetingFileName(value: string): string {
  return toSimplifiedChinese(value)
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
  const location = meeting.location?.trim();
  return toSimplifiedChinese([
    `会议标题：${meeting.title.trim() || '无标题会议'}`,
    `会议日期：${meeting.date}`,
    meeting.time?.trim() ? `会议时间：${meeting.time.trim()}` : '',
    location ? `会议地址：${location}` : '',
  ].filter(Boolean).join('\n'));
}

export function buildMeetingTranscriptText(lines: TranscriptLine[]): string {
  return lines
    .filter(line => line.text.trim())
    .map(line => {
      const time = formatTranscriptTime(line.start_time);
      const speaker = speakerDisplayLabel(line.speaker_label, line.speaker_id);
      return `${time ? `[${time}] ` : ''}${toSimplifiedChinese(speaker)}：${toSimplifiedChinese(line.text.trim())}`;
    })
    .join('\n');
}

export function buildMeetingAttachmentsText(
  attachments: readonly MeetingAttachmentRecord[],
): string {
  return attachments.map((attachment, index) => {
    const time = formatTranscriptTime(attachment.positionMs / 1_000);
    const prefix = `${index + 1}. ${time ? `[${time}] ` : ''}`;
    if (attachment.kind === 'text') {
      return `${prefix}文字\n${toSimplifiedChinese(attachment.textContent?.trim() ?? '')}`.trimEnd();
    }
    return `${prefix}照片：${attachment.fileName?.trim() || '照片'}`;
  }).filter(Boolean).join('\n\n');
}

export function buildMeetingMarkersText(markers: readonly MarkerRecord[]): string {
  return markers
    .slice()
    .sort((left, right) => (
      left.positionMs - right.positionMs
      || left.createdAtMs - right.createdAtMs
      || left.id.localeCompare(right.id)
    ))
    .map((marker, index) => {
      const time = formatTranscriptTime(marker.positionMs / 1_000);
      const label = toSimplifiedChinese(marker.label?.normalize('NFKC').replace(/\s+/g, ' ').trim() ?? '');
      return `${index + 1}. ${time || '00:00'}${label ? ` · ${label}` : ''}`;
    })
    .join('\n');
}

function structuredSummaryText(document: MeetingSummaryDocument | null | undefined): string {
  if (!document) return '';
  return meetingSummarySectionsForPresentation(document.sections)
    .filter(section => !isMeetingSummaryActionSection(section))
    .map(section => [section.title?.trim(), toSimplifiedChinese(section.content.trim())].filter(Boolean).join('\n'))
    .filter(Boolean)
    .join('\n\n');
}

function withoutMarkdownActionSections(value: string): string {
  const lines = value.replace(/\r\n?/g, '\n').split('\n');
  const kept: string[] = [];
  let skipping = false;
  lines.forEach(line => {
    const heading = /^\s*#{1,6}\s+(.+?)\s*$/.exec(toSimplifiedChinese(line));
    if (heading) {
      const label = heading[1].trim().replace(/[：:]$/, '');
      skipping = /^(?:待办事项|待办|行动项|行动事项|任务|后续事项|下一步|跟进事项)(?:\s|$)/.test(label)
        || /^(?:todo|action item|task|follow[- ]?up)s?$/i.test(label);
      if (!skipping) kept.push(line);
      return;
    }
    if (!skipping) kept.push(line);
  });
  return kept.join('\n');
}

function selectedSummaryText(input: MeetingShareInput): string {
  if (input.summaryFactsV3 && input.summaryTemplate) {
    return input.summaryDocument?.templateRevision === 3
      && input.summaryDocument.templateId === input.summaryTemplate.id
      ? meetingSummaryV3DocumentMarkdown(input.summaryDocument)
      : meetingFactsV3Markdown(
        input.summaryFactsV3,
        input.summaryTemplate,
        input.summaryDocument?.manualNoteRevision ?? 0,
      );
  }
  const structured = structuredSummaryText(input.summaryDocument);
  if (structured) return meetingSummaryTextToPlainText(structured);
  return meetingSummaryTextToPlainText(withoutMarkdownActionSections(input.summaryText?.trim() ?? ''));
}

function formatActionDate(value: number | null): string | null {
  if (value === null) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return `${date.getFullYear()}年${date.getMonth() + 1}月${date.getDate()}日`;
}

export function buildMeetingActionsText(
  actions: readonly MeetingSummaryActionCandidate[],
): string {
  return dedupeMeetingSummaryActions(actions)
    .filter(action => action.content.trim())
    .map(action => {
      const status = action.status === 'completed'
        ? '已完成'
        : action.status === 'dismissed' ? '已忽略' : '未完成';
      const due = formatActionDate(action.dueAtMs);
      const details = [
        action.assignee?.trim() ? `负责人：${action.assignee.trim()}` : '',
        due ? `截止：${due}` : action.dueText?.trim() ? `截止：${action.dueText.trim()}` : '',
      ].filter(Boolean);
      return `- [${status}] ${toSimplifiedChinese(action.content.trim())}${details.length ? `（${toSimplifiedChinese(details.join('，'))}）` : ''}`;
    })
    .join('\n');
}

type TextShareContent = {
  document: string;
  included: MeetingShareContentKey[];
};

type MeetingShareSection = {
  key: Exclude<MeetingShareContentKey, 'audio'>;
  title: string;
  content: string;
};

function buildSelectedMeetingSections(
  selection: MeetingShareSelection,
  input: MeetingShareInput,
): MeetingShareSection[] {
  const sections: MeetingShareSection[] = [];
  if (selection.info) {
    sections.push({ key: 'info', title: '基本会议信息', content: buildMeetingInfoText(input.meeting) });
  }
  if (selection.summary) {
    const summary = selectedSummaryText(input);
    if (summary) {
      sections.push({ key: 'summary', title: '整理结果', content: summary });
    }
  }
  if (selection.actions) {
    const actions = buildMeetingActionsText(input.actionItems ?? input.summaryDocument?.actionItemCandidates ?? []);
    if (actions) {
      sections.push({ key: 'actions', title: '行动项', content: actions });
    }
  }
  if (selection.transcript) {
    const transcript = buildMeetingTranscriptText(input.transcriptLines);
    if (transcript) {
      sections.push({ key: 'transcript', title: '文字记录', content: transcript });
    }
  }
  if (selection.markers) {
    const markers = buildMeetingMarkersText(input.markers ?? []);
    if (markers) {
      sections.push({ key: 'markers', title: '标记', content: markers });
    }
  }
  if (selection.attachments) {
    const attachments = buildMeetingAttachmentsText(input.attachments ?? []);
    if (attachments) {
      sections.push({ key: 'attachments', title: '附件', content: attachments });
    }
  }
  if (selection.manualNote) {
    const note = input.manualNoteText?.replace(/\r\n?/g, '\n').trim() ?? '';
    if (note) {
      sections.push({ key: 'manualNote', title: '我的笔记', content: note });
    }
  }
  return sections.map(section => ({
    ...section,
    title: toSimplifiedChinese(section.title),
    content: toSimplifiedChinese(section.content),
  }));
}

function buildSelectedMeetingDocument(
  selection: MeetingShareSelection,
  input: MeetingShareInput,
): TextShareContent {
  const sections = buildSelectedMeetingSections(selection, input);
  const markdownSection = (section: MeetingShareSection): string => {
    const content = toSimplifiedChinese(section.content).replace(/^\s*•\s+/gm, '- ');
    if (section.key === 'info') {
      return content.split('\n').filter(Boolean).map(line => `- ${line}`).join('\n');
    }
    return content;
  };
  return {
    document: sections.length > 0
      ? [
          '# 老记会议资料',
          ...sections.map(section => `## ${toSimplifiedChinese(section.title)}\n${markdownSection(section)}`),
        ].join('\n\n')
      : '',
    included: sections.map(section => section.key),
  };
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

function audioExtension(info: MeetingAudioInfo): string {
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

function localAudioMimeType(uri: string): string {
  const extension = uri.split(/[?#]/)[0].match(/\.([A-Za-z0-9]{2,6})$/)?.[1]?.toLowerCase();
  switch (extension) {
    case 'mp3': return 'audio/mpeg';
    case 'm4a': return 'audio/mp4';
    case 'aac': return 'audio/aac';
    case 'ogg': return 'audio/ogg';
    case 'webm': return 'audio/webm';
    case 'flac': return 'audio/flac';
    case 'wav':
    default: return 'audio/wav';
  }
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

export async function buildMeetingShareManifest(
  input: MeetingShareInput,
  included: readonly MeetingShareContentKey[],
  exportedAt = Date.now(),
): Promise<MeetingShareManifest> {
  const meetingHash = await Crypto.digestStringAsync(
    Crypto.CryptoDigestAlgorithm.SHA256,
    input.meeting.id,
  );
  return {
    schema_version: MEETING_SHARE_MANIFEST_SCHEMA_VERSION,
    meeting_ref: meetingHash.slice(0, 16),
    exported_at: new Date(exportedAt).toISOString(),
    included_contents: SHARE_CONTENT_ORDER.filter(key => included.includes(key)),
    transcript_revision_id: input.transcriptRevisionId?.trim()
      || input.summaryDocument?.transcriptRevisionId?.trim()
      || null,
    summary_version_id: input.summaryVersionId?.trim()
      || input.summaryDocument?.remoteVersionId?.trim()
      || null,
  };
}

async function resolveAudioInfo(input: MeetingShareInput): Promise<MeetingAudioInfo | null> {
  if (input.audioInfo) return input.audioInfo;
  const localUri = input.meeting.audioLocalUri;
  if (localUri) {
    try {
      const info = await FileSystem.getInfoAsync(localUri);
      if (info.exists) {
        return {
          url: localUri,
          mime_type: localAudioMimeType(localUri),
          file_name: localUri.split('/').pop() ?? 'meeting.wav',
        };
      }
    } catch {
      // Fall through to the cloud copy when a stale local URI is unavailable.
    }
  }
  return null;
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
    if (audio.requires_auth) throw new Error('meeting audio authentication required');
    const remoteUrl = validateMeetingAudioUrl(audio.url, {
      requiresAuth: audio.requires_auth,
      expiresAt: audio.expires_at,
    });
    const result = await FileSystem.downloadAsync(remoteUrl, targetUri);
    if (result.status < 200 || result.status >= 300) {
      throw new Error(`meeting audio download failed: ${result.status}`);
    }
  }
  return { uri: targetUri, mimeType: audio.mime_type || 'audio/wav' };
}

async function materializeAttachmentImages(
  input: MeetingShareInput,
  directoryUri: string,
  baseName: string,
): Promise<readonly string[]> {
  const images = (input.attachments ?? []).filter(attachment => attachment.kind === 'image');
  const copied: string[] = [];
  for (let index = 0; index < images.length; index += 1) {
    const attachment = images[index];
    if (!isStoredMeetingAttachmentUri(attachment.localUri)) {
      throw new MeetingShareError('NO_ATTACHMENTS', 'meeting attachment file is unavailable');
    }
    const originalName = attachment.fileName?.trim() ?? '';
    const originalExtension = originalName.match(/\.([A-Za-z0-9]{2,5})$/)?.[1]?.toLowerCase();
    const mimeExtension = attachment.mimeType === 'image/jpeg'
      ? 'jpg'
      : attachment.mimeType === 'image/png'
        ? 'png'
        : attachment.mimeType === 'image/webp'
          ? 'webp'
          : attachment.mimeType === 'image/heif' ? 'heif' : 'heic';
    const extension = originalExtension ?? mimeExtension;
    const stem = originalExtension ? originalName.slice(0, -(originalExtension.length + 1)) : originalName;
    const sourceName = `${safeMeetingFileName(stem || `照片_${index + 1}`).slice(0, 40)}.${extension}`;
    const targetUri = `${directoryUri}${baseName}_附件_${String(index + 1).padStart(2, '0')}_${sourceName}`;
    try {
      await FileSystem.copyAsync({ from: attachment.localUri, to: targetUri });
      const info = await FileSystem.getInfoAsync(targetUri);
      if (!info.exists || typeof info.size !== 'number' || info.size < 1) {
        throw new Error('copied meeting attachment is empty');
      }
      copied.push(targetUri);
    } catch {
      throw new MeetingShareError('NO_ATTACHMENTS', 'meeting attachment file is unavailable');
    }
  }
  return copied;
}

async function shareFile(uri: string, mimeType: string, dialogTitle: string, UTI?: string): Promise<void> {
  if (!(await Sharing.isAvailableAsync())) {
    throw new MeetingShareError('SHARING_UNAVAILABLE', 'system sharing is unavailable');
  }
  await Sharing.shareAsync(uri, { mimeType, dialogTitle, UTI });
}

export async function shareMeetingContent(
  selection: MeetingShareSelection,
  input: MeetingShareInput,
): Promise<void> {
  await cleanupStaleMeetingShareCache().catch(() => {});
  const { directoryUri, baseName } = await createShareDirectory(input.meeting);
  let archiveUri: string | null = null;
  let shareCompleted = false;

  try {
    if (selection.attachments && !(input.attachments?.length)) {
      throw new MeetingShareError('NO_ATTACHMENTS', 'meeting attachments are unavailable');
    }
    if (selection.markers && !(input.markers?.length)) {
      throw new MeetingShareError('NO_MARKERS', 'meeting markers are unavailable');
    }
    const textContent = buildSelectedMeetingDocument(selection, input);
    const documentUri = textContent.document
      ? await writeTextFile(`${directoryUri}${baseName}_会议资料.md`, textContent.document)
      : null;
    let audio: { uri: string; mimeType: string } | null = null;
    if (selection.audio) {
      audio = await materializeAudio(input, directoryUri, baseName);
      if (!audio) throw new MeetingShareError('NO_AUDIO', 'meeting audio is unavailable');
    }
    const attachmentFiles = selection.attachments
      ? await materializeAttachmentImages(input, directoryUri, baseName)
      : [];
    const included = [...textContent.included, ...(audio ? ['audio' as const] : [])];
    if (included.length === 0) {
      throw new MeetingShareError('NO_MEETING_CONTENT', 'selected meeting content is unavailable');
    }
    const manifest = await buildMeetingShareManifest(input, included);
    const manifestUri = await writeTextFile(
      `${directoryUri}share_manifest.json`,
      `${JSON.stringify(manifest, null, 2)}\n`,
    );
    const archiveRequired = attachmentFiles.length > 0 || Boolean(audio && documentUri);
    const artifactKind = archiveRequired ? 'archive' : audio ? 'audio' : 'document';
    diagnosticAudit('meeting_share_prepared', {
      included_contents: manifest.included_contents.join('.') || 'none',
      artifact_kind: artifactKind,
    });

    if (archiveRequired) {
      archiveUri = `${requireCacheDirectory()}meeting-shares/${baseName}_会议资料_${Date.now()}.zip`;
      const result = await zip(
        [documentUri, audio?.uri, ...attachmentFiles, manifestUri]
          .filter((uri): uri is string => Boolean(uri))
          .map(fileUriToPath),
        fileUriToPath(archiveUri),
        BEST_SPEED,
      );
      await shareFile(pathToFileUri(result), 'application/zip', '分享会议资料', 'com.pkware.zip-archive');
    } else if (audio) {
      await shareFile(audio.uri, audio.mimeType, '分享会议录音', 'public.audio');
    } else if (documentUri) {
      await shareFile(documentUri, 'text/markdown', '分享会议资料', 'net.daringfireball.markdown');
    }
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
    if (error.code === 'NO_MARKERS') return '所选标记已不存在，请重新选择。';
    if (error.code === 'NO_ATTACHMENTS') return '所选附件暂时无法读取，请稍后重试。';
    if (error.code === 'NO_MEETING_CONTENT') return '所选会议内容当前不可分享，请重新选择。';
    if (error.code === 'SHARING_UNAVAILABLE') return '当前设备暂不支持系统文件分享。';
  }
  return '分享文件准备失败，请稍后重试。';
}
