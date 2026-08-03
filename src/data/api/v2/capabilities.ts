import { getAppStorageItem, setAppStorageItem } from '../../../services/appStorage';
import { getApiConfig } from '../../../services/config';
import { readResponseError } from '../../../services/errors';
import { fetchWithTimeout, readJsonWithTimeout } from '../../../services/http';
import {
  LEGACY_MEETING_CAPABILITIES,
  type MeetingCapabilities,
} from './contracts';

const CAPABILITY_CACHE_KEY = '@laoji:meetingCapabilities:v1';
const CAPABILITY_CACHE_TTL_MS = 6 * 60 * 60 * 1000;

type CapabilityCache = {
  fetchedAtMs: number;
  capabilities: MeetingCapabilities;
};

export interface MeetingCapabilityState {
  capabilities: MeetingCapabilities;
  source: 'remote' | 'cache' | 'legacy';
  fetchedAtMs: number | null;
}

export interface LoadMeetingCapabilitiesOptions {
  accessToken?: string | null;
  forceRefresh?: boolean;
  allowStaleOnError?: boolean;
  nowMs?: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function booleanField(record: Record<string, unknown>, key: string): boolean {
  return record[key] === true;
}

function normalizeCapabilities(value: unknown): MeetingCapabilities {
  if (!isRecord(value)) throw new Error('meeting capabilities response is invalid');
  const schemaVersion = Number(value.schema_version);
  if (!Number.isSafeInteger(schemaVersion) || schemaVersion < 1) {
    throw new Error('meeting capabilities schema version is invalid');
  }
  const media = isRecord(value.media_import) ? value.media_import : null;
  const mimeTypes = media && Array.isArray(media.mime_types)
    ? media.mime_types.filter((item): item is string => typeof item === 'string' && item.length > 0)
    : [];
  const maxBytes = Number(media?.max_bytes ?? 0);
  const mediaClips = isRecord(value.media_clips_v1) ? value.media_clips_v1 : null;
  const clipMinimum = Number(mediaClips?.minimum_duration_ms ?? 0);
  const clipMaximum = Number(mediaClips?.maximum_duration_ms ?? 0);
  const clipStep = Number(mediaClips?.adjustment_step_ms ?? 0);
  const softDeleteDays = typeof value.soft_delete_days === 'number'
    ? value.soft_delete_days
    : Number.NaN;
  return {
    schemaVersion,
    meetingNotesV2: booleanField(value, 'meeting_notes_v2'),
    structuredSummaryV2: booleanField(value, 'structured_summary_v2'),
    summaryCitations: booleanField(value, 'summary_citations'),
    summaryVersionsV1: booleanField(value, 'summary_versions_v1'),
    summaryAttachmentsText: booleanField(value, 'summary_attachments_text'),
    summaryAttachmentsImage: booleanField(value, 'summary_attachments_image'),
    meetingAttachmentsV1: booleanField(value, 'meeting_attachments_v1'),
    meetingMarkersV1: booleanField(value, 'meeting_markers_v1'),
    meetingQuestionsV1: booleanField(value, 'meeting_questions_v1'),
    actionItemsV2: booleanField(value, 'action_items_v2'),
    actionItemsPullV2: booleanField(value, 'action_items_pull_v2'),
    actionCollaborationV1: booleanField(value, 'action_collaboration_v1'),
    meetingContentSharesV1: booleanField(value, 'meeting_content_shares_v1'),
    recordingAssetsV2: booleanField(value, 'recording_assets_v2'),
    transcriptReprocessV1: booleanField(value, 'transcript_reprocess_v1'),
    manualNotesV2: booleanField(value, 'manual_notes_v2'),
    meetingTagsV1: booleanField(value, 'meeting_tags_v1'),
    occurrenceLinksV2: booleanField(value, 'occurrence_links_v2'),
    speakerCorrections: booleanField(value, 'speaker_corrections'),
    mediaImport: media && Number.isSafeInteger(maxBytes) && maxBytes > 0
      ? { mimeTypes, maxBytes }
      : null,
    mediaClips: mediaClips
      && mediaClips.output_mime_type === 'audio/wav'
      && Number.isSafeInteger(clipMinimum) && clipMinimum > 0
      && Number.isSafeInteger(clipMaximum) && clipMaximum >= clipMinimum
      && Number.isSafeInteger(clipStep) && clipStep > 0
      ? {
        minimumDurationMs: clipMinimum,
        maximumDurationMs: clipMaximum,
        adjustmentStepMs: clipStep,
        outputMimeType: 'audio/wav',
      }
      : null,
    syncCursor: booleanField(value, 'sync_cursor'),
    softDeleteDays: Number.isSafeInteger(softDeleteDays) && softDeleteDays >= 0
      ? softDeleteDays
      : null,
  };
}

async function readCache(): Promise<CapabilityCache | null> {
  const raw = await getAppStorageItem(CAPABILITY_CACHE_KEY);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!isRecord(parsed) || !Number.isFinite(parsed.fetchedAtMs)) return null;
    return {
      fetchedAtMs: Number(parsed.fetchedAtMs),
      capabilities: normalizeCapabilities({
        schema_version: isRecord(parsed.capabilities) ? parsed.capabilities.schemaVersion : undefined,
        meeting_notes_v2: isRecord(parsed.capabilities) ? parsed.capabilities.meetingNotesV2 : undefined,
        structured_summary_v2: isRecord(parsed.capabilities) ? parsed.capabilities.structuredSummaryV2 : undefined,
        summary_citations: isRecord(parsed.capabilities) ? parsed.capabilities.summaryCitations : undefined,
        summary_versions_v1: isRecord(parsed.capabilities)
          ? parsed.capabilities.summaryVersionsV1
          : undefined,
        summary_attachments_text: isRecord(parsed.capabilities)
          ? parsed.capabilities.summaryAttachmentsText
          : undefined,
        summary_attachments_image: isRecord(parsed.capabilities)
          ? parsed.capabilities.summaryAttachmentsImage
          : undefined,
        meeting_attachments_v1: isRecord(parsed.capabilities)
          ? parsed.capabilities.meetingAttachmentsV1
          : undefined,
        meeting_markers_v1: isRecord(parsed.capabilities)
          ? parsed.capabilities.meetingMarkersV1
          : undefined,
        meeting_questions_v1: isRecord(parsed.capabilities)
          ? parsed.capabilities.meetingQuestionsV1
          : undefined,
        action_items_v2: isRecord(parsed.capabilities) ? parsed.capabilities.actionItemsV2 : undefined,
        action_items_pull_v2: isRecord(parsed.capabilities)
          ? parsed.capabilities.actionItemsPullV2
          : undefined,
        action_collaboration_v1: isRecord(parsed.capabilities)
          ? parsed.capabilities.actionCollaborationV1
          : undefined,
        meeting_content_shares_v1: isRecord(parsed.capabilities)
          ? parsed.capabilities.meetingContentSharesV1
          : undefined,
        recording_assets_v2: isRecord(parsed.capabilities)
          ? parsed.capabilities.recordingAssetsV2
          : undefined,
        transcript_reprocess_v1: isRecord(parsed.capabilities)
          ? parsed.capabilities.transcriptReprocessV1
          : undefined,
        manual_notes_v2: isRecord(parsed.capabilities) ? parsed.capabilities.manualNotesV2 : undefined,
        meeting_tags_v1: isRecord(parsed.capabilities) ? parsed.capabilities.meetingTagsV1 : undefined,
        occurrence_links_v2: isRecord(parsed.capabilities)
          ? parsed.capabilities.occurrenceLinksV2
          : undefined,
        speaker_corrections: isRecord(parsed.capabilities) ? parsed.capabilities.speakerCorrections : undefined,
        media_import: isRecord(parsed.capabilities) && isRecord(parsed.capabilities.mediaImport)
          ? {
            mime_types: parsed.capabilities.mediaImport.mimeTypes,
            max_bytes: parsed.capabilities.mediaImport.maxBytes,
          }
          : null,
        media_clips_v1: isRecord(parsed.capabilities) && isRecord(parsed.capabilities.mediaClips)
          ? {
            minimum_duration_ms: parsed.capabilities.mediaClips.minimumDurationMs,
            maximum_duration_ms: parsed.capabilities.mediaClips.maximumDurationMs,
            adjustment_step_ms: parsed.capabilities.mediaClips.adjustmentStepMs,
            output_mime_type: parsed.capabilities.mediaClips.outputMimeType,
          }
          : null,
        sync_cursor: isRecord(parsed.capabilities) ? parsed.capabilities.syncCursor : undefined,
        soft_delete_days: isRecord(parsed.capabilities) ? parsed.capabilities.softDeleteDays : undefined,
      }),
    };
  } catch {
    return null;
  }
}

