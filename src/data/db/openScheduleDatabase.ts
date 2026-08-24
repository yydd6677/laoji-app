import { deleteDatabaseAsync, openDatabaseAsync, type SQLiteDatabase } from 'expo-sqlite';
import { diagnosticAudit } from '../../services/diagnostics';
import { openMeetingDatabase, withMeetingDatabaseTransaction } from './openDatabase';

const SCHEDULE_DATABASE_NAME = 'laoji-schedule.db';
const SCHEDULE_DATABASE_SCHEMA_VERSION = 1;
const LEGACY_MEETING_DATABASE_NAME = 'laoji-meeting-memory.db';

export const SCHEDULE_DATABASE_SCHEMA_V1_SQL = `
CREATE TABLE IF NOT EXISTS schedule_database_meta (
  singleton_id INTEGER PRIMARY KEY CHECK(singleton_id = 1),
  schema_version INTEGER NOT NULL CHECK(schema_version >= 1),
  legacy_source_database TEXT,
  legacy_source_user_version INTEGER,
  legacy_imported_row_count INTEGER NOT NULL DEFAULT 0 CHECK(legacy_imported_row_count >= 0),
  legacy_imported_checkpoint_count INTEGER NOT NULL DEFAULT 0 CHECK(legacy_imported_checkpoint_count >= 0),
  legacy_import_completed_at_ms INTEGER,
  legacy_source_retired_at_ms INTEGER
);

INSERT OR IGNORE INTO schedule_database_meta (
  singleton_id,
  schema_version,
  legacy_source_database,
  legacy_imported_row_count
) VALUES (1, 1, '${LEGACY_MEETING_DATABASE_NAME}', 0);

CREATE TABLE IF NOT EXISTS local_schedule_events (
  id TEXT PRIMARY KEY,
  source_event_id TEXT,
  start_date TEXT NOT NULL,
  end_date TEXT,
  start_time TEXT,
  end_time TEXT,
  title TEXT NOT NULL DEFAULT '',
  event_json TEXT NOT NULL,
  event_revision INTEGER NOT NULL DEFAULT 1 CHECK(event_revision >= 1),
  draft_source_sha256 TEXT,
  producer_revision TEXT NOT NULL DEFAULT 'legacy-v1',
  graph_schema_revision TEXT NOT NULL DEFAULT 'mention-graph-v1',
  deleted_at_ms INTEGER,
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_schedule_event_date
  ON local_schedule_events(start_date, end_date, id);
CREATE INDEX IF NOT EXISTS idx_schedule_event_revision
  ON local_schedule_events(id, event_revision);
CREATE INDEX IF NOT EXISTS idx_schedule_event_source_hash
  ON local_schedule_events(draft_source_sha256, producer_revision)
  WHERE draft_source_sha256 IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_schedule_event_deleted
  ON local_schedule_events(deleted_at_ms, start_date, id)
  WHERE deleted_at_ms IS NOT NULL;

CREATE TABLE IF NOT EXISTS native_schedule_projection_checkpoints (
  device_epoch_id TEXT NOT NULL,
  surface_key TEXT NOT NULL CHECK(surface_key = 'calendar'),
  entity_id TEXT NOT NULL,
  entity_revision INTEGER NOT NULL CHECK(entity_revision >= 1),
  view_revision INTEGER NOT NULL CHECK(view_revision >= 1),
  surface_instance_id TEXT NOT NULL,
  payload_sha256 TEXT NOT NULL CHECK(
    length(payload_sha256) = 71
    AND substr(payload_sha256, 1, 7) = 'sha256:'
    AND substr(payload_sha256, 8) NOT GLOB '*[^0-9a-f]*'
  ),
  accepted_at_ms INTEGER NOT NULL,
  PRIMARY KEY(device_epoch_id, surface_key, entity_id)
);

CREATE INDEX IF NOT EXISTS idx_schedule_projection_checkpoint_entity
  ON native_schedule_projection_checkpoints(entity_id, surface_key, accepted_at_ms DESC);
`;

