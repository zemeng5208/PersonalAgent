// 门控真实验收：POTATOS-MVP-TASKS-20260930 §9 第 2 条——「至少一条实际子任务使用真实已配置
// 模型，返回实际模型标识、结果和执行回执」。开启条件（凭据只经环境变量，不进仓库）：
//
//   PA_MODEL_LIVE=1 PA_MODEL_BASE_URL=https://open.bigmodel.cn/api/paas/v4 \
//   PA_MODEL_MODEL=glm-4-flash PA_MODEL_API_KEY=<key> \
//   node tests/manual/models/openai-subagent-live.mjs
//
// 覆盖：真实 OpenAI 兼容补全（文本层）→ StructuredToolProvider 工具提案 → TaskRuntime 子任务
// （真实网关授权身份）→ 读回实际模型标识/结果/延迟/执行记录。适用任何 OpenAI 兼容端点
// （智谱/DeepSeek/Moonshot/vLLM…）；生产切换盘古时改用 pangu-subagent-live.mjs。
import assert from 'node:assert/strict';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {OpenAICompatibleModelProvider, StructuredToolProvider} from '@personal-agent/models';
import {TaskRuntime} from '@personal-agent/runtime';
import {createRuntimeSubagentDispatchTool} from '@personal-agent/runtime/application';

if (process.env.PA_MODEL_LIVE !== '1') {
  console.error('真实模型验收默认关闭；显式设置 PA_MODEL_LIVE=1 后才会读取凭据或发起请求。');
  process.exit(1);
}

const required = name => {
  const value = process.env[name];
  if (!value || !value.trim()) {
    console.error(`缺少 ${name}；本脚本需要真实模型凭据（PA_MODEL_LIVE=1 门控，不会误跑）。`);
    process.exit(1);
  }
  return value.trim();
};

const baseUrl = required('PA_MODEL_BASE_URL');
const model = required('PA_MODEL_MODEL');
const apiKey = required('PA_MODEL_API_KEY');

const text = new OpenAICompatibleModelProvider({baseUrl, model, apiKey: () => apiKey});
const gateway = new StructuredToolProvider(text);
console.log('deployment:', JSON.stringify(gateway.deployment));

const directory = await mkdtemp(path.join(tmpdir(), 'pa-openai-subagent-live-'));
const runtime = new TaskRuntime(path.join(directory, 'runtime.sqlite'));
try {
  const parent = runtime.submitTask({conversationId: 'desktop-panel',
    goal: '真实模型验收：单条子任务', idempotencyKey: 'openai-live-parent-1'});
  const tool = createRuntimeSubagentDispatchTool({getRuntime: () => runtime, getModelGateway: () => gateway});
  const summary = await tool.execute({
    subtasks: [{subtaskId: 'live-1', role: 'researcher', goal: '用一句话说明今天验收了什么：真实模型驱动的子任务执行链'}],
  }, {taskId: parent.taskId, runId: 'openai-live-run-1', signal: new AbortController().signal,
    deadline: new Date(Date.now() + 120_000).toISOString(), authorizationRef: `auth-${parent.taskId}`,
    scopes: ['agent:delegate']});

  console.log('dispatch summary:', JSON.stringify(summary, null, 2));
  const child = runtime.findTaskByIdempotencyKey(`subagent-dispatch-${parent.taskId}-live-1`);
  assert.ok(child, '子任务必须在 Runtime 中持久化');
  assert.equal(child.state, 'succeeded', `子任务应成功，实际 ${child.state}`);
  assert.ok((child.resultSummary ?? '').trim(), '结果必须非空');
  console.log('child resultSummary:', child.resultSummary);
  console.log('PASS: 真实模型子任务端到端（模型=' + model + '，端点=' + baseUrl + '）');
} finally {
  runtime.close?.();
  await rm(directory, {recursive: true, force: true});
}
