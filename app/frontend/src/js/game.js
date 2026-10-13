/**
 * game.js: the arena (a circuit board), the bug, the 10-second clock.
 *
 * The module knows nothing about accounts or the API. A page creates a game and
 * passes `onRoundEnd`, which decides what happens to the score:
 *   - landing page: practice mode, nothing is saved;
 *   - dashboard:    ranked mode, the score is POSTed to /api/scores.
 *
 * Timing design:
 *   - A single setTimeout(ROUND_MS) is the authority on when the round ends.
 *     requestAnimationFrame only *draws* the clock; browsers pause rAF in
 *     background tabs, and the round must still end on time.
 *   - The bug teleports on every hit and also on its own every HOP_START_MS,
 *     speeding up to HOP_END_MS by the end of the round.
 *
 * Input design (mouse, touch, pen and keyboard all count exactly once):
 *   - pointerdown on the bug counts a hit. Arcade games react on press, not on
 *     release; otherwise a bug that hops between press and release eats the click.
 *   - Keyboard: the bug is a real <button>, so Enter/Space fire a "click" whose
 *     event.detail is 0. Only those clicks are counted (mouse clicks have
 *     detail >= 1 and were already counted on pointerdown). Holding Enter down
 *     auto-repeats; repeated keydowns are ignored so a stuck key is not a strategy.
 *
 * Remember: none of this is anti-cheat. Anyone can POST any number with curl.
 * The real limit (MAX_SCORE = 200) is enforced by the backend.
 */
import { $, el } from './dom.js';

export const ROUND_MS = 10_000;
const HOP_START_MS = 1100;
const HOP_END_MS = 600;
const URGENT_MS = 3000;
/** Pixels kept free along the board edges (the mounting holes live there). */
const EDGE_GAP = 12;
/** After a round ends, ignore "Play again" for a moment so a player still mashing Enter doesn't restart by accident. */
const RESTART_COOLDOWN_MS = 800;

/** Every bug has a species, shown in the "+1" splat. Several are lessons in disguise. */
const BUG_SPECIES = [
  'off-by-one',
  'race condition',
  'memory leak',
  'flaky test',
  "DNS (it's always DNS)",
  'merge conflict',
  'YAML indentation',
  'expired TLS cert',
  'zombie process',
  'OOMKilled container',
  'port already in use',
  'secret in git history',
  'null pointer',
  'timezone bug',
  'dangling image',
  'cache invalidation',
];

/* Inline SVG, so the bug inherits colors from CSS custom properties (and works with a strict CSP). */
const BUG_SVG = `
<svg class="bug-art" viewBox="0 0 64 64" aria-hidden="true" focusable="false">
  <g class="bug-art__legs" fill="none" stroke-width="3.5" stroke-linecap="round" stroke-linejoin="round">
    <path d="M21 29 13 23 8 25M19 38H9l-4 4M21 47l-9 7-3 5"/>
    <path d="M43 29l8-6 5 2M45 38h10l4 4M43 47l9 7 3 5"/>
  </g>
  <path class="bug-art__antennae" d="M28 12Q24 3 17 4M36 12Q40 3 47 4" fill="none" stroke-width="3" stroke-linecap="round"/>
  <ellipse class="bug-art__head" cx="32" cy="17" rx="8" ry="6.5"/>
  <ellipse class="bug-art__shell" cx="32" cy="38" rx="14.5" ry="18"/>
  <path class="bug-art__seam" d="M32 22v33" fill="none" stroke-width="2"/>
  <g class="bug-art__spots">
    <circle cx="25.5" cy="32" r="3"/><circle cx="38.5" cy="32" r="3"/>
    <circle cx="25" cy="44" r="2.5"/><circle cx="39" cy="44" r="2.5"/>
  </g>
  <g class="bug-art__eyes"><circle cx="28.5" cy="15.5" r="1.6"/><circle cx="35.5" cy="15.5" r="1.6"/></g>
</svg>`;

