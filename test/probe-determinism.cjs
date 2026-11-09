const factory = require('../vendor/ggwave.js');
const SR = 48000;
(async () => {
  const ggwave = await factory(); ggwave.disableLog();
  const mk = () => { const p = ggwave.getDefaultParameters(); p.sampleRateInp=SR; p.sampleRateOut=SR;
    p.sampleFormatInp=ggwave.SampleFormat.GGWAVE_SAMPLE_FORMAT_I16; p.sampleFormatOut=ggwave.SampleFormat.GGWAVE_SAMPLE_FORMAT_I16; return ggwave.init(p); };
  const inst = mk();
  const P = ggwave.ProtocolId;
  const payload = 'A'.repeat(70) + 'b'.repeat(70);
  const w = ggwave.encode(inst, payload, P.GGWAVE_PROTOCOL_AUDIBLE_FAST, 25);
  const bytes = Int8Array.from(new Uint8Array(w.buffer, w.byteOffset, w.byteLength));
  const n = bytes.length / 2;
  const f32 = new Float32Array(n);
  for (let i = 0; i < n; i++) { const v = (bytes[2*i] & 0xff) | ((bytes[2*i+1] & 0xff) << 8); f32[i] = (v << 16 >> 16) / 32768; }
  let rms = 0; for (let i = 0; i < n; i++) rms += f32[i]*f32[i]; rms = Math.sqrt(rms/n);
  console.log('wave samples', n, 'rms', rms.toFixed(4));
  const pad = new Float32Array(Math.round(0.4*SR));
  const sig = new Float32Array(n + pad.length); sig.set(f32, 0);

  // reuse one decoder instance across runs
  for (let run = 0; run < 6; run++) {
    const rx = mk();
    let out = [];
    for (let off = 0; off + 1024 <= sig.length; off += 1024) {
      const s = new Int16Array(1024);
      for (let i = 0; i < 1024; i++) s[i] = Math.round(sig[off+i]*32767);
      const r = ggwave.decode(rx, new Int8Array(s.buffer));
      if (r && r.length) out.push(r.length);
    }
    console.log('run', run, 'handle', rx, 'results:', JSON.stringify(out));
    if (rx) ggwave.free(rx);
  }
})();
