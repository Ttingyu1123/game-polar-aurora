/* Audio proof-of-life. "The AudioContext exists" proves nothing — a graph
   can be fully wired and still emit silence. We tap an AnalyserNode on the
   master bus and measure real RMS while the game plays. */
const { chromium } = require('playwright');
const path = require('path');
const ROOT = require('path').resolve(__dirname, '..');
const url = 'file:///' + path.join(ROOT, 'index.html').split(path.sep).join('/');

(async () => {
  const b = await chromium.launch({
    headless: false,
    args: ['--autoplay-policy=no-user-gesture-required', '--enable-gpu-rasterization']
  });
  const p = await b.newPage({ viewport: { width: 1280, height: 800 } });
  p.on('pageerror', (e) => console.log('ERR', e.message));
  await p.goto(url, { waitUntil: 'load' });
  await p.waitForTimeout(500);
  await p.click('#btnPlay');
  await p.waitForFunction(() => window.__game.fsm.current === 'playing', { timeout: 12000 });
  await p.waitForTimeout(400);

  const r = await p.evaluate(async () => {
    const a = window.__game.audio;
    if (!a.ready) return { fatal: 'AudioManager never initialised' };
    const ctx = a.ctx;
    if (ctx.state === 'suspended') await ctx.resume();

    // Tap the master bus, upstream of the compressor.
    const an = ctx.createAnalyser();
    an.fftSize = 2048;
    a.master.connect(an);
    const buf = new Float32Array(an.fftSize);
    const rms = () => {
      an.getFloatTimeDomainData(buf);
      let s = 0;
      for (let i = 0; i < buf.length; i++) s += buf[i] * buf[i];
      return Math.sqrt(s / buf.length);
    };
    const peakOver = async (ms) => {
      let peak = 0;
      const t0 = performance.now();
      while (performance.now() - t0 < ms) {
        peak = Math.max(peak, rms());
        await new Promise((r) => setTimeout(r, 12));
      }
      return peak;
    };

    const out = { state: ctx.state, sampleRate: ctx.sampleRate };
    out.irLength = a.verb.buffer ? a.verb.buffer.length : 0;
    out.noiseLength = a._noise ? a._noise.length : 0;

    // Ambient bed (wind + music) with nothing else happening.
    a.setWind(0.8);
    out.bed = await peakOver(700);

    // Individual one-shots, measured against a quiet floor.
    // NB: setWind(0) intentionally leaves an ambient breeze (~0.06 gain) —
    // the polar plain is never truly silent — so to establish a real noise
    // floor we have to zero the wind bus itself, and wait out the 2.6 s
    // reverb tail.
    a.stopMusic(0.01);
    a.setWind(0);
    a.windGain.gain.cancelScheduledValues(ctx.currentTime);
    a.windGain.gain.setValueAtTime(0, ctx.currentTime);
    await new Promise((r) => setTimeout(r, 3000));
    out.silence = await peakOver(300);

    const shot = async (name) => {
      a[name]();
      return await peakOver(420);
    };
    out.jump = await shot('jump');
    // The reverb tail runs ~2.6 s; wait it out before measuring the next
    // one-shot or the pre-check reads the previous sound's tail.
    await new Promise((r) => setTimeout(r, 1200));
    a.collect(3);
    out.collect = await peakOver(400);
    await new Promise((r) => setTimeout(r, 400));
    out.hit = await shot('hit');
    await new Promise((r) => setTimeout(r, 400));
    out.golden = await shot('golden');
    await new Promise((r) => setTimeout(r, 400));
    out.land = (a.land(1), await peakOver(400));
    await new Promise((r) => setTimeout(r, 400));
    out.gameOver = await shot('gameOver');
    await new Promise((r) => setTimeout(r, 900));

    // Music must produce sustained sound, not one blip.
    a.setIntensity(0.9);
    a.intensity = 0.9;
    a.startMusic();
    await new Promise((r) => setTimeout(r, 400));
    out.music = await peakOver(2200);

    // Mute must actually silence the master.
    a.setMuted(true);
    await new Promise((r) => setTimeout(r, 400));
    out.muted = await peakOver(700);
    a.setMuted(false);
    await new Promise((r) => setTimeout(r, 300));
    out.unmuted = await peakOver(900);
    return out;
  });

  if (r.fatal) { console.log('FATAL: ' + r.fatal); process.exit(1); }

  const results = [];
  const check = (n, pass, d) => { results.push([n, pass, d]); console.log((pass ? '  PASS  ' : '  FAIL  ') + n.padEnd(34) + d); };

  check('AudioContext running', r.state === 'running', r.state + ' @ ' + r.sampleRate + 'Hz');
  check('procedural reverb IR generated', r.irLength > 10000, r.irLength + ' samples');
  check('procedural noise buffer generated', r.noiseLength > 10000, r.noiseLength + ' samples');
  check('baseline is quiet', r.silence < 0.02, 'rms ' + r.silence.toFixed(4));
  check('ambient bed (wind+music) audible', r.bed > 0.01, 'rms ' + r.bed.toFixed(4));
  check('jump sfx audible', r.jump > 0.02, 'rms ' + r.jump.toFixed(4));
  check('collect sfx audible', r.collect > 0.02, 'rms ' + r.collect.toFixed(4));
  check('land sfx audible', r.land > 0.02, 'rms ' + r.land.toFixed(4));
  check('golden sfx audible', r.golden > 0.02, 'rms ' + r.golden.toFixed(4));
  check('hit sfx audible', r.hit > 0.02, 'rms ' + r.hit.toFixed(4));
  check('game-over sting audible', r.gameOver > 0.02, 'rms ' + r.gameOver.toFixed(4));
  check('background music sustains', r.music > 0.02, 'rms ' + r.music.toFixed(4));
  check('mute silences output', r.muted < 0.004, 'rms ' + r.muted.toFixed(4));
  check('unmute restores output', r.unmuted > 0.01, 'rms ' + r.unmuted.toFixed(4));

  await b.close();
  const bad = results.filter((x) => !x[1]);
  console.log('\n  ' + (results.length - bad.length) + '/' + results.length + ' audio checks passed');
  process.exit(bad.length ? 1 : 0);
})();
