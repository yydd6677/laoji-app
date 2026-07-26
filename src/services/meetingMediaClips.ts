import * as FileSystem from 'expo-file-system/legacy';
import * as Sharing from 'expo-sharing';
import { BEST_SPEED, zip } from 'react-native-zip-archive';
import {
  createNativeWavMediaClip,
  deleteNativeMediaClip,
  getNativeMediaClipCapabilities,
  hasNativeMediaClip,
  inspectNativeWavClipSource,
} from 'laoji-native-platform';
import {
  completeMeetingMediaClip,
  beginDeletingMeetingMediaClip,
  failMeetingMediaClip,
  finishDeletingMeetingMediaClip,
  insertPendingMeetingMediaClip,
  listMeetingMediaClips,
  markMeetingMediaClipPending,
  sqliteMeetingNoteRepository,
  type RecordingAssetRecord,
} from '../data/repositories';
import {
  assertScopeKey,
  secureClientIdFactory,
  type MeetingMediaClip,
  type MeetingMediaClipDraft,
  type MeetingMediaClipLimits,
  type ScopeKey,
} from '../domain/meeting';

const MARKER_CONTEXT_MS = 5_000;
const TRANSCRIPT_CONTEXT_MS = 1_500;
const SHARE_ROOT = 'meeting-clip-shares';

export type MeetingMediaClipDraftSource =
  | { kind: 'marker'; markerId: string }
  | { kind: 'transcript'; segmentId: string; selectedText?: string | null };

function isWavRecording(asset: RecordingAssetRecord): boolean {
  const mime = asset.mimeType?.trim().toLowerCase() ?? '';
  const fileName = asset.fileName?.trim().toLowerCase() ?? '';
  const localUri = asset.localUri?.trim().toLowerCase() ?? '';
  return mime === 'audio/wav'
    || mime === 'audio/wave'
    || mime === 'audio/x-wav'
    || fileName.endsWith('.wav')
    || localUri.endsWith('.wav');
}

function chooseLocalWavRecording(
  assets: readonly RecordingAssetRecord[],
  preferredAssetId?: string | null,
): RecordingAssetRecord {
  const available = assets.filter(asset => (
    asset.localState === 'local_ready'
    && Boolean(asset.localUri?.trim())
    && isWavRecording(asset)
  ));
  const preferred = preferredAssetId
    ? available.find(asset => asset.id === preferredAssetId)
    : null;
  const selected = preferred
    ?? available.find(asset => asset.role === 'primary')
    ?? available[0]
    ?? null;
  if (!selected) throw new Error('当前会议没有可生成片段的本机 WAV 录音。');
  return selected;
}

function normalizeLimits(value: Awaited<ReturnType<typeof getNativeMediaClipCapabilities>>): MeetingMediaClipLimits {
  return {
    minimumDurationMs: value.minimumDurationMs,
    maximumDurationMs: value.maximumDurationMs,
    adjustmentStepMs: value.adjustmentStepMs,
  };
}

function boundedDefaultRange(input: {
  startMs: number;
  endMs: number;
  sourceDurationMs: number;
  limits: MeetingMediaClipLimits;
}): { startMs: number; endMs: number } {
  const { sourceDurationMs, limits } = input;
  let startMs = Math.max(0, Math.min(Math.floor(input.startMs), sourceDurationMs));
  let endMs = Math.max(startMs, Math.min(Math.ceil(input.endMs), sourceDurationMs));
  if (endMs - startMs < limits.minimumDurationMs) {
    const missing = limits.minimumDurationMs - (endMs - startMs);
    const before = Math.min(startMs, Math.ceil(missing / 2));
    startMs -= before;
    endMs = Math.min(sourceDurationMs, endMs + missing - before);
    if (endMs - startMs < limits.minimumDurationMs) {
      startMs = Math.max(0, endMs - limits.minimumDurationMs);
    }
  }
  if (endMs - startMs > limits.maximumDurationMs) {
    endMs = startMs + limits.maximumDurationMs;
  }
  if (endMs <= startMs || endMs - startMs < limits.minimumDurationMs) {
    throw new Error('当前录音过短，无法生成音频片段。');
  }
  return { startMs, endMs };
}

