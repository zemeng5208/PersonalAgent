import {mkdirSync, mkdtempSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {join} from 'node:path';
import {createOpenMeteoApplication} from '@personal-agent/runtime/weather';

// Explicit local opt-in only. Never load .env or print credentials.
if (process.env.PA_MODEL_LIVE !== '1') {
  console.log('SKIPPED: set PA_MODEL_LIVE=1 only after authorizing real model and read-only weather calls.');
  process.exit(0);
}
for (const name of ['PANGU_BASE_URL', 'PANGU_MODEL', 'PANGU_API_KEY']) {
  if (!process.env[name]?.trim()) { console.error('Missing local configuration: ' + name); process.exit(1); }
}
const root = fileURLToPath(new URL('../../.cache/mod-04-05-live/', import.meta.url));
mkdirSync(root, {recursive: true});
const app = createOpenMeteoApplication({path: join(mkdtempSync(join(root, 'run-')), 'runtime.sqlite'), text: {
  mode: 'pangu', baseUrl: process.env.PANGU_BASE_URL, model: process.env.PANGU_MODEL, apiKey: () => process.env.PANGU_API_KEY,
}});
const request = (operation, payload, extra = {}) => ({kind: 'request', protocolVersion: '1.0.0', requestId: crypto.randomUUID(), operation, payload, deadline: new Date(Date.now() + 60_000).toISOString(), ...extra});
const signal = new AbortController().signal;
try {
  const connection = await app.testTextConnection();
  console.log(JSON.stringify({check: 'real-text', provider: connection.deployment.provider, model: connection.deployment.model, latencyMs: connection.latencyMs, usage: connection.usage ?? null}));
  const response = await app.send(request('task.submit', {goal: '请查询北京今天的天气。必须先调用 weather.forecast 获取结果，再依据工具数据用中文回答；不要编造天气。', conversationId: 'manual-weather'}, {idempotencyKey: crypto.randomUUID()}), signal);
  if (response.outcome !== 'ok') throw new Error(response.error.code);
  const taskId = response.data.taskId;
  const end = Date.now() + 90_000;
  const approved = new Set();
  while (Date.now() < end) {
    for (const event of app.readEvents().filter(item => item.type === 'approval.requested' && item.taskId === taskId)) {
      if (approved.has(event.payload.approvalId)) continue;
      if (event.payload.action !== 'weather.forecast' || approved.size > 0) throw new Error('Unexpected additional tool approval');
      approved.add(event.payload.approvalId);
      const approval = await app.send(request('authorization.respond', {approvalId: event.payload.approvalId, expectedRevision: event.payload.revision, decision: 'allow_once'}), signal);
      if (approval.outcome !== 'ok') throw new Error(approval.error.code);
    }
    const task = app.runtime.getTask(taskId);
    if (['succeeded', 'failed', 'cancelled'].includes(task.state)) {
      const records = app.runtime.readToolExecutions(taskId);
      console.log(JSON.stringify({check: 'real-weather-loop', state: task.state, errorCode: task.error?.code ?? null, toolRuns: records.length, confirmedRuns: records.filter(item => item.state === 'confirmed').length, evidenceCount: task.evidenceRefs.length}));
      if (task.state !== 'succeeded' || !records.some(item => item.state === 'confirmed')) throw new Error('Real tool loop did not pass');
      break;
    }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  if (app.runtime.getTask(taskId).state !== 'succeeded') {
    app.runtime.requestCancel(taskId);
    throw new Error('Manual acceptance deadline exceeded');
  }
} catch (error) {
  console.error('Acceptance failed:', error instanceof Error ? error.message : 'unknown error');
  process.exitCode = 1;
} finally {
  if (!app.activeTaskCount) app.close();
}
