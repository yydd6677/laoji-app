import type { MeetingDatabaseMigration } from './types';

export const DEVICE_UPLOAD_EXECUTOR_V46_SQL = `
ALTER TABLE device_operations ADD COLUMN executor_kind TEXT
  CHECK(executor_kind IS NULL OR executor_kind IN ('workmanager'));
ALTER TABLE device_operations ADD COLUMN executor_id TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_device_operation_executor
  ON device_operations(executor_kind, executor_id)
  WHERE executor_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_device_upload_pending_asset
  ON device_operations(capability, remote_state, updated_at_ms, operation_id)
  WHERE capability = 'media.upload' AND remote_state IN ('queued', 'running', 'failure');
`;

export const deviceUploadExecutorV46: MeetingDatabaseMigration = {
  version: 46,
  name: 'device-upload-executor',
  async migrate(database) {
    const columns = await database.getAllAsync<{ name: string }>('PRAGMA table_info(device_operations)');
    const existing = new Set(columns.map(row => row.name));
    if (!existing.has('executor_kind')) {
      await database.execAsync(
        "ALTER TABLE device_operations ADD COLUMN executor_kind TEXT CHECK(executor_kind IS NULL OR executor_kind IN ('workmanager'))",
      );
    }
    if (!existing.has('executor_id')) {
      await database.execAsync('ALTER TABLE device_operations ADD COLUMN executor_id TEXT');
    }
    await database.execAsync(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_device_operation_executor
        ON device_operations(executor_kind, executor_id)
        WHERE executor_id IS NOT NULL;
      CREATE INDEX IF NOT EXISTS idx_device_upload_pending_asset
        ON device_operations(capability, remote_state, updated_at_ms, operation_id)
        WHERE capability = 'media.upload' AND remote_state IN ('queued', 'running', 'failure');
    `);
  },
};
