/* ═══════════════════════════════════════════════════════════
   CollisionSystem — AABB overlap, but SWEPT along z.

   WHY SWEPT
   At 42 m/s a prop travels 0.7 m per frame, and a seal is only 1.6 m
   deep. A naive "is it overlapping right now?" test samples the world
   16 times per metre and will eventually miss one entirely — the
   player runs straight through a hazard, or (worse) through a fish.
   So each frame we test the SWEPT interval the prop covered:

       [z_now − halfZ, z_prev + halfZ]   vs   the player's z window

   which cannot tunnel regardless of speed or frame time.

   FORGIVENESS
   Hitboxes are deliberately smaller than the art (~85 %) and the y
   test has a small grace band. A runner should kill you for reading
   the obstacle wrong, never for a pixel you couldn't have seen.
   ═══════════════════════════════════════════════════════════ */
(function (global) {
  'use strict';

  const U = global.U;

  const FORGIVE_X = 0.86;      // hitbox shrink vs. the drawn silhouette
  const FORGIVE_Y = 0.10;      // metres of vertical grace
  const NEAR_MISS_X = 1.05;    // lateral distance that still counts as "close"

  class CollisionSystem {
    constructor() {
      this.events = [];
    }

    /**
     * @param {Player} player
     * @param {ObstacleManager} obs
     * @param {CollectibleManager} col
     * @param {number} dz  metres the world moved this frame (speed·dt)
     * @param {Object} powers  {shield, cocoa, magnet, multiplier}
     * @returns {Array} events: {kind:'hit'|'near'|'pickup', ...}
     */
    check(player, obs, col, dz, powers) {
      const ev = this.events;
      ev.length = 0;
      const pb = player.getBox();
      const invincible = powers.cocoa > 0;

      /* ── obstacles ── */
      for (let i = 0; i < obs.list.length; i++) {
        const o = obs.list[i];
        if (o.hit) continue;
        const ob = obs.getBox(o);

        // Swept z interval this prop covered during the frame.
        const zNear = ob.z - ob.halfZ;
        const zFar = ob.z + dz + ob.halfZ;
        if (zNear > pb.halfZ || zFar < -pb.halfZ) {
          continue;
        }

        // Lateral overlap (shrunken).
        const dx = Math.abs(pb.x - ob.x);
        const xHit = dx < (pb.halfW + ob.halfW * FORGIVE_X);

        if (!xHit) {
          // A clean pass close to a hazard is worth celebrating.
          if (!o.near && ob.z + dz < 0 && ob.z > -2.5 && dx < NEAR_MISS_X + ob.halfW) {
            o.near = true;
            ev.push({ kind: 'near', obstacle: o });
          }
          continue;
        }

        // Vertical overlap.
        let yHit;
        if (ob.flat) {
          // An ice hole only catches you if you're actually on the ice.
          yHit = pb.bottom <= 0.16;
        } else {
          yHit = pb.bottom < (ob.yMax - FORGIVE_Y) && pb.top > (ob.yMin + FORGIVE_Y);
        }

        if (!yHit) {
          if (!o.near) { o.near = true; ev.push({ kind: 'near', obstacle: o, cleared: true }); }
          continue;
        }

        o.hit = true;
        if (invincible) {
          ev.push({ kind: 'smash', obstacle: o });
        } else {
          ev.push({ kind: 'hit', obstacle: o, fatal: true });
          return ev;                 // one hit ends the frame's story
        }
      }

      /* ── collectibles ── */
      for (let i = 0; i < col.list.length; i++) {
        const c = col.list[i];
        if (c.taken) continue;
        const sp = col.getSpec(c.type);
        const r = sp.r + 0.30;                          // generous pickup radius

        const zNear = c.z - r, zFar = c.z + dz + r;
        if (zNear > pb.halfZ || zFar < -pb.halfZ) continue;

        if (Math.abs(pb.x - c.x) > r + pb.halfW) continue;
        // Vertical: measure from the middle of the penguin, not his feet.
        const midY = (pb.bottom + pb.top) * 0.5;
        const halfH = (pb.top - pb.bottom) * 0.5;
        if (Math.abs(midY - c.y) > r + halfH) continue;

        col.collect(c);
        ev.push({ kind: 'pickup', item: c, spec: sp });
      }

      return ev;
    }
  }

  global.CollisionSystem = CollisionSystem;
})(window);
