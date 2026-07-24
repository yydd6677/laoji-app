import type { MeetingDatabaseMigration } from './types';

export const ACTION_OUTBOX_TRANSPORT_V8_SQL = `
ALTER TABLE sync_outbox ADD COLUMN request_payload_json TEXT;
ALTER TABLE sync_outbox ADD COLUMN claim_token TEXT;

CREATE UNIQUE INDEX idx_outbox_claim_token
  ON sync_outbox(claim_token, operation_id)
  WHERE claim_token IS NOT NULL;

CREATE INDEX idx_outbox_action_aggregate
  ON sync_outbox(scope_key, aggregate_type, aggregate_id, status, created_at_ms);
`;

export const actionOutboxTransportV8: MeetingDatabaseMigration = {
  version: 8,
  name: 'meeting-action-outbox-transport',
  async migrate(database) {
    await database.execAsync(ACTION_OUTBOX_TRANSPORT_V8_SQL);
  },
};
