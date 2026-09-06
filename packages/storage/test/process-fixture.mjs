import { openStorage } from '../dist/index.js';
const db = openStorage(process.argv[2], [{version: 1, sql: 'CREATE TABLE notes (id INTEGER PRIMARY KEY, body TEXT NOT NULL) STRICT'}]);
try {
  if (process.argv[3] === 'write') db.prepare('INSERT INTO notes VALUES (?, ?)').run(1, '持久化记录');
  else console.log(db.prepare('SELECT body FROM notes WHERE id = 1').get().body);
} finally {
  db.close();
}
