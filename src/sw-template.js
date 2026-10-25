/* DMC service worker. Generated at build time: version and precache list are injected. */
const VERSION = '__VERSION__';
const CACHE = `dmc-${VERSION}`;
const PRECACHE = __PRECACHE__;

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(PRECACHE)));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith('dmc-') && k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') self.skipWaiting();
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== self.location.origin) return;
  if (req.mode === 'navigate') {
    // App shell from this version's cache, so the page always matches its cached assets.
    // New versions arrive through the service worker update and the in-app prompt.
    event.respondWith(
      caches
        .match('./', { ignoreSearch: true, ignoreVary: true })
        .then((hit) => hit || caches.match('./index.html'))
        .then((hit) => hit || fetch(req)),
    );
    return;
  }
  event.respondWith(caches.match(req, { ignoreVary: true }).then((hit) => hit || fetch(req)));
});
