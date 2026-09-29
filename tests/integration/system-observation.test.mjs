import assert from 'node:assert/strict';
import test from 'node:test';
import {InMemoryAuthorizationPolicy} from '@personal-agent/policy';
import {ToolGateway} from '@personal-agent/tool-gateway';
import {createSystemObservationTool, SYSTEM_OBSERVATION_SCOPE,
  SYSTEM_OBSERVATION_TOOL_NAME, SYSTEM_OBSERVATION_TOOL_VERSION} from '@personal-agent/windows-client';

test('synthetic computer observation crosses Policy and Gateway without granting itself authority', async () => {
  let reads = 0;
  const probe = {
    cpuTimes: () => { reads++; return [{user: reads * 10, nice: 0, sys: 0, idle: reads * 30, irq: 0}]; },
    totalMemoryBytes: () => 1024,
    freeMemoryBytes: () => 256,
    uptimeSeconds: () => 600,
  };
  const policy = new InMemoryAuthorizationPolicy();
  const gateway = new ToolGateway({policy});
  const dispose = gateway.register(createSystemObservationTool({probe, sampleWindowMs: 1}));
  const deadline = new Date(Date.now() + 60_000).toISOString();
  const request = {toolName: SYSTEM_OBSERVATION_TOOL_NAME, toolVersion: SYSTEM_OBSERVATION_TOOL_VERSION,
    taskId: 'synthetic-observation', runId: 'read-1', authorizationRef: 'synthetic-read-grant',
    arguments: {}, deadline, signal: new AbortController().signal};
  await assert.rejects(gateway.invoke(request), {code: 'UNAUTHORIZED'});
  assert.equal(reads, 0);
  policy.grant({authorizationRef: request.authorizationRef, taskId: request.taskId,
    toolName: request.toolName, scopes: [SYSTEM_OBSERVATION_SCOPE], expiresAt: deadline});
  const result = await gateway.invoke(request);
  assert.equal(result.source, 'injected');
  assert.equal(result.cpu.utilizationPercent, 25);
  assert.equal(result.memory.usedBytes, 768);
  assert.equal(reads, 2);
  policy.revoke(request.authorizationRef);
  await assert.rejects(gateway.invoke({...request, runId: 'read-2'}), {code: 'UNAUTHORIZED'});
  assert.equal(reads, 2);
  dispose();
  await assert.rejects(gateway.invoke({...request, runId: 'read-3'}), {code: 'UNSUPPORTED_CAPABILITY'});
});
