/**
 * layout.js: the header navigation and footer shared by every page.
 *
 * The footer is the "did my deploy land?" indicator for the course:
 *   - Web: the version baked into THIS bundle at build time. CI passes the git
 *     short SHA as the Docker build arg VITE_APP_VERSION; Vite replaces
 *     import.meta.env.VITE_APP_VERSION with that literal string during the build.
 *   - API: the version the RUNNING backend reports from GET /api/health
 *     (its APP_VERSION env var, also set from the git SHA).
 * After a deploy both should show the new 7-character short SHA (e.g. 1a2b3c4,
 * the same hash as the sha-1a2b3c4 image tag). If only one changed,
 * one of the containers was not recreated.
 */
import { api, ApiError } from './api.js';
import { el } from './dom.js';

/**
 * Only variables prefixed VITE_ are exposed to browser code, and they end up in
 * the public JavaScript bundle: never put a secret in a VITE_ variable.
 */
export const WEB_VERSION = import.meta.env.VITE_APP_VERSION || 'dev';

/** Render the footer and start the API health check. Call once per page. */
export function initLayout() {
  const footer = document.querySelector('[data-site-footer]');
  if (!footer) return;

  const apiValue = el('span', { class: 'versions__value', text: 'checking…' });
  const apiState = el('span', { class: 'versions__state', dataset: { state: 'pending' } });

  footer.replaceChildren(
    el(
      'div',
      { class: 'site-footer__inner' },
      el('p', { class: 'site-footer__note', text: 'No production systems were harmed. Several bugs were.' }),
      el(
        'dl',
        { class: 'versions', 'aria-label': 'Deployed versions' },
        el(
          'div',
          { class: 'versions__item' },
          el('dt', { text: 'Web' }),
          el('dd', {}, el('span', { class: 'versions__value', text: WEB_VERSION })),
        ),
        el('div', { class: 'versions__item' }, el('dt', { text: 'API' }), el('dd', {}, apiValue, apiState)),
      ),
    ),
  );

  showApiVersion(apiValue, apiState);
}

async function showApiVersion(valueNode, stateNode) {
  const setState = (state, label) => {
    stateNode.dataset.state = state;
    stateNode.textContent = label;
  };
  try {
    const health = await api.health();
    valueNode.textContent = health.version ?? 'unknown';
    setState('up', 'healthy');
  } catch (error) {
    // A 503 from /api/health still carries the version: the API is running but
    // something behind it (usually the database) is not. The endpoint does not
    // say what, on purpose; operators read the reason in `docker compose logs`.
    if (error instanceof ApiError && error.data?.version) {
      valueNode.textContent = error.data.version;
      setState('degraded', 'degraded');
    } else {
      valueNode.textContent = 'unreachable';
      setState('down', 'offline');
    }
  }
}

/**
 * Swap the header navigation for a logged-in user. With `user === null` the
 * logged-out links already in the HTML are kept, so the header never flashes.
 *
 * @param {{username: string} | null} user
 * @param {{ onDashboard?: boolean }} [options]
 */
export function renderNav(user, { onDashboard = false } = {}) {
  const nav = document.querySelector('[data-site-nav]');
  if (!nav || !user) return;

  const logoutButton = el('button', {
    class: 'btn btn--ghost btn--small',
    type: 'button',
    text: 'Log out',
    onClick: async () => {
      logoutButton.disabled = true;
      try {
        await api.logout();
      } catch {
        // Even if the request failed we leave: the worst case is a stale cookie
        // that expires on its own, and the user clearly wants to go.
      }
      window.location.assign('/');
    },
  });

  const items = [el('span', { class: 'site-nav__user', text: `@${user.username}` })];
  if (!onDashboard) items.push(el('a', { class: 'btn btn--primary btn--small', href: '/dashboard.html', text: 'Arena' }));
  items.push(logoutButton);
  nav.replaceChildren(...items);
}
