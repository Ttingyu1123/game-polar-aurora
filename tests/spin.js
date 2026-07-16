/* "The penguin spins at the start of a run." Reproduce it, don't guess.
   Hypothesis: Player.reset() never resets its FSM, so after one death the
   next run begins in the 'hit' state and hitSpin keeps integrating. */
const { chromium } = require('playwright');
const path = require('path');
const ROOT = require('path').resolve(__dirname, '..');
const url = 'file:///' + path.join(ROOT, 'index.html').split(path.sep).join('/');

(async () => {
  const b = await chromium.launch({ headless: false, args: ['--enable-gpu-rasterization'] });
  const p = await b.newPage({ viewport: { width: 1280, height: 800 } });
  p.on('pageerror', (e) => console.log('ERR', e.message));
  await p.goto(url, { waitUntil: 'load' });
  await p.waitForTimeout(500);

  const r = await p.evaluate(async () => {
    const g = window.__game;
    const waitPlay = () => new Promise((r) => {
      const w = () => (g.fsm.current === 'playing' ? r() : setTimeout(w, 50)); w();
    });

    // ── Run 1: the very first run of the session ──
    g.start(); await waitPlay();
    await new Promise((r) => setTimeout(r, 400));
    const first = { state: g.player.fsm.current, spin: +g.player.hitSpin.toFixed(3) };

    // ── Kill him ──
    g.collisions.check = () => [];
    g.player.hit(); g.fsm.set('dying');
    await new Promise((r) => setTimeout(r, 2200));
    const dead = { state: g.player.fsm.current, spin: +g.player.hitSpin.toFixed(3) };

    // ── Run 2: press play again ──
    g.start(); await waitPlay();
    await new Promise((r) => setTimeout(r, 100));
    const s0 = g.player.hitSpin;
    await new Promise((r) => setTimeout(r, 900));
    const second = {
      state: g.player.fsm.current,
      spin: +g.player.hitSpin.toFixed(3),
      spinning: g.player.hitSpin - s0 > 0.05,
      spinRate: +((g.player.hitSpin - s0) / 0.9).toFixed(2),
      expr: g.player.expr,
      dead: g.player.dead
    };

    // Does jumping snap him out of it? (matches "it stops once you do something")
    g.player.jump();
    await new Promise((r) => setTimeout(r, 200));
    const afterJump = { state: g.player.fsm.current };

    return { first, dead, second, afterJump };
  });

  console.log('  run 1 (fresh session)   state=' + r.first.state + '  hitSpin=' + r.first.spin);
  console.log('  after dying             state=' + r.dead.state + '  hitSpin=' + r.dead.spin);
  console.log('  run 2 (after restart)   state=' + r.second.state + '  hitSpin=' + r.second.spin +
              '  expr=' + r.second.expr + '  dead=' + r.second.dead);
  console.log('  → SPINNING ON RUN 2:    ' + (r.second.spinning ? 'YES — ' + r.second.spinRate + ' rad/s' : 'no'));
  console.log('  after pressing jump     state=' + r.afterJump.state);
  console.log('');
  console.log(r.second.spinning
    ? '  REPRODUCED: Player.reset() leaves the FSM in whatever state death left it.'
    : '  not reproduced this way');
  await b.close();
  process.exit(r.second.spinning ? 1 : 0);
})();
