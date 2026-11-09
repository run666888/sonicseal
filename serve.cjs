#!/usr/bin/env node
/**
 * Tiny static server for SonicSeal.
 *
 *   node serve.cjs            → http://localhost:8787
 *   node serve.cjs 9000       → http://localhost:9000
 *
 * Why: browsers only grant microphone access on a secure origin. localhost
 * counts as secure, a LAN IP over plain http does not. Opening index.html
 * directly with file:// works for *sending* (playback + WAV), but the
 * microphone is blocked there in Chrome.
 */
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const PORT = Number(process.argv[2] || process.env.PORT || 8787);
const HOST = process.env.HOST || '127.0.0.1';

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.wav': 'audio/wav',
  '.md': 'text/markdown; charset=utf-8',
};

const server = http.createServer((req, res) => {
  let rel = decodeURIComponent((req.url || '/').split('?')[0]);
  if (rel === '/' || rel === '') rel = '/index.html';

  const target = path.join(ROOT, path.normalize(rel).replace(/^(\.\.[/\\])+/, ''));
  if (!target.startsWith(ROOT)) {
    res.writeHead(403).end('forbidden');
    return;
  }

  fs.stat(target, (err, st) => {
    if (err || !st.isFile()) {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end('not found: ' + rel);
      return;
    }
    res.writeHead(200, {
      'content-type': TYPES[path.extname(target).toLowerCase()] || 'application/octet-stream',
      'content-length': st.size,
      'cache-control': 'no-cache',
    });
    fs.createReadStream(target).pipe(res);
  });
});

server.listen(PORT, HOST, () => {
  console.log(`SonicSeal → http://localhost:${PORT}`);
  console.log('(localhost counts as a secure origin, so the microphone works.)');
});
