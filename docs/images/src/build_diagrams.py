#!/usr/bin/env python3
"""Draw the system-design pictures for the README and the five stage guides.

One shared layout produces six SVG files in docs/images/:

    architecture-overview.svg     the whole system in full colour, stage badges 1-5
    stage-1.svg ... stage-5.svg   the same canvas: what the stage adds is highlighted
                                  and tagged NEW, earlier parts stay calm, later parts fade

Standard library only. From the repository root:

    python3 docs/images/src/build_diagrams.py
    python3 docs/images/src/build_diagrams.py --refresh-logos <simple-icons package dir>

The second form rebuilds logos.json from an unpacked `npm pack simple-icons` first
(see README.md in this folder). The script also checks that every text fits its box
and prints a warning when one does not, so layout edits stay safe.
"""

import argparse
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from svgkit import *  # noqa: E402,F401,F403  shared tokens, helpers, icons and logos

OUT_DIR = os.path.dirname(HERE)          # docs/images


# ---------------------------------------------------------------------------
# States: normal (overview) | new (the stage adds it, highlight root)
#         cur (added this stage, inside a highlighted root) | done (earlier) | todo (later)
# ---------------------------------------------------------------------------
STAGE_OF = {
    # build
    "laptop": 0, "dock_git": 0, "dock_docker": 0, "dock_ansible": 5,
    "github": 0, "a_gitpush": 0, "local": 0,
    # ship
    "actions": 4, "a_onpush": 4, "a_buildpush": 4, "dockerhub": 0,
    # laptop/CI -> VM
    "a_scp": 1, "a_provision": 5, "a_backup": 5, "a_deploy": 4, "a_pull": 1,
    # run
    "vm": 1, "frontend": 1, "backend": 1, "proxy": 1, "port80": 1, "port443": 3,
    "private": 1, "db": 1, "a_fe": 1, "a_be": 1, "a_db": 1,
    "certbot": 3, "a_cert": 3,
    # reach
    "cloudflare": 2, "a_dns": 2, "browser": 1, "a_http": 1, "a_https": 3,
    "letsencrypt": 3, "a_le": 3,
}
# parts that carry the NEW highlight; their children are drawn normally inside them
ROOTS = {1: {"vm", "browser"}, 2: {"cloudflare"}, 3: {"certbot", "letsencrypt", "port443"},
         4: {"actions"}, 5: {"dock_ansible"}}


def state(key, mode):
    if mode == 0:
        return "normal"
    s = STAGE_OF[key]
    if s > mode:
        return "todo"
    if s == mode:
        if key.startswith("a_"):
            return "new"
        return "new" if key in ROOTS[mode] else "cur"
    return "done"


# ---------------------------------------------------------------------------
# Layout. Cards, zones and gutters snap to an 8 px grid; door chips and a few arrow
# lines take 4 px half-steps so they run through the centre of what they connect.
# Boxes are (x, y, width, height).
#
#   x: | 32  BUILD 232 | 312  SHIP 536 | 688   RUN (the VM)   1176 | 1320 REACH 1568 |
#   y:  24-112 title band, 128-168 zone headers, 192-792 content, 824-868 legend strip
# ---------------------------------------------------------------------------
COLS = [("BUILD", "write & push", 32, 232), ("SHIP", "test & package", 312, 536),
        ("RUN", "serve the app", 688, 1176), ("REACH", "find & play", 1320, 1568)]

VM = (688, 192, 488, 600)
DOCKER = (704, 264, 456, 512)
FRONTEND = (720, 320, 224, 96)
BACKEND = (720, 448, 224, 96)
PROXY = (1056, 320, 88, 224)       # narrow "gatehouse" right behind the entrance
ENTRANCE = (1140, 336, 72, 160)    # the only public door: a frame on the VM wall around door, :80, :443
PORT80 = (1144, 404, 64, 36)
PORT443 = (1144, 452, 64, 36)
PRIVATE = (720, 568, 224, 192)
DB = (736, 600, 192, 80)
CERTBOT = (960, 600, 184, 160)

GITHUB = (32, 448, 200, 152)
LOCAL = (32, 648, 200, 144)
ACTIONS = (312, 448, 224, 152)
DOCKERHUB = (312, 648, 224, 144)

CLOUDFLARE = (1320, 192, 248, 128)
BROWSER = (1320, 408, 248, 168)
LETSENCRYPT = (1320, 672, 248, 120)

LAPTOP_CX = 132
Y_PULL = 704            # Docker Hub -> VM
X_CERT = 1076           # certbot -> proxy
Y_FE, Y_BE = 368, 496   # proxy -> frontend, proxy -> backend
X_DB = 872              # backend -> db
Y_LE = 712              # Let's Encrypt -> certbot
Y_SCP, Y_PROV, Y_BACKUP = 216, 260, 304
LANE_X0, LANE_X1 = LAPTOP_CX + 88, 688
LANE_MID = (LANE_X0 + LANE_X1) / 2

