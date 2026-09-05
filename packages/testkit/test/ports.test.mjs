import assert from 'node:assert/strict';
import {test} from 'node:test';
import {FakeClock,FakeStorage,FakeToolHost,FakeConnector} from '../dist/index.js';
import {register} from '../examples/connector-provider.mjs';
test('fake storage namespaces isolate data and return copies',()=>{
  const storage=new FakeStorage(),a=storage.namespace('a'),b=storage.namespace('b');
  const input={value:1};a.set('key',input);input.value=2;
  const read=a.get('key');read.value=3;
  assert.equal(a.get('key').value,1);assert.equal(b.get('key'),undefined);
  a.delete('key');assert.equal(a.get('key'),undefined);
});
test('tool registration validates scope, input, output, deadline and disposal',async()=>{
  const clock=new FakeClock(),host=new FakeToolHost(clock.now),dispose=register(host);
  const context={taskId:'t',runId:'r',authorizationRef:'fixture',signal:new AbortController().signal,deadline:new Date(clock.now()+1000).toISOString(),scopes:['fixture:read']};
  await assert.rejects(host.invoke('fixture.search',{query:'plan'},{...context,scopes:[]}),{code:'SCOPE_DENIED'});
  await assert.rejects(host.invoke('fixture.search',{query:1},context),{code:'INVALID_ARGUMENT'});
  assert.equal((await host.invoke('fixture.search',{query:'plan'},context)).length,1);
  clock.advance(1000);
  await assert.rejects(host.invoke('fixture.search',{query:'plan'},context),{code:'TIMEOUT'});
  dispose();
  await assert.rejects(host.invoke('fixture.search',{query:'plan'},context),{code:'UNSUPPORTED_CAPABILITY'});
});
test('tool rejects bad output and respects already-aborted calls',async()=>{
  const clock=new FakeClock(),host=new FakeToolHost(clock.now);
  host.register({descriptor:{name:'bad',version:'1',inputSchema:{type:'object'},outputSchema:{type:'string'},sideEffect:'read',requiredScopes:[],idempotencySupport:true,recoverySupport:true,requiresPresence:false},execute:async()=>42});
  const controller=new AbortController();
  const context={taskId:'t',runId:'r',authorizationRef:'fixture',signal:controller.signal,deadline:new Date(clock.now()+1000).toISOString(),scopes:[]};
  await assert.rejects(host.invoke('bad',{},context),{code:'INVALID_ARGUMENT'});
  controller.abort();
  await assert.rejects(host.invoke('bad',{},context),{code:'CANCELLED'});
});
test('connector fixture paginates by account, reads back and refuses writes',()=>{
  const item={source:'fixture',accountRef:'a',externalId:'1',occurredAt:'2026-09-05T12:00:00Z',fetchedAt:'2026-09-05T12:00:00Z',contentRef:'fixture://one',sensitivity:'test',dedupeKey:'1'};
  const connector=new FakeConnector([item,{...item,externalId:'2',dedupeKey:'2'},{...item,accountRef:'b'}]);
  assert.throws(()=>connector.search('a','one'),{code:'UNAUTHORIZED'});
  connector.connect();
  const first=connector.fetchChanges({accountRef:'a',limit:1});
  assert.equal(first.hasMore,true);
  const second=connector.fetchChanges({accountRef:'a',limit:1,cursor:first.nextCursor});
  assert.equal(second.hasMore,false);assert.equal(second.items[0].externalId,'2');
  assert.equal(connector.getItem('a','1').contentRef,'fixture://one');
  assert.throws(()=>connector.performAction({}),{code:'UNSUPPORTED_CAPABILITY'});
  connector.disconnect();assert.equal(connector.health().state,'disconnected');
});
