(function () {
  'use strict';
  var $ = function (id) { return document.getElementById(id); };
  var input = $('file'), state = { source: null, info: null, plans: [], active: null, busy: false, finished: {} };
  function time(s) { s = Math.round(s); return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0'); }
  function size(n) { return n >= 1e9 ? (n / 1e9).toFixed(2) + ' GB' : Math.round(n / 1e6) + ' MB'; }
  function say(text, error) { $('msg').textContent = text; $('msg').hidden = !text; $('msg').className = 'msg' + (error ? ' error' : ''); }
  function status(text, error) { $('saveStatus').textContent = text; $('saveStatus').className = 'msg' + (error ? ' error' : ''); }
  function controls() {
    input.disabled = state.busy || !!state.active;
    document.querySelectorAll('input[name="mode"]').forEach(function (el) { el.disabled = state.busy || !!state.active; });
    $('clearTemporary').hidden = !state.active;
    $('clearTemporary').disabled = state.busy || !state.active || !state.active.requested;
  }
  async function hasTemporary() {
    var root = await navigator.storage.getDirectory(), dir;
    try { dir = await root.getDirectoryHandle('video-split-exports'); }
    catch (e) { if (e.name === 'NotFoundError') return false; throw e; }
    for await (var entry of dir.values()) return true;
    return false;
  }
  function leftover() {
    say('以前の一時動画が残っています。下の「一時ファイルの確認・削除」で削除してから、この画面で書き出してください。追加の動画は作っていません。', true);
  }
  async function workerReady() {
    if (!navigator.serviceWorker) throw new Error('Safariで開いてください。');
    var reg = await navigator.serviceWorker.register('sw.js');
    await reg.update();
    await navigator.serviceWorker.ready;
    for (var i = 0; i < 10; i++) {
      if (navigator.serviceWorker.controller) {
        var version = await new Promise(function (resolve) {
          var channel = new MessageChannel();
          var timer = setTimeout(function () { channel.port1.close(); resolve(null); }, 1000);
          channel.port1.onmessage = function (e) { clearTimeout(timer); channel.port1.close(); resolve(e.data); };
          navigator.serviceWorker.controller.postMessage('export-version', [channel.port2]);
        });
        if (version === 'video-split-v9') return;
      }
      await new Promise(function (resolve) { setTimeout(resolve, 300); });
    }
    throw new Error('保存処理の更新を確認できませんでした。通信を確認してページを開き直してください。');
  }
  async function analyze() {
    if (state.busy || state.active || !state.source) return;
    state.busy = true; controls(); $('result').hidden = true; state.plans = []; state.finished = {};
    say('動画の分け方を調べています。まだ一時動画は作りません。');
    try {
      if (!state.info) state.info = await VideoSplit.analyze(state.source);
      var mode = document.querySelector('input[name="mode"]:checked').value;
      var segments = VideoSplit.plan(state.info, { mode: mode, maxSec: 300 });
      var name = state.source.name.replace(/\.[^.]+$/, '').replace(/[^\w-]+/g, '_') || 'video';
      state.plans = await VideoSplit.build(state.info, segments, name);
      say('保存するパートを選んでください。1本ずつ書き出します。');
      status('①書き出す → ②ファイルに保存 → ③保存を確認して一時動画を削除');
    } catch (e) { say(e.userMessage || e.message, true); }
    finally { state.busy = false; render(); controls(); }
  }
  async function prepare(index) {
    if (state.busy || state.active) return;
    state.busy = true; controls(); render();
    try {
      await workerReady();
      if (await hasTemporary()) { leftover(); return; }
      say('パート' + (index + 1) + 'だけを書き出しています…');
      var output = await ExportStore.prepare([state.plans[index]], function (_, total, done, bytes) {
        say('パート' + (index + 1) + 'を書き出しています：' + Math.round(done / bytes * 100) + '％');
      }, function () { return false; });
      state.active = { index: index, part: output[0], requested: false };
      say('パート' + (index + 1) + 'の準備ができました。一時動画はこの1本だけです。');
      status('「ファイルに保存」を押し、Safariのダウンロード完了と保存先の動画を確認してください。');
    } catch (e) { say('パート' + (index + 1) + 'を準備できませんでした。' + (e.userMessage || e.message), true); }
    finally { state.busy = false; render(); controls(); }
  }
  async function clearActive() {
    if (!state.active || state.busy) return;
    var current = state.active;
    if (!confirm('パート' + (current.index + 1) + 'の保存先で動画を確認しましたか？この一時動画を削除します。保存中・保存失敗の場合はキャンセルしてください。')) return;
    state.busy = true; controls(); render();
    try {
      try { await ExportStore.remove(current.part.exportId); }
      catch (e) { if (e.name !== 'NotFoundError') throw e; }
      var stillExists = false;
      try {
        var root = await navigator.storage.getDirectory();
        var parent = await root.getDirectoryHandle('video-split-exports');
        await parent.getDirectoryHandle(current.part.exportId);
        stillExists = true;
      } catch (e) { if (e.name !== 'NotFoundError') throw e; }
      if (stillExists) throw new Error('一時動画の削除を確認できませんでした。');
      state.finished[current.index] = true; state.active = null;
      say('パート' + (current.index + 1) + 'の一時動画を削除しました。保存済みの動画は変更していません。');
      status('次に保存するパートを選んでください。');
    } catch (e) { status('一時動画を削除できませんでした。' + e.message, true); }
    finally { state.busy = false; render(); controls(); }
  }
  function render() {
    $('result').hidden = !state.plans.length;
    if (!state.plans.length) return;
    $('fDur').textContent = time(state.info.duration); $('fSize').textContent = size(state.source.size); $('fParts').textContent = state.plans.length + '本';
    $('timeline').textContent = ''; $('parts').textContent = '';
    state.plans.forEach(function (p, i) {
      var seg = document.createElement('div'); seg.className = 'seg'; seg.style.flex = String(p.dur) + ' 1 0'; seg.textContent = (i + 1) + ' · ' + time(p.dur); $('timeline').appendChild(seg);
      var li = document.createElement('li'); li.className = 'part';
      var info = document.createElement('div'); info.className = 'info';
      var title = document.createElement('b'); title.textContent = 'パート' + (i + 1) + '　' + time(p.dur);
      var detail = document.createElement('span'); detail.textContent = time(p.start) + ' から ・ ' + size(p.size) + (state.finished[i] ? ' ・ 保存確認済み／一時動画削除済み' : '');
      info.appendChild(title); info.appendChild(detail); li.appendChild(info);
      if (state.active && state.active.index === i) {
        if (!state.busy) {
          var link = document.createElement('a'); link.className = 'btn small'; link.href = state.active.part.downloadUrl; link.target = '_blank'; link.rel = 'noopener'; link.textContent = '② ファイルに保存';
          link.addEventListener('click', function () { state.active.requested = true; controls(); status('ダウンロードを要求しました。完了後、保存先で動画を確認してから「③ 保存を確認したので一時動画を削除」を押してください。保存の成功は自動判定できません。'); });
          li.appendChild(link);
        }
      } else {
        var button = document.createElement('button'); button.type = 'button'; button.className = 'btn small'; button.textContent = '① このパートを書き出す'; button.disabled = state.busy || !!state.active;
        button.addEventListener('click', function () { prepare(i); }); li.appendChild(button);
      }
      $('parts').appendChild(li);
    });
    $('clearTemporary').disabled = state.busy || !state.active || !state.active.requested;
  }
  input.addEventListener('click', function () { input.value = ''; });
  input.addEventListener('change', function () {
    if (state.busy || state.active) return;
    var file = input.files && input.files[0]; if (!file) return;
    if (!/\.(mp4|mov|m4v)$/i.test(file.name)) { say('MP4・MOV・M4Vを選んでください。', true); return; }
    state.source = file; state.info = null; analyze();
  });
  document.querySelectorAll('input[name="mode"]').forEach(function (el) { el.addEventListener('change', analyze); });
  $('clearTemporary').addEventListener('click', clearActive);
  $('install').hidden = window.navigator.standalone === true || (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches);
  controls();
})();
