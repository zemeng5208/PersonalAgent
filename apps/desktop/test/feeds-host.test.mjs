import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync} from 'node:fs';
import path from 'node:path';
import {HttpFeedProvider,encodeCursor} from '@personal-agent/feeds';
import {createDesktopFeedsHost} from '../electron/feeds-host.js';

// Test configuration stays in the repository's ignored cache; no account credentials are used.
import {mkdirSync} from 'node:fs';
const cache = new URL('../../../.cache/feeds-host-tests/',import.meta.url);
mkdirSync(cache,{recursive:true});
const safeStorage = {isEncryptionAvailable:()=>true,encryptString:value=>Buffer.from(value).reverse(),
  decryptString:value=>Buffer.from(value).reverse().toString()};
function runtime() {
  const records = new Map();
  return {runtime:{loadCheckpoint:(id,key)=>records.get(id+key),saveCheckpoint:(id,key,value)=>records.set(id+key,value)}};
}
const request = id => ({taskId:id,signal:new AbortController().signal,deadline:new Date(Date.now()+30_000).toISOString(),scopes:['feeds:read']});
const xml = '<?xml version="1.0"?><rss version="2.0"><channel><title>Engineering updates</title><link>https://example.com/</link>'
  + '<item><guid>one</guid><title>New release</title><link>https://example.com/one</link><pubDate>Sun, 27 Sep 2026 08:00:00 GMT</pubDate><description>Release summary</description></item>'
  + '<item><guid>two</guid><title>Previous release</title><pubDate>Sat, 26 Sep 2026 08:00:00 GMT</pubDate></item></channel></rss>';

test('configured feeds reuse connector parsing and pagination with session-bound read/export permission', async () => {
  const userData = mkdtempSync(new URL('configured-',cache)); let calls = 0;
  const provider = new HttpFeedProvider({fetchImpl:async()=>{
    calls++; return {status:200,headers:{get:()=>null},body:null,text:async()=>xml};
  }});
  let host = createDesktopFeedsHost({userData,safeStorage,provider});
  const configured = host.add({title:'Engineering updates',url:'https://example.com/rss?token=synthetic-secret-123'});
  assert.doesNotMatch(JSON.stringify(configured),/example\.com|synthetic-secret/);
  assert.doesNotMatch(readFileSync(path.join(userData,'feeds-config.json'),'utf8'),/synthetic-secret/);
  host.close();
  host = createDesktopFeedsHost({userData,safeStorage,provider}); host.prepare(); host.bindApplication(runtime());
  try {
    const context = request('feed-task');
    const binding = host.competitionToolAvailability.find(item=>item.toolName==='feeds.collect');
    const collect = host.tools.find(item=>item.descriptor.name==='feeds.collect');
    const list = host.tools.find(item=>item.descriptor.name==='feeds.subscriptions');
    const policy = host.competitionToolExports.find(item=>item.toolName==='feeds.collect');
    assert.equal(calls,0); assert.equal(binding.available(context),false);
    host.authorize({readAndCloudConsent:true}); assert.equal(binding.available(context),true);
    const listed = await list.execute({},context);
    assert.equal(listed.subscriptions[0].title,'Engineering updates');
    const subscriptionId = listed.subscriptions[0].id;
    const first = await collect.execute({subscriptionId,limit:1},context);
    assert.equal(first.items.length,1); assert.equal(first.hasMore,true);
    assert.equal(policy.project({...context,result:first}).items[0].title,'New release');
    const next = await collect.execute({subscriptionId,limit:1,cursor:first.nextCursor},context);
    assert.equal(next.items[0].title,'Previous release'); assert.equal(next.hasMore,false);
    await assert.rejects(collect.execute({subscriptionId:'unregistered'},context)); assert.equal(calls,2);
    const leakedCursor = encodeCursor({v:1,seen:[],etag:'synthetic-secret-123'});
    assert.throws(()=>policy.project({...context,result:{...first,nextCursor:leakedCursor}}),/受保护配置/);
    host.revoke(); assert.equal(policy.accepts(context),false);
    host.authorize({readAndCloudConsent:true}); assert.equal(binding.available(context),false);
    assert.equal(binding.available(request('new-task')),true);
    host.remove({id:subscriptionId}); assert.equal(host.snapshot().requiresRestart,true);
    assert.equal(binding.available(request('third-task')),false);
  } finally {host.close();}
  const reopened = createDesktopFeedsHost({userData,safeStorage,provider});
  assert.equal(reopened.snapshot().sessionAllowed,false); reopened.close();
});

test('revocation rejects an in-flight result even if the provider ignores cancellation', async () => {
  const userData = mkdtempSync(new URL('revocation-',cache)); let finish;
  const provider = new HttpFeedProvider({fetchImpl:async()=>{
    await new Promise(resolve=>{finish=resolve;});
    return {status:200,headers:{get:()=>null},body:null,text:async()=>xml};
  }});
  const host = createDesktopFeedsHost({userData,safeStorage,provider});
  host.add({title:'Updates',url:'https://example.com/rss'}); host.prepare(); host.bindApplication(runtime());
  const context = request('revocation-task'); host.authorize({readAndCloudConsent:true});
  host.competitionToolAvailability.find(item=>item.toolName==='feeds.collect').available(context);
  const task = host.tools.find(item=>item.descriptor.name==='feeds.collect').execute(
    {subscriptionId:host.snapshot().subscriptions[0].id},context);
  host.revoke(); finish();
  await assert.rejects(task); host.close();
});
