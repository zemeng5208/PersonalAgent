import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

export interface Migration {
  readonly version: number;
  readonly sql: string;
}

// Trusted root migrations only; never pass tool, model, or connector input here.
export function migrate(db: DatabaseSync, migrations: readonly Migration[]): void {
  for (const [index, migration] of migrations.entries()) {
    if (migration.version !== index + 1 || !migration.sql.trim()) {
      throw new Error('Migrations must contain nonempty SQL and consecutive versions from 1');
    }
  }
  db.exec('BEGIN IMMEDIATE');
  try {
    db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      checksum TEXT NOT NULL
    ) STRICT`);
    const applied = db.prepare('SELECT version, checksum FROM schema_migrations ORDER BY version').all();
    if (applied.length > migrations.length) throw new Error('Database schema is newer than this application');
    for (const [index, migration] of migrations.entries()) {
      const checksum = createHash('sha256').update(migration.sql).digest('hex');
      const previous = applied[index];
      if (previous) {
        if (previous.version !== migration.version || previous.checksum !== checksum) {
          throw new Error(`Applied migration ${migration.version} was changed`);
        }
        continue;
      }
      db.exec(migration.sql);
      db.prepare('INSERT INTO schema_migrations (version, checksum) VALUES (?, ?)')
        .run(migration.version, checksum);
    }
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

export function openStorage(path: string, migrations: readonly Migration[] = []): DatabaseSync {
  const db = new DatabaseSync(path);
  try {
    db.exec('PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL;');
    migrate(db, migrations);
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}
