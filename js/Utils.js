/* ═══════════════════════════════════════════════════════════
   Utils — math, noise, colour and canvas helpers.
   Loaded first; everything else depends on it.
   ═══════════════════════════════════════════════════════════ */
(function (global) {
  'use strict';

  const TAU = Math.PI * 2;

  /* ── scalar math ─────────────────────────────────────────── */
  const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
  const lerp = (a, b, t) => a + (b - a) * t;
  const invLerp = (a, b, v) => (b === a ? 0 : (v - a) / (b - a));
  const smoothstep = (a, b, v) => { const t = clamp(invLerp(a, b, v), 0, 1); return t * t * (3 - 2 * t); };
  const smootherstep = (a, b, v) => { const t = clamp(invLerp(a, b, v), 0, 1); return t * t * t * (t * (t * 6 - 15) + 10); };

  /** Frame-rate independent exponential approach. `rate` = how much of the gap
   *  is closed per second (0..1). Guarantees identical feel at 30 or 144 Hz. */
  const damp = (a, b, rate, dt) => lerp(a, b, 1 - Math.pow(1 - rate, dt * 60));

  const wrap = (v, m) => ((v % m) + m) % m;
  const sign = (v) => (v < 0 ? -1 : v > 0 ? 1 : 0);
  const dist2 = (x1, y1, x2, y2) => { const dx = x2 - x1, dy = y2 - y1; return dx * dx + dy * dy; };

  /* ── easing ──────────────────────────────────────────────── */
  const Ease = {
    outQuad: (t) => t * (2 - t),
    inQuad: (t) => t * t,
    outCubic: (t) => 1 - Math.pow(1 - t, 3),
    inCubic: (t) => t * t * t,
    inOutCubic: (t) => (t < .5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2),
    outQuart: (t) => 1 - Math.pow(1 - t, 4),
    outExpo: (t) => (t >= 1 ? 1 : 1 - Math.pow(2, -10 * t)),
    outBack: (t) => { const c1 = 1.70158, c3 = c1 + 1; return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2); },
    outElastic: (t) => {
      if (t === 0 || t === 1) return t;
      const p = TAU / 3;
      return Math.pow(2, -10 * t) * Math.sin((t * 10 - .75) * p) + 1;
    },
    outBounce: (t) => {
      const n1 = 7.5625, d1 = 2.75;
      if (t < 1 / d1) return n1 * t * t;
      if (t < 2 / d1) return n1 * (t -= 1.5 / d1) * t + .75;
      if (t < 2.5 / d1) return n1 * (t -= 2.25 / d1) * t + .9375;
      return n1 * (t -= 2.625 / d1) * t + .984375;
    }
  };

  /* ── random ──────────────────────────────────────────────── */
  const rand = (a = 1, b) => (b === undefined ? Math.random() * a : a + Math.random() * (b - a));
  const randInt = (a, b) => Math.floor(rand(a, b + 1));
  const pick = (arr) => arr[(Math.random() * arr.length) | 0];
  const chance = (p) => Math.random() < p;

  /** Deterministic 32-bit PRNG (mulberry32). Used for scenery so mountains,
   *  cracks and drifts stay stable frame to frame without storing arrays. */
  function makeRNG(seed) {
    let a = seed >>> 0;
    return function () {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  /** Stateless hash → [0,1). Cheap "noise at integer index". */
  function hash1(n) {
    let x = Math.imul(n ^ 0x9E3779B9, 0x85EBCA6B);
    x ^= x >>> 13; x = Math.imul(x, 0xC2B2AE35); x ^= x >>> 16;
    return (x >>> 0) / 4294967296;
  }
  function hash2(x, y) { return hash1((x | 0) * 374761393 + (y | 0) * 668265263); }

  /** Smooth 1-D value noise. */
  function noise1(x) {
    const i = Math.floor(x), f = x - i;
    const u = f * f * (3 - 2 * f);
    return lerp(hash1(i), hash1(i + 1), u);
  }
  /** Fractal 1-D noise, `oct` octaves. Returns ~[0,1]. */
  function fbm1(x, oct = 4, gain = .5, lac = 2) {
    let s = 0, a = .5, n = 0;
    for (let i = 0; i < oct; i++) { s += noise1(x) * a; n += a; a *= gain; x *= lac; }
    return s / n;
  }
  /** Smooth 2-D value noise. */
  function noise2(x, y) {
    const ix = Math.floor(x), iy = Math.floor(y);
    const fx = x - ix, fy = y - iy;
    const ux = fx * fx * (3 - 2 * fx), uy = fy * fy * (3 - 2 * fy);
    const a = hash2(ix, iy), b = hash2(ix + 1, iy), c = hash2(ix, iy + 1), d = hash2(ix + 1, iy + 1);
    return lerp(lerp(a, b, ux), lerp(c, d, ux), uy);
  }

  /* ── colour ──────────────────────────────────────────────── */
  const rgb = (r, g, b) => 'rgb(' + (r | 0) + ',' + (g | 0) + ',' + (b | 0) + ')';
  const rgba = (r, g, b, a) => 'rgba(' + (r | 0) + ',' + (g | 0) + ',' + (b | 0) + ',' + (a < 0 ? 0 : a > 1 ? 1 : a).toFixed(3) + ')';

  /** Parse "#rgb" / "#rrggbb" / "rgb(...)" / "rgba(...)" → [r,g,b,a]. */
  function parseColor(c) {
    if (Array.isArray(c)) return c;
    if (c[0] === '#') {
      let h = c.slice(1);
      if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
      const n = parseInt(h, 16);
      return [(n >> 16) & 255, (n >> 8) & 255, n & 255, 1];
    }
    const m = c.match(/[-\d.]+/g);
    return m ? [+m[0], +m[1], +m[2], m[3] === undefined ? 1 : +m[3]] : [0, 0, 0, 1];
  }

  /** Linear blend between two colours. Accepts any parseable form. */
  function mix(c1, c2, t) {
    const a = parseColor(c1), b = parseColor(c2);
    return rgba(lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t), lerp(a[3], b[3], t));
  }
  function mixArr(a, b, t) {
    return [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)];
  }

  /** HSL → css rgb string. h in [0,360), s/l in [0,1]. */
  function hsl(h, s, l, a) {
    h = wrap(h, 360) / 360;
    let r, g, b;
    if (s === 0) { r = g = b = l; }
    else {
      const q = l < .5 ? l * (1 + s) : l + s - l * s;
      const p = 2 * l - q;
      const hue = (t) => {
        t = wrap(t, 1);
        if (t < 1 / 6) return p + (q - p) * 6 * t;
        if (t < 1 / 2) return q;
        if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
        return p;
      };
      r = hue(h + 1 / 3); g = hue(h); b = hue(h - 1 / 3);
    }
    return a === undefined ? rgb(r * 255, g * 255, b * 255) : rgba(r * 255, g * 255, b * 255, a);
  }

  /* ── canvas helpers ──────────────────────────────────────── */

  /** Rounded rect path (Safari-safe — does not rely on ctx.roundRect). */
  function roundRect(ctx, x, y, w, h, r) {
    const rr = Math.min(r, Math.abs(w) * .5, Math.abs(h) * .5);
    ctx.beginPath();
    ctx.moveTo(x + rr, y);
    ctx.lineTo(x + w - rr, y);
    ctx.quadraticCurveTo(x + w, y, x + w, y + rr);
    ctx.lineTo(x + w, y + h - rr);
    ctx.quadraticCurveTo(x + w, y + h, x + w - rr, y + h);
    ctx.lineTo(x + rr, y + h);
    ctx.quadraticCurveTo(x, y + h, x, y + h - rr);
    ctx.lineTo(x, y + rr);
    ctx.quadraticCurveTo(x, y, x + rr, y);
    ctx.closePath();
  }

  /** Ellipse path. */
  function ellipse(ctx, x, y, rx, ry, rot) {
    ctx.beginPath();
    ctx.ellipse(x, y, Math.abs(rx), Math.abs(ry), rot || 0, 0, TAU);
  }

  /** Closed Catmull-Rom-ish smooth polygon through points [[x,y],…]. */
  function smoothPoly(ctx, pts) {
    const n = pts.length;
    if (n < 3) return;
    ctx.beginPath();
    let mx = (pts[n - 1][0] + pts[0][0]) / 2, my = (pts[n - 1][1] + pts[0][1]) / 2;
    ctx.moveTo(mx, my);
    for (let i = 0; i < n; i++) {
      const p = pts[i], q = pts[(i + 1) % n];
      ctx.quadraticCurveTo(p[0], p[1], (p[0] + q[0]) / 2, (p[1] + q[1]) / 2);
    }
    ctx.closePath();
  }

  /** Open smooth curve through points [[x,y],…] — used for scarves, ribbons. */
  function smoothLine(ctx, pts) {
    const n = pts.length;
    if (n < 2) return;
    ctx.moveTo(pts[0][0], pts[0][1]);
    if (n === 2) { ctx.lineTo(pts[1][0], pts[1][1]); return; }
    for (let i = 1; i < n - 1; i++) {
      const p = pts[i], q = pts[i + 1];
      ctx.quadraticCurveTo(p[0], p[1], (p[0] + q[0]) / 2, (p[1] + q[1]) / 2);
    }
    ctx.lineTo(pts[n - 1][0], pts[n - 1][1]);
  }

  /** Offscreen canvas factory (with 2D ctx). */
  function makeCanvas(w, h) {
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.ceil(w));
    c.height = Math.max(1, Math.ceil(h));
    return c;
  }

  /* ── misc ────────────────────────────────────────────────── */
  function formatNum(n) {
    return Math.floor(n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  }

  /** Storage that never throws (private mode / file:// quirks). */
  const Store = {
    get(k, d) {
      try { const v = localStorage.getItem(k); return v === null ? d : JSON.parse(v); }
      catch (e) { return d; }
    },
    set(k, v) {
      try { localStorage.setItem(k, JSON.stringify(v)); return true; }
      catch (e) { return false; }
    }
  };

  /** Reusable pooled array — avoids GC churn in per-frame hot loops. */
  class Pool {
    constructor(factory, reset) { this.factory = factory; this.reset = reset; this.free = []; this.live = []; }
    spawn() {
      const o = this.free.length ? this.free.pop() : this.factory();
      this.live.push(o);
      return o;
    }
    release(i) {
      const o = this.live[i];
      this.live[i] = this.live[this.live.length - 1];
      this.live.pop();
      if (this.reset) this.reset(o);
      if (this.free.length < 2048) this.free.push(o);
    }
    clear() { while (this.live.length) this.release(this.live.length - 1); }
    get count() { return this.live.length; }
  }

  global.U = {
    TAU, clamp, lerp, invLerp, smoothstep, smootherstep, damp, wrap, sign, dist2,
    Ease, rand, randInt, pick, chance, makeRNG, hash1, hash2, noise1, fbm1, noise2,
    rgb, rgba, parseColor, mix, mixArr, hsl,
    roundRect, ellipse, smoothPoly, smoothLine, makeCanvas,
    formatNum, Store, Pool
  };
})(window);
