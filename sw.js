/* Polar Aurora service worker — offline play + installability.
 *
 * Strategy: NETWORK-FIRST with cache fallback, for everything.
 * The game is 20-odd small files with no build step and no content hashes,
 * so cache-first would pin players to a stale build until the cache name
 * changes. Network-first means: online users always get the newest deploy,
 * offline users get the last one they played. Bump VERSION on deploys that
 * must invalidate old caches promptly.
 */
const VERSION = 'pa-v2.0.0';
const CACHE = 'polar-aurora-' + VERSION;

const ASSETS = [
  './',
  'index.html',
  'manifest.webmanifest',
  'css/style.css',
  'js/Utils.js', 'js/StateMachine.js', 'js/Progress.js', 'js/Biomes.js',
  'js/Camera.js', 'js/InputManager.js', 'js/AudioManager.js',
  'js/ParticleSystem.js', 'js/BackgroundRenderer.js', 'js/GroundRenderer.js',
  'js/Player.js', 'js/ObstacleManager.js', 'js/CollectibleManager.js',
  'js/CollisionSystem.js', 'js/UIManager.js', 'js/Renderer.js',
  'js/Game.js', 'js/main.js',
  'icons/icon-192.png', 'icons/icon-512.png', 'icons/icon-maskable-512.png',
  'icons/icon-180.png'
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE).then((c) => c.addAll(ASSETS)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== location.origin) return;

  e.respondWith(
    fetch(req)
      .then((res) => {
        if (res && res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(req, copy));
        }
        return res;
      })
      .catch(() =>
        caches.match(req).then((hit) =>
          hit || (req.mode === 'navigate' ? caches.match('./') : Response.error())
        )
      )
  );
});
