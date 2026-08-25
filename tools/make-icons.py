#!/usr/bin/env python3
"""Regenerate the PWA icons.

The committed icons are deliberately generic. If you want branded ones on your
own kiosk, change the colours below and re-run — but remember the icons are part
of the published bundle, unlike checkout-config.json.

    python3 tools/make-icons.py

Requires Pillow (`pip install pillow`). """
import pathlib
from PIL import Image, ImageDraw

BASE   = (63, 91, 115, 255)     # neutral slate, matches the default --accent
MARK   = (255, 255, 255, 255)   # checkmark
PANEL  = (233, 237, 240, 255)   # laptop body

OUT = pathlib.Path(__file__).resolve().parent.parent / "icons"


def make(path, size, maskable=False):
    img = Image.new("RGBA", (size, size), BASE)
    d = ImageDraw.Draw(img)

    # Maskable icons are cropped to a circle by the launcher, so they keep the
    # full square of colour and shrink the glyph into the safe zone instead.
    if not maskable:
        mask = Image.new("L", (size, size), 0)
        ImageDraw.Draw(mask).rounded_rectangle(
            [0, 0, size - 1, size - 1], radius=int(size * 0.22), fill=255)
        img.putalpha(mask)

    scale = 0.62 if maskable else 0.74
    w = size * scale
    x0, y0 = (size - w) / 2, (size - w * 0.72) / 2

    d.rounded_rectangle([x0, y0, x0 + w, y0 + w * 0.56],
                        radius=size * 0.035, fill=PANEL)                    # screen
    d.rounded_rectangle([x0 - w * 0.09, y0 + w * 0.585,
                         x0 + w + w * 0.09, y0 + w * 0.70],
                        radius=size * 0.022, fill=PANEL)                    # base

    cx, cy, r = x0 + w / 2, y0 + w * 0.28, w * 0.17
    d.line([(cx - r, cy), (cx - r * 0.25, cy + r * 0.68), (cx + r * 1.05, cy - r * 0.75)],
           fill=BASE, width=max(3, int(size * 0.055)), joint="curve")     # checkmark

    img.save(path)
    print("wrote", path)


if __name__ == "__main__":
    OUT.mkdir(exist_ok=True)
    make(OUT / "icon-192.png", 192)
    make(OUT / "icon-512.png", 512)
    make(OUT / "icon-512-maskable.png", 512, maskable=True)
