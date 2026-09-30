import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdir, mkdtemp, rm, writeFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {join} from 'node:path';
import test from 'node:test';
import {createPrivateMemoryController} from '../electron/private-memory.js';
import {createPrivateMemoryErasureHost} from '../electron/private-memory-erasure-host.js';

const hash = value => createHash('sha256').update(value).digest('hex');
async function fixture(t) {
  const parent = fileURLToPath(new URL('../../../.cache/private-memory-erasure/', import.meta.url));
  await mkdir(parent, {recursive: true});
  const base = await mkdtemp(join(parent, 'case-'));
  const vault = join(base, 'vault');
  await mkdir(vault);
  await writeFile(join(vault, 'note.md'), 'Synthetic private preference.\n');
  const database = join(base, 'private.sqlite');
  let privateMemory = createPrivateMemoryController(database, async () => true, async () => true,
    {confirmWithdraw: async () => true});
  await privateMemory.selectVault(vault);
  const source = (await privateMemory.search('Synthetic private')).hits[0].source;
  await privateMemory.save(source, 'Synthetic summary');
  const ref = (await privateMemory.listSaved()).facts[0].ref;
  const bindings = [];
  const copies = new Map();
  const receipts = new Map();
  const cancelled = [];
  const released = [];
  let pending = false;
  let forged = false;
  const add = (taskId, fact = ref) => {
    const binding = {taskId, destination: 'agentarts', fact: {...privateMemory.readConsumptionBinding(ref), ref: fact}};
    bindings.push({taskId, binding}); bindings.sort((a, b) => a.taskId < b.taskId ? -1 : 1);
    copies.set(taskId, 'Synthetic private copy');
  };
  const ports = () => ({privateMemory, consumptionHost: {releaseTask: taskId => released.push(taskId)},
    listBindings: ({limit, afterTaskId}) => {
      const remaining = bindings.filter(item => afterTaskId === undefined || item.taskId > afterTaskId);
      const items = remaining.slice(0, Math.min(limit, 1));
      return {items, ...(remaining.length > items.length ? {nextAfterTaskId: items.at(-1).taskId} : {})};
    }, cancelTask: taskId => cancelled.push(taskId),
    eraseTaskCopies: async ({taskId, factId, bindingDigest}) => {
      if (pending) return;
      copies.delete(taskId);
      receipts.set(taskId, {taskId, factId, bindingDigest: forged ? '0'.repeat(64) : bindingDigest, state: 'purged'});
    }, readCopyErasureReceipt: taskId => receipts.get(taskId) ?? null});
  t.after(async () => {privateMemory.close(); await rm(base, {recursive: true, force: true});});
  return {get privateMemory() {return privateMemory;}, ref, source, bindings, copies, receipts, cancelled, released, add,
    host: () => createPrivateMemoryErasureHost(ports()), setPending: value => {pending = value;},
    setForged: value => {forged = value;},
    restart() {privateMemory.close(); privateMemory = createPrivateMemoryController(database, async () => false);}};
}

test('exact private erasure purges all matching task and derived-child copies, preserving independent copies', async t => {
  const f = await fixture(t);
  f.add('a-parent'); f.add('b-child'); f.add('c-independent', {id: 'independent-fact', revision: 1});
  const host = f.host();
  assert.equal(host.inventory().length, 3);
  assert.throws(() => host.assertReady([{kind: 'unknown-backup'}]), /副本/);
  assert.equal((await host.erase(f.ref)).state, 'deleted');
  assert.deepEqual(f.cancelled, ['a-parent', 'b-child']);
  assert.deepEqual(f.released, ['a-parent', 'b-child']);
  assert.deepEqual([...f.copies.keys()], ['c-independent']);
  for (const item of f.bindings.slice(0, 2)) {
    assert.equal(f.receipts.get(item.taskId).bindingDigest, hash(JSON.stringify(item.binding)));
  }
  assert.equal((await f.privateMemory.listSaved()).facts.length, 0);
});

test('stale private deletion has zero task cancellation; missing and mismatched copy receipts stay pending across restart', async t => {
  const f = await fixture(t);
  f.add('a-task');
  await f.privateMemory.save(f.source, 'Corrected preference');
  await assert.rejects(f.host().erase(f.ref), /版本已变化/);
  assert.deepEqual(f.cancelled, []);
  assert.deepEqual(f.released, []);
  f.setPending(true);
  const current = (await f.privateMemory.listSaved()).facts[0].ref;
  const erased = await f.host().erase(current);
  assert.equal(erased.state, 'pending');
  assert.deepEqual(erased.pendingTaskIds, ['a-task']);
  assert.equal(f.copies.has('a-task'), true);
  f.restart();
  assert.equal((await f.host().reconcile()).state, 'pending');
  f.setPending(false); f.setForged(true);
  assert.equal((await f.host().reconcile()).state, 'pending');
  f.setForged(false);
  assert.equal((await f.host().reconcile()).state, 'reconciled');
  assert.equal(f.copies.has('a-task'), false);
  assert.equal(f.bindings.length, 1);
});
