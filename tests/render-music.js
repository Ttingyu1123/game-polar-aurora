/* Render the game's own soundtrack to WAV with an OfflineAudioContext.
   Same chord progression, same instruments, same recipe as AudioManager —
   scheduled deterministically over N bars with intensity ramping up, so the
   promo's music IS the game's music, not a stock track. */
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const OUT = require('path').join(__dirname, '..', 'promo', 'raw', 'music.wav');
const SECONDS = 84;

const RENDER = `async (SECONDS) => {
  const SR = 44100;
  const ctx = new OfflineAudioContext(2, SR * SECONDS, SR);
  const mtof = (m) => 440 * Math.pow(2, (m - 69) / 12);
  const PROG = [
    { root: 45, chord: [45, 52, 57, 60, 64] },
    { root: 41, chord: [41, 48, 53, 57, 60] },
    { root: 48, chord: [48, 55, 60, 64, 67] },
    { root: 43, chord: [43, 50, 55, 59, 62] }
  ];
  const ARP = [0, 2, 1, 3, 2, 4, 3, 2];
  const PENTA = [0, 3, 5, 7, 10, 12, 15, 17, 19, 22, 24];
  const BPM = 124, spb = 60 / BPM, step16 = spb / 4;

  const master = ctx.createGain(); master.gain.value = 0.8;
  const comp = ctx.createDynamicsCompressor();
  comp.threshold.value = -16; comp.knee.value = 24; comp.ratio.value = 6;
  master.connect(comp); comp.connect(ctx.destination);

  // procedural reverb IR (same recipe as the game)
  const irN = (SR * 2.6) | 0;
  const ir = ctx.createBuffer(2, irN, SR);
  for (let c = 0; c < 2; c++) {
    const d = ir.getChannelData(c); let lp = 0;
    for (let i = 0; i < irN; i++) {
      const t = i / irN, env = Math.pow(1 - t, 2.4);
      const pre = i < SR * 0.012 ? i / (SR * 0.012) : 1;
      lp += ((Math.random() * 2 - 1) - lp) * 0.42;
      d[i] = lp * env * pre * 0.7;
    }
  }
  const verb = ctx.createConvolver(); verb.buffer = ir;
  const verbG = ctx.createGain(); verbG.gain.value = 0.5;
  verb.connect(verbG); verbG.connect(master);
  const music = ctx.createGain(); music.gain.value = 0.3;
  music.connect(master);
  const wet = ctx.createGain(); wet.gain.value = 0.34;
  music.connect(wet); wet.connect(verb);

  // wind bed
  const nN = SR * 3;
  const noise = ctx.createBuffer(2, nN, SR);
  for (let c = 0; c < 2; c++) {
    const d = noise.getChannelData(c); let last = 0;
    for (let i = 0; i < nN; i++) { const w = Math.random() * 2 - 1; last = (last + 0.022 * w) / 1.022; d[i] = last * 3.2; }
  }
  const wind = ctx.createBufferSource(); wind.buffer = noise; wind.loop = true;
  const bp = ctx.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = 520; bp.Q.value = 0.75;
  const wg = ctx.createGain(); wg.gain.value = 0.06;
  wind.connect(bp); bp.connect(wg); wg.connect(master);
  wind.start(0);

  const pluck = (freq, t, dur, vol, type) => {
    const o = ctx.createOscillator(), g = ctx.createGain();
    o.type = type; o.frequency.setValueAtTime(freq, t);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(vol, t + 0.006);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g); g.connect(music);
    o.start(t); o.stop(t + dur + 0.05);
    return o;
  };
  const hat = (t, vol) => {
    const s = ctx.createBufferSource(); s.buffer = noise;
    const f = ctx.createBiquadFilter(); f.type = 'highpass'; f.frequency.value = 8200;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(vol, t + 0.008);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.045);
    s.connect(f); f.connect(g); g.connect(music);
    s.start(t, Math.random() * 2, 0.1);
  };

  const steps = Math.floor((SECONDS - 3) / step16);
  for (let step = 0; step < steps; step++) {
    const t = 0.2 + step * step16;
    const bar = (step / 16) | 0, beat = step % 16;
    const P = PROG[bar % PROG.length];
    const I = Math.min(0.95, 0.25 + (step / steps) * 0.75);   // build over the video

    if (beat === 0) {                                   // pad
      const dur = spb * 4;
      const f = ctx.createBiquadFilter(); f.type = 'lowpass';
      f.frequency.setValueAtTime(360 + I * 900, t);
      f.frequency.linearRampToValueAtTime(520 + I * 1400, t + dur * 0.5);
      f.Q.value = 1.5;
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, t);
      g.gain.linearRampToValueAtTime(0.05 + I * 0.03, t + 0.5);
      g.gain.setValueAtTime(0.05 + I * 0.03, t + dur * 0.6);
      g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      f.connect(g); g.connect(music);
      for (const semi of [P.chord[0] + 12, P.chord[2], P.chord[3]]) {
        for (const det of [-7, 7]) {
          const o = ctx.createOscillator(); o.type = 'sawtooth';
          o.frequency.value = mtof(semi); o.detune.value = det;
          o.connect(f); o.start(t); o.stop(t + dur + 0.1);
        }
      }
    }
    if (beat === 0 || beat === 10) {
      const n = beat === 0 ? P.root - 12 : P.root - 5;
      pluck(mtof(n), t, 0.42, 0.11 + I * 0.05, 'triangle');
    }
    if (I > 0.18 && (beat === 0 || beat === 8)) {
      const o = pluck(90, t, 0.16, 0.14 * I, 'sine');
      o.frequency.setValueAtTime(120, t);
      o.frequency.exponentialRampToValueAtTime(46, t + 0.11);
    }
    if (I > 0.42 && beat % 2 === 1) hat(t, 0.02 * I);
    if (beat % 2 === 0) {
      const idx = ARP[(step / 2) % ARP.length];
      pluck(mtof(P.chord[idx % P.chord.length] + 12), t, 0.28, 0.03 + I * 0.028, 'triangle');
    }
    if (I > 0.55 && beat === 6 && bar % 2 === 0) {
      const n = P.root + PENTA[4 + (bar % 3)] + 24;
      pluck(mtof(n), t, 1.1, 0.035 * I, 'sine');
      pluck(mtof(n + 7), t + 0.09, 0.9, 0.022 * I, 'sine');
    }
  }
  // gentle master fade at the very end
  master.gain.setValueAtTime(0.8, SECONDS - 2.2);
  master.gain.linearRampToValueAtTime(0.0001, SECONDS - 0.1);

  const buf = await ctx.startRendering();

  // encode WAV (16-bit PCM stereo)
  const n = buf.length, ch = 2;
  const bytes = 44 + n * ch * 2;
  const ab = new ArrayBuffer(bytes), v = new DataView(ab);
  const ws = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  ws(0, 'RIFF'); v.setUint32(4, bytes - 8, true); ws(8, 'WAVE'); ws(12, 'fmt ');
  v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, ch, true);
  v.setUint32(24, SR, true); v.setUint32(28, SR * ch * 2, true);
  v.setUint16(32, ch * 2, true); v.setUint16(34, 16, true);
  ws(36, 'data'); v.setUint32(40, n * ch * 2, true);
  const L = buf.getChannelData(0), R = buf.getChannelData(1);
  let off = 44;
  for (let i = 0; i < n; i++) {
    v.setInt16(off, Math.max(-1, Math.min(1, L[i])) * 32767, true); off += 2;
    v.setInt16(off, Math.max(-1, Math.min(1, R[i])) * 32767, true); off += 2;
  }
  const blob = new Blob([ab], { type: 'audio/wav' });
  return await new Promise((res) => {
    const r = new FileReader();
    r.onload = () => res(r.result.split(',')[1]);
    r.readAsDataURL(blob);
  });
}`;

(async () => {
  const b = await chromium.launch();
  const p = await b.newPage();
  await p.goto('about:blank');
  const b64 = await p.evaluate(`(${RENDER})(${SECONDS})`);
  fs.writeFileSync(OUT, Buffer.from(b64, 'base64'));
  console.log('music → ' + OUT + '  (' + Math.round(fs.statSync(OUT).size / 1024 / 1024 * 10) / 10 + ' MB)');
  await b.close();
})();
