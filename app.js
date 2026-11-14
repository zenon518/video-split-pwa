(function () {
  'use strict';

  var MAX_SEC = 300;
  var $ = function (id) { return document.getElementById(id); };
  var fileInput = $('file'), msg = $('msg'), result = $('result');
  var state = { file: null, info: null, token: 0, parts: [] };

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
      state.parts = built.map(function (p) {
        return { file: new File([p.blob], p.name, { type: p.mime }), blob: p.blob, name: p.name, start: p.start, dur: p.dur, size: p.size, url: null };
      });
      render(info, segs.length);
      var over = state.parts.some(function (p) { return p.dur > MAX_SEC; });
      say(over ? '5分を超えるパートがあります。「5分以内に自動」を選ぶと、すべて5分以内になります。' : '');
    } catch (e) {
      if (token !== state.token) return;
      state.info = null;
      say(e && e.userMessage ? e.userMessage : '分割できませんでした。別の動画で試してください。', true);
      console.error(e);
    }
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
      var btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'btn ghost small';
      btn.textContent = '保存';
      btn.addEventListener('click', function () { save([p]); });
      li.appendChild(info2); li.appendChild(btn);
      ul.appendChild(li);
    });
    $('saveAll').textContent = n + '本をまとめて保存';
    result.hidden = false;
  }

  // 共有画面を開く。開けない環境ではファイルとしてダウンロードする。
  async function save(parts) {
    var files = parts.map(function (p) { return p.file; });
    try {
      if (navigator.canShare && navigator.canShare({ files: files })) {
        await navigator.share({ files: files });
        return;
      }
    } catch (e) {
      if (e && e.name === 'AbortError') return;
      console.error(e);
    }
    parts.forEach(function (p, i) {
      setTimeout(function () {
        if (!p.url) p.url = URL.createObjectURL(p.blob);
        var a = document.createElement('a');
        a.href = p.url; a.download = p.name;
        document.body.appendChild(a); a.click(); a.remove();
      }, i * 400);
    });
    say('ファイルとして保存しました。「ファイル」アプリを確認してください。');
  }

  fileInput.addEventListener('change', function () {
    var f = fileInput.files && fileInput.files[0];
    if (!f) return;
    state.parts.forEach(function (p) { if (p.url) URL.revokeObjectURL(p.url); });
    state.parts = []; state.info = null; state.file = f;
    run();
  });
  Array.prototype.forEach.call(document.querySelectorAll('input[name="mode"]'), function (r) {
    r.addEventListener('change', run);
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
