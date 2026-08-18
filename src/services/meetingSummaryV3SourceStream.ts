import * as Crypto from 'expo-crypto';
import type { MeetingSummaryAttachmentAuthorization } from '../domain/meeting';
import type { TranscriptLine } from '../types';
import { ensureRemoteMeetingServiceBinding } from './deviceAuthority';
import {
  appendDeviceV2SourceBundle,
  appendDeviceV2SourceManifestPage,
  commitDeviceV2SourceBundleGroup,
  createDeviceV2SourceBundleGroup,
  createDeviceV2SourceStream,
  getDeviceV2SourceStream,
  getDeviceV2Task,
  getDeviceV2TaskArtifact,
  type SourceBundleItem,
} from './deviceV2SourceStream';
import { DeviceV2ApiError, loadDeviceV2Capabilities } from './deviceV2Api';
import { parseMeetingFactsResultV3, meetingFactsV3ToSummary } from './meetingSummaryV3';
import type { MeetingSummary } from '../types';
import type { MeetingTemplate } from '../domain/meeting';

const MAX_CHAPTER_BYTES = 48 * 1024;
const POLL_LIMIT = 10 * 60 * 1_000;
const SOURCE_ADMISSION_POLL_MS = 1_000;
const SOURCE_ADMISSION_LIMIT = 10 * 60 * 1_000;

