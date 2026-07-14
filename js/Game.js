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

  const SPEED_MIN = 19.5;
  const SPEED_MAX = 45;
  const RAMP_M = 2600;          // e-folding distance of the speed ramp
  const COMBO_WINDOW = 2.3;

  const POWER_TIME = { shield: 14, magnet: 9, cocoa: 5.5, multiplier: 10 };

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
        over:      {}
      }, 'boot', {
        boot: ['menu'],
        menu: ['countdown'],
        countdown: ['playing', 'menu'],
        playing: ['paused', 'dying', 'menu'],
        paused: ['playing', 'countdown', 'menu'],
        dying: ['over', 'menu'],
        over: ['countdown', 'menu']
      });
    }

    /* ── boot ──────────────────────────────────────────────── */
    init() {
      this.ui.init();
      this.ui.buildHelp(this.collectibles);
      this.renderer.resize(this.cam);
      this.particles.initSnow(300);
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
      this.audio.stopMusic(0.4);
      this.audio.setWind(0.22);
      this.input.setEnabled(false);
    }

    start() {
      this._unlock();
      if (!this.fsm.isAny('menu', 'over', 'paused')) return;
      // Always reset through the menu state so there is exactly one reset
      // routine — `force` because over→menu and paused→menu are both legal
      // but we want the enter handler regardless of where we came from.
      this.fsm.set('menu', {}, true);
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
      this.audio.gameOver();
      this.cam.addTrauma(0.95);
      this.renderer.setFlash(255, 190, 170, 0.75);
      this.timeScale = 0.28;
    }

    _dying(dt, t) {
      this.deathFade = U.clamp(t / 1.1, 0, 1);
      this.timeScale = U.lerp(0.28, 0.02, U.clamp(t / 1.4, 0, 1));
      if (t > 1.5) {
        const isBest = Math.floor(this.score) > this.best;
        if (isBest) {
          this.best = Math.floor(this.score);
          U.Store.set('pa_best', this.best);
          this.audio.newBest();
        }
        this.ui.setGameOver(Math.floor(this.score), Math.floor(this.distance), this.fish, this.best, isBest);
        this.fsm.set('over');
      }
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

      if (st === 'paused' || st === 'over') {
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
      if (st === 'playing') this.distance += dz;

      /* ── input ── */
      if (st === 'playing') {
        if (this.input.consume('left')) this.player.moveLane(-1);
        if (this.input.consume('right')) this.player.moveLane(1);
        if (this.input.consume('jump')) this.player.jump();
        if (this.input.consume('slide')) this.player.slide();
      }

      /* ── world ── */
      this.bg.update(scaled, this.worldZ);
      this.ground.update(scaled);
      this.player.update(scaled, this.speed01, this.speed01);

      if (st === 'playing') {
        this.obstacles.update(scaled, this.worldZ, this.speed, this.difficulty);
        this.collectibles.update(scaled, this.worldZ, this.difficulty, this.obstacles, this.player, this.powers);
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
      this.audio.setWind(st === 'menu' ? 0.22 : 0.18 + this.speed01 * 0.7);

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

    _pickup(c, spec) {
      const mult = this.powers.multiplier > 0 ? 2 : 1;

      if (spec.power) {
        this._power(spec.power, c);
      } else {
        this.fish++;
        this.combo++;
        this.comboT = COMBO_WINDOW;
        this.audio.collect(this.combo);
        this.player.setExpr('happy', 0.45);
        if (c.type === 'goldenFish') {
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
      this.player.hit();
      if (o.type === 'hole') {
        this.particles.splash(o.x, o.z);
        this.player.vy = 2;
      } else {
        this.particles.crash(this.player.x, 0.6, 0.2);
      }
      this.fsm.set('dying');
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
