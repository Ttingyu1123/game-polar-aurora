/* ═══════════════════════════════════════════════════════════
   Renderer — canvas ownership, draw order, post, quality governor.

   DEPTH ORDER
   Everything solid goes into one list keyed by z and painted far→near,
   with the penguin inserted at z = 0. That is the whole depth solution:
   a prop at z = −2 has already passed him and correctly draws in front.

   Particles paint after the solids (they are overwhelmingly additive
   light, which belongs on top) and the ambient snowfall paints last,
   because it hangs between the lens and the world.

   QUALITY GOVERNOR
   `quality` (1 → 0.35) is a single dial every subsystem reads to thin
   its own detail. It follows a MEDIAN of recent frame times, not a
   mean — one 200 ms hitch from a GC pause or an alt-tab shouldn't
   permanently downgrade the art. It also only steps back up after a
   sustained good stretch, so it can't oscillate.
   ═══════════════════════════════════════════════════════════ */
(function (global) {
  'use strict';

  const U = global.U;
  const TAU = U.TAU;

  class Renderer {
    constructor(canvas) {
      this.canvas = canvas;
      this.ctx = canvas.getContext('2d', { alpha: false, desynchronized: true });
      this.width = 0; this.height = 0;
      this.dpr = 1;
      this.dprCap = 2;

      this.quality = 1;
      this._times = [];
      this._warm = 0;
      this._holdUp = 0;
      this._vigKey = '';
      this._vigGrd = null;

      this.flash = { a: 0, r: 255, g: 255, b: 255 };
      this._drawables = [];
    }

    resize(cam) {
      const w = Math.max(1, window.innerWidth);
      const h = Math.max(1, window.innerHeight);
      // Cap DPR: a 3x retina phone would otherwise shade 9x the pixels
      // for a runner that is already fill-bound on the ground pass.
      const dpr = Math.min(window.devicePixelRatio || 1, this.dprCap);
      this.width = w; this.height = h; this.dpr = dpr;
      this.canvas.width = Math.round(w * dpr);
      this.canvas.height = Math.round(h * dpr);
      this.canvas.style.width = w + 'px';
      this.canvas.style.height = h + 'px';
      this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      cam.resize(w, h, dpr);
    }

    /* ── quality governor ──────────────────────────────────── */

    /**
     * @param {number} ms  WALL time between frames, not time spent in JS.
     *   Canvas2D raster happens off-thread, so our own JS timers see ~2 ms
     *   on a frame that actually took 30 — measuring them made the governor
     *   permanently blind. The rAF delta is the only honest signal, and it
     *   has the right semantics too: we want to react to DROPPED FRAMES,
     *   not to how much work we chose to do inside a comfortable budget.
     */
    sample(ms) {
      // Ignore start-up jank: shader/JIT warm-up is not a quality signal.
      if (this._warm < 40) { this._warm++; return null; }

      const t = this._times;
      t.push(ms);
      if (t.length < 40) return null;

      // Median beats mean: it ignores the single catastrophic frame from a
      // GC pause or an alt-tab, which a mean would treat as a trend.
      const sorted = t.slice().sort((a, b) => a - b);
      const med = sorted[sorted.length >> 1];
      t.length = 0;

      // Thresholds bracket a vsynced 60 Hz frame (16.7 ms) on BOTH sides, so
      // a healthy 60 Hz display sits in the "climb back up" zone rather than
      // being stuck at whatever quality it first dipped to.
      if (med > 21 && this.quality > 0.36) {
        this.quality = Math.max(0.36, this.quality - 0.16);
        this._holdUp = 8;                  // don't bounce straight back
        if (this.quality < 0.7 && this.dprCap > 1.35) { this.dprCap = 1.35; return 'resize'; }
      } else if (med < 18.5 && this.quality < 1) {
        // Climb slowly and only after a sustained good stretch. Falling fast
        // and rising slow is what keeps this from oscillating around the
        // threshold, which reads to the player as the scene "breathing".
        if (this._holdUp > 0) { this._holdUp--; return null; }
        this.quality = Math.min(1, this.quality + 0.05);
        this._holdUp = 3;
      }
      return null;
    }

    setFlash(r, g, b, a) {
      if (a > this.flash.a) { this.flash.r = r; this.flash.g = g; this.flash.b = b; this.flash.a = a; }
    }

    update(dt) {
      if (this.flash.a > 0) this.flash.a = Math.max(0, this.flash.a - dt * 3.4);
    }

    /* ── frame ─────────────────────────────────────────────── */
    draw(scene) {
      const ctx = this.ctx;
      const { cam, bg, ground, obstacles, collectibles, player, particles, worldZ, powers, state } = scene;

      ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);

      // Camera shake + roll live here so nothing else has to know.
      ctx.save();
      if (cam.shakeX || cam.shakeY || cam.roll || cam.shakeR) {
        ctx.translate(this.width * 0.5, this.height * 0.5);
        ctx.rotate(cam.roll + cam.shakeR);
        // Overscan slightly so rotation never reveals the canvas edge.
        const os = 1 + Math.abs(cam.roll + cam.shakeR) * 0.9;
        ctx.scale(os, os);
        ctx.translate(-this.width * 0.5 + cam.shakeX, -this.height * 0.5 + cam.shakeY);
      }

      bg.draw(ctx);
      ground.draw(ctx, worldZ);
      // Atmosphere last: it sits between the lens and BOTH the sky and the
      // ice, so it has to composite over the ground, not under it.
      bg.drawHaze(ctx);

      // Shadows first, as a group, so no prop's shadow lands on another's art.
      player.drawShadow(ctx);

      /* ── depth-sorted solids ── */
      const list = this._drawables;
      list.length = 0;
      for (let i = 0; i < obstacles.list.length; i++) {
        const o = obstacles.list[i];
        if (o.z > -3 && o.z < 134) list.push({ z: o.z, t: 0, o });
      }
      for (let i = 0; i < collectibles.list.length; i++) {
        const c = collectibles.list[i];
        if (c.z > -3 && c.z < 98) list.push({ z: c.z, t: 1, o: c });
      }
      list.push({ z: 0, t: 2, o: player });
      list.sort((a, b) => b.z - a.z);

      for (let i = 0; i < list.length; i++) {
        const d = list[i];
        if (d.t === 0) obstacles._drawOne(ctx, d.o, bg);
        else if (d.t === 1) collectibles._drawOne(ctx, d.o, bg);
        else {
          this._playerAura(ctx, player, powers, cam, bg, true);
          player.draw(ctx, bg);
          this._playerAura(ctx, player, powers, cam, bg, false);
        }
      }

      particles.draw(ctx);
      particles.drawSnow(ctx);

      ctx.restore();

      this._post(ctx, scene);
    }

    /* ── power-up auras (drawn around the penguin) ─────────── */
    _playerAura(ctx, player, powers, cam, bg, behind) {
      if (!powers) return;
      const p = cam.project(player.x, player.y + 0.55, 0, { x: 0, y: 0, s: 0, visible: false });
      if (!p.visible) return;
      const s = p.s;
      const t = performance.now() * 0.001;

      /* SHIELD — a faceted ice bubble */
      if (powers.shield > 0) {
        const R = 0.95 * s;
        const blink = powers.shield < 2.2 ? (0.45 + 0.55 * Math.abs(Math.sin(t * 12))) : 1;
        ctx.save();
        ctx.globalCompositeOperation = 'lighter';
        if (behind) {
          const g = ctx.createRadialGradient(p.x, p.y, R * 0.55, p.x, p.y, R);
          g.addColorStop(0, 'rgba(60,180,255,0)');
          g.addColorStop(0.82, 'rgba(90,206,255,' + (0.10 * blink).toFixed(3) + ')');
          g.addColorStop(1, 'rgba(150,236,255,' + (0.22 * blink).toFixed(3) + ')');
          ctx.fillStyle = g;
          ctx.beginPath(); ctx.arc(p.x, p.y, R, 0, TAU); ctx.fill();
        } else {
          // Rim + travelling facet glints = glass, not a coloured circle.
          ctx.strokeStyle = 'rgba(178,242,255,' + (0.5 * blink).toFixed(3) + ')';
          ctx.lineWidth = Math.max(1, 0.018 * s);
          ctx.beginPath(); ctx.arc(p.x, p.y, R, 0, TAU); ctx.stroke();
          for (let i = 0; i < 6; i++) {
            const a = t * 0.7 + (i / 6) * TAU;
            const a2 = a + 0.5;
            ctx.strokeStyle = 'rgba(226,252,255,' + (0.16 * blink).toFixed(3) + ')';
            ctx.lineWidth = Math.max(0.5, 0.01 * s);
            ctx.beginPath();
            ctx.arc(p.x, p.y, R * 0.985, a, a2);
            ctx.stroke();
          }
          const hg = ctx.createRadialGradient(p.x - R * 0.35, p.y - R * 0.4, 0, p.x - R * 0.35, p.y - R * 0.4, R * 0.55);
          hg.addColorStop(0, 'rgba(255,255,255,' + (0.22 * blink).toFixed(3) + ')');
          hg.addColorStop(1, 'rgba(255,255,255,0)');
          ctx.fillStyle = hg;
          ctx.beginPath(); ctx.arc(p.x - R * 0.35, p.y - R * 0.4, R * 0.55, 0, TAU); ctx.fill();
        }
        ctx.restore();
      }

      /* COCOA — heat haze + embers */
      if (powers.cocoa > 0 && !behind) {
        ctx.save();
        ctx.globalCompositeOperation = 'lighter';
        const R = 1.15 * s;
        const g = ctx.createRadialGradient(p.x, p.y, R * 0.2, p.x, p.y, R);
        const pulse = 0.6 + 0.4 * Math.sin(t * 9);
        g.addColorStop(0, 'rgba(255,190,110,' + (0.22 * pulse).toFixed(3) + ')');
        g.addColorStop(0.55, 'rgba(255,132,52,' + (0.10 * pulse).toFixed(3) + ')');
        g.addColorStop(1, 'rgba(255,90,30,0)');
        ctx.fillStyle = g;
        ctx.beginPath(); ctx.arc(p.x, p.y, R, 0, TAU); ctx.fill();
        ctx.restore();
      }

      /* MAGNET — field rings pulsing outward on the ice */
      if (powers.magnet > 0 && behind) {
        const gp = cam.project(player.x, 0.02, 0, { x: 0, y: 0, s: 0, visible: false });
        if (gp.visible) {
          ctx.save();
          ctx.globalCompositeOperation = 'lighter';
          for (let i = 0; i < 3; i++) {
            const u = U.wrap(t * 0.75 + i / 3, 1);
            const rr = u * 3.6 * gp.s;
            ctx.strokeStyle = 'rgba(255,132,176,' + ((1 - u) * 0.3).toFixed(3) + ')';
            ctx.lineWidth = Math.max(0.6, 0.02 * gp.s);
            ctx.beginPath();
            ctx.ellipse(gp.x, gp.y, rr, rr * 0.3, 0, 0, TAU);
            ctx.stroke();
          }
          ctx.restore();
        }
      }

      /* MULTIPLIER — orbiting violet motes */
      if (powers.multiplier > 0 && !behind) {
        ctx.save();
        ctx.globalCompositeOperation = 'lighter';
        for (let i = 0; i < 4; i++) {
          const a = t * 2.2 + (i / 4) * TAU;
          const ox = Math.cos(a) * 0.62 * s;
          const oy = Math.sin(a) * 0.2 * s - Math.sin(t * 3 + i) * 0.12 * s;
          const r = (0.06 + 0.02 * Math.sin(t * 6 + i)) * s;
          const g = ctx.createRadialGradient(p.x + ox, p.y + oy, 0, p.x + ox, p.y + oy, r * 3);
          g.addColorStop(0, 'rgba(240,224,255,0.8)');
          g.addColorStop(0.35, 'rgba(168,130,255,0.4)');
          g.addColorStop(1, 'rgba(140,90,255,0)');
          ctx.fillStyle = g;
          ctx.beginPath(); ctx.arc(p.x + ox, p.y + oy, r * 3, 0, TAU); ctx.fill();
        }
        ctx.restore();
      }
    }

    /* ── post ──────────────────────────────────────────────── */
    _post(ctx, scene) {
      const W = this.width, H = this.height;
      const sp = U.clamp(scene.speed01, 0, 1);

      /* Speed tunnel + base vignette, merged into ONE full-screen pass.
         Both are centre-radial darkenings, so painting them separately was
         paying twice for the same 1 Mpx of alpha blending. Cached and only
         rebuilt when the speed bucket or the viewport changes. */
      const bucket = Math.round(sp * 20);
      const key = W + ':' + H + ':' + bucket;
      if (key !== this._vigKey) {
        this._vigKey = key;
        const g = ctx.createRadialGradient(
          W * 0.5, H * 0.51, H * (0.42 - sp * 0.14),
          W * 0.5, H * 0.51, H * (1.0 - sp * 0.12));
        g.addColorStop(0, 'rgba(4,14,32,0)');
        g.addColorStop(0.62, 'rgba(5,16,38,' + (0.06 + sp * 0.19).toFixed(3) + ')');
        g.addColorStop(1, 'rgba(2,8,20,' + (0.46 + sp * 0.3).toFixed(3) + ')');
        this._vigGrd = g;
      }
      ctx.save();
      ctx.fillStyle = this._vigGrd;
      ctx.fillRect(0, 0, W, H);
      ctx.restore();

      /* radial streaks — a cheap, convincing motion blur at the edges */
      if (sp > 0.45 && this.quality > 0.5) {
        ctx.save();
        ctx.globalCompositeOperation = 'lighter';
        const n = Math.round(26 * this.quality);
        const t = performance.now() * 0.001;
        const cx = W * 0.5, cy = scene.cam.horizon;
        for (let i = 0; i < n; i++) {
          const a = U.hash1(i * 17 + 3) * TAU + t * 0.12;
          const r0 = H * (0.42 + U.hash1(i * 23) * 0.3);
          const len = H * (0.14 + U.hash1(i * 31) * 0.3) * (sp - 0.45) * 2.4;
          const al = (sp - 0.45) * 0.34 * (0.3 + U.hash1(i * 37) * 0.7);
          const x0 = cx + Math.cos(a) * r0, y0 = cy + Math.sin(a) * r0 * 0.85;
          const x1 = cx + Math.cos(a) * (r0 + len), y1 = cy + Math.sin(a) * (r0 + len) * 0.85;
          const lg = ctx.createLinearGradient(x0, y0, x1, y1);
          lg.addColorStop(0, 'rgba(190,232,255,0)');
          lg.addColorStop(0.4, 'rgba(212,244,255,' + al.toFixed(3) + ')');
          lg.addColorStop(1, 'rgba(190,232,255,0)');
          ctx.strokeStyle = lg;
          ctx.lineWidth = 1 + U.hash1(i * 41) * 2;
          ctx.beginPath(); ctx.moveTo(x0, y0); ctx.lineTo(x1, y1); ctx.stroke();
        }
        ctx.restore();
      }

      /* chromatic fringe at the very top end — sells "too fast" */
      if (sp > 0.72 && this.quality > 0.6) {
        const a = (sp - 0.72) * 0.5;
        ctx.save();
        ctx.globalCompositeOperation = 'screen';
        const L = ctx.createLinearGradient(0, 0, W * 0.16, 0);
        L.addColorStop(0, 'rgba(255,40,60,' + (a * 0.5).toFixed(3) + ')');
        L.addColorStop(1, 'rgba(255,40,60,0)');
        ctx.fillStyle = L; ctx.fillRect(0, 0, W * 0.16, H);
        const R = ctx.createLinearGradient(W, 0, W * 0.84, 0);
        R.addColorStop(0, 'rgba(0,190,255,' + (a * 0.5).toFixed(3) + ')');
        R.addColorStop(1, 'rgba(0,190,255,0)');
        ctx.fillStyle = R; ctx.fillRect(W * 0.84, 0, W * 0.16, H);
        ctx.restore();
      }

      /* power-up screen tints */
      if (scene.powers) {
        if (scene.powers.cocoa > 0) {
          ctx.save();
          ctx.globalCompositeOperation = 'overlay';
          const g = ctx.createRadialGradient(W * 0.5, H * 0.6, 0, W * 0.5, H * 0.6, H);
          g.addColorStop(0, 'rgba(255,170,90,0.05)');
          g.addColorStop(1, 'rgba(255,110,40,0.22)');
          ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
          ctx.restore();
        }
        if (scene.powers.multiplier > 0) {
          ctx.save();
          ctx.globalCompositeOperation = 'overlay';
          ctx.fillStyle = 'rgba(150,100,255,0.06)';
          ctx.fillRect(0, 0, W, H);
          ctx.restore();
        }
      }

      /* full-screen flash */
      if (this.flash.a > 0.004) {
        ctx.save();
        ctx.globalCompositeOperation = 'lighter';
        ctx.fillStyle = U.rgba(this.flash.r, this.flash.g, this.flash.b, this.flash.a * 0.55);
        ctx.fillRect(0, 0, W, H);
        ctx.restore();
      }

      /* death wash */
      if (scene.deathFade > 0) {
        ctx.save();
        const d = U.clamp(scene.deathFade, 0, 1);
        const g = ctx.createRadialGradient(W * 0.5, H * 0.6, 0, W * 0.5, H * 0.6, H * 1.1);
        g.addColorStop(0, 'rgba(120,20,30,' + (d * 0.12).toFixed(3) + ')');
        g.addColorStop(1, 'rgba(60,8,16,' + (d * 0.5).toFixed(3) + ')');
        ctx.fillStyle = g;
        ctx.fillRect(0, 0, W, H);
        ctx.restore();
      }
    }
  }

  global.Renderer = Renderer;
})(window);
