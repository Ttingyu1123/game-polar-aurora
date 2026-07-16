/* Production smoke for v2: core play + every new system + SW/manifest,
   which only work over HTTPS and therefore could not be tested locally. */
const { chromium } = require('playwright');
const URL = 'https://game-polar-aurora.tingyudeco.com/';

const out = [];
const check = (n, ok, d) => { out.push(ok); console.log((ok ? '  PASS  ' : '  FAIL  ') + n.padEnd(40) + (d || '')); };

(async () => {
  const b = await chromium.launch({ headless: false, args: ['--enable-gpu-rasterization', '--ignore-gpu-blocklist'] });
  const ctx = await b.newContext({ viewport: { width: 1280, height: 800 } });
  const p = await ctx.newPage();
  const errs = [], failed = [];
  p.on('pageerror', (e) => errs.push(e.message));
  p.on('console', (m) => { if (m.type() === 'error') errs.push(m.text().slice(0, 100)); });
  p.on('response', (r) => { if (r.status() >= 400) failed.push(r.url().split('/').pop() + ' ' + r.status()); });

  await p.goto(URL, { waitUntil: 'load', timeout: 45000 });
  await p.waitForTimeout(2200);

  check('no failed requests', failed.length === 0, failed.slice(0, 4).join(' | '));
  check('no console errors', errs.length === 0, errs.slice(0, 2).join(' | '));

  const menu = await p.evaluate(() => ({
    booted: !!window.__game,
    daily: document.getElementById('dailySub').textContent,
    missions: document.querySelectorAll('.mission-row').length,
    bank: document.getElementById('bankValue').textContent
  }));
  check('v2 menu live (daily + missions + bank)', menu.booted && menu.missions === 3 &&
    /\d{4}-\d{2}-\d{2}/.test(menu.daily), JSON.stringify(menu));

  // Service worker registers and controls the page.
  const sw = await p.evaluate(async () => {
    if (!('serviceWorker' in navigator)) return { support: false };
    const reg = await navigator.serviceWorker.ready.catch(() => null);
    for (let i = 0; i < 40 && !(reg && reg.active); i++) await new Promise(r => setTimeout(r, 250));
    const keys = await caches.keys();
    return { support: true, active: !!(reg && reg.active), caches: keys };
  });
  check('service worker active', sw.support && sw.active, JSON.stringify(sw.caches));

  const manifest = await p.evaluate(async () => {
    const r = await fetch('manifest.webmanifest');
    const m = await r.json();
    const icon = await fetch(m.icons[0].src);
    return { ok: r.ok, name: m.name, iconOk: icon.ok, iconType: icon.headers.get('content-type') };
  });
  check('manifest + icons served', manifest.ok && manifest.iconOk && /png/.test(manifest.iconType),
    JSON.stringify(manifest));

  // A real daily run on production.
  await p.click('#btnDaily');
  await p.waitForFunction(() => window.__game.fsm.current === 'playing', { timeout: 15000 });
  const daily = await p.evaluate(async () => {
    const g = window.__game;
    const first = g.obstacles.list.slice(0, 6).map(o => o.type + '@' + o.lane + '@' + o.z0.toFixed(1));
    await new Promise(r => setTimeout(r, 1500));
    return { daily: g.daily, first, moved: g.distance > 10,
             tagged: document.querySelector('.hud-dist').classList.contains('daily') };
  });
  check('daily run plays with HUD tag', daily.daily && daily.moved && daily.tagged, daily.first.slice(0, 2).join(' '));

  // Wardrobe purchase on production (bank granted via console for the test).
  const ward = await p.evaluate(() => {
    const g = window.__game;
    g.toMenu();
    g.progress.deposit(200);
    const ok = g.buyItem('scarf_teal');
    return { ok, applied: g.player.style.scarf.base === '#2ec9a8', bank: g.progress.bank };
  });
  check('wardrobe works on production', ward.ok && ward.applied, JSON.stringify(ward));

  // Offline: SW must serve the cached game with the network cut.
  await ctx.setOffline(true);
  const p2 = await ctx.newPage();
  let offlineOk = false, offlineBoot = false;
  try {
    const r = await p2.goto(URL, { waitUntil: 'load', timeout: 25000 });
    offlineOk = !!r && r.ok();
    await p2.waitForTimeout(2200);
    offlineBoot = await p2.evaluate(() => !!window.__game && !!document.getElementById('btnPlay'));
  } catch (e) { /* stays false */ }
  await ctx.setOffline(false);
  check('OFFLINE: game loads from SW cache', offlineOk && offlineBoot,
    'response=' + offlineOk + ' boot=' + offlineBoot);
  // The offline page runs a second full game loop; leaving it open halves the
  // fps measurement on the first page (it did: 24 fps with it, 75+ without).
  await p2.close();
  await p.bringToFront();
  await p.waitForTimeout(600);

  const fps = await p.evaluate(async () => {
    const g = window.__game;
    g.start();
    await new Promise(r => { const w = () => (g.fsm.current === 'playing' ? r() : setTimeout(w, 60)); w(); });
    g.collisions.check = () => [];
    await new Promise(r => setTimeout(r, 1500));
    const t = []; let last = performance.now(); let n = 0;
    await new Promise(d => { const tick = () => { const now = performance.now(); t.push(now - last); last = now; if (++n < 150) requestAnimationFrame(tick); else d(); }; requestAnimationFrame(tick); });
    t.sort((a, b) => a - b);
    return t[t.length >> 1];
  });
  check('production frame rate', fps < 18.5, (1000 / fps).toFixed(0) + ' fps');

  await p.screenshot({ path: require('path').join(__dirname, 'shots') + '/live-v2.png' });
  await b.close();
  const bad = out.filter(x => !x).length;
  console.log('\n  ' + (out.length - bad) + '/' + out.length + ' production checks passed');
  process.exit(bad ? 1 : 0);
})();
