// Probe payload length -> waveform duration for each protocol + roundtrip with noise.
const factory = require('../vendor/ggwave.js');

(async () => {
  const ggwave = await factory();
  ggwave.disableLog();
  const params = ggwave.getDefaultParameters();
  params.sampleRateInp = 48000;
  params.sampleRateOut = 48000;
  params.sampleFormatInp = ggwave.SampleFormat.GGWAVE_SAMPLE_FORMAT_I16;
  params.sampleFormatOut = ggwave.SampleFormat.GGWAVE_SAMPLE_FORMAT_I16;
  const instance = ggwave.init(params);

  const P = ggwave.ProtocolId;
  const protocols = {
    AUDIBLE_NORMAL: P.GGWAVE_PROTOCOL_AUDIBLE_NORMAL,
    AUDIBLE_FAST: P.GGWAVE_PROTOCOL_AUDIBLE_FAST,
    AUDIBLE_FASTEST: P.GGWAVE_PROTOCOL_AUDIBLE_FASTEST,
    ULTRASOUND_FAST: P.GGWAVE_PROTOCOL_ULTRASOUND_FAST,
    DT_FAST: P.GGWAVE_PROTOCOL_DT_FAST,
  };
  console.log('protocol ids:', JSON.stringify(protocols));

  const toF32 = (view) => {
    const bytes = new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
    const i16 = new Int16Array(bytes.buffer, bytes.byteOffset, bytes.byteLength >> 1);
    const f = new Float32Array(i16.length);
    for (let i = 0; i < i16.length; i++) f[i] = i16[i] / 32768;
    return f;
  };
  const fromF32 = (f) => {
    const i16 = new Int16Array(f.length);
    for (let i = 0; i < f.length; i++) {
      let v = Math.round(f[i] * 32767);
      i16[i] = v > 32767 ? 32767 : v < -32768 ? -32768 : v;
    }
    return new Int8Array(i16.buffer);
  };

  for (const [name, proto] of Object.entries(protocols)) {
    const row = [];
    for (const n of [8, 32, 64, 100, 140, 180, 220, 256]) {
      const text = 'x'.repeat(n);
      try {
        const w = ggwave.encode(instance, text, proto, 10);
        const sec = w.length / 2 / 48000;
        row.push(`${n}:${sec.toFixed(1)}s`);
      } catch (e) { row.push(`${n}:ERR`); }
    }
    console.log(name.padEnd(18), row.join('  '));
  }

  // roundtrip + noise robustness on AUDIBLE_FAST & FASTEST
  const payload = 'The quick brown fox jumps over 13 lazy dogs!';
  for (const [name, proto] of Object.entries({ AUDIBLE_FAST: protocols.AUDIBLE_FAST, AUDIBLE_FASTEST: protocols.AUDIBLE_FASTEST })) {
    const w = ggwave.encode(instance, payload, proto, 10);
    const clean = toF32(w);
    const cases = {
      clean,
      noise10db: addNoise(clean, 0.1),
      noise5db: addNoise(clean, 0.3),
      quiet: scale(clean, 0.05),
      echo: addEcho(clean, 48000 * 0.08, 0.35),
    };
    const out = [];
    for (const [cn, sig] of Object.entries(cases)) {
      const res = ggwave.decode(instance, fromF32(sig));
      const txt = res && res.length ? Buffer.from(new Uint8Array(res.buffer, res.byteOffset, res.length)).toString() : '';
      out.push(`${cn}:${txt === payload ? 'OK' : (txt ? 'WRONG(' + txt.slice(0, 12) + ')' : 'fail')}`);
    }
    console.log(name.padEnd(18), payload.length, 'bytes ->', out.join(' '));
  }

  // streamed decode in 1024-sample chunks (like mic)
  const w = ggwave.encode(instance, payload, protocols.AUDIBLE_FAST, 10);
  const sig = toF32(w);
  let got = null;
  for (let off = 0; off + 1024 <= sig.length; off += 1024) {
    const res = ggwave.decode(instance, fromF32(sig.subarray(off, off + 1024)));
    if (res && res.length) { got = Buffer.from(new Uint8Array(res.buffer, res.byteOffset, res.length)).toString(); }
  }
  console.log('streamed 1024-chunks:', got === payload ? 'OK' : String(got).slice(0, 20));

  // max payload probe: does decode return what was sent?
  for (const n of [256, 300, 400, 600]) {
    const text = 'y'.repeat(n);
    try {
      const w2 = ggwave.encode(instance, text, protocols.AUDIBLE_FAST, 10);
      const res = ggwave.decode(instance, w2);
      const len = res ? res.length : 0;
      console.log('payload', n, 'wave', (w2.length / 2 / 48000).toFixed(2) + 's', 'decoded len', len, len === n ? 'EXACT' : '');
    } catch (e) { console.log('payload', n, 'THROW', String(e).slice(0, 80)); }
  }

  function addNoise(f, amp) {
    const o = new Float32Array(f.length);
    for (let i = 0; i < f.length; i++) o[i] = f[i] + (Math.random() * 2 - 1) * amp;
    return o;
  }
  function scale(f, k) { const o = new Float32Array(f.length); for (let i = 0; i < f.length; i++) o[i] = f[i] * k; return o; }
  function addEcho(f, delay, g) {
    const o = new Float32Array(f.length);
    for (let i = 0; i < f.length; i++) o[i] = f[i] + (i >= delay ? g * f[i - delay] : 0);
    return o;
  }
})().catch(e => { console.error('FATAL', e); process.exit(1); });
