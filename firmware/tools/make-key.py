"""Generate a preshared key for the boards (and the web page).

    python firmware/tools/make-key.py
    python firmware/tools/make-key.py --count 2     # one key per board pair

Prints the 64 hex characters to paste into firmware/config.py (KEY_HEX) and
the matching `key:...` string to paste into the web page's key field.
"""

import os
import sys


def new_key():
    try:
        return os.urandom(32)
    except (AttributeError, NotImplementedError):
        import urandom
        return bytes(urandom.getrandbits(8) for _ in range(32))


def main():
    count = 2 if '--count' in sys.argv else 1
    if '--count' in sys.argv:
        try:
            count = int(sys.argv[sys.argv.index('--count') + 1])
        except (IndexError, ValueError):
            count = 2

    for i in range(count):
        hex_key = new_key().hex()
        if count > 1:
            print('# key %d' % (i + 1))
        print('config.py      KEY_HEX = %r' % hex_key)
        print('web page  key  key:%s' % hex_key)
        if i + 1 < count:
            print()

    print()
    print('Give the same key to both boards. Anyone with this key can read the')
    print('radio traffic, so keep it out of screenshots and chat logs.')


if __name__ == '__main__':
    main()
