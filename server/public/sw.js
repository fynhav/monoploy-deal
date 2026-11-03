/* Monopoly Deal Tally: offline cache.
   Change VERSION whenever you want every device to throw away its old copy. */
const VERSION = 'v5';
const CACHE = 'deal-tally-' + VERSION;
const CORE = [
  './', 'index.html', 'manifest.webmanifest',
  'fonts/bricolage.woff', 'fonts/instrument.woff',
  'icons/icon-192.png', 'icons/icon-512.png', 'icons/icon-maskable-512.png',
  'icons/apple-touch-icon.png', 'icons/favicon-32.png'
];

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    await cache.addAll(CORE);
    self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    for (const k of await caches.keys()) {
      if (k.startsWith('deal-tally-') && k !== CACHE) await caches.delete(k);
    }
    await self.clients.claim();
  })());
});

// Answer from the cache straight away, and refresh the cached copy in the background.
self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.includes('/api/') || url.pathname === '/health') return;   // game data always goes to the server, never from the cache
  event.respondWith((async () => {
    const cache = await caches.open(CACHE);
    const key = req.mode === 'navigate' ? 'index.html' : req;
    const hit = await cache.match(key, { ignoreSearch: true });
    const refresh = fetch(req, { cache: 'no-cache' }).then((res) => {
      if (res && res.ok) cache.put(key, res.clone());
      return res;
    }).catch(() => null);
    if (hit) { event.waitUntil(refresh); return hit; }
    const res = await refresh;
    if (res) return res;
    return req.mode === 'navigate' ? (await cache.match('index.html')) || Response.error() : Response.error();
  })());
});
