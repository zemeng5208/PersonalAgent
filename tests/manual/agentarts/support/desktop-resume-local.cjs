const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {_electron} = require('playwright');

// Resume only an isolated synthetic Desktop acceptance after the cloud source
// task already succeeded. It makes no new AgentArts request.
const root = path.resolve(__dirname, '../../../..');
const name = process.env.PA_DESKTOP_RESUME_DIR;
if (process.env.PA_DESKTOP_RESUME_LOCAL !== '1'
  || !/^desktop-agentarts-[A-Za-z0-9]+$/.test(name ?? '')
  || !process.env.PA_AGENTARTS_AUTHORIZATION) throw Error('Explicit local resume required');
const userData = path.join(root, '.cache', name);
if (fs.realpathSync.native(userData).toLowerCase() !== path.resolve(userData).toLowerCase())
  throw Error('Synthetic data path is redirected');
const previous = JSON.parse(fs.readFileSync(path.join(userData, 'receipt.json'), 'utf8'));
for (const id of [previous.sourceTaskId, previous.localTaskId])
  if (typeof id !== 'string' || !/^[0-9a-f-]{36}$/.test(id)) throw Error('Invalid task receipt');
const report = {profile: 'huawei_ict_agentarts', dataClass: 'synthetic',
  resumedAt: new Date().toISOString(), sourceTaskId: previous.sourceTaskId,
  localTaskId: previous.localTaskId, cloudRequests: 0};

async function waitUntil(check, timeoutMs = 15_000) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    const value = await check();
    if (value) return value;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw Error('Desktop local resume timed out');
}
async function launch() {
  const app = await _electron.launch({
    executablePath: path.join(root, 'node_modules/electron/dist/electron.exe'),
    args: [path.join(root, 'apps/desktop')],
    env: {...process.env, ELECTRON_RUN_AS_NODE: undefined,
      PA_RUNTIME_PROFILE: 'huawei_ict_agentarts', PA_DESKTOP_SYNTHETIC_MVP: '1',
      PA_AGENTARTS_RESPONSE_MODE: 'tool-proposal-json',
      PA_AGENTARTS_REPAIR_CANDIDATE_VERSION: '1.0', PA_DESKTOP_TEST_USER_DATA: userData,
      PA_DESKTOP_MODEL_MODE: undefined},
  });
  await app.firstWindow();
  const orb = await waitUntil(() => app.windows().find(page => page.url().includes('mode=orb')));
  await orb.evaluate(() => window.desktop.invoke('orb.open'));
  const panel = await waitUntil(() => app.windows().find(page => page.url().includes('mode=panel')));
  await panel.waitForSelector('#send');
  await panel.evaluate(() => window.desktop.invoke('admin.open', {page: 'authorizations'}));
  const admin = await waitUntil(() => app.windows().find(page => page.url().includes('mode=admin')));
  return {app, panel, admin};
}
async function snapshot(admin) {
  return (await admin.evaluate(() => window.desktop.invoke('snapshot'))).value;
}

(async () => {
  let session;
  try {
    session = await launch();
    await session.app.evaluate(() => {
      const originalFetch = globalThis.fetch;
      globalThis.__mvpCloudAttempts = 0;
      globalThis.fetch = (...args) => {
        globalThis.__mvpCloudAttempts++;
        return originalFetch(...args);
      };
    });
    const before = await snapshot(session.admin);
    assert.equal(before.tasks.find(item => item.taskId === previous.sourceTaskId)?.state, 'succeeded');
    assert.equal(before.tasks.find(item => item.taskId === previous.localTaskId)?.state, 'waiting_approval');
    const approval = before.approvals.find(item => item.taskId === previous.localTaskId
      && item.state === 'pending');
    assert.equal(approval?.action, 'cognition.commit_repair');
    await session.admin.locator(`[data-approval="allow_once"][data-id="${approval.approvalId}"]`).click();
    await waitUntil(async () => {
      const task = (await snapshot(session.admin)).tasks.find(item => item.taskId === previous.localTaskId);
      if (task?.state === 'failed') throw Error('Local repair failed');
      return task?.state === 'succeeded';
    }, 30_000);
    report.localState = 'succeeded';
    report.cloudRequests += await session.app.evaluate(() => globalThis.__mvpCloudAttempts);
    await session.panel.screenshot({path: path.join(userData, 'desktop-result.png')});
    await session.app.close();
    session = await launch();
    const after = await snapshot(session.admin);
    assert.equal(after.tasks.find(item => item.taskId === previous.sourceTaskId)?.state, 'succeeded');
    assert.equal(after.tasks.find(item => item.taskId === previous.localTaskId)?.state, 'succeeded');
    report.restartTaskReadback = true;
    await session.app.close(); session = undefined;

    const {createRuntimeApplication} = await import('@personal-agent/runtime/application');
    const {currentNodes} = await import('@personal-agent/goals');
    const reader = createRuntimeApplication({path: path.join(userData, 'runtime.sqlite'),
      profile: 'huawei_ict_agentarts'});
    try {
      const graph = reader.runtime.bindCoordinationStore('mvp-synthetic-meeting').read();
      const nodes = new Map(currentNodes(graph).map(node => [node.id, node]));
      assert.equal(graph.revision, 9);
      assert.equal(nodes.get('attend')?.summary, 'Attend meeting at 17:00');
      assert.equal(nodes.get('prepare')?.summary, 'Prepare one hour before 17:00 meeting');
      assert.equal(nodes.get('preparation')?.summary, 'Prepare at 16:00');
      assert.equal(nodes.get('unrelated')?.summary, 'Unrelated plan remains at 18:00');
      assert.equal(nodes.get('unrelated')?.revision, 1);
      const sourceRecord = reader.runtime.readToolExecutions(previous.sourceTaskId);
      const localRecord = reader.runtime.readToolExecutions(previous.localTaskId);
      assert.equal(sourceRecord.length, 1);
      assert.equal(sourceRecord[0].state, 'confirmed');
      assert.equal(localRecord.length, 1);
      assert.equal(localRecord[0].toolName, 'cognition.commit_repair');
      assert.equal(localRecord[0].state, 'confirmed');
      assert.equal(reader.runtime.getApproval(approval.approvalId).state, 'allowed');
      report.graphRevision = graph.revision;
      report.graphReadback = true;
      report.executionEvidenceReadback = true;
    } finally { reader.close(); }
    assert.equal(report.cloudRequests, 0);
    report.outcome = 'passed';
  } catch (error) {
    report.outcome = 'failed';
    report.errorCode = error?.code ?? 'LOCAL_RESUME_FAILURE';
    process.exitCode = 1;
  } finally {
    if (session) await session.app.close().catch(() => {});
    report.finishedAt = new Date().toISOString();
    fs.writeFileSync(path.join(userData, 'local-resume-receipt.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report, null, 2));
  }
})().catch(error => { console.error(error.message); process.exitCode = 1; });
