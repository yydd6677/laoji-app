import { deleteDatabaseAsync, openDatabaseAsync, type SQLiteDatabase } from 'expo-sqlite';
import { meetingDatabaseMigrations } from './migrations';

const MEETING_DATABASE_NAME = 'laoji-meeting-memory.db';

let databasePromise: Promise<SQLiteDatabase> | null = null;
let writeTail: Promise<void> = Promise.resolve();

async function currentSchemaVersion(database: SQLiteDatabase): Promise<number> {
  const row = await database.getFirstAsync<{ user_version: number }>('PRAGMA user_version');
  const version = Number(row?.user_version ?? 0);
  if (!Number.isSafeInteger(version) || version < 0) {
    throw new Error('meeting database schema version is invalid');
  }
  return version;
}

async function applyMigrations(database: SQLiteDatabase): Promise<void> {
  const migrations = [...meetingDatabaseMigrations].sort((left, right) => left.version - right.version);
  const latestVersion = migrations.at(-1)?.version ?? 0;
  let installedVersion = await currentSchemaVersion(database);
  if (installedVersion > latestVersion) {
    throw new Error(`meeting database schema ${installedVersion} is newer than supported ${latestVersion}`);
  }

  for (const migration of migrations) {
    if (migration.version <= installedVersion) continue;
    if (migration.version !== installedVersion + 1) {
      throw new Error(`meeting database migration gap before ${migration.name}`);
    }
    await database.withTransactionAsync(async () => {
      await migration.migrate(database);
      await database.execAsync(`PRAGMA user_version = ${migration.version};`);
    });
    installedVersion = migration.version;
  }
}

async function initializeMeetingDatabase(): Promise<SQLiteDatabase> {
  const database = await openDatabaseAsync(MEETING_DATABASE_NAME);
  try {
    await database.execAsync(`
      PRAGMA foreign_keys = ON;
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = NORMAL;
      PRAGMA busy_timeout = 5000;
    `);
    await applyMigrations(database);
    return database;
  } catch (error) {
    await database.closeAsync().catch(() => undefined);
    throw error;
  }
}

export function openMeetingDatabase(): Promise<SQLiteDatabase> {
  if (!databasePromise) {
    const pending = initializeMeetingDatabase();
    databasePromise = pending;
    void pending.catch(() => {
      if (databasePromise === pending) databasePromise = null;
    });
  }
  return databasePromise;
}

export function withMeetingDatabaseTransaction<T>(
  work: (database: SQLiteDatabase) => Promise<T>,
): Promise<T> {
  const operation = writeTail.catch(() => undefined).then(async () => {
    const database = await openMeetingDatabase();
    let result: T | undefined;
    let completed = false;
    await database.withTransactionAsync(async () => {
      result = await work(database);
      completed = true;
    });
    if (!completed) throw new Error('meeting database transaction did not complete');
    return result as T;
  });
  writeTail = operation.then(() => undefined, () => undefined);
  return operation;
}

export async function closeMeetingDatabaseForTests(): Promise<void> {
  const operation = writeTail.catch(() => undefined).then(async () => {
    const pending = databasePromise;
    databasePromise = null;
    if (!pending) return;
    const database = await pending.catch(() => null);
    await database?.closeAsync();
  });
  writeTail = operation.then(() => undefined, () => undefined);
  await operation;
}

export async function deleteMeetingDatabase(): Promise<void> {
  const operation = writeTail.catch(() => undefined).then(async () => {
    const pending = databasePromise;
    databasePromise = null;
    const database = pending ? await pending.catch(() => null) : null;
    await database?.closeAsync();
    try {
      await deleteDatabaseAsync(MEETING_DATABASE_NAME);
    } catch (error) {
      if (!(error instanceof Error) || !/not found/i.test(error.message)) throw error;
    }
  });
  writeTail = operation.then(() => undefined, () => undefined);
  await operation;
}

export { MEETING_DATABASE_NAME };
