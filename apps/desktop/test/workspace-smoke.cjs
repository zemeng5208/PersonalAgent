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
  async function captureNative(mode,file){
    const wasOnTop=await app.evaluate(({BrowserWindow},mode)=>{const win=BrowserWindow.getAllWindows().find(w=>w.webContents.getURL().includes(`mode=${mode}`));const previous=win.isAlwaysOnTop();win.setAlwaysOnTop(true);win.show();win.moveTop();win.focus();return previous;},mode);
    await new Promise(resolve=>setTimeout(resolve,200));
    const png=await app.evaluate(async({BrowserWindow,desktopCapturer,screen},mode)=>{
      const win=BrowserWindow.getAllWindows().find(w=>w.webContents.getURL().includes(`mode=${mode}`));
      const bounds=win.getBounds(),display=screen.getDisplayMatching(bounds);
      const sources=await desktopCapturer.getSources({types:['screen'],thumbnailSize:{width:Math.round(display.size.width*display.scaleFactor),height:Math.round(display.size.height*display.scaleFactor)}});
      const source=sources.find(s=>s.display_id===String(display.id));
      if(!source)throw Error('Display capture unavailable');
      const factor=source.thumbnail.getSize().width/display.size.width;
      return source.thumbnail.crop({x:Math.round((bounds.x-display.bounds.x)*factor),y:Math.round((bounds.y-display.bounds.y)*factor),width:Math.round(bounds.width*factor),height:Math.round(bounds.height*factor)}).toPNG().toString('base64');
    },mode);
    fs.writeFileSync(path.join(output,file),Buffer.from(png,'base64'));
    await app.evaluate(({BrowserWindow},{mode,wasOnTop})=>BrowserWindow.getAllWindows().find(w=>w.webContents.getURL().includes(`mode=${mode}`)).setAlwaysOnTop(wasOnTop),{mode,wasOnTop});
  }
  try {
    await app.firstWindow();
    await app.evaluate(async ({BrowserWindow})=>{const win=BrowserWindow.getAllWindows().find(w=>w.webContents.getURL().includes('mode=orb'));await win.webContents.executeJavaScript("window.desktop.invoke('orb.open')");});
    const panel=app.windows().find(w=>w.url().includes('mode=panel'));await panel.waitForSelector('#panel-expand');
    await panel.locator('textarea').fill('从小面板继续');await panel.locator('textarea').focus();
    assert.equal(await panel.locator('textarea').evaluate(e=>getComputedStyle(e).outlineStyle),'none');
    const opened=app.waitForEvent('window');await panel.locator('#panel-expand').click();const workspace=await opened;
    await workspace.waitForSelector('#workspace-input');
    assert.equal(await workspace.locator('#workspace-input').inputValue(),'');
    assert.equal(await panel.locator('textarea').inputValue(),'从小面板继续');
    assert.equal(await workspace.locator('.workspace-sidebar').count(),0);
    assert.equal(await workspace.locator('[data-connector]').count(),5);
    assert.ok((await workspace.locator('.connector-card').first().innerText()).includes('预览'));
    await workspace.locator('#workspace-input').fill('大工作区独立对话');
    const bounds=await app.evaluate(({BrowserWindow,screen})=>{const w=BrowserWindow.getAllWindows().find(w=>w.webContents.getURL().includes('mode=workspace'));return {bounds:w.getBounds(),area:screen.getDisplayMatching(w.getBounds()).workArea,panelVisible:BrowserWindow.getAllWindows().find(w=>w.webContents.getURL().includes('mode=panel')).isVisible()};});
    assert.equal(bounds.panelVisible,false);
    assert.ok(Math.abs(bounds.bounds.x+bounds.bounds.width/2-(bounds.area.x+bounds.area.width/2))<=1);
    assert.ok(Math.abs(bounds.bounds.y+bounds.bounds.height/2-(bounds.area.y+bounds.area.height/2))<=1);
    await workspace.locator('#workspace-orb').click();assert.equal(await workspace.locator('#workspace-orb').getAttribute('aria-pressed'),'true');
    await workspace.waitForFunction(()=>document.querySelector('#workspace-orb').getAttribute('aria-pressed')==='false');
    const adminOpened=app.waitForEvent('window');await workspace.locator('[data-open-settings="settings"]').click();const admin=await adminOpened;
    await admin.waitForSelector('[data-page="appearance"]');
    for(const removed of ['import','tasks','browser','account','usage'])assert.equal(await admin.locator(`.side [data-page="${removed}"]`).count(),0);
    await admin.locator('[data-page="appearance"]').click();
    assert.equal(await admin.locator('#pref-theme').inputValue(),'system');
    for(const theme of ['dark','light']) {
      await admin.locator('#pref-theme').selectOption(theme);
      await workspace.waitForFunction(t=>document.documentElement.dataset.theme===t,theme);
      const floating=app.windows().find(w=>w.url().includes('mode=orb'));
      await floating.waitForFunction(t=>document.documentElement.dataset.theme===t,theme);
      assert.equal(await floating.locator('canvas').evaluate(e=>getComputedStyle(e).filter),'none');
      assert.equal(await workspace.locator('canvas').evaluate(e=>getComputedStyle(e).filter),theme==='light'?'invert(1)':'none');
      assert.equal(await workspace.locator('.workspace').evaluate(e=>getComputedStyle(e).backgroundColor),theme==='light'?'rgb(250, 250, 250)':'rgb(16, 16, 16)');
      assert.equal(await admin.locator('.admin').evaluate(e=>getComputedStyle(e).backgroundColor),theme==='light'?'rgb(250, 250, 250)':'rgb(16, 16, 16)');
      await workspace.screenshot({path:path.join(output,`workspace-${theme}.png`)});
      if(theme==='light')await captureNative('workspace','native-workspace.png');
      await admin.locator('[data-page="capabilities"]').click();
      const colors=await admin.locator('th').first().evaluate(e=>({actual:getComputedStyle(e).backgroundColor,expected:getComputedStyle(document.documentElement).getPropertyValue('--surface-2').trim()}));
      assert.ok(colors.actual.includes(theme==='light'?'240':'34'),JSON.stringify(colors));
      await admin.screenshot({path:path.join(output,`tasks-${theme}.png`)});
      await admin.locator('[data-page="profile"]').click();await admin.waitForSelector('.profile-identity');
      await admin.screenshot({path:path.join(output,`profile-${theme}.png`)});
      if(theme==='light')await captureNative('admin','native-settings.png');
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
    assert.equal(await workspace.locator('.user-message').innerText(),'大工作区独立对话');
    const bigTask=(await workspace.evaluate(()=>window.desktop.invoke('snapshot'))).value.tasks[0];
    assert.equal((await panel.evaluate(()=>window.desktop.invoke('snapshot'))).value.tasks.length,0);
    const denied=await panel.evaluate(id=>window.desktop.invoke('task.cancel',id),bigTask.taskId);assert.equal(denied.ok,false);
    await workspace.locator('[data-cancel]').click();
    await workspace.waitForFunction(()=>document.querySelector('[data-cancel]')?.textContent==='正在停止');
    await workspace.evaluate(async()=>{const r=await window.desktop.invoke('snapshot');await window.desktop.invoke('test.advance',r.value.tasks[0].taskId);});
    for(let index=0;index<8;index++){
      await workspace.locator('#workspace-input').fill('大工作区第 '+(index+2)+' 轮：回顾项目进展与下一步安排');
      await workspace.locator('#workspace-send').click();
      await workspace.waitForSelector('[data-cancel]');
      await workspace.evaluate(async()=>{const r=await window.desktop.invoke('snapshot');for(let step=0;step<4;step++)await window.desktop.invoke('test.advance',r.value.tasks.at(-1).taskId);});
    }
    await workspace.waitForFunction(()=>document.querySelectorAll('.conversation-rail button').length===9);
    await workspace.locator('.conversation-rail button').first().click();
    await workspace.waitForFunction(()=>document.querySelector('#workspace-stage').scrollTop<150);
    await workspace.locator('[data-view]').first().click();
    assert.equal(await workspace.locator('#conversation-inspector').isVisible(),true);
    assert.ok((await workspace.locator('#inspector-content').innerText()).includes('大工作区独立对话'));
    await workspace.screenshot({path:path.join(output,'workspace-detail.png')});
    await workspace.locator('#inspector-close').click();
    const floating=app.windows().find(w=>w.url().includes('mode=orb'));
    await floating.evaluate(()=>window.desktop.invoke('orb.open'));
    await panel.locator('#send').click();
    await panel.waitForSelector('[data-action="task.cancel"]');
    assert.equal((await workspace.evaluate(()=>window.desktop.invoke('snapshot'))).value.tasks.length,9);
    await panel.evaluate(async()=>{const r=await window.desktop.invoke('snapshot');for(let step=0;step<4;step++)await window.desktop.invoke('test.advance',r.value.tasks[0].taskId);});
    await panel.locator('textarea').fill('小窗口的第二轮');await panel.locator('#send').click();
    await panel.waitForFunction(()=>document.querySelectorAll('[data-turn]').length===2);
    assert.equal(await panel.locator('.thread').evaluate(e=>getComputedStyle(e).scrollbarWidth),'none');
    await panel.screenshot({path:path.join(output,'panel-light.png')});
    await captureNative('panel','native-panel.png');
    assert.deepEqual(errors,[]);
    console.log('PASS: separate conversations and drafts, opaque shared themes, connector previews, click burst, internal message inspector, message rails, task isolation/cancel; screenshots: '+output);
  } finally {await app.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