type ScheduleDatabaseMetaRow = {
  schema_version: number;
  legacy_import_completed_at_ms: number | null;
  legacy_source_retired_at_ms: number | null;
};

type LegacyScheduleRow = {
  id: string;
  source_event_id: string | null;
  start_date: string;
  end_date: string | null;
  start_time: string | null;
  end_time: string | null;
  title: string;
  event_json: string;
  event_revision: number;
  draft_source_sha256: string | null;
  producer_revision: string;
  graph_schema_revision: string;
  deleted_at_ms: number | null;
  created_at_ms: number;
  updated_at_ms: number;
};

type LegacyCalendarCheckpointRow = {
  device_epoch_id: string;
  surface_key: string;
  entity_id: string;
  entity_revision: number;
  view_revision: number;
  surface_instance_id: string;
  payload_sha256: string;
  accepted_at_ms: number;
};

let databasePromise: Promise<SQLiteDatabase> | null = null;
let writeDatabasePromise: Promise<SQLiteDatabase> | null = null;
let writeTail: Promise<void> = Promise.resolve();

async function currentSchemaVersion(database: SQLiteDatabase): Promise<number> {
  const row = await database.getFirstAsync<{ user_version: number }>('PRAGMA user_version');
  const version = Number(row?.user_version ?? 0);
  if (!Number.isSafeInteger(version) || version < 0) {
    throw new Error('schedule database schema version is invalid');
  }
  return version;
}

async function readLegacyScheduleRows(): Promise<{
  sourceUserVersion: number;
  rows: LegacyScheduleRow[];
  checkpoints: LegacyCalendarCheckpointRow[];
}> {
  const database = await openMeetingDatabase();
  const sourceUserVersion = await currentSchemaVersion(database);
  const table = await database.getFirstAsync<{ name: string }>(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'local_schedule_events'",
  );
  const rows = table ? await database.getAllAsync<LegacyScheduleRow>(
    `SELECT id, source_event_id, start_date, end_date, start_time, end_time,
            title, event_json, event_revision, draft_source_sha256,
            producer_revision, graph_schema_revision, deleted_at_ms,
            created_at_ms, updated_at_ms
       FROM local_schedule_events
      ORDER BY id`,
  ) : [];
  const checkpointTable = await database.getFirstAsync<{ name: string }>(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'native_projection_checkpoints'",
  );
  const checkpoints = checkpointTable ? await database.getAllAsync<LegacyCalendarCheckpointRow>(
    `SELECT device_epoch_id, surface_key, entity_id, entity_revision, view_revision,
            surface_instance_id, payload_sha256, accepted_at_ms
       FROM native_projection_checkpoints
      WHERE surface_key = 'calendar'
      ORDER BY device_epoch_id, entity_id`,
  ) : [];
  return { sourceUserVersion, rows, checkpoints };
}

function legacyRowsEqual(left: LegacyScheduleRow, right: LegacyScheduleRow): boolean {
  return left.id === right.id
    && left.source_event_id === right.source_event_id
    && left.start_date === right.start_date
    && left.end_date === right.end_date
    && left.start_time === right.start_time
    && left.end_time === right.end_time
    && left.title === right.title
    && left.event_json === right.event_json
    && Number(left.event_revision) === Number(right.event_revision)
    && left.draft_source_sha256 === right.draft_source_sha256
    && left.producer_revision === right.producer_revision
    && left.graph_schema_revision === right.graph_schema_revision
    && left.deleted_at_ms === right.deleted_at_ms
    && Number(left.created_at_ms) === Number(right.created_at_ms)
    && Number(left.updated_at_ms) === Number(right.updated_at_ms);
}

