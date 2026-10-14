"""Shared drawing kit for the generated pictures in docs/images/.

build_diagrams.py (system design) and build_slides.py (the containers lesson) both draw with
these tokens, helpers and icons, so every picture shares one palette, one type scale and one
set of logos. Standard library only.
"""

import json
import os
import re
import sys
from xml.sax.saxutils import escape

HERE = os.path.dirname(os.path.abspath(__file__))
LOGOS_FILE = os.path.join(HERE, "logos.json")

# Simple Icons slugs available to every picture (https://simpleicons.org)
LOGO_SLUGS = [
    "alpinelinux", "ansible", "cloudflare", "debian", "docker", "express", "git", "github",
    "githubactions", "googlecloud", "letsencrypt", "linux", "nginx", "nodedotjs",
    "postgresql", "vite",
]

# ---------------------------------------------------------------------------
# Design tokens
# ---------------------------------------------------------------------------
W, H = 1600, 900
FONT = "system-ui, -apple-system, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif"

INK = "#111827"        # titles, step dots            17.7:1 on white
TEXT = "#374151"       # labels, normal arrows        10.3:1
CAP = "#4B5563"        # captions                      7.6:1
GREY = "#6B7280"       # calm arrows (done)            4.8:1
FAINT = "#9CA3AF"      # faded parts, chevrons
LINE = "#D1D5DB"       # card borders
HAIR = "#E5E7EB"       # light borders
SOFT = "#F3F4F6"       # chips, header pills
WASH = "#F9FAFB"       # zone fills
WHITE = "#FFFFFF"

ACCENT = "#D61F69"     # the one accent: NEW, stage badges (white text 4.9:1)
ACCENT_TEXT = "#BE185D"  # accent text on white (6.0:1)
ACCENT_HALO = "#FCE7F3"  # soft glow behind NEW parts

R_CARD, R_CHIP = 16, 10

# ---------------------------------------------------------------------------
# Text measuring (Helvetica/Arial advance widths, padded for wider system fonts)
# ---------------------------------------------------------------------------
_REG = dict(zip(
    " !\"#$%&'()*+,-./0123456789:;<=>?@ABCDEFGHIJKLMNOPQRSTUVWXYZ[\\]^_`abcdefghijklmnopqrstuvwxyz{|}~",
    [278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278]
    + [556] * 10 + [278, 278, 584, 584, 584, 556, 1015]
    + [667, 667, 722, 722, 667, 611, 778, 722, 278, 500, 667, 556, 833, 722, 778, 667,
       778, 722, 667, 611, 722, 667, 944, 667, 667, 611]
    + [278, 278, 278, 469, 556, 333]
    + [556, 556, 500, 556, 556, 278, 556, 556, 222, 222, 500, 222, 833, 556, 556, 556,
       556, 333, 500, 278, 556, 500, 722, 500, 500, 500]
    + [334, 260, 334, 584]))
_BOLD = dict(zip(
    " !\"#$%&'()*+,-./0123456789:;<=>?@ABCDEFGHIJKLMNOPQRSTUVWXYZ[\\]^_`abcdefghijklmnopqrstuvwxyz{|}~",
    [278, 333, 474, 556, 556, 889, 722, 238, 333, 333, 389, 584, 278, 333, 278, 278]
    + [556] * 10 + [333, 333, 584, 584, 584, 611, 975]
    + [722, 722, 722, 722, 667, 611, 778, 722, 278, 556, 722, 611, 833, 722, 778, 667,
       778, 722, 667, 611, 722, 667, 944, 667, 667, 611]
    + [333, 278, 333, 584, 556, 333]
    + [556, 611, 556, 611, 556, 333, 611, 611, 278, 278, 556, 278, 889, 611, 611, 611,
       611, 389, 556, 333, 611, 556, 778, 556, 556, 500]
    + [389, 280, 389, 584]))
_EXTRA = {"·": 278, "→": 1000, "×": 584, "…": 1000, "’": 222}
FONT_PAD = 1.08   # Noto Sans / DejaVu run wider than Helvetica