STAGES = {
    1: dict(title="Your app on the internet", sub="IP + HTTP: rent a VM, copy three files, start the containers, open its IP",
            scheme="http", url="http://<VM-IP>"),
    2: dict(title="A real name", sub="Domain, still HTTP: one DNS record points devops.gulfheight.com at the VM",
            scheme="http", url="http://devops.gulfheight.com"),
    3: dict(title="The padlock", sub="HTTPS: Let’s Encrypt signs a free certificate; certbot renews it twice a day",
            scheme="https", url="https://devops.gulfheight.com"),
    4: dict(title="Push to deploy", sub="CI/CD: merge into main and GitHub Actions tests, builds, pushes and deploys",
            scheme="https", url="https://devops.gulfheight.com"),
    5: dict(title="The VM as code", sub="Ansible, optional: rebuild the whole VM from your laptop in one command",
            scheme="https", url="https://devops.gulfheight.com"),
}
LEGEND = [(1, "IP"), (2, "Domain"), (3, "HTTPS"), (4, "CI/CD"), (5, "Ansible")]

# which flow carries the numbered step dots in each picture: (x, y, number)
STEPS = {
    0: [(1368, 408, 1), (1520, 320, 2), (1320, 470, 3), (1056, 432, 4), (X_DB, 544, 5)],
    1: [(LANE_X0, Y_SCP, 1), (536, Y_PULL, 2), (1320, 422, 3), (1056, 432, 4), (X_DB, 544, 5)],
    2: [(1368, 408, 1), (1520, 320, 2), (1320, 422, 3), (1056, 432, 4), (X_DB, 544, 5)],
    3: [(1320, Y_LE, 1), (X_CERT, 600, 2), (1320, 470, 3), (1056, 432, 4), (X_DB, 544, 5)],
    4: [(LAPTOP_CX, 384, 1), (232, 520, 2), (360, 600, 3), (536, 520, 4), (536, Y_PULL, 5)],
    5: [(LANE_X0, Y_PROV, 1), (688, Y_BACKUP, 2)],
}


# ---------------------------------------------------------------------------
# Components
# ---------------------------------------------------------------------------
def title_band(mode):
    out = []
    if mode == 0:
        out.append(ic_bug(32, 36, 56))
        title, sub = "What we’ll build", "Bug Squash Arena: the path your code travels from a laptop to a live, secure website"
        scheme, url, lead = "https", "https://devops.gulfheight.com", "Live at"
    else:
        out.append(rect(32, 40, 56, 56, 12, fill=ACCENT))
        out.append(text(60, 81, str(mode), 34, 800, WHITE, "middle"))
        st = STAGES[mode]
        title, sub = f"Stage {mode} · {st['title']}", st["sub"]
        scheme, url, lead = st["scheme"], st["url"], "By the end"
    out.append(text(108, 76, title, 42, 800, INK, spacing=-0.5))
    out.append(text(108, 106, sub, 20, 400, CAP))
    # outcome pill (right aligned)
    url_w = text_width(url, 22, 700)
    lead_w = text_width(lead, 17, 400)
    pill_w = 20 + lead_w + 16 + 22 + 10 + url_w + 22
    px = 1568 - pill_w
    out.append(rect(px, 44, pill_w, 52, 26, fill=WHITE, stroke=LINE, stroke_width=1.5, filter="url(#shadow)"))
    out.append(text(px + 20, 76, lead, 17, 400, CAP))
    ix = px + 20 + lead_w + 16
    if scheme == "https":
        out.append(ic_lock(ix, 58, 22, INK))
    else:
        out.append(ic_warn(ix, 59, 22, GREY))
    out.append(text(ix + 32, 78, url, 22, 700, INK))
    check_fit("title", title, 42, 800, px - 108 - 24)
    return "".join(out)


def zone_headers():
    out = []
    for i, (name, cap, x0, x1) in enumerate(COLS):
        out.append(rect(x0, 128, x1 - x0, 40, R_CHIP, fill=SOFT))
        nw = text_width(name, 16, 800, 2)
        cw = text_width(cap, 17, 400)
        tx = x0 + (x1 - x0 - (nw + 12 + cw)) / 2
        out.append(text(tx, 154, name, 16, 800, TEXT, spacing=2))
        out.append(text(tx + nw + 12, 154, cap, 17, 400, CAP))
        check_fit("zone " + name, name + "  " + cap, 17, 700, x1 - x0 - 16)
        if i < len(COLS) - 1:
            nx = COLS[i + 1][2]
            out.append(ic_chevron((x1 + nx) / 2, 148, FAINT, 8))
    return "".join(out)


