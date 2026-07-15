/* ═══════════════════════════════════════════════════════════
   Biomes — the weather schedule. Pure data + a mixer.

   The runway cycles through four moods keyed by distance. Each biome
   is a parameter set; `Biomes.at(dist)` returns a smoothly blended mix
   so transitions are gradients, never pops. Game applies the mix to
   the renderer, particles, audio and spawners once per frame.

   FAIRNESS RULE: weather may change how the world FEELS, never how
   much time you get. Anything that reduces legibility (blizzard) must
   pay for it in `thinkMul` — the obstacle spacing budget widens to
   compensate. This is enforced here in data so no renderer change can
   quietly break it.
   ═══════════════════════════════════════════════════════════ */
(function (global) {
  'use strict';

  const U = global.U;

  //                 aurora snow  wind  cloud moon  fish  cryst think
  const BIOMES = [
    { key: 'aurora',   name: 'AURORA NIGHT',  len: 750,
      p: { aurora: 1.00, snow: 0.68, wind: 1.0, cloud: 1.0, moon: 1.0, fish: 1.0, crystal: 1.0, think: 1.00 } },
    { key: 'blizzard', name: 'BLIZZARD',      len: 520,
      p: { aurora: 0.45, snow: 1.65, wind: 2.2, cloud: 1.8, moon: 0.55, fish: 1.0, crystal: 0.7, think: 1.15 } },
    { key: 'moonglow', name: 'MOONGLOW CALM', len: 520,
      p: { aurora: 0.30, snow: 0.30, wind: 0.5, cloud: 0.5, moon: 1.8, fish: 1.15, crystal: 1.2, think: 1.00 } },
    { key: 'storm',    name: 'AURORA STORM',  len: 480,
      p: { aurora: 1.45, snow: 0.55, wind: 1.4, cloud: 0.8, moon: 0.8, fish: 1.6, crystal: 3.0, think: 1.00 } }
  ];

  const BLEND = 90;      // metres over which one biome fades into the next
  const CYCLE = BIOMES.reduce((s, b) => s + b.len, 0);

  const Biomes = {
    LIST: BIOMES,

    /** Which biome owns absolute distance d, plus progress inside it. */
    _segment(d) {
      let t = U.wrap(d, CYCLE);
      for (let i = 0; i < BIOMES.length; i++) {
        if (t < BIOMES[i].len) return { i, into: t };
        t -= BIOMES[i].len;
      }
      return { i: 0, into: 0 };
    },

    /**
     * Blended parameters at distance d. Near a boundary the two biomes
     * crossfade over BLEND metres; elsewhere it's the owner verbatim.
     * @returns {{key,name,p:Object,fresh:boolean}} `fresh` = just entered.
     */
    at(d) {
      const seg = this._segment(Math.max(0, d));
      const cur = BIOMES[seg.i];
      const nxt = BIOMES[(seg.i + 1) % BIOMES.length];
      const untilEnd = cur.len - seg.into;

      let mix = 0;
      if (untilEnd < BLEND) mix = 1 - untilEnd / BLEND;   // fading into next

      const p = {};
      for (const k in cur.p) p[k] = U.lerp(cur.p[k], nxt.p[k], mix);

      // The label flips at the midpoint of the blend, which is where the
      // sky visibly commits to the new mood.
      const label = mix > 0.5 ? nxt : cur;
      return { key: label.key, name: label.name, p };
    }
  };

  global.Biomes = Biomes;
})(window);
