import { requireOptionalNativeModule } from 'expo-modules-core';
import type { NativeModule } from 'expo-modules-core';
import { File as ExpoFileSystemFile } from 'expo-file-system';

export type MeetingMediaImportOrigin = 'file_import' | 'share_intent';
export type MeetingMediaIngestOrigin = MeetingMediaImportOrigin | 'recording_merge';

export interface PendingMeetingMediaImportIntent {
  token: string;
  uri: string | null;
  mimeType: string | null;
  fileName: string | null;
  byteSize: number | null;
  lastModifiedMs: number | null;
  fingerprint: string | null;
  receivedAtMs: number;
  errorCode: 'multiple_not_supported' | 'missing_file' | 'unreadable_uri' | 'unsupported_type' | null;
}

export interface IngestedMeetingMedia {
  meetingId: string;
  assetId: string;
  origin: MeetingMediaIngestOrigin;
  localUri: string;
  fileName: string;
  mimeType: string;
  byteSize: number;
  durationMs: number;
  checksumSha256: string;
  sourceLastModifiedMs: number | null;
}

export interface MeetingMediaSourceInfo {
  sourceUri: string;
  fileName: string;
  mimeType: string;
  byteSize: number | null;
  lastModifiedMs: number | null;
}

interface NativeMediaImportEvents {
  [eventName: string]: (...args: any[]) => void;
  onMediaImportIntent: (intent: unknown) => void;
}

interface NativeMediaImportModule extends NativeModule<NativeMediaImportEvents> {
  getPendingMediaImportIntent(): Promise<unknown>;
  acknowledgeMediaImportIntent(token: string): Promise<boolean>;
  inspectMeetingMediaSource(sourceUri: string): Promise<unknown>;
  pickMeetingMedia(includeVideo: boolean): Promise<string>;
  ingestMeetingMedia(
    sourceUri: string,
    meetingId: string,
    assetId: string,
    origin: MeetingMediaIngestOrigin,
    maximumBytes: number,
  ): Promise<unknown>;
  recoverPendingMediaImports(): Promise<unknown>;
  acknowledgeIngestedMeetingMedia(meetingId: string, assetId: string): Promise<boolean>;
  discardIngestedMeetingMedia(meetingId: string, assetId: string): Promise<boolean>;
  addListener(
    eventName: 'onMediaImportIntent',
    listener: NativeMediaImportEvents['onMediaImportIntent'],
  ): { remove(): void };
}

const nativeModule = requireOptionalNativeModule<NativeMediaImportModule>('LaojiMediaImport');

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function optionalString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function optionalNonNegativeInteger(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function requireString(value: unknown, label: string): string {
  const result = optionalString(value);
  if (!result) throw new Error(`native media import ${label} is invalid`);
  return result;
}

function requireNonNegativeInteger(value: unknown, label: string): number {
  const result = optionalNonNegativeInteger(value);
  if (result === null) throw new Error(`native media import ${label} is invalid`);
  return result;
}

function normalizePendingIntent(value: unknown): PendingMeetingMediaImportIntent | null {
  if (value == null) return null;
  const source = record(value);
  if (!source) throw new Error('native media import intent is invalid');
  const errorCode = optionalString(source.errorCode);
  if (errorCode && ![
    'multiple_not_supported',
    'missing_file',
    'unreadable_uri',
    'unsupported_type',
  ].includes(errorCode)) {
    throw new Error('native media import intent error is invalid');
  }
  return {
    token: requireString(source.token, 'intent token'),
    uri: optionalString(source.uri),
    mimeType: optionalString(source.mimeType),
    fileName: optionalString(source.fileName),
    byteSize: optionalNonNegativeInteger(source.byteSize),
    lastModifiedMs: optionalNonNegativeInteger(source.lastModifiedMs),
    fingerprint: optionalString(source.fingerprint),
    receivedAtMs: requireNonNegativeInteger(source.receivedAtMs, 'intent timestamp'),
    errorCode: errorCode as PendingMeetingMediaImportIntent['errorCode'],
  };
}

function normalizeIngestedMedia(value: unknown): IngestedMeetingMedia {
  const source = record(value);
  if (!source) throw new Error('native ingested media result is invalid');
  const origin = requireString(source.origin, 'origin');
  if (origin !== 'file_import' && origin !== 'share_intent' && origin !== 'recording_merge') {
    throw new Error('native ingested media origin is invalid');
  }
  const checksumSha256 = requireString(source.checksumSha256, 'checksum').toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(checksumSha256)) {
    throw new Error('native ingested media checksum is invalid');
  }
  return {
    meetingId: requireString(source.meetingId, 'meeting ID'),
    assetId: requireString(source.assetId, 'asset ID'),
    origin,
    localUri: requireString(source.localUri, 'local URI'),
    fileName: requireString(source.fileName, 'file name'),
    mimeType: requireString(source.mimeType, 'MIME type'),
    byteSize: requireNonNegativeInteger(source.byteSize, 'byte size'),
    durationMs: requireNonNegativeInteger(source.durationMs, 'duration'),
    checksumSha256,
    sourceLastModifiedMs: optionalNonNegativeInteger(source.sourceLastModifiedMs),
  };
}