function normalizedSelectedText(value: string | null | undefined): string | null {
  const text = value?.normalize('NFKC').replace(/\r\n?/g, '\n').trim() ?? '';
  return text ? text.slice(0, 20_000) : null;
}

function distinctSpeakerText(values: readonly (string | null | undefined)[]): string | null {
  const seen = new Set<string>();
  const names: string[] = [];
  values.forEach(value => {
    const name = value?.normalize('NFKC').trim() ?? '';
    if (!name || seen.has(name)) return;
    seen.add(name);
    names.push(name);
  });
  return names.length > 0 ? names.join('、').slice(0, 2_000) : null;
}

export function meetingMediaClipErrorMessage(
  reason: unknown,
  fallback = '音频片段暂时无法生成，请稍后重试。',
): string {
  const source = reason as { code?: unknown; message?: unknown } | null;
  const code = typeof source?.code === 'string' ? source.code.toUpperCase() : '';
  if (code.includes('FORMAT')) return '当前录音格式暂不支持在本机生成片段。';
  if (code.includes('SOURCE_CHANGED')) return '本机录音已发生变化，请重新选择片段。';
  if (code.includes('SOURCE')) return '本机录音无法读取，请稍后重试。';
  if (code.includes('RANGE')) return '片段时间范围无效，请重新调整。';
  if (code.includes('STORAGE')) return '片段文件保存失败，请检查存储空间后重试。';
  const message = typeof source?.message === 'string' ? source.message.trim() : '';
  return message && /[\u3400-\u9fff]/.test(message) ? message : fallback;
}

export function mediaClipPreferredAssetId(playerSourceId: string): string | null {
  return playerSourceId.startsWith('asset:') ? playerSourceId.slice('asset:'.length).trim() || null : null;
}

