import { Meeting, TranscriptLine } from '../types';
import { formatDuration } from '../utils/meetingMedia';
import { getAppStorageItem, removeAppStorageItem, setAppStorageItem } from './appStorage';

const PENDING_AUDIO_UPLOADS_KEY = '@laoji:pendingMeetingAudioUploads:v2';
const LEGACY_PENDING_AUDIO_UPLOADS_KEY = '@laoji:pendingMeetingAudioUploads:v1';

export function normalizeRecordingUri(uri: string | undefined): string | undefined {
  if (!uri) return undefined;
  return uri.startsWith('file://') || uri.startsWith('content://') ? uri : `file://${uri}`;
}

export interface FinalizeMeetingRecordingInput {
  meetingId: string;
  storageScope: string;
  transcriptLines: TranscriptLine[];
  isGuest: boolean;
  accessToken?: string | null;
  audioDurationSec?: number;
  audioBars?: number[];
  stopAudio: () => Promise<string | undefined>;
}

export interface FinalizeMeetingRecordingDependencies {
  saveTranscript: (meetingId: string, lines: TranscriptLine[]) => Promise<void>;
  uploadAudio: (meetingId: string, uri: string, accessToken: string) => Promise<unknown>;
  updateStatus: (meetingId: string, status: string, patch: Partial<Meeting>) => Promise<boolean>;
  refreshMeetings: () => Promise<void>;
}

export interface FinalizeMeetingRecordingResult {
  audioUri?: string;
  uploadFailed: boolean;
  retryQueued: boolean;
  statusSyncPending: boolean;
}

export interface PendingMeetingAudioUpload {
  meetingId: string;
  audioUri: string;
  fileName: string;
  mimeType: string;
  createdAt: string;
  lastAttemptAt: string;
  attemptCount: number;
}

type PendingUploadMap = Record<string, PendingMeetingAudioUpload>;
type PendingAudioUploader = (
  pending: PendingMeetingAudioUpload,
  accessToken: string,
) => Promise<unknown>;

let pendingStorageMutation: Promise<void> = Promise.resolve();

export function createMeetingRecordingFinalizer(
  finalize: () => Promise<FinalizeMeetingRecordingResult>,
): () => Promise<FinalizeMeetingRecordingResult> {
  let inFlightOrCompleted: Promise<FinalizeMeetingRecordingResult> | null = null;
  return () => {
    if (inFlightOrCompleted) return inFlightOrCompleted;
    const operation = Promise.resolve().then(finalize);
    inFlightOrCompleted = operation;
    void operation.catch(() => {
      if (inFlightOrCompleted === operation) inFlightOrCompleted = null;
    });
    return operation;
  };
}

export async function getPendingMeetingAudioUpload(
  storageScope: string,
  meetingId: string,
): Promise<PendingMeetingAudioUpload | null> {
  await pendingStorageMutation.catch(() => {});
  return (await readPendingUploads(storageScope))[meetingId] ?? null;
}

export async function retryPendingMeetingAudioUpload(
  storageScope: string,
  meetingId: string,
  accessToken: string,
  uploadAudio: PendingAudioUploader,
): Promise<boolean> {
  const pending = await getPendingMeetingAudioUpload(storageScope, meetingId);
  if (!pending) return false;

  try {
    await uploadAudio(pending, accessToken);
    await clearPendingMeetingAudioUpload(storageScope, meetingId);
    return true;
  } catch (error) {
    await savePendingMeetingAudioUpload(storageScope, pending).catch(() => {});
    throw error;
  }
}

