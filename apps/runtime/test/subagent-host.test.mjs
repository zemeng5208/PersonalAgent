import assert from 'node:assert/strict';
import test from 'node:test';
import {TaskRuntime} from '../dist/index.js';
import {createRuntimeSubagentDispatchTool} from '../dist/application.js';
import {createRuntimeApplication} from '../dist/application/runtime-application.js';
import {ModelGateway, FakeModelProvider} from '@personal-agent/models';

test('createRuntimeSubagentDispatchTool creates real tracked child tasks in Runtime', async () => {
  const runtime = new TaskRuntime(':memory:');
  const parent = runtime.submitTask({
    conversationId: 'desktop-panel',
    goal: '主任务：协同分析天气与工程差异',
    idempotencyKey: 'parent-task-1',
  });

  const tool = createRuntimeSubagentDispatchTool({
    getRuntime: () => runtime,
  });

  const context = {
    taskId: parent.taskId,
    runId: 'run-tool-1',
    signal: new AbortController().signal,
    deadline: new Date(Date.now() + 60_000).toISOString(),
    authorizationRef: `auth-${parent.taskId}`,
    scopes: ['agent:delegate'],
  };

  const result = await tool.execute({
    subtasks: [
      {subtaskId: 'sub-1', role: 'researcher', goal: '调查北京天气趋势'},
      {subtaskId: 'sub-2', role: 'coder', goal: '审查工作区差异'},
    ],
  }, context);

  // 校验汇总结构
  assert.equal(result.total, 2);
  assert.equal(result.succeeded, 2);
  assert.equal(result.failed, 0);
  assert.equal(result.cancelled, 0);
  assert.equal(result.subtasks.length, 2);
  assert.match(result.aggregatedSummary, /次级智能体协作汇总/);

  // 校验 Runtime 中真实创建了子任务
  const child1 = runtime.findTaskByIdempotencyKey(`subagent-dispatch-${parent.taskId}-sub-1`);
  assert.ok(child1);
  assert.equal(child1.state, 'succeeded');
  assert.equal(child1.conversationId, `desktop-subtask:${parent.taskId}`);

  // 校验父子关联检查点
  const parentRef = runtime.loadCheckpoint(child1.taskId, 'subtask-parent');
  assert.equal(parentRef.parentTaskId, parent.taskId);
  assert.equal(parentRef.subtaskId, 'sub-1');
  assert.equal(parentRef.role, 'researcher');
});

test('createRuntimeSubagentDispatchTool rejects recursive delegation from subtask', async () => {
  const runtime = new TaskRuntime(':memory:');
  const child = runtime.submitTask({
    conversationId: 'desktop-subtask:parent-1',
    goal: '已有子任务',
    idempotencyKey: 'child-task-1',
  });

  const tool = createRuntimeSubagentDispatchTool({
    getRuntime: () => runtime,
  });

  const context = {
    taskId: child.taskId,
    runId: 'run-tool-2',
    signal: new AbortController().signal,
    deadline: new Date(Date.now() + 60_000).toISOString(),
    authorizationRef: `auth-${child.taskId}`,
    scopes: ['agent:delegate'],
  };

  await assert.rejects(tool.execute({
    subtasks: [{subtaskId: 'nested-1', role: 'coder', goal: '嵌套派发'}],
  }, context), {code: 'INVALID_ARGUMENT'});
});

test('runtimeApplication configureThinking independently presents stepBudget and modelReasoning', () => {
  const app = createRuntimeApplication({path: ':memory:'});
  const state = app.configureThinking({depth: 3, fast: true});

  assert.equal(state.depth, 3);
  assert.equal(state.fast, true);
  assert.equal(state.maxSteps, 6);
  assert.equal(state.stepBudget.maxSteps, 6);
  assert.equal(state.stepBudget.fast, true);
  assert.equal(state.modelReasoning.supported, false);
  assert.equal(state.modelReasoning.effort, 'medium');
  assert.match(state.modelReasoning.reason, /主模型当前未开放原生 reasoning 参数/);

  const readback = app.getThinkingState();
  assert.deepEqual(readback.stepBudget, state.stepBudget);
  assert.deepEqual(readback.modelReasoning, state.modelReasoning);
});

