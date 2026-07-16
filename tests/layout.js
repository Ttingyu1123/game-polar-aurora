/* Layout guard: on every aspect ratio, all three lane centres must be on
   screen at the player's depth and the HUD must not self-overlap. */
const { chromium } = require('playwright');
const path = require('path');
const ROOT = require('path').resolve(__dirname, '..');
const url = 'file:///' + path.join(ROOT, 'index.html').split(path.sep).join('/');

const SIZES = [
  { w: 360, h: 640, dpr: 3, n: 'small-phone-portrait' },
  { w: 390, h: 844, dpr: 3, n: 'iphone-portrait' },
  { w: 430, h: 932, dpr: 3, n: 'big-phone-portrait' },
  { w: 844, h: 390, dpr: 3, n: 'phone-landscape' },
  { w: 768, h: 1024, dpr: 2, n: 'tablet-portrait' },
  { w: 1280, h: 800, dpr: 1, n: 'laptop' },
  { w: 1920, h: 1080, dpr: 1, n: 'desktop-hd' },
  { w: 3440, h: 1440, dpr: 1, n: 'ultrawide' }
];

(async () => {
  const b = await chromium.launch({ headless: false, args: ['--enable-gpu-rasterization', '--ignore-gpu-blocklist'] });
  let fails = 0;
  for (const s of SIZES) {
    const ctx = await b.newContext({ viewport: { width: s.w, height: s.h }, deviceScaleFactor: s.dpr, hasTouch: true });
    const p = await ctx.newPage();
    const errs = [];
    p.on('pageerror', (e) => errs.push(e.message));
    await p.goto(url, { waitUntil: 'load' });
    await p.waitForTimeout(500);
    await p.click('#btnPlay');
    await p.waitForFunction(() => window.__game.fsm.current === 'playing', { timeout: 12000 });
    await p.waitForTimeout(400);

    const r = await p.evaluate(() => {
      const g = window.__game, cam = g.cam;
      const out = { x: 0, y: 0, s: 0, visible: false };
      // Lane centres at the player's own depth — the tightest case.
      const lanes = window.WORLD.LANES.map((lx) => {
        cam.project(lx, 0, 0, out);
        return +out.x.toFixed(1);
      });
      const margin = 8;
      const lanesOnScreen = lanes.every((x) => x > margin && x < window.innerWidth - margin);

      // HUD overlap: does the sound button cover the fish counter?
      const fish = document.querySelector('.hud-fish').getBoundingClientRect();
      const sys = document.getElementById('sysbar').getBoundingClientRect();
      const overlap = !(fish.right <= sys.left || fish.left >= sys.right ||
                        fish.bottom <= sys.top || fish.top >= sys.bottom);
      const centre = document.querySelector('.hud-center').getBoundingClientRect();
      const centred = Math.abs((centre.left + centre.right) / 2 - window.innerWidth / 2) < 14;
      const fishVisible = fish.width > 10 && fish.right < window.innerWidth + 1 && fish.left > 0;

      return { lanes, lanesOnScreen, overlap, centred, fishVisible,
               focal: +cam.focal.toFixed(0), iw: window.innerWidth };
    });
    const ok = r.lanesOnScreen && !r.overlap && r.centred && r.fishVisible && !errs.length;
    if (!ok) fails++;
    console.log((ok ? '  PASS  ' : '  FAIL  ') + s.n.padEnd(22) + s.w + 'x' + s.h + '@' + s.dpr +
      '  lanes=' + JSON.stringify(r.lanes) + ' focal=' + r.focal +
      (r.lanesOnScreen ? '' : ' [LANES OFF SCREEN]') +
      (r.overlap ? ' [HUD OVERLAP]' : '') +
      (r.centred ? '' : ' [CENTRE OFF]') +
      (r.fishVisible ? '' : ' [FISH HIDDEN]') +
      (errs.length ? ' [ERR ' + errs[0] + ']' : ''));
    await p.screenshot({ path: require('path').join(__dirname, 'shots') + '/lay-' + s.n + '.png' });
    await ctx.close();
  }
  await b.close();
  console.log(fails ? '\n  ' + fails + ' layout failures' : '\n  all layouts OK');
  process.exit(fails ? 1 : 0);
})();
