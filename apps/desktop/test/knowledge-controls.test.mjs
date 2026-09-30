import assert from 'node:assert/strict';
import test from 'node:test';
import {createServer} from 'node:http';
import {readFile} from 'node:fs/promises';

// Opt-in rendered test: uses the existing Desktop Playwright dependency and an installed browser.
test('knowledge controls preserve read/delivery/binding distinctions and refresh exact subscriptions',
  {skip: process.env.PA_KNOWLEDGE_UI_TEST !== '1'}, async t => {
    const {chromium} = await import('playwright');
    const moduleSource = await readFile(new URL('../src/app/knowledge-controls.js', import.meta.url), 'utf8');
    const server = createServer((req, res) => {
      res.setHeader('Content-Type', req.url === '/controls.js' ? 'text/javascript' : 'text/html; charset=utf-8');
      if (req.url === '/controls.js') { res.end(moduleSource); return; }
      res.end(`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>Knowledge controls fixture</title>
        <style>body{background:#171b25;color:#e4e8f0;font:14px system-ui;padding:24px}
        main{max-width:880px;margin:auto}.task{overflow-wrap:anywhere}.notice{color:#b4bfd2}
        button,input{font:inherit}button{padding:6px 10px;margin:2px}button:disabled{opacity:.5}
        a{color:#b9dcff}.setting-row{display:flex;justify-content:space-between;gap:10px}</style><main></main>
        <script type="module">
          import {mountKnowledgeControls} from '/controls.js';
          window.calls = [];
          const topic = {topicId:'TypeScript',state:'tracked',boundSource:{sourceId:'feed-a',revision:'v1'}};
          const item = {...topic,usableAsCurrentFact:false,answer:{kind:'latest_observation',sourceRevision:'v2',
            citation:'https://example.com/release'},binding:{ready:false,reason:'reevaluation_unconfirmed',taskState:'running'}};
          const state = {namespace:'fixture',running:true,health:{status:'ready'},watches:[topic],dialogue:{items:[item]},
            notices:[{id:'a'.repeat(64),delivered:false,summary:'公共来源更新'}]};
          const controls = mountKnowledgeControls(document.querySelector('main'), async (name,payload) => {
            window.calls.push({name,payload});
            if(name==='knowledge.watch.status')return structuredClone(state);
            if(name==='knowledge.watch.read'){state.notices[0].readAt=new Date().toISOString();return {accepted:true};}
            if(name==='knowledge.watch.pause'){topic.state='paused';item.state='paused';item.answer={kind:'withheld',reason:'user_paused'};return {state:'paused'};}
            if(name==='knowledge.watch.resume'){topic.state='tracked';item.state='tracked';item.answer={kind:'latest_observation',citation:'https://example.com/release'};return {state:'tracked'};}
            if(name==='knowledge.watch.refresh')return {accepted:true,reason:'unchanged',notified:false};
            if(name==='knowledge.watch.bind'){topic.boundSource.revision='v2';item.usableAsCurrentFact=true;item.answer={kind:'current_fact',citation:'https://example.com/release'};return {accepted:true,revision:'v2'};}
            if(name==='knowledge.watch.revoke'){topic.state='revoked';item.state='revoked';item.answer={kind:'withheld',reason:'user_revoked'};return {state:'revoked'};}
            throw Error(name);
          });
          controls.render({available:false,reason:'合成预览：知识目录未配置'},state);
          window.setBindingReady=()=>{item.binding={ready:true,reason:'reevaluation_confirmed',taskState:'succeeded'};controls.render({},state);};
          window.injectUntrusted=()=>{item.answer={kind:'withheld',reason:'<img src=x onerror="window.injected=true">',citation:'javascript:window.injected=true'};controls.render({},state);};
        </script></html>`);
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    t.after(() => new Promise(resolve => server.close(resolve)));
    const browser = await chromium.launch({headless: true,
      ...(process.env.PA_KNOWLEDGE_UI_BROWSER ? {executablePath: process.env.PA_KNOWLEDGE_UI_BROWSER} : {})});
    t.after(() => browser.close());
    const page = await browser.newPage({viewport: {width: 1100, height: 1050}});
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', message => { if (['warning', 'error'].includes(message.type())) errors.push(message.text()); });
    const url = `http://127.0.0.1:${server.address().port}`;
    await page.goto(url);
    assert.equal(await page.title(), 'Knowledge controls fixture');
    assert.equal(page.url(), `${url}/`);
    await page.getByRole('heading', {name: '知识关注与增量更新'}).waitFor();
    assert.equal(await page.locator('[data-bind-topic]').isDisabled(), true);
    await page.getByRole('button', {name:'标记已读'}).click();
    await page.getByText('系统投递未确认 · 用户已读').waitFor();
    assert.equal(await page.locator('[data-bind-topic]').isDisabled(), true);
    await page.getByRole('button', {name:'检查关注更新'}).click();
    await page.locator('[data-watch-op-status]').filter({hasText:'来源未发生改变'}).waitFor();
    assert.deepEqual(await page.evaluate(() => calls.find(call => call.name==='knowledge.watch.refresh').payload), {subscriptionId:'feed-a'});
    await page.getByRole('button', {name:'暂停关注'}).click();
    await page.getByRole('button', {name:'恢复关注'}).waitFor();
    assert.equal(await page.getByRole('button', {name:'检查关注更新'}).isDisabled(), true);
    await page.getByRole('button', {name:'恢复关注'}).click();
    await page.getByRole('button', {name:'暂停关注'}).waitFor();
    await page.evaluate(() => setBindingReady());
    await page.getByRole('button', {name:'绑定已重评的新版本'}).click();
    await page.getByText('已确认当前事实', {exact:true}).waitFor();
    if (process.env.PA_KNOWLEDGE_UI_SCREENSHOT) await page.screenshot({path:process.env.PA_KNOWLEDGE_UI_SCREENSHOT,fullPage:true});
    await page.evaluate(() => injectUntrusted());
    assert.equal(await page.locator('img').count(), 0);
    assert.equal(await page.locator('a[href^="javascript:"]').count(), 0);
    assert.equal(await page.evaluate(() => window.injected), undefined);
    await page.getByRole('button', {name:'撤销关注'}).click();
    await page.getByText('已扣留/待重评 (user_revoked)').waitFor();
    assert.equal((await page.evaluate(() => calls)).some(call => call.name==='knowledge.watch.acknowledge'), false);
    assert.deepEqual(errors, []);
    assert.equal(await page.locator('nextjs-portal, #vite-error-overlay').count(), 0);
  });
