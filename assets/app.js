/* SonicSeal — browser glue: modem, playback, microphone capture, decrypt log. */
(function () {
  'use strict';

  var S = window.SonicSeal;
  var $ = function (id) { return document.getElementById(id); };

  var PROTO_ID = {
    normal: 'GGWAVE_PROTOCOL_AUDIBLE_NORMAL',
    fast: 'GGWAVE_PROTOCOL_AUDIBLE_FAST',
    fastest: 'GGWAVE_PROTOCOL_AUDIBLE_FASTEST',
  };
  var SPEED_NAME = { normal: '标准', fast: '快速', fastest: '极速' };
  // Measured: a full 140-char frame takes 13.5 / 9.26 / 4.97 s, and roughly
  // 0.7 s of that is fixed protocol overhead (preamble + trailing marker).
  var SPEED_PER_CHAR = { normal: 0.0914, fast: 0.0611, fastest: 0.0305 };
  var VOLUME = 90;
  var LEAD_SILENCE = 0.12;
  var TAIL_SILENCE = 0.32;
  var HISTORY_KEY = 'sonicseal.history.v1';
  var HISTORY_MAX = 60;

  var gg = null;
  var modem = null;
  var ctx = null;
  var modemRate = 48000;
  var base64Alphabet = null;

  /* ------------------------------------------------------------------ */
  /* boot                                                                */
  /* ------------------------------------------------------------------ */

  function setStatus(text, kind) {
    $('statusText').textContent = text;
    var el = $('status');
    el.className = 'status' + (kind ? ' ' + kind : '');
  }

  function ensureContext() {
    if (ctx) return Promise.resolve(ctx);
    var Ctor = window.AudioContext || window.webkitAudioContext;
    if (!Ctor) return Promise.reject(new Error('这个浏览器不支持 Web Audio'));
    try {
      ctx = new Ctor({ sampleRate: 48000, latencyHint: 'interactive' });
    } catch (e) {
      ctx = new Ctor();
    }
    return Promise.resolve(ctx);
  }

  function modemParams(rate) {
    var p = gg.getDefaultParameters();
    p.sampleRateInp = rate;
    p.sampleRateOut = rate;
    p.sampleRate = rate;
    p.sampleFormatInp = gg.SampleFormat.GGWAVE_SAMPLE_FORMAT_I16;
    p.sampleFormatOut = gg.SampleFormat.GGWAVE_SAMPLE_FORMAT_I16;
    p.operatingMode = 6; // RX | TX
    return p;
  }

  function initModem() {
    // The wasm build fails the very first ggwave_init() call and succeeds on
    // the following one (observed in Chrome and stable across reloads), so
    // warm it up with a retry loop instead of trusting a single attempt.
    var handle = 0;
    for (var attempt = 0; attempt < 3; attempt++) {
      handle = gg.init(modemParams(modemRate));
      if (handle) { modem = handle; return; }
    }
    throw new Error('声学引擎初始化失败');
  }

  function resetModem() {
    try { if (modem) gg.free(modem); } catch (e) { /* already gone */ }
    initModem();
  }

  function boot() {
    if (typeof window.ggwave_factory !== 'function') {
      setStatus('声学引擎加载失败', 'bad');
      return;
    }
    // The emscripten build logs every encode through console.log; passing
    // print/printErr overrides at instantiation keeps the console clean.
    var quiet = function () {};
    window.ggwave_factory({ print: quiet, printErr: quiet }).then(function (mod) {
      gg = mod;
      try { gg.disableLog(); } catch (e) { /* older builds */ }
      modemRate = 48000;
      initModem();
      setStatus('声学引擎就绪 · ' + modemRate + ' Hz', 'ok');
      refreshSendMeta();
      $('playBtn').disabled = false;
      drawIdleMark();
      drawWave(null);
      drawScopeIdle();
    }).catch(function (err) {
      console.error(err);
      setStatus('声学引擎加载失败', 'bad');
    });
  }

  /* ------------------------------------------------------------------ */
  /* modem helpers                                                       */
  /* ------------------------------------------------------------------ */

  function decodeWireToFloat(view) {
    var bytes = new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
    var n = bytes.length >> 1;
    var out = new Float32Array(n);
    for (var i = 0; i < n; i++) {
      var s = (bytes[2 * i] | (bytes[2 * i + 1] << 8)) << 16 >> 16;
      out[i] = s / 32768;
    }
    return out;
  }

  function encodeWire(wire, speed) {
    var id = PROTO_ID[speed] || PROTO_ID.fast;
    var view = gg.encode(modem, wire, gg.ProtocolId[id], VOLUME);
    return decodeWireToFloat(view); // must copy now: static buffer
  }

  function floatToInt16View(samples) {
    var i16 = new Int16Array(samples.length);
    for (var i = 0; i < samples.length; i++) {
      var v = samples[i];
      if (v > 1) v = 1; else if (v < -1) v = -1;
      i16[i] = Math.round(v * 32767);
    }
    return new Int8Array(i16.buffer);
  }

  /* ------------------------------------------------------------------ */
  /* send                                                                */
  /* ------------------------------------------------------------------ */

  var sealed = null;   // last seal result
  var audio = null;    // { buffer, duration }
  var playing = null;  // { src, startedAt, duration }
  var rafPlay = 0;

  function refreshSendMeta() {
    var text = $('plain').value;
    var bytes = new TextEncoder().encode(text).length;
    $('byteCount').textContent = bytes;
    $('byteCap').textContent = String(S.MAX_TEXT_BYTES);
    $('byteCount').parentNode.classList.toggle('over', bytes > S.MAX_TEXT_BYTES);

    if (!modem) return;

    var speed = $('speed').value;
    var perFrame = S.CHUNK_BYTES + S.HEADER_BYTES + ($('pass').value ? 12 + 16 : 0);
    var frames = Math.max(1, Math.ceil(bytes / S.CHUNK_BYTES));
    var lastFrame = bytes - (frames - 1) * S.CHUNK_BYTES + S.HEADER_BYTES + ($('pass').value ? 12 + 16 : 0);
    var est = 0;
    for (var i = 0; i < frames; i++) {
      var body = i === frames - 1 ? lastFrame : perFrame;
      var chars = Math.ceil(body * 8 / 7);
      est += 0.7 + chars * SPEED_PER_CHAR[speed] + TAIL_SILENCE;
    }
    est += LEAD_SILENCE;
    var meta = $('sendMeta');
    if (!text.trim()) {
      meta.innerHTML = '<span>等待输入…</span>';
      return;
    }
    if (bytes > S.MAX_TEXT_BYTES) {
      meta.innerHTML = '<span class="badTxt">太长了，最多 ' + S.MAX_TEXT_BYTES + ' 字节（约 ' +
        Math.floor(S.MAX_TEXT_BYTES / 1.6) + ' 个字符）</span>';
      return;
    }
    var parts = [
      '≈ <b>' + frames + '</b> 帧',
      '<b>' + bytes + '</b> 字节明文',
      SPEED_NAME[speed] + '模式',
      '约 <b>' + est.toFixed(1) + '</b> 秒',
      $('pass').value ? 'AES-256-GCM' : '明文（未加密）',
    ];
    meta.innerHTML = parts.map(function (p) { return '<span>' + p + '</span>'; }).join('');
  }

  function renderFrameStrip() {
    var strip = $('frameStrip');
    strip.innerHTML = '';
    if (!sealed) return;
    sealed.wires.forEach(function (w, i) {
      var el = document.createElement('i');
      el.textContent = ('0' + i).slice(-2) + ' ' + b64short(w);
      el.title = w.length + ' 字符';
      strip.appendChild(el);
    });
  }

  function b64short(str) {
    var bytes = new Uint8Array(str.length);
    for (var i = 0; i < str.length; i++) bytes[i] = str.charCodeAt(i);
    var bin = '';
    for (var j = 0; j < bytes.length; j++) bin += String.fromCharCode(bytes[j]);
    return btoa(bin).replace(/=+$/, '').slice(0, 12) + '…';
  }

  function buildAudio(wires, speed) {
    var parts = [];
    var pad = new Float32Array(Math.round(LEAD_SILENCE * modemRate));
    parts.push(pad);
    var gap = new Float32Array(Math.round(TAIL_SILENCE * modemRate));
    var total = pad.length;
    wires.forEach(function (w) {
      var f = encodeWire(w, speed);
      parts.push(f, gap);
      total += f.length + gap.length;
    });
    var all = new Float32Array(total);
    var at = 0;
    parts.forEach(function (p) { all.set(p, at); at += p.length; });
    return all;
  }

  function makeBuffer(samples) {
    var buf = ctx.createBuffer(1, samples.length, modemRate);
    buf.copyToChannel(samples, 0);
    return buf;
  }

  function onSeal() {
    if (!modem) return;
    var text = $('plain').value;
    if (!text.trim()) { setStatus('先写点内容', 'bad'); return; }
    var btn = $('playBtn');
    btn.disabled = true;

    ensureContext().then(function () {
      return ctx.resume();
    }).then(function () {
      modemRate = ctx.sampleRate;
      resetModem(); // encode with the context's clock
      var pass = $('pass').value;
      return S.sealMessage(text, {
        passphrase: pass ? pass : undefined,
        compress: true,
      });
    }).then(function (result) {
      sealed = result;
      var speed = $('speed').value;
      var samples = buildAudio(result.wires, speed);
      audio = { samples: samples, duration: samples.length / modemRate, speed: speed };
      drawWave(samples);
      renderFrameStrip();
      $('wavBtn').disabled = false;
      $('copyWireBtn').disabled = false;
      $('sendMeta').innerHTML = [
        '<span><b>' + result.chunks + '</b> 帧</span>',
        '<span><b>' + result.plainBytes + '</b> 字节明文</span>',
        '<span><b>' + result.frameBytes + '</b> 字节密文</span>',
        '<span>音频 <b>' + audio.duration.toFixed(2) + '</b> 秒</span>',
        '<span>' + SPEED_NAME[speed] + '</span>',
        '<span>' + (result.sealed ? 'AES-256-GCM' : '明文') + '</span>',
      ].join('');
      btn.disabled = false;
      play();
    }).catch(function (err) {
      btn.disabled = false;
      setStatus(err.code === 'TOO_LONG' ? '内容超过 ' + S.MAX_TEXT_BYTES + ' 字节' : (err.message || '生成失败'), 'bad');
      console.error(err);
    });
  }

  function play() {
    if (!audio || !ctx) return;
    stopPlayback();
    var buf = makeBuffer(audio.samples);
    var src = ctx.createBufferSource();
    src.buffer = buf;
    var gain = ctx.createGain();
    gain.gain.value = 0.95;
    src.connect(gain).connect(ctx.destination);
    var t0 = ctx.currentTime + 0.02;
    src.start(t0);
    playing = { src: src, startedAt: t0, duration: buf.duration };
    var btn = $('playBtn');
    btn.classList.add('playing');
    btn.textContent = '正在播放 · 点击停止';
    setStatus('正在发送声音 · ' + audio.duration.toFixed(1) + ' 秒', 'ok');
    src.onended = function () {
      if (playing && playing.src === src) {
        playing = null;
        btn.classList.remove('playing');
        btn.textContent = '再次播放';
        setStatus('播放结束 · 声学引擎就绪', 'ok');
        drawWave(audio.samples);
      }
    };
    tickPlayhead();
  }

  function stopPlayback() {
    if (rafPlay) { cancelAnimationFrame(rafPlay); rafPlay = 0; }
    if (playing) {
      try { playing.src.stop(); } catch (e) { /* already stopped */ }
      playing = null;
    }
    var btn = $('playBtn');
    btn.classList.remove('playing');
    btn.textContent = audio ? '再次播放' : '生成并播放';
  }

  function tickPlayhead() {
    if (!playing || !audio) return;
    var el = (ctx.currentTime - playing.startedAt) / playing.duration;
    drawWave(audio.samples, Math.max(0, Math.min(1, el)));
    if (el < 1 && playing) rafPlay = requestAnimationFrame(tickPlayhead);
  }

  /* ------------------------------------------------------------------ */
  /* canvas: send waveform                                               */
  /* ------------------------------------------------------------------ */

  function fitCanvas(cv, cssHeight) {
    var dpr = Math.min(window.devicePixelRatio || 1, 2);
    var w = cv.clientWidth || 600;
    var h = cssHeight || cv.clientHeight || 150;
    if (cv.width !== Math.round(w * dpr) || cv.height !== Math.round(h * dpr)) {
      cv.width = Math.round(w * dpr);
      cv.height = Math.round(h * dpr);
    }
    var c2d = cv.getContext('2d');
    c2d.setTransform(dpr, 0, 0, dpr, 0, 0);
    return { c2d: c2d, w: w, h: h };
  }

  function drawWave(samples, progress) {
    var cv = $('wave');
    var f = fitCanvas(cv);
    var c = f.c2d, w = f.w, h = f.h;
    c.clearRect(0, 0, w, h);

    var mid = h / 2;
    c.strokeStyle = 'rgba(96,176,204,0.18)';
    c.lineWidth = 1;
    c.beginPath(); c.moveTo(0, mid + 0.5); c.lineTo(w, mid + 0.5); c.stroke();

    if (!samples) {
      c.fillStyle = 'rgba(93,122,137,0.55)';
      c.font = '12px ui-monospace, monospace';
      c.textAlign = 'center';
      c.fillText('波形将在这里显示', w / 2, mid - 8);
      return;
    }

    var cols = Math.max(1, Math.floor(w));
    var per = samples.length / cols;
    c.strokeStyle = 'rgba(70,224,208,0.75)';
    c.lineWidth = 1.2;
    c.beginPath();
    for (var x = 0; x < cols; x++) {
      var from = Math.floor(x * per);
      var to = Math.min(samples.length, Math.floor((x + 1) * per));
      var lo = 0, hi = 0;
      for (var i = from; i < to; i++) {
        var v = samples[i];
        if (v < lo) lo = v; else if (v > hi) hi = v;
      }
      c.moveTo(x + 0.5, mid - hi * (mid - 6));
      c.lineTo(x + 0.5, mid - lo * (mid - 6) + 0.5);
    }
    c.stroke();

    // envelope glow
    var g = c.createLinearGradient(0, 0, w, 0);
    g.addColorStop(0, 'rgba(70,224,208,0.0)');
    g.addColorStop(0.5, 'rgba(70,224,208,0.10)');
    g.addColorStop(1, 'rgba(30,168,201,0.0)');
    c.fillStyle = g;
    c.fillRect(0, 0, w, h);

    if (typeof progress === 'number') {
      var px = Math.round(progress * w) + 0.5;
      c.strokeStyle = 'rgba(255,180,84,0.9)';
      c.lineWidth = 1.5;
      c.beginPath(); c.moveTo(px, 4); c.lineTo(px, h - 4); c.stroke();
      c.fillStyle = 'rgba(255,180,84,0.10)';
      c.fillRect(0, 0, px, h);
    }
  }

  /* ------------------------------------------------------------------ */
  /* canvas: sonar scope                                                 */
  /* ------------------------------------------------------------------ */

  var scope = { level: 0, hist: [], blips: [], live: false, raf: 0, phase: 0, lastBlock: null };

  function drawScopeIdle() {
    var cv = $('scope');
    var f = fitCanvas(cv);
    var c = f.c2d, w = f.w, h = f.h;
    c.clearRect(0, 0, w, h);
    var cx = w / 2, cy = h / 2 + 6;
    var maxR = Math.min(w, h) * 0.42;
    c.strokeStyle = 'rgba(96,176,204,0.16)';
    c.lineWidth = 1;
    for (var k = 1; k <= 4; k++) {
      c.beginPath();
      c.arc(cx, cy, maxR * (k / 4), 0, Math.PI * 2);
      c.stroke();
    }
    c.strokeStyle = 'rgba(96,176,204,0.10)';
    c.beginPath(); c.moveTo(cx - maxR, cy); c.lineTo(cx + maxR, cy); c.stroke();
    c.beginPath(); c.moveTo(cx, cy - maxR); c.lineTo(cx, cy + maxR); c.stroke();
    c.fillStyle = 'rgba(70,224,208,0.05)';
    c.beginPath(); c.arc(cx, cy, maxR, 0, Math.PI * 2); c.fill();
  }

  function drawScopeFrame() {
    var cv = $('scope');
    var f = fitCanvas(cv);
    var c = f.c2d, w = f.w, h = f.h;
    var cx = w / 2, cy = h / 2 + 6;
    var maxR = Math.min(w, h) * 0.42;

    c.clearRect(0, 0, w, h);

    // rings
    c.strokeStyle = 'rgba(96,176,204,0.18)';
    c.lineWidth = 1;
    for (var k = 1; k <= 4; k++) {
      c.beginPath(); c.arc(cx, cy, maxR * (k / 4), 0, Math.PI * 2); c.stroke();
    }
    c.strokeStyle = 'rgba(96,176,204,0.12)';
    c.beginPath(); c.moveTo(cx - maxR, cy); c.lineTo(cx + maxR, cy); c.stroke();
    c.beginPath(); c.moveTo(cx, cy - maxR); c.lineTo(cx, cy + maxR); c.stroke();

    // sweep
    var a = scope.phase % (Math.PI * 2);
    var grad = c.createRadialGradient(cx, cy, 0, cx, cy, maxR);
    grad.addColorStop(0, 'rgba(70,224,208,0.32)');
    grad.addColorStop(1, 'rgba(70,224,208,0.0)');
    c.fillStyle = grad;
    c.beginPath();
    c.moveTo(cx, cy);
    c.arc(cx, cy, maxR, a - 0.55, a);
    c.closePath();
    c.fill();

    c.strokeStyle = 'rgba(70,224,208,0.55)';
    c.beginPath();
    c.moveTo(cx, cy);
    c.lineTo(cx + Math.cos(a) * maxR, cy + Math.sin(a) * maxR);
    c.stroke();

    // waveform ring
    var hist = scope.lastBlock;
    if (hist && hist.length) {
      var step = Math.max(1, Math.floor(hist.length / 180));
      c.beginPath();
      for (var i = 0; i < hist.length; i += step) {
        var ang = (i / hist.length) * Math.PI * 2 - Math.PI / 2;
        var r = maxR * 0.30 + hist[i] * maxR * 0.62;
        var px = cx + Math.cos(ang) * r;
        var py = cy + Math.sin(ang) * r;
        if (i === 0) c.moveTo(px, py); else c.lineTo(px, py);
      }
      c.closePath();
      c.strokeStyle = 'rgba(70,224,208,' + (0.30 + scope.level * 0.7) + ')';
      c.lineWidth = 1.4;
      c.stroke();
    }

    // blips from decoded frames
    var now = performance.now();
    scope.blips = scope.blips.filter(function (b) { return now - b.t < 2600; });
    scope.blips.forEach(function (b) {
      var age = (now - b.t) / 2600;
      var rr = maxR * (0.25 + age * 0.72);
      c.strokeStyle = 'rgba(255,180,84,' + (0.75 * (1 - age)) + ')';
      c.lineWidth = 1.6;
      c.beginPath(); c.arc(cx, cy, rr, 0, Math.PI * 2); c.stroke();
      var bx = cx + Math.cos(b.ang) * maxR * 0.86;
      var by = cy + Math.sin(b.ang) * maxR * 0.86;
      c.fillStyle = 'rgba(255,180,84,' + (1 - age) + ')';
      c.beginPath(); c.arc(bx, by, 3.2, 0, Math.PI * 2); c.fill();
    });

    scope.phase += 0.035;
    scope.raf = requestAnimationFrame(drawScopeFrame);
  }

  function startScope() {
    if (scope.raf) return;
    scope.live = true;
    scope.phase = 0;
    drawScopeFrame();
  }

  function stopScope() {
    scope.live = false;
    if (scope.raf) { cancelAnimationFrame(scope.raf); scope.raf = 0; }
    scope.lastBlock = null;
    scope.level = 0;
    $('levelBar').style.width = '0%';
    drawScopeIdle();
  }

  /* ------------------------------------------------------------------ */
  /* receive                                                             */
  /* ------------------------------------------------------------------ */

  var rx = {
    stream: null,
    source: null,
    node: null,
    asm: S.createAssembler({ ttlMs: 5 * 60 * 1000 }),
    logged: Object.create(null),
    frames: 0,
    dirty: 0,
    hitUntil: 0,
  };

  function setMicUI(on) {
    var btn = $('micBtn');
    btn.classList.toggle('live', on);
    $('micLabel').textContent = on ? '停止收听' : '开始收听';
    $('sonarTag').textContent = on ? '收听中 · 等待声学帧' : '待机 · 麦克风未开启';
    $('sonarTag').className = 'sonarTag' + (on ? ' live' : '');
  }

  function toggleMic() {
    if (rx.stream) stopMic(); else startMic();
  }

  function startMic() {
    if (!modem) return;
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      setStatus('浏览器不支持麦克风采集（需要 HTTPS 或 localhost）', 'bad');
      return;
    }
    ensureContext().then(function () { return ctx.resume(); }).then(function () {
      return navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false,
          channelCount: 1,
        },
      });
    }).then(function (stream) {
      rx.stream = stream;
      modemRate = ctx.sampleRate;
      resetModem(); // fresh decode state for a new capture session
      rx.asm.reset();
      rx.logged = Object.create(null);
      rx.frames = 0;
      renderChips([]);

      rx.source = ctx.createMediaStreamSource(stream);
      // ScriptProcessor is deprecated but still the most portable capture tap.
      rx.node = ctx.createScriptProcessor(4096, 1, 1);
      var silentGain = ctx.createGain();
      silentGain.gain.value = 0; // keep the node alive without monitoring feedback
      rx.source.connect(rx.node);
      rx.node.connect(silentGain).connect(ctx.destination);

      rx.node.onaudioprocess = function (ev) {
        var input = ev.inputBuffer.getChannelData(0);
        onAudioBlock(input);
      };

      setMicUI(true);
      setStatus('正在收听 · ' + Math.round(ctx.sampleRate / 1000) + ' kHz', 'ok');
      startScope();
    }).catch(function (err) {
      console.error(err);
      var msg = '麦克风开启失败';
      if (location.protocol === 'file:') msg = 'file:// 不能录音 · 用 http://localhost:8787';
      else if (!window.isSecureContext) msg = '需要 HTTPS 或 localhost 才能录音';
      else if (err && err.name === 'NotAllowedError') msg = '麦克风权限被拒绝';
      else if (err && err.name === 'NotFoundError') msg = '没有找到麦克风设备';
      else if (String(err && err.message).indexOf('secure') >= 0) msg = '需要 HTTPS 或 localhost 才能录音';
      setStatus(msg, 'bad');
    });
  }

  function stopMic() {
    if (rx.node) {
      rx.node.onaudioprocess = null;
      try { rx.node.disconnect(); } catch (e) { /* noop */ }
    }
    if (rx.source) { try { rx.source.disconnect(); } catch (e) { /* noop */ } }
    if (rx.stream) {
      rx.stream.getTracks().forEach(function (t) { t.stop(); });
    }
    rx.node = rx.source = rx.stream = null;
    setMicUI(false);
    stopScope();
    setStatus('收听已停止', '');
    flushAssembler(true);
  }

  var blockCount = 0;

  function onAudioBlock(input) {
    // level meter
    var sum = 0;
    for (var i = 0; i < input.length; i++) sum += input[i] * input[i];
    var rms = Math.sqrt(sum / input.length);
    scope.level = Math.min(1, rms * 6);
    $('levelBar').style.width = (scope.level * 100).toFixed(0) + '%';
    scope.lastBlock = input.slice(0, Math.min(input.length, 512));

    if (++blockCount % 6 === 0 && performance.now() > rx.hitUntil) {
      $('sonarTag').textContent = '收听中 · 电平 ' + (rms > 0.0005 ? (20 * Math.log10(rms)).toFixed(0) + ' dB' : '静音');
    }

    if (!modem) return;
    var res;
    try {
      res = gg.decode(modem, floatToInt16View(input));
    } catch (e) {
      return;
    }
    if (!res || !res.length) return;

    var raw = new Uint8Array(res.buffer, res.byteOffset, res.length);
    var wire = '';
    for (var k = 0; k < raw.length; k++) wire += String.fromCharCode(raw[k]);
    handleWire(wire, 'mic');
  }

  function handleWire(wire, source) {
    var frame;
    try { frame = S.unpackWire(wire); } catch (e) { return; }
    var parsed = S.parseFrame(frame);
    if (!parsed) return; // somebody else's noise
    if (parsed.invalid === 'VERSION') {
      // valid SonicSeal signal, but from another protocol generation
      rx.stray = (rx.stray || 0) + 1;
      if (rx.stray === 1) setStatus('这段声音是旧版本格式，当前程序读不了', 'bad');
      return;
    }

    rx.frames += 1;
    scope.blips.push({ ang: Math.random() * Math.PI * 2, t: performance.now() });
    $('sonarTag').className = 'sonarTag live hit';
    $('sonarTag').textContent = '捕获声学帧 · #' + parsed.idx + '/' + parsed.total;
    rx.hitUntil = performance.now() + 1400;
    setTimeout(function () {
      if (performance.now() >= rx.hitUntil - 40) {
        $('sonarTag').className = 'sonarTag' + (rx.stream ? ' live' : '');
      }
    }, 1500);

    rx.asm.push(frame);
    flushAssembler(false);
  }

  var flushTimer = 0;
  var flushing = false;
  var flushAgain = false;

  function flushAssembler(force) {
    if (flushing) { flushAgain = true; return; }
    flushing = true;
    var pass = $('passRx').value;
    rx.asm.flush(pass ? pass : undefined).then(function (res) {
      renderChips(res.groups);
      res.messages.forEach(function (m) {
        if (rx.logged[m.msgId]) return;
        rx.logged[m.msgId] = true;
        addLog({ text: m.text, sealed: m.sealed, chunks: m.chunks, at: Date.now(), msgId: m.msgId });
      });
      res.errors.forEach(function (e) {
        var key = 'err:' + e.msgId;
        if (rx.logged[key]) return;
        if (e.reason === 'NEED_KEY') return; // wait for the user to type a key
        rx.logged[key] = true;
        addLog({ text: e.reason === 'AUTH' ? '密钥不对，或这段声音被改动了（' + e.msgId + '）' : '解不开：' + e.reason, error: true, at: Date.now() });
      });
    }).catch(function (err) {
      console.error(err);
    }).then(function () {
      flushing = false;
      if (flushAgain) { flushAgain = false; flushAssembler(force); }
    });
  }

  function renderChips(groups) {
    var box = $('chips');
    box.innerHTML = '';
    (groups || []).forEach(function (g) {
      var el = document.createElement('span');
      el.textContent = g.msgId + ' · ' + g.received + '/' + g.total;
      el.className = g.state === 'done' ? 'done' : (g.state === 'locked' ? 'locked' : (g.received ? 'got' : ''));
      el.title = g.state;
      box.appendChild(el);
    });
  }

  /* ------------------------------------------------------------------ */
  /* log + history                                                       */
  /* ------------------------------------------------------------------ */

  function loadHistory() {
    try {
      var raw = localStorage.getItem(HISTORY_KEY);
      if (!raw) return [];
      var arr = JSON.parse(raw);
      return Array.isArray(arr) ? arr : [];
    } catch (e) { return []; }
  }

  function saveHistory(list) {
    try { localStorage.setItem(HISTORY_KEY, JSON.stringify(list.slice(0, HISTORY_MAX))); } catch (e) { /* full */ }
  }

  function addLog(entry) {
    var log = $('log');
    var empty = log.querySelector('.empty');
    if (empty) empty.remove();

    var li = document.createElement('li');
    if (entry.error) li.className = 'err';

    var head = document.createElement('div');
    head.className = 'msgHead';
    var time = document.createElement('span');
    var d = new Date(entry.at || Date.now());
    time.textContent = ('0' + d.getHours()).slice(-2) + ':' + ('0' + d.getMinutes()).slice(-2) + ':' + ('0' + d.getSeconds()).slice(-2);
    head.appendChild(time);

    if (!entry.error) {
      var tag = document.createElement('span');
      tag.className = 'tag';
      tag.textContent = entry.sealed ? 'AES-GCM' : '明文';
      head.appendChild(tag);
      var chunks = document.createElement('span');
      chunks.textContent = (entry.chunks || 1) + ' 帧';
      head.appendChild(chunks);
    }

    var spacer = document.createElement('span');
    spacer.className = 'spacer';
    head.appendChild(spacer);

    if (!entry.error) {
      var copy = document.createElement('button');
      copy.className = 'copy';
      copy.type = 'button';
      copy.textContent = '复制';
      copy.addEventListener('click', function () {
        navigator.clipboard.writeText(entry.text).then(function () {
          copy.textContent = '已复制';
          setTimeout(function () { copy.textContent = '复制'; }, 1400);
        });
      });
      head.appendChild(copy);
    }

    var body = document.createElement('div');
    body.className = 'msgText';
    body.textContent = entry.text;

    li.appendChild(head);
    li.appendChild(body);
    log.insertBefore(li, log.firstChild);

    if (!entry.error) bumpBadge();

    if (!entry.error) {
      var hist = loadHistory();
      hist.unshift({ text: entry.text, sealed: !!entry.sealed, at: entry.at || Date.now() });
      saveHistory(hist);
    }
  }

  function clearLog() {
    $('log').innerHTML = '<li class="empty">还没有解出任何消息。打开麦克风，或载入一段录音。</li>';
    try { localStorage.removeItem(HISTORY_KEY); } catch (e) { /* noop */ }
    rx.logged = Object.create(null);
    rx.asm.reset();
    renderChips([]);
  }

  function restoreLog() {
    var hist = loadHistory();
    if (!hist.length) return;
    hist.slice(0, 20).reverse().forEach(function (h) {
      addLogSilently(h);
    });
  }

  function addLogSilently(entry) {
    var log = $('log');
    var empty = log.querySelector('.empty');
    if (empty) empty.remove();
    var li = document.createElement('li');
    var head = document.createElement('div');
    head.className = 'msgHead';
    var time = document.createElement('span');
    var d = new Date(entry.at);
    time.textContent = d.getMonth() + 1 + '月' + d.getDate() + '日 ' + ('0' + d.getHours()).slice(-2) + ':' + ('0' + d.getMinutes()).slice(-2);
    head.appendChild(time);
    var tag = document.createElement('span');
    tag.className = 'tag';
    tag.textContent = entry.sealed ? 'AES-GCM' : '明文';
    head.appendChild(tag);
    var spacer = document.createElement('span');
    spacer.className = 'spacer';
    head.appendChild(spacer);
    var copy = document.createElement('button');
    copy.className = 'copy';
    copy.type = 'button';
    copy.textContent = '复制';
    copy.addEventListener('click', function () {
      navigator.clipboard.writeText(entry.text);
    });
    head.appendChild(copy);
    var body = document.createElement('div');
    body.className = 'msgText';
    body.textContent = entry.text;
    li.appendChild(head);
    li.appendChild(body);
    log.appendChild(li);
  }

  /* ------------------------------------------------------------------ */
  /* WAV export + file decode                                            */
  /* ------------------------------------------------------------------ */

  function exportWav() {
    if (!audio) return;
    var samples = audio.samples;
    var rate = modemRate;
    var buf = new ArrayBuffer(44 + samples.length * 2);
    var view = new DataView(buf);
    var writeStr = function (off, s) {
      for (var i = 0; i < s.length; i++) view.setUint8(off + i, s.charCodeAt(i));
    };
    writeStr(0, 'RIFF');
    view.setUint32(4, 36 + samples.length * 2, true);
    writeStr(8, 'WAVE');
    writeStr(12, 'fmt ');
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);          // PCM
    view.setUint16(22, 1, true);          // mono
    view.setUint32(24, rate, true);
    view.setUint32(28, rate * 2, true);
    view.setUint16(32, 2, true);
    view.setUint16(34, 16, true);
    writeStr(36, 'data');
    view.setUint32(40, samples.length * 2, true);
    var at = 44;
    for (var i = 0; i < samples.length; i++) {
      var v = Math.max(-1, Math.min(1, samples[i]));
      view.setInt16(at, Math.round(v * 32767), true);
      at += 2;
    }

    var blob = new Blob([buf], { type: 'audio/wav' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = 'sonicseal-' + Date.now() + '.wav';
    a.click();
    setTimeout(function () { URL.revokeObjectURL(url); }, 8000);
    setStatus('已导出 WAV · ' + audio.duration.toFixed(1) + ' 秒', 'ok');
  }

  function decodeFile(file) {
    if (!file) return;
    ensureContext().then(function () {
      return file.arrayBuffer();
    }).then(function (arr) {
      return ctx.decodeAudioData(arr);
    }).then(function (buffer) {
      modemRate = buffer.sampleRate; // decode at the file's own rate
      resetModem();
      rx.asm.reset();
      rx.logged = Object.create(null);
      renderChips([]);

      var samples;
      if (buffer.numberOfChannels > 1) {
        var a = buffer.getChannelData(0);
        var b = buffer.getChannelData(1);
        samples = new Float32Array(a.length);
        for (var i = 0; i < a.length; i++) samples[i] = (a[i] + b[i]) / 2;
      } else {
        samples = buffer.getChannelData(0);
      }

      setStatus('正在解码录音 · ' + samples.length / buffer.sampleRate + ' 秒', 'ok');
      var found = 0;
      var step = 1024;
      for (var off = 0; off + step <= samples.length; off += step) {
        var chunk = samples.subarray(off, off + step);
        var res;
        try {
          res = gg.decode(modem, floatToInt16View(chunk));
        } catch (e) { continue; }
        if (res && res.length) {
          var raw = new Uint8Array(res.buffer, res.byteOffset, res.length);
          var wire = '';
          for (var k = 0; k < raw.length; k++) wire += String.fromCharCode(raw[k]);
          var frame = S.unpackWire(wire);
          if (S.parseFrame(frame)) { rx.asm.push(frame); found++; }
        }
      }
      flushAssembler(true);
      if (found) setStatus('录音里找到 ' + found + ' 个声学帧', 'ok');
      else setStatus('录音里没有可识别的 SonicSeal 帧', 'bad');
    }).catch(function (err) {
      console.error(err);
      setStatus('读取音频失败', 'bad');
    });
  }

  /* ------------------------------------------------------------------ */
  /* brand mark                                                          */
  /* ------------------------------------------------------------------ */

  function drawIdleMark() {
    var cv = $('mark');
    if (!cv) return;
    var dpr = Math.min(window.devicePixelRatio || 1, 2);
    cv.width = 60 * dpr; cv.height = 60 * dpr;
    var c = cv.getContext('2d');
    c.setTransform(dpr, 0, 0, dpr, 0, 0);
    var cx = 30, cy = 30;
    c.clearRect(0, 0, 60, 60);
    c.strokeStyle = 'rgba(70,224,208,0.85)';
    c.lineWidth = 1.4;
    for (var k = 1; k <= 3; k++) {
      c.globalAlpha = 0.9 - k * 0.22;
      c.beginPath(); c.arc(cx, cy, 5 + k * 6.5, -1.05, 1.05); c.stroke();
    }
    c.globalAlpha = 1;
    c.fillStyle = '#46e0d0';
    c.beginPath(); c.arc(cx, cy, 2.6, 0, Math.PI * 2); c.fill();
    c.strokeStyle = 'rgba(70,224,208,0.35)';
    c.lineWidth = 1;
    c.beginPath(); c.arc(cx, cy, 26, 0, Math.PI * 2); c.stroke();
  }

  /* ------------------------------------------------------------------ */
  /* wiring                                                              */
  /* ------------------------------------------------------------------ */

  /* ------------------------------------------------------------------ */
  /* shell: tabs, unread badge, service worker, drag & drop              */
  /* ------------------------------------------------------------------ */

  var shell = { tab: 'send', unread: 0 };

  function bumpBadge() {
    if (shell.tab === 'recv') return;
    shell.unread += 1;
    var badge = $('rxBadge');
    if (!badge) return;
    badge.textContent = shell.unread > 9 ? '9+' : String(shell.unread);
    badge.hidden = false;
  }

  function refitCanvases() {
    drawWave(audio ? audio.samples : null, playing ? null : undefined);
    if (scope.live) drawScopeFrame(); else drawScopeIdle();
    drawIdleMark();
  }

  function showTab(name) {
    shell.tab = name;
    var tabs = document.querySelectorAll('#tabs .tab');
    for (var i = 0; i < tabs.length; i++) {
      var on = tabs[i].getAttribute('data-tab') === name;
      tabs[i].classList.toggle('on', on);
      tabs[i].setAttribute('aria-selected', on ? 'true' : 'false');
    }
    var panels = document.querySelectorAll('#panels .panel');
    for (var j = 0; j < panels.length; j++) {
      panels[j].classList.toggle('on', panels[j].getAttribute('data-panel') === name);
    }
    if (name === 'recv') {
      shell.unread = 0;
      var badge = $('rxBadge');
      if (badge) badge.hidden = true;
    }
    // canvases were display:none while hidden, so they need a fresh measure
    refitCanvases();
    if (name === 'send') window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  function setupShell() {
    var tabs = document.querySelectorAll('#tabs .tab');
    for (var i = 0; i < tabs.length; i++) {
      (function (btn) {
        btn.addEventListener('click', function () { showTab(btn.getAttribute('data-tab')); });
      })(tabs[i]);
    }

    var pick = $('filePick');
    if (pick) {
      ['dragenter', 'dragover'].forEach(function (evt) {
        pick.addEventListener(evt, function (ev) { ev.preventDefault(); pick.classList.add('dragging'); });
      });
      ['dragleave', 'drop'].forEach(function (evt) {
        pick.addEventListener(evt, function () { pick.classList.remove('dragging'); });
      });
      pick.addEventListener('drop', function (ev) {
        ev.preventDefault();
        var f = ev.dataTransfer && ev.dataTransfer.files && ev.dataTransfer.files[0];
        if (f) decodeFile(f);
      });
    }

    // offline shell — only meaningful when served over http(s)
    if ('serviceWorker' in navigator && location.protocol !== 'file:') {
      window.addEventListener('load', function () {
        navigator.serviceWorker.register('sw.js').catch(function () { /* ignore */ });
      });
    }

    // desktop folds the two panels side by side; keep the send tab active there
    if (window.matchMedia && window.matchMedia('(min-width: 980px)').matches) {
      shell.tab = 'send';
    }
  }

  function bind() {
    $('plain').addEventListener('input', refreshSendMeta);
    $('speed').addEventListener('change', function () {
      refreshSendMeta();
      if (sealed) { sealed = null; $('wavBtn').disabled = true; $('copyWireBtn').disabled = true; renderFrameStrip(); }
    });
    $('pass').addEventListener('input', refreshSendMeta);
    $('playBtn').addEventListener('click', function () {
      if (playing) stopPlayback(); else onSeal();
    });
    $('wavBtn').addEventListener('click', exportWav);
    $('copyWireBtn').addEventListener('click', function () {
      if (!sealed) return;
      var text = sealed.wires.join('\n');
      navigator.clipboard.writeText(text).then(function () {
        setStatus('已复制 ' + sealed.wires.length + ' 帧报文', 'ok');
      });
    });

    ['pass', 'passRx'].forEach(function (id) {
      var eye = $(id === 'pass' ? 'eye' : 'eyeRx');
      eye.addEventListener('click', function () {
        var input = $(id);
        input.type = input.type === 'password' ? 'text' : 'password';
        eye.textContent = input.type === 'password' ? '◍' : '◉';
      });
    });

    $('micBtn').addEventListener('click', toggleMic);
    $('clearLog').addEventListener('click', clearLog);
    $('file').addEventListener('change', function (ev) {
      if (ev.target.files && ev.target.files[0]) decodeFile(ev.target.files[0]);
      ev.target.value = '';
    });

    var rxTimer = 0;
    $('passRx').addEventListener('input', function () {
      clearTimeout(rxTimer);
      rxTimer = setTimeout(function () {
        rx.logged = Object.create(null);
        flushAssembler(true);
      }, 450);
    });

    window.addEventListener('resize', function () {
      drawWave(audio ? audio.samples : null, playing ? null : undefined);
      if (!scope.live) drawScopeIdle();
    });

    window.addEventListener('beforeunload', function () {
      if (rx.stream) rx.stream.getTracks().forEach(function (t) { t.stop(); });
    });
  }

  document.addEventListener('DOMContentLoaded', function () {
    setupShell();
    bind();
    restoreLog();
    boot();
  });
})();
