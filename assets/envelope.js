/*
 * SonicSeal — envelope layer
 * ---------------------------------------------------------------
 * Turns a message into a series of small binary frames that the sound
 * modem (ggwave) can carry, and turns received frames back into text.
 *
 *   text ──(deflate)──► bytes ──(AES-256-GCM)──► frames ──(7-bit)──► wire ──► ggwave ──► 🔊
 *
 * Frame layout (little-endian, max 122 bytes; 140 wire chars):
 *
 *   [0]      0x57 'W'   magic
 *   [1]      0x53 'S'   magic
 *   [2]      0x02       version
 *   [3]      flags      bit0 = deflate-compressed, bit1 = AES-GCM sealed
 *   [4..7]   msgId      4 random bytes — identifies the message
 *   [8]      idx        chunk index (0-based)
 *   [9]      total      chunk count (1..255)
 *   [10..17] salt       8 random bytes, fresh for every message (PBKDF2 salt)
 *   [18..]   body       sealed: nonce(12) + ciphertext+tag ;  clear: raw bytes
 *
 * The 18 header bytes are bound to the ciphertext as AES-GCM additional
 * data, so the chunk order / message id / salt cannot be rewritten in flight.
 *
 * The module works as a classic browser script (window.SonicSeal) and as a
 * CommonJS module (require('./envelope.js')), which keeps the Node tests
 * exercising exactly the code the page runs.
 */
