import assert from 'node:assert/strict';
import {mkdir, mkdtemp, rm, writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import test from 'node:test';
import {Client} from '@personal-agent/client';
import {createAgentArtsRuntimeApplication} from '@personal-agent/runtime/application';
import {openSqliteMemoryHost} from '@personal-agent/memory/sqlite';
import {createPrivateMemoryController} from '../../apps/desktop/electron/private-memory.js';
import {createPrivateMemoryConsumptionHost} from '../../apps/desktop/electron/private-memory-consumption-host.js';
import {createPrivateMemoryErasureHost} from '../../apps/desktop/electron/private-memory-erasure-host.js';

const context = () => ({deadline: new Date(Date.now() + 60000).toISOString(), signal: new AbortController().signal});
async function terminal(app, taskId) {
  for (let attempt = 0; attempt < 2000; attempt++) {
    const task = app.runtime.getTask(taskId);
    if (['succeeded', 'failed', 'cancelled'].includes(task.state)) return task;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  throw Error('Synthetic private task did not settle');
}

async function fixture(t, asynchronousGate = false) {
  const parent = fileURLToPath(new URL('../../.cache/private-runtime-copies/', import.meta.url));
  await mkdir(parent, {recursive: true});
  const directory = await mkdtemp(join(parent, 'case-'));
  const vault = join(directory, 'vault');
  await mkdir(vault);
  await writeFile(join(vault, 'a.md'), 'Synthetic A: read the plan.\n');
  await writeFile(join(vault, 'b.md'), 'Synthetic B: preserve this independent fact.\n');
  const database = join(directory, 'memory.sqlite');
  const requests = [], consents = [], replies = new Map();
  let app, memory, consumption, erasure, client, beforeReply, callbackFailure, allowCopyPurge = false;
  async function open() {
    memory = createPrivateMemoryController(database, async () => true, async () => true,
      {confirmWithdraw: async () => true, authorizeConsumption: async scope => {consents.push(scope.taskId); return true;}});
    app = createAgentArtsRuntimeApplication({path: join(directory, 'runtime.sqlite'),
      gatewayUrl: 'https://private-memory.example.test', runtimeName: 'synthetic', invokeMode: 'published',
      authorizationProvider: {read: async () => 'Bearer synthetic-only'},
      fetchImpl: async (_url, input) => {
        requests.push(JSON.parse(input.body));
        if (beforeReply) {
          const callback = beforeReply;
          beforeReply = undefined;
          try {await callback();} catch (error) {callbackFailure = error;}
        }
        return new Response(JSON.stringify({event: 'message', data: {text: 'Synthetic private-derived reply', index: 0}}),
          {status: 200, headers: {'content-type': 'application/json'}});
      },
      coordinationInput: {
        prepareCoordinationGoal: async scope => (await consumption.prepare({...scope, goal: scope.publicGoal})).goal,
        beforeCoordinationSend: (request, scope) => consumption.assertCloudSend({...request, goal: scope.preparedGoal}),
        onEphemeralReply: async ({taskId, text}) => {replies.set(taskId, text);},
        eraseEphemeralCopies: async scope => {
          if (allowCopyPurge) replies.delete(scope.taskId);
          return {taskId: scope.taskId, factId: scope.factId, bindingDigest: scope.bindingDigest,
            state: allowCopyPurge ? 'purged' : 'withheld'};
        },
        releaseTask: taskId => consumption.releaseTask(taskId),
      }});
    consumption = createPrivateMemoryConsumptionHost({profile: 'huawei_ict_agentarts', privateMemory: memory,
      readTask: taskId => app.runtime.getTask(taskId), readTaskBinding: taskId => app.readPrivateTaskBinding(taskId),
      writeTaskBinding: (taskId, binding) => app.writePrivateTaskBinding(taskId, binding),
      readConfigurationRef: () => app.coordinationConfigurationRef,
      assertCopyManagement: () => asynchronousGate ? Promise.resolve() : erasure.assertReady([])});
    erasure = createPrivateMemoryErasureHost({privateMemory: memory, consumptionHost: consumption,
      listBindings: input => app.listBindings(input), cancelTask: taskId => app.runtime.requestCancel(taskId),
      eraseTaskCopies: scope => app.eraseTaskCopies(scope), readCopyErasureReceipt: taskId => app.readCopyErasureReceipt(taskId)});
    client = new Client(app, Date.now);
    await client.connect();
  }
  const close = () => {consumption?.close(); memory?.close(); app?.close();};
  await open();
  t.after(async () => {close(); await rm(directory, {recursive: true, force: true});});
  await memory.selectVault(vault);
  const sourceA = (await memory.search('Synthetic A')).hits[0].source;
  await memory.save(sourceA, 'Synthetic private A');
  await memory.save(sourceA, 'Synthetic corrected A');
  await memory.save((await memory.search('Synthetic B')).hits[0].source, 'Synthetic independent B');
  const facts = (await memory.listSaved()).facts;
  return {database, requests, consents, replies, facts, get app() {return app;}, get erasure() {return erasure;},
    get memory() {return memory;}, async restart() {close(); await open();},
    onNextRequest(callback) {beforeReply = callback;},
    allowPurge() {allowCopyPurge = true;},
    async submit(conversationId, ref) {
      consumption.select({conversationId, ref});
      const submitted = await client.call('task.submit', {goal: 'Review the confirmed fact', conversationId},
        {idempotencyKey: conversationId, ...context()});
      const task = await terminal(app, submitted.taskId);
      if (callbackFailure) throw callbackFailure;
      return task;
    }};
}

test('real Runtime copy receipts resume private erasure after restart and preserve an independent task', async t => {
  const f = await fixture(t);
  const target = f.facts.find(fact => fact.summary === 'Synthetic corrected A');
  const independent = f.facts.find(fact => fact.summary === 'Synthetic independent B');
  let child;
  f.onNextRequest(async () => {
    const parentTaskId = f.app.listBindings().items[0].taskId;
    assert.equal(f.app.runtime.getTask(parentTaskId).state, 'running');
    f.app.runtime.saveCheckpoint(parentTaskId, 'synthetic-private-body', {text: target.summary});
    // Synthetic child worker; actual Runtime storage and ancestry copy inventory.
    child = f.app.runtime.submitTaskWithCheckpoint({goal: 'Synthetic child', idempotencyKey: `synthetic-child-${parentTaskId}`,
      conversationId: `desktop-subtask:${parentTaskId}`}, 'subtask-parent',
      {parentTaskId, subtaskId: 'derived'});
    const outcome = await f.app.runtime.runTask(child.taskId, async worker => {
      worker.saveCheckpoint('synthetic-private-body', {text: target.summary});
      return 'Synthetic derived child body';
    }, context());
    assert.equal(outcome.state, 'succeeded');
  });
  const first = await f.submit('private-a', target.ref);
  assert.equal(first.state, 'succeeded', JSON.stringify(first.error));
  const other = await f.submit('private-b', independent.ref);
  assert.equal(other.state, 'succeeded');
  f.app.runtime.saveCheckpoint(other.taskId, 'synthetic-private-body', {text: independent.summary});
  assert.deepEqual(f.consents, [first.taskId, other.taskId]);
  assert.equal(JSON.parse(f.requests[0].query).userConfirmedMemory.summary, target.summary);
  assert.equal(f.app.readPrivateTaskBinding(first.taskId).fact.ref.revision, 2);
  assert.equal(f.app.runtime.loadCheckpoint(child.taskId, 'subtask-parent').parentTaskId, first.taskId);
  assert.equal(f.app.listBindings().items.find(item => item.taskId === child.taskId).binding.copyOnly, true);
  assert.equal(f.app.readPrivateTaskBinding(child.taskId), undefined, 'derived copy metadata is not a child consumption grant');
  await assert.rejects(f.erasure.withdraw({...target.ref, revision: 1}));
  const withdrawn = await f.erasure.withdraw(target.ref);
  assert.equal(withdrawn.state, 'withdrawn');
  await assert.rejects(f.submit('withdrawn-task', target.ref));
  const pending = await f.erasure.erase({id: target.ref.id, revision: withdrawn.revision});
  assert.equal(pending.state, 'pending');
  assert.deepEqual(pending.pendingTaskIds, [first.taskId, child.taskId].sort());
  assert.equal(f.app.readCopyErasureReceipt(first.taskId), undefined);
  assert.equal(f.app.readCopyErasureReceipt(child.taskId), undefined);
  assert.equal(f.app.runtime.loadCheckpoint(child.taskId, 'private-copy-erasure').state, 'withheld');
  assert.equal(f.app.isHistoryWithheld(child.taskId), true);
  await f.restart();
  f.allowPurge();
  assert.equal((await f.erasure.reconcile()).state, 'reconciled');
  assert.equal(f.app.readCopyErasureReceipt(first.taskId).state, 'purged');
  assert.equal(f.app.readCopyErasureReceipt(child.taskId).state, 'purged');
  assert.equal(f.app.runtime.loadCheckpoint(first.taskId, 'synthetic-private-body').redacted, true);
  assert.equal(f.app.runtime.loadCheckpoint(child.taskId, 'synthetic-private-body').redacted, true);
  assert.equal(f.app.runtime.loadCheckpoint(child.taskId, 'subtask-parent').redacted, true);
  assert.equal(f.replies.has(first.taskId), false);
  assert.equal(f.replies.has(other.taskId), true);
  assert.equal(f.app.readCopyErasureReceipt(other.taskId), undefined);
  assert.deepEqual(f.app.runtime.loadCheckpoint(other.taskId, 'synthetic-private-body'), {text: independent.summary});
  assert.deepEqual((await f.memory.listSaved()).facts.map(fact => fact.ref), [independent.ref]);
  const stored = openSqliteMemoryHost(f.database);
  try {
    const query = stored.bind('desktop-private', {allowedSensitivities: ['private']});
    assert.deepEqual((await query.listHistory({factId: target.ref.id, limit: 20, ...context()})).facts, []);
  } finally {stored.close();}
  assert.equal(f.requests.length, 2, 'copy reconciliation never repeats a cloud invocation');
});

test('an asynchronous private copy gate refuses before consent or cloud transport', async t => {
  const f = await fixture(t, true);
  const task = await f.submit('async-gate', f.facts[0].ref);
  assert.equal(task.state, 'failed');
  assert.deepEqual(f.consents, []);
  assert.deepEqual(f.requests, []);
  assert.equal(f.app.readPrivateTaskBinding(task.taskId), undefined);
});
