// Probe the vendored ggwave wasm build: API shape, payload limits, roundtrip.
const factory = require('../vendor/ggwave.js');

(async () => {
  const ggwave = await factory();
  console.log('module keys:', Object.keys(ggwave).join(','));
  console.log('SampleFormat:', JSON.stringify(ggwave.SampleFormat));
  console.log('ProtocolId:', JSON.stringify(ggwave.ProtocolId));

  const params = ggwave.getDefaultParameters();
  console.log('default params:', JSON.stringify(params));

  params.sampleRateInp = 48000;
  params.sampleRateOut = 48000;
  params.sampleFormatInp = ggwave.SampleFormat.GGWAVE_SAMPLE_FORMAT_I16;
  params.sampleFormatOut = ggwave.SampleFormat.GGWAVE_SAMPLE_FORMAT_I16;
  const instance = ggwave.init(params);
  ggwave.disableLog();

  const proto = ggwave.ProtocolId.GGWAVE_PROTOCOL_AUDIBLE_FAST;
  const payload = 'hello js';
  const waveform = ggwave.encode(instance, payload, proto, 10);
  console.log('waveform ctor:', waveform && waveform.constructor && waveform.constructor.name, 'len:', waveform.length);

  const asBytes = new Uint8Array(waveform.buffer, waveform.byteOffset, waveform.byteLength);
  console.log('duration sec:', (waveform.length / 1) ,
    (asBytes.length / 2 / 48000).toFixed(3));

  // try decode with the returned view
  const r1 = ggwave.decode(instance, waveform);
  console.log('decode(view) ->', r1 && r1.length, r1 && String.fromCharCode(...r1).slice(0, 40));

  // try decode with binary string
  let bin = '';
  for (let i = 0; i < asBytes.length; i++) bin += String.fromCharCode(asBytes[i]);
  const r2 = ggwave.decode(instance, bin);
  console.log('decode(binary string) ->', r2 && r2.length, r2 && String.fromCharCode(...r2).slice(0, 40));

  // payload ceiling probe
  for (const n of [180, 200, 220, 240, 256, 300]) {
    const text = 'A'.repeat(n);
    try {
      const w = ggwave.encode(instance, text, proto, 10);
      const bytes = new Uint8Array(w.buffer, w.byteOffset, w.byteLength);
      console.log('len', n, '-> waveform samples', w.length, 'sec', (bytes.length / 2 / 48000).toFixed(2));
    } catch (e) {
      console.log('len', n, '-> THROW', e.message || e);
    }
  }
})().catch(e => { console.error('FATAL', e); process.exit(1); });
