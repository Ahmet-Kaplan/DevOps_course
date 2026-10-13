/**
 * dom.js: small DOM helpers shared by every page.
 *
 * Rule of thumb used across this frontend: data that came from the network
 * (usernames, error messages, scores) is only ever inserted with textContent or
 * as text nodes, never by building HTML strings. That single habit is what
 * keeps a username like  <img src=x onerror=alert(1)>  from becoming XSS.
 * (The backend only allows [a-zA-Z0-9_] usernames anyway; defence in depth.)
 */

/**
 * Create an element. Props: `class`, `text`, `dataset`, `on<Event>` handlers,
 * and any other key becomes an attribute. Children may be nodes or strings
 * (strings become text nodes, so they are never parsed as HTML).
 *
 *   el('a', { class: 'btn', href: '/login.html' }, 'Log in')
 */
export function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value === undefined || value === null || value === false) continue;
    if (key === 'class') node.className = value;
    else if (key === 'text') node.textContent = value;
    else if (key === 'dataset') Object.assign(node.dataset, value);
    else if (key.startsWith('on') && typeof value === 'function') {
      node.addEventListener(key.slice(2).toLowerCase(), value);
    } else node.setAttribute(key, value === true ? '' : String(value));
  }
  node.append(...children.flat().filter((child) => child !== null && child !== undefined && child !== false));
  return node;
}

/** querySelector that fails loudly, so a typo in markup shows up immediately in dev. */
export function $(selector, root = document) {
  const node = root.querySelector(selector);
  if (!node) throw new Error(`Missing element: ${selector}`);
  return node;
}

const relativeTime = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });
const absoluteTime = new Intl.DateTimeFormat(undefined, {
  month: 'short',
  day: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
});

/** "just now", "5 minutes ago", "3 hours ago", or a short date for anything older. */
export function formatWhen(isoString, now = Date.now()) {
  const date = new Date(isoString);
  const seconds = Math.round((now - date.getTime()) / 1000);
  if (Number.isNaN(seconds)) return '';
  if (seconds < 45) return 'just now';
  if (seconds < 3600) return relativeTime.format(-Math.round(seconds / 60), 'minute');
  if (seconds < 86400) return relativeTime.format(-Math.round(seconds / 3600), 'hour');
  return absoluteTime.format(date);
}
