# Diagram sources

The pictures at the top of the README and of every stage guide are generated, not drawn by hand.
One script holds one shared layout, so all six images stay pixel-aligned: students see the same
system grow from stage to stage.

| File | What it is |
|------|------------|
| `build_diagrams.py` | the generator: Python 3 standard library only, writes the six SVGs into `docs/images/` |
| `logos.json` | the 14 brand logos (SVG paths, brand colours, licence, source), extracted from Simple Icons |
| `../architecture-overview.svg` | "What we'll build": the whole system, badges 1-5 mark the stage that adds each part |
| `../stage-1.svg` ... `../stage-5.svg` | the same canvas per stage: NEW parts highlighted, earlier parts calm, later parts faded |

## Regenerate

```console
laptop$ python3 docs/images/src/build_diagrams.py
wrote docs/images/architecture-overview.svg (53 KB)
...
```

The script estimates the width of every label and prints `warning: text may overflow` (exit code 1)
when one may not fit its box. Fix the layout until it is quiet, then open the SVGs in a browser at
about 880 px wide, the width GitHub shows them at.

Where to change what:

| You want to change | Edit in `build_diagrams.py` |
|--------------------|-----------------------------|
| a box position or size | the layout constants (`VM`, `PROXY`, `ACTIONS`, ...), boxes are `(x, y, width, height)` |
| which stage adds a part | `STAGE_OF` (stage number per part) and `ROOTS` (the parts that get the NEW tag) |
| a stage title, subtitle or outcome URL | `STAGES` |
| the numbered story dots | `STEPS` (one list per picture: overview = a visit, each stage = its own story) |
| colours and fonts | the design tokens at the top: one accent (`ACCENT`), neutral greys, `FONT` |

## Logos

The logos come from [Simple Icons](https://simpleicons.org) (`npm` package `simple-icons`). They are
not a dependency of this repository: download the package into a scratch folder, never into the
repository's `package.json`, and let the script copy what it needs into `logos.json`:

```console
laptop$ mkdir -p /tmp/si && cd /tmp/si && npm pack simple-icons && tar -xzf simple-icons-*.tgz
laptop$ cd - && python3 docs/images/src/build_diagrams.py --refresh-logos /tmp/si/package
```

`logos.json` currently holds Simple Icons 16.35.0. To add a logo, append its slug to `LOGO_SLUGS`,
refresh, and use `logo("<slug>", x, y, size, state)`.

### Licences and trademarks

- The Simple Icons collection is released under CC0 1.0. Some icons carry their own licence, recorded
  per icon in `logos.json`:
  - Git Logo by Jason Long, CC BY 3.0.
  - Debian logo, Copyright Software in the Public Interest, CC BY-SA 3.0.
  - Let's Encrypt logo, Copyright ISRG, CC BY-NC 4.0 (fine for this non-commercial course).
  - `unspecified` means Simple Icons lists no licence for that icon, which does not make it CC0.
- Every logo is a trademark of its owner (Docker, F5/NGINX, the PostgreSQL Community Association,
  the OpenJS Foundation, VoidZero, GitHub, Google, Cloudflare, ISRG, Red Hat, SPI, the Software
  Freedom Conservancy). They are used only to identify the technologies the course uses and imply
  no endorsement.
- Each generated SVG repeats these credits in a comment at its top.
