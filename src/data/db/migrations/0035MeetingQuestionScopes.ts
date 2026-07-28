import type { MeetingDatabaseMigration } from './types';

export const MEETING_QUESTION_SCOPES_V35_SQL = `
ALTER TABLE meeting_question_turns
  ADD COLUMN answer_scope TEXT NOT NULL DEFAULT 'meeting'
  CHECK(answer_scope IN ('meeting','general'));
`;

export const meetingQuestionScopesV35: MeetingDatabaseMigration = {
  version: 35,
  name: 'meeting-question-scopes-v35',
  async migrate(database) {
    await database.execAsync(MEETING_QUESTION_SCOPES_V35_SQL);
  },
};
