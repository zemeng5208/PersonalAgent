import assert from 'node:assert/strict';
import test from 'node:test';
import {TaskRuntime} from '../dist/index.js';
import {createRuntimeSubagentDispatchTool} from '../dist/application.js';
import {ModelGateway, FakeModelProvider} from '@personal-agent/models';

test('end-to-end subagent dispatch verifies parent-child tracking and cancellation chain', async () => {
  const runtime = new TaskRuntime(':memory:');

  // 1. 提交真实主任务
  const parentTask = runtime.submitTask({
    conversationId: 'desktop-panel',
    goal: '主对话贾维斯任务：多智能体拆解与执行',
    idempotencyKey: 'jarvis-main-goal-1',
  });

  // 显式 Fake 网关（测试内构造，等价 fakeModelMode 开关）：无网关时现在是明确失败而非假成功。
  const gateway = new ModelGateway(new FakeModelProvider([
    () => ({kind: 'final', text: '调研完成：天气与日程已核对'}),
    () => ({kind: 'final', text: '工程核对完成：差异与依赖已确认'}),
  ]));
  const tool = createRuntimeSubagentDispatchTool({
    getRuntime: () => runtime,
    getModelGateway: () => gateway,
  });

  // 2. 派发两个不同职责子任务
  const context = {
    taskId: parentTask.taskId,
    runId: 'dispatch-run-1',
    signal: new AbortController().signal,
    deadline: new Date(Date.now() + 60_000).toISOString(),
    authorizationRef: `auth-${parentTask.taskId}`,
    scopes: ['agent:delegate'],
  };

  const dispatchResult = await tool.execute({
    subtasks: [
      {
        subtaskId: 'sub-research',
        role: 'researcher',
        roleLabel: '资料检索与调研',
        goal: '调研今日天气与日程提醒',
        model: 'pangu-sub-agent',
        thinkingDepth: 2,
      },
      {
        subtaskId: 'sub-coding',
        role: 'coder',
        roleLabel: '代码与工程实现',
        goal: '核对工作区差异与依赖',
        model: 'code-helper',
        thinkingDepth: 1,
      },
    ],
  }, context);

  // 3. 校验汇总结果
  assert.equal(dispatchResult.total, 2);
  assert.equal(dispatchResult.succeeded, 2);
  assert.equal(dispatchResult.failed, 0);
  assert.equal(dispatchResult.cancelled, 0);

  // 4. 读回并校验真实的父子任务关系
  const child1 = runtime.findTaskByIdempotencyKey(`subagent-dispatch-${parentTask.taskId}-sub-research`);
  const child2 = runtime.findTaskByIdempotencyKey(`subagent-dispatch-${parentTask.taskId}-sub-coding`);

  assert.ok(child1, '子任务1必须在 Runtime 中持久化');
  assert.ok(child2, '子任务2必须在 Runtime 中持久化');

  assert.equal(child1.state, 'succeeded');
  assert.equal(child2.state, 'succeeded');

  const child1ParentMeta = runtime.loadCheckpoint(child1.taskId, 'subtask-parent');
  const child2ParentMeta = runtime.loadCheckpoint(child2.taskId, 'subtask-parent');

  assert.equal(child1ParentMeta.parentTaskId, parentTask.taskId);
  assert.equal(child1ParentMeta.subtaskId, 'sub-research');
  assert.equal(child1ParentMeta.role, 'researcher');
  assert.equal(child1ParentMeta.model, 'pangu-sub-agent');
  assert.equal(child1ParentMeta.thinkingDepth, 2);

  assert.equal(child2ParentMeta.parentTaskId, parentTask.taskId);
  assert.equal(child2ParentMeta.subtaskId, 'sub-coding');
  assert.equal(child2ParentMeta.role, 'coder');
  assert.equal(child2ParentMeta.model, 'code-helper');
  assert.equal(child2ParentMeta.thinkingDepth, 1);

  // 5. 验证取消链
  const abortController = new AbortController();
  const cancelParent = runtime.submitTask({
    conversationId: 'desktop-panel',
    goal: '将被取消的主任务',
    idempotencyKey: 'jarvis-cancel-parent-1',
  });

  abortController.abort(); // 提前取消

  const cancelContext = {
    taskId: cancelParent.taskId,
    runId: 'dispatch-cancel-run',
    signal: abortController.signal,
    deadline: new Date(Date.now() + 60_000).toISOString(),
    authorizationRef: `auth-${cancelParent.taskId}`,
    scopes: ['agent:delegate'],
  };

  const cancelResult = await tool.execute({
    subtasks: [
      {subtaskId: 'cancel-sub-1', role: 'planner', goal: '规划任务'},
    ],
  }, cancelContext);

  assert.equal(cancelResult.cancelled, 1);
  assert.equal(cancelResult.subtasks[0].state, 'cancelled');

  const cancelProgress = runtime.loadCheckpoint(cancelParent.taskId, 'subtask-progress-records');
  assert.equal(cancelProgress['cancel-sub-1'].state, 'cancelled');
});
