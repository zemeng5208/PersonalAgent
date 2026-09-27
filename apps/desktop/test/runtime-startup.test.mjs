import test from 'node:test';
import assert from 'node:assert/strict';
import {createDeferredRuntimeStartup} from '../electron/runtime-startup.js';

test('first configuration starts once without restart or duplicate runtime resources', async () => {
  let configured = false, attempts = 0, release;
  const started = new Promise(resolve => {release = resolve;});
  const host = createDeferredRuntimeStartup({isConfigured: () => configured,
    initialize: async () => {attempts++; await started;}});
  assert.equal((await host.start()).state, 'configuration_required');
  assert.equal(attempts, 0);
  configured = true;
  const first = host.start();
  assert.equal(host.snapshot().state, 'starting');
  assert.equal(host.start(), first);
  release();
  assert.equal((await first).state, 'ready');
  await host.start();
  assert.equal(attempts, 1);
});

test('partial startup failure cannot allocate another runtime over existing resources', async () => {
  let attempts = 0;
  const host = createDeferredRuntimeStartup({isConfigured: () => true,
    initialize: async () => {attempts++; throw Error('synthetic startup failure');}});
  assert.equal((await host.start()).state, 'failed');
  assert.equal((await host.start()).state, 'failed');
  assert.equal(attempts, 1);
});