def laptop(mode):
    st_l = state("laptop", mode)
    st_a = state("dock_ansible", mode)
    cx, sw, sh, sy = LAPTOP_CX, 176, 112, 200
    sx = cx - sw // 2
    out = [rect(sx, sy, sw, sh, 10, fill="#1F2937"),
           rect(sx + 6, sy + 6, sw - 12, sh - 12, 5, fill=INK)]
    # code lines (decoration, greys only)
    rows = [(0, 64, "#6B7280"), (12, 88, "#9CA3AF"), (12, 52, "#4B5563"), (24, 72, "#9CA3AF"), (0, 40, "#6B7280")]
    for i, (ind, ln, c) in enumerate(rows):
        out.append(rect(sx + 16 + ind, sy + 15 + i * 9, ln, 4, 2, fill=c))
    out.append(rect(sx + 16 + 100, sy + 15, 36, 4, 2, fill="#4B5563"))
    # dock with the laptop's tools
    out.append(rect(cx - 64, sy + 62, 128, 40, 12, fill="#374151"))
    tiles = [("git", "dock_git"), ("docker", "dock_docker"), ("ansible", "dock_ansible")]
    for i, (slug, key) in enumerate(tiles):
        st = state(key, mode)
        tx = cx - 56 + i * 40
        if st == "new":
            out.append(rect(tx - 5, sy + 61, 42, 42, 12, fill=ACCENT))
        tile = [rect(tx, sy + 66, 32, 32, 8, fill=WHITE), logo(slug, tx + 5, sy + 71, 22, st)]
        out.append(group(tile, 0.35 if st == "todo" else None))
    # base
    bx0, bx1 = cx - 108, cx + 108
    out.append(path(f"M{bx0} 312 H{bx1} V318 Q{bx1} 328 {bx1 - 10} 328 H{bx0 + 10} Q{bx0} 328 {bx0} 318 Z", fill="#D1D5DB"))
    out.append(rect(cx - 20, 312, 40, 5, 2.5, fill=FAINT))
    out.append(text(cx, 358, "Your laptop", 22, 700, INK, "middle"))
    return group(out, card_style(st_l)["op"])


def github_card(mode):
    st = state("github", mode)
    s = card_style(st)
    x, y, w, h = GITHUB
    out = [card(x, y, w, h, st), logo("github", x + 16, y + 17, 30, st),
           text(x + 54, y + 40, "GitHub repo", 21, 700, s["title"])]
    check_fit("github", "GitHub repo", 21, 700, w - 54 - 8)
    # a tiny git graph: dev -> test -> main
    gy = y + 84
    xs = [x + 34, x + 100, x + 166]
    out.append(line(xs[0], gy, xs[2], gy, stroke=LINE, stroke_width=3))
    for a, b in zip(xs, xs[1:]):
        out.append(path(f"M{b - 22} {gy - 6} L{b - 13} {gy} L{b - 22} {gy + 6}", fill="none", stroke=FAINT if st == "todo" else GREY,
                        stroke_width=2.5, stroke_linecap="round", stroke_linejoin="round"))
    for i, (bx, name) in enumerate(zip(xs, ("dev", "test", "main"))):
        main = name == "main"
        out.append(circle(bx, gy, 9, fill=(s["title"] if main else WHITE), stroke=s["title"], stroke_width=3))
        out.append(text(bx, gy + 36, name, 18, 600 if main else 400, s["title"] if main else s["cap"], "middle"))
    return group(out, s["op"])


def actions_card(mode):
    st = state("actions", mode)
    s = card_style(st)
    x, y, w, h = ACTIONS
    out = [card(x, y, w, h, st), logo("githubactions", x + 16, y + 17, 30, st),
           text(x + 54, y + 40, "GitHub Actions", 20, 700, s["title"])]
    check_fit("actions", "GitHub Actions", 20, 700, w - 54 - 8)
    chips = [("lint", 48), ("test", 50), ("build", 58)]
    cxp = x + 16
    for i, (name, cw) in enumerate(chips):
        out.append(chip(cxp, y + 88, cw, 36, name, 17, 600, SOFT, s["title"] if st != "todo" else FAINT))
        cxp += cw
        if i < 2:
            out.append(ic_chevron(cxp + 10, y + 106, FAINT, 6))
            cxp += 20
    return group(out, s["op"])


def local_card(mode):
    """Part 2 of the README: the same stack on the laptop, with hot reload."""
    st = state("local", mode)
    s = card_style(st)
    x, y, w, h = LOCAL
    out = [card(x, y, w, h, st), logo("docker", x + 16, y + 17, 30, st),
           text(x + 54, y + 40, "Local dev", 22, 700, s["title"]),
           rect(x + 12, y + 62, w - 24, 34, 8, fill=INK if st != "todo" else HAIR),
           text(x + w / 2, y + 84, "docker compose up", 15, 600, WHITE if st != "todo" else FAINT, "middle"),
           text(x + 16, y + 124, "\u2192 localhost:5173", 17, 400, s["cap"])]
    check_fit("local", "docker compose up", 15, 600, w - 24 - 12)
    return group(out, s["op"])


def dockerhub_card(mode):
    st = state("dockerhub", mode)
    s = card_style(st)
    x, y, w, h = DOCKERHUB
    out = [card(x, y, w, h, st), logo("docker", x + 16, y + 16, 32, st),
           text(x + 58, y + 40, "Docker Hub", 22, 700, s["title"])]
    for i, name in enumerate(("bugsquash-backend", "bugsquash-frontend")):
        yy = y + 70 + i * 34
        out.append(ic_layers(x + 16, yy, 22, CAP if st != "todo" else FAINT))
        out.append(text(x + 46, yy + 17, name, 17, 400, s["title"]))
        check_fit("hub", name, 17, 400, w - 46 - 10)
    return group(out, s["op"])