(function (global, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else global.SonicSeal = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const MAGIC_0 = 0x57; // 'W'
  const MAGIC_1 = 0x53; // 'S'
  const VERSION = 2;

  // ggwave's JS bindings pass payloads through a C string, which is UTF-8
  // encoded: raw bytes >= 0x80 would be split in two. So frames travel as
  // 7-bit-safe chars (0x00-0x7F), eight chars per seven bytes. That leaves
  // 140 wire chars -> 122 frame bytes.
  const WIRE_CHARS = 140;
  const MAX_FRAME_BYTES = 122;
  const HEADER_BYTES = 18;
  const SALT_BYTES = 8;
  const NONCE_BYTES = 12;
  const TAG_BYTES = 16;
  const CHUNK_BYTES = MAX_FRAME_BYTES - HEADER_BYTES - NONCE_BYTES - TAG_BYTES; // 84
  const MAX_CHUNKS = 255;
  const MAX_TEXT_BYTES = CHUNK_BYTES * MAX_CHUNKS;

  const FLAG_COMPRESSED = 0x01;
  const FLAG_SEALED = 0x02;

  const SALT_PREFIX = 'SonicSeal/v2|';
  const PBKDF2_ITERATIONS = 600000;
  const GROUP_TTL_MS = 5 * 60 * 1000;
  const MIN_COMPRESS_BYTES = 24;

  // The UMD wrapper's `global` parameter is only in scope for the wrapper, not
  // for this factory body — resolve the host object ourselves.
  const root = typeof globalThis !== 'undefined' ? globalThis
    : (typeof self !== 'undefined' ? self : window);

  const encoder = new TextEncoder();
  const decoder = new TextDecoder('utf-8');

  function subtle() {
    const c = root.crypto;
    if (!c || !c.subtle) throw codedError('NO_CRYPTO', 'Web Crypto API 不可用');
    return c.subtle;
  }

  function randomBytes(n) {
    const out = new Uint8Array(n);
    root.crypto.getRandomValues(out);
    return out;
  }

  function codedError(code, message) {
    const err = new Error(message);
    err.code = code;
    return err;
  }

  function toHex(bytes) {
    let s = '';
    for (let i = 0; i < bytes.length; i++) s += bytes[i].toString(16).padStart(2, '0');
    return s;
  }

  function concatBytes(list) {
    let total = 0;
    for (const part of list) total += part.length;
    const out = new Uint8Array(total);
    let at = 0;
    for (const part of list) { out.set(part, at); at += part.length; }
    return out;
  }

  /* ---------------------------------------------------------------- */
  /* wire codec: 7 bits per char, chars stay inside 0x00-0x7F          */
  /* ---------------------------------------------------------------- */

  /**
   * @param {Uint8Array} frame
   * @returns {string} at most 140 chars, every char < 0x80
   */
  function packWire(frame) {
    let acc = 0;
    let bits = 0;
    let out = '';
    for (let i = 0; i < frame.length; i++) {
      acc = (acc << 8) | frame[i];
      bits += 8;
      while (bits >= 7) {
        out += String.fromCharCode((acc >>> (bits - 7)) & 0x7f);
        bits -= 7;
      }
    }
    if (bits > 0) out += String.fromCharCode((acc << (7 - bits)) & 0x7f);
    return out;
  }

  /**
   * @param {string} wire ASCII-safe string as received from the modem
   * @returns {Uint8Array} frame bytes (trailing pad bits are dropped)
   */
  function unpackWire(wire) {
    let acc = 0;
    let bits = 0;
    const out = [];
    for (let i = 0; i < wire.length; i++) {
      acc = (acc << 7) | (wire.charCodeAt(i) & 0x7f);
      bits += 7;
      while (bits >= 8) {
        out.push((acc >>> (bits - 8)) & 0xff);
        bits -= 8;
      }
    }
    return Uint8Array.from(out);
  }

  function bytesToWireString(bytes) {
    let out = '';
    for (let i = 0; i < bytes.length; i++) out += String.fromCharCode(bytes[i]);
    return out;
  }

  /* ---------------------------------------------------------------- */
  /* key derivation                                                   */
  /* ---------------------------------------------------------------- */

  const keyCache = new Map(); // saltHex|passphrase -> Promise<CryptoKey>

  function deriveKey(passphrase, saltBytes) {
    const cacheKey = toHex(saltBytes) + '\u0000' + passphrase;
    let pending = keyCache.get(cacheKey);
    if (!pending) {
      pending = (async () => {
        const base = await subtle().importKey(
          'raw', encoder.encode(passphrase), 'PBKDF2', false, ['deriveKey']
        );
        return subtle().deriveKey(
          { name: 'PBKDF2', salt: saltBytes, iterations: PBKDF2_ITERATIONS, hash: 'SHA-256' },
          base,
          { name: 'AES-GCM', length: 256 },
          false,
          ['encrypt', 'decrypt']
        );
      })();
      keyCache.set(cacheKey, pending);
      if (keyCache.size > 64) keyCache.delete(keyCache.keys().next().value);
    }
    return pending;
  }

  /**
   * Raw-key mode for hardware that cannot afford 600k PBKDF2 rounds.
   * A "passphrase" of the form `key:<64 hex chars>` is used directly as the
   * AES-256 key; everything else about the frame stays identical, so a board
   * and the browser stay interoperable.
   */
  const RAW_KEY_PREFIX = 'key:';

  function parseRawKey(spec) {
    if (!spec || spec.slice(0, RAW_KEY_PREFIX.length).toLowerCase() !== RAW_KEY_PREFIX) return null;
    const hex = spec.slice(RAW_KEY_PREFIX.length).replace(/[^0-9a-f]/gi, '');
    if (hex.length !== 64) return null;
    const out = new Uint8Array(32);
    for (let i = 0; i < 32; i++) out[i] = parseInt(hex.substr(i * 2, 2), 16);
    return out;
  }

  function importRawKey(bytes) {
    return subtle().importKey('raw', bytes, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
  }

  function resolveKey(passphrase, saltBytes) {
    const raw = parseRawKey(passphrase);
    if (raw) return importRawKey(raw);
    return deriveKey(passphrase, saltBytes);
  }

  /**
   * Domain-separated PBKDF2 salt: a fixed prefix keeps these keys from ever
   * colliding with keys derived for some other purpose, and the 8 random bytes
   * make every message use its own key material.
   */
  function messageSalt(saltBytes) {
    return concatBytes([encoder.encode(SALT_PREFIX), saltBytes]);
  }

  /* ---------------------------------------------------------------- */
  /* optional deflate (raw), gracefully absent outside modern runtimes */
  /* ---------------------------------------------------------------- */

  const canCompress =
    typeof root.CompressionStream === 'function' &&
    typeof root.DecompressionStream === 'function';

  async function deflate(bytes) {
    const stream = new Blob([bytes]).stream().pipeThrough(new root.CompressionStream('deflate-raw'));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }

  async function inflate(bytes) {
    const stream = new Blob([bytes]).stream().pipeThrough(new root.DecompressionStream('deflate-raw'));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }

  /* ---------------------------------------------------------------- */
  /* sealing                                                          */
  /* ---------------------------------------------------------------- */

  /**
   * Encrypt (optionally) and split a message into sound frames.
   * @param {string} text
   * @param {{passphrase?: string, compress?: boolean}} [options]
   * @returns {Promise<{frames: Uint8Array[], msgId: string, chunks: number,
   *                    compressed: boolean, sealed: boolean,
   *                    plainBytes: number, frameBytes: number}>}
   */
  async function sealMessage(text, options) {
    const opts = options || {};
    const passphrase = (opts.passphrase || '').trim();
    const wantsCompression = opts.compress !== false;

    const raw = encoder.encode(String(text == null ? '' : text));
    if (!raw.length) throw codedError('EMPTY', '没有可加密的内容');
    if (raw.length > MAX_TEXT_BYTES) {
      throw codedError('TOO_LONG', '内容超出单条消息的容量上限');
    }

    let body = raw;
    let compressed = false;
    if (wantsCompression && canCompress && raw.length >= MIN_COMPRESS_BYTES) {
      try {
        const packed = await deflate(raw);
        if (packed.length + 8 < raw.length) { body = packed; compressed = true; }
      } catch (_) { /* fall back to plain bytes */ }
    }

    const msgId = randomBytes(4);
    const salt = randomBytes(SALT_BYTES);
    const chunks = Math.max(1, Math.ceil(body.length / CHUNK_BYTES));
    if (chunks > MAX_CHUNKS) throw codedError('TOO_LONG', '内容超出单条消息的容量上限');

    const flags = (compressed ? FLAG_COMPRESSED : 0) | (passphrase ? FLAG_SEALED : 0);
    const key = passphrase ? await resolveKey(passphrase, messageSalt(salt)) : null;
    const frames = [];

    for (let idx = 0; idx < chunks; idx++) {
      const slice = body.subarray(idx * CHUNK_BYTES, (idx + 1) * CHUNK_BYTES);
      const header = new Uint8Array(HEADER_BYTES);
      header[0] = MAGIC_0;
      header[1] = MAGIC_1;
      header[2] = VERSION;
      header[3] = flags;
      header.set(msgId, 4);
      header[8] = idx;
      header[9] = chunks;
      header.set(salt, 10);

      if (key) {
        const nonce = randomBytes(NONCE_BYTES);
        const sealed = new Uint8Array(await subtle().encrypt(
          { name: 'AES-GCM', iv: nonce, additionalData: header, tagLength: 128 },
          key,
          slice
        ));
        const frame = new Uint8Array(HEADER_BYTES + NONCE_BYTES + sealed.length);
        frame.set(header, 0);
        frame.set(nonce, HEADER_BYTES);
        frame.set(sealed, HEADER_BYTES + NONCE_BYTES);
        frames.push(frame);
      } else {
        const frame = new Uint8Array(HEADER_BYTES + slice.length);
        frame.set(header, 0);
        frame.set(slice, HEADER_BYTES);
        frames.push(frame);
      }
    }

    const wires = frames.map(packWire);
    return {
      frames,
      wires,
      msgId: toHex(msgId),
      saltHex: toHex(salt),
      chunks,
      compressed,
      sealed: !!passphrase,
      plainBytes: raw.length,
      frameBytes: body.length,
      capacity: CHUNK_BYTES * chunks,
    };
  }

  /* ---------------------------------------------------------------- */
  /* framing                                                          */
  /* ---------------------------------------------------------------- */

  /**
   * Cheap structural check + header parse. Returns null when the buffer is
   * not one of our frames.
   */
  function parseFrame(frameBytes) {
    if (!frameBytes || frameBytes.length < HEADER_BYTES + 1) return null;
    if (frameBytes[0] !== MAGIC_0 || frameBytes[1] !== MAGIC_1) return null;
    if (frameBytes[2] !== VERSION) return { version: frameBytes[2], invalid: 'VERSION' };

    const header = frameBytes.subarray(0, HEADER_BYTES);
    const flags = frameBytes[3];
    const sealed = !!(flags & FLAG_SEALED);
    const body = frameBytes.subarray(HEADER_BYTES);

    if (sealed && body.length < NONCE_BYTES + TAG_BYTES) return null;

    return {
      msgId: toHex(frameBytes.subarray(4, 8)),
      salt: frameBytes.subarray(10, HEADER_BYTES),
      idx: frameBytes[8],
      total: frameBytes[9],
      flags,
      compressed: !!(flags & FLAG_COMPRESSED),
      sealed,
      header,
      body,
    };
  }

  /**
   * Open a single frame with a passphrase.
   * @returns {Promise<{msgId:string, idx:number, total:number, compressed:boolean,
   *                    sealed:boolean, payload: Uint8Array}>}
   * Throws err.code === 'AUTH' on a wrong key / tampered frame.
   */
  async function openFrame(frameBytes, passphrase) {
    const parsed = parseFrame(frameBytes);
    if (!parsed) throw codedError('FORMAT', '信号不是 SonicSeal 帧');
    if (parsed.invalid === 'VERSION') throw codedError('VERSION', '帧版本不受支持');

    const pass = (passphrase || '').trim();

    if (!parsed.sealed) {
      return {
        msgId: parsed.msgId, idx: parsed.idx, total: parsed.total,
        compressed: parsed.compressed, sealed: false, payload: parsed.body,
      };
    }

    if (!pass) throw codedError('NEED_KEY', '这段声音已加密，需要密钥');

    const nonce = parsed.body.subarray(0, NONCE_BYTES);
    const cipher = parsed.body.subarray(NONCE_BYTES);
    const key = await resolveKey(pass, messageSalt(parsed.salt));

    let plain;
    try {
      plain = new Uint8Array(await subtle().decrypt(
        { name: 'AES-GCM', iv: nonce, additionalData: parsed.header, tagLength: 128 },
        key,
        cipher
      ));
    } catch (_) {
      throw codedError('AUTH', '密钥不对，或这段声音被改动了');
    }

    return {
      msgId: parsed.msgId, idx: parsed.idx, total: parsed.total,
      compressed: parsed.compressed, sealed: true, payload: plain,
    };
  }

  /**
   * Join already-opened chunks back into text.
   * @param {{payload: Uint8Array, compressed: boolean}[]} chunks ordered list
   */
  async function joinChunks(chunks) {
    const bytes = concatBytes(chunks.map((c) => c.payload));
    let out = bytes;
    if (chunks[0] && chunks[0].compressed) {
      if (!canCompress) throw codedError('NO_INFLATE', '当前浏览器不支持解压该消息');
      try { out = await inflate(bytes); }
      catch (_) { throw codedError('AUTH', '数据损坏，无法解压'); }
    }
    return decoder.decode(out);
  }

  /* ---------------------------------------------------------------- */
  /* receiver-side session                                            */
  /* ---------------------------------------------------------------- */

  /**
   * Collects raw frames as they arrive, retries decryption whenever the
   * passphrase changes, and reports assembled messages. Keeping the raw
   * frames means a mistyped key is recoverable: fix the key, replay, done.
   */
  function createAssembler(options) {
    const opts = options || {};
    const ttl = opts.ttlMs || GROUP_TTL_MS;
    const groups = new Map(); // msgId -> {raw: Map<idx, Uint8Array>, total, firstSeen, sealed, compressed, done}
    const emitted = new Map(); // msgId -> timestamp of completion

    function sweep(now) {
      for (const [id, group] of groups) {
        if (now - group.firstSeen > ttl) groups.delete(id);
      }
      for (const [id, at] of emitted) {
        if (now - at > ttl) emitted.delete(id);
      }
    }

    /**
     * @param {Uint8Array} frameBytes
     * @returns {{type:'ignored'|'frame'|'duplicate'|'overflow', parsed?: object}}
     */
    function push(frameBytes) {
      const parsed = parseFrame(frameBytes);
      if (!parsed || parsed.invalid) return { type: 'ignored' };
      if (parsed.idx >= parsed.total || parsed.total === 0) return { type: 'ignored' };

      const now = Date.now();
      sweep(now);

      let group = groups.get(parsed.msgId);
      if (!group) {
        group = { raw: new Map(), total: parsed.total, firstSeen: now, sealed: parsed.sealed, compressed: parsed.compressed, done: false };
        groups.set(parsed.msgId, group);
      }
      if (group.raw.has(parsed.idx)) return { type: 'duplicate', parsed };
      group.raw.set(parsed.idx, Uint8Array.from(frameBytes));
      return { type: 'frame', parsed, received: group.raw.size, total: group.total };
    }

    /**
     * Try to decrypt / assemble everything buffered with the given passphrase.
     * Safe to call after every frame and after every key edit.
     * @param {string} passphrase
     * @returns {Promise<{messages: object[], groups: object[], errors: object[]}>}
     */
    async function flush(passphrase) {
      const pass = (passphrase || '').trim();
      const now = Date.now();
      sweep(now);

      const messages = [];
      const errors = [];
      const summary = [];

      for (const [msgId, group] of groups) {
        if (now - group.firstSeen > ttl) { groups.delete(msgId); continue; }

        const complete = group.raw.size === group.total;
        const opened = [];
        let failure = null;

        for (let idx = 0; idx < group.total; idx++) {
          const raw = group.raw.get(idx);
          if (!raw) continue; // wait for the rest
          try {
            opened.push(await openFrame(raw, pass));
          } catch (err) {
            failure = err.code || 'AUTH';
            break;
          }
        }

        if (failure) {
          errors.push({ msgId, reason: failure });
          summary.push({ msgId, total: group.total, received: group.raw.size, state: 'locked', reason: failure });
          continue;
        }

        if (!complete) {
          summary.push({ msgId, total: group.total, received: group.raw.size, state: 'pending' });
          continue;
        }

        if (emitted.has(msgId) || group.done) continue;

        try {
          opened.sort((a, b) => a.idx - b.idx);
          const text = await joinChunks(opened);
          group.done = true;
          emitted.set(msgId, now);
          messages.push({
            msgId,
            text,
            chunks: group.total,
            sealed: group.sealed,
            compressed: group.compressed,
            bytes: group.total,
          });
          summary.push({ msgId, total: group.total, received: group.total, state: 'done' });
        } catch (err) {
          errors.push({ msgId, reason: err.code || 'AUTH' });
          summary.push({ msgId, total: group.total, received: group.raw.size, state: 'locked', reason: err.code || 'AUTH' });
        }
      }

      return { messages, groups: summary, errors };
    }

    function reset() { groups.clear(); emitted.clear(); }

    function stats() {
      let frames = 0, pending = 0;
      for (const group of groups.values()) { frames += group.raw.size; pending += 1; }
      return { frames, pending };
    }

    return { push, flush, reset, stats };
  }

  return {
    VERSION,
    WIRE_CHARS,
    MAX_FRAME_BYTES,
    HEADER_BYTES,
    SALT_BYTES,
    CHUNK_BYTES,
    MAX_CHUNKS,
    MAX_TEXT_BYTES,
    PBKDF2_ITERATIONS,
    canCompress,
    packWire,
    unpackWire,
    bytesToWireString,
    sealMessage,
    openFrame,
    joinChunks,
    parseFrame,
    createAssembler,
    deriveKey,
    codedError,
    toHex,
  };
});