function normalizeMediaSourceInfo(value: unknown): MeetingMediaSourceInfo {
  const source = record(value);
  if (!source) throw new Error('native media source info is invalid');
  return {
    sourceUri: requireString(source.sourceUri, 'source URI'),
    fileName: requireString(source.fileName, 'file name'),
    mimeType: requireString(source.mimeType, 'MIME type'),
    byteSize: optionalNonNegativeInteger(source.byteSize),
    lastModifiedMs: optionalNonNegativeInteger(source.lastModifiedMs),
  };
}

function requireNativeModule(): NativeMediaImportModule {
  if (!nativeModule) {
    const error = new Error('native media import is unavailable') as Error & { code?: string };
    error.code = 'ERR_MEDIA_IMPORT_UNAVAILABLE';
    throw error;
  }
  return nativeModule;
}

export function hasNativeMeetingMediaImport(): boolean {
  return nativeModule !== null;
}

export async function getPendingMeetingMediaImportIntent(): Promise<PendingMeetingMediaImportIntent | null> {
  return normalizePendingIntent(await requireNativeModule().getPendingMediaImportIntent());
}

export async function acknowledgeMeetingMediaImportIntent(token: string): Promise<boolean> {
  return requireNativeModule().acknowledgeMediaImportIntent(token);
}

export async function inspectMeetingMediaSource(sourceUri: string): Promise<MeetingMediaSourceInfo> {
  return normalizeMediaSourceInfo(await requireNativeModule().inspectMeetingMediaSource(sourceUri));
}

export async function pickMeetingMedia(includeVideo: boolean): Promise<string> {
  try {
    return requireString(
      await requireNativeModule().pickMeetingMedia(includeVideo),
      'selected media URI',
    );
  } catch (reason) {
    const code = reason && typeof reason === 'object'
      ? (reason as { code?: unknown }).code
      : null;
    if (code === 'ERR_PICKER_CANCELLED') throw reason;

    const selected = await ExpoFileSystemFile.pickFileAsync(
      undefined,
      includeVideo ? '*/*' : 'audio/*',
    );
    const file = Array.isArray(selected) ? selected[0] : selected;
    return requireString(file?.uri, 'selected media URI');
  }
}

export async function ingestMeetingMedia(input: {
  sourceUri: string;
  meetingId: string;
  assetId: string;
  origin: MeetingMediaIngestOrigin;
  maximumBytes: number;
}): Promise<IngestedMeetingMedia> {
  if (!Number.isSafeInteger(input.maximumBytes) || input.maximumBytes <= 0) {
    throw new Error('meeting media import maximum size is invalid');
  }
  return normalizeIngestedMedia(await requireNativeModule().ingestMeetingMedia(
    input.sourceUri,
    input.meetingId,
    input.assetId,
    input.origin,
    input.maximumBytes,
  ));
}

export async function recoverPendingMeetingMediaImports(): Promise<IngestedMeetingMedia[]> {
  const value = await requireNativeModule().recoverPendingMediaImports();
  if (!Array.isArray(value)) throw new Error('native media import recovery result is invalid');
  return value.map(normalizeIngestedMedia);
}

export async function acknowledgeIngestedMeetingMedia(
  meetingId: string,
  assetId: string,
): Promise<boolean> {
  return requireNativeModule().acknowledgeIngestedMeetingMedia(meetingId, assetId);
}

export async function discardIngestedMeetingMedia(
  meetingId: string,
  assetId: string,
): Promise<boolean> {
  return requireNativeModule().discardIngestedMeetingMedia(meetingId, assetId);
}

export function addMeetingMediaImportIntentListener(
  listener: (intent: PendingMeetingMediaImportIntent) => void,
) {
  if (!nativeModule) return { remove() {} };
  return nativeModule.addListener('onMediaImportIntent', value => {
    const intent = normalizePendingIntent(value);
    if (intent) listener(intent);
  });
}
