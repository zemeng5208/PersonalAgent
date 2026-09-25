import assert from 'node:assert/strict';
import {mkdtemp, rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {test} from 'node:test';
import {Client} from '@personal-agent/client';
import {createRuntimeApplication} from '../dist/application.js';

const descriptor = {
  name: 'fixture.read', version: '1.0.0',
  inputSchema: {type: 'object', required: ['path'], additionalProperties: false,
    description: 'private C:\\Users\\example',
    properties: {path: {type: 'string', minLength: 1, maxLength: 32,
      description: 'private file name', enum: ['secret-path']}}},
  outputSchema: {type: 'object', required: ['value'], additionalProperties: false,
    properties: {value: {type: 'string'}}},
  sideEffect: 'read', requiredScopes: ['fixture:read'],
  idempotencySupport: true, recoverySupport: true, requiresPresence: false,
};
const toolExport = {toolName: descriptor.name, toolVersion: descriptor.version,
  exportPolicyVersion: 'public-v1', accepts: () => true,
  project: ({result}) => ({value: result.value})};

async function waitFor(app, taskId, states) {
  for (let attempt = 0; attempt < 200; attempt++) {
    const task = app.runtime.getTask(taskId);
    if (states.includes(task.state)) return task;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  throw new Error(`Task did not settle: ${states.join(',')}`);
}

test('task catalog projects only public Schema fields and rechecks before export', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'personal-agent-catalog-'));
  let app;
  let observed;
  let availabilityCalls = 0;
  const port = {execute: async request => {
    observed = await app.prepareCompetitionToolCatalog(request);
    assert.equal(observed.length, 1);
    assert.deepEqual(request.availableTools, observed);
    await app.assertCompetitionToolCatalogAllowed({...request, availableTools: observed});
    await assert.rejects(app.assertCompetitionToolCatalogAllowed({...request,
      revision: request.revision - 1, availableTools: observed}), {code: 'UNAUTHORIZED'});
    return {kind: 'text', text: 'Catalog observed', verification: 'mock'};
  }};
  app = createRuntimeApplication({path: path.join(directory, 'runtime.sqlite'),
    profile: 'huawei_ict_agentarts', coordination: port,
    tools: [{descriptor, execute: async () => ({value: 'local-only'})}],
    competitionToolExports: [toolExport],
    competitionToolAvailability: [{toolName: descriptor.name, toolVersion: descriptor.version,
      available: async input => { availabilityCalls++; return input.taskId.length > 0 && input.revision > 0; }}],
  });
  try {
    const client = new Client(app, Date.now);
    await client.connect();
    const {taskId} = await client.call('task.submit', {goal: 'Read public item', conversationId: 'catalog'},
      {idempotencyKey: 'catalog-1'});
    assert.equal((await waitFor(app, taskId, ['succeeded', 'failed'])).state, 'succeeded');
    assert.ok(availabilityCalls >= 2);
    assert.deepEqual(observed, [{name: 'fixture.read', version: '1.0.0', inputSchema: {
      type: 'object', required: ['path'], additionalProperties: false,
      properties: {path: {type: 'string', minLength: 1, maxLength: 32}},
    }}]);
    assert.doesNotMatch(JSON.stringify(observed), /private|secret-path|Users/);
  } finally {
    for (let i = 0; i < 200 && app.activeTaskCount; i++) await new Promise(resolve => setTimeout(resolve, 5));
    app.close();
    await rm(directory, {recursive: true, force: true});
  }
});

test('empty trusted catalog stops an opt-in first cloud request', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'personal-agent-catalog-'));
  let cloudCalls = 0;
  const app = createRuntimeApplication({path: path.join(directory, 'runtime.sqlite'),
    profile: 'huawei_ict_agentarts',
    coordination: {execute: async () => { cloudCalls++; return {kind: 'text', text: 'unexpected', verification: 'mock'}; }},
    tools: [{descriptor, execute: async () => ({value: 'local-only'})}],
    competitionToolExports: [toolExport],
    competitionToolAvailability: [{toolName: descriptor.name, toolVersion: descriptor.version,
      available: () => false}],
  });
  try {
    const client = new Client(app, Date.now);
    await client.connect();
    const {taskId} = await client.call('task.submit', {goal: 'Read public item', conversationId: 'catalog'},
      {idempotencyKey: 'catalog-empty'});
    const task = await waitFor(app, taskId, ['failed', 'succeeded']);
    assert.equal(task.state, 'failed');
    assert.equal(task.error.code, 'UNSUPPORTED_CAPABILITY');
    assert.equal(cloudCalls, 0);
  } finally {
    for (let i = 0; i < 200 && app.activeTaskCount; i++) await new Promise(resolve => setTimeout(resolve, 5));
    app.close();
    await rm(directory, {recursive: true, force: true});
  }
});

