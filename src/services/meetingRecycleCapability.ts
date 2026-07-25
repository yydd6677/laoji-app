import { loadMeetingCapabilities } from '../data/api/v2';

const MEMORY_TTL_MS = 5 * 60 * 1_000;

export interface MeetingRecycleCapability {
  retentionDays: number | null;
  checkedAtMs: number;
}

let cachedToken: string | null = null;
let cachedCapability: MeetingRecycleCapability | null = null;
let inFlight: Promise<MeetingRecycleCapability> | null = null;

async function fetchCapability(accessToken: string): Promise<MeetingRecycleCapability> {
  const state = await loadMeetingCapabilities({
    accessToken,
    forceRefresh: true,
    allowStaleOnError: false,
  });
  const days = state.source === 'remote'
    && state.capabilities.meetingNotesV2
    && Number.isSafeInteger(state.capabilities.softDeleteDays)
    && Number(state.capabilities.softDeleteDays) > 0
    ? Number(state.capabilities.softDeleteDays)
    : null;
  return { retentionDays: days, checkedAtMs: Date.now() };
}

export async function probeMeetingRecycleCapability(
  accessToken: string,
  options: { forceRefresh?: boolean } = {},
): Promise<MeetingRecycleCapability> {
  const token = accessToken.trim();
  if (!token) return { retentionDays: null, checkedAtMs: Date.now() };
  const nowMs = Date.now();
  if (
    !options.forceRefresh
    && cachedToken === token
    && cachedCapability
    && nowMs - cachedCapability.checkedAtMs < MEMORY_TTL_MS
  ) return cachedCapability;
  if (!options.forceRefresh && cachedToken === token && inFlight) return inFlight;

  cachedToken = token;
  cachedCapability = null;
  const request = fetchCapability(token);
  inFlight = request;
  try {
    const result = await request;
    if (cachedToken === token) cachedCapability = result;
    return result;
  } finally {
    if (inFlight === request) inFlight = null;
  }
}

export async function requireFreshMeetingRecycleCapability(
  accessToken: string,
): Promise<number> {
  const capability = await probeMeetingRecycleCapability(accessToken, { forceRefresh: true });
  if (capability.retentionDays === null) {
    throw new Error('当前会议服务暂不支持回收站');
  }
  return capability.retentionDays;
}
