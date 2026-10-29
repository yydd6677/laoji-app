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

CREATE TRIGGER IF NOT EXISTS recording_asset_generation_insert_guard
BEFORE INSERT ON recording_assets
WHEN NEW.asset_generation IS NULL OR NEW.asset_generation GLOB '*[^0-9a-f]*'
  OR length(NEW.asset_generation) <> 32
BEGIN
  SELECT RAISE(ABORT, 'recording asset generation is invalid');
END;

CREATE TRIGGER IF NOT EXISTS recording_asset_generation_update_guard
BEFORE UPDATE OF asset_generation ON recording_assets
WHEN NEW.asset_generation <> OLD.asset_generation
BEGIN
  SELECT RAISE(ABORT, 'recording asset generation is immutable');
END;

CREATE TRIGGER IF NOT EXISTS recording_asset_source_hash_update_guard
BEFORE UPDATE OF source_sha256 ON recording_assets
WHEN OLD.source_sha256 IS NOT NULL
  AND (NEW.source_sha256 IS NULL OR NEW.source_sha256 <> OLD.source_sha256)
BEGIN
  SELECT RAISE(ABORT, 'recording asset source hash is immutable');
END;

CREATE TRIGGER IF NOT EXISTS recording_asset_source_hash_insert_guard
BEFORE INSERT ON recording_assets
WHEN NEW.source_sha256 IS NOT NULL AND (
  length(NEW.source_sha256) <> 71
  OR substr(NEW.source_sha256, 1, 7) <> 'sha256:'
  OR substr(NEW.source_sha256, 8) GLOB '*[^0-9a-f]*'
)
BEGIN
  SELECT RAISE(ABORT, 'recording asset source hash is invalid');
END;

CREATE TRIGGER IF NOT EXISTS recording_asset_source_hash_format_update_guard
BEFORE UPDATE OF source_sha256 ON recording_assets
WHEN NEW.source_sha256 IS NOT NULL AND (
  length(NEW.source_sha256) <> 71
  OR substr(NEW.source_sha256, 1, 7) <> 'sha256:'
  OR substr(NEW.source_sha256, 8) GLOB '*[^0-9a-f]*'
)
BEGIN
  SELECT RAISE(ABORT, 'recording asset source hash is invalid');
END;

CREATE TRIGGER IF NOT EXISTS recording_asset_remote_revision_guard
BEFORE UPDATE OF remote_object_revision ON recording_assets
WHEN OLD.remote_object_revision IS NOT NULL
  AND (NEW.remote_object_revision IS NULL OR NEW.remote_object_revision < OLD.remote_object_revision)
BEGIN
  SELECT RAISE(ABORT, 'recording remote object revision moved backwards');
END;

CREATE TRIGGER IF NOT EXISTS recording_asset_upload_operation_insert_guard
BEFORE INSERT ON recording_assets
WHEN NEW.upload_operation_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM device_operations operation
  WHERE operation.operation_id = NEW.upload_operation_id
    AND operation.entity_id = NEW.meeting_id
    AND operation.capability = 'media.upload'
    AND operation.generation_id = NEW.asset_generation
)
BEGIN
  SELECT RAISE(ABORT, 'recording upload operation ownership is invalid');
END;

CREATE TRIGGER IF NOT EXISTS recording_asset_upload_operation_update_guard
BEFORE UPDATE OF upload_operation_id ON recording_assets
WHEN NEW.upload_operation_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM device_operations operation
  WHERE operation.operation_id = NEW.upload_operation_id
    AND operation.entity_id = NEW.meeting_id
    AND operation.capability = 'media.upload'
    AND operation.generation_id = NEW.asset_generation
)
BEGIN
  SELECT RAISE(ABORT, 'recording upload operation ownership is invalid');
END;

CREATE TRIGGER IF NOT EXISTS recording_merge_generation_insert_guard
BEFORE INSERT ON meeting_recording_merge_tasks
WHEN NEW.target_asset_generation IS NULL
  OR NEW.target_asset_generation GLOB '*[^0-9a-f]*'
  OR length(NEW.target_asset_generation) <> 32
BEGIN
  SELECT RAISE(ABORT, 'recording merge generation is invalid');
END;

CREATE TRIGGER IF NOT EXISTS recording_merge_generation_update_guard
BEFORE UPDATE OF target_asset_generation ON meeting_recording_merge_tasks
WHEN NEW.target_asset_generation <> OLD.target_asset_generation
BEGIN
  SELECT RAISE(ABORT, 'recording merge generation is immutable');
END;
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
    if (!(await hasColumn('meeting_recording_merge_tasks', 'target_asset_generation'))) {
      await database.execAsync(
        'ALTER TABLE meeting_recording_merge_tasks ADD COLUMN target_asset_generation TEXT',
      );
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
    const missingMergeGenerations = await database.getAllAsync<{ id: string }>(
      `SELECT id FROM meeting_recording_merge_tasks
       WHERE target_asset_generation IS NULL OR length(trim(target_asset_generation)) = 0
       ORDER BY created_at_ms, id`,
    );
    for (const task of missingMergeGenerations) {
      const generation = Crypto.randomUUID().replace(/-/g, '').toLowerCase();
      await database.runAsync(
        `UPDATE meeting_recording_merge_tasks SET target_asset_generation = ?
         WHERE id = ?
           AND (target_asset_generation IS NULL OR length(trim(target_asset_generation)) = 0)`,
        generation,
        task.id,
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
