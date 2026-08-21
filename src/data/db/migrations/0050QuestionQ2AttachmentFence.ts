import type { MeetingDatabaseMigration } from './types';

/**
 * Extend the durable Q2 publication fence to the exact attachment selection.
 *
 * A nullable column keeps pre-v50 history readable. New and rebound pending
 * turns must persist the deterministic selection hash before their remote
 * result may be activated locally.
 */
export const questionQ2AttachmentFenceV50: MeetingDatabaseMigration = {
  version: 50,
  name: 'question-q2-attachment-fence',
  async migrate(database) {
    const columns = new Set(
      (await database.getAllAsync<{ name: string }>(
        'PRAGMA table_info(meeting_question_q2_turns)',
      )).map(row => row.name),
    );
    if (!columns.has('activation_attachment_selection_sha256')) {
      await database.execAsync(
        'ALTER TABLE meeting_question_q2_turns ADD COLUMN activation_attachment_selection_sha256 TEXT',
      );
    }
  },
};
