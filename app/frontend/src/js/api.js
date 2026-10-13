/**
 * api.js: the only module that talks HTTP.
 *
 * Every request goes to a RELATIVE path (/api/...). The browser therefore sends
 * it to whichever origin served the page:
 *   - local dev:  http://localhost:5173/api/...  -> Vite dev server proxy -> backend:3000
 *   - CI / Docker: http://localhost:8080/api/... -> frontend nginx proxy  -> backend:3000
 *   - production: https://devops.gulfheight.com/api/... -> edge proxy     -> backend:3000
 *
 * Because the page and the API share one origin, there is no CORS to configure,
 * and the httpOnly auth cookie (bugsquash_token) is sent automatically. The
 * JavaScript on the page never sees the token itself, so an XSS bug could not
 * steal it with document.cookie.
 */

const API_BASE = '/api';

/** Error type for every failed API call. `status` is 0 when the network failed. */
export class ApiError extends Error {
  constructor(message, { status = 0, data = null } = {}) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.data = data;
  }
}

/** Fallback messages for responses that carry no {"error": "..."} body. */
function fallbackMessage(status) {
  if (status === 401) return 'Your session has expired. Log in again.';
  if (status === 404) return 'That API endpoint does not exist.';
  if (status === 429) return 'Too many requests. Wait a few minutes and try again.';
  // 502/503/504 come from a proxy (Vite or nginx) that couldn't reach the backend.
  if (status >= 502 && status <= 504) return `The API is not reachable right now (HTTP ${status}). Try again in a moment.`;
  if (status >= 500) return `The server had a problem (HTTP ${status}). Try again in a moment.`;
  return `The request failed (HTTP ${status}).`;
}

/**
 * Send one JSON request and return the parsed JSON body (or null for 204).
 * Throws ApiError for network failures and for any non-2xx status.
 */
async function request(path, { method = 'GET', body, signal } = {}) {
  const init = {
    method,
    headers: { Accept: 'application/json' },
    // 'same-origin' is fetch()'s default; it is spelled out because cookie auth
    // depends on it. It sends cookies to our own origin and never to others.
    credentials: 'same-origin',
    signal,
  };
  if (body !== undefined) {
    init.headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(body);
  }

  let response;
  try {
    response = await fetch(`${API_BASE}${path}`, init);
  } catch (error) {
    if (error.name === 'AbortError') throw error;
    // fetch() only rejects when no HTTP response arrived at all: DNS failure,
    // connection refused, offline laptop...
    throw new ApiError("Can't reach the server. Check your connection and try again.");
  }

  if (response.status === 204) return null;

  const isJson = (response.headers.get('content-type') || '').includes('application/json');
  const data = isJson ? await response.json().catch(() => null) : null;

  if (!response.ok) {
    const message = (data && typeof data.error === 'string' && data.error) || fallbackMessage(response.status);
    throw new ApiError(message, { status: response.status, data });
  }
  return data;
}

/** One function per endpoint in the API contract. */
export const api = {
  health: () => request('/health'),

  me: () => request('/auth/me'),
  signup: (username, password) =>
    request('/auth/signup', { method: 'POST', body: { username, password } }),
  login: (username, password) =>
    request('/auth/login', { method: 'POST', body: { username, password } }),
  logout: () => request('/auth/logout', { method: 'POST' }),

  submitScore: (score) => request('/scores', { method: 'POST', body: { score } }),
  myScores: () => request('/scores/me'),
  leaderboard: () => request('/scores/leaderboard'),
};

/**
 * Who is logged in? Resolves to {id, username}, or null when there is no valid
 * session (HTTP 401). Any other failure (API down, 500...) is re-thrown so the
 * caller can tell "logged out" apart from "could not check".
 */
export async function getCurrentUser() {
  try {
    const { user } = await api.me();
    return user;
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) return null;
    throw error;
  }
}