export async function prepareMeetingMediaClipDraft(input: {
  scopeKey: ScopeKey;
  meetingId: string;
  source: MeetingMediaClipDraftSource;
  preferredRecordingAssetId?: string | null;
}): Promise<MeetingMediaClipDraft> {
  assertScopeKey(input.scopeKey);
  if (!hasNativeMediaClip()) throw new Error('当前版本暂不支持生成音频片段。');
  const aggregate = await sqliteMeetingNoteRepository.findByNativeSessionId(input.meetingId, input.scopeKey);
  if (!aggregate || aggregate.note.lifecycle === 'deleted') throw new Error('会议记录已不可用。');
  const transcript = await sqliteMeetingNoteRepository.getActiveTranscriptContent(
    aggregate.note.id,
    input.scopeKey,
  );
  const segments = transcript?.segments ?? [];
  let sourceMarkerId: string | null = null;
  let sourceSegmentId: string | null = null;
  let sourceSegment: (typeof segments)[number] | null = null;
  let requestedStartMs: number;
  let requestedEndMs: number;
  let selectedText: string | null = null;

  const source = input.source;
  if (source.kind === 'marker') {
    const marker = (await sqliteMeetingNoteRepository.listMeetingMarkers(aggregate.note.id, input.scopeKey))
      .find(candidate => candidate.id === source.markerId);
    if (!marker) throw new Error('标记已发生变化，请刷新后重试。');
    sourceMarkerId = marker.id;
    sourceSegment = marker.nearestSegmentId
      ? segments.find(candidate => candidate.id === marker.nearestSegmentId) ?? null
      : null;
    requestedStartMs = marker.positionMs - MARKER_CONTEXT_MS;
    requestedEndMs = marker.positionMs + MARKER_CONTEXT_MS;
  } else {
    sourceSegment = segments.find(candidate => (
      candidate.id === source.segmentId || candidate.sourceId === source.segmentId
    )) ?? null;
    if (!sourceSegment) throw new Error('文字记录已发生变化，请刷新后重试。');
    sourceSegmentId = sourceSegment.id;
    requestedStartMs = sourceSegment.startMs - TRANSCRIPT_CONTEXT_MS;
    requestedEndMs = Math.max(sourceSegment.endMs, sourceSegment.startMs + 1_000)
      + TRANSCRIPT_CONTEXT_MS;
    selectedText = normalizedSelectedText(source.selectedText) ?? (sourceSegment.text.trim() || null);
  }

  const provenanceAssetId = sourceSegment?.sourceRecordingAssetId ?? null;
  if (aggregate.recordingAssets.length > 1 && !provenanceAssetId) {
    throw new Error(source.kind === 'marker'
      ? '这个标记未关联到具体录音，暂时无法生成片段。'
      : '这段文字未关联到具体录音，暂时无法生成片段。');
  }
  const asset = chooseLocalWavRecording(
    aggregate.recordingAssets,
    provenanceAssetId ?? input.preferredRecordingAssetId,
  );
  if (provenanceAssetId && asset.id !== provenanceAssetId) {
    throw new Error(source.kind === 'marker'
      ? '这个标记对应的本机录音无法读取。'
      : '这段文字对应的本机录音无法读取。');
  }
  const [nativeCapabilities, sourceInfo] = await Promise.all([
    getNativeMediaClipCapabilities(),
    inspectNativeWavClipSource(requireLocalUri(asset)),
  ]);
  const limits = normalizeLimits(nativeCapabilities);
  const transcriptSegmentsForAsset = aggregate.recordingAssets.length <= 1
    ? segments
    : segments.filter(segment => segment.sourceRecordingAssetId === asset.id);

  const range = boundedDefaultRange({
    startMs: requestedStartMs,
    endMs: requestedEndMs,
    sourceDurationMs: sourceInfo.durationMs,
    limits,
  });
  const overlapping = transcriptSegmentsForAsset.filter(segment => (
    segment.endMs >= range.startMs && segment.startMs <= range.endMs
  ));
  const transcriptText = selectedText ?? normalizedSelectedText(
    overlapping.map(segment => segment.text.trim()).filter(Boolean).join('\n'),
  );
  const speakerText = distinctSpeakerText(overlapping.map(segment => (
    segment.speakerLabelOverride ?? segment.speakerLabel
  )));
  return {
    meetingId: aggregate.note.id,
    sourceRecordingAssetId: asset.id,
    sourceRecordingChecksumSha256: asset.checksumSha256,
    sourceRecordingUpdatedAtMs: asset.updatedAtMs,
    sourceKind: source.kind,
    sourceMarkerId,
    sourceSegmentId,
    startMs: range.startMs,
    endMs: range.endMs,
    sourceDurationMs: sourceInfo.durationMs,
    includeSpeaker: speakerText !== null,
    includeText: transcriptText !== null,
    speakerText,
    transcriptText,
    limits,
  };
}

function requireLocalUri(asset: RecordingAssetRecord): string {
  const uri = asset.localUri?.trim();
  if (!uri) throw new Error('本机录音无法读取。');
  return uri;
}

async function exportPendingClip(
  scopeKey: ScopeKey,
  clip: MeetingMediaClip,
): Promise<MeetingMediaClip> {
  let exportedFile = false;
  try {
    const aggregate = await sqliteMeetingNoteRepository.findByNativeSessionId(clip.meetingId, scopeKey);
    if (!aggregate || aggregate.note.lifecycle === 'deleted') throw new Error('会议记录已不可用。');
    const asset = aggregate.recordingAssets.find(candidate => candidate.id === clip.sourceRecordingAssetId);
    if (
      !asset
      || asset.localState !== 'local_ready'
      || asset.updatedAtMs !== clip.sourceRecordingUpdatedAtMs
      || asset.checksumSha256 !== clip.sourceRecordingChecksumSha256
    ) throw new Error('本机录音已发生变化，请重新生成片段。');
    await markMeetingMediaClipPending({
      clipId: clip.id,
      meetingId: clip.meetingId,
      scopeKey,
      updatedAtMs: Date.now(),
    });
    const exported = await createNativeWavMediaClip({
      sourceUri: requireLocalUri(asset),
      meetingId: clip.meetingId,
      clipId: clip.id,
      startMs: clip.startMs,
      endMs: clip.endMs,
    });
    exportedFile = true;
    if (Math.abs(exported.durationMs - (clip.endMs - clip.startMs)) > 1) {
      throw new Error('生成的片段时长与所选范围不一致。');
    }
    return completeMeetingMediaClip({
      clipId: clip.id,
      meetingId: clip.meetingId,
      scopeKey,
      file: exported,
      updatedAtMs: Date.now(),
    });
  } catch (reason) {
    if (exportedFile) {
      await deleteNativeMediaClip(clip.meetingId, clip.id).catch(() => false);
    }
    await failMeetingMediaClip({
      clipId: clip.id,
      meetingId: clip.meetingId,
      scopeKey,
      errorCode: mediaClipErrorCode(reason),
      updatedAtMs: Date.now(),
    }).catch(() => null);
    throw reason;
  }
}