def text_width(s, size, weight=400, spacing=0.0):
    table = _BOLD if weight >= 600 else _REG
    units = sum(table.get(c, _EXTRA.get(c, 600)) for c in s)
    return units / 1000.0 * size * FONT_PAD + spacing * max(len(s) - 1, 0)


FIT_PROBLEMS = []


def check_fit(name, s, size, weight, avail):
    need = text_width(s, size, weight)
    if need > avail:
        FIT_PROBLEMS.append(f"{name}: '{s}' needs ~{need:.0f}px, has {avail:.0f}px")


# ---------------------------------------------------------------------------
# SVG primitives
# ---------------------------------------------------------------------------
def f(v):
    """Short number formatting keeps the files small."""
    return f"{v:.2f}".rstrip("0").rstrip(".") if isinstance(v, float) else str(v)


def attrs(**kw):
    out = []
    for k, v in kw.items():
        if v is None:
            continue
        out.append(f'{k.rstrip("_").replace("_", "-")}="{f(v) if isinstance(v, (int, float)) else v}"')
    return " ".join(out)


def rect(x, y, w, h, r=0, **kw):
    return f'<rect {attrs(x=x, y=y, width=w, height=h, rx=r or None, **kw)}/>'


def circle(cx, cy, r, **kw):
    return f'<circle {attrs(cx=cx, cy=cy, r=r, **kw)}/>'


def line(x1, y1, x2, y2, **kw):
    return f'<line {attrs(x1=x1, y1=y1, x2=x2, y2=y2, **kw)}/>'


def path(d, **kw):
    return f'<path {attrs(d=d, **kw)}/>'


def text(x, y, s, size=18, weight=400, fill=INK, anchor="start", spacing=None, halo=False):
    extra = ""
    if halo:
        extra = ' paint-order="stroke" stroke="#FFFFFF" stroke-width="6" stroke-linejoin="round"'
    return (f'<text {attrs(x=x, y=y, font_size=size, font_weight=weight if weight != 400 else None, fill=fill, text_anchor=anchor if anchor != "start" else None, letter_spacing=spacing)}{extra}>'
            f'{escape(s)}</text>')


def group(items, opacity=None):
    body = "".join(items)
    if opacity is None or opacity >= 1:
        return body
    return f'<g opacity="{f(opacity)}">{body}</g>'


# ---------------------------------------------------------------------------
# Logos (Simple Icons, 24x24 view box)
# ---------------------------------------------------------------------------
LOGOS = {}


def logo(slug, x, y, size, st="normal", color=None):
    data = LOGOS[slug]
    fill = FAINT if st == "todo" else (color or "#" + data["hex"])
    return f'<path transform="translate({f(x)} {f(y)}) scale({size / 24:.4f})" fill="{fill}" d="{data["path"]}"/>'


def card_style(st):
    if st == "todo":
        return dict(fill=WHITE, stroke=HAIR, sw=1.5, title=FAINT, cap=FAINT, op=0.6, shadow=False)
    if st == "new":
        return dict(fill=WHITE, stroke=ACCENT, sw=2.5, title=INK, cap=CAP, op=1, shadow=True)
    return dict(fill=WHITE, stroke=LINE, sw=1.5, title=INK, cap=CAP, op=1, shadow=True)


def arrow_style(st):
    return {
        "normal": dict(c=TEXT, w=2.5, lab=INK),
        "done": dict(c=GREY, w=2.5, lab=TEXT),
        "cur": dict(c=GREY, w=2.5, lab=TEXT),
        "new": dict(c=ACCENT, w=3.5, lab=ACCENT_TEXT),
        "todo": dict(c=HAIR, w=2, lab="#C4C8CE"),
    }[st]


# ---------------------------------------------------------------------------
# Building blocks
# ---------------------------------------------------------------------------
def card(x, y, w, h, st, r=R_CARD, fill=None, stroke=None, sw=None):
    s = card_style(st)
    out = []
    if st == "new":
        out.append(rect(x - 8, y - 8, w + 16, h + 16, r + 8, fill=ACCENT_HALO))
    out.append(rect(x, y, w, h, r, fill=fill or s["fill"], stroke=stroke or s["stroke"],
                    stroke_width=sw or s["sw"], filter="url(#shadow)" if s["shadow"] else None))
    return "".join(out)


