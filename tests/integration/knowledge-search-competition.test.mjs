import assert from 'node:assert/strict';
import {mkdtemp, mkdir, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import test from 'node:test';
import {Client} from '@personal-agent/client';
import {FakeCoordinationPort} from '@personal-agent/coordination/testing';
import {openReadOnlyVault} from '@personal-agent/knowledge/filesystem';
import {createKnowledgeSearchTool, KNOWLEDGE_SEARCH_TOOL_NAME, KNOWLEDGE_SEARCH_TOOL_VERSION} from '@personal-agent/knowledge/tool';
import {createRuntimeApplication} from '@personal-agent/runtime/application';

async function fixture() {
  const base = await mkdtemp(join(tmpdir(), 'personal-agent-knowledge-competition-'));
  const root = join(base, 'vault');
  await mkdir(root);
  await writeFile(join(root, 'fixture.md'), 'synthetic knowledge answer\n', 'utf8');
  return {base, root, database: join(base, 'runtime.sqlite')};
}

async function waitForState(app, taskId, states) {
  for (let attempt = 0; attempt < 200; attempt++) {
    const task = app.runtime.getTask(taskId);
    if (states.includes(task.state)) return task;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  throw new Error(`Task ${taskId} did not reach ${states.join(' or ')}`);
}

test('repository public demo knowledge requires approval before reaching Fake coordination', async t => {
  const base = await mkdtemp(join(tmpdir(), 'personal-agent-public-knowledge-'));
  const database = join(base, 'runtime.sqlite');
  const root = fileURLToPath(new URL('../../docs/demo/knowledge/vault/', import.meta.url));
  const vault = await openReadOnlyVault({vaultId: 'public-demo-v1', rootPath: root});
  let reads = 0;
  const knowledge = createKnowledgeSearchTool({search: async request => {
    reads++;
    return vault.search(request);
  }});
  const port = new FakeCoordinationPort(request => {
    if (!request.continuation) return {
      kind: 'tool_proposal', proposalId: 'knowledge-proposal',
      toolName: KNOWLEDGE_SEARCH_TOOL_NAME, toolVersion: KNOWLEDGE_SEARCH_TOOL_VERSION,
      arguments: {query: '公开演示交付物', limit: 1}, verification: 'mock',
    };
    assert.equal(request.continuation.proposalId, 'knowledge-proposal');
    assert.equal(request.continuation.state, 'confirmed');
    assert.equal(request.continuation.result.hits.length, 1);
    assert.equal(request.continuation.result.hits[0].excerpt, '公开演示交付物：带来源引用的一页摘要。');
    assert.equal(request.continuation.result.hits[0].source.path, 'starbridge.md');
    assert.equal(request.continuation.result.hits[0].source.vaultId, 'public-demo-v1');
    assert.equal(JSON.stringify(request.continuation).includes(root), false);
    return {kind: 'text', text: 'Synthetic knowledge found', verification: 'mock'};
  });
  const app = createRuntimeApplication({
    path: database, profile: 'huawei_ict_agentarts', coordination: port, tools: [knowledge],
  });
  t.after(async () => {
    app.close();
    await rm(base, {recursive: true, force: true});
  });
  const client = new Client(app, Date.now);
  await client.connect();
  const {taskId} = await client.call('task.submit', {
    goal: '星桥项目的公开演示交付物是什么', conversationId: 'knowledge-competition-public-demo',
  }, {idempotencyKey: 'knowledge-competition-approval'});
  assert.equal((await waitForState(app, taskId, ['waiting_approval', 'failed'])).state, 'waiting_approval');
  assert.equal(reads, 0);
  assert.equal(port.requests.length, 1);
  const {items: [approval]} = await client.call('approval.list', {taskId, state: 'pending'});
  assert.equal(approval.action, KNOWLEDGE_SEARCH_TOOL_NAME);
  assert.equal('arguments' in approval, false);
  const decision = {approvalId: approval.approvalId, expectedRevision: approval.revision, decision: 'allow_once'};
  await client.call('authorization.respond', decision);
  const completed = await waitForState(app, taskId, ['succeeded', 'failed']);
  assert.equal(completed.state, 'succeeded');
  assert.equal(reads, 1);
  assert.equal(port.requests.length, 2);
  assert.deepEqual(completed.evidenceRefs, [approval.approvalId]);
  await client.call('authorization.respond', decision);
  assert.equal(reads, 1, 'replayed approval must not read the Vault again');
});

test('denying knowledge approval leaves the synthetic Vault unread and sends no continuation', async t => {
  const {base, root, database} = await fixture();
  const vault = await openReadOnlyVault({vaultId: 'synthetic-vault', rootPath: root});
  let reads = 0;
  const knowledge = createKnowledgeSearchTool({search: async request => {
    reads++;
    return vault.search(request);
  }});
  const port = new FakeCoordinationPort(() => ({
    kind: 'tool_proposal', proposalId: 'denied-knowledge-proposal',
    toolName: KNOWLEDGE_SEARCH_TOOL_NAME, toolVersion: KNOWLEDGE_SEARCH_TOOL_VERSION,
    arguments: {query: 'knowledge', limit: 1}, verification: 'mock',
  }));
  const app = createRuntimeApplication({
    path: database, profile: 'huawei_ict_agentarts', coordination: port, tools: [knowledge],
  });
  t.after(async () => {
    app.close();
    await rm(base, {recursive: true, force: true});
  });
  const client = new Client(app, Date.now);
  await client.connect();
  const {taskId} = await client.call('task.submit', {
    goal: 'Search synthetic knowledge', conversationId: 'knowledge-competition-synthetic',
  }, {idempotencyKey: 'knowledge-competition-denied'});
  assert.equal((await waitForState(app, taskId, ['waiting_approval', 'failed'])).state, 'waiting_approval');
  const {items: [approval]} = await client.call('approval.list', {taskId, state: 'pending'});
  await client.call('authorization.respond', {
    approvalId: approval.approvalId, expectedRevision: approval.revision, decision: 'deny',
  });
  assert.equal(app.runtime.getTask(taskId).state, 'cancelled');
  assert.equal(reads, 0);
  assert.equal(port.requests.length, 1);
  assert.equal(app.runtime.readToolExecutions(taskId)[0].executionStarted, false);
});

test('unverified proposal cannot read or export synthetic knowledge', async t => {
  const {base, root, database} = await fixture();
  const vault = await openReadOnlyVault({vaultId: 'synthetic-vault', rootPath: root});
  let reads = 0;
  const knowledge = createKnowledgeSearchTool({search: async request => {
    reads++;
    return vault.search(request);
  }});
  const port = new FakeCoordinationPort(() => ({
    kind: 'tool_proposal', proposalId: 'unverified-knowledge-proposal',
    toolName: KNOWLEDGE_SEARCH_TOOL_NAME, toolVersion: KNOWLEDGE_SEARCH_TOOL_VERSION,
    arguments: {query: 'knowledge', limit: 1}, verification: 'unverified',
  }));
  const app = createRuntimeApplication({
    path: database, profile: 'huawei_ict_agentarts', coordination: port, tools: [knowledge],
  });
  t.after(async () => {
    app.close();
    await rm(base, {recursive: true, force: true});
  });
  const client = new Client(app, Date.now);
  await client.connect();
  const {taskId} = await client.call('task.submit', {
    goal: 'Search synthetic knowledge', conversationId: 'knowledge-competition-synthetic',
  }, {idempotencyKey: 'knowledge-competition-unverified'});
  const failed = await waitForState(app, taskId, ['failed']);
  assert.equal(failed.error.code, 'UNSUPPORTED_CAPABILITY');
  assert.equal(reads, 0);
  assert.equal(port.requests.length, 1);
  assert.deepEqual((await client.call('approval.list', {taskId})).items, []);
});
