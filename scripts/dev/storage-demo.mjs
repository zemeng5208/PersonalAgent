import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { openStorage } from '@personal-agent/storage';

const directory = new URL('../../data/local/', import.meta.url);
mkdirSync(directory, { recursive: true });
const db = openStorage(fileURLToPath(new URL('foundation-demo.sqlite', directory)), [{
  version: 1,
  sql: 'CREATE TABLE demo_runs (id INTEGER PRIMARY KEY, started_at TEXT NOT NULL) STRICT',
}]);
try {
  db.prepare('INSERT INTO demo_runs (started_at) VALUES (?)').run(new Date().toISOString());
  console.log({ demo: 'storage-only', ...db.prepare('SELECT count(*) AS persistedRuns FROM demo_runs').get() });
} finally {
  db.close();
}
