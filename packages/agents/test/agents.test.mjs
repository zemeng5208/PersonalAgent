import assert from 'node:assert/strict';
import {mkdirSync, mkdtempSync} from 'node:fs';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import test from 'node:test';
import {FakeWeatherProvider} from '@personal-agent/weather';
import {createWeatherRuntime} from '@personal-agent/runtime/weather';
import {FakeModelProvider, ModelGateway} from '@personal-agent/models';
import {RuntimeToolInvoker, runAgent} from '../dist/index.js';

const root = fileURLToPath(new URL('../../../.cache/mod-04-agent-tests/', import.meta.url));
mkdirSync(root, {recursive: true});
const file = () => join(mkdtempSync(join(root, 'case-')), 'runtime.sqlite');
const deadline = new Date(Date.now() + 60_000).toISOString();

function context(taskId = 'task-1') {
  const progress = [];
  return {
    taskId, deadline, signal: new AbortController().signal,
    saveCheckpoint() {}, loadCheckpoint() { return undefined; },
    reportProgress(value) { progress.push(value); return undefined; }, progress,
  };
}

function weatherBundle() {
  return createWeatherRuntime({path: file(), provider: new FakeWeatherProvider()});
}

test('Agent enforces token and repair-step budgets', async () => {
  const options = {goal: 'test bounds', tools: {list: () => [], invoke: async () => assert.fail('must not invoke')}, authorizationRefFor: () => 'unused', maxSteps: 1, maxTokens: 1};
  await assert.rejects(runAgent(context(), {...options, model: new ModelGateway(new FakeModelProvider([{kind: 'final', text: 'too expensive'}]))}), {code: 'TIMEOUT'});
  const invalid = {kind: 'tool_proposal', proposal: {toolName: 'missing', toolVersion: '1', arguments: {}}};
  const provider = new FakeModelProvider([invalid, {kind: 'final', text: 'must not reach'}]);
  await assert.rejects(runAgent(context(), {...options, maxTokens: 10, model: new ModelGateway(provider)}), {code: 'TIMEOUT'});
  assert.equal(provider.requests.length, 1);
});

test('main Agent returns a final answer without a tool', async () => {
  const model = new ModelGateway(new FakeModelProvider([{kind: 'final', text: 'done'}]));
  const outcome = await runAgent(context(), {
    goal: 'say hello', model, tools: {list: () => [], invoke: async () => { throw new Error('must not call'); }},
    authorizationRefFor: () => 'unused', maxSteps: 2, maxTokens: 20,
  });
  assert.equal(outcome.status, 'succeeded');
  assert.match(outcome.resultSummary, /done/);
  assert.match(outcome.resultSummary, /model=fake\/fake-deployment\/fake-model/);
});

test('invalid proposal gets one bounded repair and then can finish', async () => {
  const modelProvider = new FakeModelProvider([
    {kind: 'tool_proposal', proposal: {toolName: 'weather.forecast', toolVersion: '0.1.0-alpha.1', arguments: {}, scopeRef: 'forged'}},
    {kind: 'final', text: 'repaired'},
  ]);
  const outcome = await runAgent(context(), {
    goal: 'repair a proposal', model: new ModelGateway(modelProvider), tools: {list: () => [], invoke: async () => { throw new Error('must not call'); }},
    authorizationRefFor: () => 'unused', maxSteps: 3, maxTokens: 20,
  });
  assert.equal(outcome.status, 'succeeded');
  assert.equal(modelProvider.requests.length, 2);
  assert.match(modelProvider.requests[1].messages.at(-1).content, /rejected/);
});

test('weather proposal crosses Runtime, Policy and ToolGateway using Fake providers', async () => {
  const bundle = weatherBundle();
  try {
    const task = bundle.runtime.submitTask({goal: '查北京天气', conversationId: 'agent-test', idempotencyKey: 'agent-weather-task'});
    bundle.policy.grant({authorizationRef: 'weather-auth', taskId: task.taskId, toolName: 'weather.forecast', scopes: ['weather:read'], expiresAt: deadline});
    const model = new ModelGateway(new FakeModelProvider([
      {kind: 'tool_proposal', proposal: {toolName: 'weather.forecast', toolVersion: '0.1.0-alpha.1', arguments: {location: 'Beijing', date: '2026-09-06', units: 'metric'}}},
      {kind: 'final', text: '北京今天多云，午后局部阵雨。'},
    ]));
    const tools = new RuntimeToolInvoker(bundle.runtime, bundle.gateway.list(), () => 'agent-weather-request');
    const snapshot = await bundle.runtime.runTask(task.taskId, workerContext => runAgent(workerContext, {
      goal: '查北京天气', model, tools, authorizationRefFor: () => 'weather-auth', maxSteps: 3, maxTokens: 50,
    }), {deadline, sideEffect: 'read'});
    assert.equal(snapshot.state, 'succeeded');
    assert.match(snapshot.resultSummary, /北京今天多云/);
    assert.match(snapshot.resultSummary, /model=fake/);
    assert.equal(bundle.readOnlyFetchCalls ?? 0, 0);
    assert.equal(bundle.runtime.readEvents().filter(event => event.type === 'tool.completed').length, 1);
  } finally {
    bundle.dispose();
  }
});

test('unknown result pauses for reconciliation and uses trusted authorization', async () => {
  const bundle = weatherBundle();
  try {
    const task = bundle.runtime.submitTask({goal: 'unknown weather result', conversationId: 'agent-test', idempotencyKey: 'agent-unknown-task'});
    let invoked;
    const model = new ModelGateway(new FakeModelProvider([{kind: 'tool_proposal', proposal: {toolName: 'weather.forecast', toolVersion: '0.1.0-alpha.1', arguments: {location: 'Beijing'}}}]));
    const tools = {
      list: () => bundle.gateway.list(),
      invoke: async input => { invoked = input; return {state: 'unknown', evidenceRefs: []}; },
    };
    const snapshot = await bundle.runtime.runTask(task.taskId, workerContext => runAgent(workerContext, {
      goal: 'unknown weather result', model, tools, authorizationRefFor: () => 'trusted-auth', maxSteps: 2, maxTokens: 20,
      onUnknownResult: worker => { bundle.runtime.transitionTask(worker.taskId, 'waiting_reconciliation', {error: {code: 'RESULT_UNKNOWN', message: 'verify tool result', retryable: false}}); },
    }), {deadline, sideEffect: 'read'});
    assert.equal(snapshot.state, 'waiting_reconciliation');
    assert.equal(invoked.authorizationRef, 'trusted-auth');
  } finally {
    bundle.dispose();
  }
});
