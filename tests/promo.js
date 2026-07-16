/* Promo recorder — drives a staged showcase run and records it.
   Usage: node promo.js landscape | portrait
   Output: raw .webm in promo/raw/, converted by promo-convert step.
   NOTE: Playwright captures no audio; the video is silent by design. */
const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');
const ROOT = require('path').resolve(__dirname, '..');
const url = 'file:///' + path.join(ROOT, 'index.html').split(path.sep).join('/');
const MODE = process.argv[2] || 'landscape';
const SIZE = MODE === 'portrait' ? { width: 720, height: 1280 } : { width: 1280, height: 720 };
const RAW = path.join(ROOT, 'promo', 'raw');
fs.mkdirSync(RAW, { recursive: true });

/* Caption overlay injected into the page — glassmorphism chip, game-styled.
   Sizing rule for social video: main line ≈ 4.5% of frame height, or it is
   unreadable on a phone. Portrait additionally sits at bottom 22% because
   IG/Reels UI (caption, actions) covers roughly the bottom fifth of the
   frame — anything placed there is decoration for the algorithm, not text. */
const PORTRAIT = MODE === 'portrait';
const EN_PX = PORTRAIT ? 46 : 34;
const ZH_PX = PORTRAIT ? 32 : 24;
// Upper-middle, not bottom: the penguin lives at bottom-centre, and a caption
// there sits right on top of the main character. Below the HUD, above the
// action — the sky region is the one part of the frame nothing plays in.
const TOP = PORTRAIT ? '13%' : '15%';
const CAPTION_CSS = `
  #promoCap {
    position: fixed; left: 50%; top: ${TOP};
    transform: translateX(-50%) translateY(-28px);
    z-index: 9999; pointer-events: none; opacity: 0;
    width: max-content; max-width: 92vw;
    padding: ${PORTRAIT ? '22px 30px' : '18px 34px'}; border-radius: 26px; text-align: center;
    background: rgba(8, 24, 46, .74);
    border: 1.5px solid rgba(180, 234, 255, .38);
    backdrop-filter: blur(18px); -webkit-backdrop-filter: blur(18px);
    box-shadow: 0 18px 50px rgba(0,12,30,.65);
    font-family: "Avenir Next","Segoe UI",sans-serif;
    transition: opacity .45s ease, transform .45s cubic-bezier(.16,1,.3,1);
  }
  #promoCap.show { opacity: 1; transform: translateX(-50%) translateY(0); }
  #promoCap .en {
    font-size: ${EN_PX}px; line-height: 1.22; font-weight: 900; letter-spacing: .04em;
    color: #ffffff;
    text-shadow: 0 0 26px rgba(120,226,255,.85), 0 3px 10px rgba(0,0,0,.7);
  }
  #promoCap .zh {
    font-size: ${ZH_PX}px; line-height: 1.35; font-weight: 700; color: #cdeeff;
    margin-top: 8px; text-shadow: 0 2px 8px rgba(0,0,0,.7);
  }
`;

