import {mkdir, writeFile} from 'node:fs/promises';
import {AgentArtsCloudAgentPort} from '../../../../packages/coordination/dist/index.js';
import {createTextDiagnosticFetch} from './text-response-diagnostic.mjs';

// Explicit manual command only. Uses the same trusted process configuration as
// Desktop; never reads old captures, secrets from other providers, or raw logs.
const configured = ['PA_AGENTARTS_AUTHORIZATION', 'PA_AGENTARTS_GATEWAY_URL', 'PA_AGENTARTS_RUNTIME_NAME']
  .every(name => typeof process.env[name] === 'string' && process.env[name].trim().length > 0);
if (!configured) {
  console.log(JSON.stringify({outcome: 'not_configured', networkCalls: 0}));
  process.exitCode = 2;
} else {
  const diagnostic = createTextDiagnosticFetch(globalThis.fetch);
  const startedAt = new Date().toISOString();
  const report = {profile: 'huawei_ict_agentarts', surface: 'CloudAgentPort only', startedAt,
    nodeVersion: process.version, dataClass: 'synthetic', automaticRetry: false,
    rawResponseSaved: false, credentialsRecorded: false, localFallback: false};
  try {
    const cloud = new AgentArtsCloudAgentPort({
      gatewayUrl: process.env.PA_AGENTARTS_GATEWAY_URL,
      runtimeName: process.env.PA_AGENTARTS_RUNTIME_NAME,
      ...(process.env.PA_AGENTARTS_WORKFLOW_GOAL_INPUT === undefined ? {} : {
        workflowGoalInput: process.env.PA_AGENTARTS_WORKFLOW_GOAL_INPUT,
      }),
    }, {read: async () => process.env.PA_AGENTARTS_AUTHORIZATION}, diagnostic.fetch);
    const result = await cloud.invoke({
      taskId: `synthetic-text-probe-${Date.now()}`, revision: 1,
      goal: '合成验收，不调用任何工具。假设会议从15:00改为17:00，准备事项从14:00改为16:00；无关计划保持不变。请简短说明影响和建议，不声称已执行或已验证。',
      deadline: new Date(Date.now() + 180_000).toISOString(), signal: new AbortController().signal,
    });
    report.outcome = 'succeeded';
    report.resultCharacters = result.text.length;
    report.verification = result.verification;
  } catch (error) {
    report.outcome = 'failed';
    report.errorCode = ['EXTERNAL_FAILURE', 'TIMEOUT', 'CANCELLED', 'INVALID_ARGUMENT'].includes(error?.code)
      ? error.code : 'INTERNAL_FAILURE';
    process.exitCode = 1;
  }
  report.finishedAt = new Date().toISOString();
  report.response = diagnostic.snapshot();
  const directory = new URL('../../../../.cache/agentarts-text/', import.meta.url);
  await mkdir(directory, {recursive: true});
  await writeFile(new URL(`${startedAt.replaceAll(':', '-')}.json`, directory), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report, null, 2));
}