def container(box, slug, name, cap, st, side_slug=None, stacked=False):
    """A container card: main logo left, bold name (optionally followed by a second logo), caption.
    stacked=True puts logo and name on the first row and a full-width caption under them."""
    s = card_style(st)
    x, y, w, h = box
    if stacked:
        out = [card(x, y, w, h, st), logo(slug, x + 14, y + 13, 30, st),
               text(x + 54, y + 36, name, 20, 700, s["title"]),
               text(x + 16, y + 72, cap, 16.5, 400, s["cap"])]
        check_fit(name, cap, 16.5, 400, w - 26)
        if side_slug:
            out.append(logo(side_slug, x + 54 + text_width(name, 20, 700) + 4, y + 15, 23, st))
        return group(out, s["op"])
    out = [card(x, y, w, h, st), logo(slug, x + 14, y + (h - 34) / 2, 34, st),
           text(x + 60, y + h / 2 - 4, name, 20, 700, s["title"]),
           text(x + 60, y + h / 2 + 22, cap, 17, 400, s["cap"])]
    check_fit(name, cap, 17, 400, w - 60 - 10)
    if side_slug:
        lx = x + 60 + text_width(name, 20, 700) + 4
        out.append(logo(side_slug, lx, y + h / 2 - 23, 23, st))
        check_fit(name + " logo", name, 20, 700, w - 60 - 8 - 27)
    return group(out, s["op"])


def vm_block(mode):
    st_vm = state("vm", mode)
    s = card_style(st_vm)
    x, y, w, h = VM
    out = [card(x, y, w, h, st_vm, sw=2.5 if st_vm != "new" else 3, stroke=None if st_vm == "new" else (HAIR if st_vm == "todo" else FAINT)),
           logo("googlecloud", x + 16, y + 16, 38, st_vm),
           text(x + 66, y + 34, "Google Cloud VM", 22, 700, s["title"]),
           logo("debian", x + 66, y + 41, 20, st_vm),
           text(x + 91, y + 58, "Debian 13 · e2-medium", 17, 400, s["cap"])]
    # the VM's public address
    ipx, ipy = 1016, 210
    out.append(rect(ipx, ipy, 120, 34, R_CHIP, fill=SOFT))
    out.append(ic_pin(ipx + 10, ipy + 6, 22, s["title"] if st_vm != "todo" else FAINT))
    out.append(text(ipx + 38, ipy + 23, "<VM-IP>", 17, 700, s["title"]))
    # docker engine area
    dx, dy, dw, dh = DOCKER
    out.append(rect(dx, dy, dw, dh, R_CARD, fill=WASH, stroke=HAIR, stroke_width=1.5))
    out.append(logo("docker", dx + 16, dy + 9, 30, st_vm))
    out.append(text(dx + 54, dy + 31, "Docker Compose", 20, 700, s["title"]))
    out.append(text(dx + dw - 16, dy + 31, "4 containers + certbot", 17, 400, s["cap"], "end"))
    return group(out, s["op"])


def proxy_block(mode):
    st = state("proxy", mode)
    s = card_style(st)
    x, y, w, h = PROXY
    tls = mode == 0 or mode >= 3
    cx = x + w / 2
    out = [card(x, y, w, h, st), logo("nginx", cx - 18, y + 16, 36, st),
           text(cx, y + 76, "proxy", 20, 700, s["title"], "middle"),
           text(cx, y + 98, "nginx", 16.5, 400, s["cap"], "middle")]
    if tls:
        out.append(text(cx, y + 118, "+ TLS", 16.5, 400, s["cap"], "middle"))
    return group(out, s["op"])


def entrance(mode):
    """The one opening in the VM wall: a door and the two published ports, nothing else."""
    st = state("proxy", mode)
    s = card_style(st)
    x, y, w, h = ENTRANCE
    col = FAINT if st == "todo" else INK
    out = [rect(x, y, w, h, 12, fill=WHITE, stroke=col, stroke_width=2.5),
           ic_door(x + w / 2 - 13, y + 12, 26, 40, col),
           text(x + w + 10, y + 26, "the only", 17, 700, s["title"]),
           text(x + w + 10, y + 48, "public door", 17, 700, s["title"])]
    return group(out, s["op"])


def port(box, name, st):
    x, y, w, h = box
    fill = {"todo": HAIR, "new": ACCENT}.get(st, INK)
    color = FAINT if st == "todo" else WHITE
    out = []
    if st == "new":
        out.append(rect(x - 6, y - 6, w + 12, h + 12, R_CHIP + 6, fill=ACCENT_HALO))
    out.append(rect(x, y, w, h, R_CHIP, fill=fill, stroke=WHITE, stroke_width=2))
    out.append(text(x + w / 2, y + h / 2 + 6.5, name, 18, 800, color, "middle"))
    return "".join(out)


