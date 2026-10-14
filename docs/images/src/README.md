# Diagram sources

The pictures in the README, the stage guides and the containers lesson are generated, not drawn by
hand. Two small scripts share one drawing kit, so every picture has the same palette, type and
logos, and the six system diagrams stay pixel-aligned: students see the same system grow from stage
to stage.

| File | What it is |
|------|------------|
| `svgkit.py` | the shared kit: design tokens (one accent, neutral greys, `FONT`), text measuring, SVG helpers, drawn icons, logo loading |
| `build_diagrams.py` | the system diagrams: writes the six SVGs below into `docs/images/` |
| `build_slides.py` | the containers lesson: writes nine slides into `docs/images/slides/` |
| `logos.json` | the 16 brand logos (SVG paths, brand colours, licence, source), extracted from Simple Icons |
| `../architecture-overview.svg` | "What we'll build": the whole system, badges 1-5 mark the stage that adds each part |
| `../stage-1.svg` ... `../stage-5.svg` | the same canvas per stage: NEW parts highlighted, earlier parts calm, later parts faded |
| `../slides/containers-01-*.svg` ... `containers-09-*.svg` | the slides of [Containers and Docker](../../containers-and-docker.md) |

Everything is Python 3 standard library only.

## Regenerate

```console
laptop$ python3 docs/images/src/build_diagrams.py
wrote docs/images/architecture-overview.svg (53 KB)
...
laptop$ python3 docs/images/src/build_slides.py
wrote docs/images/slides/containers-01-works-on-my-machine.svg (24 KB)
...
```

Both scripts estimate the width of every label and print `warning: text may overflow` (exit code 1)
when one may not fit its box. Fix the layout until they are quiet, then open the SVGs in a browser at
about 880 px wide, the width GitHub shows them at.

Where to change what in the system diagrams:

| You want to change | Edit in `build_diagrams.py` |
|--------------------|-----------------------------|
| a box position or size | the layout constants (`VM`, `PROXY`, `ACTIONS`, ...), boxes are `(x, y, width, height)` |
| which stage adds a part | `STAGE_OF` (stage number per part) and `ROOTS` (the parts that get the NEW tag) |
| a stage title, subtitle or outcome URL | `STAGES` |
| the numbered story dots | `STEPS` (one list per picture: overview = a visit, each stage = its own story) |
| colours and fonts | the design tokens in `svgkit.py`: they change every picture at once |

## Slides

`build_slides.py` draws one slide per function (`slide_1` ... `slide_9`); the list `SLIDES` at the
bottom sets the file names and their order. Every slide shares one frame: a 52 px title, one
subtitle line, the content between y = 200 and 800, and a footer with the lesson name, a progress bar
and "N / 9".

- **One idea per slide.** The accent colour marks the one thing to remember (the box, the kernel,
  the commands, the volume); everything else stays grey or in brand colours.
- **Real names only:** `bugsquash-backend`, `alhuraibisaeed/`, `pgdata`, `letsencrypt`, the limits
  from `docker-compose.prod.yml` (0.5 CPU, 256 MB), and slide 7's kernel string, captured on the
  course VM. Update them here when the repository changes.
- **Monospace text** (the terminal, the YAML) goes through `mono()`. It places each word on a fixed
  0.6 em grid, so the highlight boxes line up whatever monospace font the reader has.

## Logos

The logos come from [Simple Icons](https://simpleicons.org) (`npm` package `simple-icons`). They are
not a dependency of this repository: download the package into a scratch folder, never into the
repository's `package.json`, and let the script copy what it needs into `logos.json`:

```console
laptop$ mkdir -p /tmp/si && cd /tmp/si && npm pack simple-icons && tar -xzf simple-icons-*.tgz
laptop$ cd - && python3 docs/images/src/build_diagrams.py --refresh-logos /tmp/si/package
```

`logos.json` currently holds Simple Icons 16.35.0. To add a logo, append its slug to `LOGO_SLUGS`
in `svgkit.py`, refresh, and use `logo("<slug>", x, y, size)`.

### Licences and trademarks

- The Simple Icons collection is released under CC0 1.0. Some icons carry their own licence, recorded
  per icon in `logos.json`:
  - Git Logo by Jason Long, CC BY 3.0.
  - Debian logo, Copyright Software in the Public Interest, CC BY-SA 3.0.
  - Let's Encrypt logo, Copyright ISRG, CC BY-NC 4.0 (fine for this non-commercial course).
  - `unspecified` means Simple Icons lists no licence for that icon, which does not make it CC0.
- Every logo is a trademark of its owner (Docker, F5/NGINX, the PostgreSQL Community Association,
  the OpenJS Foundation, VoidZero, GitHub, Google, Cloudflare, ISRG, Red Hat, SPI, the Software
  Freedom Conservancy, Alpine Linux, Linus Torvalds for Linux). They are used only to identify the
  technologies the course uses and imply no endorsement.
- Each generated SVG repeats these credits in a comment at its top.