export async function finalizeMeetingRecording(
  input: FinalizeMeetingRecordingInput,
  dependencies: FinalizeMeetingRecordingDependencies,
): Promise<FinalizeMeetingRecordingResult> {
  const [stoppedAudioUri] = await Promise.all([
    input.stopAudio(),
    dependencies.saveTranscript(input.meetingId, input.transcriptLines),
  ]);
  const audioUri = normalizeRecordingUri(stoppedAudioUri);

  let uploadFailed = false;
  let retryQueued = false;
  if (!input.isGuest && audioUri) {
    const pending: PendingMeetingAudioUpload = {
      meetingId: input.meetingId,
      audioUri,
      fileName: `${input.meetingId}.wav`,
      mimeType: 'audio/wav',
      createdAt: new Date().toISOString(),
      lastAttemptAt: new Date().toISOString(),
      attemptCount: 0,
    };
    try {
      await savePendingMeetingAudioUpload(input.storageScope, pending);
      retryQueued = true;
    } catch {
      retryQueued = false;
    }
    if (!input.accessToken) {
      uploadFailed = true;
    } else {
      try {
        await dependencies.uploadAudio(input.meetingId, audioUri, input.accessToken);
        if (retryQueued) {
          try {
            await clearPendingMeetingAudioUpload(input.storageScope, input.meetingId);
            retryQueued = false;
          } catch {
            // A stale retry marker is safer than losing track of a failed upload.
          }
        }
      } catch {
        uploadFailed = true;
        if (!retryQueued) {
          try {
            await savePendingMeetingAudioUpload(input.storageScope, pending);
            retryQueued = true;
          } catch {
            retryQueued = false;
          }
        }
      }
    }
  }

  const meetingPatch: Partial<Meeting> = {
    hasTranscript: input.transcriptLines.length > 0,
    audioAvailable: Boolean(audioUri),
    audioLocalUri: audioUri ?? null,
  };
  if (input.audioDurationSec) {
    meetingPatch.audioDurationSec = input.audioDurationSec;
    meetingPatch.duration = formatDuration(input.audioDurationSec);
  }
  if (input.audioBars?.length) meetingPatch.audioBars = input.audioBars;
  const statusSynced = await dependencies.updateStatus(input.meetingId, 'ended', meetingPatch);
  if (!input.isGuest && input.accessToken && statusSynced) await dependencies.refreshMeetings();

  return {
    audioUri,
    uploadFailed,
    retryQueued,
    statusSyncPending: !input.isGuest && !statusSynced,
  };
}

async function savePendingMeetingAudioUpload(
  storageScope: string,
  pending: PendingMeetingAudioUpload,
): Promise<void> {
  const attemptedAt = new Date().toISOString();
  await mutatePendingUploads(storageScope, records => {
    const existing = records[pending.meetingId];
    records[pending.meetingId] = {
      ...pending,
      createdAt: existing?.createdAt ?? pending.createdAt ?? attemptedAt,
      lastAttemptAt: attemptedAt,
      attemptCount: (existing?.attemptCount ?? pending.attemptCount) + 1,
    };
  });
}

export async function clearPendingMeetingAudioUpload(storageScope: string, meetingId: string): Promise<void> {
  await mutatePendingUploads(storageScope, records => {
    delete records[meetingId];
  });
}

function mutatePendingUploads(storageScope: string, mutator: (records: PendingUploadMap) => void): Promise<void> {
  const storageKey = pendingUploadsKey(storageScope);
  const operation = pendingStorageMutation
    .catch(() => {})
    .then(async () => {
      const records = await readPendingUploads(storageScope);
      mutator(records);
      if (Object.keys(records).length === 0) {
        await removeAppStorageItem(storageKey);
      } else {
        await setAppStorageItem(storageKey, JSON.stringify(records));
      }
      await removeAppStorageItem(LEGACY_PENDING_AUDIO_UPLOADS_KEY).catch(() => {});
    });
  pendingStorageMutation = operation;
  return operation;
}

async function readPendingUploads(storageScope: string): Promise<PendingUploadMap> {
  const raw = await getAppStorageItem(pendingUploadsKey(storageScope));
  if (!raw) return {};
  const parsed = JSON.parse(raw) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('pending meeting audio upload registry is invalid');
  }

  const records: PendingUploadMap = {};
  Object.entries(parsed).forEach(([meetingId, value]) => {
    if (!value || typeof value !== 'object') return;
    const item = value as Partial<PendingMeetingAudioUpload>;
    if (typeof item.audioUri !== 'string' || !item.audioUri) return;
    records[meetingId] = {
      meetingId,
      audioUri: item.audioUri,
      fileName: typeof item.fileName === 'string' && item.fileName ? item.fileName : `${meetingId}.wav`,
      mimeType: typeof item.mimeType === 'string' && item.mimeType ? item.mimeType : 'audio/wav',
      createdAt: typeof item.createdAt === 'string' ? item.createdAt : new Date(0).toISOString(),
      lastAttemptAt: typeof item.lastAttemptAt === 'string' ? item.lastAttemptAt : new Date(0).toISOString(),
      attemptCount: typeof item.attemptCount === 'number' ? item.attemptCount : 0,
    };
  });
  return records;
}

function pendingUploadsKey(storageScope: string): string {
  const normalized = storageScope.trim();
  if (!normalized) throw new Error('meeting recording storage scope is required');
  return `${PENDING_AUDIO_UPLOADS_KEY}:${normalized}`;
}
