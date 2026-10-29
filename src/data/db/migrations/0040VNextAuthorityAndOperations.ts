import type { MeetingDatabaseMigration } from './types';

export const VNEXT_AUTHORITY_AND_OPERATIONS_V40_SQL = `
CREATE TABLE IF NOT EXISTS device_epochs (
  epoch_id TEXT PRIMARY KEY,
  status TEXT NOT NULL CHECK(status IN ('active','retired')),
  created_at_ms INTEGER NOT NULL,
  retired_at_ms INTEGER
);

CREATE TABLE IF NOT EXISTS device_authority_state (
  singleton_id INTEGER PRIMARY KEY CHECK(singleton_id = 1),
  current_epoch_id TEXT REFERENCES device_epochs(epoch_id),
  authority_revision INTEGER NOT NULL DEFAULT 0 CHECK(authority_revision >= 0),
  next_binding_epoch_seq INTEGER NOT NULL DEFAULT 1 CHECK(next_binding_epoch_seq >= 1),
  updated_at_ms INTEGER NOT NULL
);

INSERT OR IGNORE INTO device_authority_state (
  singleton_id, current_epoch_id, authority_revision, next_binding_epoch_seq, updated_at_ms
) VALUES (1, NULL, 0, 1, CAST(strftime('%s','now') AS INTEGER) * 1000);

CREATE TABLE IF NOT EXISTS meeting_service_bindings (
  meeting_id TEXT PRIMARY KEY REFERENCES meeting_notes(id) ON DELETE CASCADE,
  device_epoch_id TEXT NOT NULL REFERENCES device_epochs(epoch_id),
  binding_id TEXT NOT NULL UNIQUE,
  binding_generation TEXT NOT NULL,
  binding_epoch_seq INTEGER NOT NULL CHECK(binding_epoch_seq >= 1),
  binding_revision INTEGER NOT NULL DEFAULT 1 CHECK(binding_revision >= 1),
  state TEXT NOT NULL CHECK(state IN ('active','purging','purged')),
  cancel_revision INTEGER NOT NULL DEFAULT 0 CHECK(cancel_revision >= 0),
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL,
  UNIQUE(device_epoch_id, binding_generation),
  UNIQUE(device_epoch_id, binding_epoch_seq)
);

CREATE INDEX IF NOT EXISTS idx_vnext_binding_epoch
  ON meeting_service_bindings(device_epoch_id, state, binding_epoch_seq);

CREATE TABLE IF NOT EXISTS device_operations (
  operation_id TEXT PRIMARY KEY,
  device_epoch_id TEXT NOT NULL REFERENCES device_epochs(epoch_id),
  capability TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  entity_revision INTEGER NOT NULL CHECK(entity_revision >= 1),
  input_sha256 TEXT NOT NULL CHECK(
    length(input_sha256) = 71 AND input_sha256 GLOB 'sha256:[0-9a-f]*'
  ),
  generation_id TEXT NOT NULL,
  predecessor_operation_id TEXT REFERENCES device_operations(operation_id),
  creation_reason TEXT NOT NULL CHECK(creation_reason IN ('original','retry','regenerate')),
  operation_revision INTEGER NOT NULL DEFAULT 1 CHECK(operation_revision >= 1),
  cancel_revision INTEGER NOT NULL DEFAULT 0 CHECK(cancel_revision >= 0),
  remote_task_id TEXT,
  accepted_attempt_id TEXT,
  remote_state TEXT CHECK(remote_state IS NULL OR remote_state IN ('queued','running','success','failure','cancelled')),
  progress_done INTEGER CHECK(progress_done IS NULL OR progress_done >= 0),
  progress_total INTEGER CHECK(progress_total IS NULL OR progress_total >= 0),
  error_code TEXT,
  retry_after_ms INTEGER,
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL,
  terminal_at_ms INTEGER,
  UNIQUE(device_epoch_id, capability, entity_id, entity_revision, input_sha256, generation_id)
);

CREATE INDEX IF NOT EXISTS idx_vnext_operations_ready
  ON device_operations(device_epoch_id, remote_state, updated_at_ms, operation_id);
CREATE INDEX IF NOT EXISTS idx_vnext_operations_entity
  ON device_operations(entity_id, capability, updated_at_ms DESC);
`;

export const vnextAuthorityAndOperations: MeetingDatabaseMigration = {
  version: 40,
  name: 'vnext-authority-and-operations',
  async migrate(database) {
    await database.execAsync(VNEXT_AUTHORITY_AND_OPERATIONS_V40_SQL);
  },
};