function legacyCheckpointsEqual(
  left: LegacyCalendarCheckpointRow,
  right: LegacyCalendarCheckpointRow,
): boolean {
  return left.device_epoch_id === right.device_epoch_id
    && left.surface_key === right.surface_key
    && left.entity_id === right.entity_id
    && Number(left.entity_revision) === Number(right.entity_revision)
    && Number(left.view_revision) === Number(right.view_revision)
    && left.surface_instance_id === right.surface_instance_id
    && left.payload_sha256 === right.payload_sha256
    && Number(left.accepted_at_ms) === Number(right.accepted_at_ms);
}

async function importLegacyScheduleRows(
  database: SQLiteDatabase,
  sourceUserVersion: number,
  rows: readonly LegacyScheduleRow[],
  checkpoints: readonly LegacyCalendarCheckpointRow[],
): Promise<void> {
  const completedAtMs = Date.now();
  await database.withTransactionAsync(async () => {
    for (const row of rows) {
      await database.runAsync(
        `INSERT INTO local_schedule_events (
          id, source_event_id, start_date, end_date, start_time, end_time,
          title, event_json, event_revision, draft_source_sha256,
          producer_revision, graph_schema_revision, deleted_at_ms,
          created_at_ms, updated_at_ms
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO NOTHING`,
        row.id,
        row.source_event_id,
        row.start_date,
        row.end_date,
        row.start_time,
        row.end_time,
        row.title,
        row.event_json,
        row.event_revision,
        row.draft_source_sha256,
        row.producer_revision,
        row.graph_schema_revision,
        row.deleted_at_ms,
        row.created_at_ms,
        row.updated_at_ms,
      );
    }

    for (const expected of rows) {
      const imported = await database.getFirstAsync<LegacyScheduleRow>(
        `SELECT id, source_event_id, start_date, end_date, start_time, end_time,
                title, event_json, event_revision, draft_source_sha256,
                producer_revision, graph_schema_revision, deleted_at_ms,
                created_at_ms, updated_at_ms
           FROM local_schedule_events
          WHERE id = ?`,
        expected.id,
      );
      if (!imported || !legacyRowsEqual(imported, expected)) {
        throw new Error(`schedule database legacy import mismatch for ${expected.id}`);
      }
    }

    for (const checkpoint of checkpoints) {
      await database.runAsync(
        `INSERT INTO native_schedule_projection_checkpoints (
           device_epoch_id, surface_key, entity_id, entity_revision, view_revision,
           surface_instance_id, payload_sha256, accepted_at_ms
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(device_epoch_id, surface_key, entity_id) DO NOTHING`,
        checkpoint.device_epoch_id,
        checkpoint.surface_key,
        checkpoint.entity_id,
        checkpoint.entity_revision,
        checkpoint.view_revision,
        checkpoint.surface_instance_id,
        checkpoint.payload_sha256,
        checkpoint.accepted_at_ms,
      );
      const imported = await database.getFirstAsync<LegacyCalendarCheckpointRow>(
        `SELECT device_epoch_id, surface_key, entity_id, entity_revision, view_revision,
                surface_instance_id, payload_sha256, accepted_at_ms
           FROM native_schedule_projection_checkpoints
          WHERE device_epoch_id = ? AND surface_key = ? AND entity_id = ?`,
        checkpoint.device_epoch_id,
        checkpoint.surface_key,
        checkpoint.entity_id,
      );
      if (!imported || !legacyCheckpointsEqual(imported, checkpoint)) {
        throw new Error(`schedule database checkpoint import mismatch for ${checkpoint.entity_id}`);
      }
    }

    await database.runAsync(
      `UPDATE schedule_database_meta
          SET schema_version = ?,
              legacy_source_database = ?,
              legacy_source_user_version = ?,
              legacy_imported_row_count = ?,
              legacy_imported_checkpoint_count = ?,
              legacy_import_completed_at_ms = ?
        WHERE singleton_id = 1`,
      SCHEDULE_DATABASE_SCHEMA_VERSION,
      LEGACY_MEETING_DATABASE_NAME,
      sourceUserVersion,
      rows.length,
      checkpoints.length,
      completedAtMs,
    );
  });
}