function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map(key => `${JSON.stringify(key)}:${canonical(record[key])}`).join(',')}}`;
}

async function digest(value: string): Promise<string> {
  const hash = await Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, value);
  return `sha256:${hash.toLowerCase()}`;
}

function hex(hash: string): string {
  return hash.replace(/^sha256:/, '').slice(0, 32);
}

function utf8Length(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

async function bundleHash(items: readonly SourceBundleItem[]): Promise<string> {
  return digest(canonical(items.map(item => ({
    item_id: item.item_id,
    source_type: item.source_type,
    source_id: item.source_id,
    source_revision_id: item.source_revision_id,
    source_start_utf8: item.source_start_utf8,
    source_end_utf8: item.source_end_utf8,
    content_sha256: item.content_sha256,
    content_bytes: utf8Length(item.content),
    start_ms: item.start_ms ?? null,
    end_ms: item.end_ms ?? null,
    speaker: item.speaker ?? null,
  }))));
}

function chapterHash(bundleHashes: readonly string[]): Promise<string> {
  return digest(canonical(bundleHashes));
}

function textTime(value: number | undefined): number | null {
  if (value === undefined || !Number.isFinite(value)) return null;
  return Math.max(0, Math.round(value * 1_000));
}

async function waitForSourceChapterSlot(
  streamId: string,
  chapterOrdinal: number,
  signal?: AbortSignal,
): Promise<void> {
  // The server admits at most the next two chapter ordinals. Waiting for the
  // consumer cursor before creating the next group keeps the client inside
  // that contract instead of buffering an unbounded long meeting locally.
  const requiredCursor = Math.max(0, chapterOrdinal - 1);
  const deadline = Date.now() + SOURCE_ADMISSION_LIMIT;
  while (Date.now() < deadline) {
    if (signal?.aborted) throw new Error('meeting summary cancelled');
    const snapshot = await getDeviceV2SourceStream(streamId);
    if (snapshot.state === 'cancelled' || snapshot.state === 'expired') {
      throw new Error('新版整理来源流已结束');
    }
    if (snapshot.next_consumable_chapter >= requiredCursor) return;
    await new Promise(resolve => setTimeout(resolve, SOURCE_ADMISSION_POLL_MS));
  }
  throw new Error('新版整理来源上传等待超时');
}

async function uploadSourceChapterWithBackpressure(input: {
  streamId: string;
  taskId: string;
  requestSha: string;
  ordinal: number;
  chapter: readonly SourceBundleItem[];
  bundleHash: string;
  chapterSha: string;
  signal?: AbortSignal;
}): Promise<void> {
  const deadline = Date.now() + SOURCE_ADMISSION_LIMIT;
  const groupId = `summary-source:${input.taskId}:chapter:${input.ordinal}`.slice(0, 180);
  const declaredBytes = input.chapter.reduce((sum, item) => sum + utf8Length(item.content), 0);
  while (Date.now() < deadline) {
    if (input.signal?.aborted) throw new Error('meeting summary cancelled');
    await waitForSourceChapterSlot(input.streamId, input.ordinal, input.signal);
    try {
      await createDeviceV2SourceBundleGroup({
        streamId: input.streamId,
        group: {
          groupId,
          chapterOrdinal: input.ordinal,
          declaredBundleCount: 1,
          declaredItemCount: input.chapter.length,
          declaredUncompressedBytes: declaredBytes,
          chapterSha256: input.chapterSha,
          requestSha256: await digest(`${input.requestSha}:${input.ordinal}`),
        },
      });
      await appendDeviceV2SourceBundle({
        groupId,
        bundle: {
          bundleId: `${groupId}:bundle`,
          ordinal: 0,
          bundleSha256: input.bundleHash,
          items: input.chapter,
        },
      });
      await commitDeviceV2SourceBundleGroup(groupId);
      return;
    } catch (error) {
      // Creation, append, and commit are idempotent by their stable IDs. A
      // concurrent consumer may temporarily close the admission window;
      // refresh the cursor and retry only bounded capacity/order responses.
      if (!(error instanceof DeviceV2ApiError)
        || (error.status !== 409 && error.status !== 429)
        || (error.code && !['SOURCE_GROUP_ORDER', 'SOURCE_GROUP_CAPACITY', 'SOURCE_BYTES_CAPACITY'].includes(error.code))) {
        throw error;
      }
      await new Promise(resolve => setTimeout(resolve, SOURCE_ADMISSION_POLL_MS));
    }
  }
  throw new Error('新版整理来源上传等待超时');
}

export async function buildSummarySourceItems(input: {
  meetingId: string;
  transcriptRevision: string;
  transcriptLines: readonly TranscriptLine[];
  manualNote: { content: string; revision: number };
  attachmentAuthorization: MeetingSummaryAttachmentAuthorization | null;
}): Promise<SourceBundleItem[]> {
  const items: SourceBundleItem[] = [];
  for (const [index, line] of input.transcriptLines.entries()) {
    const content = String(line.text ?? '');
    if (!content) continue;
    const sourceId = String(line.id || `line-${index}`);
    items.push({
      item_id: `transcript:${sourceId}:${index}`,
      source_type: 'transcript',
      source_id: sourceId,
      source_revision_id: input.transcriptRevision,
      source_start_utf8: 0,
      source_end_utf8: utf8Length(content),
      content_sha256: await digest(content),
      content,
      start_ms: textTime(line.start_time),
      end_ms: textTime(line.end_time),
      speaker: line.speaker_label || null,
    });
  }
  if (input.manualNote.content) {
    items.push({
      item_id: `manual_note:${input.meetingId}:${input.manualNote.revision}`,
      source_type: 'manual_note',
      source_id: `manual_note:${input.meetingId}`,
      source_revision_id: `manual_note:${input.manualNote.revision}`,
      source_start_utf8: 0,
      source_end_utf8: utf8Length(input.manualNote.content),
      content_sha256: await digest(input.manualNote.content),
      content: input.manualNote.content,
      start_ms: null,
      end_ms: null,
      speaker: null,
    });
  }
  for (const item of input.attachmentAuthorization?.items ?? []) {
    if (item.kind !== 'text') continue;
    items.push({
      item_id: `attachment:${item.attachmentId}:${item.updatedAtMs}`,
      source_type: 'attachment',
      source_id: item.attachmentId,
      source_revision_id: String(item.updatedAtMs),
      source_start_utf8: 0,
      source_end_utf8: utf8Length(item.content),
      content_sha256: await digest(item.content),
      content: item.content,
      start_ms: item.positionMs,
      end_ms: item.positionMs,
      speaker: null,
    });
  }
  if (items.length === 0) throw new Error('会议来源为空');
  return items;
}

export async function summarySourceRevision(input: {
  meetingId: string;
  transcriptLines: readonly TranscriptLine[];
  manualNote: { content: string; revision: number };
  attachmentAuthorization: MeetingSummaryAttachmentAuthorization | null;
}): Promise<string> {
  const attachments = (input.attachmentAuthorization?.items ?? []).map(item => ({
    id: item.attachmentId,
    revision: item.updatedAtMs,
    hash: item.kind === 'text' ? item.contentSha256 : item.checksumSha256,
    kind: item.kind,
  }));
  return digest(canonical({
    meeting_id: input.meetingId,
    transcript: input.transcriptLines.map(line => ({
      id: line.id,
      text: line.text,
      start: line.start_time ?? null,
      end: line.end_time ?? null,
      speaker: line.speaker_label ?? null,
    })),
    manual_note: {
      revision: input.manualNote.revision,
      content: input.manualNote.content,
    },
    attachments,
  }));
}

function chapters(items: readonly SourceBundleItem[]): SourceBundleItem[][] {
  const result: SourceBundleItem[][] = [];
  let current: SourceBundleItem[] = [];
  let bytes = 0;
  for (const item of items) {
    const itemBytes = utf8Length(item.content);
    if (current.length > 0 && bytes + itemBytes > MAX_CHAPTER_BYTES) {
      result.push(current);
      current = [];
      bytes = 0;
    }
    current.push(item);
    bytes += itemBytes;
  }
  if (current.length > 0) result.push(current);
  return result;
}

export async function generateMeetingSummaryViaSourceStream(options: {
  meetingId: string;
  transcriptLines: readonly TranscriptLine[];
  transcriptRevision: string;
  manualNote: { content: string; revision: number };
  attachmentAuthorization: MeetingSummaryAttachmentAuthorization | null;
  template: MeetingTemplate;
  force: boolean;
  resumeTaskId?: string;
  signal?: AbortSignal;
  onProgress?: (stage: 'queued' | 'preparing' | 'generating' | 'verifying' | 'persisting') => void;
  onTaskSubmitted?: (taskId: string) => void | Promise<void>;
}): Promise<MeetingSummary> {
  const capabilities = await loadDeviceV2Capabilities();
  if (!capabilities.sourceStreamV2) throw new Error('来源流整理能力尚未启用');
  if ((options.attachmentAuthorization?.items ?? []).some(item => item.kind !== 'text')) {
    throw new Error('所选照片暂时无法用于新版整理，请仅选择文字附件。');
  }
  let taskId = options.resumeTaskId?.trim() || '';
  if (!taskId) {
    const binding = await ensureRemoteMeetingServiceBinding(options.meetingId);
    const items = await buildSummarySourceItems({
      meetingId: options.meetingId,
      transcriptRevision: options.transcriptRevision,
      transcriptLines: options.transcriptLines,
      manualNote: options.manualNote,
      attachmentAuthorization: options.attachmentAuthorization,
    });
    const chapterItems = chapters(items);
    const bundleHashes = await Promise.all(chapterItems.map(bundleHash));
    const requestSha = await digest(canonical({
      meeting_id: options.meetingId,
      transcript_revision: options.transcriptRevision,
      manual_note_revision: options.manualNote.revision,
      bundles: bundleHashes,
    }));
    const generationId = options.force
      ? hex(await digest(`${requestSha}:${Date.now()}:${Crypto.randomUUID()}`))
      : hex(requestSha);
    taskId = `vnext-summary:${options.meetingId}:${generationId}`.slice(0, 480);
    const stream = await createDeviceV2SourceStream({
      bindingId: binding.bindingId,
      bindingGeneration: binding.bindingGeneration,
      bindingRevision: binding.bindingRevision,
      cancelRevision: binding.cancelRevision,
      taskId,
      clientOperationId: `summary-source:${taskId}`.slice(0, 180),
      generationId,
      requestSha256: requestSha,
      capability: 'summary',
      entityId: options.meetingId,
      entityRevision: Math.max(1, options.transcriptLines.length),
      taskInputSha256: requestSha,
    });
    await options.onTaskSubmitted?.(taskId);
    options.onProgress?.('preparing');
    if (stream.state === 'open') {
      const descriptors = await Promise.all(chapterItems.map(async (chapter, ordinal) => ({
        chapter_ordinal: ordinal,
        declared_bundle_count: 1,
        declared_item_count: chapter.length,
        declared_uncompressed_bytes: chapter.reduce((sum, item) => sum + utf8Length(item.content), 0),
        chapter_sha256: await chapterHash([bundleHashes[ordinal]]),
      })));
      await appendDeviceV2SourceManifestPage({
        streamId: stream.stream_id,
        pageSeq: 0,
        firstChapterOrdinal: 0,
        descriptors,
        pageSha256: await digest(canonical(descriptors)),
        finalPage: true,
      });
      for (const [ordinal, chapter] of chapterItems.entries()) {
        await uploadSourceChapterWithBackpressure({
          streamId: stream.stream_id,
          taskId,
          requestSha,
          ordinal,
          chapter,
          bundleHash: bundleHashes[ordinal],
          chapterSha: descriptors[ordinal].chapter_sha256,
          signal: options.signal,
        });
      }
    }
  }
  const started = Date.now();
  let attempt = 0;
  while (Date.now() - started <= POLL_LIMIT) {
    if (options.signal?.aborted) throw new Error('meeting summary cancelled');
    const task = await getDeviceV2Task(taskId);
    const state = task.task.state;
    options.onProgress?.(state === 'active' ? 'generating' : state === 'success' ? 'persisting' : 'verifying');
    if (state === 'failure' || state === 'cancelled') throw new Error(task.task.error_code || '新版整理任务失败');
    if (state === 'success') {
      const artifact = await getDeviceV2TaskArtifact(taskId);
      const parsed = parseMeetingFactsResultV3(artifact.output);
      if (!parsed) throw new Error('新版整理结果格式无效');
      return meetingFactsV3ToSummary(parsed, options.template, options.manualNote.revision);
    }
    await new Promise(resolve => setTimeout(resolve, attempt++ < 4 ? 300 : 1_000));
  }
  throw new Error('新版整理任务仍在后台进行');
}
