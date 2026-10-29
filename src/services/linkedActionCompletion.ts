import { useEffect, useState } from 'react';
import { AppState } from 'react-native';
import { openMeetingDatabase } from '../data/db/openDatabase';
import { sqliteMeetingNoteRepository } from '../data/repositories/sqliteMeetingNoteRepository';

/** Read-only presentation across the two isolated databases. The meeting
 * action remains the only completion writer; no calendar sync/outbox copy. */
export function useLinkedActionCompletion(): ReadonlySet<string> {
  const [completed, setCompleted] = useState<ReadonlySet<string>>(new Set());
  useEffect(() => {
    let alive = true;
    let generation = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const refresh = async () => {
      const request = ++generation;
      try {
        const database = await openMeetingDatabase();
        const rows = await database.getAllAsync<{ event_id: string }>(
          `SELECT action.followup_event_source_id AS event_id
             FROM action_items action JOIN meeting_notes meeting ON meeting.id = action.meeting_id
            WHERE meeting.scope_key = 'guest' AND meeting.lifecycle <> 'deleted'
              AND action.followup_event_source_id IS NOT NULL AND action.status <> 'dismissed'
            GROUP BY action.followup_event_source_id
           HAVING MIN(CASE WHEN action.status = 'completed' THEN 1 ELSE 0 END) = 1`,
        );
        if (alive && request === generation) {
          const next = new Set(rows.map(row => row.event_id));
          setCompleted(current => current.size === next.size && [...next].every(id => current.has(id)) ? current : next);
        }
      } catch {
        // Never block the calendar's first frame or mutate its data if the
        // independent meeting database is being migrated/recovered.
      }
    };
    const schedule = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => { void refresh(); }, 50);
    };
    schedule();
    const unsubscribe = sqliteMeetingNoteRepository.observeList('guest', schedule);
    const appState = AppState.addEventListener('change', state => { if (state === 'active') schedule(); });
    return () => { alive = false; generation += 1; if (timer) clearTimeout(timer); unsubscribe(); appState.remove(); };
  }, []);
  return completed;
}
