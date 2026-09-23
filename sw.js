/* service worker: เก็บไฟล์หน้าสแกนไว้ในเครื่อง → เปิดได้แม้ไม่มีเน็ต (การส่งผลรอจนมีเน็ต)
 * มีเน็ต = โหลดไฟล์ใหม่จาก GitHub ก่อนเสมอ (อัปเดตถึงมือถือทันที) · ไม่มีเน็ต/ช้าเกิน 4 วินาที = ใช้ไฟล์ที่เก็บไว้ */
var CACHE = 'scangrade-scanner-v4';
var FILES = ['./', 'index.html', 'app.js', 'omr.js', 'sheet-layout.js', 'manifest.webmanifest', 'icon.svg'];

self.addEventListener('install', function (e) {
  // cache: 'reload' = ข้าม HTTP cache ของเบราว์เซอร์ (GitHub Pages ให้เก็บ 10 นาที) ไม่งั้นอาจเก็บไฟล์เก่าเข้า cache ใหม่
  e.waitUntil(caches.open(CACHE).then(function (c) {
    return c.addAll(FILES.map(function (f) { return new Request(f, { cache: 'reload' }); }));
  }).then(function () { return self.skipWaiting(); }));
});
self.addEventListener('activate', function (e) {
  e.waitUntil(caches.keys().then(function (keys) {
    return Promise.all(keys.filter(function (k) { return k !== CACHE; }).map(function (k) { return caches.delete(k); }));
  }).then(function () { return self.clients.claim(); }));
});
self.addEventListener('fetch', function (e) {
  var req = e.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== location.origin) return; // API (POST) ไม่ผ่าน cache
  e.respondWith(new Promise(function (resolve) {
    var done = false;
    var fallback = function () {
      if (done) return; done = true;
      caches.match(req).then(function (c) { return c || caches.match('index.html'); }).then(resolve);
    };
    var timer = setTimeout(fallback, 4000);
    fetch(req, { cache: 'no-cache' }).then(function (res) {
      clearTimeout(timer);
      if (res && res.ok) { var copy = res.clone(); caches.open(CACHE).then(function (c) { c.put(req, copy); }); }
      if (!done) { done = true; resolve(res); }
    }).catch(function () { clearTimeout(timer); fallback(); });
  }));
});
