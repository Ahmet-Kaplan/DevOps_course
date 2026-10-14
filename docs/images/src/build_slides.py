#!/usr/bin/env python3
"""Draw the nine slides of the "Containers and Docker" lesson (docs/containers-and-docker.md).

Same palette, type and logos as the system diagrams (shared through svgkit.py):

    docs/images/slides/containers-01-works-on-my-machine.svg ... containers-09-compose.svg

One idea per slide, a big title, very little text, a visual metaphor and real names from
this repository. Standard library only. From the repository root:

    python3 docs/images/src/build_slides.py
"""

import argparse
import math
import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from svgkit import *  # noqa: E402,F401,F403  shared tokens, helpers, icons and logos

OUT_DIR = os.path.join(os.path.dirname(HERE), "slides")
MONO = "ui-monospace, SFMono-Regular, Menlo, Consolas, 'Liberation Mono', 'DejaVu Sans Mono', monospace"
TOTAL = 9
X0, X1 = 80, 1520          # slide margins


# ---------------------------------------------------------------------------
# Slide-only helpers
# ---------------------------------------------------------------------------
def mono(x, y, s, size, fill, weight=400):
    """Monospace text on a fixed 0.6 em grid. Each word is placed at its own column and fitted
    with textLength, so spaces survive and highlight boxes line up whatever font is installed."""
    cw = size * 0.6
    out = []
    for m in re.finditer(r"\S+", s):
        tok = m.group(0)
        out.append(f'<text {attrs(x=round(x + m.start() * cw, 2), y=y, font_size=size, font_weight=weight if weight != 400 else None, fill=fill)}'
                   f' font-family="{MONO}" textLength="{f(round(len(tok) * cw, 2))}" lengthAdjust="spacingAndGlyphs">'
                   f'{escape(tok)}</text>')
    return "".join(out)


def mono_w(s, size):
    return len(s) * size * 0.6


def frame(n, title, subtitle):
    """Title, subtitle and the footer (lesson name, progress, N / 9) shared by every slide."""
    out = [text(X0, 112, title, 52, 800, INK, spacing=-0.8),
           text(X0, 158, subtitle, 24, 400, CAP)]
    check_fit("title", title, 52, 800, X1 - X0)
    check_fit("subtitle", subtitle, 24, 400, X1 - X0)
    out.append(logo("docker", X0, 836, 28))
    out.append(text(X0 + 38, 857, "Containers & Docker", 18, 700, TEXT))
    seg, gap = 26, 6
    total = TOTAL * seg + (TOTAL - 1) * gap
    sx = X1 - 64 - total
    for i in range(TOTAL):
        col = ACCENT if i + 1 == n else (FAINT if i + 1 < n else HAIR)
        out.append(rect(sx + i * (seg + gap), 848, seg, 6, 3, fill=col))
    out.append(text(X1, 858, f"{n} / {TOTAL}", 20, 800, INK, "end"))
    return "".join(out)


def ok_badge(cx, cy, r=18):
    return (circle(cx, cy, r, fill=INK, stroke=WHITE, stroke_width=3)
            + path(f"M{f(cx - r * 0.45)} {f(cy + r * 0.02)} L{f(cx - r * 0.1)} {f(cy + r * 0.38)} L{f(cx + r * 0.5)} {f(cy - r * 0.35)}",
                   fill="none", stroke=WHITE, stroke_width=f(r * 0.2), stroke_linecap="round", stroke_linejoin="round"))


def bad_badge(cx, cy, r=18):
    k = r * 0.36
    return (circle(cx, cy, r, fill=GREY, stroke=WHITE, stroke_width=3)
            + path(f"M{f(cx - k)} {f(cy - k)} L{f(cx + k)} {f(cy + k)} M{f(cx + k)} {f(cy - k)} L{f(cx - k)} {f(cy + k)}",
                   fill="none", stroke=WHITE, stroke_width=f(r * 0.2), stroke_linecap="round"))


