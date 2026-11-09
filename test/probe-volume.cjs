const factory = require('../vendor/ggwave.js');
(async () => {
  const g = await factory(); g.disableLog();
  const p = g.getDefaultParameters(); p.sampleRateInp=48000; p.sampleRateOut=48000;
  p.sampleFormatInp=g.SampleFormat.GGWAVE_SAMPLE_FORMAT_I16; p.sampleFormatOut=g.SampleFormat.GGWAVE_SAMPLE_FORMAT_I16;
  const inst = g.init(p);
  const wire = 'x'.repeat(20);
  for (const v of [10, 25, 50, 75, 100]) {
    const w = g.encode(inst, wire, g.ProtocolId.GGWAVE_PROTOCOL_AUDIBLE_FAST, v);
    const b = new Uint8Array(w.buffer, w.byteOffset, w.byteLength);
    let peak = 0, rms = 0, n = b.length/2;
    for (let i = 0; i < n; i++) { const s = ((b[2*i]&0xff) | ((b[2*i+1]&0xff)<<8)) << 16 >> 16; const a = Math.abs(s); if (a>peak) peak=a; rms += (s/32768)**2; }
    console.log('volume', String(v).padStart(3), 'peak', (peak/32768).toFixed(3), 'rms', Math.sqrt(rms/n).toFixed(3));
  }
  g.free(inst);
})();
