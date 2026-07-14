/* ═══════════════════════════════════════════════════════════
   CollectibleManager — treasures, their art and their placement.

   SEVEN PICKUPS
     fish          +1   the pulse of the run; everything else is seasoning
     goldenFish    +12  rare, loud, always at the crest of a jump arc
     crystal       ×2   score multiplier, 10 s
     shield        —    eats one hit
     magnet        —    vacuums fish for 9 s
     cocoa         —    warmth burst: brief invincible sprint
     auroraCrystal +250 flares the whole sky

   PLACEMENT IS THE LEVEL DESIGN. Trails are laid where the penguin is
   already going to be: over a jumpable hazard they arc through the jump
   parabola; under an arch they hug the ice. Collecting then costs no
   extra risk — it *confirms* you read the obstacle right. That is why
   `layTrail()` takes a shape rather than a position.
   ═══════════════════════════════════════════════════════════ */
(function (global) {
  'use strict';

  const U = global.U;
  const W3 = global.WORLD;
  const TAU = U.TAU;

  const FISH = 'fish', GOLD = 'goldenFish', CRYSTAL = 'crystal', SHIELD = 'shield',
        MAGNET = 'magnet', COCOA = 'cocoa', AURORA = 'auroraCrystal';

  const SPEC = {
    fish:          { r: 0.34, score: 1, col: [255, 209, 102], power: null },
    goldenFish:    { r: 0.40, score: 12, col: [255, 236, 150], power: null },
    crystal:       { r: 0.42, score: 25, col: [168, 130, 255], power: 'multiplier' },
    shield:        { r: 0.44, score: 15, col: [96, 214, 255], power: 'shield' },
    magnet:        { r: 0.42, score: 15, col: [255, 118, 156], power: 'magnet' },
    cocoa:         { r: 0.42, score: 20, col: [255, 158, 84], power: 'cocoa' },
    auroraCrystal: { r: 0.50, score: 250, col: [110, 255, 214], power: 'aurora' }
  };

  const FLOAT_Y = 0.92;          // resting height of a fish trail

  class CollectibleManager {
    constructor(camera, particles) {
      this.cam = camera;
      this.ps = particles;
      this.list = [];
      this.nextZ = 0;
      this.t = 0;
      this.quality = 1;
      this._p = { x: 0, y: 0, s: 0, visible: false };
      this._sinceP = 0;          // metres since the last power-up
    }

    reset() {
      this.list.length = 0;
      this.nextZ = 34;
      this.t = 0;
      this._sinceP = 0;
    }

    _emit(type, x, y, z) {
      this.list.push({
        type, x, y, z: z, z0: z, baseY: y,
        phase: U.rand(0, TAU),
        spin: U.rand(0, TAU),
        seed: (Math.random() * 1e9) | 0,
        taken: false, pop: 0, magnet: false
      });
    }

    /**
     * Lay a run of pickups along a shape.
     * @param {string} shape 'line' | 'arc' | 'zig' | 'wave' | 'ground'
     */
    layTrail(shape, lane, z, n, type) {
      const t = type || FISH;
      const step = 2.05;
      for (let i = 0; i < n; i++) {
        const u = n > 1 ? i / (n - 1) : 0.5;
        let x = W3.LANES[lane], y = FLOAT_Y;
        switch (shape) {
          case 'arc':
            // Mirrors the jump parabola, so the trail IS the jump cue.
            y = 0.55 + Math.sin(u * Math.PI) * 1.65;
            break;
          case 'ground':
            y = 0.34;                                   // slides under arches
            break;
          case 'zig': {
            const l = U.clamp(lane + (i % 2 === 0 ? 0 : 1), 0, 2);
            x = W3.LANES[l];
            break;
          }
          case 'wave':
            y = FLOAT_Y + Math.sin(u * Math.PI * 2) * 0.55;
            break;
        }
        this._emit(t, x, y, z + i * step);
      }
    }

    update(dt, worldZ, difficulty, obstacles, player, powers) {
      this.t += dt;

      while (this.nextZ < worldZ + W3.SPAWN_Z) {
        this._plan(this.nextZ, difficulty, obstacles);
        this.nextZ += U.rand(16, 30);
      }

      const mag = powers && powers.magnet > 0;
      const px = player ? player.x : 0, py = player ? player.y + 0.55 : 0.55;

      for (let i = this.list.length - 1; i >= 0; i--) {
        const c = this.list[i];
        c.z = c.z0 - worldZ;
        if (c.z < -5 || (c.taken && c.pop > 1)) { this.list.splice(i, 1); continue; }

        c.phase += dt * 2.2;
        c.spin += dt * 1.5;
        if (c.taken) { c.pop += dt * 4; continue; }

        c.y = c.baseY + Math.sin(c.phase) * 0.075;

        // Magnet: pull anything close, hard, on a spring.
        if (mag && SPEC[c.type].power === null && c.z > -1 && c.z < 17) {
          const d = Math.hypot(c.x - px, c.z - 0, c.y - py);
          if (d < 11) {
            c.magnet = true;
            const k = U.clamp(1 - d / 11, 0, 1) * 16 * dt;
            c.x = U.lerp(c.x, px, k);
            c.baseY = U.lerp(c.baseY, py, k);
            c.z0 = U.lerp(c.z0, worldZ, k * 0.9);
          }
        }

        // Sparkle motes on the good stuff.
        if (this.quality > 0.5 && SPEC[c.type].power && c.z > 0 && c.z < 26 && U.chance(dt * 5)) {
          const col = SPEC[c.type].col;
          this.ps.emit(3 /* SPARK */, c.x + U.rand(-.3, .3), c.y + U.rand(-.3, .3), c.z, {
            vy: U.rand(0.2, 0.9), life: U.rand(0.3, 0.7), size: U.rand(0.012, 0.03),
            r: col[0], g: col[1], b: col[2], a: 0.9, drag: 0.7
          });
        }
      }
    }

    /** Decide what goes at `z`, reading the obstacles already placed there. */
    _plan(z, d, obstacles) {
      this._sinceP += 22;

      // What's the hazard picture in this slice of runway?
      const near = obstacles ? obstacles.list.filter((o) => o.z0 > z - 5 && o.z0 < z + 16) : [];
      const byLane = [[], [], []];
      for (const o of near) byLane[o.lane].push(o);

      /* Power-up? Rare, and never two in a row. */
      const pChance = 0.16 + d * 0.06;
      if (this._sinceP > 210 && Math.random() < pChance) {
        this._sinceP = 0;
        const free = [0, 1, 2].filter((l) => !byLane[l].length);
        const lane = free.length ? U.pick(free) : U.randInt(0, 2);
        const roll = Math.random();
        let t;
        if (roll < 0.04) t = AURORA;
        else if (roll < 0.32) t = SHIELD;
        else if (roll < 0.58) t = MAGNET;
        else if (roll < 0.80) t = CRYSTAL;
        else t = COCOA;
        this._emit(t, W3.LANES[lane], 1.05, z);
        // Guide fish leading into it — pickups should be discovered, not stumbled on.
        this.layTrail('line', lane, z - 8, 3, FISH);
        return;
      }

      /* Trails shaped by whatever hazard shares the lane. */
      const lanes = [0, 1, 2];
      const choices = [];
      for (const l of lanes) {
        const o = byLane[l][0];
        if (!o) { choices.push({ lane: l, shape: U.chance(0.3) ? 'wave' : 'line', z, bonus: false }); continue; }
        if (o.verb === 'jump') choices.push({ lane: l, shape: 'arc', z: o.z0 - 3.2, bonus: true });
        else if (o.verb === 'slide') choices.push({ lane: l, shape: 'ground', z: o.z0 + 1.4, bonus: true });
        // dodge lanes get nothing — that lane is a wall
      }
      if (!choices.length) return;

      const c = U.pick(choices);
      const n = c.shape === 'arc' ? 5 : c.shape === 'ground' ? 4 : U.randInt(4, 7);
      this.layTrail(c.shape, c.lane, c.z, n, FISH);

      // A golden fish at the apex is the reward for committing to the jump.
      if (c.bonus && c.shape === 'arc' && Math.random() < 0.3) {
        this.list.pop();                                       // swap the middle one
        this._emit(GOLD, W3.LANES[c.lane], 2.2, c.z + 2.05 * 2);
      } else if (!c.bonus && Math.random() < 0.09) {
        this._emit(GOLD, W3.LANES[c.lane], FLOAT_Y, c.z + n * 2.05 + 2.4);
      }
    }

    collect(c) {
      if (c.taken) return;
      c.taken = true; c.pop = 0;
      const sp = SPEC[c.type];
      this.ps.pickupBurst(c.x, c.y, c.z, sp.col, !!sp.power || c.type === GOLD);
    }

    getSpec(type) { return SPEC[type]; }

    /* ══════════════════════════════════════════════════════════
       ART
       ══════════════════════════════════════════════════════════ */

    draw(ctx, bg) {
      const list = this.list.slice().sort((a, b) => b.z - a.z);
      for (let i = 0; i < list.length; i++) this._drawOne(ctx, list[i], bg);
    }

    _drawOne(ctx, c, bg) {
      const cam = this.cam, p = this._p;
      cam.project(c.x, c.y, c.z, p);
      if (!p.visible) return;
      const s = p.s;
      if (s < 0.5 || c.z > 96) return;
      const fog = U.clamp((c.z - 34) / 58, 0, 1);
      if (fog > 0.9) return;

      // LOD: below ~11 px across, the scale art is a smudge nobody can read.
      // Its glow is the only part that survives — so paint just that. This is
      // most of the list on any given frame, and it was costing 4.4 ms.
      if (SPEC[c.type].r * 2 * s < 11) {
        ctx.save();
        ctx.globalAlpha = 1 - fog;
        ctx.translate(p.x, p.y);
        ctx.scale(s, s);
        this._glow(ctx, c);
        const sp = SPEC[c.type];
        ctx.fillStyle = U.rgba(sp.col[0], sp.col[1], sp.col[2], 0.95);
        ctx.beginPath(); ctx.arc(0, 0, sp.r * 0.42, 0, TAU); ctx.fill();
        ctx.restore();
        return;
      }

      let scale = s, alpha = 1 - fog;
      if (c.taken) {
        // Pop: swell then vanish. Sells the pickup better than a fade alone.
        scale *= 1 + U.Ease.outQuart(U.clamp(c.pop, 0, 1)) * 1.1;
        alpha *= 1 - U.clamp(c.pop, 0, 1);
      }
      if (alpha <= 0.01) return;

      ctx.save();
      ctx.globalAlpha = alpha;
      ctx.translate(p.x, p.y);
      ctx.scale(scale, scale);

      this._glow(ctx, c);
      switch (c.type) {
        case FISH: this._fish(ctx, c, false); break;
        case GOLD: this._fish(ctx, c, true); break;
        case CRYSTAL: this._gem(ctx, c); break;
        case SHIELD: this._shield(ctx, c); break;
        case MAGNET: this._magnet(ctx, c); break;
        case COCOA: this._cocoa(ctx, c); break;
        case AURORA: this._aurora(ctx, c); break;
      }
      ctx.restore();
    }

    /** Soft halo — every pickup must be visible against busy ice. */
    _glow(ctx, c) {
      const sp = SPEC[c.type];
      const pulse = 0.78 + 0.22 * Math.sin(c.phase * 1.6);
      const r = sp.r * (sp.power ? 2.3 : 1.7) * pulse;
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      const g = ctx.createRadialGradient(0, 0, 0, 0, 0, r);
      g.addColorStop(0, U.rgba(sp.col[0], sp.col[1], sp.col[2], 0.5 * pulse));
      g.addColorStop(0.35, U.rgba(sp.col[0], sp.col[1], sp.col[2], 0.16 * pulse));
      g.addColorStop(1, U.rgba(sp.col[0], sp.col[1], sp.col[2], 0));
      ctx.fillStyle = g;
      ctx.beginPath(); ctx.arc(0, 0, r, 0, TAU); ctx.fill();
      ctx.restore();
    }

    /* ── FISH ──────────────────────────────────────────────── */
    _fish(ctx, c, gold) {
      // Spin about the vertical axis: the body squashes to a sliver and
      // flips — a real rotation read, not a spinning flat card.
      const yaw = c.spin;
      const fs = Math.cos(yaw);
      const flip = fs < 0 ? -1 : 1;
      const sq = Math.max(0.12, Math.abs(fs));
      const swim = Math.sin(c.phase * 2.4) * 0.14;

      ctx.save();
      ctx.rotate(Math.sin(c.phase) * 0.1);
      ctx.scale(sq * flip, 1);

      const L = 0.3, Hh = 0.17;
      const body = gold
        ? [['#fff6cf', 0], ['#ffdb63', 0.34], ['#f5ae1c', 0.68], ['#c4780a', 1]]
        : [['#dff2ff', 0], ['#8fd0f0', 0.3], ['#4b9ed0', 0.68], ['#2a6796', 1]];

      // Tail — swishes with the swim cycle.
      ctx.save();
      ctx.translate(-L * 0.86, 0);
      ctx.rotate(swim);
      const tg = ctx.createLinearGradient(-L * 0.3, 0, 0, 0);
      tg.addColorStop(0, gold ? '#e79c12' : '#3f86b8');
      tg.addColorStop(1, gold ? '#ffd95e' : '#8ccdef');
      ctx.fillStyle = tg;
      ctx.beginPath();
      ctx.moveTo(0.02, 0);
      ctx.quadraticCurveTo(-L * 0.22, -Hh * 0.95, -L * 0.34, -Hh * 0.86);
      ctx.quadraticCurveTo(-L * 0.2, 0, -L * 0.34, Hh * 0.86);
      ctx.quadraticCurveTo(-L * 0.22, Hh * 0.95, 0.02, 0);
      ctx.closePath(); ctx.fill();
      ctx.restore();

      // Dorsal + pelvic fins.
      ctx.fillStyle = gold ? 'rgba(240,168,20,0.9)' : 'rgba(66,142,190,0.9)';
      ctx.beginPath();
      ctx.moveTo(-L * 0.1, -Hh * 0.72);
      ctx.quadraticCurveTo(0, -Hh * 1.5 + swim * 0.2, L * 0.2, -Hh * 0.6);
      ctx.closePath(); ctx.fill();
      ctx.beginPath();
      ctx.moveTo(-L * 0.06, Hh * 0.64);
      ctx.quadraticCurveTo(L * 0.04, Hh * 1.24, L * 0.24, Hh * 0.5);
      ctx.closePath(); ctx.fill();

      // Body.
      ctx.beginPath();
      ctx.moveTo(L, 0);
      ctx.bezierCurveTo(L * 0.72, -Hh * 1.02, -L * 0.3, -Hh * 1.0, -L * 0.84, 0);
      ctx.bezierCurveTo(-L * 0.3, Hh * 1.0, L * 0.72, Hh * 1.02, L, 0);
      ctx.closePath();
      const g = ctx.createLinearGradient(0, -Hh, 0, Hh);
      for (const [col, st] of body) g.addColorStop(st, col);
      ctx.fillStyle = g;
      ctx.fill();

      ctx.save();
      ctx.clip();
      // Scales — arcs, cheap, immediately legible as fish.
      ctx.strokeStyle = gold ? 'rgba(180,110,10,0.28)' : 'rgba(28,80,124,0.24)';
      ctx.lineWidth = 0.012;
      for (let i = -2; i <= 3; i++) {
        ctx.beginPath();
        ctx.arc(-L * 0.1 + i * 0.085, 0, Hh * 0.85, -1.1, 1.1);
        ctx.stroke();
      }
      // Lateral line + belly.
      const bg2 = ctx.createLinearGradient(0, 0, 0, Hh);
      bg2.addColorStop(0, 'rgba(255,255,255,0)');
      bg2.addColorStop(1, gold ? 'rgba(255,246,206,0.5)' : 'rgba(226,246,255,0.55)');
      ctx.fillStyle = bg2;
      ctx.fillRect(-L, 0, L * 2, Hh);
      // Top specular.
      ctx.globalCompositeOperation = 'lighter';
      const sp = ctx.createLinearGradient(0, -Hh, 0, 0);
      sp.addColorStop(0, gold ? 'rgba(255,252,220,0.6)' : 'rgba(235,250,255,0.55)');
      sp.addColorStop(1, 'rgba(255,255,255,0)');
      ctx.fillStyle = sp;
      ctx.fillRect(-L, -Hh, L * 2, Hh);
      ctx.restore();

      ctx.strokeStyle = gold ? 'rgba(140,82,4,0.4)' : 'rgba(20,64,104,0.35)';
      ctx.lineWidth = 0.011;
      ctx.stroke();

      // Eye.
      ctx.fillStyle = '#fff';
      ctx.beginPath(); ctx.arc(L * 0.62, -Hh * 0.24, 0.044, 0, TAU); ctx.fill();
      ctx.fillStyle = '#101c2c';
      ctx.beginPath(); ctx.arc(L * 0.65, -Hh * 0.24, 0.026, 0, TAU); ctx.fill();
      ctx.fillStyle = 'rgba(255,255,255,0.95)';
      ctx.beginPath(); ctx.arc(L * 0.6, -Hh * 0.34, 0.012, 0, TAU); ctx.fill();
      ctx.restore();

      // Golden fish gets a rotating star flare.
      if (gold) {
        ctx.save();
        ctx.globalCompositeOperation = 'lighter';
        ctx.rotate(c.spin * 0.5);
        const fl = 0.62 + Math.sin(c.phase * 2) * 0.12;
        const fg = ctx.createLinearGradient(-fl, 0, fl, 0);
        fg.addColorStop(0, 'rgba(255,224,120,0)');
        fg.addColorStop(0.5, 'rgba(255,244,190,0.5)');
        fg.addColorStop(1, 'rgba(255,224,120,0)');
        ctx.fillStyle = fg;
        ctx.fillRect(-fl, -0.012, fl * 2, 0.024);
        ctx.fillRect(-0.012, -fl * 0.55, 0.024, fl * 1.1);
        ctx.restore();
      }
    }

    /* ── MULTIPLIER GEM ────────────────────────────────────── */
    _gem(ctx, c) {
      const yaw = c.spin * 1.3;
      const sq = Math.max(0.18, Math.abs(Math.cos(yaw)));
      const R = 0.30;
      ctx.save();
      ctx.rotate(Math.sin(c.phase * 0.6) * 0.12);
      ctx.scale(sq, 1);

      // Octahedron read: top pyramid + bottom pyramid, four facets.
      const facets = [
        { p: [[0, -R * 1.5], [-R, -R * 0.1], [0, -R * 0.1]], c: 'rgba(214,190,255,0.95)' },
        { p: [[0, -R * 1.5], [R, -R * 0.1], [0, -R * 0.1]], c: 'rgba(138,92,232,0.95)' },
        { p: [[0, R * 1.5], [-R, -R * 0.1], [0, -R * 0.1]], c: 'rgba(160,116,246,0.95)' },
        { p: [[0, R * 1.5], [R, -R * 0.1], [0, -R * 0.1]], c: 'rgba(94,54,178,0.95)' }
      ];
      for (const f of facets) {
        ctx.beginPath();
        ctx.moveTo(f.p[0][0], f.p[0][1]);
        ctx.lineTo(f.p[1][0], f.p[1][1]);
        ctx.lineTo(f.p[2][0], f.p[2][1]);
        ctx.closePath();
        ctx.fillStyle = f.c;
        ctx.fill();
      }
      // Inner light.
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      const ig = ctx.createRadialGradient(0, -R * 0.1, 0, 0, -R * 0.1, R * 1.2);
      ig.addColorStop(0, 'rgba(240,224,255,0.8)');
      ig.addColorStop(0.5, 'rgba(178,132,255,0.24)');
      ig.addColorStop(1, 'rgba(150,100,255,0)');
      ctx.fillStyle = ig;
      ctx.beginPath(); ctx.arc(0, -R * 0.1, R * 1.2, 0, TAU); ctx.fill();
      ctx.restore();

      ctx.strokeStyle = 'rgba(246,238,255,0.7)';
      ctx.lineWidth = 0.014;
      ctx.beginPath();
      ctx.moveTo(0, -R * 1.5); ctx.lineTo(-R, -R * 0.1); ctx.lineTo(0, R * 1.5);
      ctx.lineTo(R, -R * 0.1); ctx.closePath();
      ctx.moveTo(-R, -R * 0.1); ctx.lineTo(R, -R * 0.1);
      ctx.stroke();
      ctx.restore();

      this._badge(ctx, '×2', '#f0e4ff');
    }

    /* ── SHIELD ────────────────────────────────────────────── */
    _shield(ctx, c) {
      const R = 0.34;
      const pulse = 0.86 + 0.14 * Math.sin(c.phase * 2.2);
      ctx.save();
      ctx.rotate(Math.sin(c.phase * 0.5) * 0.1);

      // Crest.
      ctx.beginPath();
      ctx.moveTo(0, -R * 1.2);
      ctx.quadraticCurveTo(R, -R * 1.05, R * 0.98, -R * 0.28);
      ctx.quadraticCurveTo(R * 0.92, R * 0.72, 0, R * 1.28);
      ctx.quadraticCurveTo(-R * 0.92, R * 0.72, -R * 0.98, -R * 0.28);
      ctx.quadraticCurveTo(-R, -R * 1.05, 0, -R * 1.2);
      ctx.closePath();
      const g = ctx.createLinearGradient(-R, -R, R * 0.6, R);
      g.addColorStop(0, 'rgba(216,248,255,0.95)');
      g.addColorStop(0.4, 'rgba(96,206,250,0.9)');
      g.addColorStop(1, 'rgba(28,110,176,0.92)');
      ctx.fillStyle = g;
      ctx.fill();

      ctx.save();
      ctx.clip();
      ctx.globalCompositeOperation = 'lighter';
      const sg = ctx.createLinearGradient(-R, -R, 0, R * 0.4);
      sg.addColorStop(0, 'rgba(255,255,255,' + (0.6 * pulse).toFixed(3) + ')');
      sg.addColorStop(0.5, 'rgba(200,244,255,0.1)');
      sg.addColorStop(1, 'rgba(200,244,255,0)');
      ctx.fillStyle = sg;
      ctx.fillRect(-R * 1.2, -R * 1.4, R * 2.4, R * 2.8);
      ctx.restore();

      ctx.strokeStyle = 'rgba(238,254,255,0.9)';
      ctx.lineWidth = 0.02;
      ctx.stroke();

      // Snowflake emblem — reads instantly as "ice shield".
      ctx.save();
      ctx.rotate(c.spin * 0.4);
      ctx.strokeStyle = 'rgba(255,255,255,0.9)';
      ctx.lineWidth = 0.026;
      ctx.lineCap = 'round';
      for (let i = 0; i < 6; i++) {
        const a = (i / 6) * TAU;
        const ex = Math.cos(a) * R * 0.6, ey = Math.sin(a) * R * 0.6;
        ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(ex, ey); ctx.stroke();
        ctx.beginPath();
        ctx.moveTo(ex * 0.6, ey * 0.6);
        ctx.lineTo(ex * 0.6 + Math.cos(a + 0.9) * R * 0.2, ey * 0.6 + Math.sin(a + 0.9) * R * 0.2);
        ctx.moveTo(ex * 0.6, ey * 0.6);
        ctx.lineTo(ex * 0.6 + Math.cos(a - 0.9) * R * 0.2, ey * 0.6 + Math.sin(a - 0.9) * R * 0.2);
        ctx.stroke();
      }
      ctx.restore();
      ctx.restore();
    }

    /* ── MAGNET ────────────────────────────────────────────── */
    _magnet(ctx, c) {
      const R = 0.30;
      ctx.save();
      ctx.rotate(-0.25 + Math.sin(c.phase) * 0.14);

      // Horseshoe.
      ctx.lineCap = 'butt';
      const g = ctx.createLinearGradient(-R, -R, R, R);
      g.addColorStop(0, '#ff9fbd');
      g.addColorStop(0.45, '#f2436f');
      g.addColorStop(1, '#a8123c');
      ctx.strokeStyle = g;
      ctx.lineWidth = R * 0.56;
      ctx.beginPath();
      ctx.arc(0, 0, R * 0.72, Math.PI, TAU);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(-R * 0.72, 0); ctx.lineTo(-R * 0.72, R * 0.6);
      ctx.moveTo(R * 0.72, 0); ctx.lineTo(R * 0.72, R * 0.6);
      ctx.stroke();

      // Pole caps.
      ctx.lineWidth = R * 0.56;
      ctx.strokeStyle = '#e8f4ff';
      ctx.beginPath();
      ctx.moveTo(-R * 0.72, R * 0.6); ctx.lineTo(-R * 0.72, R * 0.98);
      ctx.moveTo(R * 0.72, R * 0.6); ctx.lineTo(R * 0.72, R * 0.98);
      ctx.stroke();

      // Highlight.
      ctx.strokeStyle = 'rgba(255,220,232,0.6)';
      ctx.lineWidth = R * 0.12;
      ctx.beginPath();
      ctx.arc(0, 0, R * 0.88, Math.PI + 0.25, TAU - 0.6);
      ctx.stroke();

      // Field arcs snapping between the poles.
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      for (let i = 0; i < 3; i++) {
        const t = U.wrap(c.phase * 0.5 + i * 0.33, 1);
        const a = Math.sin(t * Math.PI) * 0.6;
        ctx.strokeStyle = 'rgba(255,180,210,' + a.toFixed(3) + ')';
        ctx.lineWidth = 0.016;
        ctx.beginPath();
        ctx.ellipse(0, R * 0.98, R * 0.72, R * (0.2 + t * 0.5), 0, Math.PI, TAU);
        ctx.stroke();
      }
      ctx.restore();
      ctx.restore();
    }

    /* ── HOT COCOA ─────────────────────────────────────────── */
    _cocoa(ctx, c) {
      const R = 0.3;
      ctx.save();
      ctx.rotate(Math.sin(c.phase * 0.7) * 0.08);

      // Mug.
      ctx.beginPath();
      ctx.moveTo(-R * 0.66, -R * 0.5);
      ctx.lineTo(-R * 0.5, R * 0.72);
      ctx.quadraticCurveTo(0, R * 0.98, R * 0.5, R * 0.72);
      ctx.lineTo(R * 0.66, -R * 0.5);
      ctx.closePath();
      const g = ctx.createLinearGradient(-R * 0.66, 0, R * 0.66, 0);
      g.addColorStop(0, '#fff6ee');
      g.addColorStop(0.35, '#ffd9c2');
      g.addColorStop(0.72, '#e8926a');
      g.addColorStop(1, '#b45a34');
      ctx.fillStyle = g;
      ctx.fill();
      ctx.strokeStyle = 'rgba(120,54,28,0.4)';
      ctx.lineWidth = 0.012;
      ctx.stroke();

      // Handle.
      ctx.strokeStyle = '#f0b898';
      ctx.lineWidth = R * 0.17;
      ctx.beginPath();
      ctx.arc(R * 0.74, R * 0.02, R * 0.3, -1.1, 1.1);
      ctx.stroke();
      ctx.strokeStyle = 'rgba(255,244,236,0.5)';
      ctx.lineWidth = R * 0.06;
      ctx.beginPath();
      ctx.arc(R * 0.74, R * 0.02, R * 0.34, -0.9, 0.4);
      ctx.stroke();

      // Cocoa surface + marshmallows.
      ctx.fillStyle = '#4a2313';
      ctx.beginPath(); ctx.ellipse(0, -R * 0.5, R * 0.66, R * 0.19, 0, 0, TAU); ctx.fill();
      const cg = ctx.createRadialGradient(-R * 0.2, -R * 0.54, 0, 0, -R * 0.5, R * 0.66);
      cg.addColorStop(0, 'rgba(150,84,44,0.9)');
      cg.addColorStop(1, 'rgba(58,26,14,0.9)');
      ctx.fillStyle = cg;
      ctx.beginPath(); ctx.ellipse(0, -R * 0.5, R * 0.6, R * 0.16, 0, 0, TAU); ctx.fill();
      for (let i = 0; i < 3; i++) {
        const mx = (i - 1) * R * 0.3 + Math.sin(c.phase + i) * 0.012;
        ctx.fillStyle = '#fff8f2';
        ctx.beginPath(); ctx.ellipse(mx, -R * 0.53, R * 0.13, R * 0.075, 0, 0, TAU); ctx.fill();
        ctx.fillStyle = 'rgba(230,196,178,0.6)';
        ctx.beginPath(); ctx.ellipse(mx, -R * 0.5, R * 0.13, R * 0.05, 0, 0.2, Math.PI - 0.2); ctx.fill();
      }

      // Steam.
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      ctx.strokeStyle = 'rgba(255,240,225,0.4)';
      ctx.lineWidth = 0.03;
      ctx.lineCap = 'round';
      for (let i = 0; i < 3; i++) {
        const ph = c.phase * 1.5 + i * 2;
        ctx.beginPath();
        ctx.moveTo((i - 1) * R * 0.28, -R * 0.6);
        ctx.bezierCurveTo(
          (i - 1) * R * 0.28 + Math.sin(ph) * 0.09, -R * 0.9,
          (i - 1) * R * 0.28 - Math.sin(ph) * 0.09, -R * 1.2,
          (i - 1) * R * 0.28 + Math.sin(ph + 1) * 0.06, -R * 1.5
        );
        ctx.stroke();
      }
      ctx.restore();
      ctx.restore();
    }

    /* ── AURORA CRYSTAL ────────────────────────────────────── */
    _aurora(ctx, c) {
      const R = 0.36;
      const pulse = 0.8 + 0.2 * Math.sin(c.phase * 3);
      ctx.save();

      // Halo rings.
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      for (let i = 0; i < 3; i++) {
        const t = U.wrap(c.phase * 0.3 + i * 0.33, 1);
        ctx.strokeStyle = U.hsl(150 + t * 160, 0.9, 0.66, (1 - t) * 0.5);
        ctx.lineWidth = 0.02;
        ctx.beginPath();
        ctx.arc(0, 0, R * (0.9 + t * 1.5), 0, TAU);
        ctx.stroke();
      }
      ctx.restore();

      ctx.rotate(c.spin * 0.6);
      // Hexagonal prism, each facet a different aurora hue.
      const N = 6;
      for (let i = 0; i < N; i++) {
        const a0 = (i / N) * TAU, a1 = ((i + 1) / N) * TAU;
        ctx.beginPath();
        ctx.moveTo(0, -R * 1.6);
        ctx.lineTo(Math.cos(a0) * R, Math.sin(a0) * R * 0.62);
        ctx.lineTo(Math.cos(a1) * R, Math.sin(a1) * R * 0.62);
        ctx.closePath();
        const hue = 140 + i * 34 + c.phase * 20;
        const g = ctx.createLinearGradient(0, -R * 1.6, 0, R * 0.6);
        g.addColorStop(0, U.hsl(hue, 0.9, 0.9, 0.95));
        g.addColorStop(0.6, U.hsl(hue, 0.85, 0.6, 0.9));
        g.addColorStop(1, U.hsl(hue + 20, 0.8, 0.4, 0.9));
        ctx.fillStyle = g;
        ctx.fill();

        ctx.beginPath();
        ctx.moveTo(0, R * 1.5);
        ctx.lineTo(Math.cos(a0) * R, Math.sin(a0) * R * 0.62);
        ctx.lineTo(Math.cos(a1) * R, Math.sin(a1) * R * 0.62);
        ctx.closePath();
        const g2 = ctx.createLinearGradient(0, R * 1.5, 0, -R * 0.2);
        g2.addColorStop(0, U.hsl(hue + 40, 0.9, 0.72, 0.95));
        g2.addColorStop(1, U.hsl(hue + 10, 0.85, 0.42, 0.9));
        ctx.fillStyle = g2;
        ctx.fill();
      }
      // Core.
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      const cg = ctx.createRadialGradient(0, 0, 0, 0, 0, R * 1.5);
      cg.addColorStop(0, 'rgba(255,255,255,' + (0.9 * pulse).toFixed(3) + ')');
      cg.addColorStop(0.3, 'rgba(140,255,220,' + (0.4 * pulse).toFixed(3) + ')');
      cg.addColorStop(1, 'rgba(120,220,255,0)');
      ctx.fillStyle = cg;
      ctx.beginPath(); ctx.arc(0, 0, R * 1.5, 0, TAU); ctx.fill();
      ctx.restore();

      ctx.strokeStyle = 'rgba(255,255,255,0.7)';
      ctx.lineWidth = 0.013;
      for (let i = 0; i < N; i++) {
        const a = (i / N) * TAU;
        ctx.beginPath();
        ctx.moveTo(0, -R * 1.6);
        ctx.lineTo(Math.cos(a) * R, Math.sin(a) * R * 0.62);
        ctx.lineTo(0, R * 1.5);
        ctx.stroke();
      }
      ctx.restore();
    }

    /** Small caption under a power-up. */
    _badge(ctx, text, col) {
      ctx.save();
      ctx.font = '700 0.2px "Avenir Next", "Segoe UI", sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillStyle = 'rgba(8,20,40,0.5)';
      ctx.fillText(text, 0.01, 0.02);
      ctx.fillStyle = col;
      ctx.fillText(text, 0, 0);
      ctx.restore();
    }
  }

  CollectibleManager.SPEC = SPEC;
  CollectibleManager.TYPES = { FISH, GOLD, CRYSTAL, SHIELD, MAGNET, COCOA, AURORA };
  global.CollectibleManager = CollectibleManager;
})(window);
