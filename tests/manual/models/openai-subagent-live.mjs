// 显式门控的独立 OpenAI 兼容 API 子任务验收；源码准备不等于真实端点已验收。
// 经正式 ModelGateway → StructuredToolProvider → Provider 提案，读取本次公开合成夹具，
// 由现有 Runtime Application / Policy / ToolGateway 记录 Evidence。配置标识不冒充服务端模型身份。
// 开启条件（凭据只经环境变量，不进日志/收据/仓库）：
//
//   PA_MODEL_LIVE=1 PA_MODEL_BASE_URL=https://open.bigmodel.cn/api/paas/v4 \
//   PA_MODEL_MODEL=glm-4-flash PA_MODEL_API_KEY=<key> \
//   node tests/manual/models/openai-subagent-live.mjs
//
// 仅验本端点的文字 JSON 工具提案与本地只读闭环；不证明原生 function calling / reasoning、
// AgentArts 默认子任务、Desktop 挂载或比赛整体验收。端点不遵循提案协议时明确失败，无 Fake。
// 收据/公开夹具保留在项目忽略目录 .cache/manual-model-acceptance/；Runtime 用新建内存库，
// 不接触用户数据库，不保存原始模型输出/HTTP body/请求头/密钥，不运行未知写入或重试。
import assert from 'node:assert/strict';
import {mkdir, mkdtemp, readFile, writeFile} from 'node:fs/promises';
import {createHash, randomUUID} from 'node:crypto';
import {performance} from 'node:perf_hooks';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import {ModelGateway, OpenAICompatibleModelProvider, StructuredToolProvider} from '@personal-agent/models';
import {createRuntimeApplication, createRuntimeSubagentDispatchTool} from '@personal-agent/runtime/application';

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

const baseUrlInput = required('PA_MODEL_BASE_URL');
let baseUrl;
try {
  const endpoint = new URL(baseUrlInput);
  if (endpoint.username || endpoint.password || endpoint.search || endpoint.hash
    || !(endpoint.protocol === 'https:' || (endpoint.protocol === 'http:'
      && ['localhost', '127.0.0.1', '[::1]'].includes(endpoint.hostname)))) {
    throw new Error();
  }
  baseUrl = endpoint.href.replace(/\/+$/u, '');
} catch {
  console.error('PA_MODEL_BASE_URL must use HTTPS; HTTP is allowed only for loopback, without credentials, query, or fragment.');
  process.exit(1);
}
const model = required('PA_MODEL_MODEL');
const apiKey = required('PA_MODEL_API_KEY');
const receiptRoot = fileURLToPath(new URL('../../../.cache/manual-model-acceptance/', import.meta.url));
await mkdir(receiptRoot, {recursive: true});
const directory = await mkdtemp(path.join(receiptRoot, 'openai-'));
const fixtureId = `public-${randomUUID()}`;
const fixtureText = `Synthetic acceptance marker: ${randomUUID()}`;
const fixturePath = path.join(directory, 'public-fixture.txt');
await writeFile(fixturePath, fixtureText, {encoding: 'utf8', flag: 'wx'});
const receipt = {version: 1, status: 'running', startedAt: new Date().toISOString(),
  scope: 'explicit-api-child-json-proposal-local-read', profile: 'huawei_ict_agentarts',
  configuredModel: {provider: 'openai-compatible', model}, modelVerification: 'conditional',
  nativeToolCallingVerified: false, nativeReasoningVerified: false, agentArtsDefaultVerified: false,
  http: [], modelCalls: [], toolHandlerDurationsMs: [], checks: {}};
const started = performance.now();
const milliseconds = value => Math.round(value * 100) / 100;
// Redact any accidental credential echo, including response model identifiers and errors.
const safeId = value => typeof value === 'string' && value.trim() && value.length <= 200
  && !/[\u0000-\u001f\u007f]/u.test(value) && !value.includes(apiKey) ? value : null;
