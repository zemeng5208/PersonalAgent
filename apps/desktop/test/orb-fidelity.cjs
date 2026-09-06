const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {chromium} = require(path.join(process.env.USERPROFILE, '.npm-global/node_modules/playwright'));

(async () => {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({viewport: {width: 160, height: 160}});
    await page.setContent('<style>html,body{margin:0;background:#e8e8e4}canvas{display:block;width:132px;height:132px;margin:14px}</style><canvas></canvas>');
    const source = fs.readFileSync(path.resolve(__dirname, '../src/features/orb/orb.js'), 'utf8')
      .replace('export class Orb', 'window.ProductOrb = class Orb');
    await page.addScriptTag({content: `(()=>{${source}})();`});

    const result = await page.evaluate(() => {
      const orb = new ProductOrb(document.querySelector('canvas'), {variant: 'matrix', layout: 'shell', count: 170});
      orb.stop();
      const sample = (state, time) => {
        orb.setState(state);
        orb.mix = 1;
        orb.time = time;
        const dots = [];
        const drawDot = orb._dot;
        orb._dot = (_ctx, _x, _y, _r, color, alpha) => dots.push({color, alpha});
        orb._draw();
        orb._dot = drawDot;
        return dots;
      };

      const bright = sample('executing', Math.PI / (2 * 2.8));
      const shape = orb.shapeTo;
      const scale = orb.to.scale;
      const dark = sample('executing', 3 * Math.PI / (2 * 2.8));
      const point = orb.points.find(item => item.seed > 0.45 && item.seed < 0.55) ?? orb.points[0];
      orb.time = 0.7;
      orb.state = 'idle';
      const idleSpread = orb._spread(point);
      orb.state = 'executing';
      const executingSpread = orb._spread(point);

      orb.setState('error');
      orb.mix = 1;
      orb.time = 1.2;
      orb._draw();
      const pixels = orb.ctx.getImageData(0, 0, orb.canvas.width, orb.canvas.height).data;
      let whitePixels = 0;
      for (let i = 0; i < pixels.length; i += 4) {
        if (pixels[i] > 180 && pixels[i + 1] > 180 && pixels[i + 2] > 180 && pixels[i + 3] > 40) whitePixels++;
      }
      const center = ((Math.floor(orb.canvas.height / 2) * orb.canvas.width) + Math.floor(orb.canvas.width / 2)) * 4;
      const centerRgb = [pixels[center], pixels[center + 1], pixels[center + 2]];
      return {
        count: orb.points.length,
        shape,
        scale,
        brightMax: Math.max(...bright.map(dot => dot.alpha)),
        darkMax: Math.max(...dark.map(dot => dot.alpha)),
        idleSpread,
        executingSpread,
        whitePixels,
        centerRgb,
      };
    });

    assert.equal(result.count, 170);
    assert.equal(result.shape, 'sphere');
    assert.equal(result.scale, 1);
    assert.ok(result.brightMax > 0.95, `bright frame was ${result.brightMax}`);
    assert.ok(result.darkMax < 0.1, `dark frame was ${result.darkMax}`);
    assert.ok(result.executingSpread > result.idleSpread * 1.04);
    assert.ok(result.whitePixels > 20, `white horizon only had ${result.whitePixels} pixels`);
    assert.ok(result.centerRgb.every(value => value < 12), `error core was not solid black: ${result.centerRgb}`);

    const output = path.resolve(__dirname, '../.cache/qa');
    fs.mkdirSync(output, {recursive: true});
    await page.locator('canvas').screenshot({path: path.join(output, 'orb-error-horizon.png')});
    console.log('PASS: 170-point sphere, executing bright/dark diffusion, and solid-black error horizon');
  } finally {
    await browser.close();
  }
})().catch(error => {
  console.error(error);
  process.exit(1);
});
