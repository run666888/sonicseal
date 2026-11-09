// Bridge for test/cross-verify.py: seal/open SonicSeal frames with the very
// same envelope.js the browser runs, so the device code gets checked against
// the real thing instead of a re-implementation.
//
//   node test/peer-node.mjs seal   <<< {"text": "...", "keyHex": "..."}
//   node test/peer-node.mjs open   <<< {"frames": ["hex", ...], "keyHex": "..."}
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const S = require('../assets/envelope.js');

function readStdin() {
  return new Promise((resolve, reject) => {
    let buf = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (c) => { buf += c; });
    process.stdin.on('end', () => resolve(buf));
    process.stdin.on('error', reject);
  });
}

const hexToBytes = (hex) => Uint8Array.from(hex.match(/../g).map((b) => parseInt(b, 16)));
const bytesToHex = (bytes) => [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');

const action = process.argv[2];
const input = JSON.parse(await readStdin());
const spec = 'key:' + input.keyHex;

try {
  if (action === 'seal') {
    const out = await S.sealMessage(input.text, { passphrase: spec, compress: false });
    process.stdout.write(JSON.stringify({
      ok: true,
      frames: out.frames.map(bytesToHex),
      msgId: out.msgId,
      chunks: out.chunks,
      sealed: out.sealed,
      plainBytes: out.plainBytes,
    }));
  } else if (action === 'open') {
    const frames = input.frames.map(hexToBytes);
    const opened = [];
    for (const frame of frames) opened.push(await S.openFrame(frame, spec));
    const text = await S.joinChunks(opened);
    process.stdout.write(JSON.stringify({ ok: true, text, chunks: opened.length }));
  } else {
    throw new Error('unknown action ' + action);
  }
} catch (err) {
  process.stdout.write(JSON.stringify({ ok: false, code: err.code || 'ERROR', message: err.message }));
}
