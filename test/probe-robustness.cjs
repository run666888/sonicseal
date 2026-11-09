// Compare AUDIBLE_FAST vs AUDIBLE_FASTEST robustness at increasing noise/echo.
const factory = require('../vendor/ggwave.js');
const SR = 48000;

function toF32(view) {
  const bytes = new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
  const i16 = new Int16Array(bytes.buffer, bytes.byteOffset, bytes.byteLength >> 1);
  const out = new Float32Array(i16.length);
  for (let i = 0; i < i16.length; i++) out[i] = i16[i] / 32768;
  return out;
}
function fromF32(sig) {
  const i16 = new Int16Array(sig.length);
  for (let i = 0; i < sig.length; i++) i16[i] = Math.round(Math.max(-1, Math.min(1, sig[i])) * 32767);
  return new Int8Array(i16.buffer);
}

(async () => {
  const ggwave = await factory();
  ggwave.disableLog();
  const mk = () => {
    const p = ggwave.getDefaultParameters();
    p.sampleRateInp = SR; p.sampleRateOut = SR;
    p.sampleFormatInp = ggwave.SampleFormat.GGWAVE_SAMPLE_FORMAT_I16;
    p.sampleFormatOut = ggwave.SampleFormat.GGWAVE_SAMPLE_FORMAT_I16;
    return ggwave.init(p);
  };
  const inst = mk();
  const P = ggwave.ProtocolId;

  // 140-char ASCII payload (worst case for the audibles)
  const payload = 'A'.repeat(70) + 'b'.repeat(70);

  function room(sig, delayMs, wet) {
    const d = Math.round(delayMs / 1000 * SR);
    const out = new Float32Array(sig.length + d);
    out.set(sig, 0);
    for (let i = 0; i < sig.length; i++) out[i + d] += wet * sig[i];
    return out;
  }
  function noise(sig, amp) {
    const out = new Float32Array(sig.length);
    for (let i = 0; i < sig.length; i++) out[i] = sig[i] + (Math.random() * 2 - 1) * amp;
    return out;
  }
  function gain(sig, k) {
    const out = new Float32Array(sig.length);
    for (let i = 0; i < sig.length; i++) out[i] = sig[i] * k;
    return out;
  }

  const cases = [
    ['clean', (s) => s],
    ['gain0.2', (s) => gain(s, 0.2)],
    ['gain0.2+echo30%', (s) => room(gain(s, 0.2), 60, 0.3)],
    ['gain0.2+echo+n0.01', (s) => noise(room(gain(s, 0.2), 60, 0.3), 0.01)],
    ['gain0.2+echo+n0.03', (s) => noise(room(gain(s, 0.2), 60, 0.3), 0.03)],
    ['gain0.2+echo+n0.06', (s) => noise(room(gain(s, 0.2), 60, 0.3), 0.06)],
    ['far: gain0.05+n0.01', (s) => noise(gain(s, 0.05), 0.01)],
  ];

  for (const [name, proto] of [['FAST', P.GGWAVE_PROTOCOL_AUDIBLE_FAST], ['FASTEST', P.GGWAVE_PROTOCOL_AUDIBLE_FASTEST]]) {
    const w = ggwave.encode(inst, payload, proto, 25);
    const core = toF32(w);
    const pad = new Float32Array(Math.round(0.4*SR));
    const clean = new Float32Array(core.length + pad.length);
    clean.set(core, 0);
    const sec = (w.byteLength / 2 / SR).toFixed(2);
    const row = [];
    for (const [label, fn] of cases) {
      let hits = 0;
      const runs = 6;
      for (let r = 0; r < runs; r++) {
        const sig = fn(clean);
        const rx = mk();
        let ok = false;
        const gotList = [];
        const frame = 1024;
        for (let off = 0; off + frame <= sig.length; off += frame) {
          const res = ggwave.decode(rx, fromF32(sig.subarray(off, off + frame)));
          if (res && res.length) {
            const got = Buffer.from(new Uint8Array(res.buffer, res.byteOffset, res.length)).toString('latin1');
            gotList.push(got);
            if (got === payload) { ok = true; break; }
          }
        }
        if (ok) hits++; else if (process.env.DBG) console.log('   miss', name, label, 'results', gotList.map(g=>g.length).join(','));
      }
      row.push(`${label}:${hits}/${runs}`);
    }
    console.log(name.padEnd(8), sec + 's', row.join('  '));
  }
})().catch(e => { console.error(e); process.exit(1); });
