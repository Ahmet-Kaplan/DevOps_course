/**
 * Entry module for the landing page (/).
 * Public page: shows the leaderboard and a practice arena. If a session cookie
 * is present, the sign-up CTAs become a single "Enter the arena" button.
 */
import { getCurrentUser } from './api.js';
import { $, el } from './dom.js';
import { createGame } from './game.js';
import { initLayout, renderNav } from './layout.js';
import { loadLeaderboard } from './leaderboard.js';
import { bugs, roundVerdict } from './ranks.js';

initLayout();

let user = null;
try {
  user = await getCurrentUser();
} catch {
  // API down: treat the visitor as logged out. The footer already says "offline".
}

renderNav(user);
if (user) showWelcomeBack(user);

loadLeaderboard($('[data-leaderboard]'), { highlight: user?.username });

createGame($('[data-game="practice"]'), {
  intro: {
    title: 'Practice round',
    text: 'One bug, ten seconds. Practice scores are not saved.',
    button: 'Start practice round',
  },
  onRoundEnd: ({ score }) => ({
    title: `${bugs(score)} squashed`,
    text: `${roundVerdict(score)} ${
      user
        ? 'Practice is over: play in the arena to put it on the leaderboard.'
        : 'Create an account to put scores like this on the leaderboard.'
    }`,
  }),
});

function showWelcomeBack({ username }) {
  $('[data-hero-actions]').replaceChildren(
    el('a', { class: 'btn btn--primary btn--large', href: '/dashboard.html', text: 'Enter the arena' }),
    el('p', { class: 'hero__welcome', text: `Welcome back, @${username}.` }),
  );
}
