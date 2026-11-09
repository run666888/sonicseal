// SonicSeal — integration tests: envelope + acoustic channel simulation.
// Run with: node test/run-tests.cjs
'use strict';

const assert = require('node:assert/strict');
const ggwaveFactory = require('../vendor/ggwave.js');
const SonicSeal = require('../assets/envelope.js');

const SR = 48000;

/* ----------------------------- helpers ----------------------------- */

function toF32(view) {
  const bytes = new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
  const i16 = new Int16Array(bytes.buffer, bytes.byteOffset, bytes.byteLength >> 1);
  const out = new Float32Array(i16.length);
  for (let i = 0; i < i16.length; i++) out[i] = i16[i] / 32768;
  return out;
}

function fromF32(sig) {
  const i16 = new Int16Array(sig.length);
  for (let i = 0; i < sig.length; i++) {
    const v = Math.round(Math.max(-1, Math.min(1, sig[i])) * 32767);
    i16[i] = v;
  }
  return new Int8Array(i16.buffer);
}

function silence(seconds) { return new Float32Array(Math.round(SR * seconds)); }

function gain(sig, k) {
  const out = new Float32Array(sig.length);
  for (let i = 0; i < sig.length; i++) out[i] = sig[i] * k;
  return out;
}

// crude room: one early reflection + a diffuse tail
function room(sig, delayMs, wet) {
  const d = Math.round((delayMs / 1000) * SR);
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

function concat(list) {
  let n = 0;
  for (const s of list) n += s.length;
  const out = new Float32Array(n);
  let at = 0;
  for (const s of list) { out.set(s, at); at += s.length; }
  return out;
}

function decodeSignal(ggwave, instance, sig) {
  const found = [];
  const frame = 1024;
  for (let off = 0; off + frame <= sig.length; off += frame) {
    const res = ggwave.decode(instance, fromF32(sig.subarray(off, off + frame)));
    if (res && res.length) {
      const raw = new Uint8Array(res.buffer, res.byteOffset, res.length);
      let wire = '';
      for (let i = 0; i < raw.length; i++) wire += String.fromCharCode(raw[i]);
      const frameBytes = SonicSeal.unpackWire(wire);
      if (frameBytes.length) found.push(frameBytes);
    }
  }
  return found;
}

/* ------------------------------ tests ------------------------------ */

const results = [];
async function test(name, fn) {
  const t0 = Date.now();
  try {
    await fn();
    results.push({ name, ok: true, ms: Date.now() - t0 });
    console.log(`  ✔ ${name} (${Date.now() - t0}ms)`);
  } catch (err) {
    results.push({ name, ok: false, ms: Date.now() - t0, err });
    console.log(`  ✘ ${name}\n    ${err && (err.stack || err.message || err)}`);
  }
}

(async () => {
  console.log('\nSonicSeal tests\n===============');
  console.log('canCompress:', SonicSeal.canCompress);

  const ggwave = await ggwaveFactory();
  ggwave.disableLog();
  const P = ggwave.ProtocolId;

  function newInstance(paramsOverride) {
    const params = ggwave.getDefaultParameters();
    params.sampleRateInp = SR;
    params.sampleRateOut = SR;
    params.sampleFormatInp = ggwave.SampleFormat.GGWAVE_SAMPLE_FORMAT_I16;
    params.sampleFormatOut = ggwave.SampleFormat.GGWAVE_SAMPLE_FORMAT_I16;
    if (paramsOverride) Object.assign(params, paramsOverride);
    return ggwave.init(params);
  }
  let instance = newInstance();
  // ggwave's wasm build only supports one live modem at a time: init'ing a
  // second one leaves the first silently dead. Free + re-init to reset state.
  function resetModem() {
    try { ggwave.free(instance); } catch (e) { /* already gone */ }
    instance = newInstance();
  }

  const PASS = 'correct horse battery staple';
  const SHORT = 'Meet me where the river bends at nine. Bring the ledger.';
  const LONG = 'The night train leaves platform four at eleven forty. ' +
    'Take the second carriage, the one with brass fittings. ' +
    'If the lamp above the door is green, sit facing the engine and do not speak. ' +
    'Someone will hand you a folded newspaper before the bridge; keep it closed until morning.';

  await test('seal → open roundtrip (single chunk)', async () => {
    const sealed = await SonicSeal.sealMessage('hello', { passphrase: PASS, compress: false });
    assert.equal(sealed.chunks, 1);
    assert.equal(sealed.sealed, true);
    assert.ok(sealed.frames[0].length <= SonicSeal.MAX_FRAME_BYTES, 'frame within modem budget');
    assert.ok(sealed.wires[0].length <= SonicSeal.WIRE_CHARS, 'wire within ggwave payload limit');
    for (const ch of sealed.wires[0]) assert.ok(ch.charCodeAt(0) < 128, 'wire is ascii-safe');
    const opened = await SonicSeal.openFrame(sealed.frames[0], PASS);
    assert.equal(Buffer.from(opened.payload).toString('utf8'), 'hello');
  });

  await test('wrong passphrase is rejected', async () => {
    const sealed = await SonicSeal.sealMessage(SHORT, { passphrase: PASS });
    await assert.rejects(() => SonicSeal.openFrame(sealed.frames[0], 'wrong key'), (err) => err.code === 'AUTH');
  });

  await test('tampered ciphertext is rejected (AES-GCM tag)', async () => {
    const sealed = await SonicSeal.sealMessage(SHORT, { passphrase: PASS });
    const frame = Uint8Array.from(sealed.frames[0]);
    frame[frame.length - 3] ^= 0x01;
    await assert.rejects(() => SonicSeal.openFrame(frame, PASS), (err) => err.code === 'AUTH');
  });

  await test('header is authenticated as AAD', async () => {
    const sealed = await SonicSeal.sealMessage(SHORT, { passphrase: PASS });
    const frame = Uint8Array.from(sealed.frames[0]);
    frame[8] = 7; // rewrite chunk index
    await assert.rejects(() => SonicSeal.openFrame(frame, PASS), (err) => err.code === 'AUTH');
  });

  await test('cleartext mode works without a key', async () => {
    const sealed = await SonicSeal.sealMessage(SHORT, { passphrase: '', compress: false });
    assert.equal(sealed.sealed, false);
    const opened = await SonicSeal.openFrame(sealed.frames[0], '');
    assert.equal(Buffer.from(opened.payload).toString('utf8'), SHORT);
  });

  await test('long message splits and reassembles', async () => {
    const sealed = await SonicSeal.sealMessage(LONG, { passphrase: PASS, compress: false });
    assert.ok(sealed.chunks > 1, `expected multiple chunks, got ${sealed.chunks}`);
    const asm = SonicSeal.createAssembler();
    for (const f of sealed.frames) asm.push(f);
    const { messages } = await asm.flush(PASS);
    assert.equal(messages.length, 1);
    assert.equal(messages[0].text, LONG);
  });

  await test('assembler recovers after the key is fixed', async () => {
    const sealed = await SonicSeal.sealMessage(LONG, { passphrase: PASS });
    const asm = SonicSeal.createAssembler();
    for (const f of sealed.frames) asm.push(f);

    const bad = await asm.flush('nope');
    assert.equal(bad.messages.length, 0);
    assert.ok(bad.errors.length >= 1 && bad.errors[0].reason === 'AUTH', 'locked with wrong key');

    const good = await asm.flush(PASS);
    assert.equal(good.messages.length, 1);
    assert.equal(good.messages[0].text, LONG);
  });

  await test('assembler reports partial progress and ignores repeats', async () => {
    const sealed = await SonicSeal.sealMessage(LONG, { passphrase: PASS, compress: false });
    assert.ok(sealed.chunks >= 2);
    const asm = SonicSeal.createAssembler();
    asm.push(sealed.frames[0]);
    const first = await asm.flush(PASS);
    assert.equal(first.messages.length, 0);
    assert.equal(first.groups[0].state, 'pending');
    assert.equal(first.groups[0].received, 1);

    const dup = asm.push(sealed.frames[0]);
    assert.equal(dup.type, 'duplicate');

    for (let i = 1; i < sealed.frames.length; i++) asm.push(sealed.frames[i]);
    const done = await asm.flush(PASS);
    assert.equal(done.messages.length, 1);
    assert.equal(done.messages[0].text, LONG);

    const again = await asm.flush(PASS);
    assert.equal(again.messages.length, 0, 'a completed message is not emitted twice');
  });

  await test('every message gets its own salt and ciphertext', async () => {
    const a = await SonicSeal.sealMessage('same text', { passphrase: PASS });
    const b = await SonicSeal.sealMessage('same text', { passphrase: PASS });
    assert.notEqual(a.saltHex, b.saltHex, 'salt is fresh per message');
    assert.equal(a.saltHex.length, SonicSeal.SALT_BYTES * 2);
    assert.notEqual(
      Buffer.from(a.frames[0]).toString('hex'),
      Buffer.from(b.frames[0]).toString('hex'),
      'identical plaintext must not produce identical frames'
    );
    // both still open with the same shared passphrase
    assert.equal((await SonicSeal.openFrame(a.frames[0], PASS)).msgId, a.msgId);
    assert.equal((await SonicSeal.openFrame(b.frames[0], PASS)).msgId, b.msgId);
  });

  await test('key stretching is 600k PBKDF2 rounds', async () => {
    assert.equal(SonicSeal.PBKDF2_ITERATIONS, 600000);
  });

  await test('frames from an older protocol version are refused', async () => {
    const sealed = await SonicSeal.sealMessage('legacy', { passphrase: PASS });
    const old = Uint8Array.from(sealed.frames[0]);
    old[2] = 1; // pretend it is a v1 frame
    assert.equal(SonicSeal.parseFrame(old).invalid, 'VERSION');
    await assert.rejects(SonicSeal.openFrame(old, PASS), (err) => err.code === 'VERSION');
    // and the assembler drops it instead of silently accepting nonsense
    const asm = SonicSeal.createAssembler({});
    const result = asm.push(old);
    assert.equal(result.type, 'ignored');
  });

  await test('the salt is covered by the GCM tag', async () => {
    const sealed = await SonicSeal.sealMessage('tide table', { passphrase: PASS });
    const tampered = Uint8Array.from(sealed.frames[0]);
    tampered[12] ^= 0x40; // flip a bit inside the salt
    await assert.rejects(SonicSeal.openFrame(tampered, PASS), (err) => err.code === 'AUTH');
  });

  await test('compression shrinks repetitive text', async () => {
    if (!SonicSeal.canCompress) return;
    const text = 'the quick brown fox jumps over the lazy dog. '.repeat(12);
    const plain = await SonicSeal.sealMessage(text, { passphrase: PASS, compress: false });
    const packed = await SonicSeal.sealMessage(text, { passphrase: PASS, compress: true });
    assert.ok(packed.compressed, 'compression applied');
    assert.ok(packed.frameBytes < plain.frameBytes, `${packed.frameBytes} < ${plain.frameBytes}`);
    assert.ok(packed.chunks < plain.chunks, `${packed.chunks} < ${plain.chunks}`);
    const asm = SonicSeal.createAssembler();
    for (const f of packed.frames) asm.push(f);
    const { messages } = await asm.flush(PASS);
    assert.equal(messages[0].text, text);
  });

  // -------- acoustic channel simulations --------

  function transmit(wires, proto) {
    const parts = [silence(0.15)];
    for (const wire of wires) {
      parts.push(toF32(ggwave.encode(instance, wire, proto, 20)), silence(0.4));
    }
    return parts;
  }

  async function acousticCase(label, options) {
    const { proto, degrade, compress } = options;
    const sealed = await SonicSeal.sealMessage(LONG, { passphrase: PASS, compress });
    const perFrame = toF32(ggwave.encode(instance, sealed.wires[0], proto, 20)).length / SR;

    let sig = concat(transmit(sealed.wires, proto));
    sig = degrade(sig);

    resetModem(); // decode with a clean modem state
    const got = decodeSignal(ggwave, instance, sig);
    const asm = SonicSeal.createAssembler();
    for (const frame of got) asm.push(frame);
    const { messages, groups } = await asm.flush(PASS);

    assert.equal(messages.length, 1, `${label}: decoded frames ${got.length}/${sealed.chunks}, groups=${JSON.stringify(groups)}`);
    assert.equal(messages[0].text, LONG, `${label}: text mismatch`);
    return { label, frames: sealed.chunks, perFrame: perFrame.toFixed(2), decoded: got.length };
  }

  const acoustics = [];
  await test('acoustic: clean, AUDIBLE_FAST', async () => {
    acoustics.push(await acousticCase('clean/FAST', { proto: P.GGWAVE_PROTOCOL_AUDIBLE_FAST, degrade: (s) => s, compress: true }));
  });
  await test('acoustic: quiet playback + room echo + noise, AUDIBLE_FAST', async () => {
    acoustics.push(await acousticCase('room/FAST', {
      proto: P.GGWAVE_PROTOCOL_AUDIBLE_FAST,
      degrade: (s) => noise(room(gain(s, 0.22), 65, 0.38), 0.006),
      compress: true,
    }));
  });
  await test('acoustic: fast mode, quiet + room + noise', async () => {
    acoustics.push(await acousticCase('room/FASTEST', {
      proto: P.GGWAVE_PROTOCOL_AUDIBLE_FASTEST,
      degrade: (s) => noise(room(gain(s, 0.25), 45, 0.30), 0.005),
      compress: true,
    }));
  });
  await test('acoustic: telephony-ish band (mic roll-off), FAST', async () => {
    const lowpass = (sig, k) => {
      const out = new Float32Array(sig.length);
      let y = 0;
      for (let i = 0; i < sig.length; i++) { y += k * (sig[i] - y); out[i] = y; }
      return out;
    };
    acoustics.push(await acousticCase('lowpass/FAST', {
      proto: P.GGWAVE_PROTOCOL_AUDIBLE_FAST,
      degrade: (s) => noise(room(lowpass(gain(s, 0.3), 0.55), 40, 0.25), 0.004),
      compress: true,
    }));
  });

  if (acoustics.length) {
    console.log('\nAcoustic cases:');
    for (const a of acoustics) console.log(`  ${a.label.padEnd(16)} frames=${a.frames} decoded=${a.decoded} ~${a.perFrame}s/frame`);
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  if (failed.length) process.exit(1);
})().catch((err) => { console.error('FATAL', err); process.exit(1); });
