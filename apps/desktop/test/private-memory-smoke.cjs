const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {_electron} = require('playwright');

(async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'personal-agent-private-ui-'));
  const vault = path.join(base, 'vault');
  const data = path.join(base, 'user-data');
  fs.mkdirSync(vault);
  fs.mkdirSync(data);
  fs.writeFileSync(path.join(vault, 'note.md'), '合成偏好：周一查看计划。\n');
  const executablePath = path.resolve(__dirname, '../../../node_modules/electron/dist/electron.exe');
  let app;
  try {
    app = await _electron.launch({executablePath, args: [path.resolve(__dirname, '..')], env: {
      ...process.env, ELECTRON_RUN_AS_NODE: undefined,
      PA_RUNTIME_PROFILE: 'huawei_ict_agentarts',
      PA_AGENTARTS_AUTHORIZATION: 'Bearer synthetic-only',
      PA_AGENTARTS_GATEWAY_URL: 'https://synthetic.huaweicloud-agentarts.com',
      PA_AGENTARTS_RUNTIME_NAME: 'synthetic-only',
      PA_DESKTOP_TEST_USER_DATA: data,
      PA_DESKTOP_TEST_VAULT: vault,
      PA_DESKTOP_SYNTHETIC_MVP: '0',
    }});
    await app.firstWindow();
    const orb = app.windows().find(page => page.url().includes('mode=orb'));
    await orb.evaluate(() => window.desktop.invoke('orb.open'));
    const panel = app.windows().find(page => page.url().includes('mode=panel'));
    await panel.waitForSelector('#admin');
    const existingAdmin = app.windows().find(page => page.url().includes('mode=admin'));
    const opening = existingAdmin ? null : app.waitForEvent('window');
    await panel.evaluate(() => window.desktop.invoke('admin.open', {page: 'memory'}));
    const admin = existingAdmin ?? await opening;
    await admin.waitForSelector('#memory-select-vault', {timeout: 5000}).catch(async error => {
      const status = await admin.locator('#connection').innerText();
      const page = await admin.locator('#content').innerText();
      throw Error(`${error.message.split('\n')[0]}: ${status}; ${page.slice(0, 180)}`);
    });
    await app.evaluate(({dialog}) => {
      dialog.showOpenDialog = async () => ({canceled: false, filePaths: [process.env.PA_DESKTOP_TEST_VAULT]});
      dialog.showMessageBox = async () => ({response: 1});
    });
    await admin.locator('#memory-select-vault').click();
    await admin.locator('#memory-query').fill('合成偏好');
    await admin.locator('#memory-search-form button').click();
    await admin.waitForSelector('[data-memory-save="0"]');
    assert.equal(await admin.locator('[data-memory-save="0"]').isDisabled(), true);
    const blocked = await admin.evaluate(() => window.desktop.invoke('memory.save',
      {source: {}, summary: '不应写入'}));
    assert.equal(blocked.ok, false);
    assert.match(blocked.error, /完整删除保障/);
    assert.equal(fs.existsSync(path.join(data, 'private-memory.sqlite')), false);
    await app.evaluate(() => { process.env.PA_DESKTOP_PRIVATE_MEMORY_FIXTURE_ROOT = process.env.PA_DESKTOP_TEST_VAULT; });
    await admin.locator('#memory-select-vault').click();
    await admin.locator('#memory-query').fill('合成偏好');
    await admin.locator('#memory-search-form button').click();
    await admin.waitForSelector('[data-memory-save="0"]');
    assert.equal(await admin.locator('[data-memory-save="0"]').isDisabled(), false);
    await admin.locator('[data-memory-summary="0"]').fill('周一查看计划');
    await admin.locator('[data-memory-save="0"]').click();
    await admin.waitForFunction(() => document.querySelector('[role="status"]')?.textContent.includes('未写入记忆'));
    const {openSqliteMemoryHost} = await import('@personal-agent/memory/sqlite');
    const database = path.join(data, 'private-memory.sqlite');
    const read = async () => {
      const memory = openSqliteMemoryHost(database);
      try {
        return (await memory.bind('desktop-private', {allowedSensitivities: ['private']})
          .listCurrent({at: new Date().toISOString(), limit: 5,
            deadline: new Date(Date.now() + 60_000).toISOString(),
            signal: new AbortController().signal})).facts;
      } finally { memory.close(); }
    };
    assert.equal((await read()).length, 0);
    await app.evaluate(({dialog}) => { dialog.showMessageBox = async () => ({response: 0}); });
    await admin.locator('[data-memory-save="0"]').click();
    await admin.waitForFunction(() => document.querySelector('[role="status"]')?.textContent.includes('版本 1'));
    assert.equal((await read())[0].summary, '周一查看计划');
    await admin.locator('[data-memory-summary="0"]').fill('周一先查看计划');
    await admin.locator('[data-memory-save="0"]').click();
    await admin.waitForFunction(() => document.querySelector('[role="status"]')?.textContent.includes('版本 2'));
    assert.equal((await read())[0].ref.revision, 2);
    console.log('PASS: Competition admin confirms one synthetic private citation and correction without submitting a cloud task');
  } finally {
    if (app) await app.close();
    const relation = path.relative(os.tmpdir(), base);
    if (!relation || relation.startsWith('..') || path.isAbsolute(relation)) {
      throw Error('Refusing to remove a path outside the test temp directory');
    }
    fs.rmSync(base, {recursive: true, force: true});
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
