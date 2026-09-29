import assert from 'node:assert/strict';
import {mkdir, mkdtemp, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';
import {createWorkspaceReadTool, WORKSPACE_READ_SCOPE, WORKSPACE_READ_TOOL_NAME,
  WORKSPACE_READ_TOOL_VERSION} from '@personal-agent/coding-tools';
import {InMemoryAuthorizationPolicy} from '@personal-agent/policy';
import {ToolGateway, toolArgumentsDigest} from '@personal-agent/tool-gateway';

const now = Date.parse('2026-09-17T08:00:00.000Z');
const deadline = '2026-09-17T08:01:00.000Z';
const expiresAt = '2026-09-17T09:00:00.000Z';
const taskId = 'task-workspace-read-synthetic';
const authorizationRef = 'authorization-workspace-read-synthetic';

test('Policy and ToolGateway authorize the bound workspace reader before execution', async t => {
  const base = await mkdtemp(join(tmpdir(), 'personal-agent-workspace-read-policy-'));
  const root = join(base, 'workspace');
  await mkdir(join(root, 'src'), {recursive: true});
  await writeFile(join(root, 'src', 'fixture.ts'), 'export const fixture = "synthetic";\n', 'utf8');
  t.after(() => rm(base, {recursive: true, force: true}));

  const policy = new InMemoryAuthorizationPolicy();
  const gateway = new ToolGateway({policy, now: () => now});
  const workspaceTool = createWorkspaceReadTool({rootPath: root, maxReadBytes: 4096, now: () => now});
  let executions = 0;
  const dispose = gateway.register({
    descriptor: workspaceTool.descriptor,
    execute: async (input, context) => {
      executions++;
      return workspaceTool.execute(input, context);
    },
  });
  const argumentsValue = {path: 'src/fixture.ts', maxBytes: 1024};
  const invocation = {
    toolName: WORKSPACE_READ_TOOL_NAME,
    toolVersion: WORKSPACE_READ_TOOL_VERSION,
    arguments: argumentsValue,
    taskId,
    runId: 'run-workspace-read-synthetic',
    authorizationRef,
    deadline,
    signal: new AbortController().signal,
  };

  await assert.rejects(gateway.invoke(invocation), {code: 'UNAUTHORIZED'});
  assert.equal(executions, 0, 'provider must not execute before Policy authorization');

  policy.grant({
    authorizationRef,
    taskId,
    toolName: WORKSPACE_READ_TOOL_NAME,
    scopes: [WORKSPACE_READ_SCOPE],
    expiresAt,
    argumentsDigest: toolArgumentsDigest(argumentsValue),
  });
  assert.deepEqual(await gateway.invoke(invocation), {
    path: 'src/fixture.ts',
    encoding: 'utf-8',
    byteLength: Buffer.byteLength('export const fixture = "synthetic";\n'),
    content: 'export const fixture = "synthetic";\n',
  });
  assert.equal(executions, 1);

  policy.revoke(authorizationRef);
  await assert.rejects(gateway.invoke(invocation), {code: 'UNAUTHORIZED'});
  assert.equal(executions, 1, 'revoked authorization must fail before provider execution');

  dispose();
  await assert.rejects(gateway.invoke(invocation), {code: 'UNSUPPORTED_CAPABILITY'});
  assert.equal(executions, 1);
});
