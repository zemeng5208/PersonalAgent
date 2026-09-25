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
