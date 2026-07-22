import type { SQLiteDatabase } from 'expo-sqlite';

export interface MeetingDatabaseMigration {
  version: number;
  name: string;
  migrate(database: SQLiteDatabase): Promise<void>;
}
