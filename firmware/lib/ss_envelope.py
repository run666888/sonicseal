"""SonicSeal frame format, device side (MicroPython / CPython compatible).

Mirrors assets/envelope.js version 2 exactly, minus the things a radio link
does not need:

  * no 7-bit "wire" packing (that exists only because ggwave takes a string;
    a UART carries raw bytes),
  * no raw-deflate (the board sends uncompressed and refuses compressed
    frames from the browser instead of half-supporting them).

Frame layout (18-byte header, authenticating the header itself as GCM AAD):

    0..1   magic 'W','S'
    2      version (2)
    3      flags   bit0 compressed, bit1 sealed
    4..7   msgId   (4 random bytes)
    8      chunk index
    9      chunk count
    10..17 salt    (8 random bytes per message)

    sealed body: nonce(12) | ciphertext | tag(16)
    plain  body: payload
"""

import os

from ss_gcm import AuthError, dec, enc

MAGIC_0 = 0x57
MAGIC_1 = 0x53
VERSION = 2
HEADER_BYTES = 18
NONCE_BYTES = 12
TAG_BYTES = 16
SALT_BYTES = 8
MAX_FRAME_BYTES = 122
CHUNK_BYTES = MAX_FRAME_BYTES - HEADER_BYTES - NONCE_BYTES - TAG_BYTES  # 76
MAX_CHUNKS = 255
MAX_TEXT_BYTES = CHUNK_BYTES * MAX_CHUNKS

FLAG_COMPRESSED = 0x01
FLAG_SEALED = 0x02


class FormatError(Exception):
    pass


class VersionError(FormatError):
    pass


class NeedKeyError(FormatError):
    pass


class UnsupportedError(FormatError):
    pass


def random_bytes(n):
    try:
        return os.urandom(n)
    except (AttributeError, NotImplementedError):
        pass
    import urandom
    return bytes(urandom.getrandbits(8) for _ in range(n))


def _header(msg_id, salt, idx, total, flags):
    if len(msg_id) != 4 or len(salt) != SALT_BYTES:
        raise ValueError('bad msgId/salt length')
    h = bytearray(HEADER_BYTES)
    h[0], h[1] = MAGIC_0, MAGIC_1
    h[2] = VERSION
    h[3] = flags
    h[4:8] = msg_id
    h[8] = idx
    h[9] = total
    h[10:18] = salt
    return bytes(h)


def seal(text, key=None, msg_id=None, salt=None, compress=False):
    """Build the frames for `text`.

    `key` is 32 raw bytes, or None for a plaintext (unsealed) message.
    Returns a dict with frames (list of bytes), msgId, salt, chunks, ...
    """
    raw = text.encode('utf-8') if isinstance(text, str) else bytes(text)
    if not raw:
        raise ValueError('nothing to seal')
    if len(raw) > MAX_TEXT_BYTES:
        raise ValueError('message too long')
    if compress:
        raise UnsupportedError('device side builds uncompressed frames only')

    msg_id = msg_id or random_bytes(4)
    salt = salt or random_bytes(SALT_BYTES)
    chunks = max(1, (len(raw) + CHUNK_BYTES - 1) // CHUNK_BYTES)
    flags = FLAG_SEALED if key else 0
    frames = []
    for idx in range(chunks):
        chunk = raw[idx * CHUNK_BYTES:(idx + 1) * CHUNK_BYTES]
        header = _header(msg_id, salt, idx, chunks, flags)
        if key:
            nonce = random_bytes(NONCE_BYTES)
            ct, tag = enc(key, nonce, chunk, header)
            frames.append(header + nonce + ct + tag)
        else:
            frames.append(header + chunk)
    return {
        'frames': frames,
        'msgId': msg_id,
        'salt': salt,
        'chunks': chunks,
        'sealed': bool(key),
        'plainBytes': len(raw),
    }


def parse(frame):
    """Structural check + header parse. Returns dict or None."""
    if not frame or len(frame) < HEADER_BYTES + 1:
        return None
    if frame[0] != MAGIC_0 or frame[1] != MAGIC_1:
        return None
    if frame[2] != VERSION:
        raise VersionError('frame version %d unsupported' % frame[2])
    flags = frame[3]
    sealed = bool(flags & FLAG_SEALED)
    body = frame[HEADER_BYTES:]
    if sealed and len(body) < NONCE_BYTES + TAG_BYTES:
        return None
    return {
        'msgId': frame[4:8],
        'idx': frame[8],
        'total': frame[9],
        'salt': frame[10:18],
        'flags': flags,
        'compressed': bool(flags & FLAG_COMPRESSED),
        'sealed': sealed,
        'header': frame[:HEADER_BYTES],
        'body': body,
    }


def open_frame(frame, key):
    """Decrypt one frame. Raises AuthError on a wrong key or tampering."""
    p = parse(frame)
    if p is None:
        raise FormatError('not a SonicSeal frame')
    if p['compressed']:
        raise UnsupportedError('compressed frames are not supported on the device')
    if not p['sealed']:
        return p['body']
    if not key:
        raise NeedKeyError('frame is sealed')
    nonce = p['body'][:NONCE_BYTES]
    ct_tag = p['body'][NONCE_BYTES:]
    return dec(key, nonce, ct_tag[:-TAG_BYTES], p['header'], ct_tag[-TAG_BYTES:])


class Assembler:
    """Collect frames by msgId until every chunk has arrived."""

    def __init__(self, ttl_s=300):
        self.groups = {}
        self.ttl = ttl_s

    def push(self, frame, key, now=None):
        p = parse(frame)
        if p is None:
            return None
        msg_id = p['msgId'].hex()
        g = self.groups.get(msg_id)
        if g is None:
            g = {'parts': {}, 'total': p['total'], 'sealed': p['sealed'], 'done': False}
            self.groups[msg_id] = g
        g['parts'][p['idx']] = frame
        if g['done'] or len(g['parts']) < g['total']:
            return None
        payload = b''
        try:
            for i in range(g['total']):
                payload += open_frame(g['parts'][i], key)
        except (AuthError, FormatError):
            raise
        g['done'] = True
        return {
            'msgId': msg_id,
            'text': payload.decode('utf-8', 'replace'),
            'sealed': g['sealed'],
            'chunks': g['total'],
        }

    def flush(self, key):
        """Retry every buffered group with `key` (used after a key change)."""
        out = []
        for msg_id in list(self.groups):
            g = self.groups[msg_id]
            if g['done'] or len(g['parts']) < g['total']:
                continue
            payload = b''
            try:
                for i in range(g['total']):
                    payload += open_frame(g['parts'][i], key)
            except (AuthError, FormatError, UnsupportedError):
                continue
            g['done'] = True
            out.append({
                'msgId': msg_id,
                'text': payload.decode('utf-8', 'replace'),
                'sealed': g['sealed'],
                'chunks': g['total'],
            })
        return out

    def stats(self):
        frames = 0
        pending = 0
        for g in self.groups.values():
            frames += len(g['parts'])
            if not g['done']:
                pending += 1
        return {'frames': frames, 'pending': pending}

    def reset(self):
        self.groups = {}
