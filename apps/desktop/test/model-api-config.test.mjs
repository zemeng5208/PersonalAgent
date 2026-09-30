import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdirSync,mkdtempSync,readFileSync} from 'node:fs';
import path from 'node:path';
import * as models from '@personal-agent/models';
import {createModelApiConfig} from '../electron/model-api-config.js';

const safeStorage = {isEncryptionAvailable:()=>true,encryptString:value=>Buffer.from(value).reverse(),
  decryptString:value=>Buffer.from(value).reverse().toString()};
const input = {provider:'openai-compatible',baseUrl:'https://synthetic.invalid/v1',model:'text-model',displayName:'Research',apiKey:'synthetic-secret'};
const request = () => ({messages:[{role:'user',content:'Synthetic request'}],tools:[],
  signal:new AbortController().signal,deadline:new Date(Date.now()+60_000).toISOString()});
function fixture(fetch) {
  const base = new URL('../../../.cache/model-api-config-tests/',import.meta.url);
  mkdirSync(base,{recursive:true});
  const userData = mkdtempSync(base);
  const modelApi = {...models,
    OpenAICompatibleModelProvider:class extends models.OpenAICompatibleModelProvider {constructor(options) {super({...options,fetch});}},
    PanguModelProvider:class extends models.PanguModelProvider {constructor(options) {super({...options,fetch});}}};
  const options = {userData,safeStorage,modelApi};
  return {options,host:createModelApiConfig(options)};
}
const answer = () => new Response(JSON.stringify({choices:[{message:{content:'Synthetic answer'}}]}));
test('encrypted model config restores, masks keys, preserves only same-destination keys and selects exact model', async () => {
  const calls = [];
  const {host,options} = fixture(async (url,init)=>{calls.push({url,init});return answer();});
  const state = host.configure({...input,id:'research',makeDefault:true});
  assert.doesNotMatch(JSON.stringify(state),/synthetic-secret|apiKey/);
  assert.doesNotMatch(readFileSync(path.join(options.userData,'model-api-config.json'),'utf8'),/synthetic-secret/);
  assert.equal(calls.length,0);
  assert.equal(host.getModelGateway('unknown'),undefined);
  assert.deepEqual(host.getModelReasoningEfforts('research'),[]);
  host.configure({...input,id:'research',apiKey:''});
  assert.throws(()=>host.configure({...input,id:'research',apiKey:'',baseUrl:'https://different.invalid/v1'}));
  assert.throws(()=>host.configure({...input,id:'research',apiKey:'',provider:'pangu'}));
  const restored = createModelApiConfig(options);
  assert.equal(restored.snapshot().defaultId,'research');
  await restored.getModelGateway().complete(request());
  assert.equal(calls[0].init.headers.authorization,'Bearer synthetic-secret');
  assert.equal(calls[0].url,'https://synthetic.invalid/v1/chat/completions');
  host.configure({...input,id:'research',apiKey:'',makeDefault:false});
  assert.equal(host.snapshot().defaultId,'');
  assert.equal(host.getModelGateway(),undefined);
  const stale = host.getModelGateway('research');
  host.remove({id:'research'});
  assert.equal(host.getModelGateway(),undefined);
  await assert.rejects(stale.complete(request()));
  assert.equal(createModelApiConfig(options).snapshot().models.length,0);
  restored.dispose(); host.dispose();
});
test('changing, disabling or disposing model configuration aborts inflight calls and revokes old references', async () => {
  for (const action of ['change','disable','dispose']) {
    let started, observed;
    const ready = new Promise(resolve=>{started=resolve;});
    const {host} = fixture(async (_url,init)=>{observed=init.signal;started();return new Promise((_,reject)=>{
      init.signal.addEventListener('abort',()=>reject(Error('synthetic abort')),{once:true});});});
    host.configure({...input,id:'research'});
    const gateway = host.getModelGateway('research');
    const completion = gateway.complete(request());
    const rejected = assert.rejects(completion);
    await ready;
    if (action==='dispose') host.dispose();
    else host.configure({...input,id:'research',apiKey:'',...(action==='disable'?{enabled:false}:{model:'changed'})});
    await rejected; assert.equal(observed.aborted,true);
    await assert.rejects(gateway.complete(request()));
    host.dispose();
  }
});
test('unsafe storage, credential URLs and missing provider stay unavailable without network calls', () => {
  const {options,host} = fixture(()=>{throw Error('must not call');});
  const noStorage = createModelApiConfig({...options,safeStorage:{isEncryptionAvailable:()=>false}});
  assert.throws(()=>noStorage.configure(input),/安全存储/);
  for (const baseUrl of ['http://remote.invalid/v1','https://user:secret@synthetic.invalid/v1','https://synthetic.invalid/v1?token=secret']) {
    assert.throws(()=>host.configure({...input,baseUrl}));
  }
  const missing = createModelApiConfig({...options,modelApi:{...models,OpenAICompatibleModelProvider:undefined}});
  missing.configure({...input,id:'absent'});
  assert.equal(missing.snapshot().configured,false);
  assert.equal(missing.getModelGateway(),undefined);
  assert.equal(missing.snapshot().models[0].capabilities.nativeReasoning,false);
  host.dispose();missing.dispose();noStorage.dispose();
});