async function retireLegacyScheduleTable(database: SQLiteDatabase): Promise<boolean> {
  try {
    const retiredAtMs = Date.now();
    await withMeetingDatabaseTransaction(async meetingDatabase => {
      await meetingDatabase.runAsync(
        "DELETE FROM native_projection_checkpoints WHERE surface_key = 'calendar'",
      );
      await meetingDatabase.execAsync('DROP TABLE IF EXISTS local_schedule_events;');
      await meetingDatabase.runAsync(
        `INSERT INTO vnext_cutover_tombstones (
           capability, barrier_state, last_legacy_submit_at_ms, legacy_submit_count,
           last_legacy_read_at_ms, legacy_reader_removed_at_ms, updated_at_ms
         ) VALUES ('schedule_database_v1', 'closed', NULL, 0, ?, ?, ?)
         ON CONFLICT(capability) DO UPDATE SET
           barrier_state = 'closed',
           last_legacy_read_at_ms = excluded.last_legacy_read_at_ms,
           legacy_reader_removed_at_ms = excluded.legacy_reader_removed_at_ms,
           updated_at_ms = excluded.updated_at_ms`,
        retiredAtMs,
        retiredAtMs,
        retiredAtMs,
      );
    });
    await database.runAsync(
      `UPDATE schedule_database_meta
          SET legacy_source_retired_at_ms = ?
        WHERE singleton_id = 1`,
      retiredAtMs,
    );
    return true;
  } catch (error) {
    diagnosticAudit('schedule_db_legacy_retire_deferred', {
      error_name: error instanceof Error ? error.name : 'unknown',
    });
    return false;
  }
}

async function initializeScheduleDatabase(): Promise<SQLiteDatabase> {
  const startedAtMs = Date.now();
  const database = await openDatabaseAsync(SCHEDULE_DATABASE_NAME);
  const openedAtMs = Date.now();
  try {
    await database.execAsync(`
      PRAGMA foreign_keys = ON;
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = NORMAL;
      PRAGMA busy_timeout = 5000;
    `);
    const installedVersion = await currentSchemaVersion(database);
    if (installedVersion > SCHEDULE_DATABASE_SCHEMA_VERSION) {
      throw new Error(
        `schedule database schema ${installedVersion} is newer than supported ${SCHEDULE_DATABASE_SCHEMA_VERSION}`,
      );
    }
    await database.execAsync(SCHEDULE_DATABASE_SCHEMA_V1_SQL);
    if (installedVersion < SCHEDULE_DATABASE_SCHEMA_VERSION) {
      await database.execAsync(`PRAGMA user_version = ${SCHEDULE_DATABASE_SCHEMA_VERSION};`);
    }

    let metadata = await database.getFirstAsync<ScheduleDatabaseMetaRow>(
      `SELECT schema_version, legacy_import_completed_at_ms, legacy_source_retired_at_ms
         FROM schedule_database_meta
        WHERE singleton_id = 1`,
    );
    if (!metadata) throw new Error('schedule database metadata is missing');

    let importedRows = 0;
    let importedCheckpoints = 0;
    if (metadata.legacy_import_completed_at_ms === null) {
      const legacy = await readLegacyScheduleRows();
      importedRows = legacy.rows.length;
      importedCheckpoints = legacy.checkpoints.length;
      await importLegacyScheduleRows(
        database,
        legacy.sourceUserVersion,
        legacy.rows,
        legacy.checkpoints,
      );
      metadata = await database.getFirstAsync<ScheduleDatabaseMetaRow>(
        `SELECT schema_version, legacy_import_completed_at_ms, legacy_source_retired_at_ms
           FROM schedule_database_meta
          WHERE singleton_id = 1`,
      );
      if (!metadata?.legacy_import_completed_at_ms) {
        throw new Error('schedule database legacy import did not commit');
      }
    }

    let retired = metadata.legacy_source_retired_at_ms !== null;
    if (!retired) retired = await retireLegacyScheduleTable(database);
    const completedAtMs = Date.now();
    diagnosticAudit('schedule_db_open', {
      open_ms: Math.max(0, openedAtMs - startedAtMs),
      total_ms: Math.max(0, completedAtMs - startedAtMs),
      imported_rows: importedRows,
      imported_checkpoints: importedCheckpoints,
      legacy_source_retired: retired,
    });
    return database;
  } catch (error) {
    await database.closeAsync().catch(() => undefined);
    throw error;
  }
}

