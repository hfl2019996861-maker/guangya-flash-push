#!/usr/bin/env python3
"""Generate extension icons (pure python, no deps): rounded-square orange
gradient with a white lightning bolt."""

import struct
import zlib
import os

def write_png(path, size, pixels):
    # pixels: list of rows, each row list of (r, g, b, a)
    raw = b""
    for row in pixels:
        raw += b"\x00" + b"".join(struct.pack("4B", *px) for px in row)

    def chunk(tag, data):
        c = struct.pack(">I", len(data)) + tag + data
        return c + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)

    png = b"\x89PNG\r\n\x1a\n"
    png += chunk(b"IHDR", struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0))
    png += chunk(b"IDAT", zlib.compress(raw, 9))
    png += chunk(b"IEND", b"")
    with open(path, "wb") as f:
        f.write(png)

def hex2rgb(h):
    return tuple(int(h[i:i + 2], 16) for i in (0, 2, 4))

TOP = hex2rgb("FFD84D")   # 亮黄
BOTTOM = hex2rgb("F98A0F") # 深橙

# 闪电多边形（单位坐标 0..1）
BOLT = [
    (0.58, 0.08), (0.24, 0.55), (0.44, 0.55),
    (0.36, 0.92), (0.74, 0.42), (0.52, 0.42),
    (0.68, 0.08),
]

def point_in_poly(x, y, poly):
    inside = False
    n = len(poly)
    j = n - 1
    for i in range(n):
        xi, yi = poly[i]
        xj, yj = poly[j]
        if (yi > y) != (yj > y):
            xint = (xj - xi) * (y - yi) / (yj - yi) + xi
            if x < xint:
                inside = not inside
        j = i
    return inside

def render(size, ss=4):
    big = size * ss
    radius = big * 0.22
    cx = cy = big / 2
    out = []
    for yy in range(big):
        row = []
        for xx in range(big):
            # 圆角矩形遮罩
            dx = max(abs(xx + 0.5 - cx) - (big / 2 - radius), 0)
            dy = max(abs(yy + 0.5 - cy) - (big / 2 - radius), 0)
            dist = (dx * dx + dy * dy) ** 0.5
            alpha = 255 if dist <= radius else 0
            t = yy / big
            r = int(TOP[0] + (BOTTOM[0] - TOP[0]) * t)
            g = int(TOP[1] + (BOTTOM[1] - TOP[1]) * t)
            b = int(TOP[2] + (BOTTOM[2] - TOP[2]) * t)
            if point_in_poly(xx / big, yy / big, BOLT):
                r = g = b = 255
            row.append((r, g, b, alpha))
        out.append(row)
    # 下采样
    small = []
    for y in range(size):
        srow = []
        for x in range(size):
            r = g = b = a = 0
            for dy in range(ss):
                for dx in range(ss):
                    pr, pg, pb, pa = out[y * ss + dy][x * ss + dx]
                    r += pr; g += pg; b += pb; a += pa
            n = ss * ss
            srow.append((r // n, g // n, b // n, a // n))
        small.append(srow)
    return small

if __name__ == "__main__":
    base = os.path.join(os.path.dirname(__file__), "..", "icons")
    os.makedirs(base, exist_ok=True)
    for s in (16, 32, 48, 128):
        path = os.path.join(base, f"icon{s}.png")
        write_png(path, s, render(s))
        print("wrote", os.path.abspath(path))
