// Investigate how ggwave's JS bindings move binary payloads through std::string.
const factory = require('../vendor/ggwave.js');

function pack7(bytes) {
  let v = 0, bits = 0, out = '';
  for (let i = 0; i < bytes.length; i++) {
    v = (v << 8) | bytes[i];
    bits += 8;
    while (bits >= 7) {
      out += String.fromCharCode((v >>> (bits - 7)) & 0x7f);
      bits -= 7;
    }
  }
  if (bits > 0) out += String.fromCharCode((v << (7 - bits)) & 0x7f);
  return out;
}

function unpack7(str) {
  let v = 0, bits = 0;
  const out = [];
  for (let i = 0; i < str.length; i++) {
    v = (v << 7) | (str.charCodeAt(i) & 0x7f);
    bits += 7;
    while (bits >= 8) {
      out.push((v >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Uint8Array.from(out);
}

(async () => {
  const ggwave = await factory();
  ggwave.disableLog();
  const params = ggwave.getDefaultParameters();
  params.sampleRateInp = 48000; params.sampleRateOut = 48000;
  params.sampleFormatInp = ggwave.SampleFormat.GGWAVE_SAMPLE_FORMAT_I16;
  params.sampleFormatOut = ggwave.SampleFormat.GGWAVE_SAMPLE_FORMAT_I16;
  const inst = ggwave.init(params);
  const proto = ggwave.ProtocolId.GGWAVE_PROTOCOL_AUDIBLE_FASTEST;

  const roundtrip = (label, inputStr) => {
    const w = ggwave.encode(inst, inputStr, proto, 20);
    const res = ggwave.decode(inst, w);
    const got = res ? Buffer.from(new Uint8Array(res.buffer, res.byteOffset, res.length)) : null;
    const sent = Buffer.from(inputStr, 'utf8');
    const ok = got && got.equals(sent);
    console.log(label.padEnd(28), 'chars', String(inputStr.length).padStart(3),
      'expect bytes', String(sent.length).padStart(3), 'got', got ? got.length : 'none', ok ? 'EXACT' : 'DIFF');
    if (!ok && got) {
      let firstDiff = -1;
      for (let i = 0; i < Math.min(got.length, sent.length); i++) if (got[i] !== sent[i]) { firstDiff = i; break; }
      console.log('   first diff at', firstDiff, 'sent', sent.slice(Math.max(0, firstDiff - 2), firstDiff + 3),
        'got', got.slice(Math.max(0, firstDiff - 2), firstDiff + 3));
    }
    return ok;
  };

  // 1. plain ASCII
  roundtrip('ascii', 'hello world 123');
  // 2. char 0xFF (should reveal UTF-8 re-encoding)
  roundtrip('single 0xFF char', String.fromCharCode(0xff));
  // 3. NUL inside string
  roundtrip('nul inside', 'ab\u0000cd');
  // 4. all 0..127 chars
  let allAscii = '';
  for (let i = 0; i < 128; i++) allAscii += String.fromCharCode(i);
  roundtrip('chars 0..127', allAscii);
  // 5. 140-char window of 0..127
  roundtrip('140 chars 0..127', allAscii.slice(0, 140));

  // 6. packed random frame, 122 bytes -> 140 chars
  const frame = new Uint8Array(122);
  for (let i = 0; i < frame.length; i++) frame[i] = (i * 37 + 11) & 0xff;
  const wire = pack7(frame);
  console.log('packed', frame.length, 'bytes ->', wire.length, 'chars');
  const w = ggwave.encode(inst, wire, proto, 20);
  const res = ggwave.decode(inst, w);
  const back = res ? String.fromCharCode(...new Uint8Array(res.buffer, res.byteOffset, res.length)) : '';
  const unpacked = unpack7(back);
  const same = unpacked.length === frame.length && unpacked.every((b, i) => b === frame[i]);
  console.log('pack7 roundtrip:', same ? 'EXACT' : 'FAIL', 'chars back:', back.length, 'bytes back:', unpacked.length);

  // 7. random binary WITHOUT packing (should fail)
  const raw = new Uint8Array(122);
  for (let i = 0; i < raw.length; i++) raw[i] = Math.floor(Math.random() * 256);
  const rawStr = String.fromCharCode(...raw);
  const w2 = ggwave.encode(inst, rawStr, proto, 20);
  const res2 = ggwave.decode(inst, w2);
  const got2 = res2 ? new Uint8Array(res2.buffer, res2.byteOffset, res2.length) : new Uint8Array();
  console.log('raw binary (no pack):', got2.length === 122 && got2.every((b, i) => b === raw[i]) ? 'EXACT' : 'CORRUPTED', 'len', got2.length);

  // 8. duration of a 140-char frame
  console.log('140-char FASTEST duration:', (w.byteLength / 2 / 48000).toFixed(2) + 's');
})().catch(e => { console.error(e); process.exit(1); });
