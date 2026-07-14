/* ═══════════════════════════════════════════════════════════
   StateMachine — tiny explicit FSM with enter/exit/update hooks
   and guarded transitions. Used for the game shell (menu, play,
   pause, dying, over) and for the player's action states.
   ═══════════════════════════════════════════════════════════ */
(function (global) {
  'use strict';

  class StateMachine {
    /**
     * @param {Object<string, {enter?:Function, exit?:Function, update?:Function}>} states
     * @param {string} initial
     * @param {Object<string, string[]>} [transitions] allowed `from -> [to…]`.
     *        Omit to allow everything.
     */
    constructor(states, initial, transitions) {
      this.states = states;
      this.transitions = transitions || null;
      this.current = null;
      this.previous = null;
      this.time = 0;          // seconds spent in current state
      this.listeners = [];
      this._queued = null;
      this.set(initial, {}, true);
    }

    /** True when `to` is reachable from the current state. */
    can(to) {
      if (!this.states[to]) return false;
      if (!this.transitions || !this.current) return true;
      const allow = this.transitions[this.current];
      return !allow || allow.indexOf(to) !== -1;
    }

    /** Immediate transition. Returns false if blocked. */
    set(to, payload, force) {
      if (to === this.current && !force) return false;
      if (!force && !this.can(to)) return false;
      const st = this.states[to];
      if (!st) return false;

      const from = this.current;
      if (from && this.states[from] && this.states[from].exit) {
        this.states[from].exit.call(this, to, payload || {});
      }
      this.previous = from;
      this.current = to;
      this.time = 0;
      if (st.enter) st.enter.call(this, from, payload || {});
      for (let i = 0; i < this.listeners.length; i++) this.listeners[i](to, from, payload || {});
      return true;
    }

    /** Transition applied at the start of the next update — safe to call
     *  from inside an update handler without reentrancy surprises. */
    queue(to, payload) { this._queued = { to, payload }; }

    is(to) { return this.current === to; }
    isAny() { for (let i = 0; i < arguments.length; i++) if (this.current === arguments[i]) return true; return false; }

    onChange(fn) { this.listeners.push(fn); return () => { const i = this.listeners.indexOf(fn); if (i >= 0) this.listeners.splice(i, 1); }; }

    update(dt) {
      if (this._queued) {
        const q = this._queued; this._queued = null;
        this.set(q.to, q.payload);
      }
      this.time += dt;
      const st = this.states[this.current];
      if (st && st.update) st.update.call(this, dt, this.time);
    }
  }

  global.StateMachine = StateMachine;
})(window);
