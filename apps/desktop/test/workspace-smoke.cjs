const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const {_electron} = require('playwright');

(async () => {
  const project=path.resolve(__dirname,'..');
  const output=path.join(project,'.cache/qa-workspace');fs.mkdirSync(output,{recursive:true});
  const executablePath=fs.existsSync(path.join(project,'node_modules/electron/dist/electron.exe'))?path.join(project,'node_modules/electron/dist/electron.exe'):path.resolve(project,'../../node_modules/electron/dist/electron.exe');
  const app=await _electron.launch({executablePath,args:[project,'--fake-runtime'],env:{...process.env,ELECTRON_RUN_AS_NODE:undefined,PA_DESKTOP_EPHEMERAL_MODEL:'1'}});
  const errors=[];app.on('window', page=>page.on('pageerror', error=>errors.push(error.message)));
  try {
    await app.firstWindow();
    await app.evaluate(async ({BrowserWindow})=>{const win=BrowserWindow.getAllWindows().find(w=>w.webContents.getURL().includes('mode=orb'));await win.webContents.executeJavaScript("window.desktop.invoke('orb.open')");});
    const panel=app.windows().find(w=>w.url().includes('mode=panel'));await panel.waitForSelector('#panel-expand');
    await panel.locator('textarea').fill('从小面板继续');await panel.locator('textarea').focus();
    assert.equal(await panel.locator('textarea').evaluate(e=>getComputedStyle(e).outlineStyle),'none');
    const opened=app.waitForEvent('window');await panel.locator('#panel-expand').click();const workspace=await opened;
    await workspace.waitForSelector('#workspace-input');
    assert.equal(await workspace.locator('#workspace-input').inputValue(),'从小面板继续');
    const bounds=await app.evaluate(({BrowserWindow,screen})=>{const w=BrowserWindow.getAllWindows().find(w=>w.webContents.getURL().includes('mode=workspace'));return {bounds:w.getBounds(),area:screen.getDisplayMatching(w.getBounds()).workArea,panelVisible:BrowserWindow.getAllWindows().find(w=>w.webContents.getURL().includes('mode=panel')).isVisible()};});
    assert.equal(bounds.panelVisible,false);
    assert.ok(Math.abs(bounds.bounds.x+bounds.bounds.width/2-(bounds.area.x+bounds.area.width/2))<=1);
    assert.ok(Math.abs(bounds.bounds.y+bounds.bounds.height/2-(bounds.area.y+bounds.area.height/2))<=1);
    await workspace.locator('#workspace-orb').click();assert.equal(await workspace.locator('#workspace-orb').getAttribute('aria-pressed'),'true');
    await workspace.locator('#workspace-orb').click();
    const adminOpened=app.waitForEvent('window');await workspace.locator('[data-open-settings="settings"]').click();const admin=await adminOpened;
    await admin.waitForSelector('[data-page="appearance"]');await admin.locator('[data-page="appearance"]').click();
    assert.equal(await admin.locator('#pref-theme').inputValue(),'system');
    for(const theme of ['dark','light']) {
      await admin.locator('#pref-theme').selectOption(theme);
      await workspace.waitForFunction(t=>document.documentElement.dataset.theme===t,theme);
      const floating=app.windows().find(w=>w.url().includes('mode=orb'));
      await floating.waitForFunction(t=>document.documentElement.dataset.theme===t,theme);
      assert.equal(await floating.locator('canvas').evaluate(e=>getComputedStyle(e).filter),'none');
      assert.equal(await workspace.locator('canvas').evaluate(e=>getComputedStyle(e).filter),theme==='light'?'invert(1)':'none');
      await workspace.screenshot({path:path.join(output,`workspace-${theme}.png`)});
      await admin.locator('[data-page="tasks"]').click();
      const colors=await admin.locator('th').first().evaluate(e=>({actual:getComputedStyle(e).backgroundColor,expected:getComputedStyle(document.documentElement).getPropertyValue('--surface-2').trim()}));
      assert.ok(colors.actual.includes(theme==='light'?'240':'34'),JSON.stringify(colors));
      await admin.screenshot({path:path.join(output,`tasks-${theme}.png`)});
      await admin.locator('[data-page="profile"]').click();await admin.waitForSelector('.profile-identity');
      await admin.screenshot({path:path.join(output,`profile-${theme}.png`)});
      await admin.locator('[data-page="appearance"]').click();
    }
    await admin.locator('[data-page="profile"]').click();await admin.locator('#profile-edit').click();
    await admin.locator('#profile-name-input').fill('测试用户');await admin.locator('#profile-form button[type="submit"]').click();
    assert.equal(await admin.locator('#profile-name').innerText(),'测试用户');
    await admin.locator('[data-page="appearance"]').click();await admin.locator('#pref-theme').selectOption('system');
    const expected=await admin.evaluate(()=>matchMedia('(prefers-color-scheme: dark)').matches?'dark':'light');
    assert.equal(await admin.evaluate(()=>document.documentElement.dataset.theme),expected);
    await admin.close();
    await workspace.locator('#workspace-send').click();await workspace.waitForSelector('[data-cancel]');
    assert.equal(await workspace.locator('.user-message').innerText(),'从小面板继续');
    await workspace.locator('[data-cancel]').click();
    await workspace.waitForFunction(()=>document.querySelector('[data-cancel]')?.textContent==='正在停止');
    assert.deepEqual(errors,[]);
    console.log('PASS: centered workspace, panel draft transfer, orb click, light/dark/system themes, neutral input focus, profile editing, task submit/cancel; screenshots: '+output);
  } finally {await app.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
