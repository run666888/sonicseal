"""Link-layer test that needs no hardware: framing, corruption, resync.

    python test/link-test.py
"""

import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, os.path.join(ROOT, 'firmware', 'lib'))

import ss_link as L  # noqa: E402
import ss_envelope as env  # noqa: E402

KEY = bytes(range(32))
fail = 0


def check(label, got, want):
    global fail
    if got != want:
        print('FAIL  %s\n  got  %r\n  want %r' % (label, got, want))
        fail += 1
    else:
        print('ok    %s' % label)


def main():
    # round trip of payloads that hit every escape case
    for label, payload in [
        ('plain', b'hello'),
        ('contains END', b'a\x7eb'),
        ('contains ESC', b'a\x7db'),
        ('both', bytes([0x7E, 0x7D, 0x7E, 0x7D])),
        ('all bytes', bytes(range(256))),
        ('empty', b''),
    ]:
        encoded = L.slip_encode(payload)
        check('slip roundtrip [%s]' % label, L.slip_decode(encoded[1:-1]), payload)

    # streaming parse: two frames arriving in one read, plus leading noise.
    # min_len=1 tests the framing on its own; the 19-byte floor belongs to the
    # SonicSeal layer and is checked further down.
    p = L.SlipParser(min_len=1)
    f1, f2 = b'first payload here', b'second payload here'
    stream = b'\x00\x11' + L.slip_encode(f1) + L.slip_encode(f2)
    check('two frames in one read', p.feed(stream), [f1, f2])

    # byte-by-byte delivery (how a UART actually behaves)
    p = L.SlipParser(min_len=1)
    got = []
    for byte in L.slip_encode(b'one byte at a time'):
        got.extend(p.feed(bytes([byte])))
    check('byte-at-a-time', got, [b'one byte at a time'])

    # a frame torn in half yields two runt pieces; framing still resyncs and
    # the next good frame arrives. The pieces are rejected by the crypto layer,
    # which is where "not a SonicSeal frame" really belongs.
    p = L.SlipParser(min_len=1)
    bad = bytearray(L.slip_encode(b'corrupted payload!!'))
    bad[3] = L.END  # bare delimiter in the middle
    got = p.feed(bytes(bad) + L.slip_encode(b'good payload here.'))
    check('resync: good frame still arrives', got[-1] if got else None, b'good payload here.')
    check('torn pieces are not SonicSeal frames',
          [env.parse(piece) for piece in got[:-1]], [None, None])

    # the 19-byte floor: a runt frame never reaches the crypto layer
    p = L.SlipParser()
    check('runt frame dropped', p.feed(L.slip_encode(b'short')), [])
    check('runt counted as garbage', p.garbage, 1)

    # real SonicSeal frames survive the link layer and still decrypt
    sealed = env.seal('The lighthouse keeper left a note under the third stair.', KEY)
    p = L.SlipParser()
    frames = []
    for frame in sealed['frames']:
        for chunk in L.slip_encode(frame):
            frames.extend(p.feed(bytes([chunk])))
    asm = env.Assembler()
    result = None
    for frame in frames:
        result = asm.push(frame, KEY) or result
    check('sealed frames through SLIP',
          result['text'] if result else None,
          'The lighthouse keeper left a note under the third stair.')

    # 122-byte worst case: a full frame must not trip the 512-byte guard
    worst = bytes(range(122))
    p = L.SlipParser()
    got = p.feed(L.slip_encode(worst))
    check('122-byte frame intact', got[0] if got else None, worst)

    print('\nALL OK' if not fail else '\n%d FAILURE(S)' % fail)
    return 1 if fail else 0


if __name__ == '__main__':
    sys.exit(main())
