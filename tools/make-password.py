#!/usr/bin/env python3
"""Generate the staff password block for checkout-config.json.

    python3 tools/make-password.py

Prompts for a password (not echoed) and prints a JSON fragment to paste into
your local checkout-config.json. Nothing is written to disk, and the password
itself is never stored — only a salted PBKDF2-SHA256 hash of it.
"""
import getpass
import hashlib
import json
import os
import sys

ITERATIONS = 200_000


def main():
    pw = getpass.getpass("Staff password: ")
    if not pw:
        sys.exit("Empty password, nothing generated.")
    if pw != getpass.getpass("Again: "):
        sys.exit("Passwords did not match.")

    salt = os.urandom(16)
    digest = hashlib.pbkdf2_hmac("sha256", pw.encode(), salt, ITERATIONS, dklen=32)

    print("\nPaste this into checkout-config.json:\n")
    print('  "password": ' + json.dumps({
        "salt": salt.hex(),
        "hash": digest.hex(),
        "iterations": ITERATIONS,
    }, indent=4).replace("\n", "\n  "))
    print()


if __name__ == "__main__":
    main()