function mediaClipErrorCode(reason: unknown): string {
  const code = (reason as { code?: unknown } | null)?.code;
  if (typeof code === 'string' && /^[A-Za-z0-9_.:-]{1,120}$/.test(code)) return code.toLowerCase();
  return 'export_failed';
}

export async function createMeetingMediaClip(input: {
  scopeKey: ScopeKey;
  draft: MeetingMediaClipDraft;
}): Promise<MeetingMediaClip> {
  assertScopeKey(input.scopeKey);
  const duration = input.draft.endMs - input.draft.startMs;
  if (
    !Number.isSafeInteger(input.draft.startMs)
    || !Number.isSafeInteger(input.draft.endMs)
    || input.draft.startMs < 0
    || input.draft.endMs > input.draft.sourceDurationMs
    || duration < input.draft.limits.minimumDurationMs
    || duration > input.draft.limits.maximumDurationMs
  ) throw new Error('片段时间范围无效，请重新调整。');
  if (input.draft.includeSpeaker && !input.draft.speakerText) throw new Error('当前范围没有可包含的讲话人。');
  if (input.draft.includeText && !input.draft.transcriptText) throw new Error('当前范围没有可包含的文字。');
  const createdAtMs = Date.now();
  const pending = await insertPendingMeetingMediaClip({
    id: secureClientIdFactory.create(),
    meetingId: input.draft.meetingId,
    scopeKey: input.scopeKey,
    sourceRecordingAssetId: input.draft.sourceRecordingAssetId,
    sourceRecordingChecksumSha256: input.draft.sourceRecordingChecksumSha256,
    sourceRecordingUpdatedAtMs: input.draft.sourceRecordingUpdatedAtMs,
    sourceKind: input.draft.sourceKind,
    sourceMarkerId: input.draft.sourceMarkerId,
    sourceSegmentId: input.draft.sourceSegmentId,
    startMs: input.draft.startMs,
    endMs: input.draft.endMs,
    includeSpeaker: input.draft.includeSpeaker,
    includeText: input.draft.includeText,
    speakerText: input.draft.speakerText,
    transcriptText: input.draft.transcriptText,
    createdAtMs,
    updatedAtMs: createdAtMs,
  });
  return exportPendingClip(input.scopeKey, pending);
}

export async function retryMeetingMediaClip(
  scopeKey: ScopeKey,
  clip: MeetingMediaClip,
): Promise<MeetingMediaClip> {
  assertScopeKey(scopeKey);
  if (clip.status === 'ready') return clip;
  if (clip.status === 'deleting') throw new Error('音频片段正在删除。');
  return exportPendingClip(scopeKey, clip);
}

async function resumeInterruptedClip(scopeKey: ScopeKey, clip: MeetingMediaClip): Promise<void> {
  if (clip.status === 'pending') {
    await retryMeetingMediaClip(scopeKey, clip).catch(() => null);
    return;
  }
  if (clip.status === 'deleting') {
    await deleteNativeMediaClip(clip.meetingId, clip.id);
    await finishDeletingMeetingMediaClip({
      clipId: clip.id,
      meetingId: clip.meetingId,
      scopeKey,
    });
  }
}

export async function loadMeetingMediaClipState(
  scopeKey: ScopeKey,
  meetingId: string,
): Promise<{ canonicalMeetingId: string; clips: readonly MeetingMediaClip[] }> {
  assertScopeKey(scopeKey);
  const aggregate = await sqliteMeetingNoteRepository.findByNativeSessionId(meetingId, scopeKey);
  if (!aggregate || aggregate.note.lifecycle === 'deleted') throw new Error('会议记录已不可用。');
  const initial = await listMeetingMediaClips(aggregate.note.id, scopeKey);
  const interrupted = initial.filter(clip => clip.status === 'pending' || clip.status === 'deleting');
  if (interrupted.length > 0) {
    await Promise.all(interrupted.map(clip => resumeInterruptedClip(scopeKey, clip)));
  }
  return {
    canonicalMeetingId: aggregate.note.id,
    clips: await listMeetingMediaClips(aggregate.note.id, scopeKey),
  };
}

