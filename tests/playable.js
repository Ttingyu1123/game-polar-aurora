/* Playability: an autopilot with PERFECT decisions but HUMAN LATENCY plays
   real runs. If a bot that always chooses right still dies at 200 m, the
   game is too hard for a person who also has to think.
   Latency is the knob: 0.30s ≈ a sharp player, 0.45s ≈ a casual one. */
const { chromium } = require('playwright');
const path = require('path');
const ROOT = require('path').resolve(__dirname, '..');
const url = 'file:///' + path.join(ROOT, 'index.html').split(path.sep).join('/');

const BOT = `
window.__bot = function (latency) {
  const g = window.__game;
  const SPEC = window.ObstacleManager.SPEC;
  const LANES = window.WORLD.LANES;
  let pending = null, pendingT = 0, lastPlan = '';

  g.__botTick = function (dt) {
    if (g.fsm.current !== 'playing') return;
    const p = g.player;

    // The nearest row of hazards still ahead of us.
    const ahead = g.obstacles.list.filter(o => o.z > 1.0 && o.z < 60).sort((a, b) => a.z - b.z);
    let plan = 'none';
    if (ahead.length) {
      const z0 = ahead[0].z;
      const row = ahead.filter(o => o.z < z0 + 4.5);
      const lanes = [null, null, null];
      for (const o of row) {
        if (SPEC[o.type].allLanes) { for (let l = 0; l < 3; l++) lanes[l] = lanes[l] || SPEC[o.type].verb; }
        else lanes[o.lane] = SPEC[o.type].verb;
      }
      const free = [0, 1, 2].filter(l => !lanes[l]);
      if (free.length) {
        // Prefer the reachable free lane nearest our current one.
        free.sort((a, b) => Math.abs(a - p.lane) - Math.abs(b - p.lane));
        plan = 'lane' + free[0];
      } else {
        plan = lanes[p.lane] === 'jump' ? 'jump' : lanes[p.lane] === 'slide' ? 'slide' : 'none';
      }
      g.__rowZ = z0;
    }

    // Human latency: a new decision takes time to become an input.
    if (plan !== lastPlan) { lastPlan = plan; pending = plan; pendingT = latency; }
    if (pending && (pendingT -= dt) <= 0) {
      if (pending.startsWith('lane')) {
        const want = +pending.slice(4);
        if (want !== p.lane) {
          p.moveLane(Math.sign(want - p.lane));
          // moveLane() shifts ONE lane. A two-lane shift is two presses, so
          // stay armed and press again after a realistic re-press interval.
          // Without this the bot could never cross two lanes at all and died
          // to any pattern that asked for it — measuring my own bot, not the
          // game.
          if (want !== p.lane) { pendingT = 0.09; return; }
        }
      }
      pending = null;
    }

    // Timing-critical inputs fire on distance, but only if the decision has
    // already "landed" — we never get to act sooner than our own latency.
    if (!pending && ahead.length) {
      const z0 = ahead[0].z;
      const row = ahead.filter(o => o.z < z0 + 4.5);
      const mine = row.find(o => SPEC[o.type].allLanes || o.lane === p.lane);
      if (mine) {
        const v = SPEC[mine.type].verb;
        const tti = z0 / Math.max(1, g.speed);
        if (v === 'jump' && tti < 0.42 && p.onGround) p.jump();
        if (v === 'slide' && tti < 0.22 && p.onGround) p.slide();
      }
    }
  };
};
`;

(async () => {
  const b = await chromium.launch({ headless: false, args: ['--enable-gpu-rasterization', '--ignore-gpu-blocklist'] });
  const p = await b.newPage({ viewport: { width: 1280, height: 800 } });
  p.on('pageerror', (e) => console.log('ERR', e.message));
  await p.goto(url, { waitUntil: 'load' });
  await p.waitForTimeout(400);
  await p.evaluate(BOT);

  for (const latency of [0.30, 0.45]) {
    const runs = await p.evaluate(async (lat) => {
      const g = window.__game;
      window.__bot(lat);
      // Hook the bot into the real update loop.
      if (!g.__hooked) {
        const real = g.update.bind(g);
        g.update = function (dt) { real(dt); if (g.__botTick) g.__botTick(dt); };
        g.__hooked = true;
      }
      const out = [];
      const GOAL = 1500;                      // metres = "this run is a success"
      for (let i = 0; i < 8; i++) {
        g.fsm.set('menu', {}, true); g.start();
        await new Promise(r => { const w = () => (g.fsm.current === 'playing' ? r() : setTimeout(w, 50)); w(); });
        const t0 = performance.now();
        // Terminate on GAME distance, never on wall time. An occluded window
        // throttles rAF to ~1 Hz, which produced "45 m in 75.6 s" (0.6 m/s) —
        // the game was fine, the clock was lying.
        while (g.fsm.current === 'playing' && g.distance < GOAL &&
               performance.now() - t0 < 240000) {
          await new Promise(r => requestAnimationFrame(r));
        }
        const wall = (performance.now() - t0) / 1000;
        out.push({ dist: Math.round(g.distance), sec: +wall.toFixed(1),
                   alive: g.fsm.current === 'playing',
                   reached: g.distance >= GOAL });
        g.fsm.set('menu', {}, true);
        await new Promise(r => setTimeout(r, 120));
      }
      return out;
    }, latency);

    const dists = runs.map(r => r.dist).sort((a, b) => a - b);
    const med = dists[dists.length >> 1];
    const worst = dists[0];
    const reached = runs.filter(r => r.reached).length;
    console.log('\n  latency ' + latency.toFixed(2) + 's  (' + (latency === 0.3 ? 'sharp player' : 'casual player') + ')');
    console.log('    runs: ' + runs.map(r => r.dist + 'm' + (r.reached ? '*' : '')).join('  '));
    console.log('    median ' + med + 'm   worst ' + worst + 'm   reached 1500m: ' + reached + '/' + runs.length);
  }
  await b.close();
})();
