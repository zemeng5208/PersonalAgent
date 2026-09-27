import test from 'node:test';
import assert from 'node:assert/strict';
import {existsSync,mkdirSync,mkdtempSync,readFileSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createAgentArtsConfig} from '../electron/agentarts-config.js';
import {createDeferredRuntimeStartup} from '../electron/runtime-startup.js';
import {createAgentArtsRuntimeApplication} from '@personal-agent/runtime/application';
import {Client} from '@personal-agent/client';

test('AgentArts credential persists through host storage without snapshot disclosure or destination reuse',()=>{
  const userData=mkdtempSync(path.join(os.tmpdir(),'pa-cloud-config-'));
  const safeStorage={isEncryptionAvailable:()=>true,
    encryptString:value=>Buffer.from(value).reverse(),decryptString:value=>Buffer.from(value).reverse().toString()};
  const options={userData,safeStorage,environment:{}};
  let config=createAgentArtsConfig(options);
  const input={gatewayUrl:'https://example.cn-southwest-2.huaweicloud-agentarts.com',runtimeName:'test-runtime',authorization:'Bearer synthetic-only'};
  assert.equal(config.snapshot().configured,false);
  const snapshot=config.configure(input);
  assert.doesNotMatch(JSON.stringify(snapshot),/synthetic-only|Bearer/);
  assert.doesNotMatch(readFileSync(path.join(userData,'agentarts-config.json'),'utf8'),/synthetic-only|Bearer/);
  config=createAgentArtsConfig(options);
  const binding=config.binding();
  assert.equal(config.readAuthorization(binding),input.authorization);
  assert.throws(()=>config.configure({...input,authorization:'',gatewayUrl:'https://different.huaweicloud-agentarts.com'}));
  assert.throws(()=>config.configure({...input,gatewayUrl:'https://untrusted.example.com'}));
  assert.throws(()=>config.configure({...input,authorization:'x\r\nAuthorization: y'}));
  config.configure({...input,authorization:'Bearer replacement',runtimeName:'other-runtime'});
  assert.throws(()=>config.readAuthorization(binding));
});

test('known AgentArts destination permits Runtime and Live construction without inventing or overwriting a credential',async()=>{
  const cache=new URL('../../../.cache/agentarts-config-tests/',import.meta.url);
  mkdirSync(cache,{recursive:true});
  const userData=mkdtempSync(new URL('missing-credential-',cache));
  const config=createAgentArtsConfig({userData,safeStorage:{isEncryptionAvailable:()=>true},environment:{
    PA_AGENTARTS_GATEWAY_URL:'https://example.cn-southwest-2.huaweicloud-agentarts.com',
    PA_AGENTARTS_RUNTIME_NAME:'synthetic-runtime'}});
  assert.equal(config.snapshot().configured,false);assert.equal(config.snapshot().runtimeReady,true);
  const binding=config.runtimeBinding();assert.ok(binding);
  assert.throws(()=>config.readAuthorization(binding));
  let application,requests=0;
  const startup=createDeferredRuntimeStartup({isConfigured:()=>config.snapshot().runtimeReady,
    initialize:async()=>{application=createAgentArtsRuntimeApplication({path:path.join(userData,'runtime.sqlite'),
      ...binding,authorizationProvider:{read:async()=>config.readAuthorization(binding)},
      fetchImpl:async()=>{requests++;throw Error('No cloud call is expected without credentials');}});}});
  try {
    assert.equal((await startup.start()).state,'ready');
    assert.equal(typeof application.createLiveVoiceModel({workspaceId:'synthetic',apiKey:'synthetic-only'}).connect,'function');
    const client=new Client(application,Date.now);await client.connect();
    const receipt=await client.call('task.submit',{goal:'Synthetic missing-credential check',conversationId:'desktop-panel'},{idempotencyKey:'missing-credential'});
    for(let i=0;i<50 && !['failed','succeeded'].includes(application.runtime.getTask(receipt.taskId).state);i++) {
      await new Promise(resolve=>setTimeout(resolve,5));
    }
    assert.equal(application.runtime.getTask(receipt.taskId).state,'failed');
    assert.equal(requests,0);
    assert.equal(existsSync(path.join(userData,'agentarts-config.json')),false);
    assert.equal(config.snapshot().configured,false);
  } finally {application?.close();}
  const missing=createAgentArtsConfig({userData,safeStorage:{},environment:{}});
  assert.equal(missing.snapshot().runtimeReady,false);assert.equal(missing.runtimeBinding(),undefined);
});
