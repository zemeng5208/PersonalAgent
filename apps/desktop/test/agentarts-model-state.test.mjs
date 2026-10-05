import test from 'node:test';
import assert from 'node:assert/strict';
import {agentArtsModelSnapshot} from '../electron/agentarts-model-state.js';
import {agentArtsModelPage} from '../src/features/admin/agentarts-model.js';
const cached={provider:'agentarts',configured:true,keyConfigured:true,status:'configured',
  baseUrl:'https://old.huaweicloud-agentarts.com',deployment:'old-runtime',verification:'unverified'};
const escape=value=>String(value).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

test('AgentArts model projection displays revoked credentials instead of cached startup configuration',()=>{
  const projected=agentArtsModelSnapshot(cached,{configured:false,gatewayUrl:'',runtimeName:'',reason:'请重新配置'});
  assert.equal(projected.configured,false);assert.equal(projected.keyConfigured,false);
  assert.equal(projected.status,'unconfigured');assert.equal(projected.deployment,'');
  const html=agentArtsModelPage(projected,escape);
  assert.match(html,/尚未配置|请重新配置/);assert.doesNotMatch(html,/old-runtime|已配置；/);
  assert.equal(cached.configured,true,'read-only projection never mutates the cached model');
});
test('AgentArts model projection reflects the current saved destination without claiming a connection test',()=>{
  const projected=agentArtsModelSnapshot(cached,{configured:true,gatewayUrl:'https://new.huaweicloud-agentarts.com',
    runtimeName:'new-runtime',reason:'已保存；需重启应用'});
  assert.equal(projected.baseUrl,'https://new.huaweicloud-agentarts.com');assert.equal(projected.deployment,'new-runtime');
  assert.equal(projected.status,'configured');assert.equal(projected.verification,'unverified');
  assert.equal(projected.lastTestAt,null);assert.equal(projected.latencyMs,null);
  assert.match(agentArtsModelPage(projected,escape),/new-runtime|需重启应用/);
});
test('AgentArts model projection preserves failed deletion status and requires an explicit configured boolean',()=>{
  const projected=agentArtsModelSnapshot(cached,{configured:false,reason:'未能删除本机配置；撤销尚未确认'});
  assert.equal(projected.configured,false);assert.match(agentArtsModelPage(projected,escape),/未能删除/);
  assert.equal(agentArtsModelSnapshot(cached,{configured:'true'}).configured,false);
  assert.equal(agentArtsModelSnapshot(cached,undefined).configured,false);
});
