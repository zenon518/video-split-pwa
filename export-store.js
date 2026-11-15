(function (root) {
  'use strict';
  async function prepare(parts, onProgress, cancelled) {
    if (!navigator.storage || !navigator.storage.getDirectory) throw new Error('このブラウザーは端末内の一時保存に対応していません。Safariを更新してお試しください。');
    var rootDir = await navigator.storage.getDirectory();
    var parent = await rootDir.getDirectoryHandle('video-split-exports', { create: true });
    var id = crypto.randomUUID();
    var dir = await parent.getDirectoryHandle(id, { create: true });
    var output = [], index = 0, offset = 0;
    try {
      for (index = 0; index < parts.length; index++) {
        var part = parts[index];
        var handle = await dir.getFileHandle(part.name, { create: true });
        if (!handle.createWritable) throw new Error('このSafariは保存方式に対応していません。最新のiOSでお試しください。');
        var writer = await handle.createWritable();
        try {
          for (offset = 0; offset < part.blob.size; offset += 4 * 1024 * 1024) {
            if (cancelled()) throw new Error('処理を中止しました。');
            var end = Math.min(offset + 4 * 1024 * 1024, part.blob.size);
            var chunk = await part.blob.slice(offset, end).arrayBuffer();
            if (chunk.byteLength !== end - offset) throw new Error('元動画を最後まで読み出せませんでした。');
            await writer.write(chunk);
            onProgress(index + 1, parts.length, end, part.blob.size);
          }
          await writer.close();
        } catch (error) {
          await writer.abort().catch(function () {});
          throw error;
        }
        var file = await handle.getFile();
        if (file.size !== part.blob.size) throw new Error('書き出しサイズが一致しません。');
        output.push(Object.assign({}, part, {
          blob: file, file: new File([file], part.name, { type: part.mime }),
          url: null, exportId: id,
          downloadUrl: './__export/' + id + '/' + encodeURIComponent(part.name)
        }));
      }
      return output;
    } catch (error) {
      await parent.removeEntry(id, { recursive: true }).catch(function () {});
      var reason = error.name === 'QuotaExceededError' ? '端末の空き容量が不足しています。' : error.message;
      var failure = new Error('パート' + (index + 1) + 'の書き出し中（約' + Math.round(offset / 1e6) + ' MB）: ' + reason);
      failure.userMessage = failure.message;
      throw failure;
    }
  }
  async function remove(id) {
    var dir = await (await navigator.storage.getDirectory()).getDirectoryHandle('video-split-exports');
    await dir.removeEntry(id, { recursive: true });
  }
  root.ExportStore = { prepare: prepare, remove: remove };
})(typeof self === 'undefined' ? globalThis : self);
