import test from 'node:test';
import assert from 'node:assert/strict';
import {mountAgentArtsControls} from '../src/app/agentarts-controls.js';

function harness(t,invoke) {
  const previous=Object.getOwnPropertyDescriptor(globalThis,'document');
  t.after(()=>{if(previous) Object.defineProperty(globalThis,'document',previous);else delete globalThis.document;});
  const node=()=>({value:'',disabled:false,textContent:'',listeners:new Map(),attributes:new Map(),
    addEventListener(name,listener){this.listeners.set(name,listener);},
    setAttribute(name,value){this.attributes.set(name,value);}});
  const fields=Object.fromEntries(['gatewayUrl','runtimeName','authorization'].map(key=>[key,node()]));
  const submit=node(),revoke=node(),status=node(),form=node();
  Object.assign(form,{elements:fields,querySelector:()=>submit,
    querySelectorAll:()=>[...Object.values(fields),submit,revoke],
    reset(){Object.values(fields).forEach(field=>{field.value='';});}});
  const section={querySelector:selector=>selector==='form'?form:selector==='[data-status]'?status:revoke};
  globalThis.document={createElement:()=>section};
  const controls=mountAgentArtsControls({append(){}},invoke);
  controls.render({gatewayUrl:'https://example.huaweicloud-agentarts.com',runtimeName:'synthetic-runtime'});
  return {controls,fields,submit,revoke,status,save:()=>form.listeners.get('submit')({preventDefault(){}}),
    clear:()=>revoke.listeners.get('click')()};
}

test('AgentArts settings serialize save/revoke and preserve the pending destination across snapshots',async t=>{
  const calls=[];let resolve;
  const ui=harness(t,(action,input)=>{calls.push({action,input});return new Promise(done=>{resolve=done;});});
  ui.fields.authorization.value='Bearer synthetic-only';
  const pending=ui.save();
  assert.equal(ui.fields.authorization.value,'');
  await ui.save();await ui.clear();
  assert.equal(calls.length,1,'a pending save cannot dispatch another save or revoke');
  ui.controls.render({gatewayUrl:'https://stale.huaweicloud-agentarts.com',runtimeName:'stale'});
  assert.equal(ui.fields.runtimeName.value,'synthetic-runtime');
  assert.equal(ui.revoke.disabled,true);
  assert.ok(Object.values(ui.fields).every(field=>field.disabled));
  resolve({configured:true,reason:'synthetic saved'});await pending;
  assert.equal(calls[0].input.authorization,'','request credential is scrubbed after settlement');
  assert.equal(ui.status.textContent,'synthetic saved');
  assert.equal(ui.revoke.disabled,false);
  const revoking=ui.clear();await ui.save();
  assert.equal(calls.length,2);
  resolve({configured:false});await revoking;
  assert.equal(ui.fields.runtimeName.value,'');
  assert.match(ui.status.textContent,/凭据已清除/);
});

test('AgentArts settings keep failed writes unconfirmed, redact errors, and allow explicit retry',async t=>{
  let reject;
  const ui=harness(t,()=>new Promise((_,fail)=>{reject=fail;}));
  const pending=ui.clear();reject(Error('private-path synthetic-secret'));await pending;
  assert.match(ui.status.textContent,/撤销结果未获确认/);
  assert.equal(ui.status.attributes.get('role'),'alert');
  assert.doesNotMatch(ui.status.textContent,/private-path|synthetic-secret/);
  assert.equal(ui.submit.disabled,false);
  const retry=ui.save();reject(Error('private-path synthetic-secret'));await retry;
  assert.match(ui.status.textContent,/保存结果未获确认/);
  assert.ok(Object.values(ui.fields).every(field=>!field.disabled));
});

test('AgentArts settings require matching configuration readback before showing success',async t=>{
  let result;
  const ui=harness(t,async()=>result);
  for(result of [undefined,{configured:false,reason:'synthetic success claim'}]) {
    await ui.save();assert.match(ui.status.textContent,/保存结果未获确认/);
  }
  result={configured:true,reason:'synthetic revoked claim'};
  await ui.clear();assert.match(ui.status.textContent,/撤销结果未获确认/);
});

test('AgentArts settings refresh host status while keeping pending and unconfirmed actions explicit',async t=>{
  let resolve,reject;
  const ui=harness(t,()=>new Promise((done,fail)=>{resolve=done;reject=fail;}));
  ui.controls.render({configured:false,reason:'synthetic not configured'});
  assert.equal(ui.status.textContent,'synthetic not configured');
  ui.controls.render({configured:true,reason:'synthetic host configured'});
  assert.equal(ui.status.textContent,'synthetic host configured');
  const pending=ui.save();
  ui.controls.render({configured:false,reason:'synthetic interim host status'});
  assert.match(ui.status.textContent,/正在保存/);
  reject(Error('private diagnostic'));await pending;
  ui.controls.render({configured:true,reason:'synthetic older success claim'});
  assert.match(ui.status.textContent,/保存结果未获确认/);
  assert.equal(ui.status.attributes.get('role'),'alert');
  const retry=ui.save();resolve({configured:true,reason:'synthetic confirmed save'});await retry;
  assert.equal(ui.status.textContent,'synthetic confirmed save');
  assert.equal(ui.status.attributes.get('role'),'status');
  ui.controls.render({configured:false,reason:'synthetic host revoked'});
  assert.equal(ui.status.textContent,'synthetic host revoked','fresh host status supersedes completed success feedback');
  const revoking=ui.clear();
  ui.controls.render({configured:true,reason:'synthetic concurrent publication'});
  assert.match(ui.status.textContent,/正在撤销/);
  reject(Error('private diagnostic'));await revoking;
  ui.controls.render({configured:false,reason:'synthetic apparent revocation'});
  assert.match(ui.status.textContent,/撤销结果未获确认/);
  assert.equal(ui.status.attributes.get('role'),'alert');
});