export async function deleteMeetingMediaClip(
  scopeKey: ScopeKey,
  clip: MeetingMediaClip,
): Promise<void> {
  assertScopeKey(scopeKey);
  const deleting = await beginDeletingMeetingMediaClip({
    clipId: clip.id,
    meetingId: clip.meetingId,
    scopeKey,
    updatedAtMs: Date.now(),
  });
  if (!deleting) return;
  await deleteNativeMediaClip(clip.meetingId, clip.id);
  const deleted = await finishDeletingMeetingMediaClip({
    clipId: clip.id,
    meetingId: clip.meetingId,
    scopeKey,
  });
  if (!deleted) throw new Error('音频片段已在其他位置更新。');
}

function clipTimeLabel(milliseconds: number): string {
  const totalTenths = Math.max(0, Math.round(milliseconds / 100));
  const hours = Math.floor(totalTenths / 36_000);
  const minutes = Math.floor((totalTenths % 36_000) / 600);
  const seconds = Math.floor((totalTenths % 600) / 10);
  const tenths = totalTenths % 10;
  const base = hours > 0
    ? `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`
    : `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
  return tenths > 0 ? `${base}.${tenths}` : base;
}

function fileUriToPath(uri: string): string {
  return decodeURIComponent(uri.replace(/^file:\/\//, ''));
}

function pathToFileUri(path: string): string {
  return path.startsWith('file://') ? path : `file://${path}`;
}

export async function shareMeetingMediaClip(clip: MeetingMediaClip): Promise<void> {
  if (clip.status !== 'ready' || !clip.localUri || !clip.fileName) {
    throw new Error('音频片段尚未生成完成。');
  }
  if (!await Sharing.isAvailableAsync()) throw new Error('当前设备暂不支持系统文件分享。');
  if (!clip.includeSpeaker && !clip.includeText) {
    await Sharing.shareAsync(clip.localUri, {
      mimeType: 'audio/wav',
      dialogTitle: '分享音频片段',
      UTI: 'com.microsoft.waveform-audio',
    });
    return;
  }
  if (!FileSystem.cacheDirectory) throw new Error('片段分享缓存暂时不可用。');
  const directory = `${FileSystem.cacheDirectory}${SHARE_ROOT}/${clip.id}-${Date.now()}/`;
  const audioUri = `${directory}音频片段.wav`;
  const infoUri = `${directory}片段信息.txt`;
  const archiveUri = `${directory.replace(/\/$/, '')}.zip`;
  try {
    await FileSystem.makeDirectoryAsync(directory, { intermediates: true });
    await FileSystem.copyAsync({ from: clip.localUri, to: audioUri });
    const lines = [
      `时间范围：${clipTimeLabel(clip.startMs)}–${clipTimeLabel(clip.endMs)}`,
      ...(clip.includeSpeaker && clip.speakerText ? [`讲话人：${clip.speakerText}`] : []),
      ...(clip.includeText && clip.transcriptText ? ['', '文字：', clip.transcriptText] : []),
    ];
    await FileSystem.writeAsStringAsync(infoUri, lines.join('\n'), {
      encoding: FileSystem.EncodingType.UTF8,
    });
    const result = await zip(
      [audioUri, infoUri].map(fileUriToPath),
      fileUriToPath(archiveUri),
      BEST_SPEED,
    );
    await Sharing.shareAsync(pathToFileUri(result), {
      mimeType: 'application/zip',
      dialogTitle: '分享音频片段',
      UTI: 'com.pkware.zip-archive',
    });
  } finally {
    await Promise.allSettled([
      FileSystem.deleteAsync(directory, { idempotent: true }),
      FileSystem.deleteAsync(archiveUri, { idempotent: true }),
    ]);
  }
}