(async () => {
  const b = await chromium.launch({ headless: false, args: ['--enable-gpu-rasterization', '--ignore-gpu-blocklist'] });
  const ctx = await b.newContext({
    viewport: SIZE,
    recordVideo: { dir: RAW, size: SIZE }
  });
  const p = await ctx.newPage();
  p.on('pageerror', (e) => console.log('ERR', e.message));
  await p.goto(url, { waitUntil: 'load' });
  await p.addStyleTag({ content: CAPTION_CSS });
  await p.evaluate(() => {
    const d = document.createElement('div');
    d.id = 'promoCap';
    d.innerHTML = '<div class="en"></div><div class="zh"></div>';
    document.body.appendChild(d);
  });

  const cap = async (en, zh, holdMs) => {
    await p.evaluate(([en, zh]) => {
      const d = document.getElementById('promoCap');
      d.querySelector('.en').textContent = en;
      d.querySelector('.zh').textContent = zh;
      d.classList.add('show');
    }, [en, zh]);
    await p.waitForTimeout(holdMs);
    await p.evaluate(() => document.getElementById('promoCap').classList.remove('show'));
  };
  const sleep = (ms) => p.waitForTimeout(ms);

  // Dress the penguin + seed a lived-in save so the menu looks real.
  await p.evaluate(() => {
    const g = window.__game;
    g.progress.deposit(999);
    for (const id of ['scarf_teal', 'body_emperor', 'trail_aurora']) { g.progress.buy(id); }
    g.equipItem('scarf_teal'); g.equipItem('body_emperor'); g.equipItem('trail_aurora');
    g.best = 4210; g.ui.setMenu(g.best);
  });

  /* Safety net: fatal hits vanish the obstacle instead (looks like a clean
     dodge at speed); everything else — pickups, near-misses — stays real. */
  const armour = () => p.evaluate(() => {
    const g = window.__game;
    if (!window.__real) window.__real = g.collisions.check.bind(g.collisions);
    g.collisions.check = function () {
      const ev = window.__real.apply(null, arguments);
      return ev.filter((e) => {
        if (e.kind !== 'hit') return true;
        const i = g.obstacles.list.indexOf(e.obstacle);
        if (i >= 0) g.obstacles.list.splice(i, 1);
        return false;
      });
    };
  });
  const disarm = () => p.evaluate(() => { window.__game.collisions.check = window.__real; });

  /* A capable autopilot so the play looks intentional. */
  await p.evaluate(() => {
    const g = window.__game;
    const SPEC = window.ObstacleManager.SPEC;
    let cool = 0;
    g.__botTick = function (dt) {
      if (g.fsm.current !== 'playing') return;
      cool -= dt;
      const pl = g.player;
      const ahead = g.obstacles.list.filter(o => o.z > 1 && o.z < 50).sort((a, b) => a.z - b.z);
      // chase fish when safe
      const fish = g.collectibles.list.filter(c => !c.taken && c.z > 2 && c.z < 26 && !window.CollectibleManager.SPEC[c.type].power === false);
      if (ahead.length) {
        const z0 = ahead[0].z;
        const row = ahead.filter(o => o.z < z0 + 4.5);
        const lanes = [null, null, null];
        for (const o of row) {
          if (SPEC[o.type].allLanes) { for (let l = 0; l < 3; l++) lanes[l] = lanes[l] || SPEC[o.type].verb; }
          else lanes[o.lane] = SPEC[o.type].verb;
        }
        const free = [0, 1, 2].filter(l => !lanes[l]);
        if (!lanes[pl.lane]) { /* safe */ }
        else if (free.length && cool <= 0) {
          free.sort((a, b) => Math.abs(a - pl.lane) - Math.abs(b - pl.lane));
          pl.moveLane(Math.sign(free[0] - pl.lane)); cool = 0.24;
        }
        const mine = row.find(o => SPEC[o.type].allLanes || o.lane === pl.lane);
        if (mine) {
          const tti = z0 / Math.max(1, g.speed);
          if (SPEC[mine.type].verb === 'jump' && tti < 0.4 && pl.onGround) pl.jump();
          if (SPEC[mine.type].verb === 'slide' && tti < 0.22 && pl.onGround) pl.slide();
        }
      } else if (cool <= 0 && fish.length) {
        const near = fish.sort((a, b) => a.z - b.z)[0];
        const lane = window.WORLD.LANES.reduce((best, lx, i) => Math.abs(lx - near.x) < Math.abs(window.WORLD.LANES[best] - near.x) ? i : best, 1);
        if (lane !== pl.lane) { pl.moveLane(Math.sign(lane - pl.lane)); cool = 0.28; }
      }
    };
    if (!g.__hooked) {
      const real = g.update.bind(g);
      g.update = function (dt) { real(dt); if (g.__botTick) g.__botTick(dt); };
      g.__hooked = true;
    }
  });

  /* ═══ THE SHOW ═══ */
  const LONG = MODE === 'landscape';

  // Scene 1: menu
  await sleep(600);
  await cap('100% PROCEDURAL. ZERO ASSETS.', '每一個像素、每一個音符，全部即時運算生成', LONG ? 2600 : 2000);

  // Scene 2: into the run
  await p.evaluate(() => window.__game.start());
  await p.waitForFunction(() => window.__game.fsm.current === 'playing', { timeout: 12000 });
  await armour();
  await sleep(LONG ? 4500 : 3000);
  await cap('JUMP · DODGE · SLIDE', '三個動作，一個原則：剪影就是答案', LONG ? 2800 : 2200);
  await sleep(LONG ? 2500 : 1200);

  // Scene 3: magnet + fish rain
  await p.evaluate(() => {
    const g = window.__game;
    g.powers.magnet = 9;
    for (let i = 0; i < 3; i++) g.collectibles.layTrail('zig', i % 2 === 0 ? 0 : 2, g.worldZ + 14 + i * 12, 6, 'fish');
  });
  await cap('MAGNET UP — VACUUM EVERYTHING', '磁鐵：11 公尺內的魚全是你的', 2600);
  await sleep(2200);

  // Scene 4: cocoa rampage
  await p.evaluate(() => {
    const g = window.__game;
    g.powers.cocoa = 5.5;
    for (let i = 0; i < 4; i++) g.obstacles._emit(i % 2 ? 'iceberg' : 'crystal', i % 3, g.worldZ + 16 + i * 9);
  });
  await cap('HOT COCOA — SMASH THROUGH', '熱可可：無敵衝刺，撞碎一切', 3200);
  await sleep(1800);

  if (LONG) {
    // Scene 5: blizzard
    await p.evaluate(() => { window.__game.distance = 940; });
    await sleep(2200);
    await cap('DYNAMIC WEATHER — BLIZZARD', '生態區天氣：暴風雪', 2600);
    await sleep(1400);

    // Scene 6: aurora storm + crystal + celebrate
    await p.evaluate(() => { window.__game.distance = 2050; });
    await sleep(1800);
    await p.evaluate(() => {
      const g = window.__game;
      g.collectibles._emit('auroraCrystal', window.WORLD.LANES[g.player.lane], 1.0, g.worldZ + 12);
    });
    await sleep(1400);
    await cap('AURORA STORM — THE SKY ANSWERS', '極光風暴：整片天空為你脈動', 3000);
    await sleep(1200);

    // Scene 7: movers
    await p.evaluate(() => {
      const g = window.__game;
      g.obstacles.list.length = 0;
      g.obstacles._emit('slider', 1, g.worldZ + 30);
      g.obstacles._emit('roller', 1, g.worldZ + 55);
    });
    await cap('MOVING HAZARDS', '會動的障礙：滑行海豹與衝刺雪球', 3000);
    await sleep(1500);
  }

  // Scene 8: death → revive
  await disarm();
  await p.evaluate(() => {
    const g = window.__game;
    g.progress.d.bank = Math.max(g.progress.d.bank, 120);
    g.obstacles.list.length = 0;
    g.obstacles._emit('iceberg', g.player.lane, g.worldZ + 10);
    g.__botTick = null;                       // let it hit
  });
  await p.waitForFunction(() => window.__game.fsm.current === 'reviveOffer', { timeout: 15000 });
  await cap('DOWN? SPEND FISH. GET UP.', '花魚復活 —— 死亡只是一個決定', 2300);
  await p.evaluate(() => window.__game.reviveAccept());
  await p.waitForFunction(() => window.__game.fsm.current === 'playing', { timeout: 15000 });
  await armour();
  await p.evaluate(() => {
    const g = window.__game;
    // re-arm the bot for the finale
    g.__botTick = g.__botTick || null;
  });
  await sleep(LONG ? 2600 : 1800);

  // Scene 9: outro card over the live world. Portrait gets the URL on its
  // own line — a 46px URL crammed beside "PLAY FREE" wraps mid-domain.
  if (LONG) {
    await cap('PLAY FREE — game-polar-aurora.tingyudeco.com', '免費遊玩 · 手機電腦都能跑 · 可安裝離線玩', 3600);
  } else {
    await cap('PLAY FREE 免費遊玩', 'game-polar-aurora.tingyudeco.com', 3200);
  }
  await sleep(500);

  await ctx.close();                          // flushes the video
  const files = fs.readdirSync(RAW).filter(f => f.endsWith('.webm'))
    .map(f => ({ f, t: fs.statSync(path.join(RAW, f)).mtimeMs }))
    .sort((a, b) => b.t - a.t);
  const out = path.join(RAW, MODE + '.webm');
  if (fs.existsSync(out)) fs.unlinkSync(out);
  fs.renameSync(path.join(RAW, files[0].f), out);
  console.log('recorded → ' + out);
  await b.close();
})();
