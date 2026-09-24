const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {_electron} = require('playwright');

// Manual, paid Competition acceptance. The caller supplies the credential only
// through the trusted process environment and explicitly opts in to this run.
if (process.env.PA_MANUAL_SYNTHETIC_CLOUD_E2E !== '1'
  || !['PA_AGENTARTS_AUTHORIZATION', 'PA_AGENTARTS_GATEWAY_URL',
    'PA_AGENTARTS_RUNTIME_NAME'].every(key => process.env[key])) {
  throw Error('Explicit synthetic cloud E2E configuration is required');
}
const root = path.resolve(__dirname, '../../../..');
const desktop = path.join(root, 'apps/desktop');
const electron = path.join(root, 'node_modules/electron/dist/electron.exe');
const userData = fs.mkdtempSync(path.join(root, '.cache/desktop-agentarts-'));
const goal = '合成验收。请提出本地只读工具请求以读取当前工作区的 meeting-update.json；不要在云端执行工具、猜测内容或声称完成。最终只输出单个 JSON 对象，无 Markdown、前后说明或额外字段：{"kind":"tool_proposal","proposalId":"mvp-meeting-read-1","toolName":"workspace.read_text","toolVersion":"1.0.0","arguments":{"path":"meeting-update.json"}}。不得输出 verification、授权或 Evidence。';
const report = {profile: 'huawei_ict_agentarts', surface: 'Electron Desktop',
  startedAt: new Date().toISOString(), dataClass: 'synthetic',
  approvalMode: 'automated-synthetic-UI', userData, graphWrittenByCloud: false,
  stage: 'launch'};

async function snapshot(page) {
  return (await page.evaluate(() => window.desktop.invoke('snapshot'))).value;
}
async function waitUntil(check, timeoutMs = 190_000) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    const found = await check();
    if (found) return found;
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  throw Error('Timed out waiting for Desktop state');
}
async function pageFor(app, mode) {
  return waitUntil(() => app.windows().find(page => page.url().includes(`mode=${mode}`)), 15_000);
}
async function launch() {
  const app = await _electron.launch({executablePath: electron, args: [desktop], env: {
    ...process.env, ELECTRON_RUN_AS_NODE: undefined,
    PA_RUNTIME_PROFILE: 'huawei_ict_agentarts', PA_DESKTOP_SYNTHETIC_MVP: '1',
    PA_AGENTARTS_INVOKE_MODE: 'published', PA_AGENTARTS_RESPONSE_MODE: 'tool-proposal-json',
    PA_AGENTARTS_REPAIR_CANDIDATE_VERSION: '1.0', PA_DESKTOP_TEST_USER_DATA: userData,
    PA_DESKTOP_MODEL_MODE: undefined,
  }});
  await app.firstWindow();
  const orb = await pageFor(app, 'orb');
  await orb.evaluate(() => window.desktop.invoke('orb.open'));
  const panel = await pageFor(app, 'panel');
  await panel.waitForSelector('#send');
  return {app, panel};
}

