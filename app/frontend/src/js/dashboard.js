/**
 * Entry module for /dashboard.html (protected).
 *
 * Flow:
 *   1. GET /api/auth/me. 401 -> redirect to /login.html (replace(), so the Back
 *      button doesn't bounce the user straight back here).
 *   2. Render the arena in ranked mode and load stats + leaderboard in parallel.
 *   3. After each round: POST /api/scores, then refresh stats and leaderboard.
 */
import { api, ApiError, getCurrentUser } from './api.js';
import { $, el, formatWhen } from './dom.js';
import { createGame } from './game.js';
import { initLayout, renderNav } from './layout.js';
import { loadLeaderboard } from './leaderboard.js';
import { bugs, rankFor, roundVerdict } from './ranks.js';

/** Shown if the server rejects a score but sends no message of its own. */
const ANTI_CHEAT_FALLBACK =
  'The server says no human squashes that many bugs in ten seconds. Nice try, though.';

const pageStatus = $('[data-page-status]');
const dashboard = $('[data-dashboard]');
const leaderboardBox = $('[data-leaderboard]');

let user = null;
/** Best score as last reported by the server; used to spot personal bests and promotions. */
let knownBest = 0;

initLayout();
await main();

async function main() {
  try {
    user = await getCurrentUser();
  } catch (error) {
    pageStatus.textContent = `Can't check your session right now: ${error.message}`;
    pageStatus.classList.add('page-status--error');
    return;
  }

  if (!user) {
    window.location.replace('/login.html');
    return;
  }

  renderNav(user, { onDashboard: true });
  $('[data-username]').textContent = `@${user.username}`;
  pageStatus.hidden = true;
  dashboard.hidden = false;

  createGame($('[data-game="ranked"]'), {
    intro: {
      title: 'Ready when you are',
      text: 'One bug, ten seconds. Every round counts toward your badge.',
      button: 'Start round',
    },
    onRoundEnd: saveRound,
  });

  await Promise.all([refreshStats(), loadLeaderboard(leaderboardBox, { highlight: user.username })]);
}

/** Called by the game when the clock hits zero. Returns what the board should say. */
async function saveRound({ score, accuracy }) {
  try {
    await api.submitScore(score);
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) {
      window.location.replace('/login.html');
      return { title: 'Session expired', text: 'Log in again to keep playing.' };
    }
    if (error instanceof ApiError && error.status === 422) {
      // 422 = the request was well-formed but the score is impossible (> MAX_SCORE).
      // This only ever happens when someone edits the request, which is the lesson:
      // the server, not the browser, decides what is valid.
      return { title: 'Anti-cheat tripped', text: error.data?.error || ANTI_CHEAT_FALLBACK, tone: 'error' };
    }
    return { title: 'Score not saved', text: error.message, tone: 'error' };
  }

  const previousBest = knownBest;
  const notes = [roundVerdict(score)];
  if (score > previousBest && score > 0) {
    const before = rankFor(previousBest).current.title;
    const after = rankFor(score).current.title;
    notes.push(before === after ? 'New personal best.' : `New personal best. Promoted to ${after}.`);
  }
  if (accuracy !== null && score > 0) notes.push(`Accuracy ${Math.round(accuracy * 100)}%.`);

  // Refresh in the background; the result message should not wait for it.
  refreshStats();
  loadLeaderboard(leaderboardBox, { highlight: user.username });

  return { title: `${bugs(score)} squashed`, text: notes.join(' ') };
}

/* ------------------------------------------------------------------ stats */

async function refreshStats() {
  try {
    const stats = await api.myScores();
    knownBest = stats.best;
    renderBadge(stats);
    renderRecent(stats.recent);
  } catch (error) {
    $('[data-recent]').replaceChildren(
      el('li', { class: 'logbook__empty' }, el('span', { class: 'notice notice--error', text: `Stats didn't load: ${error.message}` })),
    );
  }
}

function renderBadge({ best, gamesPlayed }) {
  const { current, next, toNext, progress } = rankFor(best);
  $('[data-best]').textContent = String(best);
  $('[data-games]').textContent = String(gamesPlayed);
  $('[data-rank-title]').textContent = current.title;
  $('[data-rank-motto]').textContent = current.motto;
  $('[data-rank-meter]').style.setProperty('--fill', progress.toFixed(3));
  $('[data-rank-next]').textContent = next
    ? `${toNext} more for ${next.title}.`
    : 'Top rank. There is nowhere left to climb.';
}

function renderRecent(recent) {
  const list = $('[data-recent]');
  if (!recent || recent.length === 0) {
    list.replaceChildren(
      el('li', { class: 'logbook__empty', text: 'No rounds yet. Press Start round to squash your first bug.' }),
    );
    return;
  }
  list.replaceChildren(
    ...recent.map((round) =>
      el(
        'li',
        { class: 'logbook__entry' },
        el('time', { class: 'logbook__time', datetime: round.createdAt, text: formatWhen(round.createdAt) }),
        el('span', { class: 'logbook__score', text: `${bugs(round.score)} squashed` }),
      ),
    ),
  );
}
