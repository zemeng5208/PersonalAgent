import assert from 'node:assert/strict';
import test from 'node:test';
import {TaskRuntime} from '../dist/index.js';
import {createRuntimeSubagentDispatchTool} from '../dist/application.js';
import {createRuntimeApplication} from '../dist/application/runtime-application.js';

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