def chip(x, y, w, h, label, size=17, weight=600, fill=SOFT, color=TEXT, r=R_CHIP):
    return rect(x, y, w, h, r, fill=fill) + text(x + w / 2, y + h / 2 + size * 0.36, label, size, weight, color, "middle")


def new_tag(cx, cy):
    w, h = 60, 26
    return (rect(cx - w / 2, cy - h / 2, w, h, 13, fill=ACCENT, stroke=WHITE, stroke_width=2)
            + text(cx, cy + 5.5, "NEW", 15, 800, WHITE, "middle", spacing=1))


def badge(cx, cy, n, size=32):
    return (rect(cx - size / 2, cy - size / 2, size, size, 8, fill=ACCENT, stroke=WHITE, stroke_width=2.5)
            + text(cx, cy + size * 0.22, str(n), round(size * 0.62), 800, WHITE, "middle"))


def step_dot(cx, cy, n, r=15):
    return (circle(cx, cy, r, fill=INK, stroke=WHITE, stroke_width=3)
            + text(cx, cy + 6, str(n), 17, 800, WHITE, "middle"))


def arrow(pts, st, both=False):
    """Solid polyline with clean triangular heads. pts = [(x, y), ...] in flow order."""
    s = arrow_style(st)
    L, half = 14, 7.5

    def head(tip, prev):
        dx, dy = tip[0] - prev[0], tip[1] - prev[1]
        n = (dx * dx + dy * dy) ** 0.5
        ux, uy = dx / n, dy / n
        bx, by = tip[0] - ux * L, tip[1] - uy * L
        pts_ = [(tip[0], tip[1]), (bx - uy * half, by + ux * half), (bx + uy * half, by - ux * half)]
        return path("M" + " L".join(f"{f(round(a, 2))} {f(round(b, 2))}" for a, b in pts_) + "Z", fill=s["c"]), (tip[0] - ux * (L - 2), tip[1] - uy * (L - 2))

    pts = list(pts)
    out = []
    h_end, pts[-1] = head(pts[-1], pts[-2])
    out.append(h_end)
    if both:
        h_start, pts[0] = head(pts[0], pts[1])
        out.append(h_start)
    d = "M" + " L".join(f"{f(round(x, 2))} {f(round(y, 2))}" for x, y in pts)
    out.insert(0, path(d, fill="none", stroke=s["c"], stroke_width=s["w"], stroke_linecap="round", stroke_linejoin="round"))
    return "".join(out)


def label(x, y, s, st, anchor="middle", size=18, weight=600):
    return text(x, y, s, size, weight, arrow_style(st)["lab"], anchor, halo=True)


# ---------------------------------------------------------------------------
# Drawn icons (simple geometric, single colour)
# ---------------------------------------------------------------------------
def ic_lock(x, y, s, color, hole=WHITE):
    bw, bh = 0.78 * s, 0.56 * s
    bx, by = x + (s - bw) / 2, y + s - bh
    cx = x + s / 2
    r = 0.24 * s
    return (path(f"M{f(cx - r)} {f(by + 1)} V{f(y + 0.36 * s)} A{f(r)} {f(r)} 0 0 1 {f(cx + r)} {f(y + 0.36 * s)} V{f(by + 1)}",
                 fill="none", stroke=color, stroke_width=f(max(1.6, 0.11 * s)))
            + rect(bx, by, bw, bh, 0.12 * s, fill=color)
            + circle(cx, by + bh * 0.45, 0.07 * s, fill=hole))


def ic_warn(x, y, s, color):
    return (path(f"M{f(x + s / 2)} {f(y + 1)} L{f(x + s - 1)} {f(y + s - 1)} H{f(x + 1)} Z", fill=color)
            + rect(x + s / 2 - 1, y + s * 0.35, 2, s * 0.32, 1, fill=WHITE)
            + circle(x + s / 2, y + s * 0.8, 1.2, fill=WHITE))


