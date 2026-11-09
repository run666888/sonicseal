"""AES-256-GCM, portable: pure Python or MicroPython's ucryptolib for the CTR part.

API deliberately mirrors the Web Crypto calls used by the browser build:

    enc(key, nonce, plaintext, aad)        -> (ciphertext, tag)
    dec(key, nonce, ciphertext, aad, tag)  -> plaintext   (raises AuthError)

`key` is 32 bytes, `nonce` is 12 bytes, the tag is 16 bytes - exactly like
assets/envelope.js, so a frame produced by the website decrypts here and
vice versa.
"""

try:  # MicroPython on the ESP32
    import ucryptolib as _cryptolib  # type: ignore
except ImportError:  # CPython (tests, cross-verification)
    _cryptolib = None

from aes_pure import expand_key, encrypt_block


class AuthError(Exception):
    """Tag mismatch: wrong key, or the data was altered."""


# ---------------------------------------------------------------- GF(2^128)
def _gf_mul(x, y):
    """Multiply in GF(2^128) with GCM's bit-reflected field representation."""
    r = 0xE1 << 120
    z = 0
    v = y
    for i in range(128):
        if (x >> (127 - i)) & 1:
            z ^= v
        if v & 1:
            v = (v >> 1) ^ r
        else:
            v >>= 1
    return z


def _ghash(h, data):
    """GHASH over 16-byte-aligned blocks of `data`."""
    y = 0
    h_int = int.from_bytes(h, 'big')
    for i in range(0, len(data), 16):
        y = _gf_mul(y ^ int.from_bytes(data[i:i + 16], 'big'), h_int)
    return y.to_bytes(16, 'big')


def _pad16(b):
    rem = len(b) % 16
    return b if rem == 0 else b + b'\x00' * (16 - rem)


def _j0(nonce):
    """96-bit nonce -> the initial counter block (GCM's fast path)."""
    if len(nonce) != 12:
        raise ValueError('only 96-bit nonces are supported')
    return bytes(nonce) + b'\x00\x00\x00\x01'


class _Backend:
    """MicroPython's C AES when available, pure Python otherwise."""

    def __init__(self, key):
        if len(key) != 32:
            raise ValueError('AES-256 needs a 32-byte key')
        self.key = bytes(key)
        self._rounds = None

    def _rk(self):
        if self._rounds is None:
            self._rounds = expand_key(self.key)
        return self._rounds

    def block(self, data):
        """Encrypt one 16-byte block."""
        if _cryptolib is None:
            return encrypt_block(self._rk(), data)
        # ucryptolib exposes no raw ECB block call; run CTR with counter 0 and
        # xor with the zero block, which is exactly one AES encrypt.
        c = _cryptolib.aes(self.key, 6, b'\x00' * 16)
        return c.encrypt(bytes(data))

    def ctr(self, counter_block, data):
        if not data:
            return b''
        if _cryptolib is None:
            rk = self._rk()
            out = bytearray()
            ctr = bytearray(counter_block)
            for i in range(0, len(data), 16):
                ks = encrypt_block(rk, bytes(ctr))
                out += bytes(a ^ b for a, b in zip(data[i:i + 16], ks))
                v = (int.from_bytes(ctr[12:], 'big') + 1) & 0xFFFFFFFF
                ctr[12:] = v.to_bytes(4, 'big')
            return bytes(out)
        c = _cryptolib.aes(self.key, 6, bytes(counter_block))
        return c.encrypt(bytes(data))


def _tag_for(h, aad, ct):
    lengths = (len(aad) * 8).to_bytes(8, 'big') + (len(ct) * 8).to_bytes(8, 'big')
    return _ghash(h, _pad16(bytes(aad)) + _pad16(bytes(ct)) + lengths)


def _inc32(block):
    """Increment the low 32 bits of a counter block (GCM rule)."""
    v = (int.from_bytes(block[12:], 'big') + 1) & 0xFFFFFFFF
    return bytes(block[:12]) + v.to_bytes(4, 'big')


def _mask(backend, j0, tag):
    return backend.ctr(j0, b'\x00' * 16)


def _const_eq(a, b):
    if len(a) != len(b):
        return False
    diff = 0
    for x, y in zip(a, b):
        diff |= x ^ y
    return diff == 0


def enc(key, nonce, plaintext, aad=b''):
    b = _Backend(key)
    j0 = _j0(nonce)
    h = b.block(b'\x00' * 16)
    ct = b.ctr(_inc32(j0), bytes(plaintext))
    raw = _tag_for(h, aad, ct)
    ek0 = _mask(b, j0, raw)
    return ct, bytes(x ^ y for x, y in zip(raw, ek0))


def dec(key, nonce, ciphertext, aad=b'', tag=None):
    if tag is None:  # accept ciphertext||tag in one buffer too
        ciphertext, tag = bytes(ciphertext)[:-16], bytes(ciphertext)[-16:]
    b = _Backend(key)
    j0 = _j0(nonce)
    h = b.block(b'\x00' * 16)
    raw = _tag_for(h, aad, bytes(ciphertext))
    ek0 = _mask(b, j0, raw)
    want = bytes(x ^ y for x, y in zip(raw, ek0))
    if not _const_eq(want, bytes(tag)):
        raise AuthError('tag mismatch')
    return b.ctr(_inc32(j0), bytes(ciphertext))
