import * as Crypto from 'expo-crypto';
import type { MeetingDatabaseMigration } from './types';

export const MEDIA_GENERATION_AND_TRASH_VNEXT_V44_SQL = `
CREATE UNIQUE INDEX IF NOT EXISTS idx_recording_asset_generation
  ON recording_assets(meeting_id, asset_generation);

CREATE INDEX IF NOT EXISTS idx_recording_upload_operation
  ON recording_assets(upload_operation_id)
  WHERE upload_operation_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_meeting_purge_after
  ON meeting_notes(purge_after_ms, id)
  WHERE purge_after_ms IS NOT NULL;
`;

export const mediaGenerationAndTrashVNext: MeetingDatabaseMigration = {
  version: 44,
  name: 'media-generation-and-trash-vnext',
  async migrate(database) {
    const hasColumn = async (table: string, column: string): Promise<boolean> => {
      const rows = await database.getAllAsync<{ name: string }>(`PRAGMA table_info(${table})`);
      return rows.some(row => row.name === column);
    };
    if (!(await hasColumn('recording_assets', 'asset_generation'))) {
      await database.execAsync('ALTER TABLE recording_assets ADD COLUMN asset_generation TEXT');
    }
    if (!(await hasColumn('recording_assets', 'source_sha256'))) {
      await database.execAsync('ALTER TABLE recording_assets ADD COLUMN source_sha256 TEXT');
    }
    if (!(await hasColumn('recording_assets', 'upload_operation_id'))) {
      await database.execAsync(
        'ALTER TABLE recording_assets ADD COLUMN upload_operation_id TEXT REFERENCES device_operations(operation_id)',
      );
    }
    if (!(await hasColumn('recording_assets', 'remote_object_revision'))) {
      await database.execAsync('ALTER TABLE recording_assets ADD COLUMN remote_object_revision INTEGER');
    }
    if (!(await hasColumn('meeting_notes', 'purge_after_ms'))) {
      await database.execAsync('ALTER TABLE meeting_notes ADD COLUMN purge_after_ms INTEGER');
    }
    const missingGenerations = await database.getAllAsync<{ id: string }>(
      `SELECT id FROM recording_assets
       WHERE asset_generation IS NULL OR length(trim(asset_generation)) = 0
       ORDER BY created_at_ms, id`,
    );
    for (const asset of missingGenerations) {
      const generation = Crypto.randomUUID().replace(/-/g, '').toLowerCase();
      await database.runAsync(
        `UPDATE recording_assets SET asset_generation = ?
         WHERE id = ? AND (asset_generation IS NULL OR length(trim(asset_generation)) = 0)`,
        generation,
        asset.id,
      );
    }
    await database.execAsync(`
      UPDATE recording_assets
      SET source_sha256 = checksum_sha256
      WHERE source_sha256 IS NULL
        AND checksum_sha256 GLOB 'sha256:[0-9a-f]*'
        AND length(checksum_sha256) = 71;
      UPDATE meeting_notes
      SET purge_after_ms = deleted_at_ms + 2592000000
      WHERE deleted_at_ms IS NOT NULL AND purge_after_ms IS NULL;
      UPDATE meeting_notes
      SET purge_after_ms = NULL
      WHERE deleted_at_ms IS NULL AND purge_after_ms IS NOT NULL;
    `);
    await database.execAsync(MEDIA_GENERATION_AND_TRASH_VNEXT_V44_SQL);
  },
};
