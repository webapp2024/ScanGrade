/* service worker: เก็บไฟล์หน้าสแกนไว้ในเครื่อง → เปิดได้แม้ไม่มีเน็ต (การส่งผลรอจนมีเน็ต) */
var CACHE = 'scangrade-scanner-v3';
var FILES = ['./', 'index.html', 'app.js', 'omr.js', 'sheet-layout.js', 'manifest.webmanifest', 'icon.svg'];

self.addEventListener('install', function (e) {
  e.waitUntil(caches.open(CACHE).then(function (c) { return c.addAll(FILES); }).then(function () { return self.skipWaiting(); }));
});
self.addEventListener('activate', function (e) {
  e.waitUntil(caches.keys().then(function (keys) {
    return Promise.all(keys.filter(function (k) { return k !== CACHE; }).map(function (k) { return caches.delete(k); }));
  }).then(function () { return self.clients.claim(); }));
});
self.addEventListener('fetch', function (e) {
  var req = e.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== location.origin) return; // API (POST) ไม่ผ่าน cache
  e.respondWith(
    caches.match(req).then(function (cached) {
      var fresh = fetch(req).then(function (res) {
        var copy = res.clone();
        caches.open(CACHE).then(function (c) { c.put(req, copy); });
        return res;
      }).catch(function () { return cached || caches.match('index.html'); });
      return cached || fresh;
    })
  );
});
