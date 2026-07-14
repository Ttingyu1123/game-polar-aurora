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
        speedFill: $('speedFill'), multTag: $('multiplierTag'),
        tray: $('powerupTray'), combo: $('comboPop'),
        menuBest: $('menuBest'), puGrid: $('puGrid'),
        pauseScore: $('pauseScore'), pauseDist: $('pauseDist'), pauseFish: $('pauseFish'),
        goScore: $('goScore'), goDist: $('goDist'), goFish: $('goFish'), goBest: $('goBest'),
        newBest: $('newBest'), goRibbon: $('goRibbon'),
        btnPlay: $('btnPlay'), btnHow: $('btnHow'), btnHowClose: $('btnHowClose'),
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
      tap(e.btnHow, () => this.show('howto'));
      tap(e.btnHowClose, () => this.hide('howto'));
      tap(e.btnResume, () => g.resume());
      tap(e.btnRestartPause, () => g.start());
      tap(e.btnQuit, () => g.toMenu());
      tap(e.btnRetry, () => g.start());
      tap(e.btnMenu, () => g.toMenu());
      tap(e.btnPause, () => g.togglePause());
      tap(e.btnSound, () => this.syncSound(g.audio.toggleMute()));
      tap(e.btnSoundMenu, () => this.syncSound(g.audio.toggleMute()));

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
      this.el.menuBest.textContent = U.formatNum(best);
      this.show('menu');
      this.hide('hud', true); this.hide('sysbar', true);
      this.hide('pause', true); this.hide('gameover', true);
      this.endCountdown();
      this.scoreShown = 0; this.fishShown = 0;
      this._clearChips();
    }

    setPlaying() {
      this.hide('menu'); this.hide('gameover'); this.hide('pause'); this.hide('howto');
      this.show('hud'); this.show('sysbar');
      this.el.hud.setAttribute('aria-hidden', 'false');
    }

    setPaused(score, dist, fish) {
      this.el.pauseScore.textContent = U.formatNum(score);
      this.el.pauseDist.textContent = U.formatNum(dist) + 'm';
      this.el.pauseFish.textContent = U.formatNum(fish);
      this.show('pause');
    }

    setGameOver(score, dist, fish, best, isBest) {
      const e = this.el;
      e.goScore.textContent = U.formatNum(score);
      e.goDist.textContent = U.formatNum(dist) + 'm';
      e.goFish.textContent = U.formatNum(fish);
      e.goBest.textContent = U.formatNum(best);
      e.newBest.classList.toggle('hidden', !isBest);
      e.goRibbon.textContent = isBest ? 'PERSONAL BEST' : dist > 1200 ? 'LEGENDARY RUN' :
        dist > 600 ? 'GREAT RUN' : dist > 250 ? 'GOOD RUN' : 'RUN COMPLETE';
      this.show('gameover');
      this.hide('hud');
      this.hide('sysbar');
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
