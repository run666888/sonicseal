const factory = require('../vendor/ggwave.js');
(async () => {
  const ggwave = await factory(); ggwave.disableLog();
  const mk = () => { const p = ggwave.getDefaultParameters(); p.sampleRateInp=48000; p.sampleRateOut=48000;
    p.sampleFormatInp=ggwave.SampleFormat.GGWAVE_SAMPLE_FORMAT_I16; p.sampleFormatOut=ggwave.SampleFormat.GGWAVE_SAMPLE_FORMAT_I16; return ggwave.init(p); };
  const inst = mk();
  const P = ggwave.ProtocolId;
  const payload = 'A'.repeat(70) + 'b'.repeat(70);
  for (const [name, proto] of [['FAST', P.GGWAVE_PROTOCOL_AUDIBLE_FAST], ['FASTEST', P.GGWAVE_PROTOCOL_AUDIBLE_FASTEST]]) {
    const w = ggwave.encode(inst, payload, proto, 25);
    const copy = Int8Array.from(new Uint8Array(w.buffer, w.byteOffset, w.byteLength));
    console.log(name, 'wave bytes', copy.length, 'sec', (copy.length/2/48000).toFixed(2));
    const rx = mk();
    const res = ggwave.decode(rx, copy);  // whole waveform at once
    const got = res ? Buffer.from(new Uint8Array(res.buffer, res.byteOffset, res.length)) : null;
    console.log('  whole-decode ->', got ? got.length : 'none', got ? JSON.stringify(got.toString('latin1').slice(0,20)) : '');
    if (got && got.length === payload.length) console.log('  match:', got.toString('latin1') === payload);
    // chunked
    const rx2 = mk(); let hits = 0;
    const f32 = new Float32Array(copy.length/2);
    for (let i=0;i<f32.length;i++){ const b=(copy[2*i]&0xff)|((copy[2*i+1]&0xff)<<8); f32[i]=(b<<16>>16)/32768; }
    const pad = new Float32Array(48000*0.4);
    const sig = new Float32Array(f32.length+pad.length); sig.set(f32,0);
    for (let off=0; off+1024<=sig.length; off+=1024) {
      const s=new Int16Array(1024); for(let i=0;i<1024;i++) s[i]=Math.round(sig[off+i]*32767);
      const r = ggwave.decode(rx2, new Int8Array(s.buffer));
      if (r && r.length) { const g = Buffer.from(new Uint8Array(r.buffer, r.byteOffset, r.length)).toString('latin1'); hits++; console.log('  chunk result len', g.length, 'match', g===payload); }
    }
  }
})();
