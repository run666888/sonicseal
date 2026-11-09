(async () => {
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  const m = await window.ggwave_factory();
  m.disableLog();
  const log = [];
  const p = m.getDefaultParameters();
  log.push('defaults ' + JSON.stringify({ pl: p.payloadLength, i: p.sampleRateInp, o: p.sampleRateOut, s: p.sampleRate, f: p.samplesPerFrame, smt: p.soundMarkerThreshold, om: p.operatingMode }));
  let a;
  try { a = m.init(p); } catch (e) { log.push('init(default) threw ' + e.message); }
  log.push('init(default) = ' + a);
  if (a) m.free(a);
  const q = m.getDefaultParameters();
  q.sampleRateInp = 48000; q.sampleRateOut = 48000;
  q.sampleFormatInp = m.SampleFormat.GGWAVE_SAMPLE_FORMAT_I16;
  q.sampleFormatOut = m.SampleFormat.GGWAVE_SAMPLE_FORMAT_I16;
  let b;
  try { b = m.init(q); } catch (e) { log.push('init(48k,i16, no operatingMode) threw ' + e.message); }
  log.push('init(48k,i16,noOM) = ' + b);
  if (b) { m.free(b); }
  const r = m.getDefaultParameters();
  r.sampleRateInp = 48000; r.sampleRateOut = 48000; r.sampleRate = 48000;
  r.sampleFormatInp = m.SampleFormat.GGWAVE_SAMPLE_FORMAT_I16;
  r.sampleFormatOut = m.SampleFormat.GGWAVE_SAMPLE_FORMAT_I16;
  r.operatingMode = 6;
  let c;
  try { c = m.init(r); } catch (e) { log.push('init(full) threw ' + e.message); }
  log.push('init(full) = ' + c);
  return log.join('\n');
})()
