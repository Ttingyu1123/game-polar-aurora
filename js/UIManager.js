/* ═══════════════════════════════════════════════════════════
   UIManager — owns every DOM node. The game never touches an element.

   Two ideas worth naming:
   • The score counter EASES toward its true value instead of snapping,
     so a golden fish reads as a satisfying spin-up rather than a jump.
     `scoreShown` is display state only; `score` in Game stays truth.
   • The HOW-TO-PLAY cards are not icons — they render the real
     CollectibleManager art onto little canvases. One source of truth
     for what a shield looks like, so the tutorial can never drift.
   ═══════════════════════════════════════════════════════════ */
(function (global) {
  'use strict';

  const U = global.U;

  const POWER_META = {
    shield:     { name: 'SHIELD',  icon: '❄', col: '#60d6ff' },
    magnet:     { name: 'MAGNET',  icon: '🧲', col: '#ff769c' },
    cocoa:      { name: 'WARMTH',  icon: '🔥', col: '#ff9e54' },
    multiplier: { name: 'DOUBLE',  icon: '✦', col: '#a882ff' }
  };

  const PU_HELP = [
    ['fish', 'Fish', '+1 point. Chain them for combo bonuses.'],
    ['goldenFish', 'Golden Fish', '+12 points. Usually at the top of a jump.'],
    ['crystal', 'Crystal', 'Doubles every point for 10 seconds.'],
    ['shield', 'Ice Shield', 'Absorbs one crash. Keep running.'],
    ['magnet', 'Magnet', 'Pulls in every fish nearby for 9 seconds.'],
    ['cocoa', 'Hot Cocoa', 'Warmth burst — smash through anything.'],
    ['auroraCrystal', 'Aurora Crystal', '+250 and the sky answers back.']
  ];

  class UIManager {
    constructor(game) {
      this.game = game;
      this.el = {};
      this.scoreShown = 0;
      this.fishShown = 0;
      this._chips = {};
      this._lastScoreInt = 0;
      this._built = false;
    }

    /** Cache nodes and wire buttons. */
    init() {
      const $ = (id) => document.getElementById(id);
      const e = this.el = {
        hud: $('hud'), menu: $('menu'), howto: $('howto'), pause: $('pause'),
        gameover: $('gameover'), sysbar: $('sysbar'), countdown: $('countdown'),
        countText: $('countText'), fps: $('fps'),
        score: $('scoreValue'), dist: $('distValue'), fish: $('fishValue'),
        distPanel: document.querySelector('.hud-dist'),
        speedFill: $('speedFill'), multTag: $('multiplierTag'),
        tray: $('powerupTray'), combo: $('comboPop'),
        menuBest: $('menuBest'), puGrid: $('puGrid'),
        bankValue: $('bankValue'), dailySub: $('dailySub'), menuMissions: $('menuMissions'),
        pauseScore: $('pauseScore'), pauseDist: $('pauseDist'), pauseFish: $('pauseFish'),
        goScore: $('goScore'), goDist: $('goDist'), goFish: $('goFish'), goBest: $('goBest'),
        newBest: $('newBest'), goRibbon: $('goRibbon'), goBank: $('goBank'),
        revive: $('revive'), reviveBar: $('reviveBar'), reviveCost: $('reviveCost'), reviveBank: $('reviveBank'),
        wardrobe: $('wardrobe'), wardTabs: $('wardTabs'), wardGrid: $('wardGrid'), wardBank: $('wardBank'),
        records: $('records'), recTotals: $('recTotals'), recRuns: $('recRuns'), recDeaths: $('recDeaths'),
        btnPlay: $('btnPlay'), btnDaily: $('btnDaily'), btnHow: $('btnHow'), btnHowClose: $('btnHowClose'),
        btnWardrobe: $('btnWardrobe'), btnRecords: $('btnRecords'),
        btnWardClose: $('btnWardClose'), btnRecClose: $('btnRecClose'),
        btnRevive: $('btnRevive'), btnGiveUp: $('btnGiveUp'), btnShare: $('btnShare'),
        btnResume: $('btnResume'), btnRestartPause: $('btnRestartPause'), btnQuit: $('btnQuit'),
        btnRetry: $('btnRetry'), btnMenu: $('btnMenu'),
        btnSound: $('btnSound'), btnSoundMenu: $('btnSoundMenu'), btnPause: $('btnPause')
      };

      const g = this.game;
      const tap = (node, fn) => {
        if (!node) return;
        node.addEventListener('click', (ev) => { ev.stopPropagation(); g.audio.ui(); fn(); });
        // Stop taps on UI from also reaching the canvas swipe handler.
        node.addEventListener('pointerdown', (ev) => ev.stopPropagation());
      };

      tap(e.btnPlay, () => g.start());
      tap(e.btnDaily, () => g.start(true));
      tap(e.btnHow, () => this.show('howto'));
      tap(e.btnHowClose, () => this.hide('howto'));
      tap(e.btnWardrobe, () => this.openWardrobe());
      tap(e.btnWardClose, () => this.hide('wardrobe'));
      tap(e.btnRecords, () => this.openRecords());
      tap(e.btnRecClose, () => this.hide('records'));
      tap(e.btnRevive, () => g.reviveAccept());
      tap(e.btnGiveUp, () => g.reviveDecline());
      tap(e.btnShare, () => this._share());
      tap(e.btnResume, () => g.resume());
      tap(e.btnRestartPause, () => g.start(g.daily));
      tap(e.btnQuit, () => g.toMenu());
      tap(e.btnRetry, () => g.start(g.daily));
      tap(e.btnMenu, () => g.toMenu());
      tap(e.btnPause, () => g.togglePause());
      tap(e.btnSound, () => this.syncSound(g.audio.toggleMute()));
      tap(e.btnSoundMenu, () => this.syncSound(g.audio.toggleMute()));

      // Wardrobe tab strip — one handler, slot from data-attribute.
      e.wardTabs.addEventListener('click', (ev) => {
        const b = ev.target.closest('.ward-tab');
        if (!b) return;
        ev.stopPropagation();
        g.audio.ui();
        this._wardSlot = b.dataset.slot;
        for (const t of e.wardTabs.children) t.classList.toggle('active', t === b);
        this._renderWardrobe();
      });
      this._wardSlot = 'scarf';

      this.syncSound(g.audio.muted);
      this._built = true;
      return this;
    }

    /** Render the real pickup art into the tutorial cards. */
    buildHelp(collectibles) {
      const grid = this.el.puGrid;
      if (!grid || grid.childElementCount) return;
      for (const [type, name, desc] of PU_HELP) {
        const card = document.createElement('div');
        card.className = 'pu-card';
        const cv = U.makeCanvas(68, 68);
        const cx = cv.getContext('2d');
        // Fake a projection: the art is authored in metres, so just scale.
        cx.translate(34, 34);
        cx.scale(46, 46);
        const stub = { type, x: 0, y: 0, z: 6, phase: 0.9, spin: 0.55, seed: 7, taken: false, pop: 0 };
        try {
          collectibles._glow(cx, stub);
          const fn = { fish: '_fish', goldenFish: '_fish', crystal: '_gem', shield: '_shield',
                       magnet: '_magnet', cocoa: '_cocoa', auroraCrystal: '_aurora' }[type];
          if (fn === '_fish') collectibles._fish(cx, stub, type === 'goldenFish');
          else collectibles[fn](cx, stub);
        } catch (err) { /* a broken card must never break the menu */ }
        const txt = document.createElement('div');
        txt.innerHTML = '<b></b><small></small>';
        txt.querySelector('b').textContent = name;
        txt.querySelector('small').textContent = desc;
        card.appendChild(cv);
        card.appendChild(txt);
        grid.appendChild(card);
      }
    }

    /* ── screens ───────────────────────────────────────────── */
    show(name) {
      const n = this.el[name];
      if (!n) return;
      n.classList.remove('hidden', 'closing');
      n.setAttribute('aria-hidden', 'false');
    }

    hide(name, instant) {
      const n = this.el[name];
      if (!n || n.classList.contains('hidden')) return;
      n.setAttribute('aria-hidden', 'true');
      if (instant || !n.classList.contains('overlay')) { n.classList.add('hidden'); return; }
      n.classList.add('closing');
      setTimeout(() => { n.classList.add('hidden'); n.classList.remove('closing'); }, 240);
    }

    syncSound(muted) {
      for (const b of [this.el.btnSound, this.el.btnSoundMenu]) {
        if (b) b.classList.toggle('muted', !!muted);
      }
    }

    /* ── countdown ─────────────────────────────────────────── */
    countdown(text) {
      const e = this.el;
      e.countdown.classList.remove('hidden');
      e.countText.textContent = text;
      e.countText.classList.remove('tick');
      void e.countText.offsetWidth;           // restart the CSS animation
      e.countText.classList.add('tick');
    }
    endCountdown() { this.el.countdown.classList.add('hidden'); }

    /* ── HUD ───────────────────────────────────────────────── */
    setMenu(best) {
      const g = this.game;
      this.el.menuBest.textContent = U.formatNum(best);
      if (g.progress) {
        this.el.bankValue.textContent = U.formatNum(g.progress.bank);
        const key = global.Progress.todayKey();
        const db = g.progress.dailyBest(key);
        this.el.dailySub.textContent = key + (db ? '  ·  best ' + U.formatNum(db) : '  ·  not yet run');
        this.refreshMissions();
      }
      this.show('menu');
      this.hide('hud', true); this.hide('sysbar', true);
      this.hide('pause', true); this.hide('gameover', true);
      this.hide('revive', true); this.hide('wardrobe', true); this.hide('records', true);
      this.endCountdown();
      this.scoreShown = 0; this.fishShown = 0;
      this._clearChips();
    }

    /** Re-render the 3 active mission rows (menu block). */
    refreshMissions() {
      const g = this.game;
      const box = this.el.menuMissions;
      if (!box || !g.progress) return;
      box.innerHTML = '';
      for (const m of g.progress.activeMissions()) {
        const v = g.progress.missionValue(m, g.runStats);
        const row = document.createElement('div');
        row.className = 'mission-row';
        row.innerHTML =
          '<div class="mission-ico">✦</div>' +
          '<div class="mission-meta"><div class="mission-name"></div>' +
          '<div class="mission-bar"><i style="width:' + Math.round(100 * v / m.target) + '%"></i></div></div>' +
          '<div class="mission-reward">+' + m.reward + '🐟</div>';
        row.querySelector('.mission-name').textContent = m.name + '  (' + U.formatNum(v) + '/' + U.formatNum(m.target) + ')';
        box.appendChild(row);
      }
    }

    setPlaying() {
      this.hide('menu'); this.hide('gameover'); this.hide('pause'); this.hide('howto');
      this.hide('wardrobe', true); this.hide('records', true); this.hide('revive', true);
      this.show('hud'); this.show('sysbar');
      this.el.hud.setAttribute('aria-hidden', 'false');
      if (this.el.distPanel) this.el.distPanel.classList.toggle('daily', !!this.game.daily);
    }

    setPaused(score, dist, fish) {
      this.el.pauseScore.textContent = U.formatNum(score);
      this.el.pauseDist.textContent = U.formatNum(dist) + 'm';
      this.el.pauseFish.textContent = U.formatNum(fish);
      this.show('pause');
    }

    setGameOver(score, dist, fish, best, isBest, extra) {
      const e = this.el;
      e.goScore.textContent = U.formatNum(score);
      e.goDist.textContent = U.formatNum(dist) + 'm';
      e.goFish.textContent = U.formatNum(fish);
      e.goBest.textContent = U.formatNum(best);
      e.newBest.classList.toggle('hidden', !isBest);
      const x = extra || {};
      e.goRibbon.textContent =
        x.daily ? 'DAILY RUN · ' + global.Progress.todayKey()
        : isBest ? 'PERSONAL BEST'
        : dist > 1200 ? 'LEGENDARY RUN'
        : dist > 600 ? 'GREAT RUN' : dist > 250 ? 'GOOD RUN' : 'RUN COMPLETE';
      e.goBank.innerHTML = '+' + U.formatNum(fish) + ' 🐟 banked <small>· ' +
        U.formatNum(x.bank || 0) + ' total' +
        (x.daily && x.dailyBest ? ' · daily best ' + U.formatNum(x.dailyBest) : '') + '</small>';
      if (e.btnShare) {
        const t = e.btnShare.querySelector('.btn-text') || e.btnShare;
        t.textContent = '📤 SHARE';
      }
      this.show('gameover');
      this.hide('hud');
      this.hide('sysbar');
      this.hide('revive', true);
    }

    async _share() {
      const b = this.el.btnShare;
      b.disabled = true;
      try {
        const how = await this.game.shareScore();
        b.textContent = how === 'shared' ? '✓ SHARED' : how === 'downloaded' ? '✓ SAVED' : 'FAILED';
      } catch (err) {
        b.textContent = 'FAILED';
      }
      setTimeout(() => { b.textContent = '📤 SHARE'; b.disabled = false; }, 1800);
    }

    /* ── revive ────────────────────────────────────────────── */
    showRevive(cost, bank) {
      this.el.reviveCost.textContent = cost;
      this.el.reviveBank.textContent = 'bank: ' + U.formatNum(bank) + ' 🐟';
      this.el.reviveBar.style.width = '100%';
      this.show('revive');
    }
    tickRevive(frac) {
      this.el.reviveBar.style.width = (U.clamp(frac, 0, 1) * 100).toFixed(1) + '%';
    }
    hideRevive() { this.hide('revive', true); }

    /* ── wardrobe ──────────────────────────────────────────── */
    openWardrobe() {
      this._confirmId = null;
      this._renderWardrobe();
      this.show('wardrobe');
    }

    /** Item swatch: a CSS gradient built from the item's own colours. */
    _swatchStyle(slot, item) {
      const c = item.c;
      if (slot === 'scarf') {
        return 'background:linear-gradient(115deg,' + c.dark + ' 0%,' + c.base + ' 40%,' + c.light + ' 65%,' + c.deep + ' 100%)';
      }
      if (slot === 'body') {
        const patch = c.patch ? ',radial-gradient(circle at 78% 30%, ' + c.patch + ' 0 14%, transparent 26%)' : '';
        return 'background:' + (patch ? patch.slice(1) + ',' : '') +
          'linear-gradient(180deg,' + c.top + ',' + c.mid + ' 40%,' + c.low + ' 72%,' + c.bot + ')';
      }
      if (!c) return 'background:rgba(140,210,255,.08)';
      const col = c.cols[0];
      const rgb = 'rgba(' + col[0] + ',' + col[1] + ',' + col[2];
      return 'background:radial-gradient(circle at 50% 55%,' + rgb + ',0.95) 0,' + rgb + ',0.25) 45%,transparent 72%)';
    }

    _renderWardrobe() {
      const g = this.game, P = g.progress;
      const slot = this._wardSlot;
      this.el.wardBank.textContent = U.formatNum(P.bank);
      const grid = this.el.wardGrid;
      grid.innerHTML = '';

      for (const item of P.catalog(slot)) {
        const owned = P.owned(item.id);
        const equipped = P.equippedId(slot) === item.id;
        const can = P.bank >= item.cost;
        const div = document.createElement('div');
        div.className = 'ward-item' + (equipped ? ' equipped' : '') +
          (this._confirmId === item.id ? ' confirming' : '');
        const price = equipped ? 'EQUIPPED' : owned ? 'EQUIP'
          : this._confirmId === item.id ? 'BUY ' + item.cost + '🐟?'
          : item.cost + ' 🐟';
        div.innerHTML =
          '<div class="ward-swatch" style="' + this._swatchStyle(slot, item) + '"></div>' +
          '<div class="ward-name"></div>' +
          '<div class="ward-price ' + (owned ? 'owned' : can ? '' : 'cant') + '">' + price + '</div>';
        div.querySelector('.ward-name').textContent = item.name;

        div.addEventListener('click', (ev) => {
          ev.stopPropagation();
          if (owned) {
            g.equipItem(item.id);
            this._confirmId = null;
          } else if (this._confirmId === item.id) {
            // Second tap = the confirmation. No modal needed.
            g.buyItem(item.id);
            this._confirmId = null;
          } else {
            this._confirmId = item.id;
            if (!can) g.audio.deny();
          }
          this._renderWardrobe();
        });
        div.addEventListener('pointerdown', (ev) => ev.stopPropagation());
        grid.appendChild(div);
      }
    }

    /* ── records ───────────────────────────────────────────── */
    openRecords() {
      const P = this.game.progress;
      const t = P.totals;
      this.el.recTotals.innerHTML = '';
      for (const [v, label] of [
        [U.formatNum(t.runs), 'RUNS'],
        [U.formatNum(Math.round(t.dist / 1000 * 10) / 10) + ' km', 'DISTANCE'],
        [U.formatNum(t.fish), 'FISH'],
        [U.formatNum(t.missions), 'MISSIONS']
      ]) {
        const d = document.createElement('div');
        d.innerHTML = '<span></span><small></small>';
        d.querySelector('span').textContent = v;
        d.querySelector('small').textContent = label;
        this.el.recTotals.appendChild(d);
      }

      const runs = this.el.recRuns;
      runs.innerHTML = '';
      if (!P.runs.length) {
        runs.innerHTML = '<div class="rec-empty">No runs yet — the ice is waiting.</div>';
      } else {
        P.runs.forEach((r, i) => {
          const row = document.createElement('div');
          row.className = 'rec-run';
          row.innerHTML =
            '<span class="r-rank">' + (i + 1) + '</span>' +
            '<span class="r-score">' + U.formatNum(r.score) + ' pts</span>' +
            '<span class="r-dist">' + U.formatNum(r.dist) + ' m</span>' +
            '<span class="r-date">' + (r.date || '') + '</span>' +
            (r.daily ? '<span class="r-tag">DAILY</span>' : '');
          runs.appendChild(row);
        });
      }

      const NAMES = {
        iceberg: 'Iceberg', crystal: 'Ice Crystal', hole: 'Ice Hole', seal: 'Seal',
        snowball: 'Snowball', brokenIce: 'Broken Ice', arch: 'Ice Arch',
        slider: 'Sliding Seal', roller: 'Rolling Snowball'
      };
      const deaths = Object.entries(P.deaths).sort((a, b) => b[1] - a[1]);
      const box = this.el.recDeaths;
      box.innerHTML = '';
      if (!deaths.length) {
        box.innerHTML = '<div class="rec-empty">Nothing has caught you yet.</div>';
      } else {
        const max = deaths[0][1];
        for (const [type, n] of deaths.slice(0, 6)) {
          const row = document.createElement('div');
          row.className = 'rec-death';
          row.innerHTML =
            '<span class="d-name"></span>' +
            '<div class="d-bar"><i style="width:' + Math.round(100 * n / max) + '%"></i></div>' +
            '<span class="d-n">' + n + '</span>';
          row.querySelector('.d-name').textContent = NAMES[type] || type;
          box.appendChild(row);
        }
      }
      this.show('records');
    }

    /** Per-frame HUD refresh. `dt` drives the eased counters. */
    update(dt, s) {
      const e = this.el;
      if (!this._built) return;

      // Ease the score; snap when the gap is trivial so it always lands.
      this.scoreShown = Math.abs(s.score - this.scoreShown) < 1.2
        ? s.score : U.damp(this.scoreShown, s.score, 0.24, dt);
      const si = Math.floor(this.scoreShown);
      if (si !== this._lastScoreInt) {
        this._lastScoreInt = si;
        e.score.textContent = U.formatNum(si);
      }

      this.fishShown = Math.abs(s.fish - this.fishShown) < 0.6
        ? s.fish : U.damp(this.fishShown, s.fish, 0.3, dt);
      e.fish.textContent = U.formatNum(this.fishShown);
      e.dist.textContent = U.formatNum(s.distance);
      e.speedFill.style.width = (U.clamp(s.speed01, 0, 1) * 100).toFixed(1) + '%';

      const showMult = s.powers.multiplier > 0;
      e.multTag.classList.toggle('hidden', !showMult);

      this._syncChips(s.powers);
    }

    bumpScore() {
      const v = this.el.score;
      v.classList.remove('bump');
      void v.offsetWidth;
      v.classList.add('bump');
    }

    combo(text, col) {
      const c = this.el.combo;
      c.textContent = text;
      c.style.color = col || '#ffffff';
      c.classList.remove('show');
      void c.offsetWidth;
      c.classList.add('show');
    }

    /* ── power-up chips ────────────────────────────────────── */
    _syncChips(powers) {
      for (const key in POWER_META) {
        const t = powers[key] || 0;
        const meta = POWER_META[key];
        let chip = this._chips[key];

        if (t > 0 && !chip) {
          chip = document.createElement('div');
          chip.className = 'pu-chip';
          chip.style.color = meta.col;
          chip.innerHTML =
            '<div class="pu-dot" style="background:' + meta.col + '22;color:' + meta.col + '">' + meta.icon + '</div>' +
            '<div class="pu-meta"><div class="pu-name">' + meta.name + '</div><div class="pu-bar"><i></i></div></div>';
          this.el.tray.appendChild(chip);
          this._chips[key] = chip;
          chip._max = t;
        } else if (t <= 0 && chip) {
          chip.classList.add('out');
          const dead = chip;
          setTimeout(() => { if (dead.parentNode) dead.parentNode.removeChild(dead); }, 280);
          this._chips[key] = null;
          delete this._chips[key];
          continue;
        }

        if (chip) {
          if (t > chip._max) chip._max = t;     // refreshed mid-run
          const bar = chip.querySelector('.pu-bar > i');
          if (bar) bar.style.width = (U.clamp(t / chip._max, 0, 1) * 100).toFixed(1) + '%';
          chip.classList.toggle('expiring', t < 2.2);
        }
      }
    }

    _clearChips() {
      for (const k in this._chips) {
        const c = this._chips[k];
        if (c && c.parentNode) c.parentNode.removeChild(c);
      }
      this._chips = {};
      if (this.el.tray) this.el.tray.innerHTML = '';
    }

    setFps(text) {
      const f = this.el.fps;
      if (!f) return;
      if (text === null) { f.classList.add('hidden'); return; }
      f.classList.remove('hidden');
      f.textContent = text;
    }
  }

  global.UIManager = UIManager;
})(window);
