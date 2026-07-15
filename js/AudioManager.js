/* ═══════════════════════════════════════════════════════════
   AudioManager — 100 % procedural Web Audio. No files.

   Signal graph
     ┌ music ─┐
     ├ sfx   ─┼→ [wet send → convolver(procedural IR) ─┐
     └ wind  ─┘                                        ├→ master → compressor → out
                                          ─ dry ───────┘

   Music is a look-ahead scheduler (Chris Wilson's pattern): a JS timer
   wakes every 25 ms and books notes up to 120 ms into the future on the
   audio clock, so timing never jitters with frame rate. Four layers —
   pad, bass, arp, bells — fade in as run intensity rises, so the score
   grows with the run instead of looping flat.
   ═══════════════════════════════════════════════════════════ */
(function (global) {
  'use strict';

  const U = global.U;
  const mtof = (m) => 440 * Math.pow(2, (m - 69) / 12);

  // A natural-minor bed: i – VI – III – VII. Cold but hopeful.
  const PROG = [
    { root: 45, chord: [45, 52, 57, 60, 64] }, // Am
    { root: 41, chord: [41, 48, 53, 57, 60] }, // F
    { root: 48, chord: [48, 55, 60, 64, 67] }, // C
    { root: 43, chord: [43, 50, 55, 59, 62] }  // G
  ];
  const PENTA = [0, 3, 5, 7, 10, 12, 15, 17, 19, 22, 24];
  const ARP_STEPS = [0, 2, 1, 3, 2, 4, 3, 2];

  class AudioManager {
    constructor() {
      this.ctx = null;
      this.ready = false;
      this.muted = U.Store.get('pa_muted', false);
      this.intensity = 0;       // 0..1 — drives layer count + brightness
      this._targetIntensity = 0;
      this.windAmount = 0;
      this._musicOn = false;
      this._timer = null;
      this._next = 0;           // next note time on the audio clock
      this._step = 0;           // 16th-note counter
      this.bpm = 124;
      this._lastCollect = 0;
      this._duckUntil = 0;
    }

    /* ── boot (must follow a user gesture) ─────────────────── */
    init() {
      if (this.ctx) return true;
      const AC = global.AudioContext || global.webkitAudioContext;
      if (!AC) return false;
      try { this.ctx = new AC(); } catch (e) { return false; }
      const ctx = this.ctx;

      this.master = ctx.createGain();
      this.master.gain.value = this.muted ? 0 : 0.9;

      this.comp = ctx.createDynamicsCompressor();
      this.comp.threshold.value = -16;
      this.comp.knee.value = 24;
      this.comp.ratio.value = 6;
      this.comp.attack.value = 0.004;
      this.comp.release.value = 0.22;

      this.master.connect(this.comp);
      this.comp.connect(ctx.destination);

      // Procedural plate-ish reverb.
      this.verb = ctx.createConvolver();
      this.verb.buffer = this._makeIR(2.6, 2.4);
      this.verbGain = ctx.createGain();
      this.verbGain.gain.value = 0.5;
      this.verb.connect(this.verbGain);
      this.verbGain.connect(this.master);

      const bus = (vol, wet) => {
        const g = ctx.createGain();
        g.gain.value = vol;
        g.connect(this.master);
        if (wet > 0) { const s = ctx.createGain(); s.gain.value = wet; g.connect(s); s.connect(this.verb); }
        return g;
      };
      this.musicGain = bus(0.34, 0.34);
      this.sfxGain = bus(0.62, 0.16);
      this.windGain = bus(0.0, 0.05);

      this._noise = this._makeNoise(3);
      this._buildWind();
      this.ready = true;
      return true;
    }

    resume() {
      if (!this.ctx) this.init();
      if (this.ctx && this.ctx.state === 'suspended') this.ctx.resume().catch(() => {});
    }

    /* ── procedural buffers ────────────────────────────────── */

    /** Exponentially decaying stereo noise = a serviceable reverb tail. */
    _makeIR(dur, decay) {
      const ctx = this.ctx, sr = ctx.sampleRate, n = (sr * dur) | 0;
      const buf = ctx.createBuffer(2, n, sr);
      for (let c = 0; c < 2; c++) {
        const d = buf.getChannelData(c);
        let lp = 0;
        for (let i = 0; i < n; i++) {
          const t = i / n;
          const env = Math.pow(1 - t, decay);
          // Early gap keeps the tail from sounding like a noise gate.
          const pre = i < sr * 0.012 ? i / (sr * 0.012) : 1;
          lp += ((Math.random() * 2 - 1) - lp) * 0.42;   // 1-pole LP → darker, icier tail
          d[i] = lp * env * pre * 0.7;
        }
      }
      return buf;
    }

    /** Brown-ish noise — the base of wind, skids and impacts. */
    _makeNoise(sec) {
      const ctx = this.ctx, sr = ctx.sampleRate, n = (sr * sec) | 0;
      const buf = ctx.createBuffer(2, n, sr);
      for (let c = 0; c < 2; c++) {
        const d = buf.getChannelData(c);
        let last = 0;
        for (let i = 0; i < n; i++) {
          const w = Math.random() * 2 - 1;
          last = (last + 0.022 * w) / 1.022;
          d[i] = last * 3.2;
        }
      }
      return buf;
    }

    /* ── wind bed ──────────────────────────────────────────── */
    _buildWind() {
      const ctx = this.ctx;
      const src = ctx.createBufferSource();
      src.buffer = this._noise; src.loop = true;

      const bp = ctx.createBiquadFilter();
      bp.type = 'bandpass'; bp.frequency.value = 520; bp.Q.value = 0.75;

      const hp = ctx.createBiquadFilter();
      hp.type = 'highpass'; hp.frequency.value = 180;

      // Slow LFO on the band centre = gusting, not a static hiss.
      const lfo = ctx.createOscillator();
      lfo.type = 'sine'; lfo.frequency.value = 0.077;
      const lfoAmt = ctx.createGain(); lfoAmt.gain.value = 300;
      lfo.connect(lfoAmt); lfoAmt.connect(bp.frequency);

      const lfo2 = ctx.createOscillator();
      lfo2.type = 'sine'; lfo2.frequency.value = 0.19;
      const lfo2Amt = ctx.createGain(); lfo2Amt.gain.value = 0.24;
      const gustGain = ctx.createGain(); gustGain.gain.value = 0.76;
      lfo2.connect(lfo2Amt); lfo2Amt.connect(gustGain.gain);

      src.connect(bp); bp.connect(hp); hp.connect(gustGain); gustGain.connect(this.windGain);
      src.start(); lfo.start(); lfo2.start();
      this._windBp = bp;
    }

    setWind(amount01) {
      this.windAmount = amount01;
      if (!this.ready) return;
      const t = this.ctx.currentTime;
      this.windGain.gain.setTargetAtTime(0.06 + amount01 * 0.30, t, 0.35);
      this._windBp.frequency.setTargetAtTime(430 + amount01 * 900, t, 0.5);
    }

    /* ── voices ────────────────────────────────────────────── */

    _osc(type, freq, t, dur, gain, dest, detune) {
      const ctx = this.ctx;
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      o.type = type; o.frequency.setValueAtTime(freq, t);
      if (detune) o.detune.setValueAtTime(detune, t);
      g.gain.value = 0;
      o.connect(g); g.connect(dest || this.sfxGain);
      o.start(t); o.stop(t + dur + 0.06);
      o.onended = () => { try { o.disconnect(); g.disconnect(); } catch (e) {} };
      return { o, g };
    }

    /** Percussive pluck with a fast attack and exponential tail. */
    _pluck(freq, t, dur, vol, dest, type) {
      const { o, g } = this._osc(type || 'triangle', freq, t, dur, vol, dest);
      g.gain.setValueAtTime(0.0001, t);
      g.gain.linearRampToValueAtTime(vol, t + 0.006);
      g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      return o;
    }

    _noiseBurst(t, dur, vol, freq, type, q) {
      const ctx = this.ctx;
      const s = ctx.createBufferSource();
      s.buffer = this._noise;
      s.playbackRate.value = 0.85 + Math.random() * 0.3;
      const f = ctx.createBiquadFilter();
      f.type = type || 'bandpass'; f.frequency.value = freq; f.Q.value = q === undefined ? 1.1 : q;
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, t);
      g.gain.linearRampToValueAtTime(vol, t + 0.008);
      g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      s.connect(f); f.connect(g); g.connect(this.sfxGain);
      const off = Math.random() * 2;
      s.start(t, off, dur + 0.1);
      s.onended = () => { try { s.disconnect(); f.disconnect(); g.disconnect(); } catch (e) {} };
      return { s, f, g };
    }

    /* ── music scheduler ───────────────────────────────────── */
    startMusic() {
      if (!this.ready || this._musicOn) return;
      this._musicOn = true;
      this._next = this.ctx.currentTime + 0.12;
      this._step = 0;
      this._timer = setInterval(() => this._pump(), 25);
    }

    stopMusic(fade) {
      if (!this._musicOn) return;
      this._musicOn = false;
      clearInterval(this._timer); this._timer = null;
      if (this.ready) {
        const t = this.ctx.currentTime;
        this.musicGain.gain.cancelScheduledValues(t);
        this.musicGain.gain.setTargetAtTime(0, t, fade === undefined ? 0.25 : fade);
      }
    }

    _pump() {
      if (!this.ready || !this._musicOn) return;
      const ctx = this.ctx;
      const spb = 60 / this.bpm;
      const step = spb / 4;                       // 16th notes
      while (this._next < ctx.currentTime + 0.12) {
        this._schedule(this._step, this._next);
        this._next += step;
        this._step++;
      }
      // Intensity glides so layers swell rather than pop in.
      this.intensity = U.lerp(this.intensity, this._targetIntensity, 0.04);
      const duck = ctx.currentTime < this._duckUntil ? 0.45 : 1;
      this.musicGain.gain.setTargetAtTime((0.16 + this.intensity * 0.2) * duck, ctx.currentTime, 0.2);
    }

    _schedule(step, t) {
      const bar = (step / 16) | 0;
      const beat = step % 16;
      const P = PROG[bar % PROG.length];
      const I = this.intensity;

      /* PAD — two detuned saws through a slowly opening filter. */
      if (beat === 0) {
        const ctx = this.ctx;
        const dur = (60 / this.bpm) * 4;
        const f = ctx.createBiquadFilter();
        f.type = 'lowpass';
        f.frequency.setValueAtTime(360 + I * 900, t);
        f.frequency.linearRampToValueAtTime(520 + I * 1400, t + dur * 0.5);
        f.Q.value = 1.5;
        const g = ctx.createGain();
        g.gain.setValueAtTime(0.0001, t);
        g.gain.linearRampToValueAtTime(0.052 + I * 0.03, t + 0.5);
        g.gain.setValueAtTime(0.052 + I * 0.03, t + dur * 0.6);
        g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
        f.connect(g); g.connect(this.musicGain);
        for (const semi of [P.chord[0] + 12, P.chord[2], P.chord[3]]) {
          for (const det of [-7, 7]) {
            const o = ctx.createOscillator();
            o.type = 'sawtooth';
            o.frequency.value = mtof(semi);
            o.detune.value = det;
            o.connect(f); o.start(t); o.stop(t + dur + 0.1);
            o.onended = () => { try { o.disconnect(); } catch (e) {} };
          }
        }
        setTimeout(() => { try { f.disconnect(); g.disconnect(); } catch (e) {} }, (dur + 1) * 1000);
      }

      /* BASS — root on 1, fifth pickup on the & of 3. */
      if (beat === 0 || beat === 10) {
        const n = beat === 0 ? P.root - 12 : P.root - 5;
        const o = this._pluck(mtof(n), t, 0.42, 0.11 + I * 0.05, this.musicGain, 'triangle');
        o.frequency.setValueAtTime(mtof(n) * 1.01, t);
        o.frequency.exponentialRampToValueAtTime(mtof(n), t + 0.05);
      }

      /* KICK-ish pulse — subby, felt more than heard. */
      if (I > 0.18 && (beat === 0 || beat === 8)) {
        const o = this._pluck(90, t, 0.16, 0.14 * I, this.musicGain, 'sine');
        o.frequency.setValueAtTime(120, t);
        o.frequency.exponentialRampToValueAtTime(46, t + 0.11);
      }

      /* HAT — icy 16ths, only once the run has heat. */
      if (I > 0.42 && beat % 2 === 1) {
        this._noiseBurst(t, 0.045, 0.02 * I, 8200, 'highpass', 0.8).g.connect(this.musicGain);
      }

      /* ARP — the signature layer. Pentatonic, ping-ponging up the chord. */
      if (I > 0.05 && beat % 2 === 0) {
        const idx = ARP_STEPS[(step / 2) % ARP_STEPS.length];
        const n = P.chord[idx % P.chord.length] + 12;
        this._pluck(mtof(n), t, 0.28, (0.030 + I * 0.028), this.musicGain, 'triangle');
      }

      /* BELLS — sparse high sine motif over the top half of the run. */
      if (I > 0.55 && beat === 6 && (bar % 2 === 0)) {
        const n = P.root + PENTA[4 + (bar % 3)] + 24;
        this._pluck(mtof(n), t, 1.1, 0.035 * I, this.musicGain, 'sine');
        this._pluck(mtof(n + 7), t + 0.09, 0.9, 0.022 * I, this.musicGain, 'sine');
      }
    }

    setIntensity(v) { this._targetIntensity = U.clamp(v, 0, 1); }

    /** Briefly pull the music down so a big SFX cuts through. */
    duck(sec) { if (this.ready) this._duckUntil = this.ctx.currentTime + (sec || 0.5); }

    /* ── SFX ───────────────────────────────────────────────── */

    jump() {
      if (!this.ready || this.muted) return;
      const t = this.ctx.currentTime;
      const o = this._pluck(300, t, 0.2, 0.13, this.sfxGain, 'sine');
      o.frequency.setValueAtTime(240, t);
      o.frequency.exponentialRampToValueAtTime(690, t + 0.15);
      this._noiseBurst(t, 0.16, 0.10, 1500, 'bandpass', 0.7);
    }

    land(power) {
      if (!this.ready || this.muted) return;
      const p = U.clamp(power === undefined ? 1 : power, 0.2, 1.4);
      const t = this.ctx.currentTime;
      const o = this._pluck(120, t, 0.16, 0.11 * p, this.sfxGain, 'sine');
      o.frequency.setValueAtTime(160, t);
      o.frequency.exponentialRampToValueAtTime(52, t + 0.12);
      this._noiseBurst(t, 0.2 * p, 0.14 * p, 700, 'lowpass', 0.6);   // snow crunch
      this._noiseBurst(t + 0.01, 0.1, 0.05 * p, 4200, 'highpass', 0.5); // ice tick
    }

    slide() {
      if (!this.ready || this.muted) return;
      const t = this.ctx.currentTime;
      this._noiseBurst(t, 0.5, 0.09, 2600, 'bandpass', 1.6);
      const o = this._pluck(420, t, 0.42, 0.045, this.sfxGain, 'sine');
      o.frequency.setValueAtTime(520, t);
      o.frequency.exponentialRampToValueAtTime(300, t + 0.4);
    }

    lane() {
      if (!this.ready || this.muted) return;
      const t = this.ctx.currentTime;
      this._noiseBurst(t, 0.13, 0.055, 3400, 'bandpass', 2.4);
    }

    /** Collect — pitch climbs with the combo. The core dopamine sound. */
    collect(combo) {
      if (!this.ready || this.muted) return;
      const t = Math.max(this.ctx.currentTime, this._lastCollect + 0.012);
      this._lastCollect = t;
      const step = Math.min(combo || 0, 14);
      const base = 72 + PENTA[step % PENTA.length] + Math.floor(step / PENTA.length) * 12;
      this._pluck(mtof(base), t, 0.24, 0.11, this.sfxGain, 'sine');
      this._pluck(mtof(base + 7), t + 0.035, 0.2, 0.06, this.sfxGain, 'sine');
      this._pluck(mtof(base + 12), t + 0.07, 0.3, 0.035, this.sfxGain, 'triangle');
    }

    golden() {
      if (!this.ready || this.muted) return;
      const t = this.ctx.currentTime;
      [0, 4, 7, 12, 16, 19].forEach((s, i) => {
        this._pluck(mtof(76 + s), t + i * 0.045, 0.5, 0.075 - i * 0.008, this.sfxGain, 'sine');
      });
      this._noiseBurst(t, 0.4, 0.03, 6500, 'highpass', 0.6);
    }

    powerup(kind) {
      if (!this.ready || this.muted) return;
      const t = this.ctx.currentTime;
      this.duck(0.55);
      const root = kind === 'shield' ? 60 : kind === 'magnet' ? 62 : kind === 'cocoa' ? 57 : 64;
      [0, 4, 7, 11, 14].forEach((s, i) => {
        const o = this._pluck(mtof(root + s), t + i * 0.05, 0.7, 0.07, this.sfxGain, 'triangle');
        o.frequency.setValueAtTime(mtof(root + s) * 0.5, t + i * 0.05);
        o.frequency.exponentialRampToValueAtTime(mtof(root + s), t + i * 0.05 + 0.07);
      });
      this._noiseBurst(t, 0.6, 0.045, 3000, 'bandpass', 1.2);
    }

    crystal() {
      if (!this.ready || this.muted) return;
      const t = this.ctx.currentTime;
      for (let i = 0; i < 7; i++) {
        this._pluck(mtof(84 + PENTA[i]), t + i * 0.028, 0.9 - i * 0.06, 0.045, this.sfxGain, 'sine');
      }
    }

    shieldBreak() {
      if (!this.ready || this.muted) return;
      const t = this.ctx.currentTime;
      this.duck(0.5);
      this._noiseBurst(t, 0.55, 0.16, 2400, 'bandpass', 0.9);
      this._noiseBurst(t, 0.3, 0.12, 7000, 'highpass', 0.5);
      for (let i = 0; i < 5; i++) {
        this._pluck(mtof(74 + U.randInt(0, 12)), t + i * 0.03, 0.35, 0.04, this.sfxGain, 'sine');
      }
    }

    nearMiss() {
      if (!this.ready || this.muted) return;
      const t = this.ctx.currentTime;
      const ctx = this.ctx;
      const s = ctx.createBufferSource();
      s.buffer = this._noise; s.playbackRate.value = 1.5;
      const f = ctx.createBiquadFilter();
      f.type = 'bandpass'; f.Q.value = 3.2;
      f.frequency.setValueAtTime(1600, t);
      f.frequency.exponentialRampToValueAtTime(360, t + 0.26);
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, t);
      g.gain.linearRampToValueAtTime(0.07, t + 0.05);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.28);
      s.connect(f); f.connect(g); g.connect(this.sfxGain);
      s.start(t, Math.random() * 2, 0.35);
      s.onended = () => { try { s.disconnect(); f.disconnect(); g.disconnect(); } catch (e) {} };
    }

    hit() {
      if (!this.ready || this.muted) return;
      const t = this.ctx.currentTime;
      this.duck(0.7);
      this._noiseBurst(t, 0.5, 0.3, 420, 'lowpass', 0.9);
      this._noiseBurst(t, 0.18, 0.16, 2200, 'bandpass', 0.7);
      const o = this._pluck(150, t, 0.5, 0.2, this.sfxGain, 'sawtooth');
      o.frequency.setValueAtTime(190, t);
      o.frequency.exponentialRampToValueAtTime(40, t + 0.45);
    }

    gameOver() {
      if (!this.ready || this.muted) return;
      const t = this.ctx.currentTime + 0.28;
      // Aeolian descent — the run exhaling.
      [64, 60, 57, 52, 45].forEach((n, i) => {
        const tt = t + i * 0.17;
        this._pluck(mtof(n), tt, 1.5, 0.085, this.sfxGain, 'triangle');
        this._pluck(mtof(n - 12), tt, 1.8, 0.05, this.sfxGain, 'sine');
      });
      const w = this._noiseBurst(t, 2.4, 0.05, 900, 'lowpass', 0.5);
      w.f.frequency.setValueAtTime(1400, t);
      w.f.frequency.exponentialRampToValueAtTime(180, t + 2.2);
    }

    newBest() {
      if (!this.ready || this.muted) return;
      const t = this.ctx.currentTime + 0.1;
      [72, 76, 79, 84, 88, 91].forEach((n, i) => {
        this._pluck(mtof(n), t + i * 0.08, 1.2, 0.08, this.sfxGain, 'sine');
      });
    }

    /** Mission complete — a short, bright "task done" motif. */
    mission() {
      if (!this.ready || this.muted) return;
      const t = this.ctx.currentTime;
      this.duck(0.4);
      [67, 74, 79, 86].forEach((n, i) => {
        this._pluck(mtof(n), t + i * 0.07, 0.5, 0.075, this.sfxGain, 'triangle');
      });
      this._noiseBurst(t + 0.2, 0.3, 0.03, 6800, 'highpass', 0.6);
    }

    /** Revive — warmth rushing back in: a rising swell, then a heartbeat. */
    revive() {
      if (!this.ready || this.muted) return;
      const t = this.ctx.currentTime;
      this.duck(0.8);
      const o = this._pluck(mtof(48), t, 1.1, 0.12, this.sfxGain, 'sine');
      o.frequency.setValueAtTime(mtof(48), t);
      o.frequency.exponentialRampToValueAtTime(mtof(60), t + 0.8);
      [60, 64, 67, 72].forEach((n, i) => {
        this._pluck(mtof(n), t + 0.5 + i * 0.06, 0.8, 0.07, this.sfxGain, 'triangle');
      });
      // heartbeat thumps
      for (const dt of [0.05, 0.28]) {
        const h = this._pluck(70, t + dt, 0.14, 0.12, this.sfxGain, 'sine');
        h.frequency.setValueAtTime(95, t + dt);
        h.frequency.exponentialRampToValueAtTime(45, t + dt + 0.1);
      }
    }

    /** Wardrobe purchase — coins sliding across ice. */
    purchase() {
      if (!this.ready || this.muted) return;
      const t = this.ctx.currentTime;
      for (let i = 0; i < 4; i++) {
        this._pluck(mtof(88 + U.randInt(-2, 3)), t + i * 0.045, 0.22, 0.05, this.sfxGain, 'sine');
      }
      this._pluck(mtof(76), t + 0.2, 0.5, 0.07, this.sfxGain, 'triangle');
    }

    /** Flat "can't do that" tick for refused purchases. */
    deny() {
      if (!this.ready || this.muted) return;
      const t = this.ctx.currentTime;
      this._pluck(mtof(58), t, 0.16, 0.06, this.sfxGain, 'triangle');
      this._pluck(mtof(52), t + 0.09, 0.2, 0.06, this.sfxGain, 'triangle');
    }

    ui() {
      if (!this.ready || this.muted) return;
      const t = this.ctx.currentTime;
      this._pluck(mtof(84), t, 0.1, 0.05, this.sfxGain, 'sine');
      this._pluck(mtof(91), t + 0.03, 0.14, 0.03, this.sfxGain, 'sine');
    }

    countBeep(last) {
      if (!this.ready || this.muted) return;
      const t = this.ctx.currentTime;
      this._pluck(mtof(last ? 81 : 69), t, last ? 0.7 : 0.24, 0.1, this.sfxGain, 'triangle');
      if (last) this._pluck(mtof(88), t + 0.04, 0.6, 0.06, this.sfxGain, 'sine');
    }

    /* ── mute ──────────────────────────────────────────────── */
    setMuted(m) {
      this.muted = m;
      U.Store.set('pa_muted', m);
      if (this.ready) this.master.gain.setTargetAtTime(m ? 0 : 0.9, this.ctx.currentTime, 0.06);
      return m;
    }
    toggleMute() { return this.setMuted(!this.muted); }
  }

  global.AudioManager = AudioManager;
})(window);
