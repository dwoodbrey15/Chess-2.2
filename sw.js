// Offline support for the web version: every file the game needs is stored on first visit, then served
// from the device. Changing VERSION (the build script does it) makes phones fetch the new files once.
const VERSION = 'chess2-20261112-162105';
const FILES = ['./', 'index.html', 'app.js', 'pieces.js', 'worker.js', 'style.css', 'engine.wasm',
  'manifest.webmanifest', 'icon-180.png', 'icon-192.png', 'icon-512.png'];

const DEV = VERSION.endsWith('-dev');   // the unbuilt source folder: never cache, so edits show at once

self.addEventListener('install', e => {
  if (DEV) { self.skipWaiting(); return; }
  e.waitUntil(caches.open(VERSION).then(c => c.addAll(FILES.map(f => new Request(f, { cache: 'reload' })))).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== VERSION).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});

// Cached files first (they never change within a version); the network only for anything else.
self.addEventListener('fetch', e => {
  if (DEV || e.request.method !== 'GET') return;
  e.respondWith((async () => {
    const cache = await caches.open(VERSION);
    const hit = e.request.mode === 'navigate'
      ? await cache.match('index.html')
      : await cache.match(e.request, { ignoreSearch: true });
    return hit || fetch(e.request);
  })());
});
