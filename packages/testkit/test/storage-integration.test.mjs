import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdirSync,mkdtempSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {join} from 'node:path';
import {openStorage} from '@personal-agent/storage';
import {Client,EventCursor} from '@personal-agent/client';
import {FakeRuntime} from '../dist/index.js';
test('MOD-01 persists MOD-02 events, migrates and replays through the client cursor',async()=>{
  const root=fileURLToPath(new URL('../../../.cache/protocol-integration/',import.meta.url));
  mkdirSync(root,{recursive:true});const path=join(mkdtempSync(join(root,'run-')),'events.sqlite');
  const migrations=[{version:1,sql:'CREATE TABLE fixture_events (sequence INTEGER PRIMARY KEY, event_id TEXT UNIQUE NOT NULL, json TEXT NOT NULL) STRICT'}];
  let db=openStorage(path,migrations);
  const runtime=new FakeRuntime({mode:'test',scenario:'success'});
  const client=new Client(runtime,runtime.clock.now);await client.connect();
  const task=await client.call('task.submit',{goal:'fixture',conversationId:'c'},{idempotencyKey:'k'});
  for(let i=0;i<4;i++)runtime.advance(task.taskId);
  const events=runtime.readEvents('tasks');
  try{
    const insert=db.prepare('INSERT OR IGNORE INTO fixture_events VALUES (?, ?, ?)');
    for(const event of [...events,...events])insert.run(event.sequence,event.eventId,JSON.stringify(event));
  }finally{db.close();}
  db=openStorage(path,[...migrations,{version:2,sql:'ALTER TABLE fixture_events ADD COLUMN verification TEXT NOT NULL DEFAULT \'mock\''}]);
  try{
    const rows=db.prepare('SELECT json FROM fixture_events ORDER BY sequence').all();
    assert.equal(rows.length,events.length);
    const cursor=new EventCursor('tasks');
    const replay=cursor.accept(rows.map(row=>JSON.parse(row.json)));
    assert.equal(replay.at(-1).type,'task.completed');
    assert.equal(replay.at(-1).payload.state,'succeeded');
    assert.equal(cursor.afterSequence,events.at(-1).sequence);
  }finally{db.close();}
});
