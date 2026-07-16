/* PWA icons, generated procedurally in canvas — the game's own aesthetic
   (aurora sky, penguin face, red scarf), no image editor involved. */
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const OUT = require('path').join(__dirname, '..', 'icons');

const DRAW = `(pad) => {
  const c = document.createElement('canvas');
  c.width = 512; c.height = 512;
  const x = c.getContext('2d');
  const TAU = Math.PI * 2;

  // pad>0 → maskable: content shrunk into the safe zone, bg fills the bleed.
  const S = 512, cx = S/2;
  // Sky
  const bg = x.createLinearGradient(0, 0, 0, S);
  bg.addColorStop(0, '#0a1c33'); bg.addColorStop(0.55, '#0d2440'); bg.addColorStop(1, '#123054');
  x.fillStyle = bg; x.fillRect(0, 0, S, S);
  // Aurora ribbons
  x.globalCompositeOperation = 'lighter';
  for (const [hue, y0, amp, alpha] of [[160, 118, 30, 0.55], [190, 165, 24, 0.4], [280, 88, 20, 0.3]]) {
    const g = x.createLinearGradient(0, y0 - 70, 0, y0 + 60);
    g.addColorStop(0, 'hsla(' + hue + ',85%,62%,0)');
    g.addColorStop(0.6, 'hsla(' + hue + ',85%,60%,' + alpha + ')');
    g.addColorStop(1, 'hsla(' + hue + ',90%,70%,0)');
    x.fillStyle = g;
    x.beginPath();
    x.moveTo(0, y0);
    for (let i = 0; i <= 24; i++) {
      const px = i / 24 * S;
      x.lineTo(px, y0 + Math.sin(i * 0.55 + hue) * amp);
    }
    x.lineTo(S, y0 - 90); x.lineTo(0, y0 - 90);
    x.closePath(); x.fill();
  }
  x.globalCompositeOperation = 'source-over';

  // Penguin head roundel
  const k = pad ? 0.78 : 1;             // maskable safe-zone shrink
  const hy = 300, hr = 168 * k;
  x.save();
  x.translate(cx, hy); x.scale(k, k); x.translate(-cx, -hy);

  // head
  const hg = x.createRadialGradient(cx - 55, hy - 70, 20, cx, hy, 185);
  hg.addColorStop(0, '#2c4468'); hg.addColorStop(0.55, '#1a2a46'); hg.addColorStop(1, '#0e1930');
  x.fillStyle = hg;
  x.beginPath(); x.arc(cx, hy, 168, 0, TAU); x.fill();

  // cheeks
  for (const sx of [-1, 1]) {
    const g = x.createRadialGradient(cx + sx * 78, hy + 10, 5, cx + sx * 78, hy + 18, 95);
    g.addColorStop(0, 'rgba(240,250,255,0.96)');
    g.addColorStop(0.7, 'rgba(214,236,252,0.85)');
    g.addColorStop(1, 'rgba(190,220,244,0)');
    x.fillStyle = g;
    x.beginPath(); x.ellipse(cx + sx * 74, hy + 22, 78, 92, sx * -0.22, 0, TAU); x.fill();
  }

  // eyes
  for (const sx of [-1, 1]) {
    x.fillStyle = '#0b1524';
    x.beginPath(); x.ellipse(cx + sx * 62, hy - 18, 26, 30, 0, 0, TAU); x.fill();
    x.fillStyle = '#ffffff';
    x.beginPath(); x.arc(cx + sx * 62 - 9, hy - 28, 9, 0, TAU); x.fill();
    x.fillStyle = 'rgba(120,240,220,0.9)';
    x.beginPath(); x.arc(cx + sx * 62 + 10, hy - 8, 5, 0, TAU); x.fill();
  }

  // beak
  const bk = x.createLinearGradient(cx, hy + 8, cx, hy + 74);
  bk.addColorStop(0, '#ffb648'); bk.addColorStop(1, '#e07914');
  x.fillStyle = bk;
  x.beginPath();
  x.moveTo(cx - 34, hy + 14);
  x.quadraticCurveTo(cx, hy + 2, cx + 34, hy + 14);
  x.quadraticCurveTo(cx + 10, hy + 78, cx, hy + 80);
  x.quadraticCurveTo(cx - 10, hy + 78, cx - 34, hy + 14);
  x.fill();
  x.fillStyle = 'rgba(255,236,190,0.5)';
  x.beginPath(); x.ellipse(cx - 12, hy + 22, 13, 7, -0.4, 0, TAU); x.fill();

  // scarf band at the bottom of the roundel
  const sc = x.createLinearGradient(cx - 170, 0, cx + 170, 0);
  sc.addColorStop(0, '#a02234'); sc.addColorStop(0.45, '#e34355'); sc.addColorStop(1, '#8e1b2c');
  x.fillStyle = sc;
  x.beginPath();
  x.ellipse(cx, hy + 148, 175, 56, 0, Math.PI * 1.02, Math.PI * 1.98, true);
  x.ellipse(cx, hy + 128, 150, 40, 0, Math.PI * 1.95, Math.PI * 1.05, false);
  x.fill();
  x.restore();

  return c.toDataURL('image/png');
}`;

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const b = await chromium.launch();
  const p = await b.newPage();
  await p.goto('about:blank');

  for (const [file, pad] of [['base.png', 0], ['maskable.png', 1]]) {
    const data = await p.evaluate(`(${DRAW})(${pad})`);
    fs.writeFileSync(path.join(OUT, file), Buffer.from(data.split(',')[1], 'base64'));
  }
  await b.close();

  // Resize with PIL via a tiny python step (installed already).
  console.log('base renders written; resizing…');
})();