def private_zone(mode):
    st = state("private", mode)
    s = card_style(st)
    x, y, w, h = PRIVATE
    col = s["title"] if st != "todo" else FAINT
    out = [rect(x, y, w, h, R_CARD, fill=SOFT, stroke=LINE, stroke_width=1.5),
           ic_lock(x + 16, y + 126, 20, col, SOFT),
           text(x + 44, y + 144, "private network", 18, 700, col),
           text(x + 16, y + 172, "no route to the internet", 16.5, 400, s["cap"])]
    check_fit("private", "no route to the internet", 16.5, 400, w - 24)
    return group(out, s["op"])


def certbot_block(mode):
    st = state("certbot", mode)
    s = card_style(st)
    x, y, w, h = CERTBOT
    col = s["title"] if st != "todo" else FAINT
    out = [card(x, y, w, h, st), ic_cert(x + 14, y + 14, 36, col),
           text(x + 62, y + 40, "certbot", 20, 700, s["title"]),
           ic_clock(x + 16, y + 70, 20, col), text(x + 46, y + 86, "renews 2×/day", 17, 400, s["cap"]),
           ic_cyl(x + 18, y + 108, 17, 22, col), text(x + 46, y + 125, "cert volume", 17, 400, s["cap"])]
    check_fit("certbot", "renews 2×/day", 17, 400, w - 46 - 8)
    return group(out, s["op"])


def cloudflare_card(mode):
    st = state("cloudflare", mode)
    s = card_style(st)
    x, y, w, h = CLOUDFLARE
    out = [card(x, y, w, h, st), logo("cloudflare", x + 14, y + 12, 38, st),
           text(x + 60, y + 38, "Cloudflare DNS", 20, 700, s["title"]),
           text(x + 16, y + 78, "devops.gulfheight.com", 17, 600, s["title"])]
    check_fit("cloudflare", "devops.gulfheight.com", 17, 600, w - 26)
    check_fit("cloudflare title", "Cloudflare DNS", 20, 700, w - 60 - 8)
    out.append(chip(x + 16, y + 90, 30, 26, "A", 15, 800, INK if st != "todo" else HAIR, WHITE if st != "todo" else FAINT, 7))
    out.append(text(x + 56, y + 109, "→  <VM-IP>", 17, 400, s["cap"]))
    return group(out, s["op"])


def browser(mode):
    st = state("browser", mode)
    s = card_style(st)
    x, y, w, h = BROWSER
    out = [card(x, y, w, h, st, r=12)]
    for i in range(3):
        out.append(circle(x + 18 + i * 14, y + 17, 4.5, fill=LINE))
    # address bar
    out.append(rect(x + 12, y + 44, w - 24, 36, R_CHIP, fill=SOFT))
    secure = mode == 0 or mode >= 3
    host = "<VM-IP>" if mode == 1 else "devops.gulfheight.com"
    if secure:
        out.append(ic_lock(x + 22, y + 52, 18, INK, SOFT))
    else:
        out.append(ic_warn(x + 22, y + 53, 18, GREY))
    out.append(text(x + 46, y + 68, host, 16.5, 400, INK if st != "todo" else FAINT))
    check_fit("browser", host, 16.5, 400, w - 24 - 42)
    # the game: squash the bug!
    gx, gy, gw, gh = x + 12, y + 88, w - 24, 44
    out.append(rect(gx, gy, gw, gh, 8, fill=WASH, stroke=HAIR, stroke_width=1))
    for d in (f"M{gx + 10} {gy + 12} H{gx + 54} V{gy + 32} H{gx + 80}", f"M{gx + gw - 10} {gy + 32} H{gx + gw - 56} V{gy + 12} H{gx + gw - 76}"):
        out.append(path(d, fill="none", stroke=LINE, stroke_width=2, stroke_linejoin="round"))
        out.append(circle(int(d.split()[0][1:]), int(d.split()[1]), 3, fill=LINE))
    out.append(ic_bug(gx + gw / 2 - 14, gy + 7, 30, INK if st != "todo" else FAINT))
    out.append(text(gx + gw / 2 + 24, gy + 20, "+1", 17, 800, INK if st != "todo" else FAINT))
    out.append(text(x + w / 2, y + 156, "game runs here · calls /api", 16.5, 600, TEXT if st != "todo" else FAINT, "middle"))
    check_fit("browser caption", "game runs here · calls /api", 16.5, 600, w - 20)
    # players
    py_ = y + h + 18
    for i, c in enumerate(("#9CA3AF", "#6B7280", "#4B5563")):
        out.append(ic_person(x + 8 + i * 20, py_, 30, c if st != "todo" else HAIR))
    out.append(text(x + 82, py_ + 22, "Visitors", 18, 700, s["title"]))
    return group(out, s["op"])


