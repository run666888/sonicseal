"""Board configuration — the only file you normally need to edit.

Wiring (ESP32-C3 to HC-12):

    board 5V    -> HC-12 VCC        (3V3 works too, with less range)
    board GND   -> HC-12 GND
    board GPIO4 -> HC-12 RXD        (cross: board TX to radio RXD)
    board GPIO3 <- HC-12 TXD        (cross: board RX to radio TXD)
    board GPIO5 -> HC-12 SET        (optional, only for AT commands)

Keep GPIO5 unconnected if you never change the channel: HC-12 is then always
in normal (transparent) mode.
"""

# --- radio ---------------------------------------------------------------
UART_ID = 1
UART_BAUD = 9600          # HC-12 factory default
PIN_TX = 4                # board TX  -> HC-12 RXD
PIN_RX = 3                # board RX  <- HC-12 TXD
HC12_SET_PIN = None       # e.g. 5 to enable AT commands; None disables
HC12_CHANNEL = None       # e.g. 'FU3' to force a channel at boot (needs SET pin)

# --- display (optional) --------------------------------------------------
OLED_ENABLED = True       # silently skipped when no OLED is wired
I2C_ID = 0
PIN_SDA = 6
PIN_SCL = 7
OLED_ADDR = 0x3C
OLED_WIDTH = 128
OLED_HEIGHT = 64

# --- crypto --------------------------------------------------------------
# 64 hex characters = a 32-byte AES-256 key. Leave empty to send clear text.
# Generate one with:  python firmware/tools/make-key.py
KEY_HEX = ''

# --- housekeeping --------------------------------------------------------
LOOP_SLEEP_MS = 20
ECHO_CONSOLE = True       # print what you type (USB-CDC does not echo)
