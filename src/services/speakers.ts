import {
  deleteDeviceSpeaker as deleteDeviceSpeakerRemote,
  DeviceApiError,
  listDeviceSpeakers,
  registerDeviceSpeakerAudio,
  supplementDeviceSpeakerAudio,
} from './deviceApi';
import { getAppStorageItem, writeAppStorageJson } from './appStorage';
import { diagnosticAudit, diagnosticWarn } from './diagnostics';


export interface SpeakerProfile {
  speaker_id: string;
  name: string;
  sample_count: number;
  quality: number;
  registered_at?: string | null;
  updated_at?: string | null;
  available_in_realtime?: boolean;
  profile_revision?: number;
  consent_state?: 'granted' | 'revoked';
  consent_version?: string | null;
  model_version?: string;
}

// Display names are user data.  The device service only needs an anonymous
// profile id/embedding, so keep the name-to-id mapping in the phone store.
const LOCAL_DEVICE_SPEAKER_NAMES_KEY = '@laoji:deviceSpeakerNames:v1';
const LOCAL_DEVICE_SPEAKER_PROFILES_KEY = '@laoji:deviceSpeakerProfiles:v1';
const LOCAL_DEVICE_SPEAKER_DELETE_KEY = '@laoji:deviceSpeakerDeleteOutbox:v1';
const SPEAKER_DELETE_MAX_AGE_MS = 31 * 24 * 60 * 60 * 1000;
const SPEAKER_DELETE_MAX_RETRY_DELAY_MS = 15 * 60 * 1000;

type LocalSpeakerNameMap = Record<string, string>;

interface PendingSpeakerDeletion {
  speakerId: string;
  createdAt: string;
  updatedAt: string;
  attempts: number;
  nextAttemptAt?: string;
  lastErrorCode?: string;
}

type PendingSpeakerDeletionMap = Record<string, PendingSpeakerDeletion>;
let speakerDeletionMutation: Promise<void> = Promise.resolve();
let speakerDeletionDrain: Promise<void> | null = null;

function normalizeSpeakerId(value: string): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > 160 || /[\u0000-\u001f\u007f]/.test(normalized)) {
    throw new Error('讲话人标识无效');
  }
  return normalized;
}

async function readPendingSpeakerDeletions(): Promise<PendingSpeakerDeletionMap> {
  const raw = await getAppStorageItem(LOCAL_DEVICE_SPEAKER_DELETE_KEY);
  if (!raw) return {};
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { return {}; }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
  const now = Date.now();
  const result: PendingSpeakerDeletionMap = {};
  Object.entries(parsed).forEach(([key, value]) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return;
    const item = value as Partial<PendingSpeakerDeletion>;
    try {
      const speakerId = normalizeSpeakerId(typeof item.speakerId === 'string' ? item.speakerId : key);
      const createdAt = typeof item.createdAt === 'string' ? item.createdAt : '';
      const createdAtMs = Date.parse(createdAt);
      if (!Number.isFinite(createdAtMs) || now - createdAtMs > SPEAKER_DELETE_MAX_AGE_MS) return;
      result[speakerId] = {
        speakerId,
        createdAt,
        updatedAt: typeof item.updatedAt === 'string' ? item.updatedAt : createdAt,
        attempts: Number.isSafeInteger(item.attempts) && Number(item.attempts) >= 0
          ? Number(item.attempts)
          : 0,
        nextAttemptAt: typeof item.nextAttemptAt === 'string' ? item.nextAttemptAt : undefined,
        lastErrorCode: typeof item.lastErrorCode === 'string' ? item.lastErrorCode.slice(0, 80) : undefined,
      };
    } catch {
      // Ignore one malformed cleanup hint; the local name mapping is already
      // gone and the rest of the speaker list remains usable.
    }
  });
  return result;
}

async function writePendingSpeakerDeletions(records: PendingSpeakerDeletionMap): Promise<void> {
  await writeAppStorageJson(LOCAL_DEVICE_SPEAKER_DELETE_KEY, records, {
    removeIfEmpty: true,
  });
}

