"""Runs main.py on the PC with fake hardware, so the board's glue code gets
executed at least once before it ever reaches a real ESP32.

Stubs `machine`, `uselect` and a UART that loops back into itself; the loop is
stopped after a few iterations. Catches typos, wrong attribute names and the
kind of bug that only shows up at runtime.

    python test/main-smoke.py
"""

import os
import sys
import types

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
FIRMWARE = os.path.join(ROOT, 'firmware')
sys.path.insert(0, os.path.join(FIRMWARE, 'lib'))
sys.path.insert(0, FIRMWARE)

fail = 0


OUT = sys.__stdout__


def say(line):
    OUT.write(line + '\n')


def check(label, cond, detail=''):
    global fail
    if cond:
        say('ok    %s' % label)
    else:
        say('FAIL  %s %s' % (label, detail))
        fail += 1


# ------------------------------------------------------------------ stubs
class FakeUART:
    def __init__(self, *args, **kwargs):
        self.kwargs = kwargs
        self.rx = bytearray()
        self.tx = bytearray()

    def write(self, data):
        self.tx.extend(data)

    def read(self, n=None):
        if n is None:
            data = bytes(self.rx)
            del self.rx[:]
            return data
        data = bytes(self.rx[:n])
        del self.rx[:n]
        return data

    def any(self):
        return len(self.rx)


class FakePin:
    OUT = 1
    IN = 0

    def __init__(self, n, mode=None):
        self.n = n
        self.value0 = None

    def value(self, v=None):
        if v is None:
            return self.value0
        self.value0 = v


machine = types.ModuleType('machine')
machine.UART = FakeUART
machine.Pin = FakePin
machine.I2C = lambda *a, **k: types.SimpleNamespace(writeto=lambda *a, **k: None)
sys.modules['machine'] = machine

uselect = types.ModuleType('uselect')
uselect.POLLIN = 1


class FakePoll:
    def __init__(self):
        self.registered = []

    def register(self, obj, mask):
        self.registered.append(obj)

    def poll(self, timeout=0):
        return [(sys.stdin, uselect.POLLIN)] if getattr(sys.stdin, 'queue', '') else []


uselect.poll = FakePoll
sys.modules['uselect'] = uselect

# stdin has to support register()/read() without blocking
class FakeStdin:
    def __init__(self):
        self.queue = ''

    def read(self, n=1):
        if not self.queue:
            return ''
        ch, self.queue = self.queue[0], self.queue[1:]
        return ch


class QuietStdout:
    def __init__(self):
        self.text = ''

    def write(self, s):
        self.text += s

    def flush(self):
        pass


sys.stdin = FakeStdin()
sys.stdout = QuietStdout()
real_stdout = sys.__stdout__


def main():
    import config
    config.OLED_ENABLED = False          # no I2C stub for the panel
    config.KEY_HEX = ''

    import main as node_main

    iterations = [0]

    def fake_sleep(ms):
        iterations[0] += 1
        if iterations[0] > 6:
            raise StopIteration

    node_main.time.sleep_ms = fake_sleep

    # run the boot loop twice, once per console command, and collect what the
    # board would have printed
    outputs = {}
    for cmd, key in (('status\r', 'status'), ('help\r', 'help')):
        sys.stdin.queue = cmd
        sys.stdout.text = ''
        iterations[0] = 0
        node_main.time.sleep_ms = fake_sleep
        try:
            node_main.main()
        except StopIteration:
            pass
        except Exception as err:        # noqa: BLE001 - this is a smoke test
            real_stdout.write('FAIL  main() raised %s: %s\n' % (type(err).__name__, err))
            return 1
        outputs[key] = sys.stdout.text

    node_main.time.sleep_ms = lambda ms: None   # pacing no longer matters

    out = outputs['status']
    check('main loop ran', iterations[0] > 6, 'iterations=%d' % iterations[0])
    check('banner printed', 'SonicSeal radio node' in out)
    check('help answered', 'commands:' in outputs['help'], repr(outputs['help'][-120:]))
    check('status answered', 'sent=0' in out)

    # a command path that seals and transmits: 'send' must produce SLIP bytes
    uart = node_main.open_radio()
    from ss_link import Link
    from ss_node import Node
    node = Node(Link(uart), bytes(range(32)))
    check('send yields frames', node.command('send hello radio') == 'ok: 1 frame(s)')
    check('uart carried bytes', len(uart.tx) > 10, 'tx=%d' % len(uart.tx))
    check('slip delimiters present', uart.tx[0] == 0x7E and uart.tx[-1] == 0x7E)

    # and a message coming back in must be displayed and printed
    from ss_envelope import seal
    other = Node(Link(FakeUART()), bytes(range(32)))
    built = seal('hello back', bytes(range(32)))
    from ss_link import slip_encode
    for frame in built['frames']:
        node.link.uart.rx.extend(slip_encode(frame))
    msgs = node.poll()
    check('received through radio', msgs and msgs[0]['text'] == 'hello back', str(msgs))

    say('\nALL OK' if not fail else '\n%d FAILURE(S)' % fail)
    return 1 if fail else 0


if __name__ == '__main__':
    sys.exit(main())
