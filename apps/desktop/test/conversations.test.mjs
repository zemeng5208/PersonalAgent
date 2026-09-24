import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,mkdirSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {Conversations} from '../electron/conversations.js';

test('two conversations retain independent metadata and context after restart',()=>{
  const cache=fileURLToPath(new URL('../.cache/',import.meta.url));mkdirSync(cache,{recursive:true});
  const folder=mkdtempSync(path.join(cache,'conversation-test-'));
  try{
    const file=path.join(folder,'turns.json');
    const journal=new Conversations(file);
    journal.add('small-1','panel','我的小窗口信息');
    journal.add('big-1','workspace','我的大窗口信息');
    journal.add('small-2','panel','继续');
    journal.add('big-2','workspace','继续');
    const reloaded=new Conversations(file);
    const tasks=[{taskId:'small-1',state:'succeeded',resultSummary:'小窗口回答 [model=p/a/b; verification=mock; tokens=unknown]'},{taskId:'big-1',state:'succeeded',resultSummary:'大窗口回答'},{taskId:'small-2',state:'running'},{taskId:'big-2',state:'running'}];
    assert.deepEqual(reloaded.history(tasks,'small-2'),[{role:'user',content:'我的小窗口信息'},{role:'assistant',content:'小窗口回答 [model=p/a/b; verification=mock; tokens=unknown]'}]);
    assert.deepEqual(reloaded.history(tasks,'big-2'),[{role:'user',content:'我的大窗口信息'},{role:'assistant',content:'大窗口回答'}]);
    assert.equal(reloaded.goal('small-1'),'我的小窗口信息');
    assert.equal(reloaded.surface('legacy-record'),'panel');
  }finally{rmSync(folder,{recursive:true,force:true});}
});
