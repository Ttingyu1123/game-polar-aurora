/* Celebration must fire, must end, and must NOT make the penguin leave the
   ground — an involuntary hop would kill a player for doing well. */
const { chromium } = require('playwright');
const path = require('path');
const ROOT = require('path').resolve(__dirname, '..');
const url = 'file:///' + path.join(ROOT, 'index.html').split(path.sep).join('/');

(async () => {
  const b = await chromium.launch({ headless: false, args: ['--enable-gpu-rasterization', '--ignore-gpu-blocklist'] });
  const p = await b.newPage({ viewport: { width: 1280, height: 800 } });
  const errs = [];
  p.on('pageerror', (e) => errs.push(e.message));
  await p.goto(url, { waitUntil: 'load' });
  await p.waitForTimeout(500);
  await p.click('#btnPlay');
  await p.waitForFunction(() => window.__game.fsm.current === 'playing', { timeout: 12000 });

  const r = await p.evaluate(async () => {
    const g = window.__game;
    g.obstacles.list.length = 0;
    g.obstacles.update = () => {};
    g.collectibles.list.length = 0;

    // Aurora crystal → celebration.
    g.collectibles._emit('auroraCrystal', g.player.x, g.player.y + 0.55, g.worldZ + 2);
    let entered = false, maxY = 0, leftGround = false;
    for (let i = 0; i < 60; i++) {
      await new Promise((r) => requestAnimationFrame(r));
      if (g.player.fsm.current === 'celebrate') entered = true;
      if (entered) { maxY = Math.max(maxY, g.player.y); if (!g.player.onGround) leftGround = true; }
    }
    const midState = g.player.fsm.current;
    const scoreAfter = g.score;

    // It must hand control back.
    for (let i = 0; i < 180; i++) {
      await new Promise((r) => requestAnimationFrame(r));
      if (g.player.fsm.current !== 'celebrate') break;
    }
    const endState = g.player.fsm.current;

    // And the run must still be alive and controllable afterwards.
    const lane0 = g.player.lane;
    g.player.moveLane(1);
    const moved = g.player.lane !== lane0 || lane0 === 2;
    const jumped = g.player.jump();

    return { entered, midState, endState, maxY, leftGround, scoreAfter,
             moved, jumped, gameState: g.fsm.current };
  });

  const out = [];
  const check = (n, ok, d) => { out.push(ok); console.log((ok ? '  PASS  ' : '  FAIL  ') + n.padEnd(40) + (d || '')); };
  check('aurora crystal triggers celebration', r.entered, 'state=' + r.midState);
  check('celebration awards big score', r.scoreAfter > 200, 'score=' + r.scoreAfter.toFixed(0));
  check('celebration never leaves the ground', !r.leftGround && r.maxY < 0.05, 'maxY=' + r.maxY.toFixed(3));
  check('celebration ends by itself', r.endState !== 'celebrate', 'ended in ' + r.endState);
  check('control returns after celebrating', r.moved && r.jumped, JSON.stringify({ moved: r.moved, jumped: r.jumped }));
  check('run survives the celebration', r.gameState === 'playing', r.gameState);
  check('no errors', errs.length === 0, errs[0] || '');

  await p.screenshot({ path: require('path').join(__dirname, 'shots') + '/celebrate.png' });
  await b.close();
  const bad = out.filter((x) => !x).length;
  console.log('\n  ' + (out.length - bad) + '/' + out.length + ' celebration checks passed');
  process.exit(bad ? 1 : 0);
})();