def box(x, y, w, h, open_=False, color=ACCENT):
    """A shipping container: the visual for 'a container'. open_=True shows the inside."""
    dark = ACCENT_TEXT if color == ACCENT else INK
    out = [rect(x, y, w, h, 8, fill=color)]
    if open_:
        out.append(rect(x + 18, y + 26, w - 36, h - 52, 6, fill=ACCENT_HALO))
        for i in range(int((w - 48) // 14)):
            for yy in (y + 9, y + h - 21):
                out.append(rect(x + 24 + i * 14, yy, 5, 12, 2.5, fill=dark, opacity=0.35))
    else:
        n = int((w - 40) // 16)
        for i in range(n):
            out.append(rect(x + 20 + i * 16, y + 12, 6, h - 24, 3, fill=dark, opacity=0.28))
    out.append(rect(x, y, w, 8, 4, fill=dark))
    out.append(rect(x, y + h - 8, w, 8, 4, fill=dark))
    for cx_ in (x + 4, x + w - 14):
        for cy_ in (y + 2, y + h - 12):
            out.append(rect(cx_, cy_, 10, 10, 2, fill=dark))
    return "".join(out)


def plate(x, y, w, h, items, size=18):
    """White label plate on a box: [(icon_svg_fn, text), ...] in one row."""
    out = [rect(x, y, w, h, 8, fill=WHITE)]
    cx = x + 10
    for ic, s in items:
        out.append(ic(cx, y + (h - 22) / 2, 22))
        out.append(text(cx + 26, y + h / 2 + size * 0.36, s, size, 600, INK))
        cx += 26 + text_width(s, size, 600) + 12
    return "".join(out)


def bug_ic(x, y, s):
    return ic_bug(x, y, s)


def node_ic(x, y, s):
    return logo("nodedotjs", x, y, s)


def libs_ic(x, y, s):
    return ic_layers(x, y, s, CAP)


def ic_gear(x, y, s, color):
    c = s / 2
    out = []
    for i in range(6):
        out.append(f'<rect {attrs(x=x + c - s * 0.12, y=y, width=s * 0.24, height=s, rx=s * 0.05, fill=color, transform=f"rotate({i * 30} {f(x + c)} {f(y + c)})")}/>')
    out.append(circle(x + c, y + c, s * 0.33, fill=color))
    out.append(circle(x + c, y + c, s * 0.14, fill=WHITE))
    return "".join(out)


def ic_doc(x, y, w, h, color, lines=3):
    fold = w * 0.28
    out = [path(f"M{f(x)} {f(y + 4)} Q{f(x)} {f(y)} {f(x + 4)} {f(y)} H{f(x + w - fold)} L{f(x + w)} {f(y + fold)} V{f(y + h - 4)} "
                f"Q{f(x + w)} {f(y + h)} {f(x + w - 4)} {f(y + h)} H{f(x + 4)} Q{f(x)} {f(y + h)} {f(x)} {f(y + h - 4)}Z",
                fill=WHITE, stroke=color, stroke_width=2.5, stroke_linejoin="round"),
           path(f"M{f(x + w - fold)} {f(y)} V{f(y + fold)} H{f(x + w)}", fill="none", stroke=color, stroke_width=2.5, stroke_linejoin="round")]
    for i in range(lines):
        ln = (w - 16) * (1 - 0.22 * (i % 2))
        out.append(rect(x + 8, y + fold + 8 + i * (h - fold - 14) / max(lines, 1), ln, 3.5, 1.75, fill=color))
    return "".join(out)


def ic_server(x, y, w, h, color):
    out = []
    n = 3
    sh = (h - (n - 1) * 6) / n
    for i in range(n):
        yy = y + i * (sh + 6)
        out.append(rect(x, yy, w, sh, 5, fill=color))
        out.append(circle(x + 10, yy + sh / 2, 2.6, fill=WHITE))
        out.append(rect(x + w * 0.45, yy + sh / 2 - 1.5, w * 0.42, 3, 1.5, fill=WHITE, opacity=0.7))
    return "".join(out)


def ic_laptop(x, y, w, color):
    h = w * 0.62
    return (rect(x + w * 0.1, y, w * 0.8, h, 5, fill=color)
            + rect(x + w * 0.1 + 4, y + 4, w * 0.8 - 8, h - 8, 3, fill=WHITE)
            + path(f"M{f(x)} {f(y + h)} H{f(x + w)} V{f(y + h + 4)} Q{f(x + w)} {f(y + h + 8)} {f(x + w - 4)} {f(y + h + 8)} "
                   f"H{f(x + 4)} Q{f(x)} {f(y + h + 8)} {f(x)} {f(y + h + 4)}Z", fill=color))


def laptop_frame(x, y, w, h):
    """A big laptop. Returns (svg, inner screen box)."""
    out = [rect(x + 18, y, w - 36, h, 14, fill="#1F2937"),
           rect(x + 26, y + 8, w - 52, h - 16, 8, fill=WHITE),
           path(f"M{f(x)} {f(y + h)} H{f(x + w)} V{f(y + h + 8)} Q{f(x + w)} {f(y + h + 18)} {f(x + w - 10)} {f(y + h + 18)} "
                f"H{f(x + 10)} Q{f(x)} {f(y + h + 18)} {f(x)} {f(y + h + 8)}Z", fill=LINE),
           rect(x + w / 2 - 24, y + h, 48, 5, 2.5, fill=FAINT)]
    return "".join(out), (x + 26, y + 8, w - 52, h - 16)


def server_frame(x, y, w, h, title="server"):
    out = [card(x, y, w, h, "normal", r=14),
           rect(x, y, w, 44, 14, fill=SOFT), rect(x, y + 30, w, 14, 0, fill=SOFT),
           logo("googlecloud", x + 14, y + 9, 26),
           text(x + 50, y + 29, title, 19, 700, INK)]
    return "".join(out), (x + 12, y + 52, w - 24, h - 64)


def ic_globe(x, y, s, color):
    c = s / 2
    return (circle(x + c, y + c, c - 1.5, fill="none", stroke=color, stroke_width=2.4)
            + f'<ellipse {attrs(cx=x + c, cy=y + c, rx=c * 0.45, ry=c - 1.5, fill="none", stroke=color, stroke_width=2)}/>'
            + line(x + 2, y + c, x + s - 2, y + c, stroke=color, stroke_width=2))


def ic_tag(x, y, s, color):
    k = s / 24.0
    return (path(f"M{f(x + 2 * k)} {f(y + 4 * k)} V{f(y + 12 * k)} L{f(x + 13 * k)} {f(y + 23 * k)} L{f(x + 23 * k)} {f(y + 13 * k)} L{f(x + 12 * k)} {f(y + 2 * k)} H{f(x + 4 * k)} Q{f(x + 2 * k)} {f(y + 2 * k)} {f(x + 2 * k)} {f(y + 4 * k)}Z",
                 fill=color)
            + circle(x + 7.5 * k, y + 7.5 * k, 2.2 * k, fill=WHITE))


def ic_folder(x, y, s, color):
    k = s / 24.0
    return path(f"M{f(x + 1 * k)} {f(y + 5 * k)} Q{f(x + 1 * k)} {f(y + 3 * k)} {f(x + 3 * k)} {f(y + 3 * k)} H{f(x + 9 * k)} L{f(x + 11.5 * k)} {f(y + 6 * k)} H{f(x + 21 * k)} "
                f"Q{f(x + 23 * k)} {f(y + 6 * k)} {f(x + 23 * k)} {f(y + 8 * k)} V{f(y + 19 * k)} Q{f(x + 23 * k)} {f(y + 21 * k)} {f(x + 21 * k)} {f(y + 21 * k)} H{f(x + 3 * k)} "
                f"Q{f(x + 1 * k)} {f(y + 21 * k)} {f(x + 1 * k)} {f(y + 19 * k)}Z", fill=color)


def ic_list(x, y, s, color):
    out = []
    for i in range(3):
        yy = y + s * (0.18 + i * 0.32)
        out.append(circle(x + s * 0.12, yy, s * 0.09, fill=color))
        out.append(rect(x + s * 0.3, yy - s * 0.06, s * 0.68, s * 0.12, s * 0.06, fill=color))
    return "".join(out)


def ic_trash(x, y, s, color):
    k = s / 24.0
    return (rect(x + 3 * k, y + 4 * k, 18 * k, 3 * k, 1.5 * k, fill=color)
            + rect(x + 9 * k, y + 1 * k, 6 * k, 3 * k, 1.5 * k, fill=color)
            + path(f"M{f(x + 5 * k)} {f(y + 8 * k)} H{f(x + 19 * k)} L{f(x + 18 * k)} {f(y + 22 * k)} Q{f(x + 18 * k)} {f(y + 23 * k)} {f(x + 17 * k)} {f(y + 23 * k)} H{f(x + 7 * k)} Q{f(x + 6 * k)} {f(y + 23 * k)} {f(x + 6 * k)} {f(y + 22 * k)}Z", fill=color))


def usb(x, y, w, h, name, color=ACCENT):
    """A USB stick: the visual for 'a volume'."""
    cw = h * 0.55
    return (rect(x, y + (h - cw) / 2, h * 0.5, cw, 4, fill=LINE)
            + rect(x + h * 0.12, y + h / 2 - cw * 0.28, h * 0.12, cw * 0.18, 1, fill=WHITE)
            + rect(x + h * 0.12, y + h / 2 + cw * 0.1, h * 0.12, cw * 0.18, 1, fill=WHITE)
            + rect(x + h * 0.46, y, w - h * 0.46, h, h * 0.22, fill=color)
            + circle(x + w - h * 0.32, y + h / 2, h * 0.1, fill=WHITE, opacity=0.6)
            + text(x + h * 0.46 + (w - h * 0.46 - h * 0.3) / 2, y + h / 2 + h * 0.16, name, round(h * 0.42), 800, WHITE, "middle"))


def gauge(cx, cy, r, frac, color=ACCENT):
    """A meter: grey track, accent value arc, needle."""
    def pt(a, rr):
        return cx + rr * math.cos(a), cy - rr * math.sin(a)
    a1 = math.pi * (1 - frac)
    sx, sy = pt(math.pi, r)
    ex, ey = pt(0, r)
    vx, vy = pt(a1, r)
    out = [path(f"M{f(round(sx, 2))} {f(round(sy, 2))} A{r} {r} 0 0 1 {f(round(ex, 2))} {f(round(ey, 2))}", fill="none",
                stroke=HAIR, stroke_width=22, stroke_linecap="round"),
           path(f"M{f(round(sx, 2))} {f(round(sy, 2))} A{r} {r} 0 0 1 {f(round(vx, 2))} {f(round(vy, 2))}", fill="none",
                stroke=color, stroke_width=22, stroke_linecap="round")]
    for i in range(11):
        a = math.pi * i / 10
        p1, p2 = pt(a, r - 22), pt(a, r - 30 if i % 5 else r - 36)
        out.append(line(round(p1[0], 2), round(p1[1], 2), round(p2[0], 2), round(p2[1], 2), stroke=FAINT, stroke_width=2))
    nx, ny = pt(a1, r - 44)
    out.append(line(cx, cy, round(nx, 2), round(ny, 2), stroke=INK, stroke_width=6, stroke_linecap="round"))
    out.append(circle(cx, cy, 12, fill=INK))
    return "".join(out)


def cmd_chip(cx, cy, s, size=20, fill=ACCENT, color=WHITE, pad=28):
    w = text_width(s, size, 600) + pad
    return rect(cx - w / 2, cy - 18, w, 36, 18, fill=fill) + text(cx, cy + size * 0.36, s, size, 600, color, "middle"), w


def zone_chip(x0, x1, y, name, cap):
    nw = text_width(name, 17, 800, 2)
    cw = text_width(cap, 18, 400)
    tx = x0 + (x1 - x0 - (nw + 12 + cw)) / 2
    return (rect(x0, y, x1 - x0, 40, R_CHIP, fill=SOFT) + text(tx, y + 26, name, 17, 800, TEXT, spacing=2)
            + text(tx + nw + 12, y + 26, cap, 18, 400, CAP))


# ---------------------------------------------------------------------------
# 1. "It works on my machine"
# ---------------------------------------------------------------------------
def slide_1():
    out = [frame(1, "“It works on my machine”",
                 "Same code, different computer, different result. A container ships the code with what it needs.")]
    rows = [(216, False), (520, True)]
    for top, boxed in rows:
        out.append(rect(X0, top, X1 - X0, 264, R_CARD, fill=WASH))
        head = "With a container" if boxed else "Without containers"
        cap1 = "you ship the app" if boxed else "you copy only"
        cap2 = "and its runtime" if boxed else "your code"
        out.append(text(X0 + 32, top + 112, head, 28, 800, INK))
        out.append(text(X0 + 32, top + 148, cap1, 21, 400, CAP))
        out.append(text(X0 + 32, top + 176, cap2, 21, 400, CAP))
        # laptop
        lap, (sx, sy, sw, sh) = laptop_frame(424, top + 40, 280, 168)
        out.append(lap)
        out.append(text(564, top + 252, "your laptop", 20, 700, TEXT, "middle"))
        # server
        srv, (vx, vy, vw, vh) = server_frame(944, top + 32, 272, 196, "the server")
        out.append(srv)
        if boxed:
            for bx, by in ((sx + (sw - 200) / 2, sy + (sh - 104) / 2), (vx + (vw - 200) / 2, vy + (vh - 104) / 2)):
                out.append(box(bx, by, 200, 104))
                out.append(plate(bx + 14, by + 22, 172, 60, []))
                out.append(bug_ic(bx + 26, by + 34, 36))
                out.append(node_ic(bx + 80, by + 38, 30))
                out.append(libs_ic(bx + 130, by + 37, 32))
        else:
            for (bx, by, bw), ver in (((sx + 14, sy + 14, sw - 28), "Node 24"), ((vx + 14, vy + 4, vw - 28), "Node 20")):
                out.append(rect(bx, by, bw, 50, R_CHIP, fill=SOFT))
                out.append(bug_ic(bx + 12, by + 7, 36))
                out.append(text(bx + 58, by + 32, "your app", 20, 600, INK))
                out.append(rect(bx, by + 60, bw, 50, R_CHIP, fill=SOFT))
                out.append(node_ic(bx + 16, by + 70, 30))
                out.append(text(bx + 58, by + 92, ver, 20, 700, INK))
        out.append(ok_badge(sx + sw - 6, sy + 4, 20))
        # arrow + verb
        st = "new" if boxed else "normal"
        out.append(arrow([(728, top + 128), (920, top + 128)], st))
        out.append(label(824, top + 112, "ship the box" if boxed else "copy the code", st, size=20))
        # verdict
        vxr = 1260
        if boxed:
            out.append(ok_badge(vx + vw + 6, vy - 48, 20))
            out.append(ok_badge(vxr + 22, top + 104, 22))
            out.append(text(vxr + 56, top + 113, "Same result", 28, 800, INK))
            out.append(text(vxr, top + 152, "the box brings Node 24", 21, 400, CAP))
            out.append(text(vxr, top + 180, "and every library", 21, 400, CAP))
        else:
            out.append(bad_badge(vx + vw + 6, vy - 48, 20))
            out.append(bad_badge(vxr + 22, top + 104, 22))
            out.append(text(vxr + 56, top + 113, "Crashes", 28, 800, INK))
            out.append(text(vxr, top + 152, "the app needs Node 24,", 21, 400, CAP))
            out.append(text(vxr, top + 180, "the server has Node 20", 21, 400, CAP))
    return out, ("It works on my machine: copying only the code to a server with Node 20 crashes an app built for Node 24; "
                 "shipping a container that holds the app with Node 24 and its libraries gives the same result everywhere.")


# ---------------------------------------------------------------------------
# 2. What is a container?
# ---------------------------------------------------------------------------
def slide_2():
    out = [frame(2, "A container is a standard box",
                 "Your app and everything it needs, packed once. The same box runs the same way everywhere.")]
    bx, by, bw, bh = X0, 216, 700, 456
    out.append(box(bx, by, bw, bh, open_=True))
    cells = [(lambda x, y: ic_bug(x, y, 52), "Your code", "the app itself"),
             (lambda x, y: logo("nodedotjs", x + 4, y + 4, 44), "Runtime", "Node.js 24"),
             (lambda x, y: ic_layers(x, y + 2, 50, CAP), "Libraries", "node_modules"),
             (lambda x, y: ic_gear(x + 3, y + 3, 46, CAP), "Settings", "env vars, ports")]
    cw, ch = (bw - 36 - 48 - 24) / 2, (bh - 52 - 48 - 24) / 2
    for i, (ic, t1, t2) in enumerate(cells):
        cx = bx + 18 + 24 + (i % 2) * (cw + 24)
        cy = by + 26 + 24 + (i // 2) * (ch + 24)
        out.append(card(cx, cy, cw, ch, "normal"))
        out.append(ic(cx + 24, cy + (ch - 52) / 2))
        out.append(text(cx + 96, cy + ch / 2 - 6, t1, 26, 800, INK))
        out.append(text(cx + 96, cy + ch / 2 + 26, t2, 20, 400, CAP))
    out.append(logo("docker", X0, 708, 40))
    out.append(text(X0 + 54, 736, "Docker packs, ships and runs these boxes.", 22, 600, TEXT))
    # destinations
    dests = [(lambda x, y: ic_laptop(x, y + 6, 56, INK), "Your laptop", "Linux, macOS, Windows"),
             (lambda x, y: logo("googlecloud", x + 4, y + 4, 48), "A cloud VM", "our Debian 13 server"),
             (lambda x, y: ic_server(x + 6, y + 6, 44, 46, INK), "Any Linux server", "a classmate's, a CI runner")]
    dx = 1048
    for i, (ic, t1, t2) in enumerate(dests):
        y = 236 + i * 152
        out.append(card(dx, y, X1 - dx, 120, "normal"))
        out.append(ic(dx + 22, y + 32))
        out.append(text(dx + 98, y + 54, t1, 24, 800, INK))
        out.append(text(dx + 98, y + 86, t2, 20, 400, CAP))
        out.append(ok_badge(X1 - 36, y + 60, 18))
        out.append(arrow([(bx + bw, by + bh / 2), (dx, y + 60)], "normal"))
    out.append(label(908, 484, "same box", "normal", size=20))
    return out, ("A container is a standard box holding your code, the Node.js 24 runtime, the libraries and the settings; "
                 "Docker packs it once and the same box runs on your laptop, a cloud VM or any Linux server.")


# ---------------------------------------------------------------------------
# 3. Virtual machines vs containers
# ---------------------------------------------------------------------------
def slide_3():
    out = [frame(3, "Virtual machines vs containers",
                 "A VM is a house with its own OS and kernel. Containers are apartments sharing one kernel.")]
    # left: houses
    lx0, lx1 = X0, 760
    out.append(text(lx0, 236, "Virtual machines", 28, 800, INK))
    out.append(text(lx0 + text_width("Virtual machines", 28, 800) + 12, 236, "= houses", 28, 400, CAP))
    hw, gap = 200, 24
    for i in range(3):
        x = lx0 + 16 + i * (hw + gap)
        out.append(path(f"M{x - 8} 332 L{x + hw / 2} 268 L{x + hw + 8} 332Z", fill=LINE))
        out.append(card(x, 328, hw, 248, "normal", r=10))
        layers = [("App", SOFT, INK), ("Libraries", SOFT, INK), ("Guest OS", SOFT, INK), ("Own kernel", ACCENT, WHITE)]
        for j, (name, fill, col) in enumerate(layers):
            out.append(chip(x + 14, 342 + j * 56, hw - 28, 46, name, 19, 700, fill, col))
    out.append(chip(lx0 + 8, 592, 688, 44, "Hypervisor", 20, 700, SOFT, TEXT))
    out.append(chip(lx0 + 8, 644, 688, 44, "Hardware", 20, 700, HAIR, TEXT))
    # right: apartment block
    rx0 = 840
    out.append(text(rx0, 236, "Containers", 28, 800, INK))
    out.append(text(rx0 + text_width("Containers", 28, 800) + 12, 236, "= apartments", 28, 400, CAP))
    bx, bw = rx0 + 140, 420
    out.append(rect(bx - 8, 268, bw + 16, 16, 4, fill=LINE))
    out.append(card(bx, 280, bw, 248, "normal", r=10))
    apps = ["nginx", "vite", "nodedotjs", "postgresql", "alpinelinux", "debian"]
    uw, uh = (bw - 4 * 16) / 3, (248 - 3 * 16) / 2
    for k, slug in enumerate(apps):
        ux = bx + 16 + (k % 3) * (uw + 16)
        uy = 296 + (k // 3) * (uh + 16)
        out.append(box(ux, uy, uw, uh, color=SOFT))
        out.append(rect(ux + uw / 2 - 30, uy + uh / 2 - 30, 60, 60, 12, fill=WHITE))
        out.append(logo(slug, ux + uw / 2 - 20, uy + uh / 2 - 20, 40))
    out.append(chip(rx0 + 8, 540, 672, 44, "", 20, 700, SOFT, TEXT))
    out.append(logo("docker", rx0 + 8 + 336 - 70, 548, 28))
    out.append(text(rx0 + 8 + 336 - 34, 569, "Docker", 20, 700, TEXT))
    out.append(rect(rx0 + 8, 592, 672, 44, R_CHIP, fill=ACCENT))
    out.append(logo("linux", rx0 + 8 + 336 - 134, 598, 30, color=WHITE))
    out.append(text(rx0 + 8 + 336 - 96, 621, "One shared kernel (the host's)", 20, 700, WHITE))
    out.append(chip(rx0 + 8, 644, 672, 44, "Hardware", 20, 700, HAIR, TEXT))
    # the numbers
    stats = [(lx0 + 8, "GBs", "each VM carries a whole OS"), (lx0 + 360, "Minutes", "to boot an OS"),
             (rx0 + 8, "MBs", "alpine image: 8 MB"), (rx0 + 352, "< 1 second", "to start")]
    for x, big, small in stats:
        out.append(text(x, 744, big, 34, 800, INK))
        out.append(text(x, 776, small, 20, 400, CAP))
    out.append(line(800, 220, 800, 790, stroke=HAIR, stroke_width=2))
    return out, ("Virtual machines are houses: each brings its own guest OS and kernel on a hypervisor, weighs GBs and boots in minutes. "
                 "Containers are apartments: they share the host's one kernel through Docker, weigh MBs and start in under a second.")


# ---------------------------------------------------------------------------
# 4. Image vs container
# ---------------------------------------------------------------------------
LAYERS = [("start command", "node src/server.js"), ("our code", "src/"),
          ("libraries", "node_modules"), ("base", "Alpine Linux + Node.js 24")]


def slide_4():
    out = [frame(4, "Image vs container",
                 "The image is the recipe: read-only layers. Each container is one cake baked from it.")]
    ix, iw = X0, 540
    out.append(text(ix, 238, "Image", 30, 800, INK))
    out.append(ic_lock(ix + 108, 214, 26, CAP))
    out.append(text(ix + 142, 238, "read-only", 21, 400, CAP))
    out.append(text(ix + iw, 238, "bugsquash-backend", 21, 700, TEXT, "end"))
    for j, (name, val) in enumerate(LAYERS):
        y = 264 + j * 84
        out.append(card(ix, y, iw, 72, "normal", r=12, fill=SOFT if j < 3 else WASH))
        out.append(text(ix + 24, y + 45, name, 22, 800, INK))
        out.append(text(ix + iw - 24, y + 45, val, 21, 400, CAP, "end"))
        if j == 3:
            out.append(logo("alpinelinux", ix + 150, y + 22, 28))
            out.append(logo("nodedotjs", ix + 186, y + 22, 28))
    out.append(text(ix, 632, "Built once, never changed.", 21, 600, TEXT))
    out.append(text(ix, 662, "Run it again and again.", 21, 400, CAP))
    # fan out to three containers
    cx0, cw, chh = 1000, X1 - 1000, 140
    ys = [232, 404, 576]
    out.append(arrow([(ix + iw, 432), (cx0 - 4, 432)], "new"))
    for y in (ys[0], ys[2]):
        out.append(arrow([(ix + iw, 432), (cx0 - 120, 432), (cx0 - 120, y + chh / 2), (cx0 - 4, y + chh / 2)], "new"))
    chip_svg, _ = cmd_chip(720, 400, "docker run")
    out.append(chip_svg)
    for i, y in enumerate(ys):
        out.append(card(cx0, y, cw, chh, "normal"))
        sx = cx0 + 20
        out.append(rect(sx, y + 18, 150, 30, 7, fill=ACCENT))
        out.append(text(sx + 75, y + 39, "writable", 17, 700, WHITE, "middle"))
        for j in range(4):
            out.append(rect(sx, y + 54 + j * 18, 150, 14, 4, fill=LINE if j < 3 else HAIR))
        out.append(text(sx + 180, y + 60, f"container {i + 1}", 24, 800, INK))
        out.append(circle(sx + 188, y + 92, 7, fill=INK))
        out.append(text(sx + 204, y + 99, "running", 20, 400, CAP))
    out.append(text(cx0, 752, "Each adds a thin writable layer.", 21, 600, TEXT))
    out.append(text(cx0, 782, "Remove it and only that layer goes.", 21, 400, CAP))
    return out, ("Image versus container: the bugsquash-backend image is four read-only layers (base Alpine Linux with Node.js 24, "
                 "node_modules, our src code, the start command); docker run creates many containers from it, each adding a thin writable layer.")


# ---------------------------------------------------------------------------
# 5. Build, ship, run
# ---------------------------------------------------------------------------
def slide_5():
    out = [frame(5, "Build, ship, run",
                 "Four commands take our backend from source code to a running container.")]
    nw = 176
    gap = (X1 - X0 - 5 * nw) / 4
    xs = [X0 + i * (nw + gap) for i in range(5)]
    out.append(zone_chip(xs[0], xs[1] + nw, 216, "BUILD", "laptop or CI"))
    out.append(zone_chip(xs[2], xs[2] + nw, 216, "SHIP", "registry"))
    out.append(zone_chip(xs[3], xs[4] + nw, 216, "RUN", "the VM"))
    ny, nh = 296, 248
    nodes = [
        (lambda x, y: ic_doc(x + 4, y, 52, 64, INK), "Dockerfile", ["the recipe,", "in app/backend/"]),
        (lambda x, y: ic_layers(x, y + 4, 60, INK), "Image", ["bugsquash-backend", "tag sha-<commit>"]),
        (lambda x, y: logo("docker", x, y + 4, 60), "Docker Hub", ["alhuraibisaeed/", "bugsquash-backend"]),
        (lambda x, y: ic_layers(x, y + 4, 60, INK), "Image", ["the same image,", "now on the VM"]),
        (lambda x, y: box(x - 22, y + 4, 104, 60), "Container", ["the backend,", "running"]),
    ]
    for x, (ic, t, caps) in zip(xs, nodes):
        out.append(card(x, ny, nw, nh, "normal"))
        out.append(ic(x + nw / 2 - 30, ny + 28))
        out.append(text(x + nw / 2, ny + 136, t, 24, 800, INK, "middle"))
        for k, c in enumerate(caps):
            out.append(text(x + nw / 2, ny + 172 + k * 26, c, 17, 400, CAP, "middle"))
            check_fit("node", c, 17, 400, nw - 8)
    cmds = ["docker build", "docker push", "docker pull", "docker run"]
    for i, c in enumerate(cmds):
        a, b = xs[i] + nw, xs[i + 1]
        out.append(arrow([(a, ny + nh / 2 + 24), (b, ny + nh / 2 + 24)], "new"))
        chip_svg, w = cmd_chip((a + b) / 2, ny + nh / 2 - 22, c, 17, pad=22)
        out.append(chip_svg)
        check_fit("cmd", c, 17, 600, gap - 30)
    # who does what in this course
    py = 600
    out.append(rect(X0, py, X1 - X0, 168, R_CARD, fill=WASH))
    out.append(text(X0 + 32, py + 44, "In this course", 22, 800, INK))
    out.append(logo("githubactions", X0 + 32, py + 76, 40))
    out.append(text(X0 + 88, py + 96, "GitHub Actions runs build + push", 22, 700, INK))
    out.append(text(X0 + 88, py + 128, "on every merge into main (Stage 4)", 20, 400, CAP))
    out.append(logo("googlecloud", 840, py + 76, 40))
    out.append(text(896, py + 96, "The VM runs pull + run", 22, 700, INK))
    out.append(text(896, py + 128, "through docker compose (Stage 1 on)", 20, 400, CAP))
    return out, ("Build, ship, run: a Dockerfile becomes the bugsquash-backend image with docker build, docker push uploads it to "
                 "Docker Hub as alhuraibisaeed/bugsquash-backend, the VM fetches it with docker pull and starts it with docker run. "
                 "In this course GitHub Actions builds and pushes; the VM pulls and runs through docker compose.")


# ---------------------------------------------------------------------------
# 6. Walls and meters
# ---------------------------------------------------------------------------
def slide_6():
    out = [frame(6, "Walls and meters",
                 "Two Linux kernel features turn an ordinary program into a container.")]
    # walls
    out.append(text(X0, 238, "Namespaces = walls", 32, 800, INK))
    out.append(text(X0, 274, "what a container can", 22, 400, CAP))
    out.append(text(X0 + text_width("what a container can ", 22, 400), 274, "see", 22, 800, ACCENT_TEXT))
    rx, ry, rw, rh = X0 + 16, 304, 640, 476
    out.append(rect(rx, ry, rw, rh, 30, fill=WASH, stroke=INK, stroke_width=14))
    bxw, bxh = 220, 112
    bx, by = rx + (rw - bxw) / 2, ry + (rh - bxh) / 2
    out.append(box(bx, by, bxw, bxh))
    out.append(rect(bx + 18, by + 26, bxw - 36, bxh - 52, 8, fill=WHITE))
    out.append(logo("nodedotjs", bx + 32, by + 41, 30))
    out.append(text(bx + 72, by + 64, "backend", 22, 800, INK))
    items = [(ic_list, "own processes"), (ic_globe, "own network"), (ic_folder, "own files"), (ic_tag, "own hostname")]
    for k, (ic, s) in enumerate(items):
        cx = rx + 36 + (k % 2) * (rw / 2 - 18)
        cy = ry + 36 + (k // 2) * (rh - 72 - 56)
        w = rw / 2 - 54
        out.append(card(cx, cy, w, 56, "normal", r=R_CHIP))
        out.append(ic(cx + 16, cy + 14, 28, INK))
        out.append(text(cx + 56, cy + 36, s, 21, 700, INK))
    # meters
    mx = 860
    out.append(line(800, 220, 800, 790, stroke=HAIR, stroke_width=2))
    out.append(text(mx, 238, "cgroups = meters", 32, 800, INK))
    out.append(text(mx, 274, "what a container can", 22, 400, CAP))
    out.append(text(mx + text_width("what a container can ", 22, 400), 274, "use", 22, 800, ACCENT_TEXT))
    for cxg, frac, big, small in ((1030, 0.25, "0.5 CPU", "of the VM's 2 CPUs"), (1350, 256 / 4096, "256 MB", "of the VM's 4 GB")):
        out.append(gauge(cxg, 500, 130, frac))
        out.append(text(cxg, 576, big, 34, 800, INK, "middle"))
        out.append(text(cxg, 608, small, 20, 400, CAP, "middle"))
    out.append(card(mx, 664, X1 - mx, 112, "normal"))
    out.append(ic_warn(mx + 24, 700, 34, INK))
    out.append(text(mx + 78, 712, "Over the memory meter?", 22, 800, INK))
    out.append(text(mx + 78, 744, "The kernel stops that container, not the VM.", 20, 400, CAP))
    return out, ("Walls and meters: namespaces are the walls that give the backend container its own processes, network, files and "
                 "hostname (what it can see); cgroups are the meters that cap it at 0.5 CPU and 256 MB of memory (what it can use).")


# ---------------------------------------------------------------------------
# 7. Proof: one kernel
# ---------------------------------------------------------------------------
KERNEL = "6.12.111+deb13-cloud-amd64"
RUNS = [("uname -a", "devops", "GNU/Linux", "the VM itself"),
        ("docker run --rm debian uname -a", "50a2473665c5", "GNU/Linux", "a Debian container"),
        ("docker run --rm alpine uname -a", "47dc50dac49b", "Linux", "an Alpine container")]


def slide_7():
    out = [frame(7, "One kernel, many containers",
                 "Captured on our course VM: three different systems answer with the very same kernel.")]
    tx, ty, tw, th = X0, 204, X1 - X0, 340
    out.append(rect(tx, ty, tw, th, 16, fill=INK))
    for i in range(3):
        out.append(circle(tx + 26 + i * 20, ty + 22, 6, fill="#4B5563"))
    out.append(text(tx + tw / 2, ty + 28, "you@devops: the course VM (Debian 13)", 17, 600, FAINT, "middle"))
    size, lh = 22, 47
    cwid = size * 0.6
    y = ty + 82
    for cmd, host, tail, who in RUNS:
        out.append(mono(tx + 32, y, "$ " + cmd, size, "#D1D5DB"))
        out.append(text(X1 - 32, y, who, 20, 700, "#F9FAFB", "end"))
        y += lh - 10
        x = tx + 32
        hc, kc = 6, 6 + len(host) + 1           # columns where hostname and kernel start
        out.append(rect(x + hc * cwid - 4, y - 22, len(host) * cwid + 8, 30, 6, fill="#4B5563"))
        out.append(rect(x + kc * cwid - 4, y - 22, len(KERNEL) * cwid + 8, 30, 6, fill=ACCENT))
        out.append(mono(x, y, "Linux", size, WHITE))
        out.append(mono(x + hc * cwid, y, host, size, WHITE, weight=700))
        out.append(mono(x + kc * cwid, y, KERNEL, size, WHITE, weight=700))
        out.append(mono(x + (kc + len(KERNEL) + 1) * cwid, y, "… x86_64 " + tail, size, WHITE))
        y += lh + 8
    # three systems standing on one kernel
    cards = [(["debian"], "The VM", "named devops", "Debian 13"),
             (["docker", "debian"], "debian container", "named 50a2473665c5", "Debian 13"),
             (["docker", "alpinelinux"], "alpine container", "named 47dc50dac49b", "Alpine Linux")]
    cw = (tw - 2 * 32) / 3
    for i, (slugs, t, host, os_) in enumerate(cards):
        x = tx + i * (cw + 32)
        out.append(card(x, 572, cw, 128, "normal"))
        for k, s in enumerate(slugs):
            out.append(logo(s, x + 20 + k * 40, 590, 32))
        out.append(text(x + 20 + len(slugs) * 40 + 4, 616, t, 23, 800, INK))
        out.append(text(x + 20, 652, os_, 21, 700, TEXT))
        out.append(text(x + 20, 682, host, 19, 400, CAP))
        out.append(rect(x + cw / 2 - 3, 700, 6, 20, 0, fill=ACCENT))
    out.append(rect(tx, 720, tw, 64, 14, fill=ACCENT))
    out.append(logo("linux", tx + 24, 734, 36, color=WHITE))
    out.append(text(tx + 74, 761, "One Linux kernel for all three: " + KERNEL, 24, 800, WHITE))
    out.append(text(X1 - 24, 761, "the VM's own", 20, 400, WHITE, "end"))
    return out, ("Proof captured on the course VM: uname -a on the VM (hostname devops, Debian 13), in a Debian container "
                 "(hostname 50a2473665c5) and in an Alpine container (hostname 47dc50dac49b) all report the same kernel, "
                 "6.12.111+deb13-cloud-amd64: three systems, one shared kernel.")


# ---------------------------------------------------------------------------
# 8. Data lives in volumes
# ---------------------------------------------------------------------------
def slide_8():
    out = [frame(8, "Data lives in volumes",
                 "Containers are disposable. A volume keeps the data when its container is replaced.")]
    old, new = (X0, 232, 300, 144), (X0 + 540, 232, 300, 144)
    for (x, y, w, h), tag, img, alive in ((old, "old", "postgres:17.10", False), (new, "new", "postgres:17.11", True)):
        body = [card(x, y, w, h, "normal"), logo("postgresql", x + 20, y + 24, 44),
                text(x + 80, y + 52, "db container", 24, 800, INK),
                text(x + 80, y + 82, img, 20, 400, CAP)]
        if alive:
            body += [circle(x + 88, y + 114, 7, fill=INK), text(x + 104, y + 121, "running", 20, 600, TEXT)]
        else:
            body += [ic_trash(x + 78, y + 100, 26, GREY), text(x + 112, y + 121, "removed", 20, 600, GREY)]
        out.append(group(body, None if alive else 0.55))
    out.append(arrow([(old[0] + old[2] + 16, 304), (new[0] - 16, 304)], "normal"))
    out.append(label((old[0] + old[2] + new[0]) / 2, 290, "replace", "normal", size=20))
    # both containers plug into the same stick
    ux, uy, uw, uh = X0 + 210, 520, 420, 96
    for (x, y, w, h), alive, px in ((old, False, ux + 150), (new, True, ux + uw - 110)):
        cx = x + w / 2
        col = INK if alive else FAINT
        d = (f"M{cx} {y + h} V{uy - 64} Q{cx} {uy - 44} {cx + (20 if px > cx else -20)} {uy - 44} "
             f"H{px + (-20 if px > cx else 20)} Q{px} {uy - 44} {px} {uy - 24} V{uy}")
        out.append(group([path(d, fill="none", stroke=col, stroke_width=4, stroke_linecap="round", stroke_linejoin="round"),
                          circle(cx, y + h, 6, fill=col), rect(px - 10, uy - 10, 20, 10, 3, fill=col)], None if alive else 0.7))
    out.append(usb(ux, uy, uw, uh, "pgdata"))
    out.append(text(ux + uw / 2 + 20, uy + 136, "players and scores survive", 22, 700, INK, "middle"))
    # also on our VM
    rx = 1040
    out.append(line(1000, 220, 1000, 790, stroke=HAIR, stroke_width=2))
    out.append(text(rx, 248, "Also on our VM", 24, 800, INK))
    out.append(usb(rx, 280, 360, 76, "letsencrypt"))
    out.append(logo("letsencrypt", rx, 384, 30))
    out.append(text(rx + 42, 406, "the HTTPS certificate", 21, 600, TEXT))
    out.append(text(rx, 438, "survives a new proxy too", 20, 400, CAP))
    # the one rule
    for i, (cmd, ok, what) in enumerate((("docker compose down", True, "keeps the volumes"),
                                         ("docker compose down -v", False, "deletes them: never on the server"))):
        y = 528 + i * 120
        out.append(card(rx, y, X1 - rx, 96, "normal"))
        out.append((ok_badge if ok else bad_badge)(rx + 34, y + 48, 18))
        out.append(mono(rx + 66, y + 42, cmd, 21, INK, weight=700))
        out.append(text(rx + 66, y + 74, what, 20, 400, CAP))
    return out, ("Data lives in volumes: when the db container is replaced (postgres 17.10 to 17.11) the new one plugs into the "
                 "same pgdata volume, so players and scores survive; the letsencrypt volume keeps the HTTPS certificate. "
                 "docker compose down keeps volumes, docker compose down -v deletes them.")


# ---------------------------------------------------------------------------
# 9. Docker Compose
# ---------------------------------------------------------------------------
YAML = ["services:", "  proxy:    nginx", "  frontend: bugsquash-frontend", "  backend:  bugsquash-backend",
        "  db:       postgres", "  certbot:  certbot", "networks:   edge, data", "volumes:    pgdata, letsencrypt"]


def slide_9():
    out = [frame(9, "Many containers, one file",
                 "Docker Compose reads one YAML file and starts our whole stack with one command.")]
    fx, fy, fw, fh = X0, 216, 424, 560
    out.append(card(fx, fy, fw, fh, "normal"))
    out.append(ic_doc(fx + 24, fy + 22, 34, 42, INK, 2))
    out.append(text(fx + 72, fy + 52, "docker-compose.prod.yml", 21, 800, INK))
    check_fit("yaml title", "docker-compose.prod.yml", 21, 800, fw - 72 - 16)
    out.append(rect(fx + 16, fy + 84, fw - 32, fh - 100, 10, fill=WASH))
    for i, ln in enumerate(YAML):
        key_col = INK if not ln.startswith("  ") else TEXT
        out.append(mono(fx + 34, fy + 136 + i * 50, ln, 18.5, key_col, weight=700 if not ln.startswith("  ") else 400))
        if mono_w(ln, 18.5) > fw - 66:
            FIT_PROBLEMS.append(f"yaml line too long: {ln}")
    # the command
    ax0, ax1 = fx + fw, 776
    out.append(arrow([(ax0 + 8, 348), (ax1 - 8, 348)], "new"))
    chip_svg, w = cmd_chip((ax0 + ax1) / 2, 300, "docker compose up -d", 19)
    out.append(chip_svg)
    if w > ax1 - ax0 - 12:
        FIT_PROBLEMS.append("compose chip too wide")
    # the running stack, wired to two networks
    sx = 776
    out.append(logo("docker", sx, 214, 34))
    out.append(text(sx + 46, 240, "Running on the VM", 24, 800, INK))
    out.append(text(X1, 240, "5 containers · 2 networks · 2 volumes", 20, 400, CAP, "end"))
    cw, gap = 170, (X1 - sx - 4 * 170) / 3
    names = [("nginx", "proxy", ":80 :443"), ("vite", "frontend", ""), ("cert", "certbot", "letsencrypt"),
             ("nodedotjs", "backend", "")]
    cy, ch = 280, 136
    xs = []
    for i, (slug, name, extra) in enumerate(names):
        x = sx + i * (cw + gap)
        xs.append(x)
        out.append(card(x, cy, cw, ch, "normal"))
        if slug == "cert":
            out.append(ic_cert(x + cw / 2 - 20, cy + 16, 40, INK))
        else:
            out.append(logo(slug, x + cw / 2 - 20, cy + 16, 40))
        out.append(text(x + cw / 2, cy + 86, name, 22, 800, INK, "middle"))
        if extra.startswith(":"):
            for k, p in enumerate(extra.split()):
                out.append(chip(x + cw / 2 - 66 + k * 70, cy + 98, 62, 28, p, 16, 800, INK, WHITE, 8))
        elif extra:
            out.append(ic_cyl(x + 22, cy + 100, 16, 22, CAP))
            out.append(text(x + 46, cy + 118, extra, 17, 400, CAP))
    # edge network rail
    ey = 488
    out.append(rect(sx, ey - 5, X1 - sx, 10, 5, fill=LINE))
    for x in xs:
        out.append(rect(x + cw / 2 - 3, cy + ch, 6, ey - cy - ch, 0, fill=LINE))
        out.append(circle(x + cw / 2, ey, 9, fill=WHITE, stroke=GREY, stroke_width=3))
    out.append(ic_globe(sx, ey + 22, 26, TEXT))
    out.append(text(sx + 36, ey + 42, "edge network", 21, 800, TEXT))
    out.append(text(sx + 36, ey + 70, "proxy, apps, certbot", 19, 400, CAP))
    # data network rail (private)
    dy = 612
    bxc = xs[3] + cw / 2
    out.append(rect(xs[2], dy - 5, X1 - xs[2], 10, 5, fill=INK))
    out.append(rect(bxc - 3, ey, 6, dy - ey, 0, fill=INK))
    out.append(circle(bxc, dy, 9, fill=WHITE, stroke=INK, stroke_width=3))
    out.append(ic_lock(xs[2] - 196, dy - 15, 26, INK))
    out.append(text(xs[2] - 162, dy + 7, "data, private", 21, 800, INK))
    # db hangs from the private rail
    dbx = xs[3]
    out.append(rect(bxc - 3, dy, 6, 36, 0, fill=INK))
    out.append(card(dbx, dy + 36, cw, 128, "normal"))
    out.append(logo("postgresql", dbx + cw / 2 - 20, dy + 50, 40))
    out.append(text(dbx + cw / 2, dy + 116, "db", 22, 800, INK, "middle"))
    out.append(ic_cyl(dbx + 40, dy + 128, 16, 22, CAP))
    out.append(text(dbx + 64, dy + 146, "pgdata", 17, 400, CAP))
    # the two volumes, named
    vx, vy = sx, 676
    out.append(text(vx, vy, "Volumes", 21, 800, INK))
    for k, (name, what) in enumerate((("pgdata", "the database"), ("letsencrypt", "the certificate"))):
        yy = vy + 22 + k * 40
        out.append(ic_cyl(vx, yy, 18, 24, ACCENT))
        out.append(text(vx + 30, yy + 19, name, 20, 700, INK))
        out.append(text(vx + 30 + text_width(name, 20, 700) + 10, yy + 19, what, 19, 400, CAP))
    return out, ("Docker Compose: docker compose up -d reads docker-compose.prod.yml and starts five containers (proxy with ports "
                 "80 and 443, frontend, certbot, backend, db) on two networks: edge for the proxy, apps and certbot, and the "
                 "private data network that only the backend and db share; volumes pgdata and letsencrypt keep the data.")


# ---------------------------------------------------------------------------
SLIDES = [
    ("containers-01-works-on-my-machine", "1. It works on my machine", slide_1),
    ("containers-02-what-is-a-container", "2. A container is a standard box", slide_2),
    ("containers-03-vms-vs-containers", "3. Virtual machines vs containers", slide_3),
    ("containers-04-image-vs-container", "4. Image vs container", slide_4),
    ("containers-05-build-ship-run", "5. Build, ship, run", slide_5),
    ("containers-06-walls-and-meters", "6. Walls and meters: namespaces and cgroups", slide_6),
    ("containers-07-one-kernel", "7. One kernel, many containers", slide_7),
    ("containers-08-volumes", "8. Data lives in volumes", slide_8),
    ("containers-09-compose", "9. Many containers, one file: Docker Compose", slide_9),
]


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--out", default=OUT_DIR, help="output folder (default: docs/images/slides)")
    args = ap.parse_args()
    load_logos()
    os.makedirs(args.out, exist_ok=True)
    status = 0
    for name, title, fn in SLIDES:
        FIT_PROBLEMS.clear()
        body, desc = fn()
        svg = document(f"Containers and Docker, slide {title}", desc, body, "build_slides.py")
        target = os.path.join(args.out, name + ".svg")
        with open(target, "w", encoding="utf-8") as fh:
            fh.write(svg)
        print(f"wrote {os.path.relpath(target)} ({len(svg.encode()) // 1024} KB)")
        for p in FIT_PROBLEMS:
            print("  warning: text may overflow ->", p)
            status = 1
    return status


if __name__ == "__main__":
    sys.exit(main())
