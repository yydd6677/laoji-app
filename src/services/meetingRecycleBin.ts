import type { ScopeKey } from '../domain/meeting';
import type { MeetingNoteRepository } from '../data/repositories';

const DAY_MS = 24 * 60 * 60 * 1_000;

export interface MeetingRecycleBinEntry {
  meetingId: string;
  title: string;
  recordedAtMs: number;
  deletedAtMs: number;
  expiresAtMs: number;
  remainingDays: number;
  syncState: 'pending' | 'synced' | 'conflicted' | 'deleted';
  canRestore: boolean;
}

export async function listMeetingRecycleBin(
  repository: MeetingNoteRepository,
  scopeKey: ScopeKey,
  retentionDays: number,
  nowMs = Date.now(),
): Promise<readonly MeetingRecycleBinEntry[]> {
  if (scopeKey === 'guest') return [];
  if (!Number.isSafeInteger(retentionDays) || retentionDays < 1 || retentionDays > 3_650) {
    throw new Error('回收站保留期限无效');
  }
  if (!Number.isSafeInteger(nowMs) || nowMs < 0) throw new Error('回收站时间无效');
  const rows = [];
  let before: { updatedAtMs: number; id: string } | null = null;
  for (let page = 0; page < 100; page += 1) {
    const projection = await repository.listProjection(scopeKey, {
      limit: 200,
      before,
      includeDeleted: true,
      onlyDeleted: true,
    });
    rows.push(...projection.items);
    if (!projection.hasMore || projection.items.length === 0) break;
    const last = projection.items.at(-1)!;
    before = { updatedAtMs: last.updatedAtMs, id: last.id };
    if (page === 99) throw new Error('回收站记录数量超出读取范围');
  }
  return rows
    .flatMap(item => {
      if (
        item.lifecycle !== 'deleted'
        || !item.remoteId
        || item.remoteRevision === null
        || !item.deletedFromLifecycle
        || item.deletedAtMs === null
      ) return [];
      const expiresAtMs = item.deletedAtMs + retentionDays * DAY_MS;
      if (!Number.isSafeInteger(expiresAtMs) || expiresAtMs <= nowMs) return [];
      return [{
        meetingId: item.id,
        title: item.title,
        recordedAtMs: item.recordedAtMs ?? item.startedAtMs ?? item.createdAtMs,
        deletedAtMs: item.deletedAtMs,
        expiresAtMs,
        remainingDays: Math.max(1, Math.ceil((expiresAtMs - nowMs) / DAY_MS)),
        syncState: item.syncState as MeetingRecycleBinEntry['syncState'],
        canRestore: item.syncState !== 'conflicted',
      }];
    })
    .sort((left, right) => right.deletedAtMs - left.deletedAtMs || left.meetingId.localeCompare(right.meetingId));
}