/* Decorative printed circuit board drawn behind the bug. Purely visual (aria-hidden). */
const BOARD_ART = `
<svg class="game__art" viewBox="0 0 480 300" preserveAspectRatio="xMidYMid slice" aria-hidden="true" focusable="false">
  <g class="pcb__traces" fill="none" stroke-width="4" stroke-linecap="round" stroke-linejoin="round">
    <path d="M0 52h128l24 24h132l22-22h174"/>
    <path d="M0 236h96l30-30h104"/>
    <path d="M480 228H364l-30 30H212l-22 22v20"/>
    <path d="M70 0v96l22 22v182"/>
    <path d="M398 0v78l-22 22v84l22 22v94"/>
    <path d="M206 76v36M262 76v36M234 176v30"/>
  </g>
  <g class="pcb__chip">
    <rect class="pcb__chip-body" x="190" y="120" width="88" height="48" rx="4"/>
    <g class="pcb__pad">
      <rect x="198" y="111" width="6" height="9"/><rect x="212" y="111" width="6" height="9"/>
      <rect x="226" y="111" width="6" height="9"/><rect x="240" y="111" width="6" height="9"/>
      <rect x="254" y="111" width="6" height="9"/><rect x="268" y="111" width="6" height="9"/>
      <rect x="198" y="168" width="6" height="9"/><rect x="212" y="168" width="6" height="9"/>
      <rect x="226" y="168" width="6" height="9"/><rect x="240" y="168" width="6" height="9"/>
      <rect x="254" y="168" width="6" height="9"/><rect x="268" y="168" width="6" height="9"/>
    </g>
    <circle class="pcb__chip-dot" cx="200" cy="130" r="3"/>
  </g>
  <g class="pcb__parts">
    <rect x="30" y="150" width="28" height="12" rx="2"/>
    <rect x="412" y="148" width="14" height="24" rx="2"/>
    <rect x="300" y="18" width="24" height="12" rx="2"/>
  </g>
  <g class="pcb__pad">
    <rect x="23" y="151" width="7" height="10"/><rect x="58" y="151" width="7" height="10"/>
    <rect x="414" y="141" width="10" height="7"/><rect x="414" y="172" width="10" height="7"/>
    <rect x="293" y="19" width="7" height="10"/><rect x="324" y="19" width="7" height="10"/>
  </g>
  <g class="pcb__vias">
    <circle cx="152" cy="76" r="6"/><circle cx="284" cy="76" r="6"/><circle cx="92" cy="118" r="6"/>
    <circle cx="376" cy="100" r="6"/><circle cx="230" cy="206" r="6"/><circle cx="334" cy="258" r="6"/>
    <circle cx="126" cy="206" r="6"/>
  </g>
  <g class="pcb__silk">
    <text x="284" y="150">U1</text>
    <text x="28" y="144">R12</text>
    <text x="432" y="164">C7</text>
    <text x="22" y="284">bug-squash-arena rev 1.0</text>
  </g>
</svg>`;

/*
 * innerHTML is acceptable here ONLY because this is a constant string written by
 * us, with no data from users or the network in it. Dynamic text goes through
 * textContent (see dom.js).
 */
const TEMPLATE = `
  <div class="game__hud">
    <p class="game__stat"><span class="game__label">Time</span> <span class="game__value" data-time>10.0</span></p>
    <p class="game__stat game__stat--score"><span class="game__label">Squashed</span> <span class="game__value" data-score>0</span></p>
  </div>
  <div class="game__fuse" aria-hidden="true"><span class="game__fuse-fill" data-fuse></span></div>
  <div class="game__board" data-board>
    ${BOARD_ART}
    <button class="bug" type="button" data-bug hidden aria-label="Squash the bug">${BUG_SVG}</button>
    <div class="game__overlay" data-overlay>
      <p class="game__overlay-title" data-overlay-title></p>
      <p class="game__overlay-text" data-overlay-text></p>
      <button class="btn btn--primary btn--large" type="button" data-start></button>
    </div>
  </div>
  <p class="visually-hidden" aria-live="polite" data-status></p>
`;