def letsencrypt_card(mode):
    st = state("letsencrypt", mode)
    s = card_style(st)
    x, y, w, h = LETSENCRYPT
    out = [card(x, y, w, h, st), logo("letsencrypt", x + 16, y + 16, 34, st),
           text(x + 60, y + 40, "Let’s Encrypt", 20, 700, s["title"]),
           text(x + 16, y + 82, "free, trusted", 17, 400, s["cap"]),
           text(x + 16, y + 104, "TLS certificates", 17, 400, s["cap"])]
    return group(out, s["op"])


# ---------------------------------------------------------------------------
# Flows (arrows + labels)
# ---------------------------------------------------------------------------
def flows(mode):
    out = []

    def A(key, pts, both=False):
        st = state(key, mode)
        out.append(group([arrow(pts, st, both)], 0.8 if st == "todo" else None))
        return st

    def Lb(key, x, y, s, anchor="middle", size=18, weight=600):
        out.append(label(x, y, s, state(key, mode), anchor, size, weight))

    def lane_label(key, y, icon, s, tail=None):
        """Centre [icon  text  (tail chip)] on the lane, just above the arrow."""
        st = state(key, mode)
        col = arrow_style(st)["lab"]
        tw = text_width(s, 18, 600)
        tail_w = 0 if tail is None else 12 + tail[0]
        x = LANE_MID - (34 + tw + tail_w) / 2
        out.append(group([icon(x, y - 36, col, st)], 0.6 if st == "todo" else None))
        Lb(key, x + 34, y - 12, s, "start")
        if tail:
            out.append(group([tail[1](x + 34 + tw + 12, y - 36, col, st)], 0.6 if st == "todo" else None))
        return x

    bx = LAPTOP_CX
    # laptop -> GitHub
    A("a_gitpush", [(bx, 384), (bx, 440)])
    Lb("a_gitpush", bx + 14, 414, "git push", "start")
    # GitHub -> Actions -> Docker Hub
    gx = GITHUB[0] + GITHUB[2]
    ax = ACTIONS[0]
    A("a_onpush", [(gx, 520), (ax, 520)])
    Lb("a_onpush", (gx + ax) / 2, 549, "on push")
    A("a_buildpush", [(ax + 48, 600), (ax + 48, 648)])
    Lb("a_buildpush", ax + 62, 630, "build & push", "start")
    # Actions -> VM (Stage 4 deploy) and Docker Hub -> VM (pull)
    sx = ACTIONS[0] + ACTIONS[2]
    mid = (sx + VM[0]) / 2
    A("a_deploy", [(sx, 520), (VM[0], 520)])
    Lb("a_deploy", mid, 486, "ssh + rsync", size=17)
    Lb("a_deploy", mid, 507, "deploy.sh", size=17)
    A("a_pull", [(sx, Y_PULL), (VM[0], Y_PULL)])
    Lb("a_pull", mid, Y_PULL - 34, "docker compose", size=17)
    Lb("a_pull", mid, Y_PULL - 13, "pull", size=17)

    # top lane: laptop <-> VM
    A("a_scp", [(LANE_X0, Y_SCP), (LANE_X1, Y_SCP)])
    lane_label("a_scp", Y_SCP, lambda x, y, c, st: ic_files(x, y, 26, c), "scp: compose, .env, nginx")
    A("a_provision", [(LANE_X0, Y_PROV), (LANE_X1, Y_PROV)])
    vault_w = 30 + text_width("vault", 17, 600) + 10

    def vault_chip(x, y, c, st):
        return (rect(x, y + 4, vault_w, 28, 8, fill=WHITE, stroke=c, stroke_width=1.5)
                + ic_safe(x + 6, y + 8, 20, c) + text(x + 31, y + 24, "vault", 17, 600, c))
    lx = lane_label("a_provision", Y_PROV,
                    lambda x, y, c, st: logo("ansible", x, y + 6, 22, "todo" if st == "todo" else "normal"),
                    "ansible: provision", (vault_w, vault_chip))
    LANE_ANCHORS["provision"] = lx
    A("a_backup", [(LANE_X1, Y_BACKUP), (LANE_X0, Y_BACKUP)])
    lane_label("a_backup", Y_BACKUP, lambda x, y, c, st: ic_cyl(x + 4, y + 7, 17, 22, c), "backup: database + cert")

    # inside the VM
    apps_x = FRONTEND[0] + FRONTEND[2]
    mid = (PROXY[0] + apps_x) / 2
    A("a_fe", [(PROXY[0], Y_FE), (apps_x, Y_FE)])
    Lb("a_fe", mid, Y_FE - 12, "/")
    Lb("a_fe", mid, Y_FE + 27, "files", size=16.5, weight=400)
    A("a_be", [(PROXY[0], Y_BE), (apps_x, Y_BE)])
    Lb("a_be", mid, Y_BE - 12, "/api")
    Lb("a_be", mid, Y_BE + 27, "API calls", size=16.5, weight=400)
    Lb("a_be", mid, Y_BE + 47, "from browser", size=16.5, weight=400)
    check_fit("proxy arrow", "from browser", 16.5, 400, PROXY[0] - apps_x - 4)
    A("a_db", [(X_DB, BACKEND[1] + BACKEND[3]), (X_DB, 600)])
    Lb("a_db", X_DB - 22, 562, "SQL", "end")
    A("a_cert", [(X_CERT, 600), (X_CERT, PROXY[1] + PROXY[3])])
    Lb("a_cert", X_CERT - 14, 580, "TLS cert", "end")

    # REACH: DNS, the visit, the certificate
    rx = BROWSER[0]
    wall = VM[0] + VM[2]
    A("a_dns", [(rx + 48, 408), (rx + 48, 320)])
    A("a_dns", [(rx + 200, 320), (rx + 200, 408)])
    Lb("a_dns", rx + 62, 356, "DNS lookup", "start")
    Lb("a_dns", rx + 186, 392, "<VM-IP>", "end")
    door_x = PORT80[0] + PORT80[2]
    if mode in (1, 2):
        A("a_http", [(rx, 422), (door_x, 422)])
        Lb("a_http", rx - 22, 448, "HTTP :80", "end")
    A("a_https", [(rx, 470), (door_x, 470)])
    Lb("a_https", (rx + door_x) / 2 - 2, 504, "HTTPS :443")
    A("a_le", [(LETSENCRYPT[0], Y_LE), (CERTBOT[0] + CERTBOT[2], Y_LE)])
    Lb("a_le", (wall + LETSENCRYPT[0] - 15) / 2, Y_LE - 12, "issues cert")
    return "".join(out)


