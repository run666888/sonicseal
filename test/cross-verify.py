"""Whole-frame interop test: device firmware code  <->  browser envelope.js.

Not a unit test of either side — it hands real frames across the language
boundary in both directions and compares the text that comes out. If this
passes, an ESP32 running firmware/lib/* can trade messages with the web app.

    python test/cross-verify.py
"""

import json
import os
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, os.path.join(ROOT, 'firmware', 'lib'))

import ss_envelope as env  # noqa: E402

NODE = os.path.join(HERE, 'peer-node.mjs')
KEY = bytes(range(32))  # stand-in for the preshared key, same one both sides

SAMPLES = [
    ('short ascii', 'Meet me at nine.'),
    ('one chunk max', 'x' * env.CHUNK_BYTES),
    ('two chunks', 'The lighthouse keeper left a note under the third stair.'),
    ('three chunks', 'A' * (env.CHUNK_BYTES * 2 + 10)),
    ('utf-8', '中文也应当能往返 — 密钥与盐都不受影响。'),
]


def node(action, payload):
    proc = subprocess.run(
        ['node', NODE, action],
        input=json.dumps(payload).encode('utf-8'),
        capture_output=True,
    )
    if proc.returncode != 0:
        raise RuntimeError('node failed: ' + proc.stderr.decode('utf-8', 'replace'))
    return json.loads(proc.stdout.decode('utf-8'))


def check(label, got, want):
    if got != want:
        print('FAIL  %s\n  got  %r\n  want %r' % (label, got, want))
        return False
    print('ok    %s' % label)
    return True


def main():
    ok = True

    # --- direction 1: browser seals, device opens -----------------------
    for label, text in SAMPLES:
        sealed = node('seal', {'text': text, 'keyHex': KEY.hex()})
        assert sealed['ok'], sealed
        frames = [bytes.fromhex(h) for h in sealed['frames']]

        asm = env.Assembler()
        result = None
        for frame in frames:
            result = asm.push(frame, KEY) or result
        if result is None:
            print('FAIL  browser->device %s: nothing assembled' % label)
            ok = False
            continue
        ok &= check('browser -> device  [%s] %d frame(s)' % (label, len(frames)),
                    result['text'], text)

    # --- direction 2: device seals, browser opens -----------------------
    for label, text in SAMPLES:
        built = env.seal(text, KEY)
        out = node('open', {
            'frames': [f.hex() for f in built['frames']],
            'keyHex': KEY.hex(),
        })
        assert out['ok'], out
        ok &= check('device -> browser  [%s] %d frame(s)' % (label, built['chunks']),
                    out['text'], text)

    # --- wrong key must fail in both directions ------------------------
    sealed = node('seal', {'text': SAMPLES[0][1], 'keyHex': KEY.hex()})
    frames = [bytes.fromhex(h) for h in sealed['frames']]
    wrong = bytes([b ^ 0xFF for b in KEY])
    try:
        env.open_frame(frames[0], wrong)
        print('FAIL  device accepted a wrong key')
        ok = False
    except env.AuthError:
        print('ok    device rejects a wrong key')

    built = env.seal(SAMPLES[0][1], KEY)
    out = node('open', {'frames': [f.hex() for f in built['frames']], 'keyHex': wrong.hex()})
    if out.get('ok') or out.get('code') != 'AUTH':
        print('FAIL  browser accepted a wrong key: %s' % out)
        ok = False
    else:
        print('ok    browser rejects a wrong key')

    # --- tampering with the salt (header is the AAD) ------------------
    tampered = bytearray(frames[0])
    tampered[10] ^= 0x01
    try:
        env.open_frame(bytes(tampered), KEY)
        print('FAIL  device accepted a tampered header')
        ok = False
    except env.AuthError:
        print('ok    device rejects a tampered salt/header')

    print('\nALL OK' if ok else '\nFAILURES ABOVE')
    return 0 if ok else 1


if __name__ == '__main__':
    sys.exit(main())
