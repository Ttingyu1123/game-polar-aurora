/* ═══════════════════════════════════════════════════════════
   ObstacleManager — spawning, patterns and vector art.

   SEVEN HAZARDS, THREE VERBS
     JUMP  → hole · seal · snowball · brokenIce
     DODGE → crystal · iceberg            (too tall to clear)
     SLIDE → arch                         (solid above a low gap)

   Every obstacle answers one question — "which button?" — and its
   silhouette must say so before you can read any detail. Dodge-only
   hazards are tall and spiky; slide-unders are wide and overhead;
   jumpables are low and rounded. That reads at 40 m in fog.

   SOLVABILITY
   `_emit()` is the only way anything enters the world, and it refuses
   to create a row that has no answer: it tracks which lanes a row
   fills and with which verb, so a row can only be full-width if a
   single input clears all of it. There is no "unfair death" path.
   ═══════════════════════════════════════════════════════════ */
(function (global) {
  'use strict';

  const U = global.U;
  const W3 = global.WORLD;
  const TAU = U.TAU;

  const HOLE = 'hole', SEAL = 'seal', SNOWBALL = 'snowball', CRYSTAL = 'crystal',
        BROKEN = 'brokenIce', ICEBERG = 'iceberg', ARCH = 'arch';

  const VIS_FAR = 132;          // metres — beyond this a prop is pure haze

  /** Obstacles closer together than this arrive as ONE decision. */
  const ROW_TOL = 4.5;

  // verb: what clears it. 'jump' | 'dodge' | 'slide'
  const SPEC = {
    hole:      { verb: 'jump',  halfW: 1.02, yMin: -9, yMax: 0.02, halfZ: 1.02, flat: true },
    seal:      { verb: 'jump',  halfW: 0.50, yMin: 0, yMax: 0.66, halfZ: 0.80 },
    snowball:  { verb: 'jump',  halfW: 0.56, yMin: 0, yMax: 1.12, halfZ: 0.56 },
    brokenIce: { verb: 'jump',  halfW: 0.92, yMin: 0, yMax: 0.60, halfZ: 0.55 },
    crystal:   { verb: 'dodge', halfW: 0.52, yMin: 0, yMax: 2.30, halfZ: 0.48 },
    iceberg:   { verb: 'dodge', halfW: 0.92, yMin: 0, yMax: 2.70, halfZ: 0.75 },
    arch:      { verb: 'slide', halfW: 1.05, yMin: 0.60, yMax: 2.80, halfZ: 0.60 }
  };

  class ObstacleManager {
    constructor(camera, particles) {
      this.cam = camera;
      this.ps = particles;
      this.list = [];
      this.nextZ = 0;
      this.difficulty = 0;
      this.t = 0;
      this.quality = 1;
      this._p = { x: 0, y: 0, s: 0, visible: false };
      this._seed = 1;
    }

    reset() {
      this.list.length = 0;
      this.nextZ = 62;            // a calm runway before the first hazard
      this.difficulty = 0;
      this.t = 0;
      this._seed = (Math.random() * 1e9) | 0;
    }

    /* ── spawning ──────────────────────────────────────────── */

    /**
     * What each lane demands of the player within ROW_TOL metres of `z`.
     * Anything closer together than this arrives as one decision — you get
     * no separate chance to react — so it must be judged as a single row.
     */
    _answersAt(z) {
      const row = [null, null, null];
      for (let i = 0; i < this.list.length; i++) {
        const o = this.list[i];
        if (Math.abs(o.z0 - z) < ROW_TOL) row[o.lane] = SPEC[o.type].verb;
      }
      return row;
    }

    /**
     * The ONE way anything enters the world, and it is a real gate.
     *
     * A row is survivable if either (a) some lane is empty, or (b) every
     * occupied lane yields to the same input. Anything else is a death trap
     * and is refused outright.
     *
     * This used to be guaranteed only WITHIN a single _pattern() call, which
     * was worthless: patterns overlapped (15 % of them), so an iceberg would
     * spawn in the safe lane of a corridor and the run became unwinnable
     * through no fault of the player. Extent tracking stops the overlap; this
     * check is the proof, not the intention.
     */
    _emit(type, lane, z) {
      const sp = SPEC[type];
      const row = this._answersAt(z);
      if (row[lane]) return false;                     // lane already taken
      row[lane] = sp.verb;
      if (row[0] && row[1] && row[2] &&
          !(row[0] === row[1] && row[1] === row[2])) {
        return false;                                  // no gap, no shared verb
      }
      this.list.push({
        type, lane, z0: z, z: z - 0,
        x: W3.LANES[lane],
        seed: (this._seed = (this._seed * 1103515245 + 12345) & 0x7fffffff),
        phase: U.rand(0, TAU),
        spin: 0,
        hit: false, scored: false, near: false,
        verb: sp.verb
      });
      return true;
    }

    /** Build one row across `lanes`. */
    _row(z, lanes, typeFor) {
      for (const l of lanes) this._emit(typeFor(l), l, z);
    }

    _pickJumpable() {
      const r = Math.random();
      if (r < 0.30) return HOLE;
      if (r < 0.58) return SEAL;
      if (r < 0.82) return SNOWBALL;
      return BROKEN;
    }
    _pickDodge() { return Math.random() < 0.62 ? CRYSTAL : ICEBERG; }

    update(dt, worldZ, speed, difficulty) {
      this.t += dt;
      this.difficulty = difficulty;

      while (this.nextZ < worldZ + W3.SPAWN_Z) {
        const d = difficulty;
        // Budget the gap in SECONDS, not metres. Distance means nothing to a
        // player — thinking time is the actual resource, and a fixed metre gap
        // silently halves it as the run speeds up. Measured median decision
        // time was 0.49 s, which is barely above raw human reaction latency;
        // this makes it ~1.6 s at the start, easing to ~1.0 s flat out.
        const think = U.lerp(1.55, 0.95, d);
        const gap = speed * think + U.rand(0, speed * 0.3);
        // Multi-row patterns (weaves, corridors) are tens of metres long.
        // Advancing by `gap` alone dropped the next pattern INSIDE the last
        // one — which is how icebergs ended up in a corridor's safe lane.
        const extent = this._pattern(this.nextZ, d) || 0;
        this.nextZ += extent + gap;
      }

      for (let i = this.list.length - 1; i >= 0; i--) {
        const o = this.list[i];
        o.z = o.z0 - worldZ;
        if (o.z < -7) { this.list.splice(i, 1); continue; }
        if (o.type === SNOWBALL) o.spin += dt * (2.6 + speed * 0.06);
        if (o.type === SEAL) o.phase += dt * 1.7;
        if (o.type === CRYSTAL) o.phase += dt * 0.9;

        // Frost haze puffing out of ice holes — cheap, sells cold.
        if (o.type === HOLE && o.z > 2 && o.z < 34 && U.chance(dt * 1.6 * this.quality)) {
          this.ps.emit(4 /* GLOW */, o.x + U.rand(-.7, .7), U.rand(0, .3), o.z, {
            vy: U.rand(0.3, 1.1), life: U.rand(0.7, 1.5), size: U.rand(0.1, 0.28), size2: 0.3,
            r: 170, g: 216, b: 245, a: 0.22, drag: 0.4
          });
        }
      }
    }

    /**
     * Choose and lay down one pattern at depth z.
     * @returns {number} the pattern's own footprint in metres — the caller
     *   MUST skip past it before placing the next one.
     */
    _pattern(z, d) {
      const r = Math.random();

      // The first stretch of a run teaches the verbs. Weaves and corridors
      // are multi-row lane puzzles; meeting one in your first ten seconds is
      // just a death, not a lesson. They unlock as the run earns them.
      const canWeave = d > 0.16;
      const canCorridor = d > 0.3;

      /* ── single hazard: the bread and butter ── */
      if (r < 0.42 - d * 0.16) {
        const lane = U.randInt(0, 2);
        this._emit(Math.random() < 0.62 ? this._pickJumpable() : this._pickDodge(), lane, z);
        return 0;
      }

      /* ── two lanes blocked, one open ── */
      if (r < 0.64 - d * 0.10) {
        const free = U.randInt(0, 2);
        const lanes = [0, 1, 2].filter((l) => l !== free);
        const mixVerbs = Math.random() < 0.5;
        this._row(z, lanes, () => (mixVerbs ? this._pickDodge() : this._pickJumpable()));
        return 0;
      }

      /* ── full-width JUMP wall (all three share one verb) ── */
      if (r < 0.76) {
        const t = Math.random() < 0.5 ? HOLE : BROKEN;
        this._row(z, [0, 1, 2], () => t);
        return 0;
      }

      /* ── full-width SLIDE arch ── */
      if (r < 0.86 || (!canWeave && !canCorridor)) {
        this._row(z, [0, 1, 2], () => ARCH);
        return 0;
      }

      /* ── weave: staggered singles, one per row ── */
      if (r < 0.94 || !canCorridor) {
        const n = 2 + (Math.random() < d ? 1 : 0);
        let lane = U.randInt(0, 2);
        // Each step inside a weave is its own decision, so it gets its own
        // thinking time — it is not a freebie just because it's one pattern.
        const step = U.lerp(24, 15, d);
        for (let i = 0; i < n; i++) {
          this._emit(this._pickDodge(), lane, z + i * step);
          // Always shuffle to an ADJACENT lane — a two-lane hop at speed
          // is not a decision, it's a coin flip.
          lane = U.clamp(lane + (Math.random() < 0.5 ? -1 : 1), 0, 2);
        }
        return (n - 1) * step;
      }

      /* ── corridor: run one lane while walls stream past ── */
      const safe = U.randInt(0, 2);
      const walls = [0, 1, 2].filter((l) => l !== safe);
      const rows = 2 + ((Math.random() * 2) | 0);
      const step = U.lerp(14, 9, d);
      for (let i = 0; i < rows; i++) {
        this._row(z + i * step, walls, () => (Math.random() < 0.7 ? CRYSTAL : ICEBERG));
      }
      // Cap the corridor with a jumpable so it isn't a free ride.
      if (d > 0.4) {
        this._emit(this._pickJumpable(), safe, z + rows * step);
        return rows * step;
      }
      return (rows - 1) * step;
    }

    /* ── boxes ─────────────────────────────────────────────── */
    getBox(o) {
      const s = SPEC[o.type];
      return { x: o.x, halfW: s.halfW, yMin: s.yMin, yMax: s.yMax, z: o.z, halfZ: s.halfZ, flat: !!s.flat, verb: s.verb };
    }

    /* ══════════════════════════════════════════════════════════
       ART
       ══════════════════════════════════════════════════════════ */

    draw(ctx, bg) {
      // Far → near so nearer hazards overlap correctly.
      const list = this.list.slice().sort((a, b) => b.z - a.z);
      for (let i = 0; i < list.length; i++) {
        const o = list[i];
        if (o.z < -3 || o.z > VIS_FAR) continue;
        this._drawOne(ctx, o, bg);
      }
    }

    /**
     * Props dissolve into the haze well before the ground does — by 130 m an
     * iceberg is a four-pixel smudge that costs a full gradient stack to
     * paint. The ground keeps its 235 m vista; the props do not need it, and
     * you still see every hazard ~3 s before it arrives at top speed.
     */
    _fog(z) { return U.clamp((z - 44) / 84, 0, 1); }

    _drawOne(ctx, o, bg) {
      const cam = this.cam, p = this._p;
      cam.project(o.x, 0, o.z, p);
      if (!p.visible) return;
      const s = p.s;
      if (s < 0.4) return;
      const fog = this._fog(o.z);
      if (fog > 0.9) return;

      const L = bg ? bg.sampleAurora(U.clamp(p.x / cam.width, 0, 1)) : [120, 220, 255, 0.5];

      ctx.save();
      ctx.globalAlpha = 1 - fog;

      if (SPEC[o.type].flat) {
        this._hole(ctx, o, p, s, L);
      } else {
        this._contactShadow(ctx, o, p, s);
        ctx.save();
        ctx.translate(p.x, p.y);
        ctx.scale(s, s);          // 1 local unit = 1 metre
        switch (o.type) {
          case SEAL: this._seal(ctx, o, L); break;
          case SNOWBALL: this._snowball(ctx, o, L); break;
          case CRYSTAL: this._crystal(ctx, o, L); break;
          case BROKEN: this._broken(ctx, o, L); break;
          case ICEBERG: this._iceberg(ctx, o, L); break;
          case ARCH: this._arch(ctx, o, L); break;
        }
        ctx.restore();
      }

      // Fog wash: tint distant props toward the haze colour.
      if (fog > 0.02) {
        ctx.globalAlpha = fog * 0.85;
        ctx.globalCompositeOperation = 'source-atop';
      }
      ctx.restore();
    }

    _contactShadow(ctx, o, p, s) {
      const sp = SPEC[o.type];
      const r = sp.halfW * s * 1.15;
      if (r < 0.8) return;
      const g = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, r);
      g.addColorStop(0, 'rgba(10,38,72,0.5)');
      g.addColorStop(0.55, 'rgba(14,48,88,0.24)');
      g.addColorStop(1, 'rgba(20,60,104,0)');
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.ellipse(p.x, p.y, r, r * 0.3, 0, 0, TAU);
      ctx.fill();
    }

    /* ── ICE HOLE — flat, on the ground plane ──────────────── */
    _hole(ctx, o, p, s, L) {
      const cam = this.cam, q = { x: 0, y: 0, s: 0, visible: false };
      const R = SPEC.hole.halfW;
      const N = 20;

      // Project a real circle on the ice: an ellipse in world space stays
      // an ellipse on screen, but sampling it keeps the perspective exact.
      const ring = [];
      for (let i = 0; i < N; i++) {
        const a = (i / N) * TAU;
        const wob = 1 + Math.sin(a * 3 + o.phase) * 0.09 + Math.sin(a * 5.3 - o.phase * 0.7) * 0.05;
        cam.project(o.x + Math.cos(a) * R * wob, 0.005, o.z + Math.sin(a) * R * wob, q);
        if (!q.visible) return;
        ring.push([q.x, q.y]);
      }

      ctx.save();
      // Rim ice: a bright lip around the opening.
      ctx.beginPath(); U.smoothPoly(ctx, ring);
      ctx.save();
      ctx.lineJoin = 'round';
      ctx.strokeStyle = 'rgba(232,250,255,0.9)';
      ctx.lineWidth = Math.max(1, 0.09 * s);
      ctx.stroke();
      ctx.strokeStyle = 'rgba(140,196,235,0.55)';
      ctx.lineWidth = Math.max(0.6, 0.045 * s);
      ctx.stroke();
      ctx.restore();

      // The water: dark, cold, with the aurora smeared across it.
      ctx.beginPath(); U.smoothPoly(ctx, ring);
      ctx.clip();
      const cy = p.y, cx = p.x;
      const rr = R * s;
      const g = ctx.createRadialGradient(cx, cy - rr * 0.1, rr * 0.05, cx, cy, rr * 1.25);
      g.addColorStop(0, '#01060f');
      g.addColorStop(0.45, '#03121f');
      g.addColorStop(0.8, '#062435');
      g.addColorStop(1, '#0b3348');
      ctx.fillStyle = g;
      ctx.fillRect(cx - rr * 1.4, cy - rr * 1.4, rr * 2.8, rr * 2.8);

      // Aurora reflection ripples.
      ctx.globalCompositeOperation = 'lighter';
      for (let i = 0; i < 3; i++) {
        const ry = cy + Math.sin(this.t * 1.4 + i * 2.1 + o.phase) * rr * 0.18 - rr * 0.1 + i * rr * 0.16;
        const a = 0.16 * (1 - i * 0.22);
        ctx.fillStyle = U.rgba(L[0], L[1], L[2], a * (0.4 + L[3]));
        ctx.beginPath();
        ctx.ellipse(cx, ry, rr * (0.75 - i * 0.13), rr * 0.055, 0, 0, TAU);
        ctx.fill();
      }
      ctx.globalCompositeOperation = 'source-over';

      // Floating brash ice.
      const rng = U.makeRNG(o.seed);
      for (let i = 0; i < 4; i++) {
        const a = rng() * TAU, d = Math.sqrt(rng()) * rr * 0.6;
        const fx = cx + Math.cos(a) * d;
        const fy = cy + Math.sin(a) * d * 0.32 + Math.sin(this.t * 1.1 + i) * rr * 0.02;
        const fr = rr * (0.06 + rng() * 0.1);
        ctx.fillStyle = 'rgba(206,236,252,0.9)';
        ctx.beginPath();
        ctx.ellipse(fx, fy, fr, fr * 0.42, rng() * TAU, 0, TAU);
        ctx.fill();
        ctx.fillStyle = 'rgba(255,255,255,0.5)';
        ctx.beginPath();
        ctx.ellipse(fx - fr * 0.2, fy - fr * 0.12, fr * 0.5, fr * 0.18, 0, 0, TAU);
        ctx.fill();
      }
      ctx.restore();

      // Cracks radiating from the rim.
      ctx.save();
      ctx.strokeStyle = 'rgba(122,178,220,0.5)';
      ctx.lineWidth = Math.max(0.5, 0.02 * s);
      for (let i = 0; i < 7; i++) {
        const a = (i / 7) * TAU + o.phase * 0.1;
        const x0 = o.x + Math.cos(a) * R * 1.02, z0 = o.z + Math.sin(a) * R * 1.02;
        const x1 = o.x + Math.cos(a) * R * (1.3 + U.hash1(o.seed + i) * 0.5);
        const z1 = o.z + Math.sin(a) * R * (1.3 + U.hash1(o.seed + i * 3) * 0.5);
        cam.project(x0, 0.004, z0, q); if (!q.visible) continue;
        const ax = q.x, ay = q.y;
        cam.project(x1, 0.004, z1, q); if (!q.visible) continue;
        ctx.beginPath(); ctx.moveTo(ax, ay); ctx.lineTo(q.x, q.y); ctx.stroke();
      }
      ctx.restore();
    }

    /* ── SEAL ──────────────────────────────────────────────── */
    _seal(ctx, o, L) {
      const breathe = 1 + Math.sin(o.phase) * 0.035;
      const headTurn = Math.sin(o.phase * 0.42) * 0.3;
      const HB = 0.60;

      ctx.save();
      ctx.scale(1, breathe);

      // Body — a fat comma lying on the ice.
      ctx.beginPath();
      ctx.moveTo(-0.52, 0);
      ctx.bezierCurveTo(-0.56, -0.34, -0.34, -0.56, -0.02, -0.56);
      ctx.bezierCurveTo(0.28, -0.56, 0.46, -0.4, 0.52, -0.2);
      ctx.bezierCurveTo(0.58, -0.06, 0.6, -0.02, 0.62, 0);
      ctx.closePath();
      const g = ctx.createLinearGradient(-0.2, -HB, 0.2, 0);
      g.addColorStop(0, '#8fa6bd');
      g.addColorStop(0.4, '#6b8199');
      g.addColorStop(0.78, '#4c6076');
      g.addColorStop(1, '#33455a');
      ctx.fillStyle = g;
      ctx.fill();

      ctx.save();
      ctx.clip();
      // Dapple spots.
      const rng = U.makeRNG(o.seed);
      for (let i = 0; i < 14; i++) {
        const sx = -0.5 + rng() * 1.05, sy = -rng() * 0.55;
        const r = 0.02 + rng() * 0.045;
        ctx.fillStyle = 'rgba(48,64,82,0.34)';
        ctx.beginPath(); ctx.ellipse(sx, sy, r, r * 0.7, rng() * TAU, 0, TAU); ctx.fill();
      }
      // Pale underside.
      const ug = ctx.createLinearGradient(0, -0.2, 0, 0);
      ug.addColorStop(0, 'rgba(216,232,246,0)');
      ug.addColorStop(1, 'rgba(216,232,246,0.5)');
      ctx.fillStyle = ug;
      ctx.fillRect(-0.7, -0.24, 1.4, 0.26);
      // Back sheen + aurora rim.
      ctx.globalCompositeOperation = 'lighter';
      const sg = ctx.createLinearGradient(-0.3, -HB, 0.1, -0.2);
      sg.addColorStop(0, U.rgba(L[0], L[1], L[2], 0.4));
      sg.addColorStop(0.5, 'rgba(220,240,255,0.16)');
      sg.addColorStop(1, 'rgba(220,240,255,0)');
      ctx.fillStyle = sg;
      ctx.fillRect(-0.7, -0.7, 1.4, 0.8);
      ctx.restore();

      // Rear flippers.
      ctx.fillStyle = '#3d5066';
      ctx.beginPath();
      ctx.moveTo(-0.46, -0.1);
      ctx.quadraticCurveTo(-0.78, -0.26, -0.86, -0.02);
      ctx.quadraticCurveTo(-0.7, 0.02, -0.44, 0.0);
      ctx.closePath(); ctx.fill();
      ctx.strokeStyle = 'rgba(20,32,46,0.5)'; ctx.lineWidth = 0.012; ctx.stroke();

      // Head.
      ctx.save();
      ctx.translate(0.42, -0.4);
      ctx.rotate(headTurn * 0.4);
      const hg = ctx.createRadialGradient(-0.03, -0.06, 0.01, 0, 0, 0.2);
      hg.addColorStop(0, '#9db2c8');
      hg.addColorStop(0.6, '#6d8299');
      hg.addColorStop(1, '#3f5266');
      ctx.fillStyle = hg;
      ctx.beginPath();
      ctx.ellipse(0, 0, 0.19, 0.16, -0.15, 0, TAU);
      ctx.fill();
      // snout
      ctx.fillStyle = '#8399ae';
      ctx.beginPath(); ctx.ellipse(0.13, 0.05, 0.09, 0.068, 0.1, 0, TAU); ctx.fill();
      // nose
      ctx.fillStyle = '#1d2a38';
      ctx.beginPath(); ctx.ellipse(0.2, 0.03, 0.026, 0.02, 0, 0, TAU); ctx.fill();
      // eye (blinks with the breathing cycle)
      const blink = Math.sin(o.phase * 0.9) > 0.965 ? 0.12 : 1;
      ctx.fillStyle = '#0a1420';
      ctx.beginPath(); ctx.ellipse(0.03, -0.04, 0.032, 0.036 * blink, 0, 0, TAU); ctx.fill();
      if (blink > 0.5) {
        ctx.fillStyle = 'rgba(255,255,255,0.9)';
        ctx.beginPath(); ctx.ellipse(0.022, -0.052, 0.012, 0.012, 0, 0, TAU); ctx.fill();
        ctx.fillStyle = U.rgba(L[0], L[1], L[2], 0.6);
        ctx.beginPath(); ctx.ellipse(0.042, -0.026, 0.007, 0.007, 0, 0, TAU); ctx.fill();
      }
      // whiskers
      ctx.strokeStyle = 'rgba(226,240,252,0.62)';
      ctx.lineWidth = 0.007;
      for (let i = -1; i <= 1; i++) {
        ctx.beginPath();
        ctx.moveTo(0.17, 0.04 + i * 0.016);
        ctx.quadraticCurveTo(0.3, 0.03 + i * 0.05, 0.4, 0.02 + i * 0.085);
        ctx.stroke();
      }
      ctx.restore();

      // Fore flipper (on top of the body).
      ctx.save();
      ctx.translate(0.12, -0.16);
      ctx.rotate(Math.sin(o.phase * 1.3) * 0.14);
      ctx.fillStyle = '#54687e';
      ctx.beginPath();
      ctx.moveTo(0, -0.05);
      ctx.quadraticCurveTo(0.16, 0.06, 0.1, 0.19);
      ctx.quadraticCurveTo(0.0, 0.15, -0.05, 0.02);
      ctx.closePath(); ctx.fill();
      ctx.strokeStyle = 'rgba(20,32,46,0.45)'; ctx.lineWidth = 0.01; ctx.stroke();
      ctx.restore();

      ctx.restore();
    }

    /* ── SNOWBALL ──────────────────────────────────────────── */
    _snowball(ctx, o, L) {
      const R = 0.56;
      const cy = -R;
      ctx.save();
      ctx.translate(0, cy);

      // Sphere.
      const g = ctx.createRadialGradient(-R * 0.36, -R * 0.42, R * 0.05, 0, 0, R * 1.12);
      g.addColorStop(0, '#ffffff');
      g.addColorStop(0.34, '#eef8ff');
      g.addColorStop(0.66, '#c3ddf2');
      g.addColorStop(0.88, '#8fb2d2');
      g.addColorStop(1, '#5f83a8');
      ctx.fillStyle = g;
      ctx.beginPath(); ctx.arc(0, 0, R, 0, TAU); ctx.fill();

      ctx.save();
      ctx.beginPath(); ctx.arc(0, 0, R, 0, TAU); ctx.clip();

      // Packed-snow texture, rotating with the roll.
      ctx.save();
      ctx.rotate(o.spin);
      const rng = U.makeRNG(o.seed);
      for (let i = 0; i < 16; i++) {
        const a = rng() * TAU, d = Math.sqrt(rng()) * R * 0.86;
        const px = Math.cos(a) * d, py = Math.sin(a) * d;
        const pr = R * (0.06 + rng() * 0.15);
        const dark = rng() < 0.5;
        const pg = ctx.createRadialGradient(px, py, 0, px, py, pr);
        pg.addColorStop(0, dark ? 'rgba(146,178,206,0.34)' : 'rgba(255,255,255,0.5)');
        pg.addColorStop(1, 'rgba(200,226,246,0)');
        ctx.fillStyle = pg;
        ctx.beginPath(); ctx.arc(px, py, pr, 0, TAU); ctx.fill();
      }
      // Compression seams — the giveaway that it's rolling.
      ctx.strokeStyle = 'rgba(140,176,208,0.3)';
      ctx.lineWidth = 0.014;
      for (let i = 0; i < 3; i++) {
        ctx.beginPath();
        ctx.ellipse(0, 0, R * 0.9, R * (0.2 + i * 0.28), i * 0.7, 0, TAU);
        ctx.stroke();
      }
      ctx.restore();

      // Occlusion at the bottom + bounce light off the ice.
      const ao = ctx.createLinearGradient(0, R * 0.1, 0, R);
      ao.addColorStop(0, 'rgba(24,60,100,0)');
      ao.addColorStop(1, 'rgba(24,60,100,0.42)');
      ctx.fillStyle = ao;
      ctx.fillRect(-R, -R, R * 2, R * 2);
      const bl = ctx.createLinearGradient(0, R * 0.55, 0, R);
      bl.addColorStop(0, 'rgba(150,206,244,0)');
      bl.addColorStop(1, 'rgba(150,206,244,0.34)');
      ctx.fillStyle = bl;
      ctx.fillRect(-R, -R, R * 2, R * 2);

      // Aurora rim + specular.
      ctx.globalCompositeOperation = 'lighter';
      const rg = ctx.createRadialGradient(-R * 0.3, -R * 0.4, 0, -R * 0.3, -R * 0.4, R * 0.9);
      rg.addColorStop(0, U.rgba(L[0], L[1], L[2], 0.34));
      rg.addColorStop(1, U.rgba(L[0], L[1], L[2], 0));
      ctx.fillStyle = rg;
      ctx.fillRect(-R, -R, R * 2, R * 2);
      ctx.restore();

      ctx.strokeStyle = 'rgba(70,110,150,0.28)';
      ctx.lineWidth = 0.012;
      ctx.beginPath(); ctx.arc(0, 0, R, 0, TAU); ctx.stroke();
      ctx.restore();

      // Snow spray trailing the roll.
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      for (let i = 0; i < 3; i++) {
        const t = (this.t * 2 + i * 0.33) % 1;
        const sx = Math.sin(o.phase + i * 2) * 0.3;
        const sg = ctx.createRadialGradient(sx, -0.06, 0, sx, -0.06, 0.3 * (0.4 + t));
        sg.addColorStop(0, 'rgba(230,246,255,' + (0.22 * (1 - t)).toFixed(3) + ')');
        sg.addColorStop(1, 'rgba(210,238,255,0)');
        ctx.fillStyle = sg;
        ctx.beginPath(); ctx.arc(sx, -0.06, 0.3 * (0.4 + t), 0, TAU); ctx.fill();
      }
      ctx.restore();
    }

    /* ── ICE CRYSTAL cluster (dodge) ───────────────────────── */
    _crystal(ctx, o, L) {
      const rng = U.makeRNG(o.seed);
      const n = 3 + ((rng() * 3) | 0);
      const shards = [];
      for (let i = 0; i < n; i++) {
        shards.push({
          x: (rng() - 0.5) * 0.72,
          h: 0.8 + rng() * 1.45,
          w: 0.09 + rng() * 0.14,
          lean: (rng() - 0.5) * 0.42,
          hue: 186 + rng() * 26
        });
      }
      shards.sort((a, b) => b.h - a.h);

      // Ground glow — the cluster lights the ice it stands on.
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      const gg = ctx.createRadialGradient(0, 0, 0, 0, 0, 0.9);
      gg.addColorStop(0, 'rgba(96,222,255,0.34)');
      gg.addColorStop(1, 'rgba(96,222,255,0)');
      ctx.fillStyle = gg;
      ctx.beginPath(); ctx.ellipse(0, 0, 0.9, 0.28, 0, 0, TAU); ctx.fill();
      ctx.restore();

      for (const sh of shards) {
        const pulse = 0.82 + 0.18 * Math.sin(this.t * 2.1 + sh.x * 9 + o.phase);
        const tipX = sh.x + sh.lean * sh.h * 0.4;
        const tipY = -sh.h;

        ctx.save();
        // Body of the shard — a tall pyramid with two visible facets.
        ctx.beginPath();
        ctx.moveTo(tipX, tipY);
        ctx.lineTo(sh.x + sh.w, -sh.h * 0.06);
        ctx.lineTo(sh.x + sh.w * 0.35, 0.01);
        ctx.lineTo(sh.x - sh.w * 0.35, 0.01);
        ctx.lineTo(sh.x - sh.w, -sh.h * 0.06);
        ctx.closePath();
        const g = ctx.createLinearGradient(sh.x - sh.w, tipY, sh.x + sh.w, 0);
        g.addColorStop(0, U.hsl(sh.hue, 0.85, 0.86, 0.92));
        g.addColorStop(0.4, U.hsl(sh.hue, 0.75, 0.62, 0.86));
        g.addColorStop(0.75, U.hsl(sh.hue + 8, 0.7, 0.42, 0.9));
        g.addColorStop(1, U.hsl(sh.hue + 14, 0.65, 0.3, 0.94));
        ctx.fillStyle = g;
        ctx.fill();

        // Lit facet — the plane catching the aurora.
        ctx.beginPath();
        ctx.moveTo(tipX, tipY);
        ctx.lineTo(sh.x + sh.w * 0.12, -sh.h * 0.04);
        ctx.lineTo(sh.x - sh.w, -sh.h * 0.06);
        ctx.closePath();
        ctx.fillStyle = U.rgba(228, 252, 255, 0.36 * pulse);
        ctx.fill();

        // Inner refraction core.
        ctx.save();
        ctx.globalCompositeOperation = 'lighter';
        const cg = ctx.createLinearGradient(sh.x, tipY, sh.x, 0);
        cg.addColorStop(0, U.rgba(200, 255, 255, 0.7 * pulse));
        cg.addColorStop(0.5, U.rgba(90, 220, 255, 0.26 * pulse));
        cg.addColorStop(1, U.rgba(60, 180, 240, 0.06));
        ctx.fillStyle = cg;
        ctx.beginPath();
        ctx.moveTo(tipX, tipY + sh.h * 0.05);
        ctx.lineTo(sh.x + sh.w * 0.3, -sh.h * 0.1);
        ctx.lineTo(sh.x - sh.w * 0.3, -sh.h * 0.1);
        ctx.closePath();
        ctx.fill();
        ctx.restore();

        // Edge highlight.
        ctx.strokeStyle = U.rgba(232, 254, 255, 0.7 * pulse);
        ctx.lineWidth = 0.014;
        ctx.beginPath();
        ctx.moveTo(tipX, tipY); ctx.lineTo(sh.x - sh.w, -sh.h * 0.06);
        ctx.stroke();
        ctx.strokeStyle = 'rgba(40,110,160,0.4)';
        ctx.lineWidth = 0.01;
        ctx.beginPath();
        ctx.moveTo(tipX, tipY); ctx.lineTo(sh.x + sh.w, -sh.h * 0.06);
        ctx.stroke();

        // Tip flare.
        ctx.save();
        ctx.globalCompositeOperation = 'lighter';
        const tg = ctx.createRadialGradient(tipX, tipY, 0, tipX, tipY, 0.24 * pulse);
        tg.addColorStop(0, 'rgba(226,255,255,' + (0.7 * pulse).toFixed(3) + ')');
        tg.addColorStop(0.4, 'rgba(96,226,255,' + (0.26 * pulse).toFixed(3) + ')');
        tg.addColorStop(1, 'rgba(60,190,255,0)');
        ctx.fillStyle = tg;
        ctx.beginPath(); ctx.arc(tipX, tipY, 0.24 * pulse, 0, TAU); ctx.fill();
        ctx.restore();
        ctx.restore();
      }

      // Frost skirt where the shards pierce the ice.
      ctx.save();
      const fg = ctx.createRadialGradient(0, 0, 0, 0, 0, 0.55);
      fg.addColorStop(0, 'rgba(236,252,255,0.75)');
      fg.addColorStop(0.6, 'rgba(200,238,255,0.3)');
      fg.addColorStop(1, 'rgba(180,228,255,0)');
      ctx.fillStyle = fg;
      ctx.beginPath(); ctx.ellipse(0, 0, 0.55, 0.16, 0, 0, TAU); ctx.fill();
      ctx.restore();
    }

    /* ── BROKEN ICE (jump) ─────────────────────────────────── */
    _broken(ctx, o, L) {
      const rng = U.makeRNG(o.seed);
      const plates = [];
      for (let i = 0; i < 7; i++) {
        plates.push({
          x: -0.8 + rng() * 1.6,
          h: 0.2 + rng() * 0.4,
          w: 0.14 + rng() * 0.2,
          tilt: (rng() - 0.5) * 0.9
        });
      }
      plates.sort((a, b) => a.h - b.h);

      for (const p of plates) {
        ctx.save();
        ctx.translate(p.x, 0);
        ctx.rotate(p.tilt);
        // Tilted slab shoved up out of the ice.
        ctx.beginPath();
        ctx.moveTo(-p.w, 0.02);
        ctx.lineTo(-p.w * 0.7, -p.h);
        ctx.lineTo(p.w * 0.5, -p.h * 0.86);
        ctx.lineTo(p.w, 0.02);
        ctx.closePath();
        const g = ctx.createLinearGradient(-p.w, -p.h, p.w, 0);
        g.addColorStop(0, 'rgba(236,252,255,0.96)');
        g.addColorStop(0.42, 'rgba(176,220,246,0.94)');
        g.addColorStop(1, 'rgba(94,150,196,0.95)');
        ctx.fillStyle = g;
        ctx.fill();
        // Top edge catching light.
        ctx.strokeStyle = U.rgba(230, 250, 255, 0.85);
        ctx.lineWidth = 0.016;
        ctx.beginPath();
        ctx.moveTo(-p.w * 0.7, -p.h); ctx.lineTo(p.w * 0.5, -p.h * 0.86);
        ctx.stroke();
        // Shadowed inner face.
        ctx.fillStyle = 'rgba(38,86,132,0.34)';
        ctx.beginPath();
        ctx.moveTo(p.w * 0.5, -p.h * 0.86);
        ctx.lineTo(p.w, 0.02);
        ctx.lineTo(p.w * 0.3, 0.02);
        ctx.closePath(); ctx.fill();
        ctx.strokeStyle = 'rgba(30,80,124,0.32)';
        ctx.lineWidth = 0.008;
        ctx.beginPath();
        ctx.moveTo(-p.w, 0.02); ctx.lineTo(-p.w * 0.7, -p.h);
        ctx.stroke();
        ctx.restore();
      }

      // Rubble + a cold glow in the fissures.
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      const gg = ctx.createLinearGradient(0, -0.1, 0, 0.04);
      gg.addColorStop(0, U.rgba(L[0], L[1], L[2], 0));
      gg.addColorStop(1, U.rgba(L[0], L[1], L[2], 0.22));
      ctx.fillStyle = gg;
      ctx.fillRect(-0.95, -0.12, 1.9, 0.16);
      ctx.restore();
    }

    /* ── ICEBERG (dodge) ───────────────────────────────────── */
    _iceberg(ctx, o, L) {
      const rng = U.makeRNG(o.seed);
      const H = 1.9 + rng() * 0.75;
      const W = 0.86;
      const skew = (rng() - 0.5) * 0.45;

      // Silhouette.
      ctx.beginPath();
      ctx.moveTo(-W, 0.02);
      ctx.lineTo(-W * 0.82, -H * 0.42);
      ctx.lineTo(-W * 0.42 + skew * 0.4, -H * 0.78);
      ctx.lineTo(skew, -H);
      ctx.lineTo(W * 0.5 + skew * 0.5, -H * 0.7);
      ctx.lineTo(W * 0.88, -H * 0.34);
      ctx.lineTo(W, 0.02);
      ctx.closePath();
      const g = ctx.createLinearGradient(-W, -H, W, 0.02);
      g.addColorStop(0, '#dcf2ff');
      g.addColorStop(0.32, '#9fcbe9');
      g.addColorStop(0.66, '#5d90bb');
      g.addColorStop(1, '#33628c');
      ctx.fillStyle = g;
      ctx.fill();

      ctx.save();
      ctx.clip();

      // Facets — flat planes at different angles, which is what makes ice
      // read as ice rather than as a blue blob.
      const facet = (pts, col, a) => {
        ctx.beginPath();
        ctx.moveTo(pts[0][0], pts[0][1]);
        for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0], pts[i][1]);
        ctx.closePath();
        ctx.fillStyle = U.rgba(col[0], col[1], col[2], a);
        ctx.fill();
      };
      facet([[skew, -H], [-W * 0.42 + skew * 0.4, -H * 0.78], [-W * 0.3, -H * 0.2], [skew * 0.4, -H * 0.35]], [236, 250, 255], 0.5);
      facet([[skew, -H], [W * 0.5 + skew * 0.5, -H * 0.7], [W * 0.4, -H * 0.1], [skew * 0.4, -H * 0.35]], [40, 90, 132], 0.34);
      facet([[-W, 0.02], [-W * 0.82, -H * 0.42], [-W * 0.3, -H * 0.2], [-W * 0.42, 0.02]], [190, 226, 248], 0.34);

      // Internal cracks.
      ctx.strokeStyle = 'rgba(226,248,255,0.34)';
      ctx.lineWidth = 0.014;
      for (let i = 0; i < 5; i++) {
        const y0 = -H * (0.15 + rng() * 0.7);
        ctx.beginPath();
        ctx.moveTo(-W, y0);
        ctx.lineTo(-W * 0.2 + rng() * 0.4, y0 + (rng() - 0.5) * 0.3);
        ctx.lineTo(W * 0.9, y0 + (rng() - 0.5) * 0.5);
        ctx.stroke();
      }

      // Waterline / meltline glow at the base.
      const wl = ctx.createLinearGradient(0, -0.28, 0, 0.02);
      wl.addColorStop(0, 'rgba(70,190,240,0)');
      wl.addColorStop(1, 'rgba(70,190,240,0.44)');
      ctx.fillStyle = wl;
      ctx.fillRect(-W, -0.3, W * 2, 0.34);

      // Aurora transmission — light bleeding through the ice.
      ctx.globalCompositeOperation = 'lighter';
      const tg = ctx.createLinearGradient(-W, -H, W * 0.4, 0);
      tg.addColorStop(0, U.rgba(L[0], L[1], L[2], 0.44));
      tg.addColorStop(0.5, U.rgba(L[0], L[1], L[2], 0.1));
      tg.addColorStop(1, U.rgba(L[0], L[1], L[2], 0));
      ctx.fillStyle = tg;
      ctx.fillRect(-W, -H, W * 2, H + 0.04);
      ctx.restore();

      // Snow cap.
      ctx.beginPath();
      ctx.moveTo(-W * 0.42 + skew * 0.4, -H * 0.78);
      ctx.lineTo(skew, -H);
      ctx.lineTo(W * 0.5 + skew * 0.5, -H * 0.7);
      ctx.quadraticCurveTo(W * 0.1, -H * 0.62, -W * 0.2, -H * 0.7);
      ctx.closePath();
      const sg = ctx.createLinearGradient(0, -H, 0, -H * 0.6);
      sg.addColorStop(0, 'rgba(255,255,255,0.98)');
      sg.addColorStop(1, 'rgba(214,240,255,0.7)');
      ctx.fillStyle = sg;
      ctx.fill();

      // Silhouette edge + crest rim.
      ctx.strokeStyle = 'rgba(28,70,110,0.34)';
      ctx.lineWidth = 0.014;
      ctx.beginPath();
      ctx.moveTo(-W, 0.02);
      ctx.lineTo(-W * 0.82, -H * 0.42);
      ctx.lineTo(-W * 0.42 + skew * 0.4, -H * 0.78);
      ctx.lineTo(skew, -H);
      ctx.lineTo(W * 0.5 + skew * 0.5, -H * 0.7);
      ctx.lineTo(W * 0.88, -H * 0.34);
      ctx.lineTo(W, 0.02);
      ctx.stroke();

      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      ctx.strokeStyle = U.rgba(L[0], L[1], L[2], 0.6);
      ctx.lineWidth = 0.02;
      ctx.beginPath();
      ctx.moveTo(-W * 0.82, -H * 0.42);
      ctx.lineTo(-W * 0.42 + skew * 0.4, -H * 0.78);
      ctx.lineTo(skew, -H);
      ctx.stroke();
      ctx.restore();
    }

    /* ── ICE ARCH (slide under) ────────────────────────────── */
    _arch(ctx, o, L) {
      const GAP = SPEC.arch.yMin;      // clearance under the span
      const TOP = 2.5;
      const W = 1.02;
      const legW = 0.2;

      // The tunnel mouth — dark, so the gap reads as passable at a glance.
      ctx.save();
      const tg = ctx.createLinearGradient(0, -GAP, 0, 0);
      tg.addColorStop(0, 'rgba(6,24,44,0.86)');
      tg.addColorStop(1, 'rgba(12,44,74,0.5)');
      ctx.fillStyle = tg;
      ctx.fillRect(-W + legW, -GAP, (W - legW) * 2, GAP);
      ctx.restore();

      // Legs, carrying the overhead mass.
      ctx.beginPath();
      ctx.moveTo(-W - 0.16, 0.02);
      ctx.lineTo(-W - 0.1, -GAP);
      ctx.quadraticCurveTo(-W * 0.55, -GAP - 0.34, -W * 0.1, -GAP - 0.3);
      ctx.lineTo(W * 0.1, -GAP - 0.3);
      ctx.quadraticCurveTo(W * 0.55, -GAP - 0.34, W + 0.1, -GAP);
      ctx.lineTo(W + 0.16, 0.02);
      ctx.lineTo(W - legW * 0.5, 0.02);
      ctx.lineTo(W - legW * 0.72, -GAP + 0.02);
      ctx.lineTo(-W + legW * 0.72, -GAP + 0.02);
      ctx.lineTo(-W + legW * 0.5, 0.02);
      ctx.closePath();
      const lg = ctx.createLinearGradient(-W, -TOP, W, 0);
      lg.addColorStop(0, '#cfeaff');
      lg.addColorStop(0.45, '#8ab6da');
      lg.addColorStop(1, '#3d6b95');
      ctx.fillStyle = lg;
      ctx.fill();
      ctx.strokeStyle = 'rgba(24,64,102,0.4)';
      ctx.lineWidth = 0.014;
      ctx.stroke();

      // The slab overhead.
      ctx.beginPath();
      ctx.moveTo(-W - 0.24, -GAP - 0.02);
      ctx.lineTo(-W * 0.72, -TOP * 0.86);
      ctx.lineTo(-W * 0.1, -TOP);
      ctx.lineTo(W * 0.62, -TOP * 0.82);
      ctx.lineTo(W + 0.24, -GAP - 0.02);
      ctx.closePath();
      const bg2 = ctx.createLinearGradient(-W, -TOP, W * 0.5, -GAP);
      bg2.addColorStop(0, '#e6f6ff');
      bg2.addColorStop(0.4, '#a8d0ec');
      bg2.addColorStop(0.78, '#5d8fba');
      bg2.addColorStop(1, '#2f5c86');
      ctx.fillStyle = bg2;
      ctx.fill();

      ctx.save();
      ctx.clip();
      // Facet split.
      ctx.beginPath();
      ctx.moveTo(-W * 0.1, -TOP);
      ctx.lineTo(-W - 0.24, -GAP - 0.02);
      ctx.lineTo(W * 0.1, -GAP - 0.02);
      ctx.closePath();
      ctx.fillStyle = 'rgba(240,252,255,0.4)';
      ctx.fill();
      ctx.globalCompositeOperation = 'lighter';
      const ag = ctx.createLinearGradient(-W, -TOP, W * 0.3, -GAP);
      ag.addColorStop(0, U.rgba(L[0], L[1], L[2], 0.5));
      ag.addColorStop(1, U.rgba(L[0], L[1], L[2], 0));
      ctx.fillStyle = ag;
      ctx.fillRect(-W - 0.3, -TOP, W * 2 + 0.6, TOP);
      ctx.restore();

      ctx.strokeStyle = 'rgba(24,64,102,0.34)';
      ctx.lineWidth = 0.014;
      ctx.beginPath();
      ctx.moveTo(-W - 0.24, -GAP - 0.02);
      ctx.lineTo(-W * 0.72, -TOP * 0.86);
      ctx.lineTo(-W * 0.1, -TOP);
      ctx.lineTo(W * 0.62, -TOP * 0.82);
      ctx.lineTo(W + 0.24, -GAP - 0.02);
      ctx.stroke();

      // Snow on top.
      ctx.beginPath();
      ctx.moveTo(-W * 0.72, -TOP * 0.86);
      ctx.lineTo(-W * 0.1, -TOP);
      ctx.lineTo(W * 0.62, -TOP * 0.82);
      ctx.quadraticCurveTo(W * 0.1, -TOP * 0.7, -W * 0.5, -TOP * 0.78);
      ctx.closePath();
      ctx.fillStyle = 'rgba(255,255,255,0.94)';
      ctx.fill();

      // Icicles hanging into the gap — the read for "duck".
      const rng = U.makeRNG(o.seed);
      ctx.fillStyle = 'rgba(214,242,255,0.9)';
      for (let i = 0; i < 9; i++) {
        const ix = -W + legW * 1.2 + rng() * (W * 2 - legW * 2.4);
        const ih = 0.06 + rng() * 0.17;
        ctx.beginPath();
        ctx.moveTo(ix - 0.028, -GAP - 0.01);
        ctx.lineTo(ix + 0.028, -GAP - 0.01);
        ctx.lineTo(ix, -GAP + ih);
        ctx.closePath();
        ctx.fill();
      }
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      ctx.fillStyle = U.rgba(L[0], L[1], L[2], 0.3);
      for (let i = 0; i < 9; i++) {
        const ix = -W + legW * 1.2 + U.hash1(o.seed + i * 7) * (W * 2 - legW * 2.4);
        ctx.fillRect(ix - 0.008, -GAP - 0.01, 0.016, 0.1);
      }
      ctx.restore();

      // Glow marking the safe channel.
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      const gg = ctx.createLinearGradient(0, -GAP, 0, 0);
      gg.addColorStop(0, 'rgba(96,226,255,0.16)');
      gg.addColorStop(1, 'rgba(96,226,255,0.02)');
      ctx.fillStyle = gg;
      ctx.fillRect(-W + legW, -GAP, (W - legW) * 2, GAP);
      ctx.restore();
    }
  }

  ObstacleManager.SPEC = SPEC;
  ObstacleManager.TYPES = { HOLE, SEAL, SNOWBALL, CRYSTAL, BROKEN, ICEBERG, ARCH };
  global.ObstacleManager = ObstacleManager;
})(window);
