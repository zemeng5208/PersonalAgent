import assert from 'node:assert/strict';
import test from 'node:test';
import { ConnectorHost } from '../dist/index.js';

const manifest = {
  id: 'fixture',
  version: '1.0.0',
  accountTypes: ['fixture'],
  capabilities: ['search'],
  configSchema: {type: 'object'},
  authentication: 'token',
  requiresPresence: false,
  syncStrategy: 'manual',
  verification: 'mock',
};

class FixtureConnector {
  manifest = manifest;
  connected = false;
  connect() { this.connected = true; return {sessionRef: 'fixture-session', interactionRequired: false}; }
  disconnect() { this.connected = false; return {disconnected: true, cleanupState: 'complete'}; }
  getCapabilities() { return ['search']; }
  health() { return {state: this.connected ? 'ready' : 'disconnected'}; }
  fetchChanges() { throw new Error('not used'); }
  search() { return []; }
  getItem() { throw new Error('not used'); }
  performAction() { throw new Error('not used'); }
}

test('connector lifecycle is registered without exposing secrets', async () => {
  const reads = [];
  const host = new ConnectorHost({read: ref => { reads.push(ref); return 'secret-value'; }});
  let observedSecret;
  const unregister = host.register({
    manifest,
    create: async context => {
      observedSecret = await context.readSecret('fixture-token');
      return new FixtureConnector();
    },
  }, {secretRefs: ['fixture-token']});

  assert.deepEqual(host.list(), [{manifest, health: {state: 'disconnected'}}]);
  assert.equal(JSON.stringify(host.list()).includes('secret-value'), false);
  assert.deepEqual(await host.connect('fixture', new AbortController().signal), {sessionRef: 'fixture-session', interactionRequired: false});
  assert.equal(observedSecret, 'secret-value');
  assert.deepEqual(reads, ['fixture-token']);
  assert.equal(host.list()[0].health.state, 'ready');
  assert.deepEqual(host.getCapabilities('fixture'), ['search']);
  assert.deepEqual(await host.disconnect('fixture'), {disconnected: true, cleanupState: 'complete'});
  await unregister();
  await assert.rejects(host.connect('fixture', new AbortController().signal), {code: 'UNSUPPORTED_CAPABILITY'});
});

test('a connector cannot read undeclared or unavailable secrets', async () => {
  const denied = new ConnectorHost({read: () => 'must-not-be-read'});
  denied.register({manifest, create: async context => {
    await context.readSecret('other-token');
    return new FixtureConnector();
  }}, {secretRefs: ['fixture-token']});
  await assert.rejects(denied.connect('fixture', new AbortController().signal), {code: 'SCOPE_DENIED'});

  const missing = new ConnectorHost({read: () => undefined});
  missing.register({manifest, create: async context => {
    await context.readSecret('fixture-token');
    return new FixtureConnector();
  }}, {secretRefs: ['fixture-token']});
  await assert.rejects(missing.connect('fixture', new AbortController().signal), {code: 'UNAUTHORIZED'});
});

test('duplicate registration, manifest mismatch and cancellation are rejected', async () => {
  const host = new ConnectorHost({read: () => undefined});
  host.register({manifest, create: () => new FixtureConnector()});
  assert.throws(() => host.register({manifest, create: () => new FixtureConnector()}), {code: 'REVISION_CONFLICT'});

  const controller = new AbortController();
  controller.abort();
  await assert.rejects(host.connect('fixture', controller.signal), {code: 'CANCELLED'});

  const mismatch = new ConnectorHost({read: () => undefined});
  mismatch.register({manifest, create: () => {
    const connector = new FixtureConnector();
    connector.manifest = {...manifest, version: '2.0.0'};
    return connector;
  }});
  await assert.rejects(mismatch.connect('fixture', new AbortController().signal), {code: 'PROTOCOL_MISMATCH'});
});

test('concurrent connect calls share one factory and one lifecycle transition', async () => {
  const host = new ConnectorHost({read: () => undefined});
  let creates = 0;
  let connects = 0;
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  host.register({manifest, create: async () => {
    creates++;
    await gate;
    const connector = new FixtureConnector();
    connector.connect = () => {
      connects++;
      connector.connected = true;
      return {sessionRef: 'fixture-session', interactionRequired: false};
    };
    return connector;
  }});
  const first = host.connect('fixture', new AbortController().signal);
  const second = host.connect('fixture', new AbortController().signal);
  release();
  assert.deepEqual(await Promise.all([first, second]), [
    {sessionRef: 'fixture-session', interactionRequired: false},
    {sessionRef: 'fixture-session', interactionRequired: false},
  ]);
  assert.equal(creates, 1);
  assert.equal(connects, 1);
});

test('cancellation during secret read rejects connect and prevents factory from receiving credentials or creating instances', async () => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  let readStarted;
  const started = new Promise(resolve => { readStarted = resolve; });
  let observedSecret;
  let factoryCreated = false;
  let connectorConnected = false;

  const host = new ConnectorHost({
    read: async (_ref, _signal) => {
      readStarted();
      await gate;
      return 'synthetic-secret';
    },
  });

  host.register({
    manifest,
    create: async context => {
      observedSecret = await context.readSecret('fixture-token');
      factoryCreated = true;
      const connector = new FixtureConnector();
      connector.connect = () => {
        connectorConnected = true;
        return {sessionRef: 'fixture-session', interactionRequired: false};
      };
      return connector;
    },
  }, {secretRefs: ['fixture-token']});

  const controller = new AbortController();
  const connectPromise = host.connect('fixture', controller.signal);
  await started;
  controller.abort();
  release();

  await assert.rejects(connectPromise, {code: 'CANCELLED', message: 'Connector connection was cancelled'});
  assert.equal(observedSecret, undefined);
  assert.equal(factoryCreated, false);
  assert.equal(connectorConnected, false);
  assert.deepEqual(host.list(), [{manifest, health: {state: 'disconnected'}}]);
  assert.deepEqual(host.getCapabilities('fixture'), ['search']);
});