export function openScheduleDatabase(): Promise<SQLiteDatabase> {
  if (!databasePromise) {
    const pending = initializeScheduleDatabase();
    databasePromise = pending;
    void pending.catch(() => {
      if (databasePromise === pending) databasePromise = null;
    });
  }
  return databasePromise;
}

function openScheduleWriteDatabase(): Promise<SQLiteDatabase> {
  if (!writeDatabasePromise) {
    const pending = openScheduleDatabase().then(async () => {
      const database = await openDatabaseAsync(SCHEDULE_DATABASE_NAME, { useNewConnection: true });
      try {
        await database.execAsync(`
          PRAGMA foreign_keys = ON;
          PRAGMA synchronous = NORMAL;
          PRAGMA busy_timeout = 5000;
        `);
        return database;
      } catch (error) {
        await database.closeAsync().catch(() => undefined);
        throw error;
      }
    });
    writeDatabasePromise = pending;
    void pending.catch(() => {
      if (writeDatabasePromise === pending) writeDatabasePromise = null;
    });
  }
  return writeDatabasePromise;
}

export function withScheduleDatabaseTransaction<T>(
  work: (database: SQLiteDatabase) => Promise<T>,
): Promise<T> {
  const operation = writeTail.catch(() => undefined).then(async () => {
    const database = await openScheduleWriteDatabase();
    await database.execAsync('BEGIN IMMEDIATE;');
    try {
      const result = await work(database);
      await database.execAsync('COMMIT;');
      return result;
    } catch (error) {
      await database.execAsync('ROLLBACK;').catch(() => undefined);
      throw error;
    }
  });
  writeTail = operation.then(() => undefined, () => undefined);
  return operation;
}

export async function closeScheduleDatabaseForTests(): Promise<void> {
  const operation = writeTail.catch(() => undefined).then(async () => {
    const pendingRead = databasePromise;
    const pendingWrite = writeDatabasePromise;
    databasePromise = null;
    writeDatabasePromise = null;
    const [readDatabase, writeDatabase] = await Promise.all([
      pendingRead?.catch(() => null) ?? null,
      pendingWrite?.catch(() => null) ?? null,
    ]);
    await Promise.all([
      readDatabase?.closeAsync(),
      writeDatabase?.closeAsync(),
    ]);
  });
  writeTail = operation.then(() => undefined, () => undefined);
  await operation;
}

export async function deleteScheduleDatabase(): Promise<void> {
  const operation = writeTail.catch(() => undefined).then(async () => {
    const pendingRead = databasePromise;
    const pendingWrite = writeDatabasePromise;
    databasePromise = null;
    writeDatabasePromise = null;
    const [readDatabase, writeDatabase] = await Promise.all([
      pendingRead?.catch(() => null) ?? null,
      pendingWrite?.catch(() => null) ?? null,
    ]);
    await Promise.all([
      readDatabase?.closeAsync(),
      writeDatabase?.closeAsync(),
    ]);
    try {
      await deleteDatabaseAsync(SCHEDULE_DATABASE_NAME);
    } catch (error) {
      if (!(error instanceof Error) || !/not found/i.test(error.message)) throw error;
    }
  });
  writeTail = operation.then(() => undefined, () => undefined);
  await operation;
}

export {
  LEGACY_MEETING_DATABASE_NAME,
  SCHEDULE_DATABASE_NAME,
  SCHEDULE_DATABASE_SCHEMA_VERSION,
};