LANE_ANCHORS = {}


def stage_badges(mode):
    if mode != 0:
        return ""
    places = [(VM[0] + VM[2] - 24, VM[1], 1), (CLOUDFLARE[0] + CLOUDFLARE[2] - 24, CLOUDFLARE[1], 2),
              (CERTBOT[0] + CERTBOT[2] - 24, CERTBOT[1], 3), (LETSENCRYPT[0] + LETSENCRYPT[2] - 24, LETSENCRYPT[1], 3),
              (ACTIONS[0] + ACTIONS[2] - 24, ACTIONS[1], 4), (LANE_ANCHORS["provision"] - 26, Y_PROV - 22, 5)]
    return "".join(badge(x, y, n) for x, y, n in places)


def new_tags(mode):
    if mode == 0:
        return ""
    places = {
        1: [(VM[0] + VM[2] - 60, VM[1]), (BROWSER[0] + BROWSER[2] - 48, BROWSER[1])],
        2: [(CLOUDFLARE[0] + CLOUDFLARE[2] - 48, CLOUDFLARE[1])],
        3: [(CERTBOT[0] + 46, CERTBOT[1]), (LETSENCRYPT[0] + LETSENCRYPT[2] - 48, LETSENCRYPT[1])],
        4: [(ACTIONS[0] + ACTIONS[2] - 48, ACTIONS[1])],
        5: [(LANE_ANCHORS["provision"] - 42, Y_PROV - 22)],
    }[mode]
    return "".join(new_tag(x, y) for x, y in places)


def who_talks():
    """One line under the VM: the only connections the system allows."""
    # "->" is a drawn arrow, so it looks the same in every font
    parts = [("Who talks to whom:", 700, CAP), ("internet", 400, TEXT), ("->", 0, TEXT), ("proxy only", 400, TEXT),
             ("\u00b7", 400, FAINT), ("proxy", 400, TEXT), ("->", 0, TEXT), ("frontend, backend", 400, TEXT),
             ("\u00b7", 400, FAINT), ("backend", 400, TEXT), ("->", 0, TEXT), ("db", 400, TEXT)]
    gap, aw, base = 8, 22, 818
    widths = [aw if t == "->" else text_width(t, 16.5, wgt) for t, wgt, _ in parts]
    x = VM[0] + VM[2] / 2 - (sum(widths) + gap * (len(parts) - 1)) / 2
    out = []
    for (t, wgt, col), wd in zip(parts, widths):
        if t == "->":
            yy = base - 5.5
            out.append(line(x, yy, x + aw - 6, yy, stroke=col, stroke_width=2, stroke_linecap="round"))
            out.append(path(f"M{f(x + aw)} {f(yy)} L{f(x + aw - 7)} {f(yy - 4.5)} L{f(x + aw - 7)} {f(yy + 4.5)}Z", fill=col))
        else:
            out.append(text(x, base, t, 16.5, wgt, col))
        x += wd + gap
    return "".join(out)


def steps(mode):
    return "".join(step_dot(x, y, n) for x, y, n in STEPS[mode])


