import { openScheduleDatabase, withScheduleDatabaseTransaction } from '../db/openScheduleDatabase';
import { scheduleInputIdentity, type ScheduleInputJob } from '../../services/scheduleInput';
import type { PendingHardwareRecording } from 'laoji-native-platform';
import type { ParseResult } from '../../services/scheduleParsing';

type Row = { id: string; source_sha256: string; source_json: string; draft_json: string | null;
  state: ScheduleInputJob['state']; attempts: number };
function job(row: Row): ScheduleInputJob {
  return { id: row.id, source: JSON.parse(row.source_json), draft: row.draft_json ? JSON.parse(row.draft_json) : null,
    state: row.state, attempts: row.attempts };
}
export async function enqueueScheduleInput(source: PendingHardwareRecording): Promise<ScheduleInputJob> {
  const id = scheduleInputIdentity(source);
  const hash = source.audioChecksumSha256;
  if (!hash || !/^sha256:[0-9a-f]{64}$/.test(hash)) throw new Error('schedule audio hash missing');
  return withScheduleDatabaseTransaction(async db => {
    const previous = await db.getFirstAsync<Row>('SELECT * FROM schedule_input_jobs WHERE id = ?', id);
    if (previous) {
      if (previous.source_sha256 !== hash) throw new Error('schedule capture source conflict');
      return job(previous);
    }
    const now = Date.now();
    await db.runAsync(`INSERT INTO schedule_input_jobs
      (id, source_sha256, source_json, state, updated_at_ms, created_at_ms) VALUES (?, ?, ?, 'pending', ?, ?)`,
      id, hash, JSON.stringify(source), now, now);
    return { id, source, draft: null, state: 'pending', attempts: 0 };
  });
}
export async function listScheduleInputs(mode: 'work' | 'display' = 'work'): Promise<ScheduleInputJob[]> {
  const db = await openScheduleDatabase();
  return (await db.getAllAsync<Row>(`SELECT * FROM schedule_input_jobs WHERE ${mode === 'display'
    ? "state IN ('pending','ready','failed')" : "state IN ('ready','failed') OR (state='pending' AND retry_at_ms <= ?)"}
    ORDER BY created_at_ms ASC`, ...(mode === 'display' ? [] : [Date.now()]))).map(job);
}
export async function updateScheduleInput(id: string, draft: ParseResult): Promise<void> {
  await withScheduleDatabaseTransaction(async db => {
    await db.runAsync("UPDATE schedule_input_jobs SET state='ready', draft_json=?, updated_at_ms=? WHERE id=? AND state IN ('pending','ready','failed')",
      JSON.stringify(draft), Date.now(), id);
  });
}
export async function deferScheduleInput(id: string): Promise<void> {
  await withScheduleDatabaseTransaction(async db => {
    await db.runAsync(`UPDATE schedule_input_jobs SET attempts=attempts+1,
      state=CASE WHEN attempts >= 4 THEN 'failed' ELSE 'pending' END,
      retry_at_ms=?, updated_at_ms=? WHERE id=? AND state='pending'`, Date.now() + 30_000, Date.now(), id);
  });
}
export async function finishScheduleInput(id: string, state: 'saved' | 'dismissed'): Promise<void> {
  await withScheduleDatabaseTransaction(async db => {
    // Keep a content-free idempotency receipt across board refresh/rename/re-receive.
    await db.runAsync('UPDATE schedule_input_jobs SET state=?, draft_json=NULL, source_json=\'{}\', updated_at_ms=? WHERE id=?', state, Date.now(), id);
  });
}
export async function receivedScheduleInputIds(): Promise<string[]> {
  return (await (await openScheduleDatabase()).getAllAsync<{ id: string }>('SELECT id FROM schedule_input_jobs')).map(row => row.id);
}
