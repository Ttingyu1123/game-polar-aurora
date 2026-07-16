/* Automated QA harness for Polar Aurora.
   Drives the real game in Chromium, asserts behaviour, captures shots. */
const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');

const ROOT = require('path').resolve(__dirname, '..');
const OUT = path.join(__dirname, 'shots');
fs.mkdirSync(OUT, { recursive: true });

const errors = [];
const results = [];
function check(name, pass, detail) {
  results.push({ name, pass, detail });
  console.log((pass ? '  PASS  ' : '  FAIL  ') + name + (detail ? '  :: ' + detail : ''));
}

(async () => {
  // Headed + GPU rasterisation: headless Chromium falls back to SwiftShader
  // software rendering, which would make the frame-rate check a measurement
  // of a machine no player owns.
  const browser = await chromium.launch({
    headless: false,
    args: ['--enable-gpu-rasterization', '--ignore-gpu-blocklist', '--enable-zero-copy']
  });
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 });
  const page = await ctx.newPage();

  page.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message + '\n' + (e.stack || '').split('\n').slice(0, 4).join('\n')));
  page.on('requestfailed', (r) => errors.push('requestfailed: ' + r.url() + ' :: ' + (r.failure() || {}).errorText));

  const url = 'file:///' + path.join(ROOT, 'index.html').replace(/\\/g, '/');
  await page.goto(url, { waitUntil: 'load' });
  await page.waitForTimeout(1800);

  // ── 1. asset / error hygiene ──────────────────────────────
  check('no console errors or failed requests', errors.length === 0, errors.slice(0, 4).join(' | '));

  const booted = await page.evaluate(() => !!window.__game);
  check('game object constructed', booted);

  await page.screenshot({ path: path.join(OUT, '01-menu.png') });

  // ── 2. canvas is actually painting (not a black rect) ─────
  const stats = await page.evaluate(() => {
    const c = document.getElementById('game');
    const g = c.getContext('2d');
    const d = g.getImageData(0, 0, c.width, c.height).data;
    let nonBlack = 0, uniq = new Set();
    for (let i = 0; i < d.length; i += 4 * 997) {
      const r = d[i], gg = d[i + 1], b = d[i + 2];
      if (r + gg + b > 24) nonBlack++;
      uniq.add((r >> 3) + ',' + (gg >> 3) + ',' + (b >> 3));
    }
    return { nonBlack, uniq: uniq.size, w: c.width, h: c.height };
  });
  check('canvas renders content', stats.nonBlack > 100, JSON.stringify(stats));
  check('scene is richly coloured (not flat)', stats.uniq > 120, stats.uniq + ' distinct sampled colours');

  // ── 3. start a run ────────────────────────────────────────
  await page.click('#btnPlay');
  const inCountdown = await page.evaluate(() => window.__game.fsm.current);
  await page.waitForFunction(() => window.__game.fsm.current === 'playing', { timeout: 12000 });
  const st = await page.evaluate(() => window.__game.fsm.current);
  check('countdown runs then hands over to play', inCountdown === 'countdown' && st === 'playing',
    inCountdown + ' → ' + st);
  await page.screenshot({ path: path.join(OUT, '02-playing.png') });

  // Control tests must not be at the mercy of a randomly-spawned iceberg.
  // Armour suppresses only FATAL events — pickups, near-misses and every
  // other code path stay live, so we aren't testing a hollowed-out game.
  // Lethality gets its own dedicated tests below with hazards placed by hand.
  const armour = async () => page.evaluate(() => {
    const cs = window.__game.collisions;
    if (!window.__realCheck) window.__realCheck = cs.check.bind(cs);
    cs.check = function () {
      return window.__realCheck.apply(null, arguments).filter((e) => e.kind !== 'hit');
    };
  });
  const disarm = async () => page.evaluate(() => { window.__game.collisions.check = window.__realCheck; });
  await armour();

  // ── 4. perspective: obstacles scale with distance ─────────
  const persp = await page.evaluate(() => {
    const g = window.__game, cam = g.cam;
    const far = cam.scaleAt(120), mid = cam.scaleAt(40), near = cam.scaleAt(6);
    // A ground row's depth must decrease monotonically down the screen.
    const rows = [];
    for (let y = Math.ceil(cam.horizon) + 6; y < cam.height; y += 40) rows.push(cam.zAtScreenY(y));
    let mono = true;
    for (let i = 1; i < rows.length; i++) if (!(rows[i] < rows[i - 1])) mono = false;
    return { far, mid, near, mono, rows: rows.map(r => +r.toFixed(1)) };
  });
  check('scale grows as objects approach', persp.near > persp.mid && persp.mid > persp.far,
    `far=${persp.far.toFixed(2)} mid=${persp.mid.toFixed(2)} near=${persp.near.toFixed(2)}`);
  check('ground rows map monotonically to depth', persp.mono, JSON.stringify(persp.rows));

  // ── 5. procedural generation ──────────────────────────────
  const gen = await page.evaluate(() => {
    const g = window.__game;
    return { obstacles: g.obstacles.list.length, collectibles: g.collectibles.list.length,
             types: [...new Set(g.obstacles.list.map(o => o.type))] };
  });
  check('obstacles procedurally spawned', gen.obstacles > 0, gen.obstacles + ' live, types=' + gen.types.join(','));
  check('collectibles procedurally spawned', gen.collectibles > 0, gen.collectibles + ' live');

  // ── 6. keyboard: jump ─────────────────────────────────────
  const jump = await page.evaluate(async () => {
    const g = window.__game;
    g.player.y = 0; g.player.vy = 0; g.player.onGround = true;
    const before = g.player.y;
    window.dispatchEvent(new KeyboardEvent('keydown', { code: 'Space', bubbles: true }));
    await new Promise(r => setTimeout(r, 260));
    const peak = g.player.y;
    window.dispatchEvent(new KeyboardEvent('keyup', { code: 'Space', bubbles: true }));
    await new Promise(r => setTimeout(r, 900));
    return { before, peak, landed: g.player.y, onGround: g.player.onGround };
  });
  check('jump lifts the penguin', jump.peak > 0.8, JSON.stringify(jump));
  check('jump returns to the ice', jump.landed < 0.05 && jump.onGround, JSON.stringify(jump));

  // ── 7. keyboard: lanes ────────────────────────────────────
  const lanes = await page.evaluate(async () => {
    const g = window.__game;
    const key = async (code) => {
      window.dispatchEvent(new KeyboardEvent('keydown', { code, bubbles: true }));
      await new Promise(r => setTimeout(r, 260));
      window.dispatchEvent(new KeyboardEvent('keyup', { code, bubbles: true }));
      await new Promise(r => setTimeout(r, 60));
    };
    g.player.lane = 1; g.player.targetX = 0;
    const a = g.player.lane;
    await key('ArrowLeft');
    const b = g.player.lane, bx = g.player.x;
    await key('ArrowRight');
    await key('ArrowRight');
    await new Promise(r => setTimeout(r, 400));
    const c = g.player.lane, cx = g.player.x;
    // Walls: you cannot leave the runway no matter how hard you mash.
    await key('ArrowRight'); await key('ArrowRight');
    return { a, b, bx, c, cx, clamped: g.player.lane, state: g.fsm.current };
  });
  check('left moves one lane', lanes.b === lanes.a - 1, JSON.stringify(lanes));
  check('right moves back across two lanes', lanes.c === lanes.b + 2, JSON.stringify(lanes));
  check('lane index drives world x', Math.abs(lanes.cx - 2.35) < 0.35, 'x=' + lanes.cx.toFixed(2));
  check('lanes clamp at the runway edge', lanes.clamped === 2, 'lane=' + lanes.clamped);

  // ── 8. slide ──────────────────────────────────────────────
  const slide = await page.evaluate(async () => {
    const g = window.__game;
    g.player.y = 0; g.player.onGround = true; g.player.vy = 0;
    const tall = g.player.getBox().top;
    window.dispatchEvent(new KeyboardEvent('keydown', { code: 'ArrowDown', bubbles: true }));
    await new Promise(r => setTimeout(r, 140));
    const low = g.player.getBox().top;
    const state = g.player.fsm.current;
    await new Promise(r => setTimeout(r, 800));
    return { tall, low, state, after: g.player.fsm.current };
  });
  check('slide lowers the hitbox', slide.low < slide.tall * 0.6, JSON.stringify(slide));
  check('slide auto-recovers', slide.after !== 'slide', JSON.stringify(slide));

  // ── 9. scoring ────────────────────────────────────────────
  const score = await page.evaluate(async () => {
    const g = window.__game;
    const s0 = g.score, d0 = g.distance;
    await new Promise(r => setTimeout(r, 900));
    return { s0, s1: g.score, d0, d1: g.distance, fish: g.fish };
  });
  check('score accrues with distance', score.s1 > score.s0, JSON.stringify(score));
  check('distance advances', score.d1 > score.d0, `${score.d0.toFixed(1)} → ${score.d1.toFixed(1)}`);

  const hud = await page.evaluate(() => ({
    score: document.getElementById('scoreValue').textContent,
    dist: document.getElementById('distValue').textContent
  }));
  check('HUD reflects score', hud.score !== '0', JSON.stringify(hud));

  // ── 9b. jumping actually clears a jumpable hazard ─────────
  await disarm();
  const cleared = await page.evaluate(async () => {
    const g = window.__game;
    g.obstacles.list.length = 0;
    g.player.lane = 1; g.player.targetX = 0; g.player.x = 0;
    g.player.y = 0; g.player.vy = 0; g.player.onGround = true;
    // A seal 22 m out: jump at the right moment and you sail over it.
    // Trigger on TIME-to-impact, not distance. A fixed 13 m trigger is wrong
    // at low speed — airtime is 0.635 s, so at 19.5 m/s pressing at 13 m
    // means landing 1.4 m BEFORE the seal. Too early is a real way to miss.
    g.obstacles._emit('seal', 1, g.worldZ + 22);
    let jumped = false;
    for (let i = 0; i < 200; i++) {
      await new Promise(r => requestAnimationFrame(r));
      const o = g.obstacles.list[0];
      if (o && !jumped && o.z / Math.max(1, g.speed) < 0.36) { jumped = true; g.player.jump(); }
      if (g.fsm.current !== 'playing') break;
      if (!g.obstacles.list.length) break;
    }
    return { state: g.fsm.current, jumped };
  });
  check('a well-timed jump clears a seal', cleared.state === 'playing' && cleared.jumped, JSON.stringify(cleared));

  // ── 9c. sliding clears an arch that standing does not ─────
  const arch = await page.evaluate(async () => {
    const g = window.__game;
    g.progress.d.bank = 0;
    const trial = async (doSlide) => {
      g.fsm.set('menu', {}, true); g.start();
      await new Promise(r => { const w = () => (g.fsm.current === 'playing' ? r() : setTimeout(w, 60)); w(); });
      g.obstacles.list.length = 0; g.collectibles.list.length = 0;
      g.player.lane = 1; g.player.targetX = 0; g.player.x = 0;
      g.obstacles._emit('arch', 1, g.worldZ + 26);
      let acted = false;
      for (let i = 0; i < 260; i++) {
        await new Promise(r => requestAnimationFrame(r));
        const o = g.obstacles.list[0];
        if (o && !acted && o.z < 9) { acted = true; if (doSlide) g.player.slide(); }
        if (g.fsm.current !== 'playing') return 'died';
        if (!g.obstacles.list.length || (o && o.z < -4)) break;
      }
      return g.fsm.current === 'playing' ? 'survived' : 'died';
    };
    return { standing: await trial(false), sliding: await trial(true) };
  });
  check('an arch blocks you if you stand up', arch.standing === 'died', JSON.stringify(arch));
  check('sliding gets you under the arch', arch.sliding === 'survived', JSON.stringify(arch));

  // ── 10. collision kills ───────────────────────────────────
  const death = await page.evaluate(async () => {
    const g = window.__game;
    if (g.fsm.current !== 'playing') {
      g.fsm.set('menu', {}, true); g.start();
      await new Promise(r => { const w = () => (g.fsm.current === 'playing' ? r() : setTimeout(w, 60)); w(); });
    }
    // Park an iceberg right on top of him. Nothing clears a dodge-only wall.
    g.powers.shield = 0; g.powers.cocoa = 0; g.invuln = 0;
    g.progress.d.bank = 0;   // no revive offer — these tests assert dying→over
    g.obstacles.list.length = 0;
    g.obstacles._emit('iceberg', g.player.lane, g.worldZ + 3);
    for (let i = 0; i < 90; i++) {
      await new Promise(r => requestAnimationFrame(r));
      if (g.fsm.current !== 'playing') break;
    }
    return { state: g.fsm.current, dead: g.player.dead };
  });
  check('collision triggers death', death.state === 'dying' || death.state === 'over', JSON.stringify(death));
  await page.waitForTimeout(2200);
  await page.screenshot({ path: path.join(OUT, '03-gameover.png') });
  const over = await page.evaluate(() => ({
    state: window.__game.fsm.current,
    visible: !document.getElementById('gameover').classList.contains('hidden'),
    best: window.__game.best
  }));
  check('game-over screen shows', over.state === 'over' && over.visible, JSON.stringify(over));
  check('best score persisted', over.best > 0, 'best=' + over.best);

  // ── 11. pickups award points ──────────────────────────────
  await page.click('#btnRetry');
  await page.waitForFunction(() => window.__game.fsm.current === 'playing', { timeout: 12000 });
  await armour();
  const pick = await page.evaluate(async () => {
    const g = window.__game;
    g.collectibles.list.length = 0;
    const f0 = g.fish, s0 = g.score;
    for (let i = 0; i < 4; i++) g.collectibles._emit('fish', g.player.x, g.player.y + 0.55, g.worldZ + 2 + i * 1.4);
    for (let i = 0; i < 120; i++) await new Promise(r => requestAnimationFrame(r));
    return { f0, f1: g.fish, s0, s1: g.score, combo: g.combo };
  });
  check('fish are collected', pick.f1 > pick.f0, JSON.stringify(pick));
  check('pickups raise score', pick.s1 > pick.s0, JSON.stringify(pick));

  // ── 12. power-ups ─────────────────────────────────────────
  const power = await page.evaluate(async () => {
    const g = window.__game;
    if (g.fsm.current !== 'playing') {
      g.fsm.set('menu', {}, true); g.start();
      await new Promise(r => { const w = () => (g.fsm.current === 'playing' ? r() : setTimeout(w, 60)); w(); });
    }
    g.obstacles.list.length = 0;
    g.collectibles.list.length = 0;
    g.collectibles._emit('shield', g.player.x, g.player.y + 0.55, g.worldZ + 2);
    for (let i = 0; i < 90; i++) await new Promise(r => requestAnimationFrame(r));
    const got = g.powers.shield;
    const chip = document.querySelectorAll('.pu-chip').length;
    // A shield must eat exactly one hit and leave you alive.
    g.collisions.check = window.__realCheck;
    g.obstacles.list.length = 0;
    g.invuln = 0;
    g.obstacles._emit('iceberg', g.player.lane, g.worldZ + 3);
    for (let i = 0; i < 90; i++) await new Promise(r => requestAnimationFrame(r));
    const afterFirst = { shield: g.powers.shield, state: g.fsm.current };
    // …and the NEXT hit must kill. A shield that silently persists would
    // pass a naive "did I survive?" test forever.
    g.invuln = 0;
    g.obstacles.list.length = 0;
    g.obstacles._emit('iceberg', g.player.lane, g.worldZ + 3);
    for (let i = 0; i < 120; i++) {
      await new Promise(r => requestAnimationFrame(r));
      if (g.fsm.current !== 'playing') break;
    }
    return { got, chip, after: afterFirst.shield, state: afterFirst.state, second: g.fsm.current };
  });
  check('shield power-up applies', power.got > 0, JSON.stringify(power));
  check('power-up HUD chip appears', power.chip > 0, JSON.stringify(power));
  check('shield absorbs a fatal hit', power.state === 'playing' && power.after === 0, JSON.stringify(power));
  check('shield is consumed (next hit is fatal)', power.second !== 'playing', JSON.stringify(power));
  await page.screenshot({ path: path.join(OUT, '04-powerup.png') });

  // ── 13. pause ─────────────────────────────────────────────
  await page.evaluate(async () => {
    const g = window.__game;
    if (g.fsm.current !== 'playing') {
      g.fsm.set('menu', {}, true); g.start();
      await new Promise(r => { const w = () => (g.fsm.current === 'playing' ? r() : setTimeout(w, 60)); w(); });
    }
    g.collisions.check = () => [];
    // Let a real run accumulate before pausing — pausing at 0 m would make
    // "resume kept the run" vacuously true.
    await new Promise(r => setTimeout(r, 1200));
  });
  const pause = await page.evaluate(async () => {
    const g = window.__game;
    window.dispatchEvent(new KeyboardEvent('keydown', { code: 'Escape', bubbles: true }));
    await new Promise(r => setTimeout(r, 200));
    const s = g.fsm.current;
    const d0 = g.distance;
    await new Promise(r => setTimeout(r, 400));
    return { s, frozen: Math.abs(g.distance - d0) < 0.001, visible: !document.getElementById('pause').classList.contains('hidden') };
  });
  check('escape pauses', pause.s === 'paused' && pause.visible, JSON.stringify(pause));
  check('pause freezes the world', pause.frozen, JSON.stringify(pause));
  await page.screenshot({ path: path.join(OUT, '05-pause.png') });

  const resumed = await page.evaluate(async () => {
    const g = window.__game;
    const dBefore = g.distance, sBefore = g.score;
    document.getElementById('btnResume').click();
    await new Promise(r => { const w = () => (g.fsm.current === 'playing' ? r() : setTimeout(w, 60)); w(); });
    return { state: g.fsm.current, dBefore, dAfter: g.distance,
             keptDistance: g.distance >= dBefore - 0.001, keptScore: g.score >= sBefore - 0.001 };
  });
  check('resume returns to play', resumed.state === 'playing', JSON.stringify(resumed));
  check('resume keeps the run (no reset)',
    resumed.keptDistance && resumed.keptScore && resumed.dBefore > 1, JSON.stringify(resumed));

  // ── 14. frame rate ────────────────────────────────────────
  const fps = await page.evaluate(async () => {
    const times = [];
    let last = performance.now();
    await new Promise((done) => {
      let n = 0;
      const tick = () => {
        const now = performance.now();
        times.push(now - last); last = now;
        if (++n < 150) requestAnimationFrame(tick); else done();
      };
      requestAnimationFrame(tick);
    });
    times.sort((a, b) => a - b);
    return { median: times[times.length >> 1], p95: times[Math.floor(times.length * 0.95)],
             quality: window.__game.renderer.quality };
  });
  check('stable frame rate (median ≥ 55 fps)', fps.median < 18.2,
    `median=${fps.median.toFixed(2)}ms (${(1000 / fps.median).toFixed(0)}fps) p95=${fps.p95.toFixed(1)}ms q=${fps.quality.toFixed(2)}`);

  // ── 15. responsive layouts ────────────────────────────────
  const sizes = [
    { w: 390, h: 844, n: 'mobile-portrait' },
    { w: 844, h: 390, n: 'mobile-landscape' },
    { w: 820, h: 1180, n: 'tablet' },
    { w: 1920, h: 1080, n: 'desktop-hd' },
    { w: 2560, h: 1080, n: 'ultrawide' }
  ];
  for (const s of sizes) {
    await page.setViewportSize({ width: s.w, height: s.h });
    await page.waitForTimeout(650);
    const ok = await page.evaluate(() => {
      const c = document.getElementById('game');
      const g = window.__game;
      const noHScroll = document.documentElement.scrollWidth <= window.innerWidth + 1;
      // Horizon must stay on screen or the projection is broken.
      const hz = g.cam.horizon;
      return { cw: c.width, ch: c.height, iw: window.innerWidth, ih: window.innerHeight,
               noHScroll, hz, hzOK: hz > 0 && hz < window.innerHeight };
    });
    check('responsive @ ' + s.n + ' ' + s.w + 'x' + s.h,
      ok.noHScroll && ok.hzOK && ok.cw >= s.w * 0.9, JSON.stringify(ok));
    await page.screenshot({ path: path.join(OUT, 'resp-' + s.n + '.png') });
  }
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.waitForTimeout(400);

  // ── 16. touch controls ────────────────────────────────────
  const touchCtx = await browser.newContext({
    viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, deviceScaleFactor: 2
  });
  const tp = await touchCtx.newPage();
  const terrors = [];
  tp.on('pageerror', (e) => terrors.push(e.message));
  tp.on('console', (m) => { if (m.type() === 'error') terrors.push(m.text()); });
  await tp.goto(url, { waitUntil: 'load' });
  await tp.waitForTimeout(1200);
  await tp.tap('#btnPlay');
  await tp.waitForFunction(() => window.__game.fsm.current === 'playing', { timeout: 12000 });

  const swipe = await tp.evaluate(async () => {
    const g = window.__game;
    g.collisions.check = () => [];
    g.player.lane = 1; g.player.targetX = 0; g.player.x = 0;
    const c = document.getElementById('game');
    const send = (type, x, y) => c.dispatchEvent(new PointerEvent(type, {
      pointerId: 1, clientX: x, clientY: y, bubbles: true, pointerType: 'touch', isPrimary: true
    }));
    const out = { state: g.fsm.current };

    // swipe left
    const l0 = g.player.lane;
    send('pointerdown', 200, 600); send('pointermove', 120, 600); send('pointerup', 120, 600);
    await new Promise(r => setTimeout(r, 350));
    out.swipeLeft = { from: l0, to: g.player.lane };

    // swipe up = jump
    g.player.y = 0; g.player.onGround = true; g.player.vy = 0;
    send('pointerdown', 200, 600); send('pointermove', 200, 500); send('pointerup', 200, 500);
    await new Promise(r => setTimeout(r, 250));
    out.swipeUp = { y: g.player.y };
    await new Promise(r => setTimeout(r, 800));

    // swipe down = slide
    g.player.y = 0; g.player.onGround = true; g.player.vy = 0;
    send('pointerdown', 200, 500); send('pointermove', 200, 600); send('pointerup', 200, 600);
    await new Promise(r => setTimeout(r, 150));
    out.swipeDown = { state: g.player.fsm.current };
    await new Promise(r => setTimeout(r, 800));

    // tap = jump
    g.player.y = 0; g.player.onGround = true; g.player.vy = 0;
    send('pointerdown', 200, 600); send('pointerup', 201, 601);
    await new Promise(r => setTimeout(r, 250));
    out.tap = { y: g.player.y };
    return out;
  });
  check('touch: swipe left changes lane', swipe.swipeLeft.to === swipe.swipeLeft.from - 1, JSON.stringify(swipe.swipeLeft));
  check('touch: swipe up jumps', swipe.swipeUp.y > 0.6, JSON.stringify(swipe.swipeUp));
  check('touch: swipe down slides', swipe.swipeDown.state === 'slide', JSON.stringify(swipe.swipeDown));
  check('touch: tap jumps', swipe.tap.y > 0.6, JSON.stringify(swipe.tap));
  check('no errors on mobile', terrors.length === 0, terrors.slice(0, 3).join(' | '));
  await tp.screenshot({ path: path.join(OUT, '06-mobile.png') });
  await touchCtx.close();

  // ── 17. long soak: no leaks, no crashes, difficulty rises ─
  await page.evaluate(() => { window.__game.toMenu(); window.__game.start(); });
  await page.waitForFunction(() => window.__game.fsm.current === 'playing', { timeout: 12000 });
  const soakA = await page.evaluate(() => ({
    p: window.__game.particles.count, o: window.__game.obstacles.list.length,
    speed: window.__game.speed
  }));
  await page.evaluate(async () => {
    const g = window.__game;
    g.player.jump = () => false;             // stop it dying mid-soak
    g.collisions.check = () => [];
    await new Promise(r => setTimeout(r, 9000));
  });
  const soak = await page.evaluate(() => {
    const g = window.__game;
    return { state: g.fsm.current, dist: g.distance, speed: g.speed, diff: g.difficulty,
             p: g.particles.count, o: g.obstacles.list.length, c: g.collectibles.list.length,
             q: g.renderer.quality };
  });
  check('survives a long run', soak.state === 'playing' && soak.dist > 150, JSON.stringify(soak));
  // Assert the SHAPE (it rises, monotonically, from its own start), not an
  // absolute m/s — a hard-coded threshold here just breaks every time the
  // pacing is tuned, which tests nothing about whether difficulty ramps.
  check('difficulty ramps up',
    soak.speed > soakA.speed + 0.5 && soak.diff > 0 && soak.speed < 46,
    `speed ${soakA.speed.toFixed(1)} → ${soak.speed.toFixed(1)}  diff=${soak.diff.toFixed(3)}`);
  check('no unbounded growth (pools stable)', soak.p < 2200 && soak.o < 120 && soak.c < 260,
    `particles=${soak.p} obstacles=${soak.o} collectibles=${soak.c} (start p=${soakA.p} o=${soakA.o})`);
  await page.screenshot({ path: path.join(OUT, '07-soak.png') });

  check('still no console errors after full session', errors.length === 0, errors.slice(0, 5).join(' | '));

  await browser.close();

  const failed = results.filter(r => !r.pass);
  console.log('\n─────────────────────────────────────────');
  console.log(`  ${results.length - failed.length}/${results.length} checks passed`);
  if (failed.length) {
    console.log('  FAILURES:');
    for (const f of failed) console.log('   ✗ ' + f.name + '  ' + (f.detail || ''));
  }
  if (errors.length) { console.log('\n  ERRORS:'); errors.slice(0, 10).forEach(e => console.log('   ! ' + e)); }
  process.exit(failed.length ? 1 : 0);
})().catch((e) => { console.error('HARNESS CRASH', e); process.exit(2); });
