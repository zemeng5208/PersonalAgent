import type {DatabaseSync} from 'node:sqlite';
import type {AuthorizationStore, StoredGrant} from '@personal-agent/policy';

/** Uses the Runtime-owned database and migration; no separate task store. */
export class SqliteAuthorizationStore implements AuthorizationStore {
  constructor(private readonly db: DatabaseSync) {}
  get(ref: string): StoredGrant | undefined {
    const row = this.db.prepare('SELECT value_json FROM authorization_grants WHERE authorization_ref = ?').get(ref) as {value_json: string} | undefined;
    return row ? JSON.parse(row.value_json) as StoredGrant : undefined;
  }
  set(ref: string, grant: StoredGrant): void {
    this.db.prepare('INSERT INTO authorization_grants (authorization_ref, value_json) VALUES (?, ?) ON CONFLICT(authorization_ref) DO UPDATE SET value_json = excluded.value_json').run(ref, JSON.stringify(grant));
  }
  delete(ref: string): boolean {
    return Number(this.db.prepare('DELETE FROM authorization_grants WHERE authorization_ref = ?').run(ref).changes) > 0;
  }
  transaction<T>(work: () => T): T {
    this.db.exec('SAVEPOINT authorization_change');
    try {
      const result = work();
      this.db.exec('RELEASE authorization_change');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK TO authorization_change; RELEASE authorization_change');
      throw error;
    }
  }
}
