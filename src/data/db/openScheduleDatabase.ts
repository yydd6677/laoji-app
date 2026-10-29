import { backupDatabaseAsync, deleteDatabaseAsync, openDatabaseAsync, type SQLiteDatabase } from 'expo-sqlite';
import { diagnosticAudit } from '../../services/diagnostics';

const SCHEDULE_DATABASE_NAME = 'laoji-schedule.db';
const SCHEDULE_DATABASE_SCHEMA_VERSION = 4;
const SCHEDULE_PRE_EDITOR_BACKUP_NAME = 'laoji-schedule.pre-editor-v4.db';

export const SCHEDULE_DATABASE_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS schedule_database_meta (
  singleton_id INTEGER PRIMARY KEY CHECK(singleton_id = 1),
  schema_version INTEGER NOT NULL CHECK(schema_version >= 1)
);

INSERT OR IGNORE INTO schedule_database_meta (
  singleton_id,
  schema_version
) VALUES (1, ${SCHEDULE_DATABASE_SCHEMA_VERSION});

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
  producer_revision TEXT NOT NULL DEFAULT 'local-v1',
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

CREATE TABLE IF NOT EXISTS schedule_input_jobs (
  id TEXT PRIMARY KEY,
  source_sha256 TEXT NOT NULL,
  source_json TEXT NOT NULL,
  draft_json TEXT,
  state TEXT NOT NULL CHECK(state IN ('pending','ready','saved','dismissed','failed')),
  retry_at_ms INTEGER NOT NULL DEFAULT 0,
  attempts INTEGER NOT NULL DEFAULT 0,
  updated_at_ms INTEGER NOT NULL,
  created_at_ms INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS schedule_editor_drafts (
  id TEXT PRIMARY KEY,
  state TEXT NOT NULL CHECK(state IN ('editing','recording','parsing','saving','saved')),
  revision INTEGER NOT NULL CHECK(revision >= 1),
  state_revision INTEGER NOT NULL CHECK(state_revision >= 1),
  draft_json TEXT NOT NULL,
  input_job_id TEXT UNIQUE,
  event_ref_json TEXT,
  pending_input_json TEXT,
  last_undo_json TEXT,
  save_request_id TEXT NOT NULL UNIQUE,
  saved_event_ref_json TEXT,
  updated_at_ms INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_schedule_editor_unfinished
  ON schedule_editor_drafts(state, updated_at_ms DESC);

CREATE TABLE IF NOT EXISTS schedule_database_migrations (
  target_version INTEGER PRIMARY KEY,
  source_version INTEGER NOT NULL,
  backup_path TEXT NOT NULL,
  event_count INTEGER NOT NULL,
  completed_at_ms INTEGER NOT NULL
);
`;

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

async function integrityCheck(database: SQLiteDatabase): Promise<void> {
  const rows = await database.getAllAsync<{ integrity_check: string }>('PRAGMA integrity_check');
  if (rows.length !== 1 || rows[0]?.integrity_check !== 'ok') {
    throw new Error('schedule database integrity check failed');
  }
}

async function scheduleRows(database: SQLiteDatabase): Promise<string> {
  return JSON.stringify(await database.getAllAsync<{ id: string; event_json: string }>(
    'SELECT id, event_json FROM local_schedule_events ORDER BY id',
  ));
}

/** Called before the opening promise resolves: every queued writer awaits it. */
async function snapshotBeforeEditorMigration(source: SQLiteDatabase, sourceVersion: number) {
  await integrityCheck(source);
  const before = await scheduleRows(source);
  const destination = await openDatabaseAsync(SCHEDULE_PRE_EDITOR_BACKUP_NAME, { useNewConnection: true });
  try {
    const receiptTable = await destination.getFirstAsync<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='schedule_pre_editor_backup_receipt'",
    );
    if (!receiptTable) {
      // Retry an incomplete copy in the same file, never create rolling copies.
      await backupDatabaseAsync({ sourceDatabase: source, destDatabase: destination });
    }
    await integrityCheck(destination);
    if (await currentSchemaVersion(destination) !== sourceVersion
      || await scheduleRows(destination) !== before || await scheduleRows(source) !== before) {
      throw new Error('schedule migration snapshot does not match the source');
    }
    const eventCount = (JSON.parse(before) as unknown[]).length;
    await destination.execAsync(`CREATE TABLE IF NOT EXISTS schedule_pre_editor_backup_receipt (
      singleton_id INTEGER PRIMARY KEY CHECK(singleton_id=1),
      source_version INTEGER NOT NULL, event_count INTEGER NOT NULL, verified_at_ms INTEGER NOT NULL
    )`);
    await destination.runAsync(
      'INSERT OR IGNORE INTO schedule_pre_editor_backup_receipt VALUES (1, ?, ?, ?)',
      sourceVersion, eventCount, Date.now(),
    );
    return { path: destination.databasePath, eventCount };
  } finally {
    await destination.closeAsync();
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
    if (installedVersion < SCHEDULE_DATABASE_SCHEMA_VERSION) {
    const snapshot = installedVersion > 0 && installedVersion < 4
      ? await snapshotBeforeEditorMigration(database, installedVersion) : null;
    await database.execAsync('BEGIN IMMEDIATE;');
    try {
      await database.execAsync(SCHEDULE_DATABASE_SCHEMA_SQL);
      await database.runAsync(
        'UPDATE schedule_database_meta SET schema_version = ? WHERE singleton_id = 1',
        SCHEDULE_DATABASE_SCHEMA_VERSION,
      );
      if (snapshot) {
        await database.runAsync(
          `INSERT INTO schedule_database_migrations
            (target_version, source_version, backup_path, event_count, completed_at_ms) VALUES (4, ?, ?, ?, ?)`,
          installedVersion, snapshot.path, snapshot.eventCount, Date.now(),
        );
      }
      if (installedVersion < SCHEDULE_DATABASE_SCHEMA_VERSION) {
        await database.execAsync(`PRAGMA user_version = ${SCHEDULE_DATABASE_SCHEMA_VERSION};`);
      }
      await integrityCheck(database);
      await database.execAsync('COMMIT;');
    } catch (error) {
      await database.execAsync('ROLLBACK;').catch(() => undefined);
      throw error;
    }
    }

    const metadata = await database.getFirstAsync<{ schema_version: number }>(
      `SELECT schema_version
         FROM schedule_database_meta
        WHERE singleton_id = 1`,
    );
    if (metadata?.schema_version !== SCHEDULE_DATABASE_SCHEMA_VERSION) {
      throw new Error('schedule database metadata is invalid');
    }
    const completedAtMs = Date.now();
    diagnosticAudit('schedule_db_open', {
      open_ms: Math.max(0, openedAtMs - startedAtMs),
      total_ms: Math.max(0, completedAtMs - startedAtMs),
      schema_version: SCHEDULE_DATABASE_SCHEMA_VERSION,
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
    for (const name of [SCHEDULE_DATABASE_NAME, SCHEDULE_PRE_EDITOR_BACKUP_NAME]) {
      try {
        await deleteDatabaseAsync(name);
      } catch (error) {
        if (!(error instanceof Error) || !/not found/i.test(error.message)) throw error;
      }
    }
  });
  writeTail = operation.then(() => undefined, () => undefined);
  await operation;
}

export {
  SCHEDULE_DATABASE_NAME,
  SCHEDULE_DATABASE_SCHEMA_VERSION,
  SCHEDULE_PRE_EDITOR_BACKUP_NAME,
};
