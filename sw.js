/* アルノポケット — 圏外でも開けるようにするための控え
 * 方針は network-first。更新をすぐ拾い、つながらないときだけ控えを出す。
 */
const CACHE = 'arumo-v1';
const ASSETS = [
  './', './index.html', './manifest.webmanifest', './icon-180.png',
  './css/tokens.css', './css/app.css',
  './js/data.js', './js/sync.js', './js/ui.js', './js/app.js',
  './assets/logo-mark.svg',
];

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE)
      .then(c => Promise.allSettled(ASSETS.map(u => c.add(u))))   // 1つ失敗しても導入は止めない
      .then(() => self.skipWaiting())
  );
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys()
    .then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});
self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return;
  e.respondWith(
    fetch(e.request)
      .then(res => {
        const copy = res.clone();
        caches.open(CACHE).then(c => c.put(e.request, copy)).catch(() => {});
        return res;
      })
      .catch(() => caches.match(e.request).then(r => r || caches.match('./index.html')))
  );
});
