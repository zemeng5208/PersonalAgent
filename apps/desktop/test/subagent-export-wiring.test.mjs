import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import {
  createRuntimeSubagentDispatchTool,
  createDesktopSubagentDispatchTool,
  SUBAGENT_DISPATCH_TOOL_NAME,
  SUBAGENT_DISPATCH_TOOL_VERSION,
} from '@personal-agent/runtime/application';
import {TaskRuntime} from '@personal-agent/runtime';

test('subagent export projection projects bounded result correctly from real result contract', async () => {
  // 模拟 main.js 中的 subagentExport 投影逻辑
  const subagentExport = {
    toolName: 'subagent.dispatch',
    toolVersion: '1.0.0',
    exportPolicyVersion: '1.0.0',
    accepts: ({arguments: args}) => Array.isArray(args?.subtasks) && args.subtasks.length > 0 && args.subtasks.length <= 10,
    project: async ({result, signal}) => {
      if (signal?.aborted) throw Error('次级智能体结果导出已取消');
      if (!result || typeof result !== 'object') throw Error('次级智能体结果无效');
      const r = result;
      const projected = {
        total: Number(r.total ?? 0),
        succeeded: Number(r.succeeded ?? 0),
        failed: Number(r.failed ?? 0),
        cancelled: Number(r.cancelled ?? 0),
        summary: String(r.summary ?? r.aggregatedSummary ?? '').slice(0, 16384),
        subtasks: Array.isArray(r.subtasks) ? r.subtasks.map(s => ({
          subtaskId: String(s.subtaskId ?? ''),
          role: String(s.role ?? ''),
          roleLabel: String(s.roleLabel ?? ''),
          state: String(s.state ?? ''),
          result: typeof s.result === 'string' ? s.result.slice(0, 4096) : undefined,
          error: typeof s.error === 'string' ? s.error.slice(0, 1024) : undefined,
        })) : [],
      };
      if (Buffer.byteLength(JSON.stringify(projected), 'utf8') > 64 * 1024) {
        throw Error('次级智能体汇总结果超出 64KB 上限');
      }
      return projected;
    },
  };

  const rawToolResult = {
    total: 2,
    succeeded: 2,
    failed: 0,
    cancelled: 0,
    aggregatedSummary: '## 次级智能体协作汇总\n\n### 调研\n数据有效',
    subtasks: [
      {subtaskId: '1', role: 'researcher', roleLabel: '资料检索与调研', state: 'succeeded', result: '北京天气晴朗'},
      {subtaskId: '2', role: 'coder', roleLabel: '代码与工程实现', state: 'succeeded', result: '差异核查无误'},
    ],
  };

  // 必须传入真实契约字段 result
  const projected = await subagentExport.project({
    taskId: 'task-1',
    proposalId: 'prop-1',
    result: rawToolResult,
    signal: new AbortController().signal,
  });

  assert.equal(projected.total, 2);
  assert.equal(projected.succeeded, 2);
  assert.equal(projected.subtasks.length, 2);
  assert.equal(projected.subtasks[0].result, '北京天气晴朗');
  assert.match(projected.summary, /次级智能体协作汇总/);
});

test('knowledge export projection projects sanitized and bounded results', async () => {
  const knowledgeExport = {
    toolName: 'knowledge.search',
    toolVersion: '0.1.0-alpha.1',
    exportPolicyVersion: '1.0.0',
    accepts: ({arguments: args}) => typeof args?.query === 'string' && args.query.trim().length > 0,
    project: async ({result, signal}) => {
      if (signal?.aborted) throw Error('知识库检索结果导出已取消');
      if (!result || typeof result !== 'object') throw Error('知识库检索结果无效');
      const r = result;
      const projected = {
        hits: Array.isArray(r.hits) ? r.hits.slice(0, 5).map(h => ({
          source: {
            vaultId: String(h.source?.vaultId ?? ''),
            path: path.basename(String(h.source?.path ?? '')),
            line: Number(h.source?.line ?? 1),
            revision: String(h.source?.revision ?? ''),
          },
          excerpt: String(h.excerpt ?? '').slice(0, 200),
        })) : [],
        truncated: Boolean(r.truncated || (Array.isArray(r.hits) && r.hits.length > 5)),
      };
      if (Buffer.byteLength(JSON.stringify(projected), 'utf8') > 16 * 1024) {
        throw Error('知识库检索投影超出 16KB 上限');
      }
      return projected;
    },
  };

  const rawKnowledgeResult = {
    hits: [
      {
        source: {
          vaultId: 'desktop-notes',
          path: 'C:\\Users\\PrivateUser\\Documents\\PersonalObsidian\\secret\\diary.md',
          line: 42,
          revision: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
        },
        excerpt: '今天天气很好，完成了任务规划。'.repeat(10), // 超过 200 字
      },
    ],
    truncated: false,
  };

  const projected = await knowledgeExport.project({
    taskId: 'task-k',
    proposalId: 'prop-k',
    result: rawKnowledgeResult,
    signal: new AbortController().signal,
  });

  assert.equal(projected.hits.length, 1);
  // 验证敏感完整路径已被脱敏为 basename
  assert.equal(projected.hits[0].source.path, 'diary.md');
  assert.ok(!projected.hits[0].source.path.includes('Users'));
  // 验证摘要长度被限制在 200 字符内
  assert.ok(projected.hits[0].excerpt.length <= 200);
});

