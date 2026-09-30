import test from 'node:test';
import assert from 'node:assert/strict';
import {resolveRuntimeProfile} from '../electron/runtime-profile.js';
test('normal startup selects Competition, explicit Fake selects Local, malformed profiles never fall back',()=>{
  assert.equal(resolveRuntimeProfile(),'huawei_ict_agentarts');
  assert.equal(resolveRuntimeProfile({fakeRuntime:true}),'local');
  assert.equal(resolveRuntimeProfile({fakeModel:true}),'local');
  assert.equal(resolveRuntimeProfile({profile:'local'}),'local');
  for(const profile of ['', 'unknown']) assert.throws(()=>resolveRuntimeProfile({profile}));
  assert.throws(()=>resolveRuntimeProfile({profile:'huawei_ict_agentarts',fakeModel:true}));
});