function mutatePendingSpeakerDeletions(mutator: (records: PendingSpeakerDeletionMap) => void): Promise<void> {
  const operation = speakerDeletionMutation
    .catch(() => undefined)
    .then(async () => {
      const records = await readPendingSpeakerDeletions();
      mutator(records);
      await writePendingSpeakerDeletions(records);
    });
  speakerDeletionMutation = operation;
  return operation;
}

function speakerDeleteRetryDelay(attempts: number): number {
  const exponent = Math.max(0, Math.min(8, Math.floor(attempts) - 1));
  return Math.min(SPEAKER_DELETE_MAX_RETRY_DELAY_MS, 30_000 * (2 ** exponent));
}

async function enqueueDeviceSpeakerDeletion(speakerId: string): Promise<void> {
  const normalized = normalizeSpeakerId(speakerId);
  const now = new Date().toISOString();
  await mutatePendingSpeakerDeletions(records => {
    const existing = records[normalized];
    records[normalized] = {
      speakerId: normalized,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
      attempts: existing?.attempts ?? 0,
      nextAttemptAt: existing?.nextAttemptAt,
      lastErrorCode: existing?.lastErrorCode,
    };
  });
  diagnosticAudit('device_speaker_delete_enqueued', { speaker_id_suffix: normalized.slice(-8) });
}

export async function drainDeviceSpeakerDeletionOutbox(force = false): Promise<void> {
  if (speakerDeletionDrain) return speakerDeletionDrain;
  speakerDeletionDrain = (async () => {
    const now = Date.now();
    const records = await readPendingSpeakerDeletions();
    for (const item of Object.values(records).slice(0, 8)) {
      if (!force && item.nextAttemptAt && Date.parse(item.nextAttemptAt) > now) continue;
      try {
        await deleteDeviceSpeakerRemote(item.speakerId);
        await mutatePendingSpeakerDeletions(current => {
          if (current[item.speakerId]?.createdAt === item.createdAt) delete current[item.speakerId];
        });
        diagnosticAudit('device_speaker_delete_completed', { speaker_id_suffix: item.speakerId.slice(-8) });
      } catch (error) {
        if (error instanceof DeviceApiError && [404, 409].includes(error.status)) {
          await mutatePendingSpeakerDeletions(current => {
            if (current[item.speakerId]?.createdAt === item.createdAt) delete current[item.speakerId];
          });
          continue;
        }
        const attempts = Math.min(Number.MAX_SAFE_INTEGER, item.attempts + 1);
        const code = error instanceof DeviceApiError
          ? error.code || `HTTP_${error.status}`
          : error instanceof Error ? error.name : 'UNKNOWN';
        await mutatePendingSpeakerDeletions(current => {
          const existing = current[item.speakerId];
          if (!existing || existing.createdAt !== item.createdAt) return;
          current[item.speakerId] = {
            ...existing,
            attempts,
            updatedAt: new Date().toISOString(),
            nextAttemptAt: new Date(Date.now() + speakerDeleteRetryDelay(attempts)).toISOString(),
            lastErrorCode: code,
          };
        });
        diagnosticWarn('[device-speaker-delete] cleanup deferred', error);
      }
    }
  })().catch(error => {
    diagnosticWarn('[device-speaker-delete] outbox drain failed', error);
  }).finally(() => {
    speakerDeletionDrain = null;
  });
  return speakerDeletionDrain;
}

async function loadLocalDeviceSpeakerNames(): Promise<LocalSpeakerNameMap> {
  try {
    const raw = await getAppStorageItem(LOCAL_DEVICE_SPEAKER_NAMES_KEY);
    const value = raw ? JSON.parse(raw) : {};
    if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
    return Object.fromEntries(
      Object.entries(value).filter(([key, name]) => (
        Boolean(key.trim()) && typeof name === 'string' && Boolean(name.trim())
      )).map(([key, name]) => [key, String(name).trim()]),
    );
  } catch {
    return {};
  }
}

