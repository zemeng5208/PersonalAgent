// Public synthetic layout fixture. Run locally after installing workspace dependencies:
// node apps/desktop/fixtures/ui/compact-panel.cjs
// This exercises CSS/DOM only, never Electron, credentials, IPC or a provider.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { chromium } = require('playwright');
const desktop = path.resolve(__dirname, '../..');
const read = file => fs.readFileSync(path.join(desktop, file), 'utf8');
const panel = read('src/app/renderer.js').match(/root.innerHTML=`(<section class="panel">[\s\S]*?)`;/)?.[1];
assert.ok(panel, 'Update the fixture extraction when the shared Renderer template changes');
const styles = ['src/ui/tokens.css', 'src/app/style.css', 'src/app/surfaces.css'].map(read).join('\n');

(async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    for (const width of [320, 420]) {
      for (const height of [360, 480]) {
        await page.setViewportSize({ width, height });
        await page.setContent(`<html lang="zh-CN"><head><title>PersonalAgent</title><style>${styles}</style></head><body>${panel}</body></html>`);
        await page.evaluate(() => {
          document.querySelector('#model-label').textContent = '合成模型名称'.repeat(30);
          document.querySelector('#mm-model-label').textContent = 'PublicSyntheticModel'.repeat(40);
          document.querySelector('.mic-state').textContent = '公开合成状态。'.repeat(4);
          const goal = document.createElement('button');
          goal.className = 'goal-open'; goal.textContent = '目标';
          document.querySelector('.composer-bar .spacer').before(goal);
          document.querySelector('#send').dataset.mode = 'live';
          document.querySelector('#tasks').innerHTML = '<div class="assistant-message">' + '公开合成长文。'.repeat(250) + '</div><div class="approval-card"><p>合成审批内容</p><button class="turn-action">允许一次</button></div>';
          document.querySelector('#model').onclick = () => { document.querySelector('#model-menu').hidden = false; };
        });
        await page.fill('textarea', '公开合成输入。'.repeat(100));
        await page.click('#model');
        const layout = await page.evaluate(() => {
          const rect = selector => {
            const r = document.querySelector(selector).getBoundingClientRect();
            return { x: r.x, y: r.y, right: r.right, bottom: r.bottom };
          };
          const menu = document.querySelector('#model-menu');
          menu.scrollTop = menu.scrollHeight;
          const thread = document.querySelector('.thread');
          thread.scrollTop = thread.scrollHeight;
          const threadDown = thread.scrollTop > 0;
          thread.scrollTop = 0;
          const input = document.querySelector('textarea');
          input.scrollTop = input.scrollHeight;
          return {
            menu: rect('#model-menu'),
            menuOverflow: menu.scrollWidth > menu.clientWidth + 1,
            menuDown: menu.scrollTop > 0,
            inputDown: input.scrollTop > 0,
            threadDown, threadUp: thread.scrollTop === 0,
          };
        });
        assert.ok(layout.menu.x >= 0 && layout.menu.right <= width, 'Menu must fit panel width');
        assert.ok(layout.menu.y >= 0 && layout.menu.bottom <= height, 'Menu must fit panel height');
        assert.equal(layout.menuOverflow, false, 'Long model name must wrap inside menu');
        assert.ok(layout.menuDown && layout.inputDown && layout.threadDown && layout.threadUp, 'Long menu, input and conversation must scroll');
        await page.evaluate(() => { document.querySelector('#model-menu').hidden = true; });
        for (const selector of ['#talk', '#send', '#model', '#stop', '#admin']) {
          const box = await page.locator(selector).boundingBox();
          assert.ok(box && box.x >= 0 && box.y >= 0 && box.x + box.width <= width && box.y + box.height <= height, `${selector} must remain inside panel`);
        }
        console.log(`PASS synthetic CSS layout ${width}x${height}`);
      }
    }
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
