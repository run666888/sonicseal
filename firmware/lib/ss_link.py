"""Link layer for the HC-12 radio: frame boundaries + a tiny state machine.

HC-12 is a transparent UART pipe, so it hands us a continuous byte stream with
no idea where one SonicSeal frame ends. SLIP is the cheapest way to get
boundaries back: 0x7E starts and ends a frame, 0x7D escapes the two special
bytes. The payload is already authenticated by AES-GCM, so a mangled frame is
simply dropped later by the tag check — no CRC needed here.

Everything in this module is plain Python and hardware-free, so it runs on the
PC during tests as well as on the board.
"""

END = 0x7E
ESC = 0x7D
ESC_END = 0x5E
ESC_ESC = 0x5D


def slip_encode(payload):
    """Wrap `payload` in SLIP delimiters."""
    out = bytearray([END])
    for b in payload:
        if b == END:
            out.extend((ESC, ESC_END))
        elif b == ESC:
            out.extend((ESC, ESC_ESC))
        else:
            out.append(b)
    out.append(END)
    return bytes(out)


def slip_decode(raw):
    """Strict decode of one SLIP frame (without the outer 0x7E bytes).

    Returns None if the frame is malformed; the caller drops it.
    """
    out = bytearray()
    i = 0
    n = len(raw)
    while i < n:
        b = raw[i]
        if b == ESC:
            if i + 1 >= n:
                return None
            nxt = raw[i + 1]
            if nxt == ESC_END:
                out.append(END)
            elif nxt == ESC_ESC:
                out.append(ESC)
            else:
                return None
            i += 2
        elif b == END:
            return None  # bare delimiter inside a frame: framing is broken
        else:
            out.append(b)
            i += 1
    return bytes(out)


class SlipParser:
    """Feed it UART bytes, get whole frames out (malformed ones skipped).

    Two rules keep the radio link honest:

      * bytes that arrive before the first 0x7E are line noise after a power
        glitch or a mid-frame start, so they are discarded rather than
        mistaken for a frame;
      * anything shorter than a SonicSeal header cannot be one of ours, so a
        frame torn in half by an interfering transmission is counted as
        garbage instead of being pushed up to the crypto layer.
    """

    def __init__(self, max_len=512, min_len=19):
        self.buf = bytearray()
        self.max_len = max_len
        self.min_len = min_len
        self.in_frame = False
        self.garbage = 0

    def feed(self, data):
        frames = []
        for b in data:
            if b == END:
                if self.in_frame and self.buf:
                    frame = slip_decode(self.buf)
                    if frame is None or len(frame) < self.min_len:
                        self.garbage += 1
                    else:
                        frames.append(frame)
                self.buf = bytearray()
                self.in_frame = True
                continue
            if not self.in_frame:
                continue  # noise before the first delimiter
            if len(self.buf) >= self.max_len:
                # runaway line, resynchronise on the next delimiter
                self.buf = bytearray()
                self.garbage += 1
                continue
            self.buf.append(b)
        return frames


class Link:
    """HC-12 helper: send a payload as one SLIP frame, receive whole frames."""

    def __init__(self, uart):
        self.uart = uart
        self.parser = SlipParser()

    def send(self, payload):
        self.uart.write(slip_encode(payload))

    def poll(self):
        """Non-blocking drain of whatever the radio delivered."""
        n = self.uart.any()
        if not n:
            return []
        return self.parser.feed(self.uart.read(n))

    def send_frames(self, frames, gap_ms=20):
        """Send several SonicSeal frames back to back.

        HC-12 needs a moment between frames: its internal buffer is small and
        the radio does its own packetising.
        """
        import time
        for frame in frames:
            self.send(frame)
            time.sleep_ms(gap_ms)