export async function getLocalDeviceSpeakerName(speakerId: string | null | undefined): Promise<string | null> {
  const key = String(speakerId || '').trim();
  if (!key) return null;
  const names = await loadLocalDeviceSpeakerNames();
  return names[key] ?? null;
}

async function saveLocalDeviceSpeakerName(speakerId: string, name: string): Promise<void> {
  const names = await loadLocalDeviceSpeakerNames();
  names[speakerId] = name.trim();
  await writeAppStorageJson(LOCAL_DEVICE_SPEAKER_NAMES_KEY, names, { bestEffort: true });
}

async function removeLocalDeviceSpeakerName(speakerId: string): Promise<void> {
  const names = await loadLocalDeviceSpeakerNames();
  if (!Object.prototype.hasOwnProperty.call(names, speakerId)) return;
  delete names[speakerId];
  await writeAppStorageJson(LOCAL_DEVICE_SPEAKER_NAMES_KEY, names, { removeIfEmpty: true, bestEffort: true });
}

async function loadLocalDeviceSpeakerProfiles(): Promise<SpeakerProfile[]> {
  try {
    const raw = await getAppStorageItem(LOCAL_DEVICE_SPEAKER_PROFILES_KEY);
    const value = raw ? JSON.parse(raw) : [];
    if (!Array.isArray(value)) return [];
    return value.flatMap(item => {
      if (!item || typeof item !== 'object' || Array.isArray(item)) return [];
      const speakerId = String((item as any).speaker_id || '').trim();
      if (!speakerId) return [];
      return [deviceSpeakerProfile(item, String((item as any).name || '').trim() || undefined)];
    });
  } catch {
    return [];
  }
}

async function saveLocalDeviceSpeakerProfiles(profiles: readonly SpeakerProfile[]): Promise<void> {
  await writeAppStorageJson(
    LOCAL_DEVICE_SPEAKER_PROFILES_KEY,
    profiles,
    { removeIfEmpty: true, bestEffort: true },
  );
}

async function upsertLocalDeviceSpeakerProfile(profile: SpeakerProfile): Promise<void> {
  const existing = await loadLocalDeviceSpeakerProfiles();
  const next = [
    ...existing.filter(item => item.speaker_id !== profile.speaker_id),
    profile,
  ];
  await saveLocalDeviceSpeakerProfiles(next);
}

async function removeLocalDeviceSpeakerProfile(speakerId: string): Promise<void> {
  const existing = await loadLocalDeviceSpeakerProfiles();
  await saveLocalDeviceSpeakerProfiles(existing.filter(item => item.speaker_id !== speakerId));
}

export interface SpeakerMutationResponse {
  success: boolean;
  speaker: SpeakerProfile;
  quality_level?: string;
  quality_description?: string;
  quality_issues?: string[];
  duration_sec?: number;
}

function deviceSpeakerProfile(value: any, localName?: string): SpeakerProfile {
  const speakerId = String(value?.speaker_id || '');
  return {
    speaker_id: speakerId,
    // A device response deliberately contains only an anonymous label.  A
    // local mapping, when present, is the only source of the user's name.
    name: localName?.trim() || `讲话人 ${speakerId.slice(-4) || '未命名'}`,
    sample_count: Number(value?.sample_count || 0),
    quality: Number(value?.quality || 0),
    profile_revision: Number(value?.profile_revision || 1),
    consent_state: value?.consent_state === 'revoked' ? 'revoked' : 'granted',
    consent_version: value?.consent_version ?? 'voiceprint-v1',
    model_version: value?.model_version ?? 'campplus-v1',
    available_in_realtime: value?.available_in_realtime !== false,
  };
}

