var CACHE = 'video-split-v9';
var FILES = ['./', 'index.html', 'app.js?v=9', 'split.js?v=9', 'export-store.js?v=9',
  'manifest.webmanifest', 'icon-192.png', 'icon-512.png', 'apple-touch-icon.png'];
self.addEventListener('install', function (e) {
  e.waitUntil(caches.open(CACHE).then(function (c) { return c.addAll(FILES); }).then(function () { return self.skipWaiting(); }));
});
self.addEventListener('activate', function (e) {
  e.waitUntil(caches.keys().then(function (keys) {
    return Promise.all(keys.filter(function (k) { return k.indexOf('video-split-') === 0 && k !== CACHE; }).map(function (k) { return caches.delete(k); }));
  }).then(function () { return self.clients.claim(); }));
});
// Download revision v8.1: bounded reads and resumable byte ranges.
function byteRange(value, size) {
  if (!value) return null;
  var match = /^bytes=(\d*)-(\d*)$/.exec(value.trim());
  // Ignore unsupported/malformed or multipart ranges, returning a full 200 response.
  if (!match || (!match[1] && !match[2])) return null;
  var start, end;
  if (!match[1]) {
    var suffix = Number(match[2]);
    if (!Number.isSafeInteger(suffix) || suffix === 0 || size === 0) return false;
    start = Math.max(0, size - suffix); end = size - 1;
  } else {
    start = Number(match[1]); end = match[2] ? Number(match[2]) : size - 1;
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || end < start || start >= size) return false;
    end = Math.min(end, size - 1);
  }
  return { start: start, end: end };
}
function downloadStream(file, start, end) {
  var position = start, stopped = false;
  return new ReadableStream({
    async pull(controller) {
      if (stopped) return;
      if (position >= end) { stopped = true; controller.close(); return; }
      try {
        var next = Math.min(position + 256 * 1024, end);
        var buffer = await file.slice(position, next).arrayBuffer();
        if (stopped) return;
        if (buffer.byteLength !== next - position) throw new Error('Incomplete video read');
        position = next;
        controller.enqueue(new Uint8Array(buffer));
        if (position >= end) { stopped = true; controller.close(); }
      } catch (error) {
        if (!stopped) { stopped = true; controller.error(error); }
      }
    },
    cancel() { stopped = true; file = null; }
  }, { highWaterMark: 0 });
}
async function exportFile(path, request) {
  var file, bits, name;
  try {
    bits = path.split('/');
    if (bits.length !== 2 || !/^[a-f0-9-]{36}$/.test(bits[0])) throw new Error('Invalid export');
    name = decodeURIComponent(bits[1]);
    if (!name || /[\/\\\r\n]/.test(name)) throw new Error('Invalid filename');
    var root = await navigator.storage.getDirectory();
    var parent = await root.getDirectoryHandle('video-split-exports');
    var dir = await parent.getDirectoryHandle(bits[0]);
    file = await (await dir.getFileHandle(name)).getFile();
  } catch (error) {
    return new Response('保存用の一時動画が見つかりません。元の画面で動画を選び直してください。', { status: 404, headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' } });
  }
  // Every export directory has a fresh UUID and its files are immutable after close.
  var etag = '"' + bits[0] + '-' + encodeURIComponent(name) + '-' + file.size + '"';
  var headers = {
    'Content-Type': 'application/octet-stream',
    'Content-Disposition': "attachment; filename*=UTF-8''" + encodeURIComponent(name),
    'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
    'Accept-Ranges': 'bytes', 'ETag': etag
  };
  var value = request && request.method !== 'HEAD' ? request.headers.get('Range') : null;
  var ifRange = request && request.headers.get('If-Range');
  if (ifRange && ifRange !== etag) value = null;
  var range = byteRange(value, file.size);
  if (range === false) {
    headers['Content-Range'] = 'bytes */' + file.size;
    headers['Content-Length'] = '0';
    return new Response(null, { status: 416, headers: headers });
  }
  var start = range ? range.start : 0, end = range ? range.end + 1 : file.size;
  headers['Content-Length'] = String(end - start);
  if (range) headers['Content-Range'] = 'bytes ' + start + '-' + (end - 1) + '/' + file.size;
  return new Response(request && request.method === 'HEAD' ? null : downloadStream(file, start, end), {
    status: range ? 206 : 200, headers: headers
  });
}
self.addEventListener('fetch', function (e) {
  if (e.request.method !== 'GET' && e.request.method !== 'HEAD') return;
  var url = new URL(e.request.url), scope = new URL(self.registration.scope);
  if (url.origin !== scope.origin) return;
  var prefix = scope.pathname + '__export/';
  if (url.pathname.indexOf(prefix) === 0) {
    e.respondWith(exportFile(url.pathname.slice(prefix.length), e.request));
    return;
  }
  e.respondWith(fetch(e.request).then(function (res) {
    if (e.request.method === 'GET' && res.ok && FILES.some(function (f) { return new URL(f, scope).pathname === url.pathname; })) {
      var copy = res.clone();
      e.waitUntil(caches.open(CACHE).then(function (c) { return c.put(e.request, copy); }).catch(function () {}));
    }
    return res;
  }).catch(function () { return caches.match(e.request).then(function (r) { return r || (e.request.mode === 'navigate' ? caches.match('index.html') : Response.error()); }); }));
});

self.addEventListener('message', function (e) { if (e.data === 'export-version' && e.ports[0]) e.ports[0].postMessage(CACHE); });
