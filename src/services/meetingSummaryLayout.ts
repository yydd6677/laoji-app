import type { MeetingSummaryDocument, MeetingSummarySection } from '../domain/meeting';
import { getAppStorageItem, writeAppStorageJson } from './appStorage';

const STORAGE_KEY = '@laoji:meeting-summary-layout:v1';
const MAX_MEETINGS = 250;
const MAX_HIDDEN_BLOCKS = 16;
const FIXED_BLOCK_KEYS = new Set(['general:overview', 'general:themes']);

type StoredLayout = {
  hiddenKeys: string[];
  updatedAtMs: number;
};

type StoredLayouts = Record<string, StoredLayout>;

let layoutsPromise: Promise<StoredLayouts> | null = null;
let layoutMutationChain: Promise<void> = Promise.resolve();

function safeBlockKey(value: unknown): value is string {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= 120
    && /^general:[a-z0-9_-]+$/i.test(value);
}

function parseLayouts(value: string | null): StoredLayouts {
  if (!value) return {};
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const entries = Object.entries(parsed as Record<string, unknown>)
      .flatMap(([meetingId, raw]) => {
        if (!meetingId.trim() || meetingId.length > 180 || !raw || typeof raw !== 'object' || Array.isArray(raw)) return [];
        const item = raw as Record<string, unknown>;
        const hiddenKeys = Array.isArray(item.hiddenKeys)
          ? [...new Set(item.hiddenKeys.filter(safeBlockKey))]
            .filter(key => !FIXED_BLOCK_KEYS.has(key))
            .slice(0, MAX_HIDDEN_BLOCKS)
          : [];
        const updatedAtMs = typeof item.updatedAtMs === 'number' && Number.isFinite(item.updatedAtMs)
          ? Math.max(0, Math.floor(item.updatedAtMs))
          : 0;
        return [[meetingId, { hiddenKeys, updatedAtMs }] as const];
      })
      .sort((left, right) => right[1].updatedAtMs - left[1].updatedAtMs)
      .slice(0, MAX_MEETINGS);
    return Object.fromEntries(entries);
  } catch {
    return {};
  }
}

function layouts(): Promise<StoredLayouts> {
  if (!layoutsPromise) layoutsPromise = getAppStorageItem(STORAGE_KEY).then(parseLayouts);
  return layoutsPromise;
}

export function isFixedMeetingSummarySection(section: Pick<MeetingSummarySection, 'stableKey'>): boolean {
  return FIXED_BLOCK_KEYS.has(section.stableKey);
}

export function visibleMeetingSummaryDocument(
  document: MeetingSummaryDocument,
  hiddenKeys: readonly string[],
): MeetingSummaryDocument {
  if (hiddenKeys.length === 0) return document;
  const hidden = new Set(hiddenKeys.filter(key => !FIXED_BLOCK_KEYS.has(key)));
  return {
    ...document,
    sections: document.sections.filter(section => !hidden.has(section.stableKey)),
  };
}

export async function loadMeetingSummaryHiddenBlocks(meetingId: string): Promise<readonly string[]> {
  const key = meetingId.trim();
  if (!key) return [];
  return [...((await layouts())[key]?.hiddenKeys ?? [])];
}

export async function saveMeetingSummaryHiddenBlocks(
  meetingId: string,
  hiddenKeys: readonly string[],
): Promise<readonly string[]> {
  const key = meetingId.trim();
  if (!key || key.length > 180) throw new Error('meeting summary layout identity is invalid');
  const normalized = [...new Set(hiddenKeys.filter(safeBlockKey))]
    .filter(blockKey => !FIXED_BLOCK_KEYS.has(blockKey))
    .slice(0, MAX_HIDDEN_BLOCKS);
  const operation = layoutMutationChain.then(async () => {
    const current = await layouts();
    const nextEntries = Object.entries({
      ...current,
      [key]: { hiddenKeys: normalized, updatedAtMs: Date.now() },
    })
      .sort((left, right) => right[1].updatedAtMs - left[1].updatedAtMs)
      .slice(0, MAX_MEETINGS);
    const next = Object.fromEntries(nextEntries);
    await writeAppStorageJson(STORAGE_KEY, next);
    layoutsPromise = Promise.resolve(next);
  });
  layoutMutationChain = operation.catch(() => undefined);
  await operation;
  return normalized;
}

export async function resetMeetingSummaryHiddenBlocks(meetingId: string): Promise<void> {
  const key = meetingId.trim();
  if (!key) return;
  const operation = layoutMutationChain.then(async () => {
    const current = await layouts();
    if (!Object.prototype.hasOwnProperty.call(current, key)) return;
    const { [key]: _removed, ...next } = current;
    await writeAppStorageJson(STORAGE_KEY, next, { removeIfEmpty: true });
    layoutsPromise = Promise.resolve(next);
  });
  layoutMutationChain = operation.catch(() => undefined);
  await operation;
}

export function resetMeetingSummaryLayoutCacheForTests(): void {
  layoutsPromise = null;
  layoutMutationChain = Promise.resolve();
}
