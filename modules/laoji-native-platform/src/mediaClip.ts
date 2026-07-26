import { requireOptionalNativeModule } from 'expo-modules-core';

export interface NativeMediaClipCapabilities {
  localWav: true;
  minimumDurationMs: number;
  maximumDurationMs: number;
  adjustmentStepMs: number;
}

export interface NativeWavClipSource {
  sourceUri: string;
  mimeType: 'audio/wav';
  byteSize: number;
  durationMs: number;
}

export interface NativeWavMediaClip {
  meetingId: string;
  clipId: string;
  localUri: string;
  mimeType: 'audio/wav';
  fileName: string;
  byteSize: number;
  durationMs: number;
  checksumSha256: string;
}

interface NativeMediaClipModule {
  getCapabilities(): Promise<unknown>;
  inspectWavSource(sourceUri: string): Promise<unknown>;
  createWavClip(
    sourceUri: string,
    meetingId: string,
    clipId: string,
    startMs: number,
    endMs: number,
  ): Promise<unknown>;
  importRemoteWavClip(
    sourceUri: string,
    meetingId: string,
    clipId: string,
    expectedByteSize: number,
    expectedChecksumSha256: string,
    expectedDurationMs: number,
  ): Promise<unknown>;
  deleteClip(meetingId: string, clipId: string): Promise<boolean>;
}

const nativeModule = requireOptionalNativeModule<NativeMediaClipModule>('LaojiMediaClip');

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`native media clip ${label} is invalid`);
  return value.trim();
}

function requiredInteger(value: unknown, label: string, positive = false): number {
  if (
    typeof value !== 'number'
    || !Number.isSafeInteger(value)
    || value < (positive ? 1 : 0)
  ) throw new Error(`native media clip ${label} is invalid`);
  return value;
}

function requireModule(): NativeMediaClipModule {
  if (!nativeModule) throw new Error('当前版本暂不支持生成音频片段');
  return nativeModule;
}

export function hasNativeMediaClip(): boolean {
  return nativeModule !== null;
}

export async function getNativeMediaClipCapabilities(): Promise<NativeMediaClipCapabilities> {
  const source = record(await requireModule().getCapabilities());
  if (!source || source.localWav !== true) throw new Error('本机音频片段能力无效');
  const minimumDurationMs = requiredInteger(source.minimumDurationMs, 'minimum duration', true);
  const maximumDurationMs = requiredInteger(source.maximumDurationMs, 'maximum duration', true);
  const adjustmentStepMs = requiredInteger(source.adjustmentStepMs, 'adjustment step', true);
  if (maximumDurationMs < minimumDurationMs) throw new Error('本机音频片段时长范围无效');
  return { localWav: true, minimumDurationMs, maximumDurationMs, adjustmentStepMs };
}

export async function inspectNativeWavClipSource(sourceUri: string): Promise<NativeWavClipSource> {
  const source = record(await requireModule().inspectWavSource(sourceUri));
  if (!source || source.mimeType !== 'audio/wav') throw new Error('本机 WAV 录音信息无效');
  return {
    sourceUri: requiredString(source.sourceUri, 'source URI'),
    mimeType: 'audio/wav',
    byteSize: requiredInteger(source.byteSize, 'source bytes', true),
    durationMs: requiredInteger(source.durationMs, 'source duration', true),
  };
}

export async function createNativeWavMediaClip(input: {
  sourceUri: string;
  meetingId: string;
  clipId: string;
  startMs: number;
  endMs: number;
}): Promise<NativeWavMediaClip> {
  const source = record(await requireModule().createWavClip(
    input.sourceUri,
    input.meetingId,
    input.clipId,
    input.startMs,
    input.endMs,
  ));
  if (!source || source.mimeType !== 'audio/wav') throw new Error('本机音频片段结果无效');
  const checksumSha256 = requiredString(source.checksumSha256, 'checksum').toLowerCase();
  if (!/^sha256:[0-9a-f]{64}$/.test(checksumSha256)) throw new Error('本机音频片段校验值无效');
  const meetingId = requiredString(source.meetingId, 'meeting identity');
  const clipId = requiredString(source.clipId, 'clip identity');
  if (meetingId !== input.meetingId || clipId !== input.clipId) {
    throw new Error('本机音频片段身份不一致');
  }
  return {
    meetingId,
    clipId,
    localUri: requiredString(source.localUri, 'local URI'),
    mimeType: 'audio/wav',
    fileName: requiredString(source.fileName, 'file name'),
    byteSize: requiredInteger(source.byteSize, 'bytes', true),
    durationMs: requiredInteger(source.durationMs, 'duration', true),
    checksumSha256,
  };
}

export async function importRemoteWavMediaClip(input: {
  sourceUri: string;
  meetingId: string;
  clipId: string;
  expectedByteSize: number;
  expectedChecksumSha256: string;
  expectedDurationMs: number;
}): Promise<NativeWavMediaClip> {
  const source = record(await requireModule().importRemoteWavClip(
    input.sourceUri,
    input.meetingId,
    input.clipId,
    input.expectedByteSize,
    input.expectedChecksumSha256,
    input.expectedDurationMs,
  ));
  if (!source || source.mimeType !== 'audio/wav') throw new Error('远端音频片段结果无效');
  const checksumSha256 = requiredString(source.checksumSha256, 'checksum').toLowerCase();
  if (!/^sha256:[0-9a-f]{64}$/.test(checksumSha256)) throw new Error('远端音频片段校验值无效');
  const meetingId = requiredString(source.meetingId, 'meeting identity');
  const clipId = requiredString(source.clipId, 'clip identity');
  if (meetingId !== input.meetingId || clipId !== input.clipId) {
    throw new Error('远端音频片段身份不一致');
  }
  if (checksumSha256 !== input.expectedChecksumSha256.toLowerCase()) {
    throw new Error('远端音频片段校验失败');
  }
  return {
    meetingId,
    clipId,
    localUri: requiredString(source.localUri, 'local URI'),
    mimeType: 'audio/wav',
    fileName: requiredString(source.fileName, 'file name'),
    byteSize: requiredInteger(source.byteSize, 'bytes', true),
    durationMs: requiredInteger(source.durationMs, 'duration', true),
    checksumSha256,
  };
}

export async function deleteNativeMediaClip(meetingId: string, clipId: string): Promise<boolean> {
  return requireModule().deleteClip(meetingId, clipId);
}