test('stale host availability rejects an unverified cloud proposal before approval', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'personal-agent-catalog-'));
  let healthy = true;
  let executions = 0;
  const port = {execute: async () => {
    healthy = false;
    return {kind: 'tool_proposal', proposalId: 'proposal-1', toolName: descriptor.name,
      toolVersion: descriptor.version, arguments: {path: 'secret-path'}, verification: 'unverified'};
  }};
  const app = createRuntimeApplication({path: path.join(directory, 'runtime.sqlite'),
    profile: 'huawei_ict_agentarts', coordination: port,
    tools: [{descriptor, execute: async () => { executions++; return {value: 'local-only'}; }}],
    competitionToolExports: [toolExport],
    competitionToolAvailability: [{toolName: descriptor.name, toolVersion: descriptor.version,
      available: () => healthy}],
  });
  try {
    const client = new Client(app, Date.now);
    await client.connect();
    const {taskId} = await client.call('task.submit', {goal: 'Read public item', conversationId: 'catalog'},
      {idempotencyKey: 'catalog-2'});
    const task = await waitFor(app, taskId, ['failed', 'waiting_approval']);
    assert.equal(task.state, 'failed');
    assert.equal(executions, 0);
    assert.deepEqual((await client.call('approval.list', {taskId})).items, []);
  } finally {
    for (let i = 0; i < 200 && app.activeTaskCount; i++) await new Promise(resolve => setTimeout(resolve, 5));
    app.close();
    await rm(directory, {recursive: true, force: true});
  }
});

test('async availability cannot export a catalog after the running task revision changes', async () => {
  let app;
  let availabilityCalls = 0;
  let cloudFetches = 0;
  const port = {execute: async request => {
    const selected = await app.prepareCompetitionToolCatalog(request);
    await app.assertCompetitionToolCatalogAllowed({...request, availableTools: selected});
    cloudFetches++;
    return {kind: 'text', text: 'unexpected cloud result', verification: 'mock'};
  }};
  app = createRuntimeApplication({path: ':memory:', profile: 'huawei_ict_agentarts', coordination: port,
    tools: [{descriptor, execute: async () => ({value: 'local-only'})}],
    competitionToolExports: [toolExport],
    competitionToolAvailability: [{toolName: descriptor.name, toolVersion: descriptor.version,
      available: async input => {
        availabilityCalls++;
        if (availabilityCalls === 2) app.runtime.recordProgress(input.taskId,
          {stepId: 'catalog-race', label: 'new task revision'});
        return true;
      }}],
  });
  try {
    const client = new Client(app, Date.now);
    await client.connect();
    const {taskId} = await client.call('task.submit', {goal: 'Check current task revision', conversationId: 'catalog'},
      {idempotencyKey: 'catalog-revision-race'});
    assert.equal((await waitFor(app, taskId, ['failed', 'succeeded'])).state, 'failed');
    assert.equal(availabilityCalls, 2);
    assert.equal(cloudFetches, 0);
  } finally {
    for (let i = 0; i < 200 && app.activeTaskCount; i++) await new Promise(resolve => setTimeout(resolve, 5));
    app.close();
  }
});