(async () => {
  let session;
  try {
    session = await launch();
    report.stage = 'submit';
    const {app, panel} = session;
    await app.evaluate(() => {
      const originalFetch = globalThis.fetch;
      globalThis.__mvpFetchInfo = [];
      globalThis.fetch = async (...args) => {
        const item = {attempt: globalThis.__mvpFetchInfo.length + 1,
          startedAt: new Date().toISOString()};
        const headers = args[1]?.headers;
        const requestId = headers?.['X-Request-Id'];
        const sessionId = headers?.['x-hw-agentarts-session-id'];
        if (typeof requestId === 'string' && /^[0-9a-f-]{36}$/.test(requestId)) item.requestId = requestId;
        if (typeof sessionId === 'string' && /^[0-9a-f-]{36}$/.test(sessionId)) item.sessionId = sessionId;
        globalThis.__mvpFetchInfo.push(item);
        let response;
        try { response = await originalFetch(...args); }
        catch (error) {
          item.fetchRejected = true;
          item.errorName = ['AbortError', 'TimeoutError', 'TypeError'].includes(error?.name)
            ? error.name : 'other';
          throw error;
        }
        item.status = response.status;
        item.contentType = response.headers.get('content-type');
        void response.clone().text().then(body => {
          item.characters = body.length;
          let answer;
          item.errorEvents = 0;
          for (const line of body.split(/\r\n|\r|\n/)) {
            if (!line.startsWith('data:')) continue;
            try {
              const event = JSON.parse(line.slice(5).trim());
              if (event.event === 'error') item.errorEvents++;
              if (event.event === 'workflow_end' && typeof event.data?.answer === 'string')
                answer = event.data.answer;
            } catch {}
          }
          item.answerCharacters = answer?.length ?? 0;
          if (answer) {
            try {
              const value = JSON.parse(answer);
              item.answerJson = true;
              const allowedKeys = new Set(['kind', 'proposalId', 'toolName', 'toolVersion',
                'arguments', 'candidateVersion', 'candidate', 'text']);
              item.answerKeys = value && typeof value === 'object'
                ? Object.keys(value).map(key => allowedKeys.has(key) ? key : 'other') : [];
              item.answerKind = ['text', 'tool_proposal', 'repair_candidate'].includes(value?.kind)
                ? value.kind : 'other';
            } catch { item.answerJson = false; }
          }
        }).catch(() => { item.bodyReadFailed = true; });
        return response;
      };
    });
    await app.evaluate(({dialog}) => {
      const original = dialog.showMessageBox.bind(dialog);
      globalThis.__mvpDialogPreviews = [];
      dialog.showMessageBox = async (...args) => {
        const options = args.at(-1);
        if (options?.title === '合成会议计划修复预览') {
          globalThis.__mvpDialogPreviews.push(options.detail);
          return {response: 0, checkboxChecked: false};
        }
        return original(...args);
      };
    });
    await panel.locator('textarea').fill(goal);
    await panel.locator('#send').click();
    const source = await waitUntil(async () => {
      const data = await snapshot(panel);
      return data.tasks.find(task => task.goal === goal);
    });
    report.sourceTaskId = source.taskId;
    report.stage = 'read-approval';
    const firstApproval = await waitUntil(async () => {
      const data = await snapshot(panel);
      if (data.tasks.find(task => task.taskId === source.taskId)?.state === 'failed')
        throw Error('Source task failed before tool approval');
      return data.approvals.find(item => item.taskId === source.taskId && item.state === 'pending');
    });
    report.sourceApprovalPresented = Boolean(firstApproval);
    await panel.evaluate(() => window.desktop.invoke('admin.open', {page: 'authorizations'}));
    const admin = await pageFor(app, 'admin');
    await admin.locator(`[data-approval="allow_once"][data-id="${firstApproval.approvalId}"]`).click();
    report.readApprovalResponded = true;
    const completed = await waitUntil(async () => {
      const data = await snapshot(panel);
      const task = data.tasks.find(item => item.taskId === source.taskId);
      if (task?.state === 'failed') throw Error('Cloud continuation or candidate failed');
      return task?.state === 'succeeded' ? task : undefined;
    });
    report.sourceState = completed.state;
    report.stage = 'preview';
    const preview = await waitUntil(() => app.evaluate(() => globalThis.__mvpDialogPreviews?.at(-1)), 15_000);
    assert.match(preview, /Attend meeting at 17:00/);
    assert.match(preview, /Prepare at 16:00/);
    report.candidatePreviewed = true;
    const repair = await waitUntil(async () => {
      const data = await snapshot(admin);
      return data.tasks.find(item => item.taskId !== source.taskId && item.state === 'waiting_approval');
    }, 15_000);
    report.localTaskId = repair.taskId;
    report.stage = 'write-approval';
    const localApproval = await waitUntil(async () => {
      const data = await snapshot(admin);
      return data.approvals.find(item => item.taskId === repair.taskId && item.state === 'pending');
    }, 15_000);
    assert.equal(localApproval.toolName, 'cognition.commit_repair');
    await admin.locator(`[data-approval="allow_once"][data-id="${localApproval.approvalId}"]`).click();
    const localDone = await waitUntil(async () => {
      const data = await snapshot(admin);
      const task = data.tasks.find(item => item.taskId === repair.taskId);
      if (task?.state === 'failed') throw Error('Local repair failed');
      return task?.state === 'succeeded' ? task : undefined;
    }, 30_000);
    report.localState = localDone.state;
    report.stage = 'restart';
    await panel.screenshot({path: path.join(userData, 'desktop-result.png')});
    await app.close();
    session = await launch();
    await session.panel.evaluate(() => window.desktop.invoke('admin.open', {page: 'tasks'}));
    const reopenedAdmin = await pageFor(session.app, 'admin');
    const reopened = await snapshot(reopenedAdmin);
    assert.equal(reopened.tasks.find(item => item.taskId === source.taskId)?.state, 'succeeded');
    assert.equal(reopened.tasks.find(item => item.taskId === repair.taskId)?.state, 'succeeded');
    await session.app.close();
    session = undefined;
    const {createRuntimeApplication} = await import('@personal-agent/runtime/application');
    const {currentNodes} = await import('@personal-agent/goals');
    const readback = createRuntimeApplication({path: path.join(userData, 'runtime.sqlite'),
      profile: 'huawei_ict_agentarts'});
    try {
      const graph = readback.runtime.bindCoordinationStore('mvp-synthetic-meeting').read();
      const nodes = new Map(currentNodes(graph).map(node => [node.id, node]));
      assert.equal(graph.revision, 9);
      assert.equal(nodes.get('attend')?.summary, 'Attend meeting at 17:00');
      assert.equal(nodes.get('prepare')?.summary, 'Prepare one hour before 17:00 meeting');
      assert.equal(nodes.get('preparation')?.summary, 'Prepare at 16:00');
      assert.equal(nodes.get('unrelated')?.summary, 'Unrelated plan remains at 18:00');
      assert.equal(nodes.get('unrelated')?.revision, 1);
      const sourceRecord = readback.runtime.readToolExecutions(source.taskId);
      const localRecord = readback.runtime.readToolExecutions(repair.taskId);
      assert.equal(sourceRecord.length, 1);
      assert.equal(sourceRecord[0].state, 'confirmed');
      assert.equal(localRecord.length, 1);
      assert.equal(localRecord[0].toolName, 'cognition.commit_repair');
      assert.equal(localRecord[0].state, 'confirmed');
      assert.equal(readback.runtime.getApproval(localApproval.approvalId).state, 'allowed');
      report.graphRevision = graph.revision;
      report.graphReadback = true;
      report.executionEvidenceReadback = true;
    } finally { readback.close(); }
    report.restartReadback = true;
    report.outcome = 'passed';
  } catch (error) {
    report.outcome = 'failed';
    report.errorCode = error?.code ?? 'E2E_FAILURE';
    if (report.stage === 'launch') report.launchError = error?.message?.slice(0, 250);
    if (session) {
      report.fetchInfo = await session.app.evaluate(() => globalThis.__mvpFetchInfo ?? []).catch(() => []);
    }
    process.exitCode = 1;
  } finally {
    if (session) await session.app.close().catch(() => {});
    report.finishedAt = new Date().toISOString();
    fs.writeFileSync(path.join(userData, 'receipt.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify({...report, userData: path.basename(userData)}, null, 2));
  }
})().catch(error => { console.error(error.message); process.exitCode = 1; });
