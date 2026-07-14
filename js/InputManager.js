/* ═══════════════════════════════════════════════════════════
   InputManager — keyboard, swipe, tap and pointer, normalised into
   four buffered intents: left, right, jump, slide.

   Two details that matter for feel:
   • Intents are BUFFERED (~140 ms). Pressing jump a hair before you
     land still jumps. Without this the game feels like it drops input.
   • Swipes resolve on movement, not on release, so a flick registers
     the instant it passes threshold.
   ═══════════════════════════════════════════════════════════ */
(function (global) {
  'use strict';

  const U = global.U;
  const BUFFER = 0.14;          // seconds an unconsumed intent survives
  const SWIPE_MIN = 24;         // px before a drag counts as a swipe
  const SWIPE_RATIO = 1.25;     // dominance of one axis over the other

  const KEYMAP = {
    ArrowLeft: 'left', KeyA: 'left',
    ArrowRight: 'right', KeyD: 'right',
    ArrowUp: 'jump', KeyW: 'jump', Space: 'jump',
    ArrowDown: 'slide', KeyS: 'slide'
  };

  class InputManager {
    constructor() {
      this.intents = { left: 0, right: 0, jump: 0, slide: 0 }; // remaining buffer time
      this.held = { left: false, right: false, jump: false, slide: false };
      this.lastDevice = 'keyboard';
      this.anyKeySinceReset = false;

      this._touchId = null;
      this._sx = 0; this._sy = 0; this._st = 0;
      this._swiped = false;
      this._actions = {};        // name -> callback (pause, mute, start…)
      this._bound = [];
      this._enabled = true;
    }

    /** Register a one-shot action key, e.g. on('pause', fn). */
    on(name, fn) { (this._actions[name] || (this._actions[name] = [])).push(fn); }
    _fire(name) { const l = this._actions[name]; if (l) for (let i = 0; i < l.length; i++) l[i](); }

    attach(target) {
      const el = target || window;

      const kd = (e) => {
        if (e.repeat) return;
        const a = KEYMAP[e.code];
        if (a) {
          e.preventDefault();
          this.lastDevice = 'keyboard';
          this.anyKeySinceReset = true;
          this.held[a] = true;
          if (this._enabled) this.intents[a] = BUFFER;
          this._fire('any');
        } else if (e.code === 'Escape' || e.code === 'KeyP') {
          e.preventDefault(); this._fire('pause');
        } else if (e.code === 'KeyM') {
          e.preventDefault(); this._fire('mute');
        } else if (e.code === 'Enter' || e.code === 'NumpadEnter') {
          e.preventDefault(); this._fire('confirm');
        } else if (e.code === 'KeyF') {
          e.preventDefault(); this._fire('fps');
        }
      };
      const ku = (e) => { const a = KEYMAP[e.code]; if (a) this.held[a] = false; };

      // Pointer covers mouse + pen + touch uniformly.
      const pd = (e) => {
        if (this._touchId !== null) return;
        this._touchId = e.pointerId;
        this._sx = e.clientX; this._sy = e.clientY;
        this._st = performance.now();
        this._swiped = false;
        this.lastDevice = e.pointerType === 'mouse' ? 'mouse' : 'touch';
        this._fire('any');
      };
      const pm = (e) => {
        if (e.pointerId !== this._touchId || this._swiped || !this._enabled) return;
        const dx = e.clientX - this._sx, dy = e.clientY - this._sy;
        const ax = Math.abs(dx), ay = Math.abs(dy);
        if (ax < SWIPE_MIN && ay < SWIPE_MIN) return;
        if (ax > ay * SWIPE_RATIO) { this.trigger(dx > 0 ? 'right' : 'left'); this._swiped = true; }
        else if (ay > ax * SWIPE_RATIO) { this.trigger(dy > 0 ? 'slide' : 'jump'); this._swiped = true; }
      };
      const pu = (e) => {
        if (e.pointerId !== this._touchId) return;
        const dt = performance.now() - this._st;
        const dx = e.clientX - this._sx, dy = e.clientY - this._sy;
        // Quick tap that never became a swipe = jump. Generous, forgiving.
        if (!this._swiped && dt < 260 && Math.abs(dx) < SWIPE_MIN && Math.abs(dy) < SWIPE_MIN) {
          this.trigger('jump');
        }
        this._touchId = null;
        this.held.slide = false;
      };
      const pc = () => { this._touchId = null; this.held.slide = false; };

      const blur = () => { this.held.left = this.held.right = this.held.jump = this.held.slide = false; };
      const ctx = (e) => e.preventDefault();

      window.addEventListener('keydown', kd, { passive: false });
      window.addEventListener('keyup', ku);
      window.addEventListener('blur', blur);
      el.addEventListener('pointerdown', pd, { passive: true });
      el.addEventListener('pointermove', pm, { passive: true });
      el.addEventListener('pointerup', pu, { passive: true });
      el.addEventListener('pointercancel', pc, { passive: true });
      el.addEventListener('contextmenu', ctx);

      this._bound = [
        [window, 'keydown', kd], [window, 'keyup', ku], [window, 'blur', blur],
        [el, 'pointerdown', pd], [el, 'pointermove', pm], [el, 'pointerup', pu],
        [el, 'pointercancel', pc], [el, 'contextmenu', ctx]
      ];
    }

    detach() {
      for (const [t, n, f] of this._bound) t.removeEventListener(n, f);
      this._bound = [];
    }

    setEnabled(v) { this._enabled = v; if (!v) this.flush(); }

    /** Inject an intent (used by swipes and by on-screen buttons). */
    trigger(name) {
      if (!this._enabled) return;
      if (this.intents[name] !== undefined) this.intents[name] = BUFFER;
      if (name === 'slide') this.held.slide = true;
    }

    /** Consume a buffered intent. Returns true once per press. */
    consume(name) {
      if (this.intents[name] > 0) { this.intents[name] = 0; return true; }
      return false;
    }

    peek(name) { return this.intents[name] > 0; }

    flush() {
      this.intents.left = this.intents.right = this.intents.jump = this.intents.slide = 0;
    }

    update(dt) {
      const k = this.intents;
      if (k.left > 0) k.left -= dt;
      if (k.right > 0) k.right -= dt;
      if (k.jump > 0) k.jump -= dt;
      if (k.slide > 0) k.slide -= dt;
    }
  }

  global.InputManager = InputManager;
})(window);