def ic_cert(x, y, s, color, seal=None):
    k = s / 32.0
    return (rect(x + 2 * k, y + 3 * k, 26 * k, 21 * k, 3 * k, fill=WHITE, stroke=color, stroke_width=2.2 * k)
            + line(x + 7 * k, y + 10 * k, x + 22 * k, y + 10 * k, stroke=color, stroke_width=2 * k, stroke_linecap="round")
            + line(x + 7 * k, y + 15 * k, x + 16 * k, y + 15 * k, stroke=color, stroke_width=2 * k, stroke_linecap="round")
            + path(f"M{f(x + 20 * k)} {f(y + 24 * k)} l-2.5 {f(7 * k)} l{f(4.5 * k)} -2 l{f(4.5 * k)} 2 l-2.5 -{f(7 * k)}Z", fill=seal or color)
            + circle(x + 22.5 * k, y + 21 * k, 5.5 * k, fill=seal or color, stroke=WHITE, stroke_width=1.5 * k))


def ic_safe(x, y, s, color):
    """A small safe: the encrypted Ansible vault."""
    k = s / 24.0
    return (rect(x + 1 * k, y + 2 * k, 22 * k, 18 * k, 3.5 * k, fill=color)
            + circle(x + 10 * k, y + 11 * k, 5 * k, fill=WHITE)
            + circle(x + 10 * k, y + 11 * k, 2 * k, fill=color)
            + rect(x + 17.5 * k, y + 7 * k, 2.5 * k, 8 * k, 1.2 * k, fill=WHITE)
            + rect(x + 4 * k, y + 20 * k, 4 * k, 3 * k, 1 * k, fill=color)
            + rect(x + 16 * k, y + 20 * k, 4 * k, 3 * k, 1 * k, fill=color))


def ic_clock(x, y, s, color):
    c = s / 2
    return (circle(x + c, y + c, c - 1.2, fill="none", stroke=color, stroke_width=2.2)
            + path(f"M{f(x + c)} {f(y + c * 0.45)} V{f(y + c)} L{f(x + c * 1.45)} {f(y + c * 1.25)}",
                   fill="none", stroke=color, stroke_width=2.2, stroke_linecap="round", stroke_linejoin="round"))


def ic_cyl(x, y, w, h, color):
    ry = h * 0.18
    return (path(f"M{f(x)} {f(y + ry)} V{f(y + h - ry)} A{f(w / 2)} {f(ry)} 0 0 0 {f(x + w)} {f(y + h - ry)} V{f(y + ry)}",
                 fill=color)
            + path(f"M{f(x)} {f(y + h * 0.5)} A{f(w / 2)} {f(ry)} 0 0 0 {f(x + w)} {f(y + h * 0.5)}", fill="none", stroke=WHITE, stroke_width=1.4)
            + f'<ellipse {attrs(cx=x + w / 2, cy=y + ry, rx=w / 2, ry=ry, fill=color, stroke=WHITE, stroke_width=1.4)}/>')


def ic_files(x, y, s, color):
    k = s / 32.0
    out = []
    for i, (dx, dy) in enumerate([(0, 6), (6, 3), (12, 0)]):
        px, py = x + dx * k, y + dy * k
        out.append(path(f"M{f(px)} {f(py + 2 * k)} q0 -2 2 -2 h{f(10 * k)} l{f(6 * k)} {f(6 * k)} v{f(16 * k)} q0 2 -2 2 h-{f(14 * k)} q-2 0 -2 -2Z",
                        fill=WHITE, stroke=color, stroke_width=2 * k, stroke_linejoin="round"))
    return "".join(out)


def ic_layers(x, y, s, color):
    k = s / 24.0
    out = []
    for i, dy in enumerate((12, 7, 2)):
        out.append(path(f"M{f(x + 12 * k)} {f(y + dy * k)} L{f(x + 22 * k)} {f(y + (dy + 5) * k)} L{f(x + 12 * k)} {f(y + (dy + 10) * k)} L{f(x + 2 * k)} {f(y + (dy + 5) * k)}Z",
                        fill=color if i == 2 else WHITE, stroke=color, stroke_width=1.8 * k, stroke_linejoin="round"))
    return "".join(out)