test('createRuntimeSubagentDispatchTool executes real ModelGateway with role prompt and native reasoningEffort', async () => {
  const runtime = new TaskRuntime(':memory:');
  const parent = runtime.submitTask({
    conversationId: 'desktop-panel',
    goal: '父级主任务',
    idempotencyKey: 'parent-model-test-1',
  });

  const capturedRequests = [];
  const fakeProvider = new FakeModelProvider([
    req => {
      capturedRequests.push(req);
      return {kind: 'final', text: '调研报告：根据事实检索完成天气分析'};
    },
    req => {
      capturedRequests.push(req);
      return {kind: 'final', text: '代码审查通过：已验证差异'};
    },
  ]);
  const gateway = new ModelGateway(fakeProvider);

  const tool = createRuntimeSubagentDispatchTool({
    getRuntime: () => runtime,
    getModelGateway: () => gateway,
  });

  const context = {
    taskId: parent.taskId,
    runId: 'model-dispatch-run',
    signal: new AbortController().signal,
    deadline: new Date(Date.now() + 60_000).toISOString(),
    authorizationRef: `auth-${parent.taskId}`,
    scopes: ['agent:delegate'],
  };

  const result = await tool.execute({
    subtasks: [
      {
        subtaskId: 'sub-research-model',
        role: 'researcher',
        roleLabel: '资料检索与调研',
        goal: '调研今日天气',
        model: 'deep-research',
        thinkingDepth: 3,
      },
      {
        subtaskId: 'sub-coding-model',
        role: 'coder',
        roleLabel: '代码与工程实现',
        goal: '审查工作区差异',
        model: 'code-fast',
        thinkingDepth: 1,
      },
    ],
  }, context);

  assert.equal(result.total, 2);
  assert.equal(result.succeeded, 2);
  assert.equal(capturedRequests.length, 2);

  // 校验子任务1的原生 reasoningEffort 和角色提示
  const req1 = capturedRequests[0];
  assert.equal(req1.reasoningEffort, 'medium'); // thinkingDepth: 3 -> 'medium'
  assert.equal(req1.messages[0].role, 'system');
  assert.match(req1.messages[0].content, /【资料检索与调研】\(researcher\)/);

  // 校验子任务2的原生 reasoningEffort 和角色提示
  const req2 = capturedRequests[1];
  assert.equal(req2.reasoningEffort, 'low'); // thinkingDepth: 1 -> 'low'
  assert.equal(req2.messages[0].role, 'system');
  assert.match(req2.messages[0].content, /【代码与工程实现】\(coder\)/);

  // 校验 Runtime 中子任务保存了真实模型返回结果与元数据
  const child1 = runtime.findTaskByIdempotencyKey(`subagent-dispatch-${parent.taskId}-sub-research-model`);
  assert.ok(child1);
  assert.equal(child1.state, 'succeeded');
  assert.match(child1.resultSummary, /调研报告：根据事实检索完成天气分析/);
  assert.match(child1.resultSummary, /model=fake\/fake-deployment\/fake-model/);

  // 校验汇总输出
  assert.match(result.aggregatedSummary, /调研报告：根据事实检索完成天气分析/);
});

test('subagent execution propagates parent cancellation to cancel inflight runtime child tasks', async () => {
  const runtime = new TaskRuntime(':memory:');
  const parent = runtime.submitTask({
    conversationId: 'desktop-panel',
    goal: '父级主任务：待取消',
    idempotencyKey: 'parent-cancel-test-1',
  });

  const parentController = new AbortController();

  let childStartedResolve;
  const childStarted = new Promise(resolve => { childStartedResolve = resolve; });

  const fakeProvider = new FakeModelProvider([
    async req => {
      childStartedResolve();
      return new Promise((_, reject) => {
        req.signal.addEventListener('abort', () => reject(new Error('Model request aborted')), {once: true});
      });
    },
  ]);
  const gateway = new ModelGateway(fakeProvider);

  const tool = createRuntimeSubagentDispatchTool({
    getRuntime: () => runtime,
    getModelGateway: () => gateway,
  });

  const context = {
    taskId: parent.taskId,
    runId: 'cancel-inflight-run',
    signal: parentController.signal,
    deadline: new Date(Date.now() + 60_000).toISOString(),
    authorizationRef: `auth-${parent.taskId}`,
    scopes: ['agent:delegate'],
  };

  const dispatchPromise = tool.execute({
    subtasks: [
      {
        subtaskId: 'sub-inflight-cancel',
        role: 'researcher',
        goal: '长时间执行的任务',
        thinkingDepth: 2,
      },
    ],
  }, context);

  // 等待子任务已经进入执行
  await childStarted;

  // 父级中断 signal
  parentController.abort();

  const result = await dispatchPromise;
  assert.equal(result.total, 1);
  assert.equal(result.cancelled, 1);
  assert.equal(result.subtasks[0].state, 'cancelled');

  // 确认 TaskRuntime 中该子任务确实变成了 cancelled
  const childTask = runtime.findTaskByIdempotencyKey(`subagent-dispatch-${parent.taskId}-sub-inflight-cancel`);
  assert.ok(childTask);
  assert.equal(childTask.state, 'cancelled');
});
