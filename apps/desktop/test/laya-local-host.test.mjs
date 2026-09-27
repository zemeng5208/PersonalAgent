import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {createLocalLayaHost} from '../electron/laya-local-host.js';

test('local Laya requires free memory, owns one child, and revokes classification on stop', async () => {
  let launches = 0, options, inferenceSignal, choiceSignal;
  const child = new EventEmitter();
  child.kill = () => {queueMicrotask(() => child.emit('exit', 0)); return true;};
  const setup = {projectRoot:'project', discover:() => ({python:'python', script:'batch.py', model:'model'}),
    launch:(_exe,_args,value) => {launches++; options=value; return child;},
    request:async (_url, value) => {assert.match(value.headers.authorization, /^Bearer [a-f0-9]{64}$/);
      return {ok:true, json:async () => ({status:'ok', model:'multilingual', capabilities:['multi_state'], maxStates:4})};},
    createService:() => ({classify:async value => {inferenceSignal=value.signal; return ['local'];}}),
    createChooser:()=>({choose:async value=>{choiceSignal=value.signal;return {state:'selected',selected:{id:'recheck',revision:1}};}})};
  const low = createLocalLayaHost({...setup, freeMemory:() => 512 * 1024 ** 2});
  assert.equal((await low.start()).state, 'memory_insufficient'); assert.equal(launches,0);
  const host = createLocalLayaHost({...setup, freeMemory:() => 8 * 1024 ** 3});
  const [first, second] = await Promise.all([host.start(), host.start()]);
  assert.equal(first.ready,true); assert.equal(second.ready,true); assert.equal(launches,1);
  assert.equal(options.windowsHide,true); assert.equal(options.shell,false);
  assert.equal(options.env.PA_AGENTARTS_AUTHORIZATION,undefined);
  assert.equal(options.env.HF_HUB_OFFLINE,'1');
  assert.deepEqual(await host.classify({signal:new AbortController().signal}), ['local']);
  assert.equal((await host.choose({signal:new AbortController().signal})).selected.id,'recheck');
  assert.equal((await host.stop()).state,'stopped'); assert.equal(inferenceSignal.aborted,true);
  assert.equal(choiceSignal.aborted,true);
  await assert.rejects(host.classify({signal:new AbortController().signal}), /尚未就绪/);
  await assert.rejects(host.choose({signal:new AbortController().signal}), /尚未就绪/);
});
