/* ═══════════════════════════════════════════════════════════
   GroundRenderer — the frozen runway.

   THE CORE TRICK
   The ice is a plane at y = 0, so a screen row and a world depth are
   the same number wearing different hats (Camera.zAtScreenY). Walking
   rows top→bottom therefore gives per-pixel-correct perspective
   texturing with zero geometry: bands, fog and the specular sweep are
   all just functions of z evaluated once per row.

   Anything that is a straight line in world space is a straight line
   on screen (projection is projective), so lane dashes, edge strips
   and grid lines are plain 4-point quads — no subdivision needed.

   Layers
     1. row pass      — snow field + ice, fog, bands, specular sweep
     2. reflections   — aurora + moon glitter (strong near the horizon,
                        where the viewing angle grazes: cheap Fresnel)
     3. edge AO       — contact shadow where ice meets the snow banks
     4. grid + dashes — the speed read
     5. cracks/frost  — surface detail, hashed so it never pops
     6. banks/drifts  — 3-D shoulders framing the runway
   ═══════════════════════════════════════════════════════════ */
(function (global) {
  'use strict';

  const U = global.U;
  const W3 = global.WORLD;
  const TAU = U.TAU;

  const FOG = [188, 224, 248];
  const FIELD_NEAR = [214, 234, 249];
  const ICE_NEAR = [104, 168, 214];
  const ICE_DEEP = [62, 118, 168];

  /**
   * Near clip for runway geometry. The camera sits at z ≈ −8.6, so anything
   * from about −8.2 forward is still in front of the lens. Quads that stopped
   * at z = 0.6 ended at ~80 % of the screen height and left a hard seam across
   * the bottom of the frame — the runway must be built past the viewport edge.
   */
  const NEAR_Z = -6.5;

  class GroundRenderer {
    constructor(camera, bg) {
      this.cam = camera;
      this.bg = bg;
      this.t = 0;
      this.quality = 1;
      this._p = { x: 0, y: 0, s: 0, visible: false };
      this._q = { x: 0, y: 0, s: 0, visible: false };
    }

    update(dt) { this.t += dt; }

    /* ── helpers ───────────────────────────────────────────── */

    /** Ground quad from (x1..x2) spanning depth z1..z2. Straight in both spaces. */
    _quad(ctx, x1, x2, z1, z2) {
      const cam = this.cam, p = this._p, q = this._q;
      cam.project(x1, 0, z1, p); if (!p.visible) return false;
      const ax = p.x, ay = p.y;
      cam.project(x2, 0, z1, q); if (!q.visible) return false;
      const bx = q.x, by = q.y;
      cam.project(x2, 0, z2, p); if (!p.visible) return false;
      const cx = p.x, cy = p.y;
      cam.project(x1, 0, z2, q); if (!q.visible) return false;
      ctx.beginPath();
      ctx.moveTo(ax, ay); ctx.lineTo(bx, by); ctx.lineTo(cx, cy); ctx.lineTo(q.x, q.y);
      ctx.closePath();
      return true;
    }

    /* ── 1. row pass ───────────────────────────────────────── */
    _rows(ctx, worldZ) {
      const cam = this.cam;
      const W = cam.width, H = cam.height;
      const hz = cam.horizon;
      const y0 = Math.max(0, Math.ceil(hz + 0.5));
      if (y0 >= H) return;

      // Rows above this are past the draw distance → flat fog.
      const yFar = Math.max(y0, Math.floor(cam.screenYAtZ(W3.FAR)));
      if (yFar > y0) {
        ctx.fillStyle = U.rgb(FOG[0], FOG[1], FOG[2]);
        ctx.fillRect(0, y0, W, yFar - y0 + 1);
      }

      const halfW = W * 0.5;
      const spec = this.t * 2.1;      // travelling specular sweep
      const fogSpan = W3.FAR - W3.FOG_START;

      // Aurora light landing on the snow. Sampled once per frame at three
      // points rather than per row — the field is matte, so a slow colour
      // wash is all it needs, and snow that ignores the sky looks like paper.
      const skyL = this.bg.sampleAurora(0.5);
      const tintR = (skyL[0] - 210) * skyL[3] * 0.16;
      const tintG = (skyL[1] - 210) * skyL[3] * 0.16;
      const tintB = (skyL[2] - 210) * skyL[3] * 0.16;

      for (let sy = yFar; sy < H; sy++) {
        const z = cam.zAtScreenY(sy + 0.5);
        if (!isFinite(z) || z > W3.FAR) continue;
        const depth = z - cam.z;
        if (depth <= 0.4) continue;
        const s = cam.focal / depth;
        const zw = z + worldZ;                        // absolute texture depth

        const fog = U.clamp((z - W3.FOG_START) / fogSpan, 0, 1);
        const f = fog * fog * (3 - 2 * fog);          // smoothstep

        /* — snow field — */
        // Beating sines at incommensurate periods: long dunes, a mid ripple
        // and a fine grain that never repeats visibly. Sastrugi, basically.
        const dune = Math.sin(zw * 0.041) * 7.5
                   + Math.sin(zw * 0.163 + 1.7) * 4.0
                   + Math.sin(zw * 0.51 + 0.6) * 2.2
                   + Math.sin(zw * 1.7) * 1.2;
        // Snow is blue in its own shadow: darker troughs go cooler, not just
        // grey. That single asymmetry is most of what sells it as snow.
        const cool = dune < 0 ? -dune * 0.5 : 0;
        const fr = U.lerp(FIELD_NEAR[0] + dune - cool * 1.4 + tintR, FOG[0], f);
        const fg = U.lerp(FIELD_NEAR[1] + dune * 0.9 - cool * 0.5 + tintG, FOG[1], f);
        const fb = U.lerp(FIELD_NEAR[2] + dune * 0.55 + cool * 0.4 + tintB, FOG[2], f);
        ctx.fillStyle = 'rgb(' + (fr | 0) + ',' + (fg | 0) + ',' + (fb | 0) + ')';
        ctx.fillRect(0, sy, W, 1);

        /* — ice runway — */
        const lx = halfW + (-W3.ROAD_HALF - cam.x) * s;
        const rx = halfW + (W3.ROAD_HALF - cam.x) * s;
        if (rx <= 0 || lx >= W) continue;

        // Depth-of-ice: the surface darkens where the frozen sea is deeper.
        const deep = 0.5 + 0.5 * Math.sin(zw * 0.026 + 0.9);
        let ir = U.lerp(ICE_NEAR[0], ICE_DEEP[0], deep);
        let ig = U.lerp(ICE_NEAR[1], ICE_DEEP[1], deep);
        let ib = U.lerp(ICE_NEAR[2], ICE_DEEP[2], deep);

        // Specular sweep: broad highlight bands sliding toward the player.
        // sin^8 keeps them tight and glassy instead of a soft wash.
        const sw = Math.sin(zw * 0.115 - spec);
        const gloss = Math.pow(Math.max(0, sw), 8) * 105;
        // Fine crystalline grain.
        const grain = Math.sin(zw * 1.31) * 4 + Math.sin(zw * 0.53 + 2.1) * 5;
        ir += gloss * 0.72 + grain; ig += gloss * 0.88 + grain; ib += gloss + grain;

        // Grazing angle → the ice turns mirror-bright toward the horizon.
        const graze = Math.pow(U.clamp(1 - (sy - hz) / Math.max(1, H - hz), 0, 1), 1.6);
        ir = U.lerp(ir, 176, graze * 0.5); ig = U.lerp(ig, 214, graze * 0.5); ib = U.lerp(ib, 244, graze * 0.5);

        ctx.fillStyle = 'rgb('
          + (U.lerp(ir, FOG[0], f) | 0) + ','
          + (U.lerp(ig, FOG[1], f) | 0) + ','
          + (U.lerp(ib, FOG[2], f) | 0) + ')';
        const x0 = Math.max(0, lx);
        ctx.fillRect(x0, sy, Math.min(W, rx) - x0, 1);
      }
    }

    /* ── 2. reflections ────────────────────────────────────── */

    /**
     * The reflection needs colour that varies horizontally (which curtain is
     * overhead) multiplied by alpha that varies vertically (Fresnel — ice
     * turns mirror-like only at a grazing angle). Canvas cannot multiply two
     * gradients, and doing it with `destination-in` on the main canvas is a
     * trap: it erases the ground that was already painted there, not just
     * this layer. So we compose it in a private quarter-res buffer, where
     * destination-in means what we actually want, then blit it in additively.
     */
    _reflections(ctx, worldZ) {
      const cam = this.cam, W = cam.width, H = cam.height, hz = cam.horizon;
      const top = Math.max(0, hz);
      if (top >= H - 2) return;

      const bw = Math.max(2, Math.ceil(W * 0.25)), bh = Math.max(2, Math.ceil(H * 0.25));
      if (!this._ref || this._ref.width !== bw || this._ref.height !== bh) {
        this._ref = U.makeCanvas(bw, bh);
        this._refCtx = this._ref.getContext('2d');
      }
      const b = this._refCtx;
      b.setTransform(1, 0, 0, 1, 0, 0);
      b.clearRect(0, 0, bw, bh);
      b.setTransform(0.25, 0, 0, 0.25, 0, 0);

      // Colour: sampled straight from the real curtains overhead.
      b.globalCompositeOperation = 'source-over';
      const g = b.createLinearGradient(0, 0, W, 0);
      for (let i = 0; i <= 8; i++) {
        const c = this.bg.sampleAurora(i / 8);
        g.addColorStop(i / 8, U.rgba(c[0], c[1], c[2], c[3]));
      }
      b.fillStyle = g;
      b.fillRect(0, top, W, H - top);

      // Alpha: Fresnel ramp, brightest right below the horizon.
      b.globalCompositeOperation = 'destination-in';
      const fres = b.createLinearGradient(0, top, 0, H);
      fres.addColorStop(0, 'rgba(255,255,255,0.62)');
      fres.addColorStop(0.22, 'rgba(255,255,255,0.34)');
      fres.addColorStop(0.6, 'rgba(255,255,255,0.14)');
      fres.addColorStop(1, 'rgba(255,255,255,0.05)');
      b.fillStyle = fres;
      b.fillRect(0, top, W, H - top);
      b.setTransform(1, 0, 0, 1, 0, 0);

      ctx.save();
      // Clip to the runway: only polished ice mirrors. The near bound is
      // BEHIND the player so the reflection reaches the bottom of the frame.
      if (!this._quad(ctx, -W3.ROAD_HALF, W3.ROAD_HALF, NEAR_Z, W3.FAR * 0.9)) { ctx.restore(); return; }
      ctx.clip();
      ctx.globalCompositeOperation = 'lighter';
      ctx.imageSmoothingEnabled = true;
      ctx.drawImage(this._ref, 0, 0, W, H);
      ctx.restore();

      // Moon glitter path — a wobbling column of specks under the moon.
      ctx.save();
      if (!this._quad(ctx, -W3.ROAD_HALF, W3.ROAD_HALF, NEAR_Z, W3.FAR * 0.9)) { ctx.restore(); return; }
      ctx.clip();
      ctx.globalCompositeOperation = 'lighter';
      const mx = W * 0.795 - cam.x * 9;
      const col = ctx.createLinearGradient(0, top, 0, H);
      col.addColorStop(0, 'rgba(214,238,255,0.20)');
      col.addColorStop(0.35, 'rgba(190,224,255,0.07)');
      col.addColorStop(1, 'rgba(170,210,255,0)');
      ctx.fillStyle = col;
      const spread = W * 0.02;
      ctx.beginPath();
      ctx.moveTo(mx - spread, top); ctx.lineTo(mx + spread, top);
      ctx.lineTo(mx + spread * 9, H); ctx.lineTo(mx - spread * 9, H);
      ctx.closePath(); ctx.fill();

      if (this.quality > 0.6) {
        const n = 30;
        for (let i = 0; i < n; i++) {
          const u = U.hash1(i * 37 + 3);
          // Glints ride the world toward us and recycle — a real flow.
          const zz = U.wrap(U.hash1(i * 41 + 7) * 60 - worldZ * 0.55, 60) + 2;
          const sy = cam.screenYAtZ(zz);
          if (sy < top || sy > H) continue;
          const sc = cam.scaleAt(zz);
          const wob = Math.sin(this.t * (1.4 + u * 2.6) + i) * spread * 4;
          const gx = mx + (u - 0.5) * spread * 12 + wob;
          const tw = 0.35 + 0.65 * Math.abs(Math.sin(this.t * (2.1 + u * 3) + i * 1.7));
          const r = (0.02 + u * 0.05) * sc;
          if (r < 0.3) continue;
          const gg = ctx.createRadialGradient(gx, sy, 0, gx, sy, r * 4);
          gg.addColorStop(0, 'rgba(255,255,255,' + (0.5 * tw).toFixed(3) + ')');
          gg.addColorStop(0.4, 'rgba(200,232,255,' + (0.18 * tw).toFixed(3) + ')');
          gg.addColorStop(1, 'rgba(170,214,255,0)');
          ctx.fillStyle = gg;
          ctx.beginPath(); ctx.ellipse(gx, sy, r * 4, r * 1.5, 0, 0, TAU); ctx.fill();
        }
      }
      ctx.restore();
    }

    /* ── 3. edge ambient occlusion ─────────────────────────── */
    _edgeAO(ctx) {
      const cam = this.cam;
      ctx.save();
      // Three nested bands approximate the contact shadow cheaply.
      const bands = [[0.0, 0.30], [0.34, 0.14], [0.9, 0.05]];
      for (const [inset, alpha] of bands) {
        ctx.fillStyle = 'rgba(16,44,78,' + alpha + ')';
        if (this._quad(ctx, -W3.ROAD_HALF, -W3.ROAD_HALF + 0.34 + inset, NEAR_Z, W3.FAR * 0.75)) ctx.fill();
        if (this._quad(ctx, W3.ROAD_HALF - 0.34 - inset, W3.ROAD_HALF, NEAR_Z, W3.FAR * 0.75)) ctx.fill();
      }
      // Bright ice lip catching the aurora.
      ctx.globalCompositeOperation = 'lighter';
      const c = this.bg.sampleAurora(0.5);
      ctx.fillStyle = U.rgba(U.lerp(210, c[0], 0.5), U.lerp(240, c[1], 0.5), 255, 0.4);
      if (this._quad(ctx, -W3.ROAD_HALF - 0.07, -W3.ROAD_HALF + 0.05, NEAR_Z, W3.FAR * 0.6)) ctx.fill();
      if (this._quad(ctx, W3.ROAD_HALF - 0.05, W3.ROAD_HALF + 0.07, NEAR_Z, W3.FAR * 0.6)) ctx.fill();
      ctx.restore();
    }

    /* ── 4. grid + lane dashes ─────────────────────────────── */
    _grid(ctx, worldZ) {
      const cam = this.cam;
      ctx.save();

      /* transverse rungs — the primary speed read */
      const STEP = 5;
      const first = Math.ceil((worldZ + NEAR_Z) / STEP) * STEP;
      const last = worldZ + W3.FAR * 0.82;
      ctx.globalCompositeOperation = 'lighter';
      for (let zw = first; zw < last; zw += STEP) {
        const z = zw - worldZ;
        const s = cam.scaleAt(z);
        if (s <= 0) continue;
        const fade = 1 - U.clamp((z - 22) / (W3.FAR * 0.7), 0, 1);
        const a = fade * 0.2;
        if (a < 0.012) continue;
        const th = U.clamp(0.035 * s, 0.4, 5);
        ctx.fillStyle = 'rgba(196,236,255,' + a.toFixed(3) + ')';
        if (this._quad(ctx, -W3.ROAD_HALF, W3.ROAD_HALF, z, z + th / s)) ctx.fill();
      }

      /* lane dashes */
      const DASH = 4.2, GAP = 3.4, PER = DASH + GAP;
      const startK = Math.floor((worldZ + NEAR_Z) / PER);
      const endK = Math.ceil((worldZ + W3.FAR * 0.7) / PER);
      const HW = W3.LANE_W * 0.5;
      for (const ex of [-HW, HW]) {
        for (let k = startK; k <= endK; k++) {
          const z1 = k * PER - worldZ;
          const z2 = z1 + DASH;
          if (z2 < NEAR_Z) continue;
          const fade = 1 - U.clamp((z1 - 18) / (W3.FAR * 0.55), 0, 1);
          const a = fade * 0.42;
          if (a < 0.012) continue;
          const w = 0.055;
          ctx.fillStyle = 'rgba(226,248,255,' + a.toFixed(3) + ')';
          if (this._quad(ctx, ex - w, ex + w, Math.max(NEAR_Z, z1), z2)) ctx.fill();
          ctx.fillStyle = 'rgba(120,230,255,' + (a * 0.5).toFixed(3) + ')';
          if (this._quad(ctx, ex - w * 2.6, ex + w * 2.6, Math.max(NEAR_Z, z1), z2)) ctx.fill();
        }
      }
      ctx.restore();
    }

    /* ── 5. cracks + frost ─────────────────────────────────── */
    _cracks(ctx, worldZ) {
      if (this.quality < 0.45) return;
      const cam = this.cam, p = this._p;
      const SPACING = 13;
      const first = Math.floor((worldZ + 1) / SPACING);
      const last = Math.ceil((worldZ + 74) / SPACING);

      ctx.save();
      ctx.lineCap = 'round';
      for (let k = first; k <= last; k++) {
        const h = U.hash1(k * 97 + 13);
        if (h > 0.72) continue;                       // most tiles are clean ice
        const zBase = k * SPACING + U.hash1(k * 31) * SPACING - worldZ;
        if (zBase < 0.8 || zBase > 78) continue;
        const xBase = (U.hash1(k * 53 + 7) - 0.5) * W3.ROAD_HALF * 1.7;
        const fade = 1 - U.clamp((zBase - 14) / 52, 0, 1);
        if (fade <= 0.02) continue;

        const rng = U.makeRNG(k * 7919 + 17);
        const branches = 2 + ((rng() * 3) | 0);
        for (let b = 0; b < branches; b++) {
          let x = xBase, z = zBase;
          let ang = rng() * TAU;
          const segs = 3 + ((rng() * 4) | 0);
          const pts = [];
          for (let i = 0; i < segs; i++) {
            ang += (rng() - 0.5) * 1.5;
            const len = 0.28 + rng() * 0.75;
            x += Math.cos(ang) * len; z += Math.sin(ang) * len * 0.75;
            if (Math.abs(x) > W3.ROAD_HALF * 1.05 || z < 0.7) break;
            cam.project(x, 0.004, z, p);
            if (!p.visible) break;
            pts.push([p.x, p.y, p.s]);
          }
          if (pts.length < 2) continue;
          const sc = pts[0][2];
          // Dark fracture…
          ctx.strokeStyle = 'rgba(30,70,116,' + (0.4 * fade).toFixed(3) + ')';
          ctx.lineWidth = Math.max(0.4, 0.016 * sc);
          ctx.beginPath(); U.smoothLine(ctx, pts); ctx.stroke();
          // …with a lit lip beside it, which is what makes it read as 3-D.
          ctx.strokeStyle = 'rgba(216,244,255,' + (0.34 * fade).toFixed(3) + ')';
          ctx.lineWidth = Math.max(0.3, 0.007 * sc);
          ctx.save(); ctx.translate(-0.6, -0.8);
          ctx.beginPath(); U.smoothLine(ctx, pts); ctx.stroke();
          ctx.restore();
        }
      }

      /* frost speckle — tiny hashed crystals that catch the light */
      ctx.globalCompositeOperation = 'lighter';
      const n = Math.round(120 * this.quality);
      for (let i = 0; i < n; i++) {
        const zz = U.wrap(U.hash1(i * 29 + 5) * 46 - worldZ * 0.999, 46) + 1.2;
        const xx = (U.hash1(i * 43 + 11) - 0.5) * W3.ROAD_HALF * 2;
        cam.project(xx, 0.006, zz, p);
        if (!p.visible) continue;
        const r = 0.012 * p.s;
        if (r < 0.35) continue;
        const tw = 0.4 + 0.6 * Math.abs(Math.sin(this.t * 3 + i * 2.3));
        const fade = 1 - U.clamp((zz - 10) / 34, 0, 1);
        ctx.fillStyle = 'rgba(230,250,255,' + (0.5 * tw * fade).toFixed(3) + ')';
        ctx.beginPath(); ctx.arc(p.x, p.y, r, 0, TAU); ctx.fill();
      }
      ctx.restore();
    }

    /* ── 6. snow banks + drifts ────────────────────────────── */
    _banks(ctx, worldZ) {
      const cam = this.cam, p = this._p, q = this._q;
      const SEG = 6;
      const first = Math.floor((worldZ + NEAR_Z) / SEG) - 1;
      const last = Math.ceil((worldZ + 96) / SEG);

      ctx.save();
      for (const side of [-1, 1]) {
        // One continuous ribbon per side: crest line above, ice line below.
        const crest = [], foot = [];
        for (let k = first; k <= last; k++) {
          const zw = k * SEG;
          const z = zw - worldZ;
          if (z < NEAR_Z) continue;
          if (z > 96) break;
          const h = 0.5 + U.fbm1(zw * 0.055 + (side > 0 ? 31 : 0), 3) * 1.25;
          const w = W3.ROAD_HALF + 0.12 + U.noise1(zw * 0.03 + 7) * 0.5;
          cam.project(side * w, 0, z, p);
          if (!p.visible) continue;
          foot.push([p.x, p.y]);
          cam.project(side * (w + 1.5 + h * 0.7), h, z, q);
          crest.push([q.x, q.y]);
        }
        if (crest.length < 2) continue;

        // Shade the berm PER SEGMENT, crest → foot. A single screen-vertical
        // gradient over the whole ribbon made it a flat pale sheet: white
        // snow on a white field only reads as a raised bank if the face
        // turned toward the runway is in shadow. That inward slope faces away
        // from the aurora, so it goes cool and dark while the crest catches
        // the light — which is the entire cue.
        for (let i = 1; i < crest.length && i < foot.length; i++) {
          const c0 = crest[i - 1], c1 = crest[i], f0 = foot[i - 1], f1 = foot[i];
          ctx.beginPath();
          ctx.moveTo(c0[0], c0[1]);
          ctx.lineTo(c1[0], c1[1]);
          ctx.lineTo(f1[0], f1[1]);
          ctx.lineTo(f0[0], f0[1]);
          ctx.closePath();
          const mx = (c0[0] + c1[0]) * 0.5, my = (c0[1] + c1[1]) * 0.5;
          const fx = (f0[0] + f1[0]) * 0.5, fy = (f0[1] + f1[1]) * 0.5;
          const g = ctx.createLinearGradient(mx, my, fx, fy);
          g.addColorStop(0, '#fbfeff');
          g.addColorStop(0.3, '#e3f2fd');
          g.addColorStop(0.72, '#b9d5ec');
          g.addColorStop(1, '#93b6d6');
          ctx.fillStyle = g;
          ctx.fill();
          // Hairline overlap kills the seams between adjacent quads.
          ctx.strokeStyle = g;
          ctx.lineWidth = 1;
          ctx.stroke();
        }

        // Aurora rim along the crest.
        ctx.save();
        ctx.globalCompositeOperation = 'lighter';
        const rg = ctx.createLinearGradient(0, 0, cam.width, 0);
        for (let i = 0; i <= 6; i++) {
          const c = this.bg.sampleAurora(i / 6);
          rg.addColorStop(i / 6, U.rgba(c[0], c[1], c[2], c[3] * 0.5));
        }
        ctx.strokeStyle = rg;
        ctx.lineWidth = 2;
        ctx.beginPath(); U.smoothLine(ctx, crest); ctx.stroke();
        ctx.restore();

        // Shadow the bank casts onto the ice.
        ctx.beginPath();
        U.smoothLine(ctx, foot);
        for (let i = foot.length - 1; i >= 0; i--) {
          ctx.lineTo(foot[i][0] - side * 6, foot[i][1] + 1);
        }
        ctx.closePath();
        ctx.fillStyle = 'rgba(24,58,96,0.16)';
        ctx.fill();
      }
      ctx.restore();
    }

    /** Scattered drifts + wind-carved sastrugi out on the snow field. */
    _drifts(ctx, worldZ) {
      if (this.quality < 0.5) return;
      const cam = this.cam, p = this._p;
      const SEG = 9;
      const first = Math.floor(worldZ / SEG);
      const last = Math.ceil((worldZ + 120) / SEG);
      ctx.save();
      for (let k = first; k <= last; k++) {
        for (const side of [-1, 1]) {
          const h = U.hash1(k * 61 + (side > 0 ? 5003 : 1009));
          if (h > 0.55) continue;
          const z = k * SEG + U.hash1(k * 71 + side) * SEG - worldZ;
          if (z < 2 || z > 122) continue;
          const x = side * (W3.SHOULDER + 1.5 + U.hash1(k * 83 + side * 7) * 13);
          const w = 0.9 + U.hash1(k * 89 + side * 3) * 3.4;
          const hh = 0.3 + U.hash1(k * 101 + side) * 0.9;
          cam.project(x, 0, z, p);
          if (!p.visible) continue;
          const s = p.s;
          if (w * s < 1.4) continue;
          const fog = U.clamp((z - W3.FOG_START) / (W3.FAR - W3.FOG_START), 0, 1);
          const a = 1 - fog * 0.9;

          const px = p.x, py = p.y, rw = w * s, rh = hh * s;
          const g = ctx.createLinearGradient(px, py - rh, px, py);
          g.addColorStop(0, U.rgba(246, 253, 255, a));
          g.addColorStop(0.6, U.rgba(216, 238, 252, a));
          g.addColorStop(1, U.rgba(178, 208, 236, a * 0.9));
          ctx.fillStyle = g;
          ctx.beginPath();
          ctx.moveTo(px - rw, py);
          ctx.bezierCurveTo(px - rw * 0.6, py - rh * 1.5, px + rw * 0.1, py - rh * 1.35, px + rw * 0.75, py - rh * 0.35);
          ctx.bezierCurveTo(px + rw * 0.95, py - rh * 0.1, px + rw, py, px + rw, py);
          ctx.closePath();
          ctx.fill();
          // Wind-scoured lee side.
          ctx.fillStyle = U.rgba(150, 186, 220, a * 0.35);
          ctx.beginPath();
          ctx.moveTo(px + rw * 0.75, py - rh * 0.35);
          ctx.bezierCurveTo(px + rw * 0.95, py - rh * 0.1, px + rw, py, px + rw, py);
          ctx.lineTo(px + rw * 0.3, py);
          ctx.closePath();
          ctx.fill();
        }
      }
      ctx.restore();
    }

    /* ── entry ─────────────────────────────────────────────── */
    draw(ctx, worldZ) {
      this._rows(ctx, worldZ);
      this._reflections(ctx, worldZ);
      this._drifts(ctx, worldZ);
      this._banks(ctx, worldZ);
      this._edgeAO(ctx);
      this._grid(ctx, worldZ);
      this._cracks(ctx, worldZ);
    }
  }

  global.GroundRenderer = GroundRenderer;
})(window);
