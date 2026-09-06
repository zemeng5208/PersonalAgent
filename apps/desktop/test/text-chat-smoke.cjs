const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const {_electron} = require('playwright');

(async () => {
  const localElectron = path.resolve(__dirname, '../node_modules/electron/dist/electron.exe');
  const workspaceElectron = path.resolve(__dirname, '../../../node_modules/electron/dist/electron.exe');
  const executablePath = fs.existsSync(localElectron) ? localElectron : workspaceElectron;
  const app = await _electron.launch({
    executablePath,
    args: [path.resolve(__dirname, '..'), '--fake-model'],
    env: {...process.env, ELECTRON_RUN_AS_NODE: undefined, PA_DESKTOP_EPHEMERAL_MODEL: '1'},
  });
  const errors = [];
  try {
    await app.firstWindow();
    const orb = app.windows().find(page => page.url().includes('mode=orb'));
    assert.ok(orb, 'orb window loaded');
    orb.on('pageerror', error => errors.push(error.message));
    await orb.evaluate(() => window.desktop.invoke('orb.open'));
    const panel = app.windows().find(page => page.url().includes('mode=panel'));
    await panel.waitForSelector('textarea');
    panel.on('pageerror', error => errors.push(error.message));
    const goal = '文字交互 Smoke 测试';
    await panel.locator('textarea').fill(goal);
    await panel.locator('#send').click();
    await panel.waitForFunction(expected => document.querySelector('#tasks')?.innerText.includes(`Fake Model 回答：${expected}`), goal, {timeout: 10_000});
    const snapshot = await panel.evaluate(() => window.desktop.invoke('snapshot'));
    assert.equal(snapshot.value.fakeModel, true);
    assert.equal(snapshot.value.tasks.at(-1).state, 'succeeded');
    assert.match(snapshot.value.model.label, /Fake Model/);
    assert.deepEqual(errors, []);
    console.log('PASS: local Runtime text chat with explicit Fake Model');
  } finally {
    await app.close();
  }
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
