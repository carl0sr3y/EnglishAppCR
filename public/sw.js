'use strict';
// Servicio de la app instalable.
// - Archivos de la app: primero la red (así siempre ves la versión más nueva) y, si no hay conexión, la copia guardada.
// - Datos (/api) y administración (/admin): nunca se guardan; siempre van a la red.
const CACHE = 'tarjetas-v3';
const PRECACHE = ['/offline.html', '/styles.css', '/common.js', '/speech.js', '/icons/icon.svg', '/icons/icon-192.png'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(PRECACHE)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  const req = e.request;
  const url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/admin') || url.pathname === '/sw.js') return;

  e.respondWith((async () => {
    try {
      const res = await fetch(req);
      const cacheable = res.ok && (req.mode !== 'navigate' || url.pathname === '/');
      if (cacheable) { const copy = res.clone(); caches.open(CACHE).then(c => c.put(req, copy)); }
      return res;
    } catch (err) {
      const cached = await caches.match(req, { ignoreSearch: true });
      if (cached) return cached;
      if (req.mode === 'navigate') return caches.match('/offline.html');
      throw err;
    }
  })());
});