test('runtime-created subagent dispatch tool executes successfully in TaskRuntime flow', async () => {
  const runtime = new TaskRuntime(':memory:');
  const parent = runtime.submitTask({
    conversationId: 'desktop-panel',
    goal: '主协同任务',
    idempotencyKey: 'flow-parent-1',
  });

  let runtimeRef = runtime;
  const subagentTool = createRuntimeSubagentDispatchTool({
    getRuntime: () => runtimeRef,
  });

  const summary = await subagentTool.execute({
    subtasks: [
      {subtaskId: 'flow-sub-1', role: 'researcher', goal: '检索天气'},
      {subtaskId: 'flow-sub-2', role: 'planner', goal: '规划日程'},
    ],
  }, {
    taskId: parent.taskId,
    runId: 'flow-run-1',
    signal: new AbortController().signal,
    deadline: new Date(Date.now() + 60_000).toISOString(),
    authorizationRef: `auth-${parent.taskId}`,
    scopes: ['agent:delegate'],
  });

  assert.equal(summary.total, 2);
  assert.equal(summary.succeeded, 2);
  assert.equal(summary.failed, 0);
  assert.equal(summary.subtasks.length, 2);

  // 验证父子任务关联
  const subtask1 = runtime.findTaskByIdempotencyKey(`subagent-dispatch-${parent.taskId}-flow-sub-1`);
  assert.ok(subtask1);
  assert.equal(subtask1.state, 'succeeded');
  const parentCheckpoint = runtime.loadCheckpoint(subtask1.taskId, 'subtask-parent');
  assert.equal(parentCheckpoint.parentTaskId, parent.taskId);
});

test('desktop subagent tool with getModelGateway executes subtasks with distinct roles and models, projecting into export summary', async () => {
  const runtime = new TaskRuntime(':memory:');
  const parent = runtime.submitTask({
    conversationId: 'desktop-panel',
    goal: '桌面主任务：多角色多模型协同',
    idempotencyKey: 'desktop-subtask-test-parent',
  });

  // 镜像 main.js 中的 createDesktopSubagentDispatchTool 配置
  const subagentTool = createDesktopSubagentDispatchTool({
    getRuntime: () => runtime,
    fakeModelMode: true,
  });

  const subagentExport = {
    toolName: 'subagent.dispatch',
    toolVersion: '1.0.0',
    exportPolicyVersion: '1.0.0',
    accepts: ({arguments: args}) => Array.isArray(args?.subtasks) && args.subtasks.length > 0 && args.subtasks.length <= 10,
    project: async ({result, signal}) => {
      if (signal?.aborted) throw Error('次级智能体结果导出已取消');
      if (!result || typeof result !== 'object') throw Error('次级智能体结果无效');
      const r = result;
      return {
        total: Number(r.total ?? 0),
        succeeded: Number(r.succeeded ?? 0),
        failed: Number(r.failed ?? 0),
        cancelled: Number(r.cancelled ?? 0),
        summary: String(r.summary ?? r.aggregatedSummary ?? '').slice(0, 16384),
        subtasks: Array.isArray(r.subtasks) ? r.subtasks.map(s => ({
          subtaskId: String(s.subtaskId ?? ''),
          role: String(s.role ?? ''),
          roleLabel: String(s.roleLabel ?? ''),
          state: String(s.state ?? ''),
          result: typeof s.result === 'string' ? s.result.slice(0, 4096) : undefined,
          error: typeof s.error === 'string' ? s.error.slice(0, 1024) : undefined,
        })) : [],
      };
    },
  };

  const toolResult = await subagentTool.execute({
    subtasks: [
      {
        subtaskId: 'sub-research-desk',
        role: 'researcher',
        roleLabel: '资料检索与调研',
        goal: '调研天气与日程',
        model: 'deep-research',
        thinkingDepth: 3,
      },
      {
        subtaskId: 'sub-coder-desk',
        role: 'coder',
        roleLabel: '代码与工程实现',
        goal: '检查工作区状态',
        model: 'code-fast',
        thinkingDepth: 1,
      },
    ],
  }, {
    taskId: parent.taskId,
    runId: 'desk-subagent-run',
    signal: new AbortController().signal,
    deadline: new Date(Date.now() + 60_000).toISOString(),
    authorizationRef: `auth-${parent.taskId}`,
    scopes: ['agent:delegate'],
  });

  const projected = await subagentExport.project({
    taskId: parent.taskId,
    proposalId: 'prop-desk-subagent',
    result: toolResult,
    signal: new AbortController().signal,
  });

  assert.equal(projected.total, 2);
  assert.equal(projected.succeeded, 2);
  assert.equal(projected.failed, 0);
  assert.equal(projected.cancelled, 0);
  assert.equal(projected.subtasks.length, 2);

  // 校验子任务1角色与模型输出
  assert.equal(projected.subtasks[0].role, 'researcher');
  assert.equal(projected.subtasks[0].roleLabel, '资料检索与调研');
  assert.match(projected.subtasks[0].result, /\[次级智能体 deep-research\] 完成分析与执行/);

  // 校验子任务2角色与模型输出
  assert.equal(projected.subtasks[1].role, 'coder');
  assert.equal(projected.subtasks[1].roleLabel, '代码与工程实现');
  assert.match(projected.subtasks[1].result, /\[次级智能体 code-fast\] 完成分析与执行/);

  // 校验汇总摘要包含两个角色的输出
  assert.match(projected.summary, /次级智能体协作汇总/);
  assert.match(projected.summary, /deep-research/);
  assert.match(projected.summary, /code-fast/);
});
