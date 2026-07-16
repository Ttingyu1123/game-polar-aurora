/* Measure the difficulty the generator actually produces.
     1. Is the world ever UNSOLVABLE? (a z-slice where every lane is blocked
        by things no single input can clear)
     2. Do patterns overlap each other's footprint?
     3. How much THINKING TIME does the player get, in seconds?
   The speed curve is read from the live Game, not reimplemented here. */
const { chromium } = require('playwright');
const path = require('path');
const ROOT = require('path').resolve(__dirname, '..');
const url = 'file:///' + path.join(ROOT, 'index.html').split(path.sep).join('/');

(async () => {
  const b = await chromium.launch({ headless: true });
  const p = await b.newPage({ viewport: { width: 1280, height: 800 } });
  p.on('pageerror', (e) => console.log('ERR', e.message));
  await p.goto(url, { waitUntil: 'load' });
  await p.waitForTimeout(400);

  const r = await p.evaluate(() => {
    const g = window.__game;
    const SPEC = window.ObstacleManager.SPEC;

    // Drive the REAL Game.update loop so we measure the shipped formula.
    // Everything that could perturb it has to be held still first:
    //  - state must be 'playing' (others damp toward their own speed)
    //  - collisions off (the penguin was DYING mid-measurement, damping to 0)
    //  - distance pinned each frame (update() advances it)
    g.collisions.check = () => [];
    const speedAt = (dist) => {
      g.fsm.set('playing', {}, true);
      g.speed = 0;
      for (const k in g.powers) g.powers[k] = 0;
      for (let i = 0; i < 2000; i++) {
        g.distance = dist;
        g.fsm.current = 'playing';
        g.update(1 / 60);
      }
      g.obstacles.reset(); g.collectibles.reset();
      return g.speed;
    };

    // Prove the solvability guard is live and not just decoration: hand it a
    // row with no answer and require a refusal.
    g.obstacles.reset();
    const guard = {
      blockedTrap: false, allowsSharedVerb: true, blocksDoubleBooking: false
    };
    g.obstacles._emit('iceberg', 0, 500);          // dodge
    g.obstacles._emit('arch', 1, 500);             // slide
    guard.blockedTrap = g.obstacles._emit('hole', 2, 500) === false;  // jump → no answer
    guard.blocksDoubleBooking = g.obstacles._emit('seal', 0, 500) === false;
    g.obstacles.reset();
    g.obstacles._emit('hole', 0, 700);
    g.obstacles._emit('hole', 1, 700);
    guard.allowsSharedVerb = g.obstacles._emit('hole', 2, 700) === true; // all jump → fine
    g.obstacles.reset();

    // Sample the SHIPPED curve, then interpolate that table to drive the
    // simulation. Re-typing the formula here would let the harness drift out
    // of sync with the game and quietly report on a game nobody plays.
    const table = [];
    for (let d = 0; d <= 6000; d += 250) table.push([d, speedAt(d)]);
    const speedOf = (dist) => {
      if (dist >= 6000) return table[table.length - 1][1];
      const i = Math.floor(dist / 250);
      const a = table[i], b = table[i + 1];
      return a[1] + (b[1] - a[1]) * ((dist - a[0]) / 250);
    };
    const difficultyOf = (dist) => {
      // difficulty is the same normalised progress the speed rides.
      const lo = table[0][1], hi = 45;
      return (speedOf(dist) - lo) / (hi - lo);
    };

    const om = g.obstacles;
    let unsolvable = 0, overlaps = 0, total = 0, refused = 0;
    const gaps = [];

    const realEmit = om._emit.bind(om);
    om._emit = function (t, l, z) { const ok = realEmit(t, l, z); if (!ok) refused++; return ok; };

    for (let run = 0; run < 40; run++) {
      om.reset();
      let worldZ = 0, dist = 0;
      const pattern = [];
      const realPattern = om._pattern.bind(om);
      om._pattern = function (z, d) {
        const before = om.list.length;
        const ext = realPattern(z, d);
        const added = om.list.slice(before);
        if (added.length) {
          pattern.push({ z, d, maxZ: Math.max.apply(null, added.map((o) => o.z0)) });
        }
        return ext;
      };

      while (dist < 3000) {
        const speed = speedOf(dist);
        worldZ += speed * 0.05; dist += speed * 0.05;
        om.update(0.05, worldZ, speed, difficultyOf(dist));
      }
      om._pattern = realPattern;

      for (let i = 1; i < pattern.length; i++) {
        total++;
        if (pattern[i].z < pattern[i - 1].maxZ + 0.5) overlaps++;
        // Time from clearing the last hazard to reaching the next one.
        gaps.push((pattern[i].z - pattern[i - 1].maxZ) / speedOf(pattern[i].z));
      }

      // Solvability over the whole generated world, at real row tolerance.
      const zs = om.list.map((o) => o.z0).sort((a, b) => a - b);
      for (const z of zs) {
        const lanes = [null, null, null];
        for (const o of om.list) {
          if (Math.abs(o.z0 - z) >= 4.5) continue;
          if (SPEC[o.type].allLanes) { for (let l = 0; l < 3; l++) lanes[l] = lanes[l] || SPEC[o.type].verb; }
          else lanes[o.lane] = SPEC[o.type].verb;
        }
        if (lanes.indexOf(null) >= 0) continue;         // an empty lane = an answer
        if (lanes[0] === lanes[1] && lanes[1] === lanes[2]) continue; // one input clears it
        unsolvable++;
      }
    }
    om._emit = realEmit;

    gaps.sort((a, b) => a - b);
    const curve = [];
    for (const d of [0, 250, 500, 1000, 2000, 3000, 5000]) curve.push([d, +speedOf(d).toFixed(1)]);

    return {
      curve, unsolvable, overlaps, total, refused, guard,
      gapMin: +gaps[0].toFixed(2),
      gapP10: +gaps[Math.floor(gaps.length * 0.1)].toFixed(2),
      gapMedian: +gaps[gaps.length >> 1].toFixed(2)
    };
  });

  console.log('\n  SPEED CURVE (distance → m/s)');
  console.log('  ' + r.curve.map(([d, s]) => d + 'm:' + s).join('   '));
  console.log('\n  PATTERN OVERLAP:    ' + r.overlaps + ' / ' + r.total + '  (' +
    (100 * r.overlaps / r.total).toFixed(1) + '%)');
  console.log('  UNSOLVABLE SLICES:  ' + r.unsolvable);
  console.log('  REFUSED IN 40 RUNS: ' + r.refused + ' (0 is expected — the guard is a net, not the mechanism)');
  console.log('\n  GUARD IS ALIVE (direct probes)');
  console.log('    refuses jump+slide+dodge row   ' + (r.guard.blockedTrap ? 'yes' : 'NO — GUARD IS DEAD'));
  console.log('    refuses double-booking a lane  ' + (r.guard.blocksDoubleBooking ? 'yes' : 'NO'));
  console.log('    allows all-jump full-width row ' + (r.guard.allowsSharedVerb ? 'yes' : 'NO — TOO STRICT'));
  console.log('\n  THINKING TIME between hazards (seconds)');
  console.log('    min ' + r.gapMin + '    p10 ' + r.gapP10 + '    median ' + r.gapMedian);

  const bad = [];
  if (!r.guard.blockedTrap) bad.push('solvability guard does not actually refuse a death trap');
  if (!r.guard.allowsSharedVerb) bad.push('guard wrongly refuses a legal full-width row');
  if (r.overlaps > 0) bad.push('patterns still overlap');
  if (r.unsolvable > 0) bad.push('unsolvable slices exist');
  if (r.gapMin < 0.62) bad.push('min thinking time below human reaction+decision (' + r.gapMin + 's)');
  if (r.curve[1][1] > 24) bad.push('too fast at 250m (' + r.curve[1][1] + ')');
  if (r.curve[3][1] > 32) bad.push('too fast at 1km (' + r.curve[3][1] + ')');
  console.log(bad.length ? '\n  FAIL: ' + bad.join('; ') : '\n  PASS: generator is fair');
  await b.close();
  process.exit(bad.length ? 1 : 0);
})();
