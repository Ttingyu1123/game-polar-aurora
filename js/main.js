/* ═══════════════════════════════════════════════════════════
   main — boot, and a visible failure mode.

   If anything throws during construction the canvas stays black and the
   player has no idea why, so we catch it and say so on screen. A silent
   black rectangle is the worst possible bug report.
   ═══════════════════════════════════════════════════════════ */
(function () {
  'use strict';

  function fail(msg, err) {
    if (window.console) console.error('[Polar Aurora]', msg, err || '');
    const menu = document.getElementById('menu');
    if (!menu) return;
    menu.innerHTML =
      '<div class="panel glass sheet" style="text-align:center">' +
      '<h2 class="sheet-title">COULD NOT START</h2>' +
      '<p style="font-size:12px;opacity:.75;line-height:1.6">' + msg + '</p>' +
      '<p style="font-size:10px;opacity:.5;font-family:monospace;word-break:break-word">' +
      String(err && err.message ? err.message : err || '') + '</p></div>';
    menu.classList.remove('hidden');
  }

  function boot() {
    const canvas = document.getElementById('game');
    if (!canvas || !canvas.getContext) return fail('This browser has no HTML5 Canvas support.');
    if (!canvas.getContext('2d')) return fail('Could not acquire a 2D drawing context.');

    try {
      const game = new window.Game(canvas);
      game.init();
      window.__game = game;              // handy in the console; harmless
    } catch (err) {
      fail('The game failed to initialise.', err);
    }
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();

  // PWA: installable + offline. Registration is best-effort — the game must
  // work identically from file:// (no SW there) and on hosts without HTTPS.
  if ('serviceWorker' in navigator &&
      (location.protocol === 'https:' || location.hostname === 'localhost')) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('sw.js').catch(() => { /* offline is a bonus, not a requirement */ });
    });
  }
})();