async function fetchRemoteCapabilities(accessToken?: string | null): Promise<MeetingCapabilities> {
  const base = getApiConfig().meetingApiBase.replace(/\/+$/, '');
  const response = await fetchWithTimeout(`${base}/api/laoji/capabilities`, {
    headers: {
      Accept: 'application/json',
      ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
    },
  });
  if (!response.ok) {
    throw await readResponseError('capabilities failed', response, {
      unauthorizedToken: accessToken ?? undefined,
    });
  }
  return normalizeCapabilities(await readJsonWithTimeout<unknown>(response, 10_000));
}

export async function loadMeetingCapabilities(
  options: LoadMeetingCapabilitiesOptions = {},
): Promise<MeetingCapabilityState> {
  const nowMs = options.nowMs ?? Date.now();
  const cache = await readCache();
  if (!options.forceRefresh && cache && nowMs - cache.fetchedAtMs < CAPABILITY_CACHE_TTL_MS) {
    return { capabilities: cache.capabilities, source: 'cache', fetchedAtMs: cache.fetchedAtMs };
  }
  try {
    const capabilities = await fetchRemoteCapabilities(options.accessToken);
    await setAppStorageItem(CAPABILITY_CACHE_KEY, JSON.stringify({ fetchedAtMs: nowMs, capabilities }));
    return { capabilities, source: 'remote', fetchedAtMs: nowMs };
  } catch (error) {
    if (cache && options.allowStaleOnError !== false) {
      return { capabilities: cache.capabilities, source: 'cache', fetchedAtMs: cache.fetchedAtMs };
    }
    if (!options.forceRefresh) {
      return { capabilities: LEGACY_MEETING_CAPABILITIES, source: 'legacy', fetchedAtMs: null };
    }
    throw error;
  }
}

export async function requireFreshMeetingCapability(
  capability: keyof Pick<
    MeetingCapabilities,
    'meetingNotesV2' | 'structuredSummaryV2' | 'summaryCitations' | 'summaryVersionsV1' | 'summaryAttachmentsText' | 'summaryAttachmentsImage' | 'meetingAttachmentsV1' | 'meetingMarkersV1' | 'meetingQuestionsV1' | 'actionItemsV2' | 'actionItemsPullV2' | 'meetingContentSharesV1' | 'recordingAssetsV2' | 'transcriptReprocessV1' | 'manualNotesV2' | 'meetingTagsV1' | 'occurrenceLinksV2' | 'speakerCorrections' | 'syncCursor'
  >,
  accessToken?: string | null,
): Promise<MeetingCapabilities> {
  const state = await loadMeetingCapabilities({
    accessToken,
    forceRefresh: true,
    allowStaleOnError: false,
  });
  if (!state.capabilities[capability]) {
    throw new Error('该功能暂未由当前服务提供');
  }
  return state.capabilities;
}
