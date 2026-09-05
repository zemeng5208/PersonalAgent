import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { test } from 'node:test';
import { openStorage, migrate } from '../dist/index.js';

const root = fileURLToPath(new URL('../../../.cache/storage-tests/', import.meta.url));
mkdirSync(root, {recursive: true});
const file = () => join(mkdtempSync(join(root, 'case-')), 'store.sqlite');
const first = {version: 1, sql: 'CREATE TABLE notes (id INTEGER PRIMARY KEY, body TEXT NOT NULL) STRICT'};

test('data survives a separate process restart', () => {
  const path = file();
  const fixture = fileURLToPath(new URL('process-fixture.mjs', import.meta.url));
  execFileSync(process.execPath, [fixture, path, 'write']);
  assert.equal(execFileSync(process.execPath, [fixture, path, 'read'], {encoding: 'utf8'}).trim(), '持久化记录');
});

test('WAL, foreign keys, upgrade and repeated migration preserve records', () => {
  const path = file();
  let db = openStorage(path, [first]);
  db.prepare('INSERT INTO notes VALUES (?, ?)').run(1, 'keep');
  db.close();
  const migrations = [first, {version: 2, sql: 'ALTER TABLE notes ADD COLUMN revision INTEGER NOT NULL DEFAULT 1'}];
  db = openStorage(path, migrations);
  try {
    migrate(db, migrations);
    assert.equal(db.prepare('PRAGMA journal_mode').get().journal_mode, 'wal');
    assert.equal(db.prepare('PRAGMA foreign_keys').get().foreign_keys, 1);
    assert.deepEqual({...db.prepare('SELECT * FROM notes').get()}, {id: 1, body: 'keep', revision: 1});
    assert.equal(db.prepare('SELECT count(*) AS n FROM schema_migrations').get().n, 2);
  } finally { db.close(); }
});

test('failed migration rolls back schema and data changes', () => {
  const db = openStorage(file(), [first]);
  try {
    db.prepare('INSERT INTO notes VALUES (?, ?)').run(1, 'keep');
    assert.throws(() => migrate(db, [first, {version: 2, sql: "UPDATE notes SET body='changed'; CREATE TABLE partial (id INTEGER); SELECT * FROM missing_table;"}]));
    assert.equal(db.prepare('SELECT body FROM notes').get().body, 'keep');
    assert.equal(db.prepare("SELECT name FROM sqlite_master WHERE name='partial'").get(), undefined);
    assert.equal(db.prepare('SELECT count(*) AS n FROM schema_migrations').get().n, 1);
  } finally { db.close(); }
});

test('changed history, missing versions and downgrade are rejected', () => {
  const path = file();
  const db = openStorage(path, [first]);
  try {
    assert.throws(() => migrate(db, [{...first, sql: first.sql + ';'}]), /was changed/);
    assert.throws(() => migrate(db, [{version: 2, sql: 'SELECT 1'}]), /consecutive/);
  } finally { db.close(); }
  assert.throws(() => openStorage(path), /newer/);
  openStorage(path, [first]).close();
});
