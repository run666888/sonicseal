"""Two-node test with no hardware: two Nodes joined by an in-memory link.

This is the closest thing to "two boards on the bench" that can run on a PC.
It exercises seal -> SLIP -> framing -> open -> assemble in both directions,
plus key changes, corruption and the console commands.

    python test/node-test.py
"""

import os
import random
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, os.path.join(ROOT, 'firmware', 'lib'))

import ss_envelope as env  # noqa: E402
import ss_link as L  # noqa: E402
import ss_node as N  # noqa: E402

KEY = bytes(range(32))
OTHER = bytes([b ^ 0xFF for b in KEY])
fail = 0


def check(label, got, want):
    global fail
    if got != want:
        print('FAIL  %s\n  got  %r\n  want %r' % (label, got, want))
        fail += 1
    else:
        print('ok    %s' % label)


class Loop:
    """A radio-free link: whatever one side writes, the other side reads."""

    def __init__(self):
        self.a_to_b = bytearray()
        self.b_to_a = bytearray()
        self.drop_next = 0     # drop the next N frames to test resilience
        self.sent_frames = 0

    def link(self, outbox, inbox, name):
        outer = self

        class Side:
            def __init__(self):
                self.parser = L.SlipParser()
                self.name = name

            def send(self, payload):
                outer.sent_frames += 1
                if outer.drop_next:
                    outer.drop_next -= 1
                    return  # simulate an interference hit
                outbox.extend(L.slip_encode(payload))

            def send_frames(self, frames, gap_ms=0):
                for frame in frames:
                    self.send(frame)

            def poll(self):
                data = bytes(inbox)
                del inbox[:]
                return self.parser.feed(data)

        return Side()

    def pair(self):
        a = N.Node(self.link(self.a_to_b, self.b_to_a, 'A'), KEY)
        b = N.Node(self.link(self.b_to_a, self.a_to_b, 'B'), KEY)
        return a, b


def pump(a, b, rounds=4):
    """Let both sides drain until quiet."""
    got_a, got_b = [], []
    for _ in range(rounds):
        got_b.extend(b.poll())
        got_a.extend(a.poll())
    return got_a, got_b


def main():
    loop = Loop()
    a, b = loop.pair()

    # --- basic both ways ------------------------------------------------
    a.send_text('Meet me by the old lighthouse at nine.')
    _, got = pump(a, b)
    check('A -> B', got[0]['text'] if got else None, 'Meet me by the old lighthouse at nine.')

    b.send_text('Roger. Bring the brass key.')
    got, _ = pump(a, b)
    check('B -> A', got[0]['text'] if got else None, 'Roger. Bring the brass key.')

    # --- multi-frame, and UTF-8 ----------------------------------------
    long_text = 'The lighthouse keeper left a note under the third stair: ' \
                'the tide turns at eleven and the boat waits ten minutes.'
    a.send_text(long_text)
    _, got = pump(a, b)
    check('multi-frame reassembly', got[0]['text'] if got else None, long_text)
    check('chunk count', got[0]['chunks'] if got else None, 2)

    b.send_text('中文也可以，盐和密钥不受影响。')
    got, _ = pump(a, b)
    check('utf-8 payload', got[0]['text'] if got else None, '中文也可以，盐和密钥不受影响。')

    # --- receiver with the wrong key: frame is kept, then recovered ----
    b.key = OTHER
    a.send_text('secret for the right key only')
    _, got = pump(a, b)
    check('wrong key yields nothing', got, [])
    check('wrong key counted as error', b.errors >= 1, True)
    check('frame still buffered', b.stats()['pending'] >= 1, True)

    b.command('key ' + KEY.hex())
    _, got = pump(a, b)
    check('recovered after key fix', got[0]['text'] if got else None,
          'secret for the right key only')

    # --- clear text mode ------------------------------------------------
    a.command('key off')
    a.send_text('no key here')
    _, got = pump(a, b)
    check('clear text delivered', got[0]['text'] if got else None, 'no key here')
    check('clear text flagged', got[0]['sealed'] if got else None, False)
    a.command('key ' + KEY.hex())

    # --- lossy link: dropped frames do not break later traffic ---------
    loop.drop_next = 1
    a.send_text('this frame is dropped by the bad radio')
    _, got = pump(a, b)
    check('dropped frame not delivered', got, [])
    a.send_text('next message gets through')
    _, got = pump(a, b)
    check('link recovers after a drop', got[0]['text'] if got else None,
          'next message gets through')

    # --- console commands ----------------------------------------------
    check('status command', b.command('status').startswith('sent='), True)
    check('send has no argument', b.command('send'), 'usage: send <english text>')
    check('bad key length', b.command('key abcd'), 'error: key must be 64 hex characters')
    check('unknown command starts with help hint',
          b.command('frobnicate').startswith('commands:'), True)
    check('self-test passes', a.command('test').startswith('self-test ok'), True)

    # --- random fuzz: garbage on the link must not crash the node ------
    random.seed(7)
    for _ in range(15):
        junk = bytes(random.randrange(256) for _ in range(random.randrange(0, 200)))
        b.link.parser.feed(junk)  # may yield junk frames
        b.poll()                  # must reject them, not raise
    check('survives fuzzed input', b.errors > 0, True)
    a.send_text('still alive after the noise')
    _, got = pump(a, b)
    check('works after fuzz', got[0]['text'] if got else None, 'still alive after the noise')

    print('\nALL OK' if not fail else '\n%d FAILURE(S)' % fail)
    return 1 if fail else 0


if __name__ == '__main__':
    sys.exit(main())