def ic_pin(x, y, s, color):
    k = s / 24.0
    return (path(f"M{f(x + 12 * k)} {f(y + 23 * k)} C{f(x + 12 * k)} {f(y + 23 * k)} {f(x + 4 * k)} {f(y + 14 * k)} {f(x + 4 * k)} {f(y + 9 * k)} A{f(8 * k)} {f(8 * k)} 0 0 1 {f(x + 20 * k)} {f(y + 9 * k)} C{f(x + 20 * k)} {f(y + 14 * k)} {f(x + 12 * k)} {f(y + 23 * k)} {f(x + 12 * k)} {f(y + 23 * k)}Z",
                 fill=color)
            + circle(x + 12 * k, y + 9 * k, 3 * k, fill=WHITE))


def ic_person(x, y, s, color):
    k = s / 24.0
    return (circle(x + 12 * k, y + 7 * k, 5 * k, fill=color, stroke=WHITE, stroke_width=1.5)
            + path(f"M{f(x + 2 * k)} {f(y + 24 * k)} C{f(x + 2 * k)} {f(y + 15 * k)} {f(x + 22 * k)} {f(y + 15 * k)} {f(x + 22 * k)} {f(y + 24 * k)}Z",
                   fill=color, stroke=WHITE, stroke_width=1.5))


def ic_door(x, y, w, h, color):
    return (path(f"M{f(x)} {f(y + h)} V{f(y + 4)} Q{f(x)} {f(y)} {f(x + 4)} {f(y)} H{f(x + w - 4)} Q{f(x + w)} {f(y)} {f(x + w)} {f(y + 4)} V{f(y + h)}",
                 fill=color)
            + rect(x + 4, y + 4, w - 8, h - 4, 2, fill=WHITE, opacity=0.25)
            + circle(x + w - 7, y + h * 0.55, 2, fill=WHITE)
            + line(x - 4, y + h, x + w + 4, y + h, stroke=color, stroke_width=2, stroke_linecap="round"))


def ic_bug(x, y, s, body=INK):
    """Bug Squash Arena's hero: a small round bug seen from above."""
    k = s / 48.0
    cx = x + 24 * k
    legs = []
    for side in (-1, 1):
        for i, (yy, dx2, dy2) in enumerate(((22, 13, -6), (29, 15, 0), (36, 13, 6))):
            x1 = cx + side * 9 * k
            legs.append(path(f"M{f(x1)} {f(y + yy * k)} l{f(side * dx2 * k)} {f(dy2 * k)}", fill="none", stroke=body,
                             stroke_width=3 * k, stroke_linecap="round"))
    return ("".join(legs)
            + path(f"M{f(cx - 4 * k)} {f(y + 10 * k)} q-3 -6 -8 -7 M{f(cx + 4 * k)} {f(y + 10 * k)} q3 -6 8 -7".replace("q-3 -6 -8 -7", f"q{f(-3 * k)} {f(-6 * k)} {f(-8 * k)} {f(-7 * k)}").replace("q3 -6 8 -7", f"q{f(3 * k)} {f(-6 * k)} {f(8 * k)} {f(-7 * k)}"),
                   fill="none", stroke=body, stroke_width=2.6 * k, stroke_linecap="round")
            + circle(cx, y + 14 * k, 7 * k, fill=body)
            + f'<ellipse {attrs(cx=cx, cy=y + 30 * k, rx=13 * k, ry=15 * k, fill=body)}/>'
            + line(cx, y + 17 * k, cx, y + 44 * k, stroke=WHITE, stroke_width=1.8 * k, opacity=0.8)
            + circle(cx - 5 * k, y + 26 * k, 2.6 * k, fill=WHITE, opacity=0.85)
            + circle(cx + 5 * k, y + 33 * k, 2.2 * k, fill=WHITE, opacity=0.85))