test('selected read and local write proposals each require local approval before continuation', async () => {
  const read = {...descriptor, name: 'fixture.read', requiredScopes: ['fixture:read']};
  const write = {...descriptor, name: 'fixture.write', sideEffect: 'local_write',
    requiredScopes: ['fixture:write']};
  const executions = [];
  const requests = [];
  const app = createRuntimeApplication({path: ':memory:', profile: 'huawei_ict_agentarts',
    tools: [read, write].map(item => ({descriptor: item, execute: async () => {
      executions.push(item.name);
      return {value: item.name};
    }})),
    competitionToolExports: [read, write].map(item => ({
      toolName: item.name, toolVersion: item.version, exportPolicyVersion: 'fixture-v1',
      accepts: () => true, project: ({result}) => ({value: result.value}),
    })),
    competitionToolAvailability: [read, write].map(item => ({
      toolName: item.name, toolVersion: item.version, available: () => true,
    })),
    coordination: {execute: async request => {
      requests.push(request);
      if (requests.length === 1) {
        assert.deepEqual(request.availableTools.map(item => item.name), ['fixture.read', 'fixture.write']);
        return {kind: 'tool_proposal', proposalId: 'read-1', toolName: read.name,
          toolVersion: read.version, arguments: {path: 'secret-path'}, verification: 'unverified'};
      }
      assert.equal(request.availableTools, undefined);
      if (requests.length === 2) {
        assert.deepEqual(request.continuation, {proposalId: 'read-1', state: 'confirmed',
          result: {value: read.name}});
        return {kind: 'tool_proposal', proposalId: 'write-1', toolName: write.name,
          toolVersion: write.version, arguments: {path: 'secret-path'}, verification: 'unverified'};
      }
      assert.deepEqual(request.continuation, {proposalId: 'write-1', state: 'confirmed',
        result: {value: write.name}});
      return {kind: 'text', text: 'Synthetic read and write confirmed', verification: 'unverified'};
    }},
  });
  try {
    const client = new Client(app, Date.now);
    await client.connect();
    const {taskId} = await client.call('task.submit', {goal: 'Synthetic read then write',
      conversationId: 'catalog'}, {idempotencyKey: 'catalog-read-write'});
    assert.equal((await waitFor(app, taskId, ['waiting_approval', 'failed'])).state, 'waiting_approval');
    assert.deepEqual(executions, []);
    const first = (await client.call('approval.list', {taskId})).items[0];
    assert.equal(first.action, read.name);
    await client.call('authorization.respond', {approvalId: first.approvalId,
      expectedRevision: first.revision, decision: 'allow_once'});
    let second;
    for (let attempt = 0; attempt < 200; attempt++) {
      second = (await client.call('approval.list', {taskId})).items.find(item => item.action === write.name);
      if (second) break;
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    assert.ok(second);
    assert.deepEqual(executions, [read.name]);
    await client.call('authorization.respond', {approvalId: second.approvalId,
      expectedRevision: second.revision, decision: 'allow_once'});
    const task = await waitFor(app, taskId, ['succeeded', 'failed']);
    assert.equal(task.state, 'succeeded');
    assert.deepEqual(executions, [read.name, write.name]);
    assert.equal(requests.length, 3);
  } finally {app.close();}
});

test('a write missing from the task selection cannot reach approval or execution', async () => {
  const write = {...descriptor, name: 'fixture.write', sideEffect: 'local_write',
    requiredScopes: ['fixture:write']};
  let writes = 0;
  const app = createRuntimeApplication({path: ':memory:', profile: 'huawei_ict_agentarts',
    tools: [{descriptor, execute: async () => ({value: 'read'})},
      {descriptor: write, execute: async () => {writes++; return {value: 'write'};}}],
    competitionToolExports: [descriptor, write].map(item => ({
      toolName: item.name, toolVersion: item.version, exportPolicyVersion: 'fixture-v1',
      accepts: () => true, project: ({result}) => ({value: result.value}),
    })),
    competitionToolAvailability: [{toolName: descriptor.name, toolVersion: descriptor.version,
      available: () => true}],
    coordination: {execute: async request => {
      assert.deepEqual(request.availableTools.map(item => item.name), [descriptor.name]);
      return {kind: 'tool_proposal', proposalId: 'unselected-write', toolName: write.name,
        toolVersion: write.version, arguments: {path: 'secret-path'}, verification: 'unverified'};
    }},
  });
  try {
    const client = new Client(app, Date.now);
    await client.connect();
    const {taskId} = await client.call('task.submit', {goal: 'Synthetic unselected write',
      conversationId: 'catalog'}, {idempotencyKey: 'catalog-unselected-write'});
    assert.equal((await waitFor(app, taskId, ['failed', 'waiting_approval'])).state, 'failed');
    assert.equal(writes, 0);
    assert.deepEqual((await client.call('approval.list', {taskId})).items, []);
  } finally {app.close();}
});

test('catalog binding rejects versions beyond the cloud adapter limit', () => {
  assert.throws(() => createRuntimeApplication({path: ':memory:', profile: 'huawei_ict_agentarts',
    coordination: {execute: async () => { throw Error('unexpected'); }},
    tools: [{descriptor, execute: async () => ({value: 'unused'})}],
    competitionToolAvailability: [{toolName: descriptor.name, toolVersion: '1'.repeat(65),
      available: () => true}],
  }), {code: 'INVALID_ARGUMENT'});
});

test('catalog exceeding the cloud adapter byte limit fails before export', async () => {
  const largeDescriptor = {...descriptor, inputSchema: {type: 'object', required: [],
    additionalProperties: false,
    properties: Object.fromEntries(Array.from({length: 70}, (_, index) => [
      `a${'x'.repeat(115)}${index}`, {type: 'string'},
    ]))}};
  let cloudCalls = 0;
  const app = createRuntimeApplication({path: ':memory:', profile: 'huawei_ict_agentarts',
    coordination: {execute: async () => {cloudCalls++; throw Error('unexpected');}},
    tools: [{descriptor: largeDescriptor, execute: async () => ({value: 'unused'})}],
    competitionToolExports: [toolExport],
    competitionToolAvailability: [{toolName: descriptor.name, toolVersion: descriptor.version,
      available: () => true}],
  });
  try {
    const client = new Client(app, Date.now);
    await client.connect();
    const {taskId} = await client.call('task.submit', {goal: 'Synthetic oversized catalog',
      conversationId: 'catalog'}, {idempotencyKey: 'catalog-oversized'});
    const task = await waitFor(app, taskId, ['failed', 'succeeded']);
    assert.equal(task.state, 'failed');
    assert.equal(task.error.code, 'INVALID_ARGUMENT');
    assert.equal(cloudCalls, 0);
  } finally {app.close();}
});