const clamp01 = (value) => Math.min(1, Math.max(0, value));
const pick = (list) => list[Math.floor(Math.random() * list.length)];

/**
 * Mount a game inside `root`.
 *
 * @param {HTMLElement} root
 * @param {object} options
 * @param {{title: string, text: string, button: string}} options.intro  Overlay shown before the first round.
 * @param {(result: {score: number, misses: number, accuracy: number | null}) =>
 *          Promise<{title: string, text: string, tone?: 'error'}> | {title: string, text: string, tone?: 'error'}} options.onRoundEnd
 *        Called when the clock hits zero. Whatever it returns is shown on the board.
 */
export function createGame(root, { intro, onRoundEnd }) {
  root.innerHTML = TEMPLATE;
  const ui = {
    time: $('[data-time]', root),
    score: $('[data-score]', root),
    fuse: $('[data-fuse]', root),
    board: $('[data-board]', root),
    bug: $('[data-bug]', root),
    overlay: $('[data-overlay]', root),
    overlayTitle: $('[data-overlay-title]', root),
    overlayText: $('[data-overlay-text]', root),
    start: $('[data-start]', root),
    status: $('[data-status]', root),
  };

  let running = false;
  let score = 0;
  let misses = 0;
  let endsAt = 0;
  let restartLockedUntil = 0;
  let rafId = 0;
  let endTimer = 0;
  let hopTimer = 0;
  let position = { x: 0, y: 0 };
  let species = pick(BUG_SPECIES);

  showOverlay({ title: intro.title, text: intro.text, button: intro.button });

  /* ---------------------------------------------------------------- round lifecycle */

  function start() {
    if (running || performance.now() < restartLockedUntil) return;
    running = true;
    score = 0;
    misses = 0;
    endsAt = performance.now() + ROUND_MS;

    ui.score.textContent = '0';
    ui.overlay.hidden = true;
    ui.bug.hidden = false;
    root.classList.add('is-running');

    teleport();
    scheduleHop();
    endTimer = setTimeout(finish, ROUND_MS);
    rafId = requestAnimationFrame(drawClock);

    // Keyboard and screen-reader users land on the bug and can start pressing Enter.
    ui.bug.focus({ preventScroll: true });
    announce('Round started. Ten seconds on the clock.');
  }

  async function finish() {
    if (!running) return;
    running = false;
    clearTimeout(endTimer);
    clearTimeout(hopTimer);
    cancelAnimationFrame(rafId);

    root.classList.remove('is-running', 'is-urgent');
    ui.time.textContent = '0.0';
    ui.fuse.style.setProperty('--fuse', '0');
    ui.bug.hidden = true;
    restartLockedUntil = performance.now() + RESTART_COOLDOWN_MS;

    const attempts = score + misses;
    const result = { score, misses, accuracy: attempts === 0 ? null : score / attempts };

    showOverlay({ title: 'Time!', text: 'Counting squashed bugs…', button: 'Saving…', busy: true });

    let outcome;
    try {
      outcome = await onRoundEnd(result);
    } catch (error) {
      outcome = { title: 'Round over', text: error.message, tone: 'error' };
    }

    showOverlay({ ...outcome, button: 'Play again' });
    announce(`${outcome.title}. ${outcome.text}`);
    ui.start.focus({ preventScroll: true });
  }

  function drawClock(now) {
    const remaining = Math.max(0, endsAt - now);
    ui.time.textContent = (remaining / 1000).toFixed(1);
    ui.fuse.style.setProperty('--fuse', String(remaining / ROUND_MS));
    root.classList.toggle('is-urgent', remaining <= URGENT_MS);
    if (running) rafId = requestAnimationFrame(drawClock);
  }

  /* ---------------------------------------------------------------- the bug */

  function hit() {
    score += 1;
    ui.score.textContent = String(score);
    splat();
    teleport();
    scheduleHop(); // fresh timer, so the bug never hops right after a hit
  }

  /** Move the bug to a random spot far enough from the last one, facing where it went. */
  function teleport() {
    const size = ui.bug.offsetWidth;
    const maxX = Math.max(0, ui.board.clientWidth - size - EDGE_GAP * 2);
    const maxY = Math.max(0, ui.board.clientHeight - size - EDGE_GAP * 2);
    const minJump = Math.min(maxX, maxY) * 0.35;

    let x;
    let y;
    let tries = 0;
    do {
      x = EDGE_GAP + Math.random() * maxX;
      y = EDGE_GAP + Math.random() * maxY;
      tries += 1;
    } while (tries < 12 && Math.hypot(x - position.x, y - position.y) < minJump);

    // The artwork faces up (0deg); atan2 measures from the x-axis, hence +90.
    const angle = (Math.atan2(y - position.y, x - position.x) * 180) / Math.PI + 90;
    position = { x, y };
    species = pick(BUG_SPECIES);

    // Only custom properties change here; CSS turns them into a transform,
    // which the browser can move on the compositor without re-layout.
    ui.bug.style.setProperty('--x', `${x.toFixed(1)}px`);
    ui.bug.style.setProperty('--y', `${y.toFixed(1)}px`);
    ui.bug.style.setProperty('--r', `${angle.toFixed(0)}deg`);
  }

  function scheduleHop() {
    clearTimeout(hopTimer);
    const elapsed = clamp01(1 - (endsAt - performance.now()) / ROUND_MS);
    const delay = HOP_START_MS - (HOP_START_MS - HOP_END_MS) * elapsed;
    hopTimer = setTimeout(() => {
      if (!running) return;
      teleport();
      scheduleHop();
    }, delay);
  }

  /** A "+1 <species>" mark where the bug was hit. Decorative, hidden from screen readers. */
  function splat() {
    const half = ui.bug.offsetWidth / 2;
    const mark = el(
      'span',
      { class: 'splat', 'aria-hidden': 'true' },
      el('span', { class: 'splat__mark' }),
      el('span', { class: 'splat__text', text: `+1 ${species}` }),
    );
    mark.style.setProperty('--x', `${(position.x + half).toFixed(1)}px`);
    mark.style.setProperty('--y', `${(position.y + half).toFixed(1)}px`);
    ui.board.append(mark);
    setTimeout(() => mark.remove(), 750);
  }

  /* ---------------------------------------------------------------- overlay + announcements */

  function showOverlay({ title, text, button, tone, busy = false }) {
    ui.overlay.hidden = false;
    ui.overlay.dataset.tone = tone ?? 'normal';
    ui.overlayTitle.textContent = title;
    ui.overlayText.textContent = text;
    ui.start.textContent = button;
    ui.start.disabled = busy;
  }

  /** Write to the polite live region. Clearing first makes repeated messages re-announce. */
  function announce(message) {
    ui.status.textContent = '';
    setTimeout(() => {
      ui.status.textContent = message;
    }, 50);
  }

  /* ---------------------------------------------------------------- input */

  ui.start.addEventListener('click', start);

  ui.bug.addEventListener('pointerdown', (event) => {
    if (!running || event.button !== 0) return; // primary button, finger or pen only
    event.stopPropagation(); // a hit is not a miss
    hit();
  });

  ui.bug.addEventListener('click', (event) => {
    if (running && event.detail === 0) hit(); // keyboard activation (Enter / Space)
  });

  ui.bug.addEventListener('keydown', (event) => {
    if (event.repeat && (event.key === 'Enter' || event.key === ' ')) event.preventDefault();
  });

  ui.board.addEventListener('pointerdown', (event) => {
    if (running && event.button === 0) misses += 1;
  });

  // Long-press on touch screens opens a context menu; not helpful mid-round.
  ui.board.addEventListener('contextmenu', (event) => {
    if (running) event.preventDefault();
  });

  // Rotating a phone mid-round changes the board size: keep the bug inside it.
  new ResizeObserver(() => {
    if (running) teleport();
  }).observe(ui.board);

  return {
    start,
    get running() {
      return running;
    },
  };
}
