(function (root) {
  'use strict';
  // This function is serialized into a dedicated worker; it has no outer dependencies.
  function writerWorker() {
    var stopped = false;
    self.onmessage = async function (event) {
      if (event.data.cancel) { stopped = true; return; }
      var job = event.data, parent, access, lease, index = 0, offset = 0, stage = '一時保存の準備';
      var BLOCK = 256 * 1024;
      try {
        var rootDir = await navigator.storage.getDirectory();
        var leaseFile = await rootDir.getFileHandle('video-split-export.lock', { create: true });
        lease = await leaseFile.createSyncAccessHandle();
        parent = await rootDir.getDirectoryHandle('video-split-exports', { create: true });
        for await (var entry of parent.values()) throw new Error('以前の一時動画が残っています。「一時ファイルの確認・削除」で削除してください。');
        var dir = await parent.getDirectoryHandle(job.id, { create: true });
        var reader = new FileReaderSync();
        for (index = 0; index < job.parts.length; index++) {
          offset = 0;
          var part = job.parts[index];
          stage = '保存先を開く';
          var handle = await dir.getFileHandle(part.name, { create: true });
          access = await handle.createSyncAccessHandle();
          await access.truncate(0);
          async function write(bytes) {
            stage = '端末への書き込み';
            var pos = 0;
            while (pos < bytes.byteLength) {
              var count = await access.write(bytes.subarray(pos), { at: offset });
              if (!(count > 0 && count <= bytes.byteLength - pos)) throw new Error('書き込みが進みませんでした。');
              pos += count; offset += count;
            }
          }
          for (var h = 0; h < part.headers.length; h++) {
            for (var p = 0; p < part.headers[h].byteLength; p += BLOCK) {
              await write(part.headers[h].subarray(p, p + BLOCK));
            }
          }
          var lastReport = 0;
          for (var r = 0; r < part.ranges.length; r++) {
            var range = part.ranges[r];
            if (range[0] < 0 || range[1] > job.source.size || range[1] < range[0]) throw new Error('元動画の範囲外です。');
            for (var start = range[0]; start < range[1]; start += BLOCK) {
              if (stopped) throw new Error('処理を中止しました。');
              stage = '元動画の読み出し';
              var end = Math.min(start + BLOCK, range[1]);
              var bytes = new Uint8Array(reader.readAsArrayBuffer(job.source.slice(start, end)));
              if (bytes.byteLength !== end - start) throw new Error('元動画を最後まで読み出せませんでした。');
              await write(bytes);
              bytes = null;
              if (offset - lastReport >= 1024 * 1024) {
                self.postMessage({ progress: true, part: index + 1, total: job.parts.length, done: offset, size: part.size });
                lastReport = offset;
                // Yield so cancellation can be delivered; only one bounded read/write is in flight.
                await new Promise(function (resolve) { setTimeout(resolve, 0); });
              }
            }
          }
          stage = '書き込みの確定';
          if (stopped) throw new Error('処理を中止しました。');
          if (offset !== part.size) throw new Error('書き出しサイズが一致しません。');
          await access.flush();
          await access.close(); access = null;
          self.postMessage({ progress: true, part: index + 1, total: job.parts.length, done: offset, size: part.size });
        }
        await lease.close(); lease = null;
        self.postMessage({ complete: true });
      } catch (error) {
        if (access) { try { await access.close(); } catch (_) {} }
        if (lease) { try { await lease.close(); } catch (_) {} }
        if (parent) { try { await parent.removeEntry(job.id, { recursive: true }); } catch (_) {} }
        self.postMessage({ error: true, name: error.name, message: error.message, stage: stage, part: index + 1, offset: offset });
      }
    };
  }
  async function prepare(parts, onProgress, cancelled) {
    if (parts.length !== 1) throw new Error('書き出せる一時動画は1本だけです。');
    if (!navigator.storage || !navigator.storage.getDirectory || typeof Worker === 'undefined') throw new Error('このブラウザーでは端末内の保存処理を開始できません。');
    var id = crypto.randomUUID();
    var worker, timer, workerURL;
    try {
      await new Promise(function (resolve, reject) {
        workerURL = URL.createObjectURL(new Blob(['(' + writerWorker.toString() + ')();'], { type: 'text/javascript' }));
        worker = new Worker(workerURL);
        worker.onerror = function (e) { reject(new Error('保存処理でエラーが発生しました：' + (e.message || 'Worker error'))); };
        worker.onmessage = function (event) {
          var data = event.data;
          if (data.progress) onProgress(data.part, data.total, data.done, data.size);
          else if (data.complete) resolve();
          else if (data.error) {
            var reason = data.name === 'QuotaExceededError' ? '端末の保存領域が不足しています。' : data.name + ': ' + data.message;
            reject(new Error('パート' + data.part + '／' + data.stage + '（約' + Math.round(data.offset / 1e6) + ' MB）：' + reason));
          }
        };
        timer = setInterval(function () { if (cancelled()) worker.postMessage({ cancel: true }); }, 100);
        worker.postMessage({ id: id, source: parts[0].source, parts: parts.map(function (p) {
          return { name: p.name, headers: p.headers, ranges: p.ranges, size: p.size };
        }) });
      });
      if (cancelled()) throw new Error('処理を中止しました。');
      var parent = await (await navigator.storage.getDirectory()).getDirectoryHandle('video-split-exports');
      var dir = await parent.getDirectoryHandle(id), output = [];
      for (var i = 0; i < parts.length; i++) {
        var part = parts[i], file = await (await dir.getFileHandle(part.name)).getFile();
        if (file.size !== part.size) throw new Error('パート' + (i + 1) + 'の書き出しサイズが一致しません。');
        output.push({ name: part.name, mime: part.mime, start: part.start, dur: part.dur, size: part.size,
          blob: file, file: new File([file], part.name, { type: part.mime }), url: null, exportId: id,
          downloadUrl: './__export/' + id + '/' + encodeURIComponent(part.name) });
      }
      return output;
    } catch (error) {
      if (worker) worker.terminate();
      await remove(id).catch(function () {});
      error.userMessage = error.message;
      throw error;
    } finally {
      clearInterval(timer);
      if (worker) worker.terminate();
      if (workerURL) URL.revokeObjectURL(workerURL);
    }
  }
  async function remove(id) {
    var dir = await (await navigator.storage.getDirectory()).getDirectoryHandle('video-split-exports');
    await dir.removeEntry(id, { recursive: true });
  }
  root.ExportStore = { prepare: prepare, remove: remove };
})(typeof self === 'undefined' ? globalThis : self);
