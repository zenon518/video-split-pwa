/*
 * split.js — MP4 / MOV を再エンコードなしで分割する。
 * キーフレームの位置で切り、各パートは単体で再生できるファイルになる。
 * 動画データは Blob のスライスとして参照するだけなので、メモリを大きく使わない。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.VideoSplit = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var TWO32 = 4294967296;

  // ---------- 小さな道具 ----------
  function fourcc(buf, o) {
    return String.fromCharCode(buf[o], buf[o + 1], buf[o + 2], buf[o + 3]);
  }
  function setFourcc(buf, o, s) {
    for (var i = 0; i < 4; i++) buf[o + i] = s.charCodeAt(i);
  }
  function dvOf(buf) {
    return new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  }
  async function readSlice(file, start, end) {
    return new Uint8Array(await file.slice(start, end).arrayBuffer());
  }
  function concat(parts) {
    var len = 0, i;
    for (i = 0; i < parts.length; i++) len += parts[i].length;
    var out = new Uint8Array(len), o = 0;
    for (i = 0; i < parts.length; i++) { out.set(parts[i], o); o += parts[i].length; }
    return out;
  }
  function box(type, parts) {
    var body = concat(parts);
    var out = new Uint8Array(8 + body.length);
    dvOf(out).setUint32(0, out.length);
    setFourcc(out, 4, type);
    out.set(body, 8);
    return out;
  }
  function u32s(values) {
    var out = new Uint8Array(values.length * 4), dv = dvOf(out);
    for (var i = 0; i < values.length; i++) dv.setUint32(i * 4, values[i] >>> 0);
    return out;
  }
  function fail(msg) {
    var e = new Error(msg);
    e.userMessage = msg;
    return e;
  }

  // ---------- ボックスの読み取り ----------
  async function scanTop(file) {
    var boxes = [], pos = 0, len = file.size;
    while (pos + 8 <= len) {
      var h = await readSlice(file, pos, Math.min(pos + 16, len));
      var dv = dvOf(h);
      var size = dv.getUint32(0), hdr = 8, type = fourcc(h, 4);
      if (size === 1) {
        if (h.length < 16) break;
        size = Number(dv.getBigUint64(8));
        hdr = 16;
      } else if (size === 0) {
        size = len - pos;
      }
      if (size < hdr) break;
      boxes.push({ type: type, start: pos, size: size, hdr: hdr });
      pos += size;
    }
    return boxes;
  }

  function children(buf, start, end) {
    var out = [], dv = dvOf(buf), p = start;
    while (p + 8 <= end) {
      var size = dv.getUint32(p), hdr = 8;
      var type = fourcc(buf, p + 4);
      if (size === 1) { size = Number(dv.getBigUint64(p + 8)); hdr = 16; }
      else if (size === 0) size = end - p;
      if (size < hdr || p + size > end) break;
      out.push({ type: type, start: p, end: p + size, body: p + hdr });
      p += size;
    }
    return out;
  }
  function pick(list, type) {
    for (var i = 0; i < list.length; i++) if (list[i].type === type) return list[i];
    return null;
  }

  function parseTrack(buf, trak) {
    var dv = dvOf(buf);
    var tk = children(buf, trak.body, trak.end);
    var tkhd = pick(tk, 'tkhd'), mdia = pick(tk, 'mdia');
    if (!tkhd || !mdia) return null;
    var md = children(buf, mdia.body, mdia.end);
    var mdhd = pick(md, 'mdhd'), hdlr = pick(md, 'hdlr'), minf = pick(md, 'minf');
    if (!mdhd || !hdlr || !minf) return null;
    var mi = children(buf, minf.body, minf.end);
    var stbl = pick(mi, 'stbl');
    if (!stbl) return null;
    var st = children(buf, stbl.body, stbl.end);

    var mdhdV = buf[mdhd.body];
    var timescale = dv.getUint32(mdhd.body + (mdhdV === 1 ? 20 : 12));
    var handler = fourcc(buf, hdlr.body + 8);

    var stsd = pick(st, 'stsd'), stts = pick(st, 'stts'), stsz = pick(st, 'stsz');
    var stsc = pick(st, 'stsc'), stco = pick(st, 'stco'), co64 = pick(st, 'co64');
    var ctts = pick(st, 'ctts'), stss = pick(st, 'stss');
    if (pick(st, 'stz2')) throw fail('この動画の形式(stz2)には対応していません。');
    if (!stsd || !stts || !stsz || !stsc || !(stco || co64)) return null;

    // サイズ
    var count = dv.getUint32(stsz.body + 8);
    var fixed = dv.getUint32(stsz.body + 4);
    var size = new Uint32Array(count);
    for (var i = 0; i < count; i++) size[i] = fixed ? fixed : dv.getUint32(stsz.body + 12 + i * 4);

    // 時間
    var dur = new Uint32Array(count), dts = new Float64Array(count);
    var n = dv.getUint32(stts.body + 4), si = 0, t = 0, e, k;
    for (e = 0; e < n; e++) {
      var c = dv.getUint32(stts.body + 8 + e * 8), d = dv.getUint32(stts.body + 12 + e * 8);
      for (k = 0; k < c && si < count; k++) { dts[si] = t; dur[si] = d; t += d; si++; }
    }
    if (si !== count) throw fail('動画の時間情報が壊れています。');

    // 表示時刻とのずれ(Bフレーム)
    var cto = null, cttsVersion = 0;
    if (ctts) {
      cttsVersion = buf[ctts.body];
      cto = new Int32Array(count);
      n = dv.getUint32(ctts.body + 4); si = 0;
      for (e = 0; e < n; e++) {
        var cc = dv.getUint32(ctts.body + 8 + e * 8), co = dv.getInt32(ctts.body + 12 + e * 8);
        for (k = 0; k < cc && si < count; k++) cto[si++] = co;
      }
    }

    // キーフレーム
    var sync = null;
    if (stss) {
      sync = new Uint8Array(count);
      n = dv.getUint32(stss.body + 4);
      for (e = 0; e < n; e++) {
        var s = dv.getUint32(stss.body + 8 + e * 4) - 1;
        if (s >= 0 && s < count) sync[s] = 1;
      }
    }

    // ファイル内の位置
    var chunkCount = dv.getUint32((stco || co64).body + 4);
    var chunkOff = new Float64Array(chunkCount);
    for (e = 0; e < chunkCount; e++) {
      chunkOff[e] = stco ? dv.getUint32(stco.body + 8 + e * 4)
                         : Number(dv.getBigUint64(co64.body + 8 + e * 8));
    }
    var stscN = dv.getUint32(stsc.body + 4);
    var off = new Float64Array(count);
    si = 0;
    for (e = 0; e < stscN; e++) {
      var first = dv.getUint32(stsc.body + 8 + e * 12);
      var spc = dv.getUint32(stsc.body + 12 + e * 12);
      var next = e + 1 < stscN ? dv.getUint32(stsc.body + 8 + (e + 1) * 12) : chunkCount + 1;
      for (var ch = first; ch < next && ch <= chunkCount; ch++) {
        var o = chunkOff[ch - 1];
        for (k = 0; k < spc && si < count; k++) { off[si] = o; o += size[si]; si++; }
      }
    }
    if (si !== count) throw fail('動画の位置情報が壊れています。');

    return {
      handler: handler, timescale: timescale, count: count,
      size: size, dur: dur, dts: dts, cto: cto, cttsVersion: cttsVersion, sync: sync, off: off,
      total: t, // メディア時間の合計(timescale単位)
      refs: { trak: trak, tkhd: tkhd, mdia: mdia, mdhd: mdhd, md: md, minf: minf, mi: mi, stsd: stsd }
    };
  }

  // ---------- 解析 ----------
  async function analyze(file) {
    var top = await scanTop(file);
    var moovBox = null, ftypBox = null, i;
    for (i = 0; i < top.length; i++) {
      if (top[i].type === 'moov' && !moovBox) moovBox = top[i];
      if (top[i].type === 'ftyp' && !ftypBox) ftypBox = top[i];
    }
    if (!moovBox) {
      var hasMoof = top.some(function (b) { return b.type === 'moof'; });
      throw fail(hasMoof
        ? 'この動画は分割再生用の形式(fMP4)のため対応していません。'
        : 'MP4 / MOV の動画ではないようです。iPhoneで撮影した動画を選んでください。');
    }
    if (moovBox.size > 256 * 1024 * 1024) throw fail('動画の管理情報が大きすぎます。');
    var buf = await readSlice(file, moovBox.start, moovBox.start + moovBox.size);
    var moov = children(buf, 0, buf.length)[0];
    var kids = children(buf, moov.body, moov.end);
    if (pick(kids, 'cmov')) throw fail('圧縮された管理情報(cmov)には対応していません。');
    var mvhd = pick(kids, 'mvhd');
    if (!mvhd) throw fail('動画の管理情報が見つかりません。');
    var dv = dvOf(buf);
    var movieScale = dv.getUint32(mvhd.body + (buf[mvhd.body] === 1 ? 20 : 12));

    var tracks = [];
    kids.forEach(function (k) {
      if (k.type !== 'trak') return;
      var tr = parseTrack(buf, k);
      if (tr && (tr.handler === 'vide' || tr.handler === 'soun')) tracks.push(tr);
    });
    var video = null;
    for (i = 0; i < tracks.length; i++) if (tracks[i].handler === 'vide') { video = tracks[i]; break; }
    if (!video || !video.count) throw fail('映像が見つかりませんでした。');
    tracks = tracks.filter(function (t) { return t === video || t.handler === 'soun'; });

    var ftyp = null;
    if (ftypBox) ftyp = await readSlice(file, ftypBox.start, ftypBox.start + ftypBox.size);
    var brand = ftyp ? fourcc(ftyp, 8) : 'qt  ';

    // キーフレームの一覧
    var syncIdx = [];
    for (i = 0; i < video.count; i++) if (!video.sync || video.sync[i]) syncIdx.push(i);

    return {
      file: file, moovBuf: buf, moov: moov, mvhd: mvhd, movieScale: movieScale,
      tracks: tracks, video: video, syncIdx: syncIdx,
      ftyp: ftyp, isQuickTime: brand === 'qt  ',
      duration: video.total / video.timescale
    };
  }

  // ---------- 分割位置の決定 ----------
  function planWithParts(info, n) {
    var v = info.video, sync = info.syncIdx, total = v.total;
    var starts = [0];
    for (var k = 1; k < n; k++) {
      var target = k * total / n, lo = 0, hi = sync.length - 1, ans = -1;
      while (lo <= hi) {
        var mid = (lo + hi) >> 1;
        if (v.dts[sync[mid]] <= target) { ans = mid; lo = mid + 1; } else hi = mid - 1;
      }
      var s = ans >= 0 ? sync[ans] : 0, prev = starts[starts.length - 1];
      if (s <= prev) {
        var nxt = -1;
        for (var j = 0; j < sync.length; j++) if (sync[j] > prev) { nxt = sync[j]; break; }
        if (nxt < 0) continue;
        s = nxt;
      }
      starts.push(s);
    }
    var segs = [];
    for (var q = 0; q < starts.length; q++) {
      var vs = starts[q], ve = q + 1 < starts.length ? starts[q + 1] : v.count;
      var t0 = v.dts[vs], t1 = ve < v.count ? v.dts[ve] : total;
      segs.push({ vs: vs, ve: ve, start: t0 / v.timescale, dur: (t1 - t0) / v.timescale });
    }
    return segs;
  }

  /**
   * mode 'max'   : 1パートが maxSec 以内になるよう、均等に分ける
   * mode 'three' : 3等分
   */
  function plan(info, opts) {
    opts = opts || {};
    var mode = opts.mode || 'max', maxSec = opts.maxSec || 300;
    if (mode === 'three') return planWithParts(info, 3);
    if (info.duration <= maxSec) return planWithParts(info, 1);
    var n = Math.max(2, Math.ceil(info.duration / (maxSec - 5))), segs;
    for (var tries = 0; tries < 12; tries++, n++) {
      segs = planWithParts(info, n);
      if (segs.every(function (s) { return s.dur <= maxSec; })) return segs;
    }
    return segs;
  }

  // ---------- 書き出し ----------
  function lowerBound(arr, count, pred) {
    var lo = 0, hi = count;
    while (lo < hi) {
      var mid = (lo + hi) >> 1;
      if (pred(mid)) hi = mid; else lo = mid + 1;
    }
    return lo;
  }

  function patchDuration(raw, version, durOffV0, durOffV1, value) {
    var out = raw.slice(), dv = dvOf(out);
    if (version === 1) dv.setBigUint64(durOffV1, BigInt(Math.round(value)));
    else dv.setUint32(durOffV0, Math.min(Math.round(value), 0xffffffff));
    return out;
  }

  function runLength(values, i0, i1) {
    var out = [], cur = null, n = 0;
    for (var i = i0; i < i1; i++) {
      if (values[i] === cur) n++;
      else { if (n) out.push(n, cur); cur = values[i]; n = 1; }
    }
    if (n) out.push(n, cur);
    return out;
  }

  function buildTrak(info, tr, r, chunkRel, chunkCounts, use64, base) {
    var buf = info.moovBuf, refs = tr.refs, i0 = r.i0, i1 = r.i1, n = i1 - i0, i;

    var mediaDur = 0;
    for (i = i0; i < i1; i++) mediaDur += tr.dur[i];

    // 映像は、先頭フレームの表示開始までを編集リストで詰める
    var mediaTime = 0;
    if (tr.handler === 'vide' && tr.cto) {
      var minPts = Infinity, t0 = tr.dts[i0];
      for (i = i0; i < i1; i++) {
        var pts = tr.dts[i] - t0 + tr.cto[i];
        if (pts < minPts) minPts = pts;
        if (i - i0 > 600) break; // 先頭付近だけ見れば十分
      }
      mediaTime = Math.max(0, minPts);
    }
    // 表示される範囲は [mediaTime, mediaTime + mediaDur) なので、長さはメディアの長さと同じ
    var movieDur = mediaDur * info.movieScale / tr.timescale;

    var stts = box('stts', [u32s([0, runLength(tr.dur, i0, i1).length / 2]),
      u32s(runLength(tr.dur, i0, i1))]);
    var parts = [refs.stsd ? buf.slice(refs.stsd.start, refs.stsd.end) : new Uint8Array(0), stts];
    if (tr.cto) {
      var cr = runLength(tr.cto, i0, i1);
      parts.push(box('ctts', [u32s([tr.cttsVersion << 24, cr.length / 2]), u32s(cr)]));
    }
    if (tr.sync) {
      var syncList = [];
      for (i = i0; i < i1; i++) if (tr.sync[i]) syncList.push(i - i0 + 1);
      parts.push(box('stss', [u32s([0, syncList.length]), u32s(syncList)]));
    }
    // 連続したサンプルは同じチャンクにまとめる。
    // 元の1サンプル=1チャンク方式に比べ、長い動画の管理情報とメモリ使用量を削減する。
    var stscRows = [];
    var previousCount = -1;
    for (i = 0; i < chunkCounts.length; i++) {
      if (chunkCounts[i] !== previousCount) {
        stscRows.push(i + 1, chunkCounts[i], 1);
        previousCount = chunkCounts[i];
      }
    }
    parts.push(box('stsc', [u32s([0, stscRows.length / 3]), u32s(stscRows)]));
    var sizes = new Array(n);
    for (i = 0; i < n; i++) sizes[i] = tr.size[i0 + i];
    parts.push(box('stsz', [u32s([0, 0, n]), u32s(sizes)]));
    if (use64) {
      var co = new Uint8Array(8 + chunkRel.length * 8), cdv = dvOf(co);
      cdv.setUint32(4, chunkRel.length);
      for (i = 0; i < chunkRel.length; i++) cdv.setBigUint64(8 + i * 8, BigInt(base + chunkRel[i]));
      parts.push(box('co64', [co]));
    } else {
      var offs = new Array(chunkRel.length);
      for (i = 0; i < chunkRel.length; i++) offs[i] = base + chunkRel[i];
      parts.push(box('stco', [u32s([0, offs.length]), u32s(offs)]));
    }
    var stbl = box('stbl', parts);

    // minf: stbl 以外はそのまま、stbl は作り直し
    var minfParts = [];
    refs.mi.forEach(function (c) {
      minfParts.push(c.type === 'stbl' ? stbl : buf.slice(c.start, c.end));
    });
    var minf = box('minf', minfParts);

    // mdia: mdhd の長さを更新
    var mdParts = [];
    refs.md.forEach(function (c) {
      if (c.type === 'mdhd') {
        var raw = buf.slice(c.start, c.end), v = raw[8];
        mdParts.push(patchDuration(raw, v, 8 + (v === 1 ? 24 : 16), 8 + 24, mediaDur));
      } else if (c.type === 'minf') mdParts.push(minf);
      else mdParts.push(buf.slice(c.start, c.end));
    });
    var mdia = box('mdia', mdParts);

    var tkRaw = buf.slice(refs.tkhd.start, refs.tkhd.end), tv = tkRaw[8];
    var tkhd = patchDuration(tkRaw, tv, 8 + 20, 8 + 28, movieDur);
    var trakParts = [tkhd];
    if (tr.handler === 'vide') {
      var elst = box('elst', [u32s([0, 1, Math.round(movieDur), mediaTime, 0x00010000])]);
      trakParts.push(box('edts', [elst]));
    }
    trakParts.push(mdia);
    return { trak: box('trak', trakParts), movieDur: movieDur };
  }

  async function buildOne(info, seg, index, total, baseName) {
    var v = info.video, tracks = info.tracks, file = info.file;
    var t0 = v.dts[seg.vs];
    var t1 = seg.ve < v.count ? v.dts[seg.ve] : Infinity;

    // 各トラックのサンプル範囲
    var ranges = tracks.map(function (tr) {
      if (tr === v) return { tr: tr, i0: seg.vs, i1: seg.ve };
      var i0 = lowerBound(tr.dts, tr.count, function (i) { return tr.dts[i] * v.timescale >= t0 * tr.timescale; });
      var i1 = t1 === Infinity ? tr.count
        : lowerBound(tr.dts, tr.count, function (i) { return tr.dts[i] * v.timescale >= t1 * tr.timescale; });
      return { tr: tr, i0: i0, i1: i1 };
    }).filter(function (r) { return r.i1 > r.i0; });

    // データの並べ方: 元ファイルの順を保つ
    var total_n = 0, k, i;
    ranges.forEach(function (r) { total_n += r.i1 - r.i0; });
    var src = new Float64Array(total_n), len = new Float64Array(total_n);
    var who = new Uint16Array(total_n), idx = new Uint32Array(total_n), p = 0;
    ranges.forEach(function (r, ri) {
      for (i = r.i0; i < r.i1; i++) {
        src[p] = r.tr.off[i]; len[p] = r.tr.size[i]; who[p] = ri; idx[p] = i - r.i0; p++;
      }
    });
    var order = new Uint32Array(total_n);
    for (i = 0; i < total_n; i++) order[i] = i;
    order.sort(function (a, b) { return src[a] - src[b]; });

    var rels = ranges.map(function (r) { return new Float64Array(r.i1 - r.i0); });
    var chunkOffsets = ranges.map(function () { return []; });
    var chunkCounts = ranges.map(function () { return []; });
    var slices = [], cursor = 0, curStart = -1, curEnd = -1;
    var lastTrack = -1, lastIndex = -1, lastEnd = -1;
    for (k = 0; k < total_n; k++) {
      var j = order[k], trNo = who[j], sampleNo = idx[j], byteAt = src[j];
      rels[trNo][sampleNo] = cursor;
      if (trNo === lastTrack && sampleNo === lastIndex + 1 && byteAt === lastEnd) {
        chunkCounts[trNo][chunkCounts[trNo].length - 1]++;
      } else {
        chunkOffsets[trNo].push(cursor);
        chunkCounts[trNo].push(1);
      }
      lastTrack = trNo; lastIndex = sampleNo; lastEnd = byteAt + len[j];
      if (byteAt === curEnd) curEnd += len[j];
      else {
        if (curStart >= 0) slices.push([curStart, curEnd]);
        curStart = byteAt; curEnd = byteAt + len[j];
      }
      cursor += len[j];
      // メインスレッドを定期的に返し、iPhoneの画面更新と操作を妨げない。
      if ((k & 8191) === 8191) await new Promise(function (resolve) { setTimeout(resolve, 0); });
    }
    if (curStart >= 0) slices.push([curStart, curEnd]);
    // ごく一部のファイルではサンプルの格納順が再生順と異なる。
    // その場合だけ従来の1サンプル1チャンク方式に戻して正しい順序を維持する。
    ranges.forEach(function (r, ri) {
      for (var si = r.i0 + 1; si < r.i1; si++) {
        if (r.tr.off[si] < r.tr.off[si - 1]) {
          chunkOffsets[ri] = Array.from(rels[ri]);
          chunkCounts[ri] = new Array(rels[ri].length).fill(1);
          break;
        }
      }
    });
    var payload = cursor;

    var ftyp = info.ftyp;
    if (!ftyp) {
      ftyp = new Uint8Array(20);
      dvOf(ftyp).setUint32(0, 20); setFourcc(ftyp, 4, 'ftyp'); setFourcc(ftyp, 8, 'qt  ');
      setFourcc(ftyp, 16, 'qt  ');
    }
    var use64 = payload > 0xF0000000; // 4GB に近いときだけ64bitの位置情報を使う
    var mdatHdrLen = payload + 8 > 0xffffffff ? 16 : 8;

    function makeMoov(base) {
      var moovParts = [], maxDur = 0;
      var mv = info.moovBuf.slice(info.mvhd.start, info.mvhd.end);
      var trakBoxes = ranges.map(function (r, ri) {
        var res = buildTrak(info, r.tr, r, chunkOffsets[ri], chunkCounts[ri], use64, base);
        if (res.movieDur > maxDur) maxDur = res.movieDur;
        return res.trak;
      });
      var mvV = mv[8];
      moovParts.push(patchDuration(mv, mvV, 8 + (mvV === 1 ? 24 : 16), 8 + 24, maxDur));
      return box('moov', moovParts.concat(trakBoxes));
    }
    var moov0 = makeMoov(0);
    var base = ftyp.length + moov0.length + mdatHdrLen;
    var moov = makeMoov(base);

    var hdr = new Uint8Array(mdatHdrLen), hdv = dvOf(hdr);
    if (mdatHdrLen === 8) { hdv.setUint32(0, payload + 8); setFourcc(hdr, 4, 'mdat'); }
    else { hdv.setUint32(0, 1); setFourcc(hdr, 4, 'mdat'); hdv.setBigUint64(8, BigInt(payload + 16)); }

    var blobParts = [ftyp, moov, hdr];
    for (k = 0; k < slices.length; k++) blobParts.push(file.slice(slices[k][0], slices[k][1]));

    var ext = info.isQuickTime ? 'mov' : 'mp4';
    var mime = info.isQuickTime ? 'video/quicktime' : 'video/mp4';
    return {
      blob: new Blob(blobParts, { type: mime }),
      name: baseName + '_part' + (index + 1) + 'of' + total + '.' + ext,
      mime: mime,
      start: seg.start,
      dur: seg.dur,
      size: ftyp.length + moov.length + mdatHdrLen + payload
    };
  }

  async function build(info, segs, baseName, onProgress) {
    var out = [];
    for (var i = 0; i < segs.length; i++) {
      if (onProgress) onProgress(i, segs.length);
      // ステータス表示後に1フレーム画面更新させてから、次のパートを処理する。
      await new Promise(function (resolve) { setTimeout(resolve, 0); });
      out.push(await buildOne(info, segs[i], i, segs.length, baseName || 'video'));
    }
    if (onProgress) onProgress(segs.length, segs.length);
    return out;
  }

  return { analyze: analyze, plan: plan, build: build };
});
