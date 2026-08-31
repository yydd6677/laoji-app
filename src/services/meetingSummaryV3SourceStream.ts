import * as Crypto from 'expo-crypto';
import type {
  MeetingSummaryActivationFenceV3,
  MeetingSummaryAttachmentAuthorization,
} from '../domain/meeting';
import type { TranscriptLine } from '../types';
import {
  ensureLocalMeetingServiceBinding,
  ensureRemoteMeetingServiceBinding,
} from './deviceAuthority';
import { getDeviceAuthorityState } from '../data/repositories/vnext/deviceAuthorityRepository';
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
  type DeviceV2SourceStreamSnapshot,
} from './deviceV2SourceStream';
import { DeviceV2ApiError, loadDeviceV2Capabilities } from './deviceV2Api';
import { parseMeetingFactsResultV3, meetingFactsV3ToSummary } from './meetingSummaryV3';
import type { MeetingSummary } from '../types';
import type { MeetingTemplate } from '../domain/meeting';
import {
  createMeetingSummaryInputChangedError,
  createSummaryV3ActivationFenceError,
} from '../domain/meeting/summaryErrorIdentity';

const MAX_CHAPTER_BYTES = 48 * 1024;
const POLL_LIMIT = 10 * 60 * 1_000;
const SOURCE_ADMISSION_POLL_MS = 1_000;
const SOURCE_ADMISSION_LIMIT = 10 * 60 * 1_000;
const SOURCE_READ_RECOVERY_LIMIT = 60 * 1_000;
const SOURCE_READ_RETRY_MAX_MS = 2_000;
// Keep manifest pages comfortably below the server's 4 MiB byte limit while
// allowing long meetings to resume one page at a time.
const MANIFEST_PAGE_DESCRIPTORS = 512;

function sourceAbortError(): Error {
  const error = new Error('meeting summary cancelled');
  error.name = 'AbortError';
  return error;
}

function sourceTaskPendingError(): Error {
  const error = new Error('正在整理会议记录');
  error.name = 'MeetingSummaryTaskPendingError';
  return error;
}

function requireActiveSourceOperation(signal?: AbortSignal): void {
  if (signal?.aborted) throw sourceAbortError();
}

function sourceDelay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(sourceAbortError());
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(sourceAbortError());
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * Source-stream task reads are recovery reads, not generation ownership.
 * A short mobile-network interruption must leave the durable server task
 * running and reconnect to that same task instead of presenting a false
 * terminal failure or creating another generation.
 */
export function isRetryableSummarySourceReadError(error: unknown): boolean {
  if (error instanceof DeviceV2ApiError) {
    if (error.code?.endsWith('_INVALID')) return false;
    return error.status === 408
      || error.status === 425
      || error.status === 429
      || error.status >= 500;
  }
  const name = error && typeof error === 'object' && typeof (error as { name?: unknown }).name === 'string'
    ? (error as { name: string }).name
    : '';
  if (name === 'AbortError') return false;
  if (name === 'RequestTimeoutError' || name === 'TypeError') return true;
  const message = error instanceof Error ? error.message.toLowerCase() : '';
  return /network|failed to fetch|connection|socket|timeout|timed out/.test(message);
}

async function readSummarySourceWithRecovery<T>(
  read: () => Promise<T>,
  options: {
    signal?: AbortSignal;
    deadline?: number;
    onRetry?: () => void;
  } = {},
): Promise<T> {
  const deadline = options.deadline ?? Date.now() + SOURCE_READ_RECOVERY_LIMIT;
  let attempt = 0;
  while (true) {
    requireActiveSourceOperation(options.signal);
    try {
      return await read();
    } catch (error) {
      requireActiveSourceOperation(options.signal);
      if (!isRetryableSummarySourceReadError(error) || Date.now() >= deadline) throw error;
      options.onRetry?.();
      const delayMs = Math.min(SOURCE_READ_RETRY_MAX_MS, 300 * (2 ** Math.min(attempt, 3)));
      attempt += 1;
      await sourceDelay(delayMs, options.signal);
    }
  }
}

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

