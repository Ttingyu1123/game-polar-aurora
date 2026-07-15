/* ═══════════════════════════════════════════════════════════
   Game — the orchestrator. Owns the loop, the shell state machine,
   scoring, the difficulty curve and every power-up timer.

   TIME
   dt is variable but CLAMPED to 1/30 s. Every system is written to be
   frame-rate independent (U.damp for springs, explicit integration for
   the jump), so this is smooth from 30 to 144 Hz with no interpolation
   layer. The clamp matters: without it, one 400 ms stall would teleport
   the penguin through a wall of icebergs.

   DIFFICULTY
   Speed rises on a curve that is steep early (the first 400 m must
   *feel* like it's building) and asymptotic late, so a 3000 m run is
   hard but still humanly readable. Obstacle spacing is derived from
   speed inside ObstacleManager, so the two can never drift apart.

   THE MENU IS THE GAME. In `menu` the world runs, the penguin runs, the
   aurora burns — just with no hazards. No separate title artwork exists,
   and the transition into a run is a countdown over a live scene.
   ═══════════════════════════════════════════════════════════ */
(function (global) {
  'use strict';

  const U = global.U;
  const W3 = global.WORLD;

  const SPEED_MIN = 17.5;       // opening pace — slow enough to read the ice
  const SPEED_MAX = 45;
  const RAMP_M = 3600;          // e-folding distance of the speed ramp
  const COMBO_WINDOW = 2.3;

  const POWER_TIME = { shield: 14, magnet: 9, cocoa: 5.5, multiplier: 10 };

  const REVIVE_COST = 40;       // bank fish for a second chance, once per run
  const REVIVE_WINDOW = 5;      // seconds to decide before the run ends itself

  class Game {
    constructor(canvas) {
      this.cam = new global.Camera();
      this.renderer = new global.Renderer(canvas);
      this.audio = new global.AudioManager();
      this.input = new global.InputManager();
      this.particles = new global.ParticleSystem(this.cam);
      this.bg = new global.BackgroundRenderer(this.cam);
      this.ground = new global.GroundRenderer(this.cam, this.bg);
      this.player = new global.Player(this.cam, this.particles, this.audio);
      this.obstacles = new global.ObstacleManager(this.cam, this.particles);
      this.collectibles = new global.CollectibleManager(this.cam, this.particles);
      this.collisions = new global.CollisionSystem();
      this.ui = new global.UIManager(this);
      this.progress = new global.Progress();

      this.worldZ = 0;
      this.speed = SPEED_MIN;
      this.speed01 = 0;
      this.difficulty = 0;
      this.distance = 0;
      this.score = 0;
      this.fish = 0;
      this.combo = 0;
      this.comboT = 0;
      this.best = U.Store.get('pa_best', 0);
      this.deathFade = 0;
      this.timeScale = 1;
      this.invuln = 0;
      this.powers = { shield: 0, magnet: 0, cocoa: 0, multiplier: 0 };

      // Per-run mission counters. `dist`, `fish` etc. mirror the run's live
      // values; run-scoped missions read these, lifetime ones read totals.
      this.runStats = this._freshRunStats();
      this.daily = false;              // is this run today's seeded track?
      this._revived = false;           // one revive per run, no exceptions
      this._deathCause = null;
      this._reviveT = 0;
      this._biomeKey = '';
      this._trailAcc = 0;
      this._missionCheckT = 0;
      this._shareSnap = null;          // canvas frozen at the moment of death

      this._windMul = 1;
      this._last = 0;
      this._raf = 0;
      this._acc = 0;
      this._fpsT = 0; this._fpsN = 0; this._fpsShow = false;
      this._streak = 0;

      // `boot` exists so constructing the machine cannot fire an enter
      // handler before init() has cached the DOM. States are entered only
      // once everything they touch is alive.
      this.fsm = new global.StateMachine({
        boot:      {},
        menu:      { enter: () => this._enterMenu() },
        countdown: { enter: () => this._enterCountdown(), update: (dt, t) => this._countdown(dt, t) },
        playing:   { enter: () => this.ui.setPlaying() },
        paused:    {},
        dying:     { enter: () => this._enterDying(), update: (dt, t) => this._dying(dt, t) },
        reviveOffer: { enter: () => this._enterRevive(), update: (dt) => this._reviveTick(dt) },
        over:      {}
      }, 'boot', {
        boot: ['menu'],
        menu: ['countdown'],
        countdown: ['playing', 'menu'],
        playing: ['paused', 'dying', 'menu'],
        paused: ['playing', 'countdown', 'menu'],
        dying: ['reviveOffer', 'over', 'menu'],
        reviveOffer: ['countdown', 'over', 'menu'],
        over: ['countdown', 'menu']
      });
    }

    _freshRunStats() {
      return { fish: 0, dist: 0, near: 0, combo: 0, golden: 0, power: 0,
               slide: 0, jump: 0, smash: 0, arch: 0 };
    }

    /** Analytic target speed at a distance — same curve the damper chases.
     *  Spawning budgets use THIS, not the live speed: the damped value varies
     *  with frame timing, and a seeded daily layout must not. */
    paceAt(dist) {
      return U.lerp(SPEED_MIN, SPEED_MAX, 1 - Math.exp(-dist / RAMP_M));
    }

    /* ── boot ──────────────────────────────────────────────── */
    init() {
      this.ui.init();
      this.ui.buildHelp(this.collectibles);
      this.renderer.resize(this.cam);
      // Pool sized for the blizzard maximum; calm biomes draw a subset.
      this.particles.initSnow(430);
      this.player.setStyle(this.progress.style());
      this.player.reset();
      this.obstacles.reset();
      this.collectibles.reset();

      window.addEventListener('resize', () => this.renderer.resize(this.cam));
      window.addEventListener('orientationchange', () => setTimeout(() => this.renderer.resize(this.cam), 120));
      document.addEventListener('visibilitychange', () => {
        if (document.hidden && this.fsm.is('playing')) this.togglePause();
      });

      this.input.attach(this.renderer.canvas);
      this.input.on('pause', () => {
        if (this.fsm.isAny('playing', 'paused')) this.togglePause();
      });
      this.input.on('mute', () => this.ui.syncSound(this.audio.toggleMute()));
      this.input.on('fps', () => { this._fpsShow = !this._fpsShow; this.ui.setFps(this._fpsShow ? '' : null); });
      this.input.on('confirm', () => {
        if (this.fsm.is('menu')) this.start();
        else if (this.fsm.is('over')) this.start();
        else if (this.fsm.is('paused')) this.resume();
      });
      // The first gesture anywhere unlocks audio — browsers require it.
      this.input.on('any', () => this._unlock());

      this.fsm.set('menu');

      this._last = performance.now();
      this._raf = requestAnimationFrame((t) => this._loop(t));
      return this;
    }

    _unlock() {
      if (this._unlocked) return;
      this._unlocked = true;
      this.audio.init();
      this.audio.resume();
      this.audio.setWind(0.25);
      this.ui.syncSound(this.audio.muted);
    }

    /* ── shell transitions ─────────────────────────────────── */
    _enterMenu() {
      this.ui.setMenu(this.best);
      // Menu world is always the free-run generator, never the daily seed.
      this.daily = false;
      this.obstacles.setSeed(null);
      this.collectibles.setSeed(null);
      this.player.reset();
      this.obstacles.reset();
      this.collectibles.reset();
      this.particles.clear();
      this.cam.reset();
      this.worldZ = U.rand(0, 400);          // a different vista every visit
      this.speed = 15;
      this.speed01 = 0;
      this.difficulty = 0;
      this.distance = 0; this.score = 0; this.fish = 0; this.combo = 0;
      this.deathFade = 0; this.timeScale = 1; this.invuln = 0;
      for (const k in this.powers) this.powers[k] = 0;
      this.runStats = this._freshRunStats();
      this._revived = false;
      this._deathCause = null;
      this._shareSnap = null;
      this._biomeKey = '';
      this.audio.stopMusic(0.4);
      this.audio.setWind(0.22);
      this.input.setEnabled(false);
    }

    /** @param {boolean} [daily] run today's seeded track instead of free run */
    start(daily) {
      this._unlock();
      if (!this.fsm.isAny('menu', 'over', 'paused')) return;
      // Always reset through the menu state so there is exactly one reset
      // routine — `force` because over→menu and paused→menu are both legal
      // but we want the enter handler regardless of where we came from.
      this.fsm.set('menu', {}, true);
      if (daily) {
        // Same date → same seed → same track for everyone, everywhere. The
        // layout is a pure function of distance because spawn budgets use
        // paceAt(), not the frame-timing-dependent damped speed.
        this.daily = true;
        const seed = global.Progress.todaySeed();
        this.obstacles.setSeed(seed);
        this.collectibles.setSeed(seed);
        this.obstacles.reset();
        this.collectibles.reset();
        this.worldZ = 0;
      }
      this._countReset = true;
      this.fsm.set('countdown');
    }

    /** Shared by a fresh run and by un-pausing; `_countReset` is the only
     *  difference, so the two paths can never drift out of sync. */
    _enterCountdown() {
      this.ui.setPlaying();
      if (this._countReset) {
        this.worldZ = 0;
        this.speed = SPEED_MIN * 0.62;
      }
      this._countStep = -1;
      this.input.setEnabled(false);
      this.input.flush();
      this.audio.resume();
      this.audio.startMusic();
      this.audio.setIntensity(this._countReset ? 0.1 : 0.3 + this.speed01 * 0.5);
    }

    _countdown(dt, t) {
      const step = Math.floor(t / 0.62);
      if (step !== this._countStep) {
        this._countStep = step;
        if (step < 3) {
          this.ui.countdown(String(3 - step));
          this.audio.countBeep(false);
        } else if (step === 3) {
          this.ui.countdown('GO!');
          this.audio.countBeep(true);
          this.player.lookBack(0.5);
          this.player.setExpr('determined', 1);
        } else {
          this.ui.endCountdown();
          this.input.setEnabled(true);
          this.fsm.set('playing');
        }
      }
    }

    togglePause() {
      if (this.fsm.is('playing')) {
        this.fsm.set('paused');
        this.ui.setPaused(Math.floor(this.score), Math.floor(this.distance), this.fish);
        this.input.setEnabled(false);
        this.audio.stopMusic(0.15);
        this.audio.setWind(0.05);
      } else if (this.fsm.is('paused')) {
        this.resume();
      }
    }

    resume() {
      if (!this.fsm.is('paused')) return;
      this.ui.hide('pause');
      this._countReset = false;        // keep the run; just count us back in
      this.fsm.set('countdown');
    }

    toMenu() { this.fsm.set('menu', {}, true); }

    _enterDying() {
      this.input.setEnabled(false);
      this.audio.stopMusic(0.5);
      this.audio.hit();
      this.cam.addTrauma(0.95);
      this.renderer.setFlash(255, 190, 170, 0.75);
      this.timeScale = 0.28;

      // Freeze the moment of death for the share card, before the red wash
      // and any overlay dulls it. The canvas holds only the world (UI is
      // DOM), so this snapshot is a clean, authentic frame of the run.
      try {
        const src = this.renderer.canvas;
        const snap = U.makeCanvas(Math.min(1200, src.width), 0);
        snap.height = Math.round(snap.width * src.height / src.width);
        snap.getContext('2d').drawImage(src, 0, 0, snap.width, snap.height);
        this._shareSnap = snap;
      } catch (e) { this._shareSnap = null; }
    }

    _dying(dt, t) {
      this.deathFade = U.clamp(t / 1.1, 0, 1);
      this.timeScale = U.lerp(0.28, 0.02, U.clamp(t / 1.4, 0, 1));
      if (t > 1.25) {
        // A second chance is offered exactly once per run, and only if the
        // bank can actually pay — a revive button you can't afford is salt.
        if (!this._revived && this.progress.bank >= REVIVE_COST) {
          this.fsm.set('reviveOffer');
        } else if (t > 1.5) {
          this._finishRun();
        }
      }
    }

    /* ── revive ────────────────────────────────────────────── */
    _enterRevive() {
      this._reviveT = REVIVE_WINDOW;
      this.ui.showRevive(REVIVE_COST, this.progress.bank);
    }

    _reviveTick(dt) {
      this._reviveT -= dt;
      this.ui.tickRevive(this._reviveT / REVIVE_WINDOW);
      if (this._reviveT <= 0) this.reviveDecline();
    }

    reviveAccept() {
      if (!this.fsm.is('reviveOffer')) return;
      if (!this.progress.spend(REVIVE_COST)) { this.reviveDecline(); return; }
      this._revived = true;
      this.ui.hideRevive();

      // Stand him back up.
      const p = this.player;
      p.dead = false; p.hitSpin = 0; p.flash = 0;
      p.y = 0; p.vy = 0; p.onGround = true;
      p.fsm.set('run', {}, true);
      p.setExpr('happy', 1.2);
      p.lookBack(1.0);

      // Clear the neighbourhood — reviving into the same iceberg is a scam.
      this.obstacles.list = this.obstacles.list.filter((o) => o.z < -5 || o.z > 42);
      this.invuln = 2.4;
      this.deathFade = 0;
      this.timeScale = 1;
      this._deathCause = null;
      this.combo = 0; this.comboT = 0;
      this.audio.revive();
      this.particles.pickupBurst(p.x, 0.8, 0.3, [255, 160, 90], true);
      this.renderer.setFlash(255, 190, 120, 0.4);

      // Re-enter through the countdown WITHOUT resetting the run — the same
      // path resume() uses, so there is still exactly one way back in.
      this._countReset = false;
      this.fsm.set('countdown');
    }

    reviveDecline() {
      if (!this.fsm.is('reviveOffer')) return;
      this.ui.hideRevive();
      this._finishRun();
    }

    /** The one and only end-of-run bookkeeping path. */
    _finishRun() {
      const score = Math.floor(this.score);
      const isBest = score > this.best;
      if (isBest) {
        this.best = score;
        U.Store.set('pa_best', this.best);
        this.audio.newBest();
      }
      this.audio.gameOver();

      // Run fish become bank fish — death keeps your catch. This is what
      // makes losing feel like progress instead of waste.
      this.progress.deposit(this.fish);
      this.progress.tally('fish', 0, this.runStats);   // final run-scope check
      this.progress.recordRun({
        score, dist: this.distance, fish: this.fish,
        cause: this._deathCause, daily: this.daily,
        date: global.Progress.todayKey()
      });

      this.ui.setGameOver(score, Math.floor(this.distance), this.fish, this.best, isBest, {
        daily: this.daily,
        dailyBest: this.progress.dailyBest(global.Progress.todayKey()),
        bank: this.progress.bank
      });
      this.fsm.set('over');
    }

    /* ── loop ──────────────────────────────────────────────── */
    _loop(now) {
      this._raf = requestAnimationFrame((t) => this._loop(t));
      const frameMs = now - this._last;
      this._last = now;

      // Clamp: a stall must cost frames, never correctness.
      let dt = Math.min(frameMs, 33.4) / 1000;
      if (dt <= 0) dt = 1 / 60;

      this.update(dt);
      this.render();

      // Feed the governor WALL time, not JS time — see Renderer.sample.
      // `resize` means the DPR cap changed and the canvas must follow.
      if (this.renderer.sample(frameMs) === 'resize') {
        this.renderer.resize(this.cam);
      }
      const q = this.renderer.quality;
      this.particles.quality = q; this.bg.quality = q;
      this.ground.quality = q; this.obstacles.quality = q; this.collectibles.quality = q;

      if (this._fpsShow) {
        this._fpsN++; this._fpsT += frameMs;
        if (this._fpsT > 480) {
          const fps = (this._fpsN * 1000 / this._fpsT).toFixed(0);
          this.ui.setFps(fps + ' fps · q' + q.toFixed(2) + ' · p' + this.particles.count +
                         ' · o' + this.obstacles.list.length + ' · c' + this.collectibles.list.length);
          this._fpsT = 0; this._fpsN = 0;
        }
      }
    }

    update(dt) {
      this.fsm.update(dt);
      const st = this.fsm.current;

      if (st === 'paused' || st === 'over' || st === 'reviveOffer') {
        // Keep the sky alive under the panels — a frozen backdrop looks broken.
        this.bg.update(dt * 0.35, this.worldZ);
        this.particles.updateSnow(dt * 0.35, this.speed * 0.2);
        this.cam.update(dt, this._camTarget());
        this.renderer.update(dt);
        return;
      }

      const scaled = dt * this.timeScale;
      this.input.update(dt);

      /* ── speed & difficulty ── */
      if (st === 'playing') {
        // A plain exponential approach: 1 − e^(−d/k). Gentle early, never
        // quite arrives, so there is always a little more run left.
        //
        // The previous curve (outExpo) was violently front-loaded — measured
        // at 25.5 m/s by 100 m and 43.2 by 1000 m, i.e. 96 % of top speed
        // before most players had learned the verbs. Now: ~22 at 250 m, ~28
        // at 1 km, ~37 at 3 km. Difficulty rides the same number so pattern
        // selection and pacing can never drift apart.
        const t = 1 - Math.exp(-this.distance / RAMP_M);
        const target = U.lerp(SPEED_MIN, SPEED_MAX, t);
        this.speed = U.damp(this.speed, target * (this.powers.cocoa > 0 ? 1.16 : 1), 0.02, scaled);
        this.difficulty = t;
      } else if (st === 'countdown') {
        this.speed = U.damp(this.speed, SPEED_MIN, 0.04, scaled);
      } else if (st === 'menu') {
        this.speed = U.damp(this.speed, 15, 0.03, scaled);
      } else if (st === 'dying') {
        this.speed = U.damp(this.speed, 0, 0.05, dt);
      }
      this.speed01 = U.clamp((this.speed - SPEED_MIN) / (SPEED_MAX - SPEED_MIN), 0, 1);

      const dz = this.speed * scaled;
      this.worldZ += dz;
      if (st === 'playing') {
        this.distance += dz;
        this.runStats.dist = this.distance;
        // Distance missions tick on a half-second cadence, not per frame.
        this._missionCheckT -= scaled;
        if (this._missionCheckT <= 0) {
          this._missionCheckT = 0.5;
          this._missionDone(this.progress.tally('dist', 0, this.runStats));
        }
      }

      /* ── biome ── */
      // The weather follows the run. Same source drives the sky, snow, wind,
      // fish density AND the spawner's thinking-time budget, so a biome can
      // never change legibility without paying for it.
      const biome = global.Biomes.at(st === 'playing' ? this.distance : 120);
      this.bg.envAurora = biome.p.aurora;
      this.bg.cloudMul = biome.p.cloud;
      this.bg.moonMul = biome.p.moon;
      this.particles.snowMul = biome.p.snow;
      this.collectibles.fishMul = biome.p.fish;
      this.collectibles.crystalMul = biome.p.crystal;
      this._windMul = biome.p.wind;
      if (st === 'playing' && biome.key !== this._biomeKey) {
        if (this._biomeKey) {                        // don't announce the first
          this.ui.combo(biome.name, '#a5dcf7');
          this.audio.ui();
        }
        this._biomeKey = biome.key;
      }

      /* ── input ── */
      if (st === 'playing') {
        if (this.input.consume('left')) this.player.moveLane(-1);
        if (this.input.consume('right')) this.player.moveLane(1);
        if (this.input.consume('jump') && this.player.jump()) {
          this._missionDone(this.progress.tally('jump', 1, this.runStats));
          this.runStats.jump++;
        }
        if (this.input.consume('slide') && this.player.slide()) {
          this._missionDone(this.progress.tally('slide', 1, this.runStats));
          this.runStats.slide++;
        }
      }

      /* ── world ── */
      this.bg.update(scaled, this.worldZ);
      this.ground.update(scaled);
      this.player.update(scaled, this.speed01, this.speed01 * this._windMul);

      if (st === 'playing') {
        this.obstacles.update(scaled, this.worldZ, this.speed, this.difficulty,
          this.paceAt(this.distance), biome.p.think);
        this.collectibles.update(scaled, this.worldZ, this.difficulty, this.obstacles, this.player, this.powers);

        /* equipped trail — pure cosmetics, pure joy */
        const tr = this.player.style.trail;
        if (tr && this.speed01 > 0.12) {
          this._trailAcc += scaled * tr.rate * this.renderer.quality;
          while (this._trailAcc >= 1) {
            this._trailAcc -= 1;
            const col = tr.cols[(Math.random() * tr.cols.length) | 0];
            if (tr.kind === 'spark') {
              this.particles.emit(3 /* SPARK */, this.player.x + U.rand(-.2, .2),
                this.player.y + U.rand(0.05, 0.5), U.rand(-0.6, 0), {
                  vy: U.rand(0.3, 1.2), vz: U.rand(-3, -1),
                  life: U.rand(0.3, 0.7), size: U.rand(0.02, 0.05),
                  r: col[0], g: col[1], b: col[2], a: 0.95, grav: -3, drag: 0.8
                });
            } else {
              this.particles.trail(this.player.x, this.player.y + 0.15, -0.2, col);
            }
          }
        }
      } else {
        // Keep props moving (and expiring) during the death slow-mo.
        for (const o of this.obstacles.list) o.z = o.z0 - this.worldZ;
        for (const c of this.collectibles.list) c.z = c.z0 - this.worldZ;
      }

      this.particles.windX = Math.sin(this.bg.t * 0.4) * 0.6;
      this.particles.updateSnow(scaled, this.speed);
      this.particles.update(scaled, this.speed);

      if (st === 'playing' && this.speed01 > 0.4 && U.chance(scaled * 30 * this.speed01 * this.renderer.quality)) {
        this.particles.speedStreak(this.cam.x, this.cam.z);
      }
      if (this.powers.cocoa > 0 && U.chance(scaled * 40)) {
        this.particles.trail(this.player.x, this.player.y + 0.4, 0, [255, 150, 70]);
      }

      /* ── collisions ── */
      if (st === 'playing') {
        const ev = this.collisions.check(this.player, this.obstacles, this.collectibles, dz, this.powers);
        for (let i = 0; i < ev.length; i++) this._event(ev[i]);
      }

      /* ── timers ── */
      if (st === 'playing') {
        for (const k in this.powers) {
          if (this.powers[k] > 0) {
            this.powers[k] -= scaled;
            if (this.powers[k] <= 0) { this.powers[k] = 0; this._powerEnded(k); }
          }
        }
        if (this.invuln > 0) this.invuln -= scaled;
        if (this.comboT > 0) {
          this.comboT -= scaled;
          if (this.comboT <= 0) this.combo = 0;
        }
        // Distance score, doubled by the crystal.
        this.score += dz * (this.powers.multiplier > 0 ? 2 : 1) * 0.42;
      }

      /* ── audio mix ── */
      this.audio.setIntensity(st === 'playing' ? 0.12 + this.speed01 * 0.88 : 0.05);
      this.audio.setWind((st === 'menu' ? 0.22 : 0.18 + this.speed01 * 0.7) * (this._windMul || 1) * 0.72);

      this.cam.update(dt, this._camTarget());
      this.renderer.update(dt);
      if (st === 'playing' || st === 'countdown') this.ui.update(dt, this);
    }

    _camTarget() {
      return {
        x: this.player.x,
        y: this.player.y,
        speed01: this.speed01,
        roll: this.player.lean * 0.16,
        pitchBias: this.fsm.is('dying') ? -1.6 : (this.player.fsm.is('slide') ? 0.9 : 0)
      };
    }

    /* ── events ────────────────────────────────────────────── */
    _event(e) {
      if (e.kind === 'pickup') return this._pickup(e.item, e.spec);
      if (e.kind === 'near') return this._nearMiss(e.obstacle);
      if (e.kind === 'smash') return this._smash(e.obstacle);
      if (e.kind === 'hit') return this._hit(e.obstacle);
    }

    /** Celebrate any missions a tally just completed. */
    _missionDone(done) {
      if (!done || !done.length) return;
      for (const m of done) {
        this.ui.combo('MISSION ✓  +' + m.reward + ' 🐟', '#6cf59b');
        this.audio.mission();
        this.particles.pickupBurst(this.player.x, this.player.y + 0.9, 0.3, [108, 245, 155], true);
      }
      this.ui.refreshMissions();
    }

    _pickup(c, spec) {
      const mult = this.powers.multiplier > 0 ? 2 : 1;

      if (spec.power) {
        this._power(spec.power, c);
        this.runStats.power++;
        this._missionDone(this.progress.tally('power', 1, this.runStats));
      } else {
        this.fish++;
        this.combo++;
        this.comboT = COMBO_WINDOW;
        this.runStats.fish = this.fish;
        this.runStats.combo = Math.max(this.runStats.combo, this.combo);
        this._missionDone(this.progress.tally('fish', 1, this.runStats));
        this._missionDone(this.progress.tally('combo', 0, this.runStats));
        this.audio.collect(this.combo);
        this.player.setExpr('happy', 0.45);
        if (c.type === 'goldenFish') {
          this.runStats.golden++;
          this._missionDone(this.progress.tally('golden', 1, this.runStats));
          this.audio.golden();
          this.renderer.setFlash(255, 230, 150, 0.3);
          this.cam.addTrauma(0.09);
          this.player.lookBack(0.6);
          this.ui.combo('GOLDEN!', '#ffd166');
        }
        // Combo milestones — the only place raw fish become a moment.
        if (this.combo > 0 && this.combo % 10 === 0) {
          const bonus = this.combo * 2;
          this.score += bonus * mult;
          this.ui.combo(this.combo + '× COMBO  +' + bonus, '#4ff0d0');
          this.renderer.setFlash(120, 240, 210, 0.2);
          this.particles.pickupBurst(this.player.x, this.player.y + 0.7, 0.4, [79, 240, 208], true);
          this.player.wingFlap = 1;
          // A 30-chain is genuinely hard; it earns the full celebration.
          if (this.combo >= 30) this.player.celebrate(1.2);
          else this.player.lookBack(0.7);
        }
      }

      this.score += spec.score * mult;
      this.ui.bumpScore();
    }

    _power(kind, c) {
      if (kind === 'aurora') {
        this.bg.flare(1.8);
        this.audio.crystal();
        this.audio.powerup('aurora');
        this.renderer.setFlash(140, 255, 220, 0.55);
        this.cam.addTrauma(0.22);
        this.ui.combo('AURORA  +250', '#6effd6');
        this.player.celebrate(1.6);
        this.particles.confetti(this.player.x, this.player.y + 0.8, 0.3);
        for (let i = 0; i < 26; i++) {
          this.particles.auroraMote(this.player.x + U.rand(-3, 3), U.rand(0.2, 3.4), U.rand(-1, 8), 140 + i * 8);
        }
        return;
      }

      const key = kind;
      const fresh = this.powers[key] <= 0;
      this.powers[key] = POWER_TIME[key];
      this.audio.powerup(key);
      this.player.setExpr('happy', 0.7);
      this.player.lookBack(0.55);
      this.cam.addTrauma(0.12);

      const label = { shield: 'SHIELD UP', magnet: 'MAGNET', cocoa: 'WARMTH BURST', multiplier: 'DOUBLE POINTS' }[key];
      const col = { shield: '#60d6ff', magnet: '#ff769c', cocoa: '#ff9e54', multiplier: '#a882ff' }[key];
      this.ui.combo(fresh ? label : label + ' +', col);
      this.renderer.setFlash.apply(this.renderer,
        U.parseColor(col).slice(0, 3).concat([0.3]));

      if (key === 'cocoa') {
        this.cam.addTrauma(0.3);
        this.player.wingFlap = 1;
      }
    }

    _powerEnded(key) {
      if (key === 'shield') this.particles.shieldShatter(this.player.x, this.player.y + 0.55, 0.2);
      if (key === 'cocoa') this.renderer.setFlash(120, 190, 255, 0.18);
    }

    /** Cocoa is running: obstacles explode instead of stopping you. */
    _smash(o) {
      this.particles.crash(o.x, 0.5, o.z);
      this.cam.addTrauma(0.24);
      this.audio.shieldBreak();
      this.renderer.setFlash(255, 170, 90, 0.28);
      this.score += 15 * (this.powers.multiplier > 0 ? 2 : 1);
      this.ui.combo('SMASH! +15', '#ff9e54');
      this.runStats.smash++;
      this._missionDone(this.progress.tally('smash', 1, this.runStats));
      // Remove it so it can't be smashed twice.
      const i = this.obstacles.list.indexOf(o);
      if (i >= 0) this.obstacles.list.splice(i, 1);
    }

    _nearMiss(o) {
      this._streak++;
      this.score += 2 * (this.powers.multiplier > 0 ? 2 : 1);
      this.cam.addTrauma(0.035);
      if (U.chance(0.3)) this.audio.nearMiss();
      this.player.setExpr(U.chance(0.5) ? 'worried' : 'determined', 0.35);
      this.runStats.near++;
      this._missionDone(this.progress.tally('near', 1, this.runStats));
      // Sliding under an arch is the arch mission's currency.
      if (o.type === 'arch' && this.player.fsm.is('slide')) {
        this.runStats.arch++;
        this._missionDone(this.progress.tally('arch', 1, this.runStats));
      }
      if (this._streak > 0 && this._streak % 8 === 0) {
        this.ui.combo('CLOSE CALL ×' + this._streak, '#a5dcf7');
        this.score += 20;
      }
    }

    _hit(o) {
      if (this.invuln > 0) return;

      /* shield eats it */
      if (this.powers.shield > 0) {
        this.powers.shield = 0;
        this.invuln = 1.15;
        this.particles.shieldShatter(this.player.x, this.player.y + 0.55, 0.2);
        this.audio.shieldBreak();
        this.cam.addTrauma(0.42);
        this.renderer.setFlash(150, 230, 255, 0.4);
        this.ui.combo('SHIELD BROKE', '#60d6ff');
        this.player.setExpr('shock', 0.7);
        this.player.lookBack(0.8);
        // Clear the hazard so you aren't instantly killed by the same prop.
        const i = this.obstacles.list.indexOf(o);
        if (i >= 0) this.obstacles.list.splice(i, 1);
        return;
      }

      /* real death */
      this.combo = 0;
      this._streak = 0;
      this._deathCause = o.type;
      this.player.hit();
      if (o.type === 'hole') {
        this.particles.splash(o.x, o.z);
        this.player.vy = 2;
      } else {
        this.particles.crash(this.player.x, 0.6, 0.2);
      }
      this.fsm.set('dying');
    }

    /* ── wardrobe (UI calls these) ─────────────────────────── */
    buyItem(id) {
      const ok = this.progress.buy(id);
      if (ok) { this.audio.purchase(); this.equipItem(id); }
      else this.audio.deny();
      return ok;
    }

    equipItem(id) {
      const ok = this.progress.equip(id);
      if (ok) {
        this.player.setStyle(this.progress.style());
        this.audio.ui();
      }
      return ok;
    }

    /* ── share card ────────────────────────────────────────── */

    /** Compose a 1200×630 share card: the death-frame snapshot + the stats. */
    makeShareCard() {
      const W = 1200, H = 630;
      const c = U.makeCanvas(W, H);
      const x = c.getContext('2d');

      const bg = x.createLinearGradient(0, 0, 0, H);
      bg.addColorStop(0, '#071527');
      bg.addColorStop(1, '#030b17');
      x.fillStyle = bg; x.fillRect(0, 0, W, H);

      // The actual moment of death, rounded-masked on the right.
      if (this._shareSnap) {
        const s = this._shareSnap;
        const ph = H - 80, pw = Math.min(640, ph * s.width / s.height);
        const px = W - pw - 44, py = 40;
        x.save();
        U.roundRect(x, px, py, pw, ph, 22);
        x.clip();
        x.drawImage(s, px, py, pw, ph);
        const vg = x.createLinearGradient(px, 0, px + pw, 0);
        vg.addColorStop(0, 'rgba(3,11,23,0.55)');
        vg.addColorStop(0.3, 'rgba(3,11,23,0)');
        x.fillStyle = vg; x.fillRect(px, py, pw, ph);
        x.restore();
        x.strokeStyle = 'rgba(160,220,255,0.3)';
        x.lineWidth = 2;
        U.roundRect(x, px, py, pw, ph, 22);
        x.stroke();
      }

      const F = '"Avenir Next","Segoe UI",Inter,system-ui,sans-serif';
      x.textBaseline = 'top';
      x.fillStyle = '#a5dcf7';
      x.font = '700 26px ' + F;
      x.fillText('POLAR AURORA', 56, 60);
      x.fillStyle = 'rgba(165,220,247,0.6)';
      x.font = '600 17px ' + F;
      x.fillText('THE GREAT PENGUIN ADVENTURE' + (this.daily ? '  ·  DAILY RUN' : ''), 56, 96);

      const grad = x.createLinearGradient(56, 0, 500, 0);
      grad.addColorStop(0, '#4ff0d0'); grad.addColorStop(0.55, '#f2fbff'); grad.addColorStop(1, '#ffd166');
      x.fillStyle = grad;
      x.font = '900 132px ' + F;
      x.fillText(U.formatNum(Math.floor(this.score)), 50, 168);
      x.fillStyle = 'rgba(242,251,255,0.55)';
      x.font = '800 24px ' + F;
      x.fillText('POINTS', 58, 312);

      x.fillStyle = '#e8f6ff';
      x.font = '700 30px ' + F;
      x.fillText(U.formatNum(Math.floor(this.distance)) + ' m', 56, 392);
      x.fillText(U.formatNum(this.fish) + ' fish', 56, 438);
      x.fillStyle = 'rgba(232,246,255,0.5)';
      x.font = '600 20px ' + F;
      x.fillText('best ' + U.formatNum(this.best), 56, 490);

      x.fillStyle = '#4ff0d0';
      x.font = '700 22px ' + F;
      x.fillText('game-polar-aurora.tingyudeco.com', 56, H - 76);
      return c;
    }

    /** Web Share with files when available; otherwise download the PNG. */
    async shareScore() {
      const card = this.makeShareCard();
      const text = 'POLAR AURORA — ' + U.formatNum(Math.floor(this.score)) + ' pts · ' +
                   Math.floor(this.distance) + ' m 🐧  https://game-polar-aurora.tingyudeco.com';
      const blob = await new Promise((res) => card.toBlob(res, 'image/png'));
      if (!blob) return 'failed';
      const file = new File([blob], 'polar-aurora-score.png', { type: 'image/png' });
      if (navigator.canShare && navigator.canShare({ files: [file] })) {
        try {
          await navigator.share({ files: [file], text });
          return 'shared';
        } catch (e) { /* user cancelled → fall through to download */ }
      }
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = 'polar-aurora-score.png';
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 4000);
      return 'downloaded';
    }

    render() {
      this.renderer.draw({
        cam: this.cam, bg: this.bg, ground: this.ground,
        obstacles: this.obstacles, collectibles: this.collectibles,
        player: this.player, particles: this.particles,
        worldZ: this.worldZ, powers: this.powers,
        speed01: this.speed01, deathFade: this.deathFade,
        state: this.fsm.current
      });
    }
  }

  global.Game = Game;
})(window);
