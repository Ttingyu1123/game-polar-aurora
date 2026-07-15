/* ═══════════════════════════════════════════════════════════
   Player — the penguin. Every pixel is vector work; there is no
   sprite sheet and no bitmap anywhere in this file.

   THE VIEWING PROBLEM
   A chase camera looks at the BACK of a runner, which would hide the
   two things that give a character life: the face and the white belly.
   So the penguin is not drawn as a flat sprite — the face and belly are
   DECALS ON AN ELLIPSOID, positioned by a yaw angle:

       screenX = radius · sin(θ + yaw)      // where the feature lands
       facing  = cos(θ + yaw)               // >0 means we can see it

   At rest he alternately glances left and right down the runway, so we
   see him in profile — beak out at the silhouette edge, one eye, full
   expression — and his body sits in a 3/4 back view where a sliver of
   belly wraps around one edge. He snaps his head round to look at the
   camera when something happens. Nothing is symmetric-flat; the yaw
   does the acting.

   Everything else is springs: squash & stretch on takeoff and landing,
   a verlet scarf, counter-rotating wings, an 8-phase foot cycle.
   ═══════════════════════════════════════════════════════════ */
(function (global) {
  'use strict';

  const U = global.U;
  const W3 = global.WORLD;
  const TAU = U.TAU;

  const H = 1.16;              // body height in metres = 1 local unit
  const JUMP_V = 14.6;
  const COYOTE = 0.09;
  const SLIDE_TIME = 0.66;
  const LANE_SNAP = 13.5;      // lane change speed (units/s at full gap)

  /* Expression presets: [browAngle, browY, eyeOpen, beakOpen, blush] */
  const FACES = {
    neutral:    [0.00, 0.00, 1.00, 0.00, 0.00],
    determined: [0.34, 0.02, 0.78, 0.10, 0.10],
    happy:      [-0.20, -0.02, 0.42, 0.55, 0.65],
    worried:    [-0.42, -0.03, 1.05, 0.30, 0.00],
    shock:      [-0.15, -0.06, 1.35, 0.85, 0.00],
    dizzy:      [0.10, 0.02, 0.30, 0.60, 0.30]
  };

  class Player {
    constructor(camera, particles, audio) {
      this.cam = camera;
      this.ps = particles;
      this.audio = audio;
      this._p = { x: 0, y: 0, s: 0, visible: false };

      // The FSM must exist BEFORE reset(), because reset() puts it back to
      // 'run' — see the note there.
      this.fsm = new global.StateMachine({
        run: {
          enter() {}, update() {}
        },
        jump: {}, fall: {}, land: {}, slide: {}, hit: {}, celebrate: {}
      }, 'run');

      this.reset();
    }

    reset() {
      this.lane = 1;
      this.x = 0; this.y = 0; this.vy = 0;
      this.targetX = 0;
      this.onGround = true;
      this.coyote = 0;
      this.slideT = 0;
      this.dead = false;

      this.runPhase = 0;
      this.bob = 0;
      this.lean = 0;            // body roll, radians
      this.pitchLean = 0;       // forward pitch when accelerating

      // squash & stretch springs
      this.sqX = 1; this.sqY = 1;
      this.sqVX = 0; this.sqVY = 0;

      // yaw actors
      this.headYaw = 1.85;
      this.headYawT = 1.85;
      this.bodyYaw = 2.42;
      this.bodyYawT = 2.42;
      this._lookTimer = 0;
      this._lookDir = 1;
      this._faceCamT = 0;       // >0 = forced to look back at camera

      this.blink = 0;
      this.blinkT = U.rand(1.6, 4);
      this.expr = 'determined';
      this.exprT = 0;
      this._face = FACES.determined.slice();

      this.scarf = null;
      this._initScarf();

      this.flash = 0;           // white hit flash
      this.hitSpin = 0;
      this.celebrateT = 0;
      this.celebrateDur = 1.4;

      // Wardrobe. reset() must NOT clear an equipped style — dying doesn't
      // undress you — so only fill the default on first construction.
      if (!this.style) {
        this.style = {
          scarf: { base: '#e34355', dark: '#8e1b2c', light: '#ff6b7c', deep: '#a02234', fringe: '#c9304a' },
          body: { top: '#1d3050', mid: '#172740', low: '#121e34', bot: '#0c1424' },
          trail: null
        };
      }
      this.wingFlap = 0;
      this.speed01 = 0;
      this.auroraLight = [120, 220, 255, 0.5];

      // Put the machine back to 'run'. Forgetting this meant every run after
      // your first death began in 'hit' — reset() cleared `dead` and hitSpin
      // but left the STATE, so the hit branch kept integrating and the penguin
      // span at 5.5 rad/s until you happened to press jump (which set a new
      // state and hid the bug). 'slide' self-heals via its timer and 'hit'
      // does not, which is exactly why this went unnoticed.
      this.fsm.set('run', {}, true);
    }

    /* ── scarf: verlet chain in the penguin's local space ───── */
    _initScarf() {
      const n = 10;
      this.scarf = [];
      for (let i = 0; i < n; i++) {
        // Seeded already swept out to one side so it never has to "fall"
        // into place on the first frame of a run.
        this.scarf.push({ x: i * 0.036, y: -0.62 + i * 0.030, px: i * 0.036, py: -0.62 + i * 0.030 });
      }
    }

    /**
     * The penguin runs AWAY from the camera at ~40 m/s, so the slipstream
     * throws his scarf back toward the lens — on screen that reads as the
     * scarf sweeping outward and down while a travelling wave runs down its
     * length. The first version applied forces ~30× too weak, so gravity won
     * and it hung dead-straight down his chest like a necktie.
     *
     * Accelerations are in local units/s² (1 unit = body height).
     */
    _updateScarf(dt, wind) {
      const s = this.scarf;
      const REST = 0.052;
      const anchorX = Math.sin(this.headYaw) * 0.03;
      const anchorY = -0.63;
      s[0].x = anchorX; s[0].y = anchorY;
      s[0].px = anchorX; s[0].py = anchorY;

      const h = Math.min(dt, 0.033);
      const h2 = h * h;
      const w = 0.45 + wind;

      // The distance constraints pin the LENGTH, so what the forces actually
      // decide is the DIRECTION the chain points. Only their ratio matters,
      // not their magnitude — which is why simply scaling everything up sent
      // it rigidly along the net vector like a fire hose.
      //
      // Target: trailing roughly horizontally to one side, lifted ~15°, with
      // a travelling wave ACROSS its length. The wave has to be perpendicular
      // to the sweep or it just modulates the direction instead of bending it.
      for (let i = 1; i < s.length; i++) {
        const p = s[i];
        const vx = (p.x - p.px) * 0.88;
        const vy = (p.y - p.py) * 0.88;
        p.px = p.x; p.py = p.y;
        const t = i / (s.length - 1);

        // Slipstream drags it sideways; leaning into a turn throws it across.
        const sweep = 250 * (0.25 + t) * w - this.lean * 260;
        // Near-neutral vertical: the root droops off the neck and the tip
        // floats level. Any more lift and the tail rides up over his beak.
        const lift = -34 * w * (0.2 + t) + 46;
        // Travelling wave, vertical because the scarf lies horizontal. This
        // is the whole difference between cloth and a length of hose.
        const wave = Math.sin(this.runPhase * 2.1 - i * 0.9) * 170 * (0.12 + t) * w;

        p.x += vx + sweep * h2;
        p.y += vy + (lift + wave) * h2;
      }

      // Relaxation. Three passes: at these force magnitudes two left visible
      // stretch in the mid-links whenever the tip whipped.
      for (let k = 0; k < 3; k++) {
        for (let i = 1; i < s.length; i++) {
          const a = s[i - 1], b = s[i];
          const dx = b.x - a.x, dy = b.y - a.y;
          const d = Math.hypot(dx, dy) || 1e-5;
          const diff = (d - REST) / d * 0.5;
          const ox = dx * diff, oy = dy * diff;
          if (i > 1) { a.x += ox; a.y += oy; }
          b.x -= ox; b.y -= oy;
        }
        s[0].x = anchorX; s[0].y = anchorY;
      }
    }

    /** Apply a wardrobe style: {scarf:{base,dark,light,deep,fringe}, body:{top,mid,low,bot,patch?}, trail}. */
    setStyle(style) {
      if (!style) return;
      if (style.scarf) this.style.scarf = style.scarf;
      if (style.body) this.style.body = style.body;
      this.style.trail = style.trail || null;
    }

    /* ── expression / gaze director ─────────────────────────── */
    setExpr(name, hold) {
      this.expr = FACES[name] ? name : 'neutral';
      this.exprT = hold || 0.8;
    }

    /** Snap the head round to face the camera for `t` seconds. */
    lookBack(t) { this._faceCamT = Math.max(this._faceCamT, t || 0.7); }

    _updateGaze(dt) {
      this._lookTimer -= dt;
      if (this._faceCamT > 0) {
        this._faceCamT -= dt;
        this.headYawT = 0.72 * this._lookDir;       // over the shoulder, face to camera
      } else {
        if (this._lookTimer <= 0) {
          // Idle scanning: alternate profiles with a beat of "away" between.
          this._lookDir = U.chance(0.5) ? 1 : -1;
          this._lookTimer = U.rand(1.1, 2.6);
          const away = U.chance(0.28);
          this.headYawT = away ? 2.5 * this._lookDir : U.rand(1.5, 1.95) * this._lookDir;
        }
        // Always look where you're going.
        if (Math.abs(this.targetX - this.x) > 0.25) {
          this.headYawT = U.sign(this.targetX - this.x) * 1.42;
          this._lookTimer = Math.max(this._lookTimer, 0.35);
        }
      }
      this.headYaw = U.damp(this.headYaw, this.headYawT, 0.16, dt);

      // Body follows the head loosely, biased to a 3/4 back view.
      const strafe = U.clamp((this.targetX - this.x) * 0.34, -0.55, 0.55);
      this.bodyYawT = 2.42 - strafe * 0.9 - (this._faceCamT > 0 ? 0.5 * this._lookDir : 0);
      this.bodyYaw = U.damp(this.bodyYaw, this.bodyYawT, 0.08, dt);

      // Blink — quick, with a natural random cadence.
      this.blinkT -= dt;
      if (this.blinkT <= 0) { this.blink = 0.16; this.blinkT = U.rand(1.8, 5.2); }
      if (this.blink > 0) this.blink -= dt;

      // Expression decay back to the running default.
      if (this.exprT > 0) { this.exprT -= dt; if (this.exprT <= 0) this.expr = 'determined'; }
      const want = FACES[this.expr] || FACES.neutral;
      for (let i = 0; i < 5; i++) this._face[i] = U.damp(this._face[i], want[i], 0.22, dt);
    }

    /* ── actions ────────────────────────────────────────────── */
    moveLane(dir) {
      const n = U.clamp(this.lane + dir, 0, W3.LANES.length - 1);
      if (n === this.lane) {
        // Nudge at the wall so the input never feels ignored.
        this.lean += dir * 0.06;
        return false;
      }
      this.lane = n;
      this.targetX = W3.LANES[n];
      if (this.audio) this.audio.lane();
      this.sqVX += dir * 0.6;
      return true;
    }

    jump() {
      if (!(this.onGround || this.coyote > 0) || this.fsm.is('slide')) {
        if (this.fsm.is('slide')) { this.slideT = 0; this._endSlide(); } else return false;
      }
      this.vy = JUMP_V;
      this.onGround = false;
      this.coyote = 0;
      this.fsm.set('jump');
      // Anticipation is baked into the spring: launch stretched.
      this.sqY = 1.26; this.sqX = 0.80; this.sqVY = 1.2;
      this.setExpr('determined', 0.4);
      this.ps.footPuff(this.x, 0, 0.9);
      if (this.audio) this.audio.jump();
      return true;
    }

    slide() {
      if (!this.onGround) {
        // Air-slide = fast-fall. Feels great, costs nothing.
        if (this.vy > -6) this.vy = -18;
        return false;
      }
      if (this.fsm.is('slide')) { this.slideT = SLIDE_TIME; return false; }
      this.fsm.set('slide');
      this.slideT = SLIDE_TIME;
      this.sqY = 0.62; this.sqX = 1.3;
      this.setExpr('determined', SLIDE_TIME);
      if (this.audio) this.audio.slide();
      return true;
    }

    _endSlide() {
      if (!this.fsm.is('slide')) return;
      this.fsm.set('run');
      this.sqVY += 1.1;
    }

    hit() {
      this.dead = true;
      this.fsm.set('hit');
      this.vy = 9.5;
      this.hitSpin = 0;
      this.flash = 1;
      this.setExpr('shock', 1.4);
      this._faceCamT = 3.5;
      this._lookDir = 1;
      this.sqY = 1.2; this.sqX = 0.86;
    }

    /**
     * Wings up, grinning back at the camera. Deliberately does NOT hop: an
     * involuntary jump mid-run would throw the player into a hazard they had
     * already read correctly, and punishing someone for doing well is the
     * worst thing a celebration can do.
     */
    celebrate(dur) {
      if (this.dead) return;
      this.celebrateDur = dur || 1.4;
      this.fsm.set('celebrate');
      this.celebrateT = 0;
      this.setExpr('happy', this.celebrateDur);
      this._faceCamT = this.celebrateDur;
      this.wingFlap = 1;
    }

    /* ── sim ────────────────────────────────────────────────── */
    update(dt, speed01, wind) {
      this.speed01 = speed01;

      // Lateral: critically-damped-ish move to the lane centre.
      const dx = this.targetX - this.x;
      const step = U.clamp(dx * LANE_SNAP * dt, -Math.abs(dx), Math.abs(dx));
      this.x += step;
      const vx = step / Math.max(dt, 1e-4);
      this.lean = U.damp(this.lean, U.clamp(-vx * 0.052, -0.42, 0.42), 0.15, dt);

      if (!this.dead) {
        this.runPhase += dt * (7.4 + speed01 * 6.2);
        this.pitchLean = U.damp(this.pitchLean, 0.06 + speed01 * 0.12, 0.06, dt);
      }

      /* vertical */
      const wasAir = !this.onGround;
      if (!this.onGround || this.vy !== 0) {
        this.vy += W3.GRAVITY * dt;
        this.y += this.vy * dt;
        if (this.y <= 0 && !this.dead) {
          const impact = U.clamp(-this.vy / 20, 0, 1.35);
          this.y = 0; this.vy = 0;
          if (wasAir) this._land(impact);
        } else if (this.y < -3.2 && this.dead) {
          this.y = -3.2; this.vy = 0;
        }
      }
      if (this.onGround) this.coyote = COYOTE; else this.coyote -= dt;

      /* state upkeep */
      if (this.fsm.is('jump') && this.vy < 0) this.fsm.set('fall');
      if (this.fsm.is('slide')) {
        this.slideT -= dt;
        this.ps.slideSpray(this.x, 0, speed01);
        if (this.slideT <= 0) this._endSlide();
      }
      if (this.fsm.is('land') && this.fsm.time > 0.16) this.fsm.set('run');
      if (this.fsm.is('hit')) {
        this.hitSpin += dt * (5.5 - Math.min(4.4, this.fsm.time * 3.2));
        if (this.fsm.time > 0.4) this.setExpr('dizzy', 9);
      }
      if (this.fsm.is('celebrate')) {
        this.celebrateT += dt;
        if (this.celebrateT > this.celebrateDur) this.fsm.set('run');
      }

      /* running footfalls */
      if (this.onGround && !this.dead && this.fsm.isAny('run', 'land', 'celebrate')) {
        const ph = U.wrap(this.runPhase, TAU);
        const strike = ph < 0.2 || (ph > Math.PI && ph < Math.PI + 0.2);
        if (strike && !this._struck) {
          this._struck = true;
          this.bob = 0.02;
          if (U.chance(0.65)) this.ps.footPuff(this.x + U.rand(-.1, .1), 0, 0.25 + this.speed01 * 0.45);
        } else if (!strike) this._struck = false;
      }

      /* squash & stretch spring — one spring, two axes, volume-ish preserved */
      const restY = this.fsm.is('slide') ? 0.62 : 1;
      const restX = this.fsm.is('slide') ? 1.34 : 1;
      const K = 168, D = 15;
      this.sqVY += (restY - this.sqY) * K * dt; this.sqVY *= Math.max(0, 1 - D * dt); this.sqY += this.sqVY * dt;
      this.sqVX += (restX - this.sqX) * K * dt; this.sqVX *= Math.max(0, 1 - D * dt); this.sqX += this.sqVX * dt;
      // Airborne stretch tracks vertical speed — a free, very readable cue.
      if (!this.onGround && !this.dead) {
        const st = U.clamp(this.vy / 22, -0.45, 0.45);
        this.sqY = U.lerp(this.sqY, 1 + st * 0.4, 0.4);
        this.sqX = U.lerp(this.sqX, 1 - st * 0.26, 0.4);
      }
      this.sqY = U.clamp(this.sqY, 0.5, 1.5);
      this.sqX = U.clamp(this.sqX, 0.6, 1.6);

      this.bob = U.damp(this.bob, 0, 0.2, dt);
      this.wingFlap = U.damp(this.wingFlap, 0, 0.1, dt);
      if (this.flash > 0) this.flash -= dt * 2.4;

      this._updateGaze(dt);
      this._updateScarf(dt, 0.35 + speed01 * 0.9 + (this.onGround ? 0 : 0.3));
    }

    _land(impact) {
      this.onGround = true;
      this.fsm.set('land');
      this.sqY = U.lerp(1, 0.58, U.clamp(impact, 0, 1));
      this.sqX = U.lerp(1, 1.36, U.clamp(impact, 0, 1));
      this.sqVY = 0;
      this.ps.landBurst(this.x, 0, U.clamp(impact, 0.25, 1.25));
      this.cam.addTrauma(0.05 + impact * 0.13);
      if (this.audio) this.audio.land(impact);
      if (impact > 0.55) this.setExpr('determined', 0.3);
    }

    /* ── collision box ──────────────────────────────────────── */
    getBox() {
      const sliding = this.fsm.is('slide');
      return {
        x: this.x,
        halfW: sliding ? 0.44 : 0.36,
        bottom: this.y + (sliding ? 0 : 0.02),
        top: this.y + (sliding ? 0.52 : 1.08),
        halfZ: sliding ? 0.55 : 0.4
      };
    }

    /* ══════════════════════════════════════════════════════════
       DRAWING
       ══════════════════════════════════════════════════════════ */

    /** Where a feature at angular position θ lands, given a yaw. */
    _decal(theta, yaw) {
      const a = theta + yaw;
      return { x: Math.sin(a), face: Math.cos(a) };
    }

    /** Shadow — separate pass so it sits under obstacles too. */
    drawShadow(ctx) {
      const cam = this.cam, p = this._p;
      cam.project(this.x, 0, 0, p);
      if (!p.visible) return;
      const s = p.s;
      const lift = U.clamp(this.y / 3.4, 0, 1);
      const r = H * s * (0.36 - lift * 0.13) * this.sqX;
      if (r < 0.6) return;
      const a = (0.48 - lift * 0.36) * (this.dead ? 0.5 : 1);
      const g = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, r);
      g.addColorStop(0, 'rgba(10,38,72,' + (a).toFixed(3) + ')');
      g.addColorStop(0.5, 'rgba(14,48,88,' + (a * 0.55).toFixed(3) + ')');
      g.addColorStop(1, 'rgba(20,60,104,0)');
      ctx.save();
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.ellipse(p.x, p.y, r, r * 0.30, 0, 0, TAU);
      ctx.fill();
      // Hard contact core — the thing that stops him floating.
      if (lift < 0.12) {
        ctx.fillStyle = 'rgba(8,32,64,' + (0.34 * (1 - lift / 0.12)).toFixed(3) + ')';
        ctx.beginPath();
        ctx.ellipse(p.x, p.y, r * 0.42, r * 0.13, 0, 0, TAU);
        ctx.fill();
      }
      ctx.restore();
    }

    draw(ctx, bg) {
      const cam = this.cam, p = this._p;
      cam.project(this.x, this.y, 0, p);
      if (!p.visible) return;

      // Key light = the aurora directly above the penguin's screen column.
      if (bg) this.auroraLight = bg.sampleAurora(U.clamp(p.x / cam.width, 0, 1));

      const S = p.s * H;
      if (S < 2) return;

      ctx.save();
      ctx.translate(p.x, p.y);
      ctx.scale(S, S);

      // Body transform: lean, hit-spin, squash — all around the hips.
      ctx.translate(0, -0.34);
      let rot = this.lean;
      if (this.fsm.is('hit')) rot += this.hitSpin;
      if (this.fsm.is('slide')) rot += 0.10;
      ctx.rotate(rot);
      ctx.scale(this.sqX, this.sqY);
      ctx.translate(0, 0.34 - this.bob);

      this._drawPenguin(ctx);
      ctx.restore();
    }

    _drawPenguin(ctx) {
      const f = this._face;
      const sliding = this.fsm.is('slide');
      const cel = this.fsm.is('celebrate');
      const L = this.auroraLight;

      // Run cycle drives limbs; frozen while sliding.
      const ph = sliding ? 0 : this.runPhase;
      const legA = Math.sin(ph), legB = Math.sin(ph + Math.PI);

      /* ── back wing (drawn first = behind the body) ── */
      this._wing(ctx, -1, legB, sliding, cel);

      /* ── body silhouette ── */
      const yTop = -0.985, yNeck = -0.655, yWide = -0.34, yBot = -0.04;
      const wBody = 0.292, wHead = 0.188;

      ctx.beginPath();
      ctx.moveTo(0, yTop);
      ctx.bezierCurveTo(wHead * 0.98, yTop, wHead * 1.10, yNeck - 0.03, wHead * 0.90, yNeck + 0.045);
      ctx.bezierCurveTo(wBody * 0.84, yNeck + 0.115, wBody, yWide - 0.075, wBody, yWide + 0.055);
      ctx.bezierCurveTo(wBody, yBot - 0.155, wBody * 0.74, yBot, 0.132, yBot);
      ctx.bezierCurveTo(0.06, yBot + 0.012, -0.06, yBot + 0.012, -0.132, yBot);
      ctx.bezierCurveTo(-wBody * 0.74, yBot, -wBody, yBot - 0.155, -wBody, yWide + 0.055);
      ctx.bezierCurveTo(-wBody, yWide - 0.075, -wBody * 0.84, yNeck + 0.115, -wHead * 0.90, yNeck + 0.045);
      ctx.bezierCurveTo(-wHead * 1.10, yNeck - 0.03, -wHead * 0.98, yTop, 0, yTop);
      ctx.closePath();

      ctx.save();
      ctx.clip();                       // everything below stays inside the body

      // Base coat: cool blue-black. Head and torso share one ramp so they
      // read as a single continuous form rather than a head sat on a body.
      const B = this.style.body;
      const bg2 = ctx.createLinearGradient(0, yTop, 0, yBot);
      bg2.addColorStop(0, B.top);
      bg2.addColorStop(0.35, B.mid);
      bg2.addColorStop(0.72, B.low);
      bg2.addColorStop(1, B.bot);
      ctx.fillStyle = bg2;
      ctx.fillRect(-0.4, yTop - 0.05, 0.8, 1.05);

      // Form shading: a radial "sphere" pass turns the flat fill into volume.
      // Centred on the shoulder, not the neck — putting the hot spot on the
      // head is what made it glow lighter than everything below it.
      const vol = ctx.createRadialGradient(-0.10, -0.48, 0.02, 0, -0.40, 0.46);
      vol.addColorStop(0, 'rgba(84,120,168,0.30)');
      vol.addColorStop(0.45, 'rgba(44,68,106,0.14)');
      vol.addColorStop(1, 'rgba(4,10,22,0.55)');
      ctx.fillStyle = vol;
      ctx.fillRect(-0.4, yTop - 0.05, 0.8, 1.05);

      // Ambient occlusion where the body meets the ice.
      const ao = ctx.createLinearGradient(0, yBot - 0.2, 0, yBot + 0.02);
      ao.addColorStop(0, 'rgba(2,6,16,0)');
      ao.addColorStop(1, 'rgba(2,6,16,0.6)');
      ctx.fillStyle = ao;
      ctx.fillRect(-0.4, yBot - 0.2, 0.8, 0.24);

      /* ── belly decal (wraps the ellipsoid; mostly hidden from behind) ── */
      this._belly(ctx, wBody, yNeck, yBot);

      /* ── aurora rim light along the upper-left edge ── */
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      const rim = ctx.createLinearGradient(-wBody, yTop, wBody * 0.45, yWide);
      rim.addColorStop(0, U.rgba(L[0], L[1], L[2], 0.5 + L[3] * 0.42));
      rim.addColorStop(0.42, U.rgba(L[0], L[1], L[2], 0.10));
      rim.addColorStop(1, U.rgba(L[0], L[1], L[2], 0));
      ctx.fillStyle = rim;
      ctx.fillRect(-0.4, yTop - 0.05, 0.8, 1.05);

      // Specular sheen — penguins are oily and glossy; two tight bands.
      const sp = ctx.createLinearGradient(-0.16, -0.9, 0.06, -0.2);
      sp.addColorStop(0, 'rgba(214,240,255,0)');
      sp.addColorStop(0.42, 'rgba(214,240,255,0.30)');
      sp.addColorStop(0.62, 'rgba(190,226,255,0.06)');
      sp.addColorStop(1, 'rgba(190,226,255,0)');
      ctx.fillStyle = sp;
      ctx.fillRect(-0.4, yTop - 0.05, 0.8, 1.05);
      ctx.restore();

      // Hit flash.
      if (this.flash > 0) {
        ctx.fillStyle = 'rgba(255,240,240,' + (this.flash * 0.8).toFixed(3) + ')';
        ctx.fillRect(-0.4, yTop - 0.05, 0.8, 1.05);
      }
      ctx.restore();     // un-clip

      // Silhouette edge: a hair of dark keeps him readable on bright ice.
      ctx.strokeStyle = 'rgba(6,12,26,0.5)';
      ctx.lineWidth = 0.012;
      ctx.stroke();

      /* ── head furniture ── */
      this._face3D(ctx, wHead, yTop, yNeck);

      /* ── feet ── */
      this._feet(ctx, legA, legB, sliding, cel);

      /* ── scarf ── */
      this._scarf(ctx);

      /* ── front wing ── */
      this._wing(ctx, 1, legA, sliding, cel);
    }

    /* ── belly: angular decal on the body ellipsoid ─────────── */
    _belly(ctx, wBody, yNeck, yBot) {
      const SPAN = 1.16;            // half-angle the white patch covers
      const yaw = this.bodyYaw;
      // Find the visible horizontal extent of the patch.
      let xMin = 9, xMax = -9, any = false;
      const N = 14;
      for (let i = 0; i <= N; i++) {
        const th = -SPAN + (2 * SPAN) * (i / N);
        const d = this._decal(th, yaw);
        if (d.face > -0.03) {
          any = true;
          if (d.x < xMin) xMin = d.x;
          if (d.x > xMax) xMax = d.x;
        }
      }
      if (!any || xMax - xMin < 0.02) return;

      const x0 = xMin * wBody, x1 = xMax * wBody;
      const cx = (x0 + x1) * 0.5, rw = (x1 - x0) * 0.5;
      const yT = yNeck + 0.055, yB = yBot - 0.035;
      const cy = (yT + yB) * 0.5, rh = (yB - yT) * 0.5;

      ctx.save();
      ctx.beginPath();
      // Rounded-top capsule; the belly is taller than it is wide.
      ctx.ellipse(cx, cy, Math.max(0.004, rw), rh, 0, 0, TAU);
      ctx.clip();

      const g = ctx.createLinearGradient(cx - rw, yT, cx + rw * 0.6, yB);
      g.addColorStop(0, '#ffffff');
      g.addColorStop(0.36, '#eaf6ff');
      g.addColorStop(0.72, '#c3ddf2');
      g.addColorStop(1, '#93b7d6');
      ctx.fillStyle = g;
      ctx.fillRect(cx - rw - 0.02, yT - 0.02, rw * 2 + 0.04, (yB - yT) + 0.04);

      // Soft-focus highlight — the classic belly bounce light.
      const hl = ctx.createRadialGradient(cx - rw * 0.25, cy - rh * 0.45, 0, cx, cy, rw * 1.9);
      hl.addColorStop(0, 'rgba(255,255,255,0.85)');
      hl.addColorStop(0.5, 'rgba(255,255,255,0.12)');
      hl.addColorStop(1, 'rgba(255,255,255,0)');
      ctx.fillStyle = hl;
      ctx.fillRect(cx - rw - 0.02, yT - 0.02, rw * 2 + 0.04, (yB - yT) + 0.04);
      ctx.restore();

      // Terminator: soften the edge where white meets black plumage.
      ctx.save();
      ctx.globalAlpha = 0.5;
      ctx.strokeStyle = 'rgba(120,150,186,0.5)';
      ctx.lineWidth = 0.012;
      ctx.beginPath();
      ctx.ellipse(cx, cy, Math.max(0.004, rw), rh, 0, 0, TAU);
      ctx.stroke();
      ctx.restore();
    }

    /* ── face: eyes, beak, brows as ellipsoid decals ────────── */
    _face3D(ctx, wHead, yTop, yNeck) {
      const f = this._face;
      const yaw = this.headYaw;
      const hy = -0.815;                       // head centre
      const hrx = wHead * 1.02, hry = 0.175;

      const beak = this._decal(0, yaw);
      const eyeL = this._decal(-0.62, yaw);
      const eyeR = this._decal(0.62, yaw);
      const cheekL = this._decal(-0.95, yaw);
      const cheekR = this._decal(0.95, yaw);

      /* Emperor ear patches — the gold blaze on the side-back of the head.
         Drawn first so the white cheek patches sit over their inner edge.
         Placed at ±2.1 rad: mostly visible from BEHIND, which is exactly
         where a chase camera lives — the one skin that looks best from our
         angle. */
      if (this.style.body.patch) {
        const drawPatch = (d) => {
          if (d.face > 0.55 || d.x === 0) return;      // hidden when facing us
          const x = d.x * hrx * 0.9;
          const vis = U.clamp(1 - Math.abs(d.face), 0.25, 1);
          const g = ctx.createRadialGradient(x, hy + 0.02, 0, x, hy + 0.03, 0.1);
          g.addColorStop(0, this.style.body.patch);
          g.addColorStop(0.55, U.mix(this.style.body.patch, '#00000000', 0.35));
          g.addColorStop(1, 'rgba(242,181,60,0)');
          ctx.save();
          ctx.globalAlpha = 0.9 * vis;
          ctx.fillStyle = g;
          ctx.beginPath();
          ctx.ellipse(x, hy + 0.025, 0.062, 0.085, d.x * 0.3, 0, TAU);
          ctx.fill();
          ctx.restore();
        };
        drawPatch(this._decal(-2.1, yaw));
        drawPatch(this._decal(2.1, yaw));
      }

      /* White cheek patches. Kept SMALL and dim on purpose: at 0.09 radius
         and 0.95 alpha the two of them overlapped into a single pale mask
         that turned the head into a grey helmet floating above a black body.
         A penguin's head is black — the patch is a detail around the eye,
         not the face. */
      const patch = (d, sc) => {
        if (d.face <= -0.02) return;
        const x = d.x * hrx * 0.94;
        const fs = Math.max(0.08, Math.abs(d.face));     // foreshorten
        const a = U.clamp((d.face + 0.02) / 0.32, 0, 1);
        ctx.save();
        ctx.globalAlpha = a * 0.5;
        const g = ctx.createRadialGradient(x, hy - 0.02, 0, x, hy - 0.01, 0.055 * sc);
        g.addColorStop(0, 'rgba(236,248,255,0.85)');
        g.addColorStop(0.55, 'rgba(206,230,250,0.4)');
        g.addColorStop(1, 'rgba(180,214,242,0)');
        ctx.fillStyle = g;
        ctx.beginPath();
        ctx.ellipse(x, hy - 0.012, 0.05 * sc * fs, 0.058 * sc, 0, 0, TAU);
        ctx.fill();
        ctx.restore();
      };
      patch(eyeL, 1); patch(eyeR, 1);

      /* beak — a wedge poking out of the silhouette */
      if (beak.face > -0.28) {
        const bx = beak.x * hrx * 1.0;
        const by = hy + 0.028;
        const open = f[3] * 0.055;
        const fs = U.clamp((beak.face + 0.28) / 0.9, 0.18, 1);
        const len = 0.115 * (0.42 + fs * 0.58);
        const dir = U.sign(beak.x) || 1;
        // The beak leaves the head along the surface normal at θ=0.
        const nx = beak.x, ny = 0;
        ctx.save();
        ctx.translate(bx, by);
        ctx.rotate(Math.atan2(ny, nx) + (dir > 0 ? 0 : Math.PI));
        const bl = len, bw = 0.052;
        // upper mandible
        const g1 = ctx.createLinearGradient(0, -bw, bl, bw * 0.4);
        g1.addColorStop(0, '#ffb648');
        g1.addColorStop(0.45, '#f79228');
        g1.addColorStop(1, '#d96a12');
        ctx.fillStyle = g1;
        ctx.beginPath();
        ctx.moveTo(-0.02, -bw * 0.75);
        ctx.quadraticCurveTo(bl * 0.62, -bw * 0.62 - open * 0.5, bl, -open * 0.35);
        ctx.quadraticCurveTo(bl * 0.55, bw * 0.08 - open * 0.35, -0.02, bw * 0.12);
        ctx.closePath(); ctx.fill();
        // lower mandible
        const g2 = ctx.createLinearGradient(0, 0, bl, bw);
        g2.addColorStop(0, '#e8892a');
        g2.addColorStop(1, '#b8560c');
        ctx.fillStyle = g2;
        ctx.beginPath();
        ctx.moveTo(-0.02, bw * 0.12);
        ctx.quadraticCurveTo(bl * 0.5, bw * 0.5 + open, bl * 0.92, open * 0.62);
        ctx.quadraticCurveTo(bl * 0.5, open * 0.2, -0.02, bw * 0.16);
        ctx.closePath(); ctx.fill();
        // specular ridge
        ctx.strokeStyle = 'rgba(255,238,190,0.6)';
        ctx.lineWidth = 0.009;
        ctx.beginPath();
        ctx.moveTo(0.01, -bw * 0.5);
        ctx.quadraticCurveTo(bl * 0.6, -bw * 0.42 - open * 0.5, bl * 0.94, -open * 0.3);
        ctx.stroke();
        ctx.restore();
      }

      /* eyes */
      const eye = (d, side) => {
        if (d.face <= 0.0) return;
        const x = d.x * hrx * 0.9;
        const fs = U.clamp(d.face, 0.12, 1);              // squash toward the rim
        const open = U.clamp(f[2] * (this.blink > 0 ? U.clamp(1 - this.blink / 0.08, 0, 1) : 1), 0.02, 1.5);
        const rx = 0.045 * fs, ry = 0.052 * open;
        const a = U.clamp(d.face / 0.3, 0, 1);
        ctx.save();
        ctx.globalAlpha = a;

        // sclera
        ctx.fillStyle = '#fdfeff';
        ctx.beginPath(); ctx.ellipse(x, hy - 0.012, rx * 1.28, ry * 1.05, 0, 0, TAU); ctx.fill();

        if (open > 0.12) {
          // iris + pupil, with the gaze drifting toward the beak side
          const gz = U.sign(this.headYaw) * 0.012 * fs;
          const ig = ctx.createRadialGradient(x + gz - rx * 0.2, hy - 0.03, 0, x + gz, hy - 0.012, rx * 1.05);
          ig.addColorStop(0, '#4a6a8e');
          ig.addColorStop(0.55, '#1d2f47');
          ig.addColorStop(1, '#080f1c');
          ctx.fillStyle = ig;
          ctx.beginPath(); ctx.ellipse(x + gz, hy - 0.012, rx * 0.86, ry * 0.86, 0, 0, TAU); ctx.fill();
          // catchlights — two, offset. This is what makes eyes feel alive.
          ctx.fillStyle = 'rgba(255,255,255,0.95)';
          ctx.beginPath(); ctx.ellipse(x + gz - rx * 0.3, hy - 0.034, rx * 0.28, ry * 0.24, 0, 0, TAU); ctx.fill();
          ctx.fillStyle = U.rgba(this.auroraLight[0], this.auroraLight[1], this.auroraLight[2], 0.75);
          ctx.beginPath(); ctx.ellipse(x + gz + rx * 0.32, hy + 0.014, rx * 0.16, ry * 0.14, 0, 0, TAU); ctx.fill();
        }
        // lid — closes from the top, like a real blink
        if (open < 0.98) {
          ctx.fillStyle = '#1b2c48';
          const lidH = ry * 2 * (1 - open / 0.98);
          ctx.beginPath();
          ctx.ellipse(x, hy - 0.012, rx * 1.34, ry * 1.1, 0, Math.PI, TAU);
          ctx.fill();
          ctx.fillRect(x - rx * 1.34, hy - 0.012 - ry * 1.1, rx * 2.68, Math.max(0, lidH - ry * 1.1) + 0.001);
        }

        // brow — the single biggest expression lever
        ctx.strokeStyle = '#0e1a2e';
        ctx.lineWidth = 0.017 * fs + 0.004;
        ctx.lineCap = 'round';
        const bAng = f[0] * side;
        const by = hy - 0.078 + f[1];
        ctx.save();
        ctx.translate(x, by); ctx.rotate(bAng);
        ctx.beginPath();
        ctx.moveTo(-rx * 1.25, 0.004);
        ctx.quadraticCurveTo(0, -0.016, rx * 1.25, 0.004);
        ctx.stroke();
        ctx.restore();
        ctx.restore();
      };
      // Draw the far eye first so the near one overlaps at the silhouette.
      if (eyeL.face < eyeR.face) { eye(eyeL, -1); eye(eyeR, 1); }
      else { eye(eyeR, 1); eye(eyeL, -1); }

      /* blush */
      if (f[4] > 0.03) {
        const blush = (d) => {
          if (d.face <= 0.02) return;
          const x = d.x * hrx * 0.88;
          ctx.save();
          ctx.globalCompositeOperation = 'source-over';
          const g = ctx.createRadialGradient(x, hy + 0.06, 0, x, hy + 0.06, 0.06);
          g.addColorStop(0, 'rgba(255,138,158,' + (f[4] * 0.55 * U.clamp(d.face, 0, 1)).toFixed(3) + ')');
          g.addColorStop(1, 'rgba(255,138,158,0)');
          ctx.fillStyle = g;
          ctx.beginPath(); ctx.arc(x, hy + 0.06, 0.06, 0, TAU); ctx.fill();
          ctx.restore();
        };
        blush(cheekL); blush(cheekR);
      }

      /* head-top sheen */
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      const L = this.auroraLight;
      const hs = ctx.createRadialGradient(-0.05, yTop + 0.06, 0, 0, yTop + 0.09, 0.16);
      hs.addColorStop(0, U.rgba(L[0], L[1], L[2], 0.22));
      hs.addColorStop(1, U.rgba(L[0], L[1], L[2], 0));
      ctx.fillStyle = hs;
      ctx.beginPath(); ctx.ellipse(0, yTop + 0.1, 0.17, 0.1, 0, 0, TAU); ctx.fill();
      ctx.restore();
    }

    /* ── wings ──────────────────────────────────────────────── */
    _wing(ctx, side, phase, sliding, cel) {
      const yaw = this.bodyYaw;
      // Shoulder rides the body ellipsoid too, so wings stay attached
      // as the torso turns.
      const d = this._decal(side * 1.42, yaw);
      const sx = d.x * 0.30;
      const sy = -0.545;
      const depth = d.face;                        // <0 = far side

      /* Angles are authored for a wing pointing DOWN-RIGHT (measured from
         +x, screen y down) and then mirrored for the other side.
         `side * angle` was the old approach and it is wrong: negating an
         angle mirrors across the HORIZONTAL axis, so the left wing pointed
         up-right like a raised blade. Mirroring left/right is π − angle.
         Which side a wing is actually on depends on the body yaw, so the
         mirror has to key off its projected x, not off the abstract side. */
      let a;
      if (cel) a = 0.28 - Math.sin(this.runPhase * 2.4) * 0.5;          // wings up, cheering
      else if (sliding) a = 2.42 + Math.sin(this.runPhase * 0.6) * 0.06; // swept back
      else if (this.fsm.is('hit')) a = 0.7 + Math.sin(this.hitSpin * 4) * 0.6;
      else if (!this.onGround) a = 0.62 + Math.sin(this.runPhase * 3.4) * 0.42;
      else a = 1.24 + phase * 0.30 - this.wingFlap * 0.55;               // tucked, swinging

      const outward = (Math.abs(d.x) < 0.02 ? side : U.sign(d.x));
      const ang = outward >= 0 ? a : Math.PI - a;

      const len = 0.335, w = 0.098;
      ctx.save();
      ctx.translate(sx, sy);
      ctx.rotate(ang);
      // Foreshorten the far wing horizontally — it's pointing away from us.
      const fs = U.lerp(0.55, 1, U.clamp((depth + 1) / 2, 0, 1));
      ctx.scale(1, 1);

      ctx.beginPath();
      ctx.moveTo(0, -w * 0.55);
      ctx.bezierCurveTo(len * 0.42, -w * 1.05 * fs, len * 0.86, -w * 0.72 * fs, len, w * 0.1);
      ctx.bezierCurveTo(len * 0.88, w * 0.62 * fs, len * 0.4, w * 0.86 * fs, 0, w * 0.72);
      ctx.closePath();

      const g = ctx.createLinearGradient(0, -w, len, w);
      if (depth < 0) {                             // far wing sits in shadow
        g.addColorStop(0, '#16243c');
        g.addColorStop(0.6, '#101a2e');
        g.addColorStop(1, '#0a1120');
      } else {
        g.addColorStop(0, '#2a4064');
        g.addColorStop(0.55, '#1a2a46');
        g.addColorStop(1, '#101a2f');
      }
      ctx.fillStyle = g;
      ctx.fill();

      // rim + tip highlight
      const L = this.auroraLight;
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      const rg = ctx.createLinearGradient(len * 0.3, -w, len, w * 0.5);
      rg.addColorStop(0, U.rgba(L[0], L[1], L[2], 0));
      rg.addColorStop(1, U.rgba(L[0], L[1], L[2], depth < 0 ? 0.18 : 0.42));
      ctx.fillStyle = rg;
      ctx.fill();
      ctx.restore();

      ctx.strokeStyle = 'rgba(6,12,24,0.4)';
      ctx.lineWidth = 0.010;
      ctx.stroke();

      // Underside crease — sells thickness.
      ctx.strokeStyle = 'rgba(150,190,230,0.14)';
      ctx.lineWidth = 0.008;
      ctx.beginPath();
      ctx.moveTo(len * 0.12, w * 0.32);
      ctx.quadraticCurveTo(len * 0.55, w * 0.5, len * 0.9, w * 0.06);
      ctx.stroke();
      ctx.restore();
    }

    /* ── feet ───────────────────────────────────────────────── */
    _feet(ctx, legA, legB, sliding, cel) {
      const foot = (phase, baseX, back) => {
        // 8-phase cycle compressed into two sines: lift + swing.
        const lift = sliding ? 0 : Math.max(0, Math.sin(phase)) * 0.115;
        const swing = sliding ? 0 : Math.cos(phase) * 0.085;
        const x = baseX + swing;
        const y = -0.012 - lift;
        const tilt = sliding ? -0.5 : Math.cos(phase) * 0.42;

        ctx.save();
        ctx.translate(x, y);
        ctx.rotate(tilt * 0.5);
        const w = 0.088, h = 0.042;
        const g = ctx.createLinearGradient(0, -h, 0, h);
        g.addColorStop(0, back ? '#e08a2a' : '#ffbe58');
        g.addColorStop(0.5, back ? '#c06a14' : '#f79228');
        g.addColorStop(1, back ? '#944c08' : '#c96a12');
        ctx.fillStyle = g;
        // Webbed foot: three toes fanning forward.
        ctx.beginPath();
        ctx.moveTo(-w * 0.42, -h * 0.75);
        ctx.lineTo(w * 0.55, -h * 0.55);
        ctx.quadraticCurveTo(w * 0.95, -h * 0.3, w * 0.92, h * 0.05);
        ctx.quadraticCurveTo(w * 0.7, h * 0.42, w * 0.3, h * 0.5);
        ctx.quadraticCurveTo(-w * 0.2, h * 0.6, -w * 0.5, h * 0.2);
        ctx.closePath();
        ctx.fill();
        // Toe splits.
        ctx.strokeStyle = 'rgba(140,66,8,0.5)';
        ctx.lineWidth = 0.007;
        ctx.beginPath();
        ctx.moveTo(w * 0.12, -h * 0.35); ctx.lineTo(w * 0.8, -h * 0.05);
        ctx.moveTo(w * 0.1, h * 0.05); ctx.lineTo(w * 0.72, h * 0.34);
        ctx.stroke();
        // Top highlight.
        ctx.fillStyle = 'rgba(255,226,160,0.34)';
        ctx.beginPath();
        ctx.moveTo(-w * 0.36, -h * 0.6);
        ctx.lineTo(w * 0.5, -h * 0.42);
        ctx.quadraticCurveTo(w * 0.2, -h * 0.1, -w * 0.3, -h * 0.2);
        ctx.closePath();
        ctx.fill();
        ctx.restore();
      };
      const spread = cel ? 0.16 : 0.105;
      // Far foot first.
      if (legA > legB) { foot(legB + Math.PI, -spread, true); foot(legA, spread, false); }
      else { foot(legA, spread, true); foot(legB + Math.PI, -spread, false); }
    }

    /* ── scarf ──────────────────────────────────────────────── */
    _scarf(ctx) {
      const s = this.scarf;
      const L = this.auroraLight;

      /* neck wrap — a torus band around the ellipsoid */
      const SC = this.style.scarf;
      const yaw = this.bodyYaw;
      ctx.save();
      const ny = -0.635;
      const g = ctx.createLinearGradient(-0.22, ny - 0.05, 0.22, ny + 0.06);
      g.addColorStop(0, U.mix(SC.base, SC.dark, 0.45));
      g.addColorStop(0.4, SC.base);
      g.addColorStop(0.72, SC.light);
      g.addColorStop(1, SC.deep);
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.ellipse(Math.sin(yaw) * 0.012, ny, 0.222, 0.062, this.lean * 0.4, 0, TAU);
      ctx.fill();
      // knit ribbing
      ctx.save();
      ctx.beginPath();
      ctx.ellipse(Math.sin(yaw) * 0.012, ny, 0.222, 0.062, this.lean * 0.4, 0, TAU);
      ctx.clip();
      // Ribbing shade = the scarf's own dark tone, pulled toward black, at
      // 40 % — U.parseColor keeps this correct for any wardrobe colour.
      const ribC = U.parseColor(U.mix(SC.dark, '#000000', 0.35));
      ctx.strokeStyle = U.rgba(ribC[0], ribC[1], ribC[2], 0.4);
      ctx.lineWidth = 0.009;
      for (let i = -5; i <= 5; i++) {
        const rx = i * 0.042;
        ctx.beginPath();
        ctx.moveTo(rx, ny - 0.07);
        ctx.quadraticCurveTo(rx + 0.012, ny, rx, ny + 0.07);
        ctx.stroke();
      }
      // top-lit edge
      const sg = ctx.createLinearGradient(0, ny - 0.06, 0, ny + 0.02);
      const litC = U.parseColor(U.mix(SC.light, '#ffffff', 0.5));
      sg.addColorStop(0, U.rgba(litC[0], litC[1], litC[2], 0.5));
      sg.addColorStop(1, 'rgba(255,255,255,0)');
      ctx.fillStyle = sg;
      ctx.fillRect(-0.24, ny - 0.07, 0.48, 0.09);
      ctx.restore();
      // shadow the scarf casts on the chest
      const sh = ctx.createLinearGradient(0, ny + 0.03, 0, ny + 0.13);
      sh.addColorStop(0, 'rgba(8,14,28,0.4)');
      sh.addColorStop(1, 'rgba(8,14,28,0)');
      ctx.fillStyle = sh;
      ctx.fillRect(-0.2, ny + 0.03, 0.4, 0.1);
      ctx.restore();

      /* trailing tail — verlet chain, tapered ribbon, toward the camera */
      const pts = [];
      for (let i = 1; i < s.length; i++) pts.push([s[i].x, s[i].y]);
      if (pts.length < 2) return;

      ctx.save();
      // Build the ribbon as a tapered stroke stack: wide near the neck,
      // whipping thin at the tip. Growing width also fakes it coming at us.
      for (let pass = 0; pass < 2; pass++) {
        for (let i = 1; i < pts.length; i++) {
          const t = i / (pts.length - 1);
          // Tapers as cloth does, but perspective growth (it is flying at the
          // lens) roughly cancels it, so it stays near-constant down its
          // length. Wider than this and the round caps read as a hose.
          const w = U.lerp(0.070, 0.040, t) * (1 + t * 0.5);
          const a = pass === 0 ? 1 : 0.5;
          ctx.strokeStyle = pass === 0
            ? U.mix(SC.base, SC.dark, t * 0.75)
            : (function (c) { return U.rgba(c[0], c[1], c[2], 0.4 * (1 - t)); })(U.parseColor(U.mix(SC.light, '#ffffff', 0.4)));
          ctx.lineWidth = pass === 0 ? w : w * 0.32;
          ctx.lineCap = 'round';
          ctx.globalAlpha = a;
          ctx.beginPath();
          ctx.moveTo(pts[i - 1][0], pts[i - 1][1] - (pass === 1 ? w * 0.26 : 0));
          ctx.lineTo(pts[i][0], pts[i][1] - (pass === 1 ? w * 0.26 : 0));
          ctx.stroke();
        }
      }
      // Aurora rim on the cloth.
      ctx.globalCompositeOperation = 'lighter';
      ctx.globalAlpha = 0.4;
      ctx.strokeStyle = U.rgba(L[0], L[1], L[2], 0.5);
      ctx.lineWidth = 0.014;
      ctx.beginPath(); U.smoothLine(ctx, pts); ctx.stroke();
      ctx.globalCompositeOperation = 'source-over';
      ctx.globalAlpha = 1;

      // Fringe at the tip.
      const tip = pts[pts.length - 1], prev = pts[pts.length - 2];
      const ang = Math.atan2(tip[1] - prev[1], tip[0] - prev[0]);
      ctx.strokeStyle = SC.fringe;
      ctx.lineWidth = 0.011;
      for (let i = -2; i <= 2; i++) {
        const a2 = ang + i * 0.19;
        ctx.beginPath();
        ctx.moveTo(tip[0], tip[1]);
        ctx.lineTo(tip[0] + Math.cos(a2) * 0.06, tip[1] + Math.sin(a2) * 0.06);
        ctx.stroke();
      }
      ctx.restore();
    }
  }

  Player.HEIGHT = H;
  global.Player = Player;
})(window);
