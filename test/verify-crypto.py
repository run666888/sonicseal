"""Self-test for the portable AES-256-GCM used by the device firmware.

Two checks, both runnable right now on the PC without any board:

  1. FIPS-197 AES-256 block-cipher vector (proves the cipher core is right).
  2. Random round-trips against Node's OpenSSL-backed aes-256-gcm
     (proves the whole GCM construction, including AAD and tag, matches the
     browser build byte for byte).

Run:  python test/verify-crypto.py
"""

import json
import os
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, '..', 'firmware', 'lib'))

import ss_gcm  # noqa: E402
from aes_pure import expand_key, encrypt_block  # noqa: E402


def check_fips197():
    key = bytes(range(32))
    pt = bytes.fromhex('00112233445566778899aabbccddeeff')
    want = '8ea2b7ca516745bfeafc49904b496089'
    got = encrypt_block(expand_key(key), pt).hex()
    ok = got == want
    print(f'  FIPS-197 AES-256 block   {got}  {"OK" if ok else "MISMATCH"}')
    return ok


NODE_VECTORS = r"""
const crypto = require('node:crypto');
const cases = [];
for (let i = 0; i < 6; i++) {
  const key = crypto.randomBytes(32);
  const nonce = crypto.randomBytes(12);
  const pt = crypto.randomBytes([0, 1, 17, 76, 120, 250][i]);
  const aad = crypto.randomBytes(i === 0 ? 0 : 18);
  const c = crypto.createCipheriv('aes-256-gcm', key, nonce);
  c.setAAD(aad, { plaintextLength: pt.length });
  const ct = Buffer.concat([c.update(pt), c.final()]);
  cases.push({
    key: key.toString('hex'), nonce: nonce.toString('hex'),
    aad: aad.toString('hex'), pt: pt.toString('hex'),
    ct: ct.toString('hex'), tag: c.getAuthTag().toString('hex'),
  });
}
process.stdout.write(JSON.stringify(cases));
"""


def check_gcm_against_node():
    cases = json.loads(subprocess.run(
        ['node', '-e', NODE_VECTORS], capture_output=True, text=True, check=True).stdout)

    ok = True
    for i, case in enumerate(cases):
        key = bytes.fromhex(case['key'])
        nonce = bytes.fromhex(case['nonce'])
        aad = bytes.fromhex(case['aad'])
        pt = bytes.fromhex(case['pt'])
        ct, tag = ss_gcm.enc(key, nonce, pt, aad)
        if ct.hex() != case['ct'] or tag.hex() != case['tag']:
            print(f'  case {i}: ENC MISMATCH\n    node {case["ct"]} {case["tag"]}\n    ours {ct.hex()} {tag.hex()}')
            ok = False
            continue
        back = ss_gcm.dec(key, nonce, ct, aad, tag)
        if back != pt:
            print(f'  case {i}: round-trip MISMATCH')
            ok = False
    print(f'  GCM vs Node/OpenSSL      {len(cases)} cases  {"OK" if ok else "FAILED"}')

    # tampering must be rejected, not silently accepted
    key, nonce = bytes(range(32)), bytes(range(12))
    ct, tag = ss_gcm.enc(key, nonce, b'attack at dawn', b'\x00' * 18)
    bad = bytearray(tag)
    bad[0] ^= 0x01
    try:
        ss_gcm.dec(key, nonce, ct, b'\x00' * 18, bytes(bad))
        print('  tampered tag             ACCEPTED (bad!)')
        ok = False
    except ss_gcm.AuthError:
        print('  tampered tag             rejected  OK')
    return ok


if __name__ == '__main__':
    print('crypto self-test')
    a = check_fips197()
    b = check_gcm_against_node()
    print('\n' + ('ALL OK' if a and b else 'FAILURES ABOVE'))
    sys.exit(0 if a and b else 1)