const observedFetch = async (url, init) => {
  assert.equal(String(url), `${baseUrl}/chat/completions`, 'Provider must use the normalized endpoint');
  const record = {startedAfterMs: milliseconds(performance.now() - started), status: null, serverReportedModel: null};
  receipt.http.push(record);
  const response = await globalThis.fetch(url, init);
  record.status = response.status;
  // Observe only the optional server-reported model identifier, never raw response data.
  try {record.serverReportedModel = safeId((await response.clone().json())?.model);} catch { /* Provider validates the actual response. */ }
  return response;
};
const provider = new StructuredToolProvider(new OpenAICompatibleModelProvider({baseUrl, model, apiKey: () => apiKey, fetch: observedFetch}));
const gateway = new ModelGateway(provider);
const complete = gateway.complete.bind(gateway);
// Instrument the actual gateway result, after its validation/cancellation/deadline checks.
gateway.complete = async request => {
  const callStarted = performance.now();
  const call = {startedAfterMs: milliseconds(callStarted - started), durationMs: null, responseKind: null};
  receipt.modelCalls.push(call);
  try {
    const result = await complete(request);
    call.responseKind = result.response.kind;
    call.providerLatencyMs = result.latencyMs;
    if (result.usage) call.usage = result.usage;
    return result;
  } finally {call.durationMs = milliseconds(performance.now() - callStarted);}
};
const readTool = {descriptor: {name: 'acceptance.read_public_fixture', version: '1.0.0',
  inputSchema: {type: 'object', required: ['fixtureId'], additionalProperties: false,
    properties: {fixtureId: {type: 'string', enum: [fixtureId]}}},
  outputSchema: {type: 'object', required: ['text'], additionalProperties: false, properties: {text: {type: 'string'}}},
  sideEffect: 'read', requiredScopes: ['acceptance:read'], idempotencySupport: true, recoverySupport: true, requiresPresence: false},
  async execute(input, context) {
    assert.equal(input.fixtureId, fixtureId);
    assert.equal(context.signal.aborted, false);
    const readStarted = performance.now();
    try {return {text: await readFile(fixturePath, 'utf8')};}
    finally {receipt.toolHandlerDurationsMs.push(milliseconds(performance.now() - readStarted));}
  }};
const app = createRuntimeApplication({path: ':memory:', profile: 'huawei_ict_agentarts', tools: [readTool],
  automaticTools: [{toolName: readTool.descriptor.name, toolVersion: readTool.descriptor.version}]});
