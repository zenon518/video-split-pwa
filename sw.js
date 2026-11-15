var CACHE = 'video-split-v7';
var FILES = ['./', 'index.html', 'app.js?v=7', 'split.js?v=7', 'export-store.js?v=7',
  'manifest.webmanifest', 'icon-192.png', 'icon-512.png', 'apple-touch-icon.png'];
self.addEventListener('install', function (e) {
  e.waitUntil(caches.open(CACHE).then(function (c) { return c.addAll(FILES); }).then(function () { return self.skipWaiting(); }));
});
self.addEventListener('activate', function (e) {
  e.waitUntil(caches.keys().then(function (keys) {
    return Promise.all(keys.filter(function (k) { return k.indexOf('video-split-') === 0 && k !== CACHE; }).map(function (k) { return caches.delete(k); }));
  }).then(function () { return self.clients.claim(); }));
});
async function exportFile(path) {
  try {
    var bits = path.split('/');
    if (bits.length !== 2 || !/^[a-f0-9-]{36}$/.test(bits[0])) throw new Error('Invalid export');
    var name = decodeURIComponent(bits[1]);
    if (!name || /[\/\\\r\n]/.test(name)) throw new Error('Invalid filename');
    var root = await navigator.storage.getDirectory();
    var parent = await root.getDirectoryHandle('video-split-exports');
    var dir = await parent.getDirectoryHandle(bits[0]);
    var file = await (await dir.getFileHandle(name)).getFile();
    return new Response(file.stream(), { headers: {
      'Content-Type': 'application/octet-stream',
      'Content-Length': String(file.size),
      'Content-Disposition': "attachment; filename*=UTF-8''" + encodeURIComponent(name),
      'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff'
    }});
  } catch (error) {
    return new Response('保存用の一時動画が見つかりません。元の画面で動画を選び直してください。', { status: 404, headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' } });
  }
}
self.addEventListener('fetch', function (e) {
  if (e.request.method !== 'GET') return;
  var url = new URL(e.request.url), scope = new URL(self.registration.scope);
  if (url.origin !== scope.origin) return;
  var prefix = scope.pathname + '__export/';
  if (url.pathname.indexOf(prefix) === 0) {
    e.respondWith(exportFile(url.pathname.slice(prefix.length)));
    return;
  }
  e.respondWith(fetch(e.request).then(function (res) {
    if (res.ok && FILES.some(function (f) { return new URL(f, scope).pathname === url.pathname; })) {
      var copy = res.clone();
      e.waitUntil(caches.open(CACHE).then(function (c) { return c.put(e.request, copy); }).catch(function () {}));
    }
    return res;
  }).catch(function () { return caches.match(e.request).then(function (r) { return r || (e.request.mode === 'navigate' ? caches.match('index.html') : Response.error()); }); }));
});

self.addEventListener('message', function (e) { if (e.data === 'export-version' && e.ports[0]) e.ports[0].postMessage(CACHE); });
