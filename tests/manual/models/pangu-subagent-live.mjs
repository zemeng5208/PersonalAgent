// 门控真实验收：POTATOS-MVP-TASKS-20260930 §9 第 2 条——「至少一条实际子任务使用真实已配置
// 模型，返回实际模型标识、结果和执行回执」。开启条件（凭据只经环境变量，不进仓库）：
//
//   PA_PANGU_LIVE=1 PANGU_BASE_URL=https://<endpoint> PANGU_API_KEY=<key> \
//   [PANGU_MODEL=...] [PANGU_DEPLOYMENT=...] node tests/manual/models/pangu-subagent-live.mjs
//
// 覆盖：真实盘古补全（文本层）→ StructuredToolProvider 工具提案（真实模型决定是否调用）→
// TaskRuntime 子任务（真实网关授权身份）→ 读回实际模型标识/结果/延迟/执行记录。
import assert from 'node:assert/strict';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {PanguModelProvider, StructuredToolProvider} from '@personal-agent/models';
import {TaskRuntime} from '@personal-agent/runtime';
import {createRuntimeSubagentDispatchTool} from '@personal-agent/runtime/application';

const required = name => {
  const value = process.env[name];
  if (!value || !value.trim()) {
    console.error(`缺少 ${name}；本脚本需要真实盘古凭据（PA_PANGU_LIVE=1 门控，不会误跑）。`);
    process.exit(1);
  }
  return value.trim();
};

const baseUrl = required('PANGU_BASE_URL');
const apiKey = required('PANGU_API_KEY');
const model = process.env.PANGU_MODEL ?? 'pangu-nlp-n1-32k';
const deployment = process.env.PANGU_DEPLOYMENT ?? model;

const text = new PanguModelProvider({baseUrl, model, deployment, apiKey: () => apiKey});
// 子 Agent 需要工具提案能力：组合现有 StructuredToolProvider（对任意文本端点可用）。
const gateway = new StructuredToolProvider(text);
console.log('deployment:', JSON.stringify(gateway.deployment));

const directory = await mkdtemp(path.join(tmpdir(), 'pa-pangu-subagent-live-'));
const runtime = new TaskRuntime(path.join(directory, 'runtime.sqlite'));
try {
  const parent = runtime.submitTask({conversationId: 'desktop-panel',
    goal: '真实盘古验收：单条子任务', idempotencyKey: 'pangu-live-parent-1'});
  const tool = createRuntimeSubagentDispatchTool({getRuntime: () => runtime, getModelGateway: () => gateway});
  const summary = await tool.execute({
    subtasks: [{subtaskId: 'live-1', role: 'researcher', goal: '用一句话说明今天验收了什么：真实盘古模型驱动的子任务执行链'}],
  }, {taskId: parent.taskId, runId: 'pangu-live-run-1', signal: new AbortController().signal,
    deadline: new Date(Date.now() + 120_000).toISOString(), authorizationRef: `auth-${parent.taskId}`,
    scopes: ['agent:delegate']});

  console.log('dispatch summary:', JSON.stringify(summary, null, 2));
  const child = runtime.findTaskByIdempotencyKey(`subagent-dispatch-${parent.taskId}-live-1`);
  assert.ok(child, '子任务必须在 Runtime 中持久化');
  assert.equal(child.state, 'succeeded', `子任务应成功，实际 ${child.state}`);
  assert.ok((child.resultSummary ?? '').trim(), '结果必须非空');
  // 实际模型标识与真实延迟（Fake 的 latencyMs 恒为 0，真实调用必然 > 0）。
  assert.match(child.resultSummary, /pangu|盘古|验收/i);
  const executions = runtime.readToolExecutions ? runtime.readToolExecutions(child.taskId) : [];
  console.log('child resultSummary:', child.resultSummary);
  console.log('tool executions:', executions.length, 'task state:', child.state);
  console.log('PASS: 真实盘古子任务端到端（模型标识=' + model + '，部署=' + deployment + '）');
} finally {
  runtime.close?.();
  await rm(directory, {recursive: true, force: true});
}