def ic_chevron(cx, cy, color, s=10):
    return path(f"M{f(cx - s * 0.4)} {f(cy - s)} L{f(cx + s * 0.6)} {f(cy)} L{f(cx - s * 0.4)} {f(cy + s)}",
                fill="none", stroke=color, stroke_width=3, stroke_linecap="round", stroke_linejoin="round")




def credits(generator):
    """The comment every generated SVG carries: who made it, and whose logos these are."""
    return (f"<!-- Generated by docs/images/src/{generator} - edit the script, not this file. "
            "Logos from Simple Icons (simpleicons.org); trademarks of their owners, used only to identify the "
            "technologies. Git Logo by Jason Long, CC BY 3.0. Debian logo (c) Software in the Public Interest, "
            "CC BY-SA 3.0. Let's Encrypt logo (c) ISRG, CC BY-NC 4.0. -->")


def document(title, desc, body, generator):
    """Wrap drawn parts into one 1600x900 SVG with a white background, title, description and credits."""
    head = (f'<svg xmlns="http://www.w3.org/2000/svg" width="{W}" height="{H}" viewBox="0 0 {W} {H}" '
            f'role="img" aria-labelledby="t d" font-family="{FONT}">'
            f'<title id="t">{escape(title)}</title><desc id="d">{escape(desc)}</desc>'
            '<defs><filter id="shadow" x="-10%" y="-10%" width="120%" height="130%" color-interpolation-filters="sRGB">'
            '<feDropShadow dx="0" dy="2" stdDeviation="3" flood-color="#111827" flood-opacity="0.08"/></filter></defs>'
            f'<rect width="{W}" height="{H}" fill="#FFFFFF"/>')
    return head + credits(generator) + "".join(body) + "</svg>\n"


def load_logos():
    with open(LOGOS_FILE, encoding="utf-8") as fh:
        LOGOS.update(json.load(fh))


# ---------------------------------------------------------------------------
# logos.json from an unpacked simple-icons npm package
# ---------------------------------------------------------------------------
def refresh_logos(pkg_dir):
    data_file = os.path.join(pkg_dir, "data", "simple-icons.json")
    with open(data_file, encoding="utf-8") as fh:
        data = json.load(fh)
    icons = data if isinstance(data, list) else data.get("icons", [])
    by_slug = {}
    for item in icons:
        slug = item.get("slug")
        if not slug:  # older releases derive the slug from the title
            slug = re.sub(r"[^a-z0-9]", "", item["title"].lower().replace("+", "plus").replace(".", "dot").replace("&", "and"))
        by_slug[slug] = item
    version = "unknown"
    try:
        with open(os.path.join(pkg_dir, "package.json"), encoding="utf-8") as fh:
            version = json.load(fh).get("version", "unknown")
    except OSError:
        pass
    logos = {"_about": {
        "source": f"Simple Icons {version} (https://simpleicons.org), npm package simple-icons",
        "license": "The Simple Icons collection is CC0-1.0; some icons carry their own licence ('license' per icon, "
                   "'unspecified' when Simple Icons lists none). All logos are trademarks of their owners and are "
                   "used here only to identify the technologies.",
    }}
    for slug in LOGO_SLUGS:
        with open(os.path.join(pkg_dir, "icons", slug + ".svg"), encoding="utf-8") as fh:
            svg = fh.read()
        m = re.search(r'<path d="([^"]+)"', svg)
        if not m:
            sys.exit(f"no path in {slug}.svg")
        meta = by_slug.get(slug, {})
        lic = meta.get("license")
        logos[slug] = {
            "title": meta.get("title", slug),
            "hex": meta.get("hex", "000000").upper(),
            "license": (lic.get("type") or lic.get("url")) if isinstance(lic, dict) else "unspecified",
            "source": meta.get("source", ""),
            "path": m.group(1),
        }
    with open(LOGOS_FILE, "w", encoding="utf-8") as fh:
        json.dump(logos, fh, indent=2, ensure_ascii=False)
        fh.write("\n")
    print(f"wrote {os.path.relpath(LOGOS_FILE)} ({len(LOGO_SLUGS)} logos, Simple Icons {version})")
