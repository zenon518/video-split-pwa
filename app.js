(function () {
  'use strict';

  var MAX_SEC = 300;
  var $ = function (id) { return document.getElementById(id); };
  var fileInput = $('file'), msg = $('msg'), result = $('result');
  var state = { file: null, info: null, token: 0, parts: [] };
  var sharing = false;

  function fmtTime(sec) {
    sec = Math.max(0, Math.round(sec));
    var h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
    var ss = (s < 10 ? '0' : '') + s;
    if (h) return h + ':' + (m < 10 ? '0' : '') + m + ':' + ss;
    return m + ':' + ss;
  }
  function fmtSize(bytes) {
    if (bytes >= 1e9) return (bytes / 1e9).toFixed(2) + ' GB';
    return Math.max(1, Math.round(bytes / 1e6)) + ' MB';
  }
  function say(text, isError) {
    msg.hidden = !text;
    msg.textContent = text || '';
    msg.className = 'msg' + (isError ? ' error' : '');
  }
  function mode() {
    return document.querySelector('input[name="mode"]:checked').value;
  }
  function baseName(name) {
    var b = String(name || 'video').replace(/\.[^.]+$/, '').replace(/[^\w\-]+/g, '_');
    return b || 'video';
  }

  async function run() {
    if (!state.file) return;
    var token = ++state.token;
    result.hidden = true;
    say('動画を調べています…');
    try {
      if (!state.info) state.info = await VideoSplit.analyze(state.file);
      if (token !== state.token) return;
      var info = state.info;
      var segs = VideoSplit.plan(info, { mode: mode(), maxSec: MAX_SEC });

      if (mode() === 'max' && segs.length === 1) {
        say('この動画は ' + fmtTime(info.duration) + ' で、5分以内です。分ける必要はありません。');
        return;
      }
      say('分割準備ができました。');
      var built = await VideoSplit.build(info, segs, baseName(state.file.name), function (done, total) {
        if (token === state.token) {
          say(done === total ? '分割が完了しました。結果を表示しています…' :
            '分割中：' + (done + 1) + ' / ' + total + ' 本目を処理しています…');
        }
      });
      if (token !== state.token) return;
      await ensureDownloadWorker();
      var prepared = await ExportStore.prepare(built, function (part, total, done, size) {
        if (token === state.token) say('保存用ファイルを書き出しています：' + part + ' / ' + total + ' 本目・' + Math.round(done / size * 100) + '％');
      }, function () { return token !== state.token; });
      if (token !== state.token) {
        await ExportStore.remove(prepared[0].exportId);
        return;
      }
      state.parts = prepared;
      render(info, segs.length);
      var over = state.parts.some(function (p) { return p.dur > MAX_SEC; });
      say(over ? '5分を超えるパートがあります。「5分以内に自動」を選ぶと、すべて5分以内になります。' : '');
    } catch (e) {
      if (token !== state.token) return;
      state.info = null;
      say(e && e.userMessage ? e.userMessage : '動画の準備を完了できませんでした：' + (e.message || e.name || '不明なエラー'), true);
      console.error(e);
    }
  }

  async function ensureDownloadWorker() {
    if (!('serviceWorker' in navigator)) throw new Error('Safariでこのページを開いてください。');
    await navigator.serviceWorker.register('sw.js');
    await navigator.serviceWorker.ready;
    for (var attempt = 0; attempt < 8; attempt++) {
      if (navigator.serviceWorker.controller && await workerVersion()) return;
      await new Promise(function (resolve) { setTimeout(resolve, 500); });
    }
    throw new Error('保存方式を更新しています。ページを一度再読み込みしてください。');
  }
  function workerVersion() {
    return new Promise(function (resolve) {
      var channel = new MessageChannel();
      var timer = setTimeout(function () { channel.port1.close(); resolve(false); }, 1500);
      channel.port1.onmessage = function (e) { clearTimeout(timer); channel.port1.close(); resolve(e.data === 'video-split-v7'); };
      navigator.serviceWorker.controller.postMessage('export-version', [channel.port2]);
    });
  }

  function render(info, n) {
    $('fDur').textContent = fmtTime(info.duration);
    $('fSize').textContent = fmtSize(state.file.size);
    $('fParts').textContent = n + '本';

    var tl = $('timeline');
    tl.textContent = '';
    state.parts.forEach(function (p, i) {
      var d = document.createElement('div');
      d.className = 'seg';
      d.style.flex = String(p.dur) + ' 1 0';
      d.textContent = (i + 1) + ' · ' + fmtTime(p.dur);
      tl.appendChild(d);
    });

    var ul = $('parts');
    ul.textContent = '';
    state.parts.forEach(function (p, i) {
      var li = document.createElement('li');
      li.className = 'part';
      var info2 = document.createElement('div');
      info2.className = 'info';
      var b = document.createElement('b');
      b.textContent = 'パート' + (i + 1) + '　' + fmtTime(p.dur);
      var s = document.createElement('span');
      s.textContent = fmtTime(p.start) + ' から ・ ' + fmtSize(p.size);
      info2.appendChild(b); info2.appendChild(s);
      if (!p.url) p.url = URL.createObjectURL(p.blob);
      var actions = document.createElement('div');
      actions.className = 'save-actions';
      var download = document.createElement('a');
      download.className = 'btn small';
      download.href = p.downloadUrl;
      download.target = '_blank';
      download.rel = 'noopener';
      download.textContent = 'ファイルに保存';
      download.addEventListener('click', function () {
        saveStatus('パート' + (i + 1) + 'のダウンロードを要求しました。Safariのダウンロード一覧をご確認ください。反応がない場合は「動画を開く」をお試しください。');
      });
      actions.appendChild(download);
      var preview = document.createElement('a');
      preview.href = p.url;
      preview.target = '_blank';
      preview.rel = 'noopener';
      preview.textContent = '動画を開く';
      var btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'btn ghost small';
      btn.textContent = '共有して保存';
      btn.addEventListener('click', function () { save([p]); });
      actions.appendChild(btn);
      actions.appendChild(preview);
      li.appendChild(info2); li.appendChild(actions);
      ul.appendChild(li);
    });
    $('saveAll').textContent = n + '本をまとめて共有';
    saveStatus('各パートの「ファイルに保存」で1本ずつ保存できます。写真アプリに入れる場合は「共有して保存」を押してください。');
    result.hidden = false;
  }

  function saveStatus(text, isError) {
    var status = $('saveStatus');
    status.hidden = !text;
    status.textContent = text || '';
    status.className = 'msg' + (isError ? ' error' : '');
  }

  // 共有とダウンロードは独立させる。失敗後に自動クリックしない。
  async function save(parts) {
    if (!parts.length) {
      saveStatus('保存する動画がありません。動画を選び直してください。', true);
      return;
    }
    if (sharing) {
      saveStatus('共有画面を準備中です。開いている共有画面を閉じるか、「ファイルに保存」をお使いください。');
      return;
    }
    var token = state.token;
    var files = parts.map(function (p) { return p.file; });
    try {
      if (!navigator.share || !navigator.canShare || !navigator.canShare({ files: files })) {
        saveStatus('この環境ではこの動画を共有できません。各パートの「ファイルに保存」、または「動画を開く」をお使いください。', true);
        return;
      }
      sharing = true;
      saveStatus('共有画面を開いています。表示されない場合は「ファイルに保存」をお使いください。');
      await navigator.share({ files: files });
      if (token === state.token) saveStatus('共有画面の操作が終了しました。選択した保存先で動画をご確認ください。');
    } catch (e) {
      if (token !== state.token) return;
      var code = e && e.name ? e.name : 'Error';
      saveStatus(code === 'AbortError' ?
        '共有が中断されました。保存は確認できていません。「ファイルに保存」なら共有画面を使わずに保存できます。' :
        '共有画面を開けませんでした（' + code + '）。各パートの「ファイルに保存」をお使いください。', true);
      console.error(e);
    } finally {
      sharing = false;
    }
  }

  // iPhoneの「ファイル」からMP4/MOV/M4Vを選ぶ。写真ライブラリ経由は不要。
  fileInput.addEventListener('click', function () {
    // 同じ動画の再選択でも change が届くようにする。
    fileInput.value = '';
    say('「ファイル」から動画を選んでください。選択後、自動で解析を開始します。');
  });
  fileInput.addEventListener('cancel', function () {
    say('ファイルが選択されませんでした。分割処理は開始していません。', true);
  });
  fileInput.addEventListener('input', function () {
    // OSがchangeを通知する前でも、選択状態が分かるようにする。
    if (fileInput.files && fileInput.files.length) {
      var selected = fileInput.files[0];
      say('動画の選択を受け取りました：' + selected.name + '（' + fmtSize(selected.size) + '）');
    }
  });
  fileInput.addEventListener('change', function () {
    var f = fileInput.files && fileInput.files[0];
    if (!f) {
      say('ファイルを受け取れませんでした。分割処理はまだ始まっていません。', true);
      return;
    }
    // accept を付けないことでiOSのファイルブラウザを使いやすくする。
    // 代わりにアプリ内で動画形式を確認する。
    if (!/\.(mp4|mov|m4v)$/i.test(f.name) &&
        !/^(video\/mp4|video\/quicktime|video\/x-m4v)$/i.test(f.type)) {
      say('MP4・MOV・M4Vの動画ファイルを選んでください。', true);
      return;
    }
    state.parts.forEach(function (p) { if (p.url) URL.revokeObjectURL(p.url); });
    state.parts = []; state.info = null; state.file = f;
    say('動画を受け取りました：' + f.name + '（' + fmtSize(f.size) + '）。解析します…');
    run();
  });
  Array.prototype.forEach.call(document.querySelectorAll('input[name="mode"]'), function (r) {
    r.addEventListener('change', run);
  });
  $('clearTemporary').addEventListener('click', async function () {
    if (!state.parts.length) return;
    if (!confirm('全パートの保存が完了していますか？この画面の一時動画を削除します。保存中の場合はキャンセルしてください。')) return;
    try {
      await ExportStore.remove(state.parts[0].exportId);
      state.parts.forEach(function (p) { if (p.url) URL.revokeObjectURL(p.url); });
      state.parts = [];
      result.hidden = true;
      say('この画面で作成した一時動画を削除しました。');
    } catch (e) { saveStatus('一時動画を削除できませんでした。', true); }
  });
  $('saveAll').addEventListener('click', function () { save(state.parts); });

  // ホーム画面に追加済みなら案内を隠す
  var standalone = window.navigator.standalone === true ||
    (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches);
  $('install').hidden = standalone;

  if ('serviceWorker' in navigator) {
    window.addEventListener('load', function () {
      navigator.serviceWorker.register('sw.js').catch(function () {});
    });
  }
})();