export async function fetchDeviceSpeakerProfiles(): Promise<SpeakerProfile[]> {
  const [remote, names, pending, localProfiles] = await Promise.all([
    listDeviceSpeakers()
      .then(data => ({ data, error: null as unknown }))
      .catch(error => ({ data: null, error })),
    loadLocalDeviceSpeakerNames(),
    readPendingSpeakerDeletions(),
    loadLocalDeviceSpeakerProfiles(),
  ]);
  void drainDeviceSpeakerDeletionOutbox();
  const pendingIds = new Set(Object.keys(pending));
  if (remote.error) {
    if (localProfiles.length === 0) throw remote.error;
    return localProfiles.filter(item => !pendingIds.has(item.speaker_id));
  }
  const remoteItems = Array.isArray(remote.data?.items) ? remote.data.items : [];
  const profiles = remoteItems
    .filter((item: any) => !pendingIds.has(String(item?.speaker_id || '').trim()))
    .map((item: any) => {
      const speakerId = String(item?.speaker_id || '').trim();
      const cached = localProfiles.find(profile => profile.speaker_id === speakerId);
      return deviceSpeakerProfile(item, names[speakerId] || cached?.name);
    });
  // A successful empty response is authoritative: it also removes stale
  // cached anonymous profiles after a remote deletion has completed.
  await saveLocalDeviceSpeakerProfiles(profiles);
  return profiles;
}

export async function registerDeviceSpeaker(
  name: string,
  audioUri: string,
  fileName: string,
): Promise<SpeakerMutationResponse> {
  const data = await registerDeviceSpeakerAudio(name, audioUri, fileName);
  const speaker = deviceSpeakerProfile(data?.speaker ?? data, name);
  if (speaker.speaker_id) {
    await saveLocalDeviceSpeakerName(speaker.speaker_id, name);
    await upsertLocalDeviceSpeakerProfile(speaker);
  }
  return { ...data, speaker, success: data?.success !== false };
}

export async function supplementDeviceSpeaker(
  speakerId: string,
  audioUri: string,
  fileName: string,
): Promise<SpeakerMutationResponse> {
  const data = await supplementDeviceSpeakerAudio(speakerId, audioUri, fileName);
  const names = await loadLocalDeviceSpeakerNames();
  const speaker = deviceSpeakerProfile(data?.speaker ?? data, names[speakerId]);
  if (speaker.speaker_id) await upsertLocalDeviceSpeakerProfile(speaker);
  return {
    ...data,
    speaker,
    success: data?.success !== false,
  };
}

export async function renameDeviceSpeaker(
  speakerId: string,
  name: string,
): Promise<SpeakerMutationResponse> {
  const normalized = name.trim();
  if (!normalized) throw new Error('讲话人名称不能为空');
  await saveLocalDeviceSpeakerName(speakerId, normalized);
  const profiles = await fetchDeviceSpeakerProfiles();
  const speaker = profiles.find(item => item.speaker_id === speakerId) ?? {
    speaker_id: speakerId,
    name: normalized,
    sample_count: 0,
    quality: 0,
  };
  const renamed = { ...speaker, name: normalized };
  await upsertLocalDeviceSpeakerProfile(renamed);
  return { success: true, speaker: renamed };
}

export async function deleteDeviceSpeakerProfile(speakerId: string): Promise<void> {
  // The visible name is local data and must disappear even when the service
  // is temporarily offline.  The anonymous server profile is revoked through
  // a durable outbox; deleting a local profile never waits for the network.
  const normalized = normalizeSpeakerId(speakerId);
  await removeLocalDeviceSpeakerName(normalized);
  await removeLocalDeviceSpeakerProfile(normalized);
  // A deletion hint is the only durable bridge between local-first removal
  // and the later service cleanup. Do not swallow a storage failure here: the
  // caller must be able to tell the user that service-side cleanup is not yet
  // queued and offer a retry, instead of presenting a silently orphaned
  // server profile as fully deleted.
  await enqueueDeviceSpeakerDeletion(normalized);
  void drainDeviceSpeakerDeletionOutbox(true);
}
