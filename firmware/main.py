"""SonicSeal radio node — main.py for ESP32-C3 + HC-12 (MicroPython).

Boot flow
  1. open the HC-12 UART, optionally force a channel through the SET pin
  2. try to bring up an SSD1306 OLED (skipped silently when absent)
  3. run a loop that watches the radio and the USB console at the same time

Console commands (typed into any serial terminal, 115200 baud):
    send <english text>     seal + transmit
    key <64 hex | off>      change the preshared key (also retries buffered frames)
    status                  counters
    test                    crypto self-test, no peer needed
    help                    this list

Files to copy to the board (all flattened into the root, easy and boring):

    mpremote cp firmware/config.py :config.py
    mpremote cp firmware/main.py :main.py
    mpremote cp firmware/lib/aes_pure.py :aes_pure.py
    mpremote cp firmware/lib/ss_gcm.py :ss_gcm.py
    mpremote cp firmware/lib/ss_envelope.py :ss_envelope.py
    mpremote cp firmware/lib/ss_link.py :ss_link.py
    mpremote cp firmware/lib/ss_node.py :ss_node.py
    (optional) mpremote cp firmware/lib/ssd1306_min.py :ssd1306_min.py
"""

import sys
import time

import config
from ss_link import Link
from ss_node import Node

try:
    import uselect
except ImportError:      # pragma: no cover - only on very old builds
    uselect = None


# ---------------------------------------------------------------- display
class Display:
    """Thin wrapper so a missing OLED never breaks the node."""

    def __init__(self):
        self.oled = None
        self.lines = ['SonicSeal ready']
        if not config.OLED_ENABLED:
            return
        try:
            from machine import I2C, Pin
            import ssd1306_min
            i2c = I2C(config.I2C_ID, scl=Pin(config.PIN_SCL), sda=Pin(config.PIN_SDA), freq=400000)
            self.oled = ssd1306_min.SSD1306_I2C(
                config.OLED_WIDTH, config.OLED_HEIGHT, i2c, addr=config.OLED_ADDR)
        except Exception as err:            # no driver, no wiring, no address
            self.oled = None
            print('display off:', err)

    def show(self, text, status=None):
        """Draw `text` wrapped to the panel, plus an optional status line."""
        if not self.oled:
            return
        width = config.OLED_WIDTH // 8
        lines = []
        for para in str(text).split('\n'):
            while len(para) > width:
                cut = para.rfind(' ', 0, width)
                if cut <= 0:
                    cut = width
                lines.append(para[:cut])
                para = para[cut:].lstrip()
            lines.append(para)
        body = lines[:(5 if status else 6)]
        self.oled.fill(0)
        for i, line in enumerate(body):
            self.oled.text(line, 0, i * 10)
        if status:
            self.oled.text(status[:width], 0, 54)
        try:
            self.oled.show()
        except Exception:
            self.oled = None  # unplugged mid-run


# ------------------------------------------------------------------ radio
def open_radio():
    from machine import UART

    if config.HC12_CHANNEL and config.HC12_SET_PIN is not None:
        try:
            set_channel(config.HC12_CHANNEL)
        except Exception as err:
            print('channel setup skipped:', err)

    uart = UART(config.UART_ID, baudrate=config.UART_BAUD,
                tx=config.PIN_TX, rx=config.PIN_RX, timeout=0)
    return uart


def set_channel(channel):
    """Force the HC-12 to `channel` (e.g. 'FU3') using the SET pin.

    AT commands go at 9600 baud with SET held low. Only needed once, and only
    when two radios do not already share the factory default.
    """
    from machine import UART, Pin

    pin = Pin(config.HC12_SET_PIN, Pin.OUT)
    pin.value(0)
    time.sleep_ms(40)
    at = UART(config.UART_ID, baudrate=9600, tx=config.PIN_TX, rx=config.PIN_RX, timeout=200)
    for cmd in ('AT', 'AT+FU3', 'AT+P8'):     # 8N1, then the channel
        at.write((cmd + '\r\n').encode())
        time.sleep_ms(120)
        reply = at.read() or b''
        print('hc12', cmd, '->', reply)
    pin.value(1)
    time.sleep_ms(80)


# ---------------------------------------------------------------- console
class Console:
    def __init__(self):
        self.buf = ''
        self.poller = None
        if uselect:
            self.poller = uselect.poll()
            try:
                self.poller.register(sys.stdin, uselect.POLLIN)
            except Exception:
                self.poller = None

    def read_line(self):
        """Return a finished line, or None while the user is still typing."""
        if not self.poller:
            return None
        if not self.poller.poll(0):
            return None
        ch = sys.stdin.read(1)
        if ch in ('\r', '\n'):
            line, self.buf = self.buf, ''
            return line
        if ch in ('\x7f', '\b'):
            self.buf = self.buf[:-1]
            return None
        if ch == '\x03':            # Ctrl-C: clear the line
            self.buf = ''
            return None
        self.buf += ch
        if config.ECHO_CONSOLE:
            sys.stdout.write(ch)
        return None


# ------------------------------------------------------------------- main
def main():
    display = Display()
    console = Console()
    uart = open_radio()
    link = Link(uart)

    key = None
    if config.KEY_HEX:
        try:
            key = bytes.fromhex(config.KEY_HEX.strip())
            if len(key) != 32:
                print('config.KEY_HEX must be 64 hex chars, ignoring it')
                key = None
        except ValueError:
            print('config.KEY_HEX is not valid hex, ignoring it')

    node = Node(link, key)

    print()
    print('SonicSeal radio node')
    print('  uart%d  %d baud  tx=%d rx=%d' % (config.UART_ID, config.UART_BAUD,
                                              config.PIN_TX, config.PIN_RX))
    print('  key    %s' % ('set' if key else 'none (clear text)'))
    print('  type "help" for commands')
    display.show('SonicSeal ready', 'key: %s' % ('set' if key else 'none'))

    while True:
        for msg in node.poll():
            tag = 'AES-GCM' if msg['sealed'] else 'clear'
            print('\n> [%s] %s' % (tag, msg['text']))
            display.show(msg['text'], '%s %s' % (tag, msg['msgId'][:6]))

        line = console.read_line()
        if line is not None:
            reply = node.command(line)
            if reply:
                print(reply)
                if line.strip().lower().startswith(('key', 'status', 'test', 'send')):
                    display.show(reply, 'ok')
            elif line.strip():
                print()

        time.sleep_ms(config.LOOP_SLEEP_MS)


if __name__ == '__main__':
    main()
