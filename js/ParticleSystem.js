/* ═══════════════════════════════════════════════════════════
   ParticleSystem — every particle lives in WORLD space and is
   projected like any prop, so a spark thrown at the penguin's feet
   shrinks correctly as it drifts away. Nothing here is a sprite.

   Two batches:
     • SOLID   — snow, dust, shards, plumes   (source-over)
     • ADDITIVE— sparks, glow, trails, streaks (lighter)
   Each batch draws far→near. Additive last so light sits on top.

   Ambient snowfall is a separate persistent field that wraps around
   the camera volume — recycling flakes instead of spawning them keeps
   allocation at zero in the steady state.
   ═══════════════════════════════════════════════════════════ */
(function (global) {
  'use strict';

  const U = global.U;
  const TAU = U.TAU;

  // Kinds → { additive, draw }
  const SNOW = 0, DUST = 1, SHARD = 2, SPARK = 3, GLOW = 4, TRAIL = 5,
        STREAK = 6, PLUME = 7, RING = 8, CONFETTI = 9, BUBBLE = 10;

  const ADDITIVE = { 3: 1, 4: 1, 5: 1, 6: 1, 8: 1, 10: 1 };

  function newP() {
    return {
      x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0,
      life: 0, max: 1, size: 1, size2: 0,
      kind: SNOW, r: 255, g: 255, b: 255, a: 1,
      rot: 0, spin: 0, grav: 0, drag: 0, sway: 0, phase: 0, fade: 1
    };
  }

  class ParticleSystem {
    constructor(camera) {
      this.cam = camera;
      this.pool = new U.Pool(newP);
      this.snow = [];
      this.snowCount = 0;
      this._p = { x: 0, y: 0, s: 0, visible: false };
      this._t = 0;
      this.quality = 1;      // scaled down by the perf governor
      this.windX = 0;
      // Biome dial. The flake pool is allocated once at the blizzard maximum;
      // calmer weather simply draws (and simulates the fall of) fewer flakes.
      this.snowMul = 0.68;
    }

    /* ── ambient snowfall ──────────────────────────────────── */
    initSnow(n) {
      this.snowCount = n;
      this.snow.length = 0;
      for (let i = 0; i < n; i++) this.snow.push(this._newFlake(true));
    }

    _newFlake(anywhere) {
      const cam = this.cam;
      return {
        x: U.rand(-22, 22),
        y: anywhere ? U.rand(0, 17) : U.rand(11, 18),
        z: cam.z + U.rand(1, 78),
        size: U.rand(0.012, 0.055),
        vy: -U.rand(1.1, 3.4),
        sway: U.rand(0.3, 1.5),
        phase: U.rand(0, TAU),
        spin: U.rand(0.4, 1.6),
        depth: U.rand(0.4, 1)          // parallax weight, also brightness
      };
    }

    updateSnow(dt, worldSpeed) {
      const cam = this.cam;
      const arr = this.snow;
      for (let i = 0; i < arr.length; i++) {
        const f = arr[i];
        f.z -= worldSpeed * dt * (0.55 + f.depth * 0.5);
        f.y += f.vy * dt;
        f.phase += dt * f.spin;
        f.x += (Math.sin(f.phase) * f.sway + this.windX * 1.4) * dt;

        if (f.y < -0.4 || f.z < cam.z + 0.9 || Math.abs(f.x - cam.x) > 26) {
          const nf = this._newFlake(false);
          nf.z = cam.z + U.rand(58, 84);
          nf.x = cam.x + U.rand(-22, 22);
          arr[i] = nf;
        }
      }
    }

    drawSnow(ctx) {
      const cam = this.cam, p = this._p;
      const n = Math.min(this.snow.length,
        Math.floor(this.snow.length * this.quality * U.clamp(this.snowMul, 0, 1)));
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      for (let i = 0; i < n; i++) {
        const f = this.snow[i];
        cam.project(f.x, f.y, f.z, p);
        if (!p.visible) continue;
        const r = f.size * p.s;
        if (r < 0.35 || p.x < -30 || p.x > cam.width + 30 || p.y < -30 || p.y > cam.height + 30) continue;
        const near = U.clamp((f.z - cam.z) / 34, 0, 1);
        const a = (0.30 + f.depth * 0.5) * (1 - near * 0.55);
        if (r > 2.2) {
          // Close flakes get a soft halo — reads as shallow depth of field.
          const grd = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, r * 2.4);
          grd.addColorStop(0, 'rgba(255,255,255,' + (a * 0.95).toFixed(3) + ')');
          grd.addColorStop(0.42, 'rgba(214,241,255,' + (a * 0.42).toFixed(3) + ')');
          grd.addColorStop(1, 'rgba(180,225,255,0)');
          ctx.fillStyle = grd;
          ctx.beginPath(); ctx.arc(p.x, p.y, r * 2.4, 0, TAU); ctx.fill();
        } else {
          ctx.fillStyle = 'rgba(238,250,255,' + a.toFixed(3) + ')';
          ctx.beginPath(); ctx.arc(p.x, p.y, r, 0, TAU); ctx.fill();
        }
      }
      ctx.restore();
    }

    /* ── generic emitter ───────────────────────────────────── */
    emit(kind, x, y, z, opt) {
      if (this.pool.count > 1400) return null;
      const p = this.pool.spawn();
      const o = opt || {};
      p.kind = kind;
      p.x = x; p.y = y; p.z = z;
      p.vx = o.vx || 0; p.vy = o.vy || 0; p.vz = o.vz || 0;
      p.max = p.life = o.life || 0.6;
      p.size = o.size || 0.1;
      p.size2 = o.size2 || 0;
      p.r = o.r === undefined ? 255 : o.r;
      p.g = o.g === undefined ? 255 : o.g;
      p.b = o.b === undefined ? 255 : o.b;
      p.a = o.a === undefined ? 1 : o.a;
      p.rot = o.rot || 0;
      p.spin = o.spin || 0;
      p.grav = o.grav === undefined ? 0 : o.grav;
      p.drag = o.drag === undefined ? 0.6 : o.drag;
      p.fade = o.fade === undefined ? 1 : o.fade;
      p.phase = U.rand(0, TAU);
      return p;
    }

    /* ── presets ───────────────────────────────────────────── */

    /** Snow kicked up by feet. Heavy, short-lived, tumbles. */
    footPuff(x, z, power) {
      const n = Math.round(U.lerp(2, 7, power) * this.quality);
      for (let i = 0; i < n; i++) {
        this.emit(DUST, x + U.rand(-.18, .18), U.rand(0.02, 0.14), z + U.rand(-.16, .16), {
          vx: U.rand(-1.1, 1.1), vy: U.rand(0.5, 2.6) * power, vz: U.rand(-2.4, -0.3),
          life: U.rand(0.28, 0.62), size: U.rand(0.05, 0.15) * (0.7 + power),
          r: 240, g: 250, b: 255, a: U.rand(0.35, 0.7), grav: -5.2, drag: 1.9
        });
      }
    }

    /** Big landing impact: ring shockwave + snow plume + ice chips. */
    landBurst(x, z, power) {
      const q = this.quality;
      this.emit(RING, x, 0.03, z, {
        life: 0.42, size: 0.15, size2: 1.5 + power * 1.5,
        r: 210, g: 244, b: 255, a: 0.5 * power
      });
      const n = Math.round(U.lerp(6, 22, power) * q);
      for (let i = 0; i < n; i++) {
        const a = U.rand(0, TAU), sp = U.rand(1.2, 4.6) * (0.6 + power);
        this.emit(PLUME, x, 0.05, z, {
          vx: Math.cos(a) * sp, vy: U.rand(1.4, 4.2) * power, vz: Math.sin(a) * sp * 0.75,
          life: U.rand(0.4, 0.95), size: U.rand(0.09, 0.26) * (0.7 + power),
          r: 244, g: 252, b: 255, a: U.rand(0.4, 0.8), grav: -7.5, drag: 1.5
        });
      }
      const m = Math.round(5 * power * q);
      for (let i = 0; i < m; i++) {
        const a = U.rand(0, TAU), sp = U.rand(2, 6);
        this.emit(SHARD, x, 0.08, z, {
          vx: Math.cos(a) * sp, vy: U.rand(2, 6), vz: Math.sin(a) * sp * 0.7,
          life: U.rand(0.4, 0.8), size: U.rand(0.03, 0.09),
          r: 190, g: 235, b: 255, a: 0.85, grav: -24, drag: 0.3, spin: U.rand(-14, 14)
        });
      }
    }

    /** Continuous spray while sliding. */
    slideSpray(x, z, speed01) {
      const n = Math.round(3 * this.quality);
      for (let i = 0; i < n; i++) {
        this.emit(DUST, x + U.rand(-.3, .3), U.rand(0.02, 0.2), z + U.rand(-.2, .2), {
          vx: U.rand(-2.4, 2.4), vy: U.rand(0.9, 3.2), vz: U.rand(-5, -1.5) * (0.5 + speed01),
          life: U.rand(0.3, 0.7), size: U.rand(0.05, 0.16),
          r: 236, g: 248, b: 255, a: U.rand(0.3, 0.66), grav: -6, drag: 1.6
        });
      }
      if (U.chance(0.4 * this.quality)) {
        this.emit(SPARK, x + U.rand(-.3, .3), 0.06, z, {
          vx: U.rand(-1.5, 1.5), vy: U.rand(0.4, 1.8), vz: U.rand(-4, -1),
          life: U.rand(0.18, 0.4), size: U.rand(0.015, 0.045),
          r: 190, g: 240, b: 255, a: 0.9, grav: -8, drag: 0.9
        });
      }
    }

    /** Collectible pickup — colour-keyed starburst plus a light ring. */
    pickupBurst(x, y, z, col, big) {
      const q = this.quality;
      const n = Math.round((big ? 26 : 13) * q);
      for (let i = 0; i < n; i++) {
        const a = U.rand(0, TAU), e = U.rand(-0.5, 1), sp = U.rand(1.6, big ? 7.5 : 4.6);
        this.emit(SPARK, x, y, z, {
          vx: Math.cos(a) * sp, vy: e * sp * 0.9 + 1.1, vz: Math.sin(a) * sp * 0.7,
          life: U.rand(0.32, big ? 0.95 : 0.6), size: U.rand(0.018, big ? 0.075 : 0.05),
          r: col[0], g: col[1], b: col[2], a: 1, grav: -5, drag: 1.25
        });
      }
      this.emit(RING, x, y, z, {
        life: big ? 0.5 : 0.34, size: 0.08, size2: big ? 1.9 : 0.95,
        r: col[0], g: col[1], b: col[2], a: big ? 0.8 : 0.55
      });
      this.emit(GLOW, x, y, z, {
        life: big ? 0.45 : 0.28, size: big ? 0.85 : 0.5, size2: -0.7,
        r: col[0], g: col[1], b: col[2], a: 0.75
      });
    }

    /** Aurora motes — slow, weightless, drifting up the sky column. */
    auroraMote(x, y, z, hue) {
      const c = U.parseColor(U.hsl(hue, 0.8, 0.65));
      this.emit(GLOW, x, y, z, {
        vx: U.rand(-.2, .2), vy: U.rand(0.25, 0.9), vz: U.rand(-.3, .3),
        life: U.rand(1.6, 3.4), size: U.rand(0.05, 0.16), size2: 0.1,
        r: c[0], g: c[1], b: c[2], a: U.rand(0.35, 0.75), grav: 0, drag: 0.15
      });
    }

    /** Shield absorbed a hit. */
    shieldShatter(x, y, z) {
      const q = this.quality;
      this.emit(RING, x, y, z, { life: 0.5, size: 0.4, size2: 3.4, r: 120, g: 220, b: 255, a: 0.9 });
      const n = Math.round(30 * q);
      for (let i = 0; i < n; i++) {
        const a = U.rand(0, TAU), e = U.rand(-1, 1), sp = U.rand(3, 9);
        this.emit(SHARD, x, y, z, {
          vx: Math.cos(a) * sp, vy: e * sp * 0.6 + 1, vz: Math.sin(a) * sp * 0.6,
          life: U.rand(0.5, 1.1), size: U.rand(0.05, 0.13),
          r: 150, g: 230, b: 255, a: 0.95, grav: -16, drag: 0.4, spin: U.rand(-12, 12)
        });
      }
    }

    /** Crash — dark snow, ice chips, a wide plume. */
    crash(x, y, z) {
      const q = this.quality;
      this.emit(RING, x, 0.05, z, { life: 0.55, size: 0.2, size2: 4.2, r: 255, g: 220, b: 200, a: 0.7 });
      const n = Math.round(40 * q);
      for (let i = 0; i < n; i++) {
        const a = U.rand(0, TAU), sp = U.rand(2, 9);
        this.emit(PLUME, x, U.rand(0, 0.5), z, {
          vx: Math.cos(a) * sp, vy: U.rand(2, 8), vz: Math.sin(a) * sp * 0.7,
          life: U.rand(0.6, 1.5), size: U.rand(0.1, 0.4),
          r: 246, g: 252, b: 255, a: U.rand(0.4, 0.85), grav: -8, drag: 1.2
        });
      }
      const m = Math.round(20 * q);
      for (let i = 0; i < m; i++) {
        const a = U.rand(0, TAU), sp = U.rand(3, 11);
        this.emit(SHARD, x, U.rand(0.1, 0.7), z, {
          vx: Math.cos(a) * sp, vy: U.rand(3, 9), vz: Math.sin(a) * sp * 0.6,
          life: U.rand(0.6, 1.3), size: U.rand(0.04, 0.12),
          r: 200, g: 238, b: 255, a: 0.9, grav: -26, drag: 0.25, spin: U.rand(-16, 16)
        });
      }
    }

    /** Splash for ice-hole plunges. */
    splash(x, z) {
      const q = this.quality;
      this.emit(RING, x, 0.02, z, { life: 0.7, size: 0.3, size2: 3.0, r: 120, g: 200, b: 240, a: 0.75 });
      const n = Math.round(34 * q);
      for (let i = 0; i < n; i++) {
        const a = U.rand(0, TAU), sp = U.rand(1, 5);
        this.emit(BUBBLE, x, 0.05, z, {
          vx: Math.cos(a) * sp, vy: U.rand(3, 9), vz: Math.sin(a) * sp * 0.7,
          life: U.rand(0.5, 1.2), size: U.rand(0.03, 0.11),
          r: 150, g: 220, b: 255, a: 0.85, grav: -22, drag: 0.5
        });
      }
    }

    /** Speed streaks — long additive dashes hurtling past the lens. */
    speedStreak(camX, camZ) {
      const a = U.rand(0, TAU), rad = U.rand(2.2, 9);
      this.emit(STREAK, camX + Math.cos(a) * rad, 1.4 + Math.sin(a) * rad * 0.55, camZ + U.rand(24, 46), {
        vz: -U.rand(30, 52), life: U.rand(0.32, 0.6), size: U.rand(0.012, 0.035),
        r: 214, g: 244, b: 255, a: U.rand(0.25, 0.6), drag: 0
      });
    }

    /** Motion trail behind the penguin during a boost. */
    trail(x, y, z, col) {
      this.emit(TRAIL, x + U.rand(-.16, .16), y + U.rand(0, .5), z + U.rand(-.1, .1), {
        vy: U.rand(0.1, 0.7), vz: U.rand(-3, -1),
        life: U.rand(0.24, 0.5), size: U.rand(0.08, 0.2), size2: -0.14,
        r: col[0], g: col[1], b: col[2], a: 0.55, drag: 1.1
      });
    }

    confetti(x, y, z) {
      const q = this.quality;
      const cols = [[255, 209, 102], [79, 240, 208], [255, 126, 196], [169, 123, 255], [108, 245, 155]];
      const n = Math.round(44 * q);
      for (let i = 0; i < n; i++) {
        const c = U.pick(cols);
        const a = U.rand(0, TAU), sp = U.rand(2, 7);
        this.emit(CONFETTI, x, y, z, {
          vx: Math.cos(a) * sp, vy: U.rand(4, 10), vz: Math.sin(a) * sp * 0.6,
          life: U.rand(1.1, 2.2), size: U.rand(0.05, 0.11),
          r: c[0], g: c[1], b: c[2], a: 1, grav: -13, drag: 0.7, spin: U.rand(-16, 16)
        });
      }
    }

    /* ── sim ───────────────────────────────────────────────── */
    update(dt, worldSpeed) {
      this._t += dt;
      const live = this.pool.live;
      for (let i = live.length - 1; i >= 0; i--) {
        const p = live[i];
        p.life -= dt;
        if (p.life <= 0) { this.pool.release(i); continue; }

        // World flows toward the camera; every particle rides it.
        p.z -= worldSpeed * dt;

        p.vy += p.grav * dt;
        if (p.drag) {
          const d = Math.max(0, 1 - p.drag * dt);
          p.vx *= d; p.vy *= d; p.vz *= d;
        }
        p.x += p.vx * dt; p.y += p.vy * dt; p.z += p.vz * dt;
        p.rot += p.spin * dt;

        // Bounce chips and confetti once off the ice — costs nothing, sells weight.
        if (p.y < 0 && (p.kind === SHARD || p.kind === CONFETTI) && p.vy < 0) {
          p.y = 0; p.vy *= -0.34; p.vx *= 0.6; p.vz *= 0.6;
          if (Math.abs(p.vy) < 0.4) p.vy = 0;
        }
        if (p.z < this.cam.z - 2) this.pool.release(i);
      }
    }

    /* ── draw ──────────────────────────────────────────────── */
    draw(ctx) {
      const live = this.pool.live;
      if (!live.length) return;
      const cam = this.cam, p = this._p;

      // Depth sort: far first. Insertion-sort friendly (mostly-sorted list).
      live.sort((a, b) => b.z - a.z);

      ctx.save();
      let additive = false;
      ctx.globalCompositeOperation = 'source-over';

      for (let i = 0; i < live.length; i++) {
        const q = live[i];
        cam.project(q.x, q.y, q.z, p);
        if (!p.visible) continue;
        if (p.x < -140 || p.x > cam.width + 140 || p.y < -140 || p.y > cam.height + 140) continue;

        const t = q.life / q.max;
        const wantAdd = !!ADDITIVE[q.kind];
        if (wantAdd !== additive) {
          additive = wantAdd;
          ctx.globalCompositeOperation = additive ? 'lighter' : 'source-over';
        }
        this._drawOne(ctx, q, p, t);
      }
      ctx.restore();
    }

    _drawOne(ctx, q, p, t) {
      const fade = Math.pow(t, q.fade);
      const a = q.a * fade;
      if (a <= 0.004) return;
      const R = q.r | 0, G = q.g | 0, B = q.b | 0;

      switch (q.kind) {
        case DUST:
        case PLUME: {
          // Snow puff: grows as it dissipates, softest at the rim.
          const grow = 1 + (1 - t) * (q.kind === PLUME ? 1.5 : 0.9);
          const r = q.size * grow * p.s;
          if (r < 0.4) return;
          const grd = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, r);
          grd.addColorStop(0, U.rgba(R, G, B, a * 0.9));
          grd.addColorStop(0.55, U.rgba(R - 10, G - 4, B, a * 0.42));
          grd.addColorStop(1, U.rgba(R - 30, G - 14, B, 0));
          ctx.fillStyle = grd;
          ctx.beginPath(); ctx.arc(p.x, p.y, r, 0, TAU); ctx.fill();
          break;
        }
        case SHARD: {
          const r = q.size * p.s;
          if (r < 0.35) return;
          ctx.save();
          ctx.translate(p.x, p.y); ctx.rotate(q.rot);
          ctx.fillStyle = U.rgba(R, G, B, a);
          ctx.beginPath();
          ctx.moveTo(0, -r * 1.5); ctx.lineTo(r * 0.75, 0); ctx.lineTo(0, r * 1.2); ctx.lineTo(-r * 0.62, 0);
          ctx.closePath(); ctx.fill();
          ctx.fillStyle = U.rgba(255, 255, 255, a * 0.65);
          ctx.beginPath();
          ctx.moveTo(0, -r * 1.5); ctx.lineTo(r * 0.75, 0); ctx.lineTo(0, 0);
          ctx.closePath(); ctx.fill();
          ctx.restore();
          break;
        }
        case CONFETTI: {
          const r = q.size * p.s;
          if (r < 0.35) return;
          ctx.save();
          ctx.translate(p.x, p.y); ctx.rotate(q.rot);
          // Fake the flip by squashing on a sine — reads as a spinning chip.
          const sq = Math.abs(Math.cos(q.rot * 1.7 + q.phase));
          ctx.fillStyle = U.rgba(R * (0.55 + sq * 0.45), G * (0.55 + sq * 0.45), B * (0.55 + sq * 0.45), a);
          ctx.fillRect(-r, -r * 0.55 * sq - 0.4, r * 2, r * 1.1 * sq + 0.8);
          ctx.restore();
          break;
        }
        case SPARK: {
          const r = q.size * p.s;
          if (r < 0.25) return;
          const grd = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, r * 3.2);
          grd.addColorStop(0, U.rgba(255, 255, 255, a));
          grd.addColorStop(0.28, U.rgba(R, G, B, a * 0.85));
          grd.addColorStop(1, U.rgba(R, G, B, 0));
          ctx.fillStyle = grd;
          ctx.beginPath(); ctx.arc(p.x, p.y, r * 3.2, 0, TAU); ctx.fill();
          break;
        }
        case GLOW:
        case TRAIL: {
          const grow = q.size + (q.size2 || 0) * (1 - t);
          const r = Math.max(0.01, grow) * p.s;
          if (r < 0.4) return;
          const grd = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, r);
          grd.addColorStop(0, U.rgba(R, G, B, a * 0.8));
          grd.addColorStop(0.5, U.rgba(R, G, B, a * 0.28));
          grd.addColorStop(1, U.rgba(R, G, B, 0));
          ctx.fillStyle = grd;
          ctx.beginPath(); ctx.arc(p.x, p.y, r, 0, TAU); ctx.fill();
          break;
        }
        case RING: {
          // Expanding shockwave, thinning as it grows.
          const rr = U.lerp(q.size, q.size + q.size2, 1 - t) * p.s;
          if (rr < 1) return;
          ctx.strokeStyle = U.rgba(R, G, B, a * 0.85);
          ctx.lineWidth = Math.max(0.5, (1 - Math.pow(1 - t, 2)) * 0.09 * p.s);
          ctx.beginPath();
          ctx.ellipse(p.x, p.y, rr, rr * 0.32, 0, 0, TAU);   // flattened = lies on the ice
          ctx.stroke();
          break;
        }
        case STREAK: {
          const len = Math.abs(q.vz) * 0.026 * p.s;
          const w = Math.max(0.5, q.size * p.s);
          ctx.strokeStyle = U.rgba(R, G, B, a * 0.7);
          ctx.lineWidth = w;
          ctx.lineCap = 'round';
          ctx.beginPath();
          ctx.moveTo(p.x, p.y);
          // Streaks rush outward from the vanishing point.
          const dx = p.x - this.cam.width * 0.5, dy = p.y - this.cam.horizon;
          const m = Math.hypot(dx, dy) || 1;
          ctx.lineTo(p.x + (dx / m) * len, p.y + (dy / m) * len);
          ctx.stroke();
          break;
        }
        case BUBBLE: {
          const r = q.size * p.s;
          if (r < 0.4) return;
          ctx.strokeStyle = U.rgba(R, G, B, a * 0.9);
          ctx.lineWidth = Math.max(0.4, r * 0.22);
          ctx.beginPath(); ctx.arc(p.x, p.y, r, 0, TAU); ctx.stroke();
          ctx.fillStyle = U.rgba(255, 255, 255, a * 0.35);
          ctx.beginPath(); ctx.arc(p.x - r * 0.3, p.y - r * 0.3, r * 0.3, 0, TAU); ctx.fill();
          break;
        }
      }
    }

    clear() { this.pool.clear(); }
    get count() { return this.pool.count + this.snow.length; }
  }

  ParticleSystem.SNOW = SNOW; ParticleSystem.DUST = DUST; ParticleSystem.SHARD = SHARD;
  ParticleSystem.SPARK = SPARK; ParticleSystem.GLOW = GLOW; ParticleSystem.TRAIL = TRAIL;
  ParticleSystem.STREAK = STREAK; ParticleSystem.PLUME = PLUME; ParticleSystem.RING = RING;
  ParticleSystem.CONFETTI = CONFETTI; ParticleSystem.BUBBLE = BUBBLE;

  global.ParticleSystem = ParticleSystem;
})(window);
