"""Hardware-agnostic SonicSeal node: seal text, put it on the link, and turn
whatever comes back into text again.

Nothing here touches `machine` or I2C, so the whole data path can be exercised
on a PC with a loopback link (see test/node-test.py). main.py only wires this
to the HC-12 UART, the OLED and the console.
"""

import ss_envelope as env

KEY_BYTES = 32


class Node:
    def __init__(self, link, key=None, log=None, max_groups=8):
        self.link = link
        self.key = key            # 32 raw bytes, or None for plaintext mode
        self.log = log or (lambda msg: None)
        self.assembler = env.Assembler()
        self.inbox = []           # messages decoded before the caller asked
        self.sent = 0
        self.received = 0
        self.errors = 0
        self.last_error = None
        self._max_groups = max_groups

    # ---------------------------------------------------------------- sending
    def send_text(self, text):
        """Seal `text` and push its frames onto the link. Returns frame count."""
        text = (text or '').strip()
        if not text:
            raise ValueError('empty message')
        built = env.seal(text, self.key)
        self.link.send_frames(built['frames'])
        self.sent += 1
        self.log('sent %d frame(s), %d bytes%s' % (
            built['chunks'], built['plainBytes'], '' if self.key else ' (clear)'))
        return built['chunks']

    # -------------------------------------------------------------- receiving
    def poll(self):
        """Drain the link; return a list of assembled messages ({text, sealed})."""
        out = list(self.inbox)
        del self.inbox[:]
        for frame in self.link.poll():
            try:
                result = self.assembler.push(frame, self.key)
            except env.AuthError:
                # Most likely the peer uses a different key. Keep the frame so a
                # corrected key can still decode it.
                self._fail('auth failed (wrong key?)')
                continue
            except env.UnsupportedError:
                self._fail('compressed frame (not supported here)')
                continue
            except env.VersionError:
                self._fail('frame from an incompatible version')
                continue
            except env.FormatError:
                self._fail('not a SonicSeal frame')
                continue
            if result:
                self.received += 1
                out.append(result)
        return out

    def retry(self):
        """Try every buffered group again — used right after the key changes.

        Anything that now decrypts is queued so the next poll() hands it over.
        """
        recovered = self.assembler.flush(self.key)
        self.received += len(recovered)
        self.inbox.extend(recovered)
        return recovered

    def _fail(self, reason):
        self.errors += 1
        self.last_error = reason
        self.log('drop: ' + reason)

    # --------------------------------------------------------------- console
    def command(self, line):
        """Handle one console line. Returns a string to print, or None."""
        line = (line or '').strip()
        if not line:
            return None
        verb, _, rest = line.partition(' ')
        verb = verb.lower()

        if verb == 'send':
            if not rest.strip():
                return 'usage: send <english text>'
            try:
                n = self.send_text(rest)
            except ValueError as err:
                return 'error: %s' % err
            return 'ok: %d frame(s)' % n

        if verb == 'key':
            token = rest.strip()
            if not token:
                return 'key: %s' % ('(none, clear text)' if not self.key else 'set')
            if token.lower() in ('off', 'clear', 'none'):
                self.key = None
                return 'key cleared: messages travel in clear text'
            if len(token) != KEY_BYTES * 2:
                return 'error: key must be %d hex characters' % (KEY_BYTES * 2)
            try:
                self.key = bytes.fromhex(token)
            except ValueError:
                return 'error: key must be hex'
            replay = self.retry()
            suffix = ' (%d buffered message(s) recovered)' % len(replay) if replay else ''
            return 'key set%s' % suffix

        if verb == 'status':
            return 'sent=%d received=%d errors=%d key=%s' % (
                self.sent, self.received, self.errors,
                'yes' if self.key else 'no')

        if verb == 'test':
            # self-check without a peer: seal a probe, feed it back through the
            # assembler, compare. Catches a broken radio, key or crypto path.
            probe = 'probe %d' % self.sent
            try:
                built = env.seal(probe, self.key)
            except Exception as err:  # noqa: BLE001 - report anything
                return 'self-test failed to seal: %s' % err
            asm = env.Assembler()
            result = None
            for frame in built['frames']:
                result = asm.push(frame, self.key) or result
            if not result or result['text'] != probe:
                return 'self-test FAILED (crypto roundtrip)'
            return 'self-test ok: %d frame(s), peel %d bytes' % (
                built['chunks'], len(result['text']))

        return 'commands: send <text> | key <64 hex|off> | status | test | help'

    # ------------------------------------------------------------------ stats
    def stats(self):
        return {
            'sent': self.sent,
            'received': self.received,
            'errors': self.errors,
            'last_error': self.last_error,
            'key': bool(self.key),
            'pending': self.assembler.stats()['pending'],
        }
