import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtemp, readFile, readdir, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test} from 'node:test';
import {createWorkspacePatchPreviewTool} from '@personal-agent/coding-tools';
import {InMemoryAuthorizationPolicy} from '@personal-agent/policy';
import {ToolGateway, toolArgumentsDigest} from '@personal-agent/tool-gateway';

test('Policy binds preview edits and revocation without granting filesystem writes', async t => {
  const root = await mkdtemp(join(tmpdir(), 'pa-patch-preview-policy-'));
  t.after(() => rm(root, {recursive: true, force: true}));
  const source = 'export const greeting = "hello";\n';
  const file = join(root, 'fixture.ts');
  await writeFile(file, source);
  const sha = value => createHash('sha256').update(value, 'utf8').digest('hex');
  const now = Date.parse('2026-09-17T08:00:00.000Z');
  const policy = new InMemoryAuthorizationPolicy();
  const gateway = new ToolGateway({policy, now: () => now});
  const tool = createWorkspacePatchPreviewTool({rootPath: root, now: () => now});
  assert.equal(tool.descriptor.sideEffect, 'read');
  assert.deepEqual(tool.descriptor.requiredScopes, ['workspace:read']);
  let executions = 0;
  const dispose = gateway.register({descriptor: tool.descriptor, execute: (input, context) => {
    executions++;
    return tool.execute(input, context);
  }});
  const args = {path: 'fixture.ts', expectedSha256: sha(source),
    edits: [{oldText: '"hello"', newText: '"你好"'}]};
  const invocation = {toolName: tool.descriptor.name, toolVersion: tool.descriptor.version,
    taskId: 'synthetic-patch-task', runId: 'synthetic-preview-run',
    authorizationRef: 'synthetic-preview-authorization', arguments: args,
    deadline: '2026-09-17T08:01:00.000Z', signal: new AbortController().signal};
  await assert.rejects(gateway.invoke(invocation), {code: 'UNAUTHORIZED'});
  assert.equal(executions, 0);
  policy.grant({authorizationRef: invocation.authorizationRef, taskId: invocation.taskId,
    toolName: invocation.toolName, scopes: ['workspace:read'],
    expiresAt: '2026-09-17T09:00:00.000Z', argumentsDigest: toolArgumentsDigest(args)});
  const result = await gateway.invoke(invocation);
  const candidate = source.replace('"hello"', '"你好"');
  assert.deepEqual(result, {path: 'fixture.ts', beforeSha256: sha(source),
    afterSha256: sha(candidate), changed: true, previewText: candidate});
  assert.equal(await readFile(file, 'utf8'), source);
  assert.deepEqual(await readdir(root), ['fixture.ts']);
  await assert.rejects(gateway.invoke({...invocation, runId: 'synthetic-replaced-input',
    arguments: {...args, edits: [{oldText: '"hello"', newText: '"different"'}]}}),
  {code: 'SCOPE_DENIED'});
  assert.equal(executions, 1);
  policy.revoke(invocation.authorizationRef);
  await assert.rejects(gateway.invoke({...invocation, runId: 'synthetic-revoked-run'}),
    {code: 'UNAUTHORIZED'});
  assert.equal(executions, 1);
  dispose();
  assert.equal(await readFile(file, 'utf8'), source);
});
