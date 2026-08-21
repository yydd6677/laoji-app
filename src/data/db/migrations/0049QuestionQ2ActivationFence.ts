import type { MeetingDatabaseMigration } from './types';

/**
 * Persist the Q2 publication fence with the pending turn.
 *
 * The original Q2 slice kept this identity only in the in-memory request
 * closure.  After Android process death a durable remote Task could still
 * finish, but the app no longer knew which epoch/binding/note policy had
 * authorized it.  Nullable columns keep completed pre-v49 history readable;
 * new or rebound pending turns are required by the repository to populate the
 * complete fence before they can publish an answer.
 */
export const questionQ2ActivationFenceV49: MeetingDatabaseMigration = {
  version: 49,
  name: 'question-q2-activation-fence',
  async migrate(database) {
    const columns = new Set(
      (await database.getAllAsync<{ name: string }>(
        'PRAGMA table_info(meeting_question_q2_turns)',
      )).map(row => row.name),
    );
    const additions: readonly [string, string][] = [
      ['activation_device_epoch_id', 'TEXT'],
      ['activation_binding_id', 'TEXT'],
      ['activation_binding_generation', 'TEXT'],
      ['activation_binding_revision', 'INTEGER'],
      ['activation_binding_cancel_revision', 'INTEGER'],
      ['activation_manual_note_mode', 'TEXT'],
      ['activation_manual_note_revision', 'INTEGER'],
    ];
    for (const [column, declaration] of additions) {
      if (!columns.has(column)) {
        await database.execAsync(
          `ALTER TABLE meeting_question_q2_turns ADD COLUMN ${column} ${declaration}`,
        );
      }
    }
  },
};
