import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {mkdir,mkdtemp,writeFile,rm,utimes} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createLocalLayaHost} from '../electron/laya-local-host.js';

async function artifacts(t) {
  const cache=fileURLToPath(new URL('../../../.cache/laya-identity-test/',import.meta.url));
  await mkdir(cache,{recursive:true});const directory=await mkdtemp(path.join(cache,'case-'));
  const model=path.join(directory,'model'),script=path.join(directory,'batch-server.py');
  await mkdir(model);await writeFile(path.join(model,'model.safetensors'),'synthetic weights');
  await writeFile(path.join(model,'rl_agent_config.json'),'{"synthetic":true}');
  await writeFile(script,'# synthetic batch implementation');
  t.after(()=>rm(directory,{recursive:true,force:true}));
  return {python:'synthetic-python',model,script};
}
const healthy=()=>({ok:true,json:async()=>({status:'ok',model:'multilingual',capabilities:['multi_state'],maxStates:4})});
function fakeChild() {
  const child=new EventEmitter();child.kill=()=>{queueMicrotask(()=>child.emit('exit',0));return true;};return child;
}

test('local Laya requires free memory, owns one child, and revokes classification on stop', async t => {
  const config=await artifacts(t);
  let launches = 0, options, inferenceSignal, choiceSignal;
  const child = new EventEmitter();
  child.kill = () => {queueMicrotask(() => child.emit('exit', 0)); return true;};
  const setup = {projectRoot:'project', discover:() => config,
    launch:(_exe,_args,value) => {launches++; options=value; return child;},
    request:async (_url, value) => {assert.match(value.headers.authorization, /^Bearer [a-f0-9]{64}$/);
      return {ok:true, json:async () => ({status:'ok', model:'multilingual', capabilities:['multi_state'], maxStates:4})};},
    createService:() => ({classify:async value => {inferenceSignal=value.signal; return ['local'];}}),
    createChooser:()=>({choose:async value=>{choiceSignal=value.signal;return {state:'selected',selected:{id:'recheck',revision:1}};}})};
  const low = createLocalLayaHost({...setup, freeMemory:() => 512 * 1024 ** 2});
  assert.equal((await low.start()).state, 'memory_insufficient'); assert.equal(launches,0);
  const host = createLocalLayaHost({...setup, freeMemory:() => 8 * 1024 ** 3});
  assert.equal(host.readClassifierIdentity(),undefined);
  const [first, second] = await Promise.all([host.start(), host.start()]);
  assert.equal(first.ready,true); assert.equal(second.ready,true); assert.equal(launches,1);
  assert.match(host.readClassifierIdentity(),/^[a-f0-9]{64}$/);
  assert.doesNotMatch(JSON.stringify(host.snapshot()),/synthetic-python|safetensors|batch-server|[a-f0-9]{64}/);
  assert.equal(options.windowsHide,true); assert.equal(options.shell,false);
  assert.equal(options.env.PA_AGENTARTS_AUTHORIZATION,undefined);
  assert.equal(options.env.HF_HUB_OFFLINE,'1');
  assert.deepEqual(await host.classify({signal:new AbortController().signal}), ['local']);
  assert.equal((await host.choose({signal:new AbortController().signal})).selected.id,'recheck');
  assert.equal((await host.stop()).state,'stopped'); assert.equal(inferenceSignal.aborted,true);
  assert.equal(choiceSignal.aborted,true);
  assert.equal(host.readClassifierIdentity(),undefined);
  await assert.rejects(host.classify({signal:new AbortController().signal}), /尚未就绪/);
  await assert.rejects(host.choose({signal:new AbortController().signal}), /尚未就绪/);
});

test('loaded identity is content-stable across restart and changes with weights, config or server',async t=>{
  const config=await artifacts(t);
  const host=createLocalLayaHost({projectRoot:'project',discover:()=>config,freeMemory:()=>8*1024**3,
    launch:fakeChild,request:async()=>healthy(),createService:()=>({classify:async()=>[]})});
  t.after(()=>host.stop());
  await host.start();const first=host.readClassifierIdentity();
  await host.stop();await host.start();assert.equal(host.readClassifierIdentity(),first);
  for(const location of [path.join(config.model,'model.safetensors'),path.join(config.model,'rl_agent_config.json'),config.script]) {
    const before=host.readClassifierIdentity();
    await writeFile(location,`synthetic changed ${path.basename(location)}`);
    assert.equal(host.readClassifierIdentity(),undefined);
    assert.equal(host.snapshot().state,'identity_changed');
    await assert.rejects(host.classify({signal:new AbortController().signal}),/尚未就绪/);
    await host.stop();await host.start();assert.notEqual(host.readClassifierIdentity(),before);
  }
  // Metadata-only changes revoke readiness conservatively, but a new explicit load keeps content identity stable.
  const unchanged=host.readClassifierIdentity();
  await utimes(config.script,new Date(1000),new Date(1000));
  assert.equal(host.snapshot().ready,false);await host.stop();await host.start();
  assert.equal(host.readClassifierIdentity(),unchanged);
});

test('cancellation and unknown or changed startup artifacts cannot publish an identity',async t=>{
  const config=await artifacts(t);let launches=0;
  const setup={projectRoot:'project',discover:()=>config,freeMemory:()=>8*1024**3,
    launch:()=>{launches++;return fakeChild();},request:async()=>healthy(),createService:()=>({classify:async()=>[]})};
  const cancelled=createLocalLayaHost(setup);
  const startup=cancelled.start();await cancelled.stop();await startup;
  assert.equal(launches,0);assert.equal(cancelled.snapshot().state,'stopped');
  assert.equal(cancelled.readClassifierIdentity(),undefined);
  const changed=createLocalLayaHost({...setup,sleep:async()=>{},request:async()=>{
    await writeFile(config.script,'# replaced during model load');return healthy();}});
  assert.equal((await changed.start()).state,'error');assert.equal(changed.readClassifierIdentity(),undefined);
  const missing=createLocalLayaHost({...setup,discover:()=>({...config,model:path.join(config.model,'missing')})});
  assert.equal((await missing.start()).state,'error');assert.equal(missing.readClassifierIdentity(),undefined);
  const exited=createLocalLayaHost({...setup,launch:()=>{const child=fakeChild();queueMicrotask(()=>child.emit('exit',1));return child;}});
  assert.equal((await exited.start()).ready,false);assert.equal(exited.readClassifierIdentity(),undefined);
});
