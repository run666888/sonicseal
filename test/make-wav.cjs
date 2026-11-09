#!/usr/bin/env node
/**
 * Build a WAV that carries one sealed SonicSeal message — used as the fake
 * microphone input so the receive path can be tested end-to-end in headless
 * Chrome (`--use-file-for-fake-audio-capture`).
 *
 *   node test/make-wav.cjs "text" "passphrase" shots/fake-mic.wav [speed]
 */
'use strict';

const fs = require('fs');
const path = require('path');
const SonicSeal = require('../assets/envelope.js');

const factory = require('../vendor/ggwave.js');
const RATE = 48000;
const SPEED = { normal: 'GGWAVE_PROTOCOL_AUDIBLE_NORMAL', fast: 'GGWAVE_PROTOCOL_AUDIBLE_FAST', fastest: 'GGWAVE_PROTOCOL_AUDIBLE_FASTEST' };

(async () => {
  const text = process.argv[2] || 'The eagle lands at midnight.';
  const pass = process.argv[3] || '';
  const outPath = process.argv[4] || path.join(__dirname, '..', 'shots', 'fake-mic.wav');
  const speed = process.argv[5] || 'fast';

  const gg = await factory();
  gg.disableLog();
  const p = gg.getDefaultParameters();
  p.sampleRateInp = RATE; p.sampleRateOut = RATE; p.sampleRate = RATE;
  p.sampleFormatInp = gg.SampleFormat.GGWAVE_SAMPLE_FORMAT_I16;
  p.sampleFormatOut = gg.SampleFormat.GGWAVE_SAMPLE_FORMAT_I16;
  let modem = 0;
  for (let i = 0; i < 3 && !modem; i++) modem = gg.init(p);

  const sealed = await SonicSeal.sealMessage(text, { passphrase: pass || undefined, compress: true });

  const lead = new Float32Array(Math.round(0.25 * RATE));
  const gap = new Float32Array(Math.round(0.45 * RATE));
  const chunks = [lead];
  for (const wire of sealed.wires) {
    const view = gg.encode(modem, wire, gg.ProtocolId[SPEED[speed]], 90);
    const bytes = new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
    const n = bytes.length >> 1;
    const f = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const s = (bytes[2 * i] | (bytes[2 * i + 1] << 8)) << 16 >> 16;
      f[i] = s / 32768;
    }
    chunks.push(f, gap);
  }
  gg.free(modem);

  let total = 0;
  for (const c of chunks) total += c.length;
  const samples = new Float32Array(total);
  let at = 0;
  for (const c of chunks) { samples.set(c, at); at += c.length; }

  const buf = Buffer.alloc(44 + samples.length * 2);
  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + samples.length * 2, 4);
  buf.write('WAVE', 8);
  buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(RATE, 24);
  buf.writeUInt32LE(RATE * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36);
  buf.writeUInt32LE(samples.length * 2, 40);
  for (let i = 0; i < samples.length; i++) {
    const v = Math.max(-1, Math.min(1, samples[i]));
    buf.writeInt16LE(Math.round(v * 32767), 44 + i * 2);
  }
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, buf);

  console.log(JSON.stringify({
    wav: outPath,
    text,
    passphrase: pass || '(none)',
    frames: sealed.chunks,
    seconds: +(samples.length / RATE).toFixed(2),
    msgId: sealed.msgId,
  }, null, 1));
})();