def legend(mode):
    x0, y0, w, h = 32, 834, 1536, 44
    out = [rect(x0, y0, w, h, R_CHIP, fill=WASH, stroke=HAIR, stroke_width=1)]
    items = []   # (width, svg-builder)
    cy = y0 + h / 2

    def stage_item(n, name):
        if mode == 0 or n == mode:
            fill, tcol, ncol, weight = ACCENT, WHITE, INK, 700
        elif n < mode:
            fill, tcol, ncol, weight = GREY, WHITE, TEXT, 400
        else:
            fill, tcol, ncol, weight = HAIR, FAINT, FAINT, 400
        wname = text_width(name, 17, weight)

        def build(x):
            return (rect(x, cy - 13, 26, 26, 7, fill=fill)
                    + text(x + 13, cy + 6, str(n), 16, 800, tcol, "middle")
                    + text(x + 34, cy + 6, name, 17, weight, ncol))
        return 34 + wname, build

    lead = "Stages" if mode == 0 else "Progress"
    lw = text_width(lead.upper(), 14, 800, 1.5)
    items.append((lw, lambda x: text(x, cy + 5, lead.upper(), 14, 800, CAP, spacing=1.5)))
    for n, name in LEGEND:
        items.append(stage_item(n, name))
    # key for the other marks
    sep = (1, lambda x: line(x, cy - 12, x, cy + 12, stroke=LINE, stroke_width=1.5))
    items.append(sep)
    ktext = "a visit, step by step" if mode == 0 else "story of this stage, step by step"
    kw = text_width(ktext, 17, 400)
    items.append((30 + 8 + kw, lambda x: step_dot(x + 14, cy, 1, 13) + text(x + 38, cy + 6, ktext, 17, 400, TEXT)))
    if mode != 0:
        items.append(sep)
        nw = text_width("added in this stage", 17, 400)
        items.append((60 + 10 + nw, lambda x: new_tag(x + 30, cy) + text(x + 70, cy + 6, "added in this stage", 17, 400, TEXT)))
        fw = text_width("faded = a later stage", 17, 400)
        items.append((fw, lambda x: text(x, cy + 6, "faded = a later stage", 17, 400, FAINT)))
    gap = 26
    total = sum(wd for wd, _ in items) + gap * (len(items) - 1)
    x = x0 + (w - total) / 2
    for wd, build in items:
        out.append(build(x))
        x += wd + gap
    return "".join(out)


# ---------------------------------------------------------------------------
# Assemble one picture
# ---------------------------------------------------------------------------
def build(mode):
    FIT_PROBLEMS.clear()
    body = [
        title_band(mode), zone_headers(),
        # BUILD + SHIP
        laptop(mode), github_card(mode), local_card(mode), actions_card(mode), dockerhub_card(mode),
        # RUN
        vm_block(mode),
        container(FRONTEND, "vite", "frontend", "serves HTML · CSS · JS", state("frontend", mode), stacked=True),
        container(BACKEND, "nodedotjs", "backend", "Express API", state("backend", mode), "express", stacked=True),
        proxy_block(mode), entrance(mode),
        private_zone(mode),
        container(DB, "postgresql", "db", "PostgreSQL", state("db", mode)),
        certbot_block(mode),
        port(PORT80, ":80", state("port80", mode)),
        port(PORT443, ":443", state("port443", mode)),
        # REACH
        cloudflare_card(mode), browser(mode), letsencrypt_card(mode),
        # arrows above the cards, then the marks
        flows(mode), stage_badges(mode), new_tags(mode), steps(mode), who_talks(), legend(mode),
    ]
    if mode == 0:
        title = "What we'll build: Bug Squash Arena system design"
        desc = ("From the laptop (Git, Docker) through GitHub and GitHub Actions to Docker Hub, onto a Google Cloud VM "
                "where Docker runs nginx (proxy, the only public door on ports 80/443). The proxy sends / to the Vite frontend, "
                "which only serves files, and /api to the Node.js/Express backend: those API calls come from the game running "
                "in the visitor's browser. Only the backend reaches PostgreSQL, on a private network; certbot renews a Let's "
                "Encrypt certificate. Visitors find the VM through Cloudflare DNS. Badges 1-5 mark the stage that adds each part.")
    else:
        st = STAGES[mode]
        title = f"Stage {mode}: {st['title']}"
        desc = f"{st['sub']}. Outcome: {st['url']}. Parts added in this stage are highlighted and tagged NEW; later stages are faded."
    svg = document(title, desc, body, "build_diagrams.py")
    return svg, list(FIT_PROBLEMS)


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--refresh-logos", metavar="PKG_DIR",
                    help="rebuild logos.json from an unpacked simple-icons npm package first")
    ap.add_argument("--out", default=OUT_DIR, help="output folder (default: docs/images)")
    args = ap.parse_args()
    if args.refresh_logos:
        refresh_logos(args.refresh_logos)
    load_logos()
    names = {0: "architecture-overview.svg", 1: "stage-1.svg", 2: "stage-2.svg", 3: "stage-3.svg",
             4: "stage-4.svg", 5: "stage-5.svg"}
    os.makedirs(args.out, exist_ok=True)
    status = 0
    for mode, name in names.items():
        svg, problems = build(mode)
        target = os.path.join(args.out, name)
        with open(target, "w", encoding="utf-8") as fh:
            fh.write(svg)
        print(f"wrote {os.path.relpath(target)} ({len(svg.encode()) // 1024} KB)")
        for p in problems:
            print("  warning: text may overflow ->", p)
            status = 1
    return status


if __name__ == "__main__":
    sys.exit(main())
