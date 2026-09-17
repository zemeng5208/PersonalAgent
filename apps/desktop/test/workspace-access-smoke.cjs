const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {_electron} = require('playwright');

const desktopDir = path.resolve(__dirname, '..');
// Resolve the physical Electron package rather than assuming every worktree
// has downloaded its own binary.  The module resolver can safely reuse the
// locked root installation without making the candidate depend on a junction.
const electronDir = path.dirname(require.resolve('electron/package.json'));
const executablePath = fs.realpathSync(path.join(electronDir, 'dist/electron.exe'));

function waitFor(predicate, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const poll = () => {
      if (predicate()) return resolve();
      if (Date.now() >= deadline) return reject(Error('Timed out waiting for Desktop window'));
      setTimeout(poll, 25);
    };
    poll();
  });
}

async function pageFor(app, mode) {
  await waitFor(() => app.windows().some(page => page.url().includes(`mode=${mode}`)));
  return app.windows().find(page => page.url().includes(`mode=${mode}`));
}

(async () => {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'personal-agent-workspace-access-smoke-'));
  const diagnostics = [];
  let desktop;
  try {
    desktop = await _electron.launch({
      executablePath,
      args: [desktopDir],
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: undefined,
        PA_RUNTIME_PROFILE: 'huawei_ict_agentarts',
        PA_AGENTARTS_AUTHORIZATION: 'local-smoke-placeholder',
        PA_AGENTARTS_GATEWAY_URL: 'https://example.invalid',
        PA_AGENTARTS_RUNTIME_NAME: 'desktop-workspace-access-smoke',
        PA_DESKTOP_TEST_USER_DATA: userData,
      },
    });
    desktop.on('window', page => {
      page.on('pageerror', error => diagnostics.push(`pageerror:${error.message}`));
      page.on('console', message => {
        if (message.type() === 'error') diagnostics.push(`console:${message.text()}`);
      });
    });
    const panel = await pageFor(desktop, 'panel');
    const open = await panel.evaluate(() => window.desktop.invoke('admin.open', {page: 'worktrees'}));
    assert.equal(open.ok, true);
    const admin = await pageFor(desktop, 'admin');
    await admin.waitForSelector('#workspace-root-select');
    assert.match(await admin.locator('#content').innerText(), /可信工作区根/u);
    assert.match(await admin.locator('#content').innerText(), /未授权/u);
    assert.equal(await admin.locator('#workspace-root-select').isEnabled(), true);

    const snapshot = await admin.evaluate(() => window.desktop.invoke('snapshot'));
    assert.equal(snapshot.ok, true);
    assert.deepEqual(snapshot.value.workspaceAccess, {
      configured: false,
      label: '',
      status: 'unavailable',
      revision: 0,
      pendingRuntimeRefresh: false,
      available: true,
    });
    const capabilities = await admin.evaluate(() => window.desktop.invoke('capability.list'));
    assert.equal(capabilities.ok, true);
    assert.deepEqual(capabilities.value, {manifests: [], health: []});

    const injected = await admin.evaluate(rootPath => (
      window.desktop.invoke('workspace.root.select', {rootPath})
    ), userData);
    assert.equal(injected.ok, false);
    assert.match(injected.error, /只能由主进程原生目录选择器提供/u);
    assert.deepEqual(diagnostics, []);
    console.log('desktop workspace access smoke: pass');
  } finally {
    await desktop?.close().catch(() => {});
    fs.rmSync(userData, {recursive: true, force: true});
  }
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
