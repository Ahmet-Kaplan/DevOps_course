/**
 * leaderboard.js: fetch and render the public top-10 table.
 * Used by both the landing page and the dashboard.
 */
import { api } from './api.js';
import { el } from './dom.js';

/**
 * Load the leaderboard into `container`, handling the loading, empty and error
 * states. Pass `highlight` (a username) to mark the current player's row.
 */
export async function loadLeaderboard(container, { highlight } = {}) {
  container.setAttribute('aria-busy', 'true');
  if (!container.hasChildNodes()) {
    container.replaceChildren(el('p', { class: 'empty', text: 'Loading the leaderboard…' }));
  }

  try {
    const { leaderboard } = await api.leaderboard();
    container.replaceChildren(renderTable(leaderboard, highlight));
  } catch (error) {
    container.replaceChildren(
      el(
        'div',
        { class: 'notice notice--error' },
        el('p', { text: `The leaderboard didn't load: ${error.message}` }),
        el('button', {
          class: 'btn btn--secondary btn--small',
          type: 'button',
          text: 'Try again',
          onClick: () => loadLeaderboard(container, { highlight }),
        }),
      ),
    );
  } finally {
    container.removeAttribute('aria-busy');
  }
}

function renderTable(entries, highlight) {
  if (!entries || entries.length === 0) {
    return el('p', { class: 'empty', text: 'No scores yet. The bugs are winning. Play a round to claim first place.' });
  }

  const me = highlight?.toLowerCase();
  const rows = entries.map((entry) => {
    const isMe = me && entry.username.toLowerCase() === me;
    return el(
      'tr',
      { class: isMe ? 'scoreboard__row scoreboard__row--me' : 'scoreboard__row', 'data-rank': entry.rank },
      el('td', { class: 'scoreboard__rank', text: String(entry.rank) }),
      el(
        'td',
        { class: 'scoreboard__player' },
        entry.username,
        isMe ? el('span', { class: 'scoreboard__you', text: ' (you)' }) : null,
      ),
      el('td', { class: 'scoreboard__best', text: String(entry.best) }),
    );
  });

  return el(
    'table',
    { class: 'scoreboard' },
    el('caption', { class: 'visually-hidden', text: 'Top players ranked by their best round' }),
    el(
      'thead',
      {},
      el(
        'tr',
        {},
        el('th', { scope: 'col', class: 'scoreboard__rank', text: 'Rank' }),
        el('th', { scope: 'col', text: 'Player' }),
        el('th', { scope: 'col', class: 'scoreboard__best', text: 'Best' }),
      ),
    ),
    el('tbody', {}, rows),
  );
}
