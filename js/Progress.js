/* ═══════════════════════════════════════════════════════════
   Progress — the ONE persistent layer. Fish bank, wardrobe,
   missions, run history, lifetime stats, daily bests.

   Everything the player keeps between runs lives in a single
   versioned localStorage document, written through save() at a
   handful of explicit points (run end, purchase, mission complete)
   rather than per-frame. If storage is unavailable the game still
   plays — you just live in the moment.

   Design rule for the economy: fish are EARNED in runs and SPENT in
   exactly three places — wardrobe, revives, and nothing else. Every
   mission pays fish so the loops feed each other.
   ═══════════════════════════════════════════════════════════ */
(function (global) {
  'use strict';

  const U = global.U;
  const KEY = 'pa_progress_v1';

  /* ── wardrobe catalog — all colours, zero assets ─────────── */
  const SKINS = {
    scarf: [
      { id: 'scarf_crimson', name: 'Crimson', cost: 0,
        c: { base: '#e34355', dark: '#8e1b2c', light: '#ff6b7c', deep: '#a02234', fringe: '#c9304a' } },
      { id: 'scarf_teal', name: 'Aurora Teal', cost: 150,
        c: { base: '#2ec9a8', dark: '#0e6f5c', light: '#6ff0d4', deep: '#0b5a4a', fringe: '#1ba98a' } },
      { id: 'scarf_blush', name: 'Polar Blush', cost: 200,
        c: { base: '#ff7ec4', dark: '#a03572', light: '#ffb3dd', deep: '#8a2c60', fringe: '#e060a8' } },
      { id: 'scarf_gold', name: 'Golden Sun', cost: 250,
        c: { base: '#f0b429', dark: '#8f6410', light: '#ffd970', deep: '#7a520c', fringe: '#d99a18' } },
      { id: 'scarf_violet', name: 'Violet Sky', cost: 250,
        c: { base: '#9a6cf0', dark: '#4c2e8f', light: '#c5a3ff', deep: '#3d2373', fringe: '#7e4fd9' } },
      { id: 'scarf_midnight', name: 'Midnight', cost: 300,
        c: { base: '#3a4f7a', dark: '#131c30', light: '#7590c2', deep: '#0e1524', fringe: '#2c3d60' } }
    ],
    body: [
      { id: 'body_classic', name: 'Classic', cost: 0,
        c: { top: '#1d3050', mid: '#172740', low: '#121e34', bot: '#0c1424' } },
      { id: 'body_frost', name: 'Frostling', cost: 350,
        c: { top: '#31507e', mid: '#284066', low: '#1e3150', bot: '#16243c' } },
      { id: 'body_shadow', name: 'Shadow', cost: 350,
        c: { top: '#151c2e', mid: '#101624', low: '#0b101a', bot: '#070b12' } },
      { id: 'body_emperor', name: 'Emperor', cost: 400,
        c: { top: '#20304e', mid: '#1a2840', low: '#141f34', bot: '#0d1524', patch: '#f2b53c' } },
      { id: 'body_gilded', name: 'Gilded', cost: 600,
        c: { top: '#8a682a', mid: '#665020', low: '#4a3a18', bot: '#302610' } }
    ],
    trail: [
      { id: 'trail_none', name: 'No Trail', cost: 0, c: null },
      { id: 'trail_aurora', name: 'Aurora Ribbon', cost: 300,
        c: { cols: [[79, 240, 208], [169, 123, 255]], kind: 'trail', rate: 30 } },
      { id: 'trail_frost', name: 'Frost Wake', cost: 350,
        c: { cols: [[190, 235, 255]], kind: 'trail', rate: 26 } },
      { id: 'trail_gold', name: 'Gold Sparkle', cost: 450,
        c: { cols: [[255, 214, 110]], kind: 'spark', rate: 16 } }
    ]
  };

  /* ── mission pool ────────────────────────────────────────── */
  // scope 'run'  : measured against the current run's counters
  // scope 'total': measured against lifetime totals
  // Tiers escalate per completion: target ≈ base · GROW^tier.
  const MISSION_POOL = [
    { id: 'runFish',  stat: 'fish',   scope: 'run',   base: 15,  reward: 30, name: 'Catch {n} fish in one run' },
    { id: 'runDist',  stat: 'dist',   scope: 'run',   base: 400, reward: 40, name: 'Run {n} m in one run' },
    { id: 'runNear',  stat: 'near',   scope: 'run',   base: 6,   reward: 35, name: '{n} close calls in one run' },
    { id: 'combo',    stat: 'combo',  scope: 'run',   base: 12,  reward: 40, name: 'Reach a {n}× fish combo' },
    { id: 'golden',   stat: 'golden', scope: 'total', base: 3,   reward: 45, name: 'Collect {n} golden fish' },
    { id: 'power',    stat: 'power',  scope: 'total', base: 4,   reward: 40, name: 'Grab {n} power-ups' },
    { id: 'slide',    stat: 'slide',  scope: 'total', base: 12,  reward: 30, name: 'Slide {n} times' },
    { id: 'jump',     stat: 'jump',   scope: 'total', base: 25,  reward: 30, name: 'Jump {n} times' },
    { id: 'arch',     stat: 'arch',   scope: 'total', base: 4,   reward: 40, name: 'Duck under {n} ice arches' },
    { id: 'smash',    stat: 'smash',  scope: 'total', base: 3,   reward: 50, name: 'Smash {n} obstacles with cocoa' }
  ];
  const GROW = 2.1;
  const ACTIVE_N = 3;

  class Progress {
    constructor() {
      const def = this._default();
      const got = U.Store.get(KEY, null);
      // Merge over defaults so future fields never crash an old save.
      this.d = got ? Object.assign(def, got) : def;
      this.d.totals = Object.assign(this._default().totals, this.d.totals || {});
      this._dirty = false;
      this.ensureMissions();
      this.save();
    }

    _default() {
      return {
        bank: 0,
        totals: { runs: 0, dist: 0, fish: 0, score: 0, golden: 0, power: 0,
                  slide: 0, jump: 0, smash: 0, arch: 0, near: 0, missions: 0 },
        deaths: {},                                 // obstacle type → count
        unlocked: ['scarf_crimson', 'body_classic', 'trail_none'],
        equipped: { scarf: 'scarf_crimson', body: 'body_classic', trail: 'trail_none' },
        mtier: {},                                  // mission id → completions
        missions: [],                               // active: {id, target, reward}
        runs: [],                                   // newest first, max 10
        daily: {}                                   // 'YYYY-MM-DD' → best score
      };
    }

    save() { U.Store.set(KEY, this.d); this._dirty = false; }

    /* ── currency ──────────────────────────────────────────── */
    get bank() { return this.d.bank; }
    deposit(n) { if (n > 0) { this.d.bank += Math.floor(n); this.save(); } }
    spend(n) {
      if (this.d.bank < n) return false;
      this.d.bank -= n; this.save(); return true;
    }

    /* ── wardrobe ──────────────────────────────────────────── */
    catalog(slot) { return SKINS[slot]; }
    findItem(id) {
      for (const slot in SKINS) {
        const hit = SKINS[slot].find((s) => s.id === id);
        if (hit) return { slot, item: hit };
      }
      return null;
    }
    owned(id) { return this.d.unlocked.indexOf(id) !== -1; }
    equippedId(slot) { return this.d.equipped[slot]; }

    buy(id) {
      const f = this.findItem(id);
      if (!f || this.owned(id)) return false;
      if (!this.spend(f.item.cost)) return false;
      this.d.unlocked.push(id);
      this.save();
      return true;
    }

    equip(id) {
      const f = this.findItem(id);
      if (!f || !this.owned(id)) return false;
      this.d.equipped[f.slot] = id;
      this.save();
      return true;
    }

    /** Resolved style object for Player.setStyle(). */
    style() {
      const get = (slot) => {
        const f = this.findItem(this.d.equipped[slot]);
        return f ? f.item.c : SKINS[slot][0].c;
      };
      return { scarf: get('scarf'), body: get('body'), trail: get('trail') };
    }

    /* ── missions ──────────────────────────────────────────── */
    _mkMission(def) {
      const tier = this.d.mtier[def.id] || 0;
      const target = Math.round(def.base * Math.pow(GROW, tier));
      return {
        id: def.id, stat: def.stat, scope: def.scope,
        target,
        reward: Math.round(def.reward * (1 + tier * 0.6)),
        name: def.name.replace('{n}', target)
      };
    }

    ensureMissions() {
      const activeIds = this.d.missions.map((m) => m.id);
      const pool = MISSION_POOL.filter((d) => activeIds.indexOf(d.id) === -1);
      while (this.d.missions.length < ACTIVE_N && pool.length) {
        const i = (Math.random() * pool.length) | 0;
        this.d.missions.push(this._mkMission(pool.splice(i, 1)[0]));
      }
    }

    activeMissions() { return this.d.missions; }

    /** Progress value a mission currently shows, given the live run stats. */
    missionValue(m, runStats) {
      const v = m.scope === 'run' ? (runStats ? runStats[m.stat] || 0 : 0)
                                  : (this.d.totals[m.stat] || 0);
      return Math.min(v, m.target);
    }

    /**
     * Record a stat bump. Lifetime totals grow here; active missions are
     * checked against either the run counters or the totals. Returns the
     * list of missions completed by this bump (already rewarded/replaced).
     */
    tally(stat, n, runStats) {
      if (this.d.totals[stat] !== undefined && n > 0) this.d.totals[stat] += n;
      const done = [];
      for (let i = this.d.missions.length - 1; i >= 0; i--) {
        const m = this.d.missions[i];
        if (m.stat !== stat) continue;
        if (this.missionValue(m, runStats) >= m.target) {
          this.d.missions.splice(i, 1);
          this.d.mtier[m.id] = (this.d.mtier[m.id] || 0) + 1;
          this.d.totals.missions++;
          this.d.bank += m.reward;
          done.push(m);
        }
      }
      if (done.length) { this.ensureMissions(); this.save(); }
      else this._dirty = true;
      return done;
    }

    /* ── records ───────────────────────────────────────────── */
    recordRun(run) {
      const t = this.d.totals;
      t.runs++;
      t.dist += Math.floor(run.dist);
      t.score += Math.floor(run.score);
      if (run.cause) this.d.deaths[run.cause] = (this.d.deaths[run.cause] || 0) + 1;

      this.d.runs.unshift({
        score: Math.floor(run.score), dist: Math.floor(run.dist),
        fish: run.fish, cause: run.cause || null,
        daily: !!run.daily, date: run.date
      });
      // Keep the ten best BY SCORE (plus recency as tiebreak via stable sort).
      this.d.runs.sort((a, b) => b.score - a.score);
      this.d.runs.length = Math.min(this.d.runs.length, 10);

      if (run.daily && run.date) {
        const prev = this.d.daily[run.date] || 0;
        if (run.score > prev) this.d.daily[run.date] = Math.floor(run.score);
      }
      this.save();
    }

    dailyBest(dateStr) { return this.d.daily[dateStr] || 0; }
    get totals() { return this.d.totals; }
    get deaths() { return this.d.deaths; }
    get runs() { return this.d.runs; }
  }

  /** Today's date key + seed, UTC so the whole world shares one track. */
  Progress.todayKey = function () {
    return new Date().toISOString().slice(0, 10);
  };
  Progress.todaySeed = function () {
    const k = Progress.todayKey();
    // FNV-ish fold of the date string → 32-bit seed.
    let h = 2166136261;
    for (let i = 0; i < k.length; i++) { h ^= k.charCodeAt(i); h = Math.imul(h, 16777619); }
    return h >>> 0;
  };

  Progress.SKINS = SKINS;
  Progress.MISSION_POOL = MISSION_POOL;
  global.Progress = Progress;
})(window);
