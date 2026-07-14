/* ═══════════════════════════════════════════════════════════
   Camera — the pseudo-3D projection everything else speaks.

   WORLD SPACE
     x : lateral, metres. 0 = centre lane. +x = right.
     y : up, metres. 0 = ice surface.
     z : forward, metres, RELATIVE TO THE PLAYER.
         The player sits at z = 0 forever; the world flows toward
         −z as `Game.worldZ` (total distance run) increases.
         An object spawned at absolute distance `z0` is drawn at
         z = z0 − worldZ.

   SCREEN SPACE
     A classic third-person chase rig: the camera hangs behind and
     above the penguin looking down the runway. Projection is a
     pinhole:  scale = focal / depth,  so anything approaching the
     camera grows hyperbolically — that is what sells the depth.

   The single most useful trick here is `zAtScreenY()`: because the
   ice is a flat plane at y = 0, every screen ROW maps to exactly one
   world depth. GroundRenderer walks rows top→bottom and gets perfect
   perspective texturing for free, with no polygons at all.
   ═══════════════════════════════════════════════════════════ */
(function (global) {
  'use strict';

  const U = global.U;

  /* Runway metrics — shared by ground, obstacles, collectibles, player. */
  const WORLD = {
    LANE_W: 2.35,          // lane pitch in metres
    LANES: [-2.35, 0, 2.35],
    ROAD_HALF: 3.62,       // ice edge (slightly wider than the outer lanes)
    SHOULDER: 5.4,         // where the snow bank crests
    FAR: 235,              // draw distance, metres
    FOG_START: 55,
    SPAWN_Z: 205,          // where new props are seeded
    GRAVITY: -46,          // m/s²  (arcade-heavy, snappy jumps)
    HORIZON_F: 0.455       // horizon line as a fraction of canvas height
  };

  class Camera {
    constructor() {
      // Rig distance is a framing decision, not a physical one: it sets how
      // large the penguin reads. At −8.6 he was ~14 % of screen height and
      // all the facial work was invisible; −7.5 puts him near 17 % without
      // losing meaningful runway ahead.
      this.x = 0;            // lateral position (lags the player)
      this.y = 3.02;         // eye height above the ice
      this.z = -7.5;         // sits behind the penguin (player is at z=0)

      this.baseY = 3.02;
      this.baseZ = -7.5;

      this.width = 0; this.height = 0; this.dpr = 1;
      this.focal = 800;      // pixels; derived from height + FOV kick
      this.baseFocal = 800;
      this.horizon = 0;      // effective horizon in px (base + pitch)
      this.baseHorizon = 0;

      this.pitch = 0;        // px offset of the horizon (nose up/down)
      this.roll = 0;         // radians, applied by Renderer as a canvas rotate
      this.fovKick = 0;      // 0..1 — widens the lens as speed rises

      // trauma-based shake (Jan Schneider's model): shake ∝ trauma²
      this.trauma = 0;
      this.shakeX = 0; this.shakeY = 0; this.shakeR = 0;
      this._st = 0;

      this._p = { x: 0, y: 0, s: 0, visible: false };
    }

    resize(w, h, dpr) {
      this.width = w; this.height = h; this.dpr = dpr || 1;
      // Focal is driven by height so vertical framing is identical on any
      // aspect — ultra-wide screens simply see more to the sides.
      //
      // But height ALONE breaks portrait: on a 390×844 phone, h·1.02 = 861 px
      // of focal puts the 7 m runway at ~830 px across a 390 px screen. The
      // lanes fall off both edges and the game is unplayable. So the width
      // also gets a vote, and the tighter of the two wins. 1.45·w lets the
      // ice EDGES bleed off-frame in portrait (which reads fine — runners do
      // this) while keeping all three lane centres comfortably on screen.
      this.baseFocal = Math.min(h * 1.02, w * 1.45);
      this.baseHorizon = h * WORLD.HORIZON_F;
      this.horizon = this.baseHorizon;
      this.focal = this.baseFocal;
    }

    /* ── projection ─────────────────────────────────────────── */

    /**
     * World → screen. Writes into a shared scratch object; copy out if you
     * need to keep it. `s` is the pixels-per-metre scale at that depth.
     */
    project(x, y, z, out) {
      const o = out || this._p;
      const depth = z - this.z;
      if (depth <= 0.4) { o.visible = false; o.s = 0; return o; }
      const s = this.focal / depth;
      o.x = this.width * 0.5 + (x - this.x) * s;
      o.y = this.horizon + (this.y - y) * s;
      o.s = s;
      o.visible = true;
      return o;
    }

    /** Scale (px per metre) at a given world depth — cheaper than a project. */
    scaleAt(z) {
      const depth = z - this.z;
      return depth <= 0.4 ? 0 : this.focal / depth;
    }

    /** Inverse of the ground projection: screen row → world z on the y=0 plane. */
    zAtScreenY(sy) {
      const d = sy - this.horizon;
      if (d <= 0.35) return Infinity;
      return this.z + (this.focal * this.y) / d;
    }

    /** Screen row at which a given depth meets the ice — the row loop's bound. */
    screenYAtZ(z) {
      const depth = z - this.z;
      if (depth <= 0.4) return this.height * 2;
      return this.horizon + (this.y * this.focal) / depth;
    }

    /* ── feel ───────────────────────────────────────────────── */

    /** Add camera trauma (0..1). Impacts, landings, near misses. */
    addTrauma(t) { this.trauma = U.clamp(this.trauma + t, 0, 1); }

    /**
     * @param {number} dt
     * @param {Object} target  {x, y, speed01, roll}
     */
    update(dt, target) {
      // Lateral follow: deliberately loose so lane changes read as motion.
      this.x = U.damp(this.x, target.x * 0.72, 0.14, dt);

      // Rise a little with the penguin so big jumps stay framed, and pull
      // back slightly at speed for a widening-runway sensation.
      const wantY = this.baseY + target.y * 0.34;
      const wantZ = this.baseZ - target.speed01 * 1.15;
      this.y = U.damp(this.y, wantY, 0.10, dt);
      this.z = U.damp(this.z, wantZ, 0.06, dt);

      // FOV kick: shorter focal = wider lens = things streak past faster.
      this.fovKick = U.damp(this.fovKick, target.speed01, 0.05, dt);
      this.focal = this.baseFocal * (1 - this.fovKick * 0.085);

      // Nose bobs down when airborne (we look "over" the runway) and the
      // horizon lifts on landing — cheap, very effective weight cue.
      const wantPitch = -target.y * 6 + target.pitchBias * this.height * 0.012;
      this.pitch = U.damp(this.pitch, wantPitch, 0.12, dt);

      this.roll = U.damp(this.roll, target.roll || 0, 0.11, dt);

      // Shake — trauma² gives a punchy attack and a soft, natural tail.
      this.trauma = Math.max(0, this.trauma - dt * 1.15);
      const sh = this.trauma * this.trauma;
      this._st += dt * 34;
      const amp = sh * this.height * 0.028;
      this.shakeX = (U.noise1(this._st) * 2 - 1) * amp;
      this.shakeY = (U.noise1(this._st + 41.7) * 2 - 1) * amp;
      this.shakeR = (U.noise1(this._st + 93.1) * 2 - 1) * sh * 0.028;

      this.horizon = this.baseHorizon + this.pitch + this.shakeY * 0.55;
    }

    reset() {
      this.x = 0; this.y = this.baseY; this.z = this.baseZ;
      this.pitch = 0; this.roll = 0; this.fovKick = 0; this.trauma = 0;
      this.shakeX = this.shakeY = this.shakeR = 0;
      this.horizon = this.baseHorizon;
      this.focal = this.baseFocal;
    }
  }

  global.WORLD = WORLD;
  global.Camera = Camera;
})(window);
