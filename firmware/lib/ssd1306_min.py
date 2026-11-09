"""Minimal SSD1306 I2C driver for MicroPython (128x64 and 128x32).

Only the parts this project needs: init, show, text, fill, pixel — no fonts,
no scrolling, no hardware SPI. A subset of the micropython-lib driver, kept
here so the board needs nothing but the files in this folder.
"""

import framebuf


class SSD1306:
    def __init__(self, width, height, external_vcc=False):
        self.width = width
        self.height = height
        self.external_vcc = external_vcc
        self.pages = height // 8
        self.buffer = bytearray(self.pages * width)
        self.fb = framebuf.FrameBuffer(self.buffer, width, height, framebuf.MONO_VLSB)
        self.init_display()

    # -------------------------------------------------------------- commands
    def write_cmd(self, cmd):
        raise NotImplementedError

    def write_data(self, buf):
        raise NotImplementedError

    def init_display(self):
        for cmd in (
            0xAE,                          # display off
            0x20, 0x00,                    # horizontal addressing
            0xB0, 0xC8, 0x00, 0x10,        # page start, COM scan, low/high col
            0x40,                          # start line 0
            0x81, 0xCF,                    # contrast
            0xA1,                          # segment remap
            0xA6,                          # normal (not inverted)
            0xA8, self.height - 1,         # multiplex ratio
            0xD3, 0x00,                    # no display offset
            0xD5, 0x80,                    # clock divide
            0xD9, 0xF1,                    # pre-charge
            0xDA, 0x12 if self.height == 64 else 0x02,   # COM pins
            0xDB, 0x40,                    # VCOMH
            0x8D, 0x10 if not self.external_vcc else 0x14,  # charge pump
            0xAF,                          # display on
        ):
            self.write_cmd(cmd)

    def power(self, on):
        self.write_cmd(0xAF if on else 0xAE)

    def contrast(self, value):
        self.write_cmd(0x81)
        self.write_cmd(value)

    def invert(self, invert):
        self.write_cmd(0xA7 if invert else 0xA6)

    # ---------------------------------------------------------------- pixels
    def fill(self, colour):
        self.fb.fill(colour)

    def pixel(self, x, y, colour):
        self.fb.pixel(x, y, colour)

    def text(self, string, x, y, colour=1):
        self.fb.text(string, x, y, colour)

    def show(self):
        for page in range(self.pages):
            self.write_cmd(0xB0 + page)
            self.write_cmd(0x00)
            self.write_cmd(0x10)
            start = page * self.width
            self.write_data(self.buffer[start:start + self.width])


class SSD1306_I2C(SSD1306):
    def __init__(self, width, height, i2c, addr=0x3C, external_vcc=False):
        self.i2c = i2c
        self.addr = addr
        super().__init__(width, height, external_vcc)

    def write_cmd(self, cmd):
        self.i2c.writeto(self.addr, bytes([0x00, cmd]))

    def write_data(self, buf):
        chunk = 16
        for i in range(0, len(buf), chunk):
            self.i2c.writeto(self.addr, b'\x40' + bytes(buf[i:i + chunk]))
