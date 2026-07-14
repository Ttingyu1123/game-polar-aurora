/* ═══════════════════════════════════════════════════════════
   BackgroundRenderer — everything above the ice line.

   Layers, back to front:
     1. sky gradient (slow hue drift over the run)
     2. star field   (deterministic hash → no array, no allocation)
     3. moon + halo
     4. aurora curtains (additive ribbons + vertical striations)
     5. cloud banks   (fbm blobs, parallax)
     6. far mountains → mid mountains → near ridge + iceberg field
     7. horizon haze  (the seam that hides where sky meets ice)

   Mountain silhouettes come from fbm, not from data. `ridge()` is
   sampled every frame at ~70 points per layer — cheaper than a
   cached bitmap and it lets the ranges parallax properly.

   The aurora is also the world's key light: `sampleAurora()` feeds
   GroundRenderer's ice reflection and Player's rim light, so the
   scene stays colour-consistent for free.
   ═══════════════════════════════════════════════════════════ */
(function (global) {
  'use strict';

  const U = global.U;
  const TAU = U.TAU;

  const RIBBONS = [
    { hue: 158, amp: 0.052, freq: 1.45, speed: 0.052, h: 0.30, y: 0.10, a: 0.50, seed: 11 },
    { hue: 186, amp: 0.070, freq: 0.95, speed: -0.038, h: 0.40, y: 0.02, a: 0.42, seed: 27 },
    { hue: 278, amp: 0.045, freq: 1.95, speed: 0.075, h: 0.24, y: 0.17, a: 0.30, seed: 43 },
    { hue: 322, amp: 0.038, freq: 2.6, speed: -0.095, h: 0.17, y: 0.22, a: 0.18, seed: 61 }
  ];

  class BackgroundRenderer {
    constructor(camera) {
      this.cam = camera;
      this.t = 0;
      this.hueDrift = 0;
      this.intensity = 1;      // aurora energy; spikes on aurora-crystal pickups
      this._flare = 0;
      this.quality = 1;
      this._skyGrd = null;
      this._skyKey = '';

      // Half-resolution sky buffer. Profiling showed the aurora alone cost
      // 5 ms/frame at full res — it is pure soft gradient work, so it loses
      // nothing at half scale and costs a quarter of the fill. Stars and the
      // moon ride along; the upscale actually flatters them (free bloom).
      // Mountains stay on the main canvas: their silhouettes must stay crisp.
      this.buf = null;
      this.bctx = null;
      this._bufKey = '';
      this.skyScale = 0.5;
    }

    _ensureBuffer() {
      const cam = this.cam;
      // Half of DEVICE pixels, not half of CSS pixels. On a dpr-2 phone the
      // latter is a quarter-resolution sky stretched over a retina canvas —
      // visibly mushy. Keying off dpr keeps the saving proportional (always
      // 1/4 the fill of the main canvas) at any pixel density.
      const sc = (this.quality > 0.6 ? 0.5 : 0.34) * cam.dpr;
      const bw = Math.max(2, Math.ceil(cam.width * sc));
      const bh = Math.max(2, Math.ceil(cam.height * sc));
      const key = bw + 'x' + bh;
      if (key === this._bufKey && this.buf) return;
      this._bufKey = key;
      this.skyScale = sc;
      this.buf = U.makeCanvas(bw, bh);
      this.bctx = this.buf.getContext('2d');
    }

    update(dt, worldZ) {
      this.t += dt;
      // One full colour cycle every ~200 m: the sky is a slow progress bar.
      this.hueDrift = Math.sin(worldZ * 0.0031) * 26 + Math.sin(worldZ * 0.00089) * 14;
      this._flare = Math.max(0, this._flare - dt * 0.85);
      this.intensity = 1 + this._flare * 1.5;
    }

    /** Aurora crystal pickup → the whole sky pulses. */
    flare(v) { this._flare = Math.min(2.2, this._flare + (v || 1)); }

    /* ── aurora sampling (shared with ice + rim light) ───────── */

    /** Vertical extent + colour of a ribbon at screen-x fraction. */
    _ribbonAt(rb, x01) {
      const cam = this.cam;
      const hz = cam.horizon;
      const drift = this.t * rb.speed;
      const n = U.fbm1(x01 * 3.1 + rb.seed + drift * 2.2, 3);
      const wave = Math.sin(x01 * TAU * rb.freq + drift * 6.0 + rb.seed) * 0.6
                 + Math.sin(x01 * TAU * rb.freq * 2.3 - drift * 3.4) * 0.25
                 + (n - 0.5) * 0.9;
      const H = cam.height;
      const top = hz - H * (rb.y + rb.h) - wave * H * rb.amp * 2.2;
      const bot = hz - H * rb.y * 0.35 - wave * H * rb.amp * 0.7;
      return { top, bot, wave, n };
    }

    /**
     * Approximate aurora light arriving at a screen-x fraction.
     * Used by the ice reflection and the penguin's rim light so the
     * whole frame is lit by the same source.
     * @returns {[number,number,number,number]} r,g,b,a
     */
    sampleAurora(x01) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let i = 0; i < RIBBONS.length; i++) {
        const rb = RIBBONS[i];
        const s = this._ribbonAt(rb, x01);
        const w = U.clamp((s.n * 0.7 + 0.45), 0, 1) * rb.a * this.intensity;
        const c = U.parseColor(U.hsl(rb.hue + this.hueDrift, 0.85, 0.6));
        r += c[0] * w; g += c[1] * w; b += c[2] * w; a += w;
      }
      if (a > 0) { r /= a; g /= a; b /= a; }
      return [r, g, b, U.clamp(a * 0.72, 0, 1)];
    }

    /* ── sky ─────────────────────────────────────────────────── */
    _sky(ctx) {
      const cam = this.cam;
      const H = cam.height, W = cam.width;
      const hz = cam.horizon;
      const hd = Math.round(this.hueDrift * 0.5);
      const key = W + ':' + H + ':' + Math.round(hz) + ':' + hd;
      if (key !== this._skyKey) {
        this._skyKey = key;
        const g = ctx.createLinearGradient(0, 0, 0, Math.max(hz + 2, 10));
        g.addColorStop(0.00, U.hsl(224 + hd * 0.3, 0.72, 0.055));
        g.addColorStop(0.32, U.hsl(217 + hd * 0.4, 0.66, 0.105));
        g.addColorStop(0.62, U.hsl(206 + hd * 0.5, 0.58, 0.175));
        g.addColorStop(0.84, U.hsl(198 + hd * 0.6, 0.50, 0.265));
        g.addColorStop(1.00, U.hsl(192 + hd * 0.6, 0.44, 0.365));
        this._skyGrd = g;
      }
      ctx.fillStyle = this._skyGrd;
      ctx.fillRect(0, 0, W, hz + 2);
    }

    /* ── stars ───────────────────────────────────────────────── */
    _stars(ctx) {
      const cam = this.cam, W = cam.width, hz = cam.horizon;
      const n = Math.round(150 * this.quality);
      const px = -cam.x * 5;                 // gentle parallax with the camera
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      for (let i = 0; i < n; i++) {
        const sx = U.wrap(U.hash1(i * 3 + 1) * W * 1.35 + px, W * 1.35) - W * 0.175;
        const sy = U.hash1(i * 7 + 5) * hz * 0.86;
        if (sy > hz - 6) continue;
        const depth = U.hash1(i * 11 + 2);
        const tw = 0.55 + 0.45 * Math.sin(this.t * (1.1 + depth * 2.6) + i * 2.4);
        // Fade stars out as they near the horizon haze.
        const horizonFade = U.smoothstep(hz, hz * 0.55, sy);
        const a = (0.22 + depth * 0.68) * tw * horizonFade;
        if (a < 0.02) continue;
        // Never let a star fall below one buffer pixel or it strobes as the
        // sub-pixel coverage flickers frame to frame.
        const minR = 1.05 / this.skyScale;
        const r = Math.max(minR, 0.5 + depth * 1.35);
        if (depth > 0.86) {
          const grd = ctx.createRadialGradient(sx, sy, 0, sx, sy, r * 5);
          grd.addColorStop(0, U.rgba(255, 255, 255, a));
          grd.addColorStop(0.3, U.rgba(190, 226, 255, a * 0.4));
          grd.addColorStop(1, 'rgba(150,200,255,0)');
          ctx.fillStyle = grd;
          ctx.beginPath(); ctx.arc(sx, sy, r * 5, 0, TAU); ctx.fill();
          // Diffraction spike on the brightest few.
          ctx.strokeStyle = U.rgba(220, 240, 255, a * 0.5);
          ctx.lineWidth = 0.7 / this.skyScale;
          ctx.beginPath();
          ctx.moveTo(sx - r * 3.4, sy); ctx.lineTo(sx + r * 3.4, sy);
          ctx.moveTo(sx, sy - r * 3.4); ctx.lineTo(sx, sy + r * 3.4);
          ctx.stroke();
        } else {
          ctx.fillStyle = U.rgba(235, 245, 255, a);
          ctx.fillRect(sx - r * 0.5, sy - r * 0.5, r, r);
        }
      }
      ctx.restore();
    }

    /* ── moon ────────────────────────────────────────────────── */
    _moon(ctx) {
      const cam = this.cam, W = cam.width, hz = cam.horizon;
      const mx = W * 0.795 - cam.x * 9;
      const my = hz * 0.235;
      const r = Math.max(16, cam.height * 0.052);

      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      const halo = ctx.createRadialGradient(mx, my, r * 0.6, mx, my, r * 9);
      halo.addColorStop(0, 'rgba(200,232,255,0.30)');
      halo.addColorStop(0.18, 'rgba(160,210,255,0.13)');
      halo.addColorStop(0.5, 'rgba(120,180,240,0.045)');
      halo.addColorStop(1, 'rgba(90,150,220,0)');
      ctx.fillStyle = halo;
      ctx.beginPath(); ctx.arc(mx, my, r * 9, 0, TAU); ctx.fill();
      ctx.restore();

      // Disc with a terminator — lit from the upper-left, like the aurora.
      const g = ctx.createRadialGradient(mx - r * 0.35, my - r * 0.4, r * 0.1, mx, my, r * 1.08);
      g.addColorStop(0, '#ffffff');
      g.addColorStop(0.45, '#e8f4ff');
      g.addColorStop(0.82, '#b9d8f2');
      g.addColorStop(1, '#8fb6d8');
      ctx.fillStyle = g;
      ctx.beginPath(); ctx.arc(mx, my, r, 0, TAU); ctx.fill();

      // Craters — hashed, so identical every frame without a stored list.
      ctx.save();
      ctx.beginPath(); ctx.arc(mx, my, r, 0, TAU); ctx.clip();
      for (let i = 0; i < 9; i++) {
        const a = U.hash1(i * 13 + 3) * TAU;
        const d = Math.sqrt(U.hash1(i * 17 + 9)) * r * 0.82;
        const cr = r * (0.06 + U.hash1(i * 19 + 4) * 0.17);
        const cx = mx + Math.cos(a) * d, cy = my + Math.sin(a) * d;
        const cg = ctx.createRadialGradient(cx - cr * 0.3, cy - cr * 0.3, 0, cx, cy, cr);
        cg.addColorStop(0, 'rgba(150,180,208,0.30)');
        cg.addColorStop(0.7, 'rgba(168,196,222,0.16)');
        cg.addColorStop(1, 'rgba(215,235,255,0)');
        ctx.fillStyle = cg;
        ctx.beginPath(); ctx.arc(cx, cy, cr, 0, TAU); ctx.fill();
      }
      ctx.restore();
    }

    /* ── aurora ──────────────────────────────────────────────── */
    _aurora(ctx) {
      const cam = this.cam, W = cam.width, H = cam.height, hz = cam.horizon;
      const STEPS = Math.max(18, Math.round(46 * this.quality));

      ctx.save();
      ctx.globalCompositeOperation = 'lighter';

      for (let ri = 0; ri < RIBBONS.length; ri++) {
        const rb = RIBBONS[ri];
        const hue = rb.hue + this.hueDrift;
        const alpha = rb.a * this.intensity;
        if (alpha < 0.01) continue;

        // Build the curtain as one closed path: top edge left→right, bottom back.
        const tops = new Array(STEPS + 1), bots = new Array(STEPS + 1);
        let minTop = 1e9, maxBot = -1e9;
        for (let i = 0; i <= STEPS; i++) {
          const x01 = i / STEPS;
          const s = this._ribbonAt(rb, x01 + cam.x * 0.004);
          tops[i] = s.top; bots[i] = s.bot;
          if (s.top < minTop) minTop = s.top;
          if (s.bot > maxBot) maxBot = s.bot;
        }
        if (maxBot <= 0) continue;

        ctx.beginPath();
        for (let i = 0; i <= STEPS; i++) {
          const x = (i / STEPS) * W;
          if (i === 0) ctx.moveTo(x, tops[i]); else ctx.lineTo(x, tops[i]);
        }
        for (let i = STEPS; i >= 0; i--) ctx.lineTo((i / STEPS) * W, bots[i]);
        ctx.closePath();

        // One vertical gradient for the whole curtain: bright core near the
        // bottom (where the "rays" ground out), transparent at both edges.
        const g = ctx.createLinearGradient(0, minTop, 0, maxBot);
        g.addColorStop(0.00, U.hsl(hue + 34, 0.9, 0.62, 0));
        g.addColorStop(0.13, U.hsl(hue + 22, 0.9, 0.60, alpha * 0.22));
        g.addColorStop(0.44, U.hsl(hue, 0.88, 0.56, alpha * 0.62));
        g.addColorStop(0.74, U.hsl(hue - 12, 0.92, 0.62, alpha * 0.9));
        g.addColorStop(0.93, U.hsl(hue - 26, 0.95, 0.70, alpha * 0.34));
        g.addColorStop(1.00, U.hsl(hue - 34, 0.95, 0.74, 0));
        ctx.fillStyle = g;
        ctx.fill();

        // Striations: the vertical rays that make an aurora legible.
        // One gradient for the whole ribbon, alpha varied per ray via
        // globalAlpha — 52 gradient objects and 52 large fills per ribbon
        // was the single most expensive thing in the frame.
        if (this.quality > 0.55) {
          ctx.save();
          ctx.clip();
          const rays = Math.round(30 * this.quality);
          const rg = ctx.createLinearGradient(0, minTop, 0, maxBot);
          rg.addColorStop(0, U.hsl(hue + 20, 1, 0.8, 0));
          rg.addColorStop(0.55, U.hsl(hue + 6, 1, 0.78, 0.55));
          rg.addColorStop(1, U.hsl(hue - 20, 1, 0.85, 0));
          ctx.fillStyle = rg;
          for (let i = 0; i < rays; i++) {
            const x01 = (i + 0.5) / rays;
            const x = x01 * W;
            const nn = U.noise1(x01 * 22 + rb.seed * 7 + this.t * rb.speed * 9);
            const ra = (nn - 0.35) * alpha * 0.85;
            if (ra <= 0.005) continue;
            const w = (W / rays) * (0.35 + nn * 0.9);
            ctx.globalAlpha = U.clamp(ra, 0, 1);
            ctx.fillRect(x - w * 0.5, minTop, w, maxBot - minTop);
          }
          ctx.restore();
        }

        // Bottom bloom: where the curtain meets the world it glows hardest.
        const bg = ctx.createLinearGradient(0, maxBot - H * 0.1, 0, maxBot + H * 0.05);
        bg.addColorStop(0, U.hsl(hue - 18, 1, 0.7, 0));
        bg.addColorStop(1, U.hsl(hue - 24, 1, 0.72, alpha * 0.1));
        ctx.fillStyle = bg;
        ctx.fillRect(0, maxBot - H * 0.1, W, H * 0.15);
      }

      // Whole-sky wash on flare so the pulse is unmissable.
      if (this._flare > 0.02) {
        const w = ctx.createLinearGradient(0, 0, 0, hz);
        const h = 168 + this.hueDrift;
        w.addColorStop(0, U.hsl(h, 0.9, 0.6, 0));
        w.addColorStop(1, U.hsl(h, 0.9, 0.6, this._flare * 0.11));
        ctx.fillStyle = w;
        ctx.fillRect(0, 0, W, hz);
      }
      ctx.restore();
    }

    /* ── clouds ──────────────────────────────────────────────── */
    _clouds(ctx) {
      if (this.quality < 0.5) return;
      const cam = this.cam, W = cam.width, hz = cam.horizon;
      ctx.save();
      for (let layer = 0; layer < 2; layer++) {
        const par = layer === 0 ? 14 : 30;
        const drift = this.t * (layer === 0 ? 3.6 : 7.5) + cam.x * par;
        const yBase = hz - cam.height * (layer === 0 ? 0.135 : 0.062);
        const n = 5;
        for (let i = 0; i < n; i++) {
          const sp = W * 1.6;
          const cx = U.wrap(U.hash1(i * 31 + layer * 97) * sp + drift, sp) - sp * 0.3;
          const cy = yBase - U.hash1(i * 41 + layer * 13) * cam.height * 0.05;
          const cw = cam.height * (0.14 + U.hash1(i * 53 + layer) * 0.2);
          const ch = cw * (0.16 + U.hash1(i * 59 + layer) * 0.08);
          const a = (layer === 0 ? 0.11 : 0.19) * (0.55 + U.hash1(i * 61 + layer) * 0.45);
          const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, cw);
          g.addColorStop(0, U.rgba(190, 222, 250, a));
          g.addColorStop(0.5, U.rgba(150, 190, 230, a * 0.5));
          g.addColorStop(1, U.rgba(120, 165, 215, 0));
          ctx.fillStyle = g;
          ctx.save();
          ctx.translate(cx, cy); ctx.scale(1, ch / cw); ctx.translate(-cx, -cy);
          ctx.beginPath(); ctx.arc(cx, cy, cw, 0, TAU); ctx.fill();
          ctx.restore();
        }
      }
      ctx.restore();
    }

    /* ── mountains ───────────────────────────────────────────── */

    /** Procedural ridge height (0..1) at horizontal sample `u`. */
    _ridge(u, seed, sharp) {
      const a = U.fbm1(u * 1.15 + seed, 5, 0.52);
      const b = U.fbm1(u * 3.4 + seed * 2.3, 3, 0.5);
      // Ridged multifractal-ish: fold the noise to get peaks, not blobs.
      const folded = 1 - Math.abs(a * 2 - 1);
      return U.clamp(folded * 0.72 + b * 0.28, 0, 1) * sharp;
    }

    _mountainLayer(ctx, cfg) {
      const cam = this.cam, W = cam.width, hz = cam.horizon;
      const H = cam.height;
      const off = cam.x * cfg.par + cfg.scroll;
      const steps = Math.max(26, Math.round(74 * this.quality));
      const peak = H * cfg.height;
      const base = hz + H * 0.012;

      const pts = new Array(steps + 1);
      for (let i = 0; i <= steps; i++) {
        const x = (i / steps) * W;
        const u = (x + off) * cfg.scale;
        const h = this._ridge(u, cfg.seed, cfg.sharp);
        pts[i] = [x, base - h * peak];
      }

      ctx.beginPath();
      ctx.moveTo(0, base + 4);
      for (let i = 0; i <= steps; i++) ctx.lineTo(pts[i][0], pts[i][1]);
      ctx.lineTo(W, base + 4);
      ctx.closePath();

      const g = ctx.createLinearGradient(0, base - peak, 0, base);
      for (const st of cfg.grad) g.addColorStop(st[0], st[1]);
      ctx.fillStyle = g;
      ctx.fill();

      // Snow caps: brighten only the steep, high, aurora-facing faces.
      // Bucketed by alpha into 3 passes — one gradient and one path each.
      // (Per-step gradients cost 3.9 ms/frame across the three ranges; this
      // is visually identical and effectively free.)
      if (cfg.snow) {
        ctx.save();
        ctx.clip();
        ctx.globalCompositeOperation = 'lighter';
        const BUCKETS = 3;
        const capH = peak * 0.3;
        const sg = ctx.createLinearGradient(0, base - peak, 0, base - peak + capH * 1.6);
        sg.addColorStop(0, U.rgba(cfg.snowCol[0], cfg.snowCol[1], cfg.snowCol[2], 1));
        sg.addColorStop(1, U.rgba(cfg.snowCol[0], cfg.snowCol[1], cfg.snowCol[2], 0));

        for (let b = 0; b < BUCKETS; b++) {
          const lo = b / BUCKETS, hi = (b + 1) / BUCKETS;
          let any = false;
          ctx.beginPath();
          for (let i = 1; i <= steps; i++) {
            const p0 = pts[i - 1], p1 = pts[i];
            const slope = (p1[1] - p0[1]) / Math.max(1, p1[0] - p0[0]);
            const high = U.smoothstep(base - peak * 0.22, base - peak * 0.72, p1[1]);
            if (high <= 0.01) continue;
            // Faces tilted left catch the aurora; right faces stay in shadow.
            const facing = U.clamp(slope * 1.5 + 0.5, 0, 1);
            const w = high * (0.25 + facing * 0.75);
            if (w < lo || w >= hi) continue;
            any = true;
            ctx.rect(p0[0] - 1, p1[1], (p1[0] - p0[0]) + 2, capH * high);
          }
          if (!any) continue;
          ctx.save();
          ctx.clip();
          ctx.globalAlpha = cfg.snow * (lo + hi) * 0.5;
          ctx.fillStyle = sg;
          ctx.fillRect(0, base - peak, W, peak + 4);
          ctx.restore();
        }
        ctx.restore();
      }

      // Rim light along the crest — the aurora silhouetting the range.
      // Three passes, wide-and-faint to narrow-and-bright: a single hairline
      // stroke read as a stray cyan wire laid over the mountains rather than
      // as light wrapping an edge. Glow is a falloff, not a line.
      if (cfg.rim) {
        ctx.save();
        ctx.globalCompositeOperation = 'lighter';
        ctx.lineJoin = 'round';
        ctx.lineCap = 'round';
        const rimPath = () => {
          ctx.beginPath();
          for (let i = 0; i <= steps; i++) {
            if (i === 0) ctx.moveTo(pts[i][0], pts[i][1]); else ctx.lineTo(pts[i][0], pts[i][1]);
          }
        };
        const grad = (mul) => {
          const rg = ctx.createLinearGradient(0, 0, W, 0);
          for (let i = 0; i <= 6; i++) {
            const s = this.sampleAurora(i / 6);
            rg.addColorStop(i / 6, U.rgba(s[0], s[1], s[2], s[3] * cfg.rim * mul));
          }
          return rg;
        };
        const w = cfg.rimW || 1.2;
        for (const [mul, width] of [[0.10, w * 7], [0.22, w * 2.6], [0.55, w * 0.9]]) {
          ctx.strokeStyle = grad(mul);
          ctx.lineWidth = width;
          rimPath();
          ctx.stroke();
        }
        ctx.restore();
      }
    }

    _mountains(ctx) {
      const H = this.cam.height;
      // Far range — desaturated, almost fog.
      this._mountainLayer(ctx, {
        seed: 3.7, scale: 0.0011, par: 0.9, scroll: 0, height: 0.135, sharp: 0.95,
        grad: [[0, '#2c4f74'], [0.5, '#22405f'], [1, '#1b3450']],
        snow: 0.26, snowCol: [190, 226, 255], rim: 0.5, rimW: 1
      });
      // Mid range — the readable silhouette.
      this._mountainLayer(ctx, {
        seed: 12.4, scale: 0.0022, par: 2.1, scroll: 0, height: 0.105, sharp: 1,
        grad: [[0, '#1d3a5a'], [0.45, '#152c48'], [1, '#0e2038']],
        snow: 0.42, snowCol: [215, 240, 255], rim: 0.85, rimW: 1.4
      });
      // Near ridge — dark, crisp, anchors the horizon.
      this._mountainLayer(ctx, {
        seed: 28.9, scale: 0.0043, par: 4.4, scroll: 0, height: 0.062, sharp: 1,
        grad: [[0, '#122744'], [0.5, '#0b1a30'], [1, '#071223']],
        snow: 0.5, snowCol: [225, 245, 255], rim: 1.1, rimW: 1.8
      });
    }

    /** Distant iceberg field sitting right on the ice line. */
    _icebergs(ctx) {
      const cam = this.cam, W = cam.width, hz = cam.horizon, H = cam.height;
      const n = Math.round(11 * this.quality);
      const off = cam.x * 7;
      ctx.save();
      for (let i = 0; i < n; i++) {
        const sp = W * 1.5;
        const x = U.wrap(U.hash1(i * 71 + 5) * sp - off, sp) - sp * 0.25;
        const w = H * (0.018 + U.hash1(i * 73 + 2) * 0.045);
        const h = w * (0.55 + U.hash1(i * 79 + 8) * 0.9);
        const y = hz + H * 0.004;
        const skew = (U.hash1(i * 83 + 1) - 0.5) * w * 0.8;

        ctx.beginPath();
        ctx.moveTo(x - w, y);
        ctx.lineTo(x - w * 0.42 + skew * 0.3, y - h * 0.62);
        ctx.lineTo(x + skew, y - h);
        ctx.lineTo(x + w * 0.55 + skew * 0.4, y - h * 0.48);
        ctx.lineTo(x + w, y);
        ctx.closePath();
        const g = ctx.createLinearGradient(0, y - h, 0, y);
        g.addColorStop(0, 'rgba(196,232,255,0.92)');
        g.addColorStop(0.5, 'rgba(126,180,222,0.85)');
        g.addColorStop(1, 'rgba(72,120,170,0.8)');
        ctx.fillStyle = g;
        ctx.fill();

        // Lit face, aurora side.
        ctx.beginPath();
        ctx.moveTo(x + skew, y - h);
        ctx.lineTo(x - w * 0.42 + skew * 0.3, y - h * 0.62);
        ctx.lineTo(x - w * 0.1, y);
        ctx.lineTo(x + skew * 0.4, y);
        ctx.closePath();
        ctx.fillStyle = 'rgba(228,246,255,0.32)';
        ctx.fill();
      }
      ctx.restore();
    }

    /**
     * Haze band welding sky to ice.
     *
     * This is drawn by the Renderer AFTER the ground, not as part of the
     * background: the ground's own fog band starts exactly at the horizon
     * and would paint over the lower half of the haze, leaving a hard ruled
     * line across the full width of the frame. Atmosphere sits in front of
     * everything it is between — so it has to be composited last.
     */
    drawHaze(ctx) {
      const cam = this.cam, W = cam.width, hz = cam.horizon, H = cam.height;
      const band = H * 0.075;
      ctx.save();
      const g = ctx.createLinearGradient(0, hz - band, 0, hz + band * 0.75);
      g.addColorStop(0, 'rgba(150,196,232,0)');
      g.addColorStop(0.52, 'rgba(168,212,242,0.44)');
      g.addColorStop(0.72, 'rgba(190,228,250,0.55)');
      g.addColorStop(1, 'rgba(206,238,255,0.1)');
      ctx.fillStyle = g;
      ctx.fillRect(0, hz - band, W, band * 1.75);

      // Aurora bleeding into the haze, tinted per column.
      ctx.globalCompositeOperation = 'lighter';
      const ag = ctx.createLinearGradient(0, 0, W, 0);
      for (let i = 0; i <= 8; i++) {
        const s = this.sampleAurora(i / 8);
        ag.addColorStop(i / 8, U.rgba(s[0], s[1], s[2], s[3] * 0.2));
      }
      ctx.fillStyle = ag;
      ctx.fillRect(0, hz - band * 0.7, W, band * 1.2);
      ctx.restore();
    }

    /* ── entry point ─────────────────────────────────────────── */
    draw(ctx) {
      const cam = this.cam;
      this._ensureBuffer();

      // Soft layers → half-res buffer. The scaled transform lets every
      // routine keep working in CSS pixels, unaware it's been downsampled.
      const b = this.bctx;
      b.setTransform(1, 0, 0, 1, 0, 0);
      b.clearRect(0, 0, this.buf.width, this.buf.height);
      b.setTransform(this.skyScale, 0, 0, this.skyScale, 0, 0);
      this._sky(b);
      this._stars(b);
      this._moon(b);
      this._aurora(b);
      this._clouds(b);
      b.setTransform(1, 0, 0, 1, 0, 0);

      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(this.buf, 0, 0, cam.width, cam.height);

      // Crisp layers stay at native resolution.
      this._mountains(ctx);
      this._icebergs(ctx);
      // NB: drawHaze() is deliberately NOT called here — see its comment.
    }
  }

  global.BackgroundRenderer = BackgroundRenderer;
})(window);