const runtime = app.runtime;
let parent, child;
const cancel = () => {if (parent && !['succeeded', 'failed', 'cancelled'].includes(runtime.getTask(parent.taskId).state)) {
  runtime.requestCancel(parent.taskId, 'Manual acceptance interrupted');
}};
process.once('SIGINT', cancel); process.once('SIGTERM', cancel);
try {
  parent = runtime.submitTask({conversationId: 'manual-public-acceptance',
    goal: 'Synthetic explicit API child acceptance', idempotencyKey: 'openai-live-parent-1'});
  const deadline = new Date(Date.now() + 120_000).toISOString();
  const tool = createRuntimeSubagentDispatchTool({getRuntime: () => runtime, getTools: () => app.tools,
    getModelGateway: name => name === 'live-configured-api' ? gateway : undefined});
  const dispatchStarted = performance.now();
  const parentOutcome = await runtime.runTask(parent.taskId, async worker => {
    const summary = await tool.execute({subtasks: [{subtaskId: 'live-1', role: 'researcher', model: 'live-configured-api',
      goal: `Call acceptance.read_public_fixture version 1.0.0 exactly once with fixtureId ${JSON.stringify(fixtureId)}. `
        + 'Then return the exact text supplied by that tool. Do not guess the marker or report success without reading.'}]},
    {taskId: worker.taskId, runId: 'openai-live-dispatch', signal: worker.signal, deadline: worker.deadline,
      authorizationRef: 'manual-host-dispatch', scopes: ['agent:delegate']});
    receipt.dispatch = {total: summary.total, succeeded: summary.succeeded, failed: summary.failed, cancelled: summary.cancelled};
    assert.equal(summary.succeeded, 1, 'Text alone without the required tool receipt is not a passed acceptance');
    child = runtime.findTaskByIdempotencyKey(`subagent-dispatch-${parent.taskId}-live-1`);
    return {resultSummary: 'Synthetic child completed; inspect the local acceptance receipt', evidenceRefs: child?.evidenceRefs ?? []};
  }, {deadline, sideEffect: 'read'});
  receipt.dispatchDurationMs = milliseconds(performance.now() - dispatchStarted);
  child = runtime.findTaskByIdempotencyKey(`subagent-dispatch-${parent.taskId}-live-1`);
  assert.ok(child, '子任务必须在 Runtime 中持久化');
  assert.equal(parentOutcome.state, 'succeeded');
  assert.equal(child.state, 'succeeded', `子任务应成功，实际 ${child.state}`);
  const binding = runtime.loadCheckpoint(child.taskId, 'subtask-parent');
  assert.equal(binding.parentTaskId, parent.taskId); assert.equal(binding.parentDeadline, deadline);
  assert.equal(binding.model, 'live-configured-api');
  const identity = runtime.loadCheckpoint(child.taskId, 'subtask-model-binding');
  assert.deepEqual(identity, {provider: gateway.deployment.provider, deployment: gateway.deployment.deployment, model});
  const records = runtime.readToolExecutions(child.taskId);
  assert.equal(records.length, 1, 'Exactly one local read must be recorded');
  const record = records[0];
  assert.equal(record.taskId, child.taskId); assert.match(record.evidenceId, new RegExp(`^agent-run-${child.taskId}-[0-9]+$`));
  assert.equal(record.toolName, readTool.descriptor.name); assert.equal(record.toolVersion, readTool.descriptor.version);
  assert.equal(record.state, 'confirmed'); assert.equal(record.policyDecision, 'allow'); assert.equal(record.executionStarted, true);
  assert.ok(child.evidenceRefs.includes(record.evidenceId));
  assert.equal(runtime.policy.get(record.evidenceId)?.usesRemaining, 0);
  assert.equal(runtime.matchesToolExecutionInput(record, {arguments: {fixtureId}, scopeRef: record.evidenceId}), true);
  const toolResult = runtime.loadCheckpoint(child.taskId, `tool-result-${record.evidenceId}`);
  assert.equal(toolResult.result.text, await readFile(fixturePath, 'utf8'));
  assert.ok(child.resultSummary.includes(fixtureText), 'Final answer must contain the independently read synthetic marker');
  assert.ok(receipt.modelCalls.some(call => call.responseKind === 'tool_proposal'));
  assert.ok(receipt.http.length > 0 && receipt.http.every(call => call.status >= 200 && call.status < 300));
  receipt.checks = {parentChildBinding: true, configuredDeploymentBinding: true,
    modelToolProposalObserved: true, policyAllowed: true, grantConsumedOnce: true, confirmedReadbackMatchesFixture: true};
  receipt.status = 'passed';
} catch (error) {
  receipt.status = 'failed';
  // Never echo arbitrary provider/assertion messages, which may contain remote/private data.
  receipt.errorCode = typeof error?.code === 'string' && /^[A-Z_]+$/u.test(error.code) ? error.code : 'ACCEPTANCE_CHECK_FAILED';
  process.exitCode = 1;
} finally {
  receipt.totalDurationMs = milliseconds(performance.now() - started);
  receipt.modelCallsTotalMs = milliseconds(receipt.modelCalls.reduce((sum, call) => sum + (call.durationMs ?? 0), 0));
  receipt.firstValidatedModelResponseMs = receipt.modelCalls.filter(call => call.responseKind !== null)
    .map(call => milliseconds(call.startedAfterMs + call.durationMs)).at(0) ?? null;
  receipt.firstTokenMs = null; // This provider is non-streaming; no first-token measurement is claimed.
  receipt.tasks = {parent: parent ? {taskId: parent.taskId, state: runtime.getTask(parent.taskId).state} : null,
    child: child ? {taskId: child.taskId, state: child.state, evidenceRefs: child.evidenceRefs,
      resultSha256: createHash('sha256').update(child.resultSummary ?? '').digest('hex')} : null};
  receipt.evidence = child ? runtime.readToolExecutions(child.taskId) : [];
  process.removeListener('SIGINT', cancel); process.removeListener('SIGTERM', cancel);
  app.close();
  await writeFile(path.join(directory, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n', {encoding: 'utf8', flag: 'wx'});
  console.log(`${receipt.status === 'passed' ? 'PASS' : 'FAIL'}: explicit API JSON-proposal/local-read acceptance; backend model identity remains conditional.`);
  console.log(`Receipt: ${path.relative(process.cwd(), path.join(directory, 'receipt.json'))}`);
}
