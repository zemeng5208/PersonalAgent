import assert from 'node:assert/strict';
import {mkdtemp, mkdir, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';
import {openReadOnlyVault} from '@personal-agent/knowledge/filesystem';
import {
  KNOWLEDGE_READ_SCOPE, KNOWLEDGE_SEARCH_TOOL_NAME, KNOWLEDGE_SEARCH_TOOL_VERSION, register
} from '@personal-agent/knowledge/tool';
import {InMemoryAuthorizationPolicy} from '@personal-agent/policy';
import {ToolGateway, toolArgumentsDigest} from '@personal-agent/tool-gateway';

test('a synthetic Vault is read only after Policy authorizes the bound knowledge tool', async t => {
  const base = await mkdtemp(join(tmpdir(), 'personal-agent-knowledge-policy-'));
  const root = join(base, 'vault');
  await mkdir(root);
  await writeFile(join(root, 'fixture.md'), '合成知识引用\n', 'utf8');
  t.after(() => rm(base, {recursive: true, force: true}));

  const vault = await openReadOnlyVault({vaultId: 'synthetic-vault', rootPath: root});
  let reads = 0;
  const port = {search: async request => {
    reads++;
    return vault.search(request);
  }};
  const policy = new InMemoryAuthorizationPolicy();
  const gateway = new ToolGateway({policy});
  const dispose = register(gateway, port);
  const argumentsValue = {query: '知识', limit: 5};
  const authorizationRef = 'knowledge-approval-synthetic';
  const taskId = 'knowledge-task-synthetic';
  const invocation = {
    toolName: KNOWLEDGE_SEARCH_TOOL_NAME,
    toolVersion: KNOWLEDGE_SEARCH_TOOL_VERSION,
    arguments: argumentsValue,
    taskId,
    runId: 'knowledge-run-synthetic',
    authorizationRef,
    deadline: new Date(Date.now() + 30_000).toISOString(),
    signal: new AbortController().signal
  };

  await assert.rejects(gateway.invoke(invocation), {code: 'UNAUTHORIZED'});
  await assert.rejects(gateway.invoke({
    ...invocation, arguments: {...argumentsValue, rootPath: root}
  }), {code: 'INVALID_ARGUMENT'});
  await assert.rejects(gateway.invoke({
    ...invocation, arguments: {query: '   ', limit: 5}
  }), {code: 'INVALID_ARGUMENT'});
  assert.equal(reads, 0, 'a denied or invalid request must not touch the Vault');

  policy.grant({
    authorizationRef,
    taskId,
    toolName: KNOWLEDGE_SEARCH_TOOL_NAME,
    scopes: [KNOWLEDGE_READ_SCOPE],
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    argumentsDigest: toolArgumentsDigest(argumentsValue)
  });
  const result = await gateway.invoke(invocation);
  assert.equal(result.hits.length, 1);
  assert.deepEqual(result.hits[0].source.path, 'fixture.md');
  assert.equal(result.hits[0].source.vaultId, 'synthetic-vault');
  assert.equal(result.truncated, false);
  assert.equal(JSON.stringify(result).includes(root), false);
  assert.equal(reads, 1);

  await assert.rejects(gateway.invoke({
    ...invocation, arguments: {query: '其他', limit: 5}
  }), {code: 'SCOPE_DENIED'});
  policy.revoke(authorizationRef);
  await assert.rejects(gateway.invoke(invocation), {code: 'UNAUTHORIZED'});
  assert.equal(reads, 1);
  dispose();
  await assert.rejects(gateway.invoke(invocation), {code: 'UNSUPPORTED_CAPABILITY'});
});