async function completedSummaryActivationFence(
  meetingId: string,
  taskId: string,
  stream: DeviceV2SourceStreamSnapshot,
  authorization: MeetingSummaryAttachmentAuthorization | null,
): Promise<MeetingSummaryActivationFenceV3> {
  if (
    stream.task_id !== taskId
    || stream.capability !== 'summary'
    || stream.state !== 'complete'
  ) throw new Error('新版整理任务来源流尚未完整结束。');
  const [authority, binding] = await Promise.all([
    getDeviceAuthorityState(),
    ensureLocalMeetingServiceBinding(meetingId),
  ]);
  if (
    !authority?.epochId
    || authority.epochId !== binding.deviceEpochId
    || stream.binding_id !== binding.bindingId
    || stream.binding_generation !== binding.bindingGeneration
    || stream.binding_revision !== binding.bindingRevision
    || stream.cancel_revision !== binding.cancelRevision
    || binding.state !== 'active'
  ) throw createSummaryV3ActivationFenceError();
  const attachments = (authorization?.items ?? []).map(item => {
    if (item.kind !== 'text') throw new Error('新版整理激活围栏包含不支持的附件。');
    return {
      attachmentId: item.attachmentId,
      positionMs: item.positionMs,
      updatedAtMs: item.updatedAtMs,
      contentSha256: item.contentSha256,
    };
  });
  return {
    deviceEpochId: binding.deviceEpochId,
    bindingId: binding.bindingId,
    bindingGeneration: binding.bindingGeneration,
    bindingRevision: binding.bindingRevision,
    bindingCancelRevision: binding.cancelRevision,
    attachments,
  };
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
    requireActiveSourceOperation(signal);
    const snapshot = await readSummarySourceWithRecovery(
      () => getDeviceV2SourceStream(streamId),
      { signal, deadline },
    );
    if (snapshot.state === 'cancelled' || snapshot.state === 'expired') {
      throw new Error('新版整理来源流已结束');
    }
    if (snapshot.next_consumable_chapter >= requiredCursor) return;
    await sourceDelay(SOURCE_ADMISSION_POLL_MS, signal);
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
    requireActiveSourceOperation(input.signal);
    await waitForSourceChapterSlot(input.streamId, input.ordinal, input.signal);
    try {
      const group = await createDeviceV2SourceBundleGroup({
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
      if (group.state === 'consumed' || group.state === 'committed' || group.state === 'complete') return;
      if (group.state === 'cancelled') throw new Error('新版整理来源章节已取消');
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
      const capacityRetry = error instanceof DeviceV2ApiError
        && (error.status === 409 || error.status === 429)
        && (!error.code || ['SOURCE_GROUP_ORDER', 'SOURCE_GROUP_CAPACITY', 'SOURCE_BYTES_CAPACITY'].includes(error.code));
      if (!capacityRetry && !isRetryableSummarySourceReadError(error)) {
        throw error;
      }
      await sourceDelay(SOURCE_ADMISSION_POLL_MS, input.signal);
    }
  }
  throw new Error('新版整理来源上传等待超时');
}

async function appendSummaryManifestPages(
  stream: DeviceV2SourceStreamSnapshot,
  descriptors: readonly {
    chapter_ordinal: number;
    declared_bundle_count: number;
    declared_item_count: number;
    declared_uncompressed_bytes: number;
    chapter_sha256: string;
  }[],
  signal?: AbortSignal,
): Promise<DeviceV2SourceStreamSnapshot> {
  if (stream.final_chapter_count !== null) {
    if (stream.final_chapter_count !== descriptors.length) {
      throw new Error('新版整理任务来源清单与当前内容不一致。');
    }
    return stream;
  }
  let current = stream;
  while (current.next_manifest_chapter < descriptors.length) {
    requireActiveSourceOperation(signal);
    const firstChapterOrdinal = current.next_manifest_chapter;
    const pageDescriptors = descriptors.slice(
      firstChapterOrdinal,
      firstChapterOrdinal + MANIFEST_PAGE_DESCRIPTORS,
    );
    if (pageDescriptors.length === 0) {
      throw new Error('新版整理任务来源清单游标无效。');
    }
    const finalPage = firstChapterOrdinal + pageDescriptors.length === descriptors.length;
    const pageSha256 = await digest(canonical(pageDescriptors));
    const deadline = Date.now() + SOURCE_ADMISSION_LIMIT;
    while (Date.now() < deadline) {
      requireActiveSourceOperation(signal);
      try {
        current = await appendDeviceV2SourceManifestPage({
          streamId: current.stream_id,
          pageSeq: current.next_manifest_page,
          firstChapterOrdinal,
          descriptors: pageDescriptors,
          pageSha256,
          finalPage,
        });
        break;
      } catch (error) {
        // A page may be accepted before its response is lost; repeating the
        // same page is idempotent. Capacity/order responses are transient
        // while the single source consumer releases an earlier page.
        const capacityRetry = error instanceof DeviceV2ApiError
          && (error.status === 409 || error.status === 429)
          && (!error.code || ['MANIFEST_CAPACITY', 'MANIFEST_BYTES_CAPACITY'].includes(error.code));
        if (!capacityRetry && !isRetryableSummarySourceReadError(error)) {
          throw error;
        }
        await sourceDelay(SOURCE_ADMISSION_POLL_MS, signal);
      }
    }
    if (current.next_manifest_chapter <= firstChapterOrdinal) {
      throw new Error('新版整理任务来源清单上传等待超时。');
    }
  }
  if (current.final_chapter_count !== descriptors.length) {
    throw new Error('新版整理任务来源清单未完成。');
  }
  return current;
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
    const contentSha256 = await digest(content);
    items.push({
      // item_id is a bounded transport alias. The complete stable transcript
      // identity remains in source_id, whose contract explicitly allows 512
      // characters. Embedding sourceId here makes migrated Android identities
      // fail locally before the bundle request is sent.
      item_id: `summary-transcript:${index}:${hex(contentSha256)}`,
      source_type: 'transcript',
      source_id: sourceId,
      source_revision_id: input.transcriptRevision,
      source_start_utf8: 0,
      source_end_utf8: utf8Length(content),
      content_sha256: contentSha256,
      content,
      start_ms: textTime(line.start_time),
      end_ms: textTime(line.end_time),
      speaker: line.speaker_label || null,
    });
  }
  if (input.manualNote.content) {
    const contentSha256 = await digest(input.manualNote.content);
    items.push({
      item_id: `summary-manual-note:${input.manualNote.revision}:${hex(contentSha256)}`,
      source_type: 'manual_note',
      source_id: `manual_note:${input.meetingId}`,
      source_revision_id: `manual_note:${input.manualNote.revision}`,
      source_start_utf8: 0,
      source_end_utf8: utf8Length(input.manualNote.content),
      content_sha256: contentSha256,
      content: input.manualNote.content,
      start_ms: null,
      end_ms: null,
      speaker: null,
    });
  }
  for (const [index, item] of (input.attachmentAuthorization?.items ?? []).entries()) {
    if (item.kind !== 'text') continue;
    items.push({
      item_id: `summary-attachment:${index}:${hex(item.contentSha256)}`,
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
  onTaskPrepared?: (taskId: string) => void | Promise<void>;
  onTaskSubmitted?: (taskId: string) => void | Promise<void>;
}): Promise<MeetingSummary> {
  // Refresh at task creation so a model/prompt deployment cannot reuse the
  // one-minute general capability cache as an old deterministic generation.
  const capabilities = await loadDeviceV2Capabilities({ forceRefresh: true });
  if (!capabilities.sourceStreamV2) throw new Error('来源流整理能力尚未启用');
  const summaryRevisions = {
    handlerRevision: capabilities.summaryHandlerRevision,
    promptRevision: capabilities.summaryPromptRevision,
    modelRevision: capabilities.summaryModelRevision,
  };
  if (!summaryRevisions.handlerRevision || !summaryRevisions.promptRevision || !summaryRevisions.modelRevision) {
    throw new Error('会议整理服务版本信息不完整，请稍后重试');
  }
  if ((options.attachmentAuthorization?.items ?? []).some(item => item.kind !== 'text')) {
    throw new Error('所选照片暂时无法用于新版整理，请仅选择文字附件。');
  }
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
    summary_runtime: {
      handler_revision: summaryRevisions.handlerRevision,
      prompt_revision: summaryRevisions.promptRevision,
      model_revision: summaryRevisions.modelRevision,
    },
  }));
  let taskId = options.resumeTaskId?.trim() || '';
  let stream: Awaited<ReturnType<typeof getDeviceV2SourceStream>> | null = null;
  const createStreamForPreparedTask = async (
    preparedTaskId: string,
    generationId: string,
  ): Promise<Awaited<ReturnType<typeof createDeviceV2SourceStream>>> => {
    // The local recovery pointer must commit before the remote create. Both a
    // fresh submission and a post-crash 404 replay use the exact same task,
    // generation and derived stream identities.
    await options.onTaskPrepared?.(preparedTaskId);
    const binding = await ensureRemoteMeetingServiceBinding(options.meetingId);
    const streamId = `summary-stream:${hex(await digest(preparedTaskId))}`;
    const created = await createDeviceV2SourceStream({
      streamId,
      bindingId: binding.bindingId,
      bindingGeneration: binding.bindingGeneration,
      bindingRevision: binding.bindingRevision,
      cancelRevision: binding.cancelRevision,
      taskId: preparedTaskId,
      clientOperationId: `summary-source:${preparedTaskId}`.slice(0, 180),
      generationId,
      requestSha256: requestSha,
      capability: 'summary',
      entityId: options.meetingId,
      entityRevision: Math.max(1, options.transcriptLines.length),
      taskInputSha256: requestSha,
      summaryRevisions: {
        handlerRevision: summaryRevisions.handlerRevision!,
        promptRevision: summaryRevisions.promptRevision!,
        modelRevision: summaryRevisions.modelRevision!,
      },
    });
    await options.onTaskSubmitted?.(preparedTaskId);
    return created;
  };
  const generationFromPreparedTaskId = (preparedTaskId: string): string => {
    const prefix = `vnext-summary:${options.meetingId}:`;
    const generationId = preparedTaskId.startsWith(prefix)
      ? preparedTaskId.slice(prefix.length)
      : '';
    if (!/^[a-f0-9]{16,128}$/i.test(generationId)) {
      throw new Error('本机整理恢复标识无效，请重新整理。');
    }
    return generationId;
  };
  if (!taskId) {
    let generationId = options.force
      ? hex(await digest(`${requestSha}:${Date.now()}:${Crypto.randomUUID()}`))
      : hex(requestSha);
    taskId = `vnext-summary:${options.meetingId}:${generationId}`.slice(0, 480);
    if (!options.force) {
      try {
        const existingTask = await readSummarySourceWithRecovery(
          () => getDeviceV2Task(taskId),
          { signal: options.signal },
        );
        if (existingTask.task.input_sha256 !== requestSha) {
          throw createMeetingSummaryInputChangedError();
        }
        if (existingTask.task.state === 'success') {
          const resultDeadline = Date.now() + SOURCE_READ_RECOVERY_LIMIT;
          const artifact = await readSummarySourceWithRecovery(
            () => getDeviceV2TaskArtifact(taskId),
            {
              signal: options.signal,
              deadline: resultDeadline,
              onRetry: () => options.onProgress?.('persisting'),
            },
          );
          const parsed = parseMeetingFactsResultV3(artifact.output);
          if (!parsed) throw new Error('新版整理结果格式无效');
          if (
            parsed.promptRevision !== summaryRevisions.promptRevision
            || parsed.modelRevision !== summaryRevisions.modelRevision
          ) throw new Error('会议整理结果版本已变化，请重新整理');
          const sourceStreamId = existingTask.task.source_stream_id;
          if (!sourceStreamId) throw new Error('新版整理任务缺少可恢复的来源流。');
          const completedStream = await readSummarySourceWithRecovery(
            () => getDeviceV2SourceStream(sourceStreamId),
            {
              signal: options.signal,
              deadline: resultDeadline,
              onRetry: () => options.onProgress?.('persisting'),
            },
          );
          return {
            ...meetingFactsV3ToSummary(
              parsed,
              options.template,
              options.manualNote.revision,
              options.transcriptLines,
            ),
            activation_fence_v3: await completedSummaryActivationFence(
              options.meetingId,
              taskId,
              completedStream,
              options.attachmentAuthorization,
            ),
          };
        }
        if (existingTask.task.state === 'active' && existingTask.task.source_stream_id) {
          stream = await readSummarySourceWithRecovery(
            () => getDeviceV2SourceStream(existingTask.task.source_stream_id!),
            { signal: options.signal },
          );
          await options.onTaskSubmitted?.(taskId);
        } else if (existingTask.task.state !== 'active') {
          // A deterministic generation that reached a terminal failure cannot
          // be mutated or rebound. A user retry is a new explicit generation.
          generationId = hex(await digest(`${requestSha}:${Date.now()}:${Crypto.randomUUID()}`));
          taskId = `vnext-summary:${options.meetingId}:${generationId}`.slice(0, 480);
        }
      } catch (reason) {
        if (!(reason instanceof DeviceV2ApiError && reason.status === 404)) throw reason;
      }
    }
    if (!stream) {
      stream = await createStreamForPreparedTask(taskId, generationId);
    }
    options.onProgress?.('preparing');
  } else {
    let resumedTask: Awaited<ReturnType<typeof getDeviceV2Task>> | null = null;
    try {
      resumedTask = await readSummarySourceWithRecovery(
        () => getDeviceV2Task(taskId),
        { signal: options.signal },
      );
    } catch (reason) {
      if (!(reason instanceof DeviceV2ApiError && reason.status === 404)) throw reason;
      // The process stopped after persisting the intent but before remote
      // creation committed. Recreate the exact prepared generation. Falling
      // back to the ordinary deterministic ID here can return an older success
      // and falsely complete a user-requested regeneration.
      stream = await createStreamForPreparedTask(
        taskId,
        generationFromPreparedTaskId(taskId),
      );
      options.onProgress?.('preparing');
    }
    if (resumedTask && resumedTask.task.input_sha256 !== requestSha) {
      throw createMeetingSummaryInputChangedError();
    }
    if (resumedTask?.task.state === 'active') {
      const sourceStreamId = resumedTask.task.source_stream_id;
      if (!sourceStreamId) throw new Error('新版整理任务缺少可恢复的来源流。');
      stream = await readSummarySourceWithRecovery(
        () => getDeviceV2SourceStream(sourceStreamId),
        { signal: options.signal },
      );
      if (stream.task_id !== taskId) throw new Error('新版整理任务与来源流不一致。');
    }
  }
  if (stream && (stream.state === 'open' || stream.state === 'consuming')) {
    options.onProgress?.('preparing');
    const descriptors = await Promise.all(chapterItems.map(async (chapter, ordinal) => ({
      chapter_ordinal: ordinal,
      declared_bundle_count: 1,
      declared_item_count: chapter.length,
      declared_uncompressed_bytes: chapter.reduce((sum, item) => sum + utf8Length(item.content), 0),
      chapter_sha256: await chapterHash([bundleHashes[ordinal]]),
    })));
    stream = await appendSummaryManifestPages(stream, descriptors, options.signal);
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
  const started = Date.now();
  let attempt = 0;
  while (Date.now() - started <= POLL_LIMIT) {
    requireActiveSourceOperation(options.signal);
    const task = await readSummarySourceWithRecovery(
      () => getDeviceV2Task(taskId),
      {
        signal: options.signal,
        deadline: started + POLL_LIMIT,
        onRetry: () => options.onProgress?.('generating'),
      },
    );
    const state = task.task.state;
    options.onProgress?.(state === 'active' ? 'generating' : state === 'success' ? 'persisting' : 'verifying');
    if (state === 'failure' || state === 'cancelled') throw new Error(task.task.error_code || '新版整理任务失败');
    if (state === 'success') {
      const resultDeadline = Date.now() + SOURCE_READ_RECOVERY_LIMIT;
      const artifact = await readSummarySourceWithRecovery(
        () => getDeviceV2TaskArtifact(taskId),
        {
          signal: options.signal,
          deadline: resultDeadline,
          onRetry: () => options.onProgress?.('persisting'),
        },
      );
      const parsed = parseMeetingFactsResultV3(artifact.output);
      if (!parsed) throw new Error('新版整理结果格式无效');
      if (
        parsed.promptRevision !== summaryRevisions.promptRevision
        || parsed.modelRevision !== summaryRevisions.modelRevision
      ) throw new Error('会议整理结果版本已变化，请重新整理');
      const sourceStreamId = task.task.source_stream_id;
      if (!sourceStreamId) throw new Error('新版整理任务缺少可恢复的来源流。');
      const completedStream = await readSummarySourceWithRecovery(
        () => getDeviceV2SourceStream(sourceStreamId),
        {
          signal: options.signal,
          deadline: resultDeadline,
          onRetry: () => options.onProgress?.('persisting'),
        },
      );
      return {
        ...meetingFactsV3ToSummary(
          parsed,
          options.template,
          options.manualNote.revision,
          options.transcriptLines,
        ),
        activation_fence_v3: await completedSummaryActivationFence(
          options.meetingId,
          taskId,
          completedStream,
          options.attachmentAuthorization,
        ),
      };
    }
    await sourceDelay(attempt++ < 4 ? 300 : 1_000, options.signal);
  }
  throw sourceTaskPendingError();
}
