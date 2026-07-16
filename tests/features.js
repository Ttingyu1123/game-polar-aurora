/* Feature tests for the meta-game: economy, wardrobe, missions, revive,
   daily determinism, biomes, movers, records, share, PWA. Same philosophy
   as qa.js — drive the real game, assert observable behaviour. */
const { chromium } = require('playwright');
const path = require('path');
const ROOT = require('path').resolve(__dirname, '..');
const url = 'file:///' + path.join(ROOT, 'index.html').split(path.sep).join('/');

const results = [];
function check(name, pass, detail) {
  results.push([name, pass]);
  console.log((pass ? '  PASS  ' : '  FAIL  ') + name + (detail ? '  :: ' + detail : ''));
}

(async () => {
  const browser = await chromium.launch({ headless: false, args: ['--enable-gpu-rasterization', '--ignore-gpu-blocklist'] });
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

  await page.goto(url, { waitUntil: 'load' });
  await page.waitForTimeout(1200);

  const waitPlaying = () => page.waitForFunction(() => window.__game.fsm.current === 'playing', { timeout: 12000 });
  const armour = () => page.evaluate(() => {
    const cs = window.__game.collisions;
    if (!window.__realCheck) window.__realCheck = cs.check.bind(cs);
    cs.check = function () { return window.__realCheck.apply(null, arguments).filter((e) => e.kind !== 'hit'); };
  });

  /* ── 1. economy: fish bank deposits on death ── */
  await page.evaluate(() => { localStorage.clear(); location.reload(); });
  await page.waitForTimeout(1400);
  const eco = await page.evaluate(async () => {
    const g = window.__game;
    g.start();
    await new Promise(r => { const w = () => (g.fsm.current === 'playing' ? r() : setTimeout(w, 50)); w(); });
    // collect 5 fish, then die with an unavoidable wall
    g.collectibles.list.length = 0;
    for (let i = 0; i < 5; i++) g.collectibles._emit('fish', g.player.x, g.player.y + 0.55, g.worldZ + 2 + i * 1.4);
    for (let i = 0; i < 130; i++) await new Promise(r => requestAnimationFrame(r));
    const fishGot = g.fish;
    g.progress.d.bank = 0;                       // isolate the deposit
    g.obstacles.list.length = 0; g.invuln = 0;
    for (const k in g.powers) g.powers[k] = 0;
    g.obstacles._emit('iceberg', g.player.lane, g.worldZ + 3);
    for (let i = 0; i < 400; i++) {
      await new Promise(r => requestAnimationFrame(r));
      if (g.fsm.current === 'over') break;
    }
    return { fishGot, state: g.fsm.current, bank: g.progress.bank };
  });
  check('fish are banked on death', eco.state === 'over' && eco.bank === eco.fishGot && eco.fishGot > 0,
    JSON.stringify(eco));

  /* ── 2. wardrobe: buy, equip, style applies, persists across reload ── */
  const ward = await page.evaluate(() => {
    const g = window.__game;
    g.progress.deposit(500);
    const before = g.player.style.scarf.base;
    const cantAfford = !g.buyItem('scarf_gilded_nonexistent');
    const bought = g.buyItem('scarf_teal');
    const after = g.player.style.scarf.base;
    return { cantAfford, bought, before, after,
             bank: g.progress.bank, owned: g.progress.owned('scarf_teal'),
             equipped: g.progress.equippedId('scarf') };
  });
  check('wardrobe purchase + auto-equip', ward.bought && ward.owned && ward.equipped === 'scarf_teal'
    && ward.after !== ward.before, JSON.stringify(ward));
  check('purchase deducts fish', ward.bank === 500 + eco.fishGot - 150, 'bank=' + ward.bank);

  await page.reload({ waitUntil: 'load' });
  await page.waitForTimeout(1200);
  const persist = await page.evaluate(() => ({
    equipped: window.__game.progress.equippedId('scarf'),
    styleApplied: window.__game.player.style.scarf.base,
    bank: window.__game.progress.bank
  }));
  check('wardrobe persists across reload', persist.equipped === 'scarf_teal' &&
    persist.styleApplied === '#2ec9a8', JSON.stringify(persist));

  /* ── 3. missions: complete one mid-run, reward lands ── */
  const mission = await page.evaluate(async () => {
    const g = window.__game;
    // Force a tiny fish mission so we can finish it deterministically.
    g.progress.d.missions = [{ id: 'runFish', stat: 'fish', scope: 'run', target: 3, reward: 30, name: 'Catch 3 fish in one run' }];
    const bank0 = g.progress.bank;
    g.start();
    await new Promise(r => { const w = () => (g.fsm.current === 'playing' ? r() : setTimeout(w, 50)); w(); });
    const cs = g.collisions; window.__realCheck = window.__realCheck || cs.check.bind(cs);
    cs.check = function () { return window.__realCheck.apply(null, arguments).filter((e) => e.kind !== 'hit'); };
    g.collectibles.list.length = 0;
    for (let i = 0; i < 4; i++) g.collectibles._emit('fish', g.player.x, g.player.y + 0.55, g.worldZ + 2 + i * 1.4);
    for (let i = 0; i < 140; i++) await new Promise(r => requestAnimationFrame(r));
    return {
      bankGain: g.progress.bank - bank0,
      missionsDone: g.progress.totals.missions,
      newMissionDrawn: g.progress.activeMissions().length === 3,
      replaced: !g.progress.activeMissions().some(m => m.id === 'runFish' && m.target === 3)
    };
  });
  check('mission completes mid-run and pays', mission.bankGain === 30 && mission.missionsDone >= 1,
    JSON.stringify(mission));
  check('completed mission is replaced', mission.newMissionDrawn && mission.replaced, JSON.stringify(mission));

  /* ── 4. revive: offer appears, costs fish, run continues ── */
  const revive = await page.evaluate(async () => {
    const g = window.__game;
    // The mission test armoured collisions; this test needs real death.
    if (window.__realCheck) g.collisions.check = window.__realCheck;
    g.toMenu();
    g.progress.d.bank = 100; g.progress.save();
    g.start();
    await new Promise(r => { const w = () => (g.fsm.current === 'playing' ? r() : setTimeout(w, 50)); w(); });
    const distBefore = 1;                                  // any progress counts
    for (const k in g.powers) g.powers[k] = 0;
    g.invuln = 0;
    g.obstacles.list.length = 0;
    g.obstacles._emit('iceberg', g.player.lane, g.worldZ + 3);
    // Wait for the offer.
    for (let i = 0; i < 500; i++) {
      await new Promise(r => requestAnimationFrame(r));
      if (g.fsm.current === 'reviveOffer') break;
    }
    const offered = g.fsm.current === 'reviveOffer';
    const overlayVisible = !document.getElementById('revive').classList.contains('hidden');
    const scoreAtDeath = g.score;
    if (offered) g.reviveAccept();
    // Through the countdown back to playing.
    for (let i = 0; i < 600; i++) {
      await new Promise(r => requestAnimationFrame(r));
      if (g.fsm.current === 'playing') break;
    }
    return {
      offered, overlayVisible,
      backPlaying: g.fsm.current === 'playing',
      bank: g.progress.bank,
      keptScore: g.score >= scoreAtDeath,
      alive: !g.player.dead,
      revivedFlag: g._revived
    };
  });
  check('revive offer appears on death', revive.offered && revive.overlayVisible, JSON.stringify(revive));
  check('revive returns to play, keeps run, costs 40', revive.backPlaying && revive.alive &&
    revive.keptScore && revive.bank === 60, JSON.stringify(revive));

  const secondDeath = await page.evaluate(async () => {
    const g = window.__game;
    for (const k in g.powers) g.powers[k] = 0;
    g.invuln = 0;
    g.obstacles.list.length = 0;
    g.obstacles._emit('iceberg', g.player.lane, g.worldZ + 3);
    for (let i = 0; i < 500; i++) {
      await new Promise(r => requestAnimationFrame(r));
      if (g.fsm.current === 'over' || g.fsm.current === 'reviveOffer') break;
    }
    return { state: g.fsm.current };
  });
  check('second death gets NO second revive', secondDeath.state === 'over', JSON.stringify(secondDeath));

  /* ── 5. daily: identical layout across two starts ── */
  const daily = await page.evaluate(async () => {
    const g = window.__game;
    const grab = async () => {
      g.toMenu();
      g.start(true);
      await new Promise(r => { const w = () => (g.fsm.current === 'playing' ? r() : setTimeout(w, 50)); w(); });
      // Sample well beyond the visible horizon so we compare the GENERATOR,
      // not the frame timing.
      g.obstacles.update(0.001, g.worldZ, g.speed, 0, g.paceAt(0), 1);
      return g.obstacles.list.slice(0, 14).map(o => o.type + '@' + o.lane + '@' + o.z0.toFixed(1));
    };
    const a = await grab();
    const b = await grab();
    g.toMenu();
    const c = (() => { g.start(); return null; })();
    await new Promise(r => { const w = () => (g.fsm.current === 'playing' ? r() : setTimeout(w, 50)); w(); });
    const free = g.obstacles.list.slice(0, 14).map(o => o.type + '@' + o.lane + '@' + o.z0.toFixed(1));
    g.toMenu();
    return { same: JSON.stringify(a) === JSON.stringify(b),
             differsFromFree: JSON.stringify(a) !== JSON.stringify(free),
             sample: a.slice(0, 4) };
  });
  check('daily runs share one exact layout', daily.same, daily.sample.join(' '));
  check('free runs differ from the daily track', daily.differsFromFree);

  /* ── 6. biomes: parameters actually shift with distance ── */
  const biome = await page.evaluate(() => {
    const B = window.Biomes;
    const a = B.at(100), b = B.at(900), keys = [];
    for (let d = 0; d < 2400; d += 60) keys.push(B.at(d).key);
    return {
      first: a.key, second: b.key,
      distinct: [...new Set(keys)].length,
      blizzardThink: B.at(900).p.think,
      snowSwing: Math.abs(B.at(100).p.snow - B.at(900).p.snow) > 0.4
    };
  });
  check('biomes cycle (4 distinct moods)', biome.distinct === 4, JSON.stringify(biome));
  check('blizzard pays for legibility with think time', biome.blizzardThink > 1.05 && biome.snowSwing,
    'think=' + biome.blizzardThink);

  /* ── 7. movers: slider sweeps, roller closes, both jumpable, guard holds ── */
  const movers = await page.evaluate(async () => {
    const g = window.__game;
    g.start();
    await new Promise(r => { const w = () => (g.fsm.current === 'playing' ? r() : setTimeout(w, 50)); w(); });
    const cs = g.collisions;
    cs.check = function () { return window.__realCheck.apply(null, arguments).filter((e) => e.kind !== 'hit'); };
    g.obstacles.list.length = 0;
    g.obstacles._emit('slider', 1, g.worldZ + 40);
    g.obstacles._emit('roller', 1, g.worldZ + 70);
    const s0 = g.obstacles.list[0], r0 = g.obstacles.list[1];
    const x0 = s0.x, z0 = r0.z0 - g.worldZ;
    await new Promise(r => setTimeout(r, 900));
    const sweep = Math.abs(s0.x - x0);
    const rollerCloses = (r0.z0 - g.worldZ + r0.zOff) < z0 - (g.speed * 0.9) - 2;
    // Guard: a dodge hazard may NOT share a slider's row.
    const refused = g.obstacles._emit('iceberg', 0, s0.z0) === false;
    const verbs = window.ObstacleManager.SPEC.slider.verb === 'jump' &&
                  window.ObstacleManager.SPEC.roller.verb === 'jump';
    g.obstacles.list.length = 0;
    return { sweep: +sweep.toFixed(2), rollerCloses, refused, verbs };
  });
  check('slider sweeps across lanes', movers.sweep > 0.5, 'moved ' + movers.sweep + 'm laterally');
  check('roller outruns the world toward you', movers.rollerCloses, JSON.stringify(movers));
  check('movers are jump-verb and row-guarded', movers.verbs && movers.refused, JSON.stringify(movers));

  /* ── 8. records + share card ── */
  const rec = await page.evaluate(async () => {
    const g = window.__game;
    g.ui.openRecords();
    const visible = !document.getElementById('records').classList.contains('hidden');
    const runRows = document.querySelectorAll('.rec-run').length;
    const deathRows = document.querySelectorAll('.rec-death').length;
    g.ui.hide('records', true);
    // Share card: compose and measure — no DOM needed.
    g.score = 4321; g.distance = 987; g.fish = 55;
    const card = g.makeShareCard();
    const d = card.getContext('2d').getImageData(0, 0, card.width, card.height).data;
    let lit = 0;
    for (let i = 0; i < d.length; i += 4 * 1997) if (d[i] + d[i + 1] + d[i + 2] > 30) lit++;
    return { visible, runRows, deathRows, cardW: card.width, cardH: card.height, lit };
  });
  check('records screen renders history', rec.visible && rec.runRows >= 1 && rec.deathRows >= 1,
    JSON.stringify(rec));
  check('share card composes (1200×630, painted)', rec.cardW === 1200 && rec.cardH === 630 && rec.lit > 40,
    'lit=' + rec.lit);

  /* ── 9. PWA plumbing present ──
     fetch() is CORS-blocked on file://, so validate the files from disk and
     only the <link> wiring in the DOM. The full SW registration is verified
     against production after deploy. */
  const hasLink = await page.evaluate(() =>
    !!document.querySelector('link[rel="manifest"]') &&
    !!document.querySelector('link[rel="apple-touch-icon"]'));
  const fs = require('fs');
  let manifest = null;
  try { manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.webmanifest'), 'utf8')); } catch (e) {}
  const swTxt = fs.readFileSync(path.join(ROOT, 'sw.js'), 'utf8');
  const iconsOk = manifest && manifest.icons.every((i) =>
    fs.existsSync(path.join(ROOT, i.src)) && fs.statSync(path.join(ROOT, i.src)).size > 4000);
  const swAssetsExist = [...swTxt.matchAll(/'([^']+\.(?:js|css|png|webmanifest|html))'/g)]
    .map((m) => m[1]).filter((f) => !fs.existsSync(path.join(ROOT, f)));
  check('manifest valid + all icons exist', hasLink && /Polar Aurora/.test(manifest && manifest.name || '')
    && manifest.icons.length === 3 && iconsOk, JSON.stringify({ hasLink, iconsOk }));
  check('sw precache list matches real files', swAssetsExist.length === 0,
    swAssetsExist.length ? 'MISSING: ' + swAssetsExist.join(', ') : 'all present');

  // Manifest/SW fetches are CORS-noise on file:// — not game errors.
  const realErrors = errors.filter((e) => !/manifest\.webmanifest|sw\.js|CORS|ERR_FAILED/.test(e));
  check('no console errors across all feature tests', realErrors.length === 0, realErrors.slice(0, 3).join(' | '));

  await browser.close();
  const bad = results.filter(r => !r[1]).length;
  console.log('\n  ' + (results.length - bad) + '/' + results.length + ' feature checks passed');
  process.exit(bad ? 1 : 0);
})().catch((e) => { console.error('HARNESS CRASH', e); process.exit(2); });
