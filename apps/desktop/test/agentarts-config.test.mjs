import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createAgentArtsConfig} from '../electron/agentarts-config.js';

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
