/**
 * Bug Squash Arena - end-to-end integration tests
 * ===============================================
 *
 * Black-box tests that talk HTTP to a RUNNING stack, exactly like a browser
 * would. They prove that the containers work TOGETHER: nginx serves the
 * frontend and proxies /api/ to the backend, the backend reaches Postgres,
 * cookies flow, the schema exists, anti-cheat rules hold...
 *
 * Unit tests (app/backend/test) answer "is my function correct?".
 * Integration tests answer "does the deployed system work?".
 *
 * Run:
 *     BASE_URL=http://localhost node --test tests/integration/api.test.mjs
 *
 * BASE_URL defaults to http://localhost: the production stack's nginx proxy
 * container on port 80 (docker-compose.prod.yml, as started by the ci-test
 * workflow) -> frontend / backend -> Postgres. Other targets:
 *     BASE_URL=http://localhost:5173      dev stack (Vite proxies /api/)
 *     BASE_URL=https://localhost NODE_TLS_REJECT_UNAUTHORIZED=0
 *                                         prod stack in HTTPS mode with a
 *                                         self-signed certificate (CI only!)
 * To test the bare API without any frontend in front of it, add API_ONLY=1:
 *     API_ONLY=1 BASE_URL=http://localhost:3000 node --test tests/integration/api.test.mjs
 *
 * Design notes
 *   - ZERO npm dependencies: node:test + node:assert + the global fetch() that
 *     ships with Node >= 18. Nothing to install, nothing to keep up to date.
 *   - Every run creates a UNIQUE user, so the tests can be re-run against the
 *     same database without "username taken" collisions.
 *   - Fewer than 15 requests hit the rate-limited /api/auth/{signup,login}
 *     routes (limit: AUTH_RATE_LIMIT_MAX, default 30 per 15 min per IP).
 *   - Tests inside the describe() block run IN ORDER and share state (the
 *     session cookie), like a real user journey: sign up -> log in -> play.
 *   - These tests create a user and scores. Point them at CI or staging; on
 *     production they would leave a test player on the leaderboard.
 */

import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------
const BASE_URL = (process.env.BASE_URL || 'http://localhost').replace(/\/+$/, '');
// API_ONLY=1 when BASE_URL is the backend itself (e.g. http://localhost:3000):
// there is no frontend there, so the HTML landing-page test is skipped.
const API_ONLY = ['1', 'true', 'yes'].includes(String(process.env.API_ONLY || '').toLowerCase());
const COOKIE_NAME = 'bugsquash_token';
const MAX_SCORE = 200; // server-side anti-cheat limit from the API contract
const REQUEST_TIMEOUT_MS = 10_000;
const READY_TIMEOUT_MS = 60_000;

// Usernames: 3-20 chars of [a-zA-Z0-9_]. "it_" + base36 timestamp (8 chars) +
// 4 random chars = 15 chars, unique per run.
const RUN_ID = Date.now().toString(36) + Math.random().toString(36).slice(2, 6).padEnd(4, '0');
const USERNAME = `it_${RUN_ID}`;
const PASSWORD = `Sq@sh-${RUN_ID}-pw`; // 8-72 chars

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Small fetch wrapper. Returns status, headers, raw text and parsed JSON (if
 * the response is JSON). `redirect: 'manual'` so we SEE redirects instead of
 * silently following them.
 */
async function request(method, path, { body, cookie, rawBody, accept = 'application/json' } = {}) {
  const headers = { Accept: accept };
  if (cookie) headers.Cookie = cookie;
  let payload;
  if (rawBody !== undefined) {
    headers['Content-Type'] = 'application/json';
    payload = rawBody;
  } else if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
    payload = JSON.stringify(body);
  }

  const res = await fetch(`${BASE_URL}${path}`, {
    method,
    headers,
    body: payload,
    redirect: 'manual',
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });

  const text = await res.text();
  let json;
  if ((res.headers.get('content-type') || '').includes('application/json') && text) {
    try {
      json = JSON.parse(text);
    } catch {
      json = undefined;
    }
  }
  return { status: res.status, headers: res.headers, text, json };
}

/** Human-friendly context for assertion messages. */
function describeResponse(res) {
  const snippet = res.text.length > 300 ? `${res.text.slice(0, 300)}...` : res.text;
  return `HTTP ${res.status} body: ${snippet || '<empty>'}`;
}

/**
 * Parse Set-Cookie headers by hand (no cookie-jar library).
 *
 *   "bugsquash_token=eyJ...; Max-Age=604800; Path=/; HttpOnly; SameSite=Lax"
 *   -> { name, value, attributes: { 'max-age': '604800', path: '/', httponly: true, ... } }
 *
 * Headers#getSetCookie() (Node >= 19.7) returns each Set-Cookie line separately;
 * a plain get('set-cookie') would join them with ", ", which is ambiguous
 * because Expires dates contain commas too.
 */
function parseSetCookies(headers) {
  const lines =
    typeof headers.getSetCookie === 'function'
      ? headers.getSetCookie()
      : [headers.get('set-cookie')].filter(Boolean);

  return lines.map((line) => {
    const [pair, ...attributeParts] = line.split(';');
    const eq = pair.indexOf('=');
    const attributes = {};
    for (const part of attributeParts) {
      const [key, ...rest] = part.split('=');
      attributes[key.trim().toLowerCase()] = rest.length ? rest.join('=').trim() : true;
    }
    return {
      name: pair.slice(0, eq).trim(),
      value: pair.slice(eq + 1).trim(),
      attributes,
    };
  });
}

/** Find our auth cookie in a response, or undefined. */
function findAuthCookie(res) {
  return parseSetCookies(res.headers).find((c) => c.name === COOKIE_NAME);
}

/** Turn a parsed cookie into a request "Cookie:" header value. */
function toCookieHeader(cookie) {
  return `${cookie.name}=${cookie.value}`;
}

/** Assert the auth cookie has the security attributes required by the contract. */
function assertSecureCookieAttributes(cookie) {
  assert.ok(cookie.value.length > 0, 'auth cookie must carry a token value');
  assert.equal(cookie.attributes.httponly, true, 'auth cookie must be HttpOnly (JS cannot steal it via XSS)');
  assert.equal(
    String(cookie.attributes.samesite).toLowerCase(),
    'lax',
    'auth cookie must be SameSite=Lax (CSRF mitigation)',
  );
  assert.equal(cookie.attributes.path, '/', 'auth cookie must be scoped to Path=/');
  // The "Secure" flag must match the scheme of the site (COOKIE_SECURE on the
  // backend). This test's fetch() would accept the cookie either way, but a
  // BROWSER drops a Secure cookie that arrives over plain http:// (logins
  // "don't stick"), and a cookie without Secure on an HTTPS site could leak
  // over an http:// link. So: http -> COOKIE_SECURE=false, https -> true.
  const expectSecure = BASE_URL.startsWith('https:');
  assert.equal(
    cookie.attributes.secure === true,
    expectSecure,
    expectSecure
      ? 'auth cookie must be Secure on an HTTPS site - set COOKIE_SECURE=true'
      : 'auth cookie must NOT be Secure on a plain-HTTP site (browsers would drop it) - set COOKIE_SECURE=false',
  );
}

/** Poll /api/health until the stack answers, so the suite can run right after a deploy. */
async function waitUntilReady() {
  const deadline = Date.now() + READY_TIMEOUT_MS;
  let lastError = 'no response yet';
  while (Date.now() < deadline) {
    try {
      const res = await request('GET', '/api/health');
      if (res.status === 200) return;
      lastError = describeResponse(res);
    } catch (err) {
      lastError = err.message;
    }
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
  throw new Error(`Stack at ${BASE_URL} not ready after ${READY_TIMEOUT_MS / 1000}s (last: ${lastError})`);
}

// ---------------------------------------------------------------------------
// The user journey
// ---------------------------------------------------------------------------
describe(`Bug Squash Arena @ ${BASE_URL}`, () => {
  /** Cookie header for the logged-in test user, set by signup/login tests. */
  let sessionCookie;
  let userId;

  before(waitUntilReady);

  // ---- Infrastructure --------------------------------------------------------

  it('GET /api/health reports the API and database as up', async () => {
    const res = await request('GET', '/api/health');
    assert.equal(res.status, 200, `health endpoint should be 200. ${describeResponse(res)}`);
    assert.ok(res.json, `health endpoint should return JSON. ${describeResponse(res)}`);
    assert.equal(res.json.status, 'ok');
    assert.equal(res.json.db, 'up', 'backend must be able to query Postgres');
    assert.equal(typeof res.json.version, 'string', 'health must expose the deployed version');
    assert.equal(typeof res.json.uptime, 'number', 'health must expose uptime in seconds');
  });

  // Skipped only when you EXPLICITLY say BASE_URL is the bare API (API_ONLY=1),
  // never auto-detected: a broken nginx route that sends "/" to the backend
  // must fail this test, not silently skip it.
  it('GET / serves the HTML landing page', { skip: API_ONLY && 'API_ONLY=1: BASE_URL is the bare API, no frontend' }, async () => {
    // Send the Accept header a browser sends. Vite's dev server only maps "/"
    // to index.html for clients that accept text/html (or */*); with
    // "Accept: application/json" it answers 404. nginx ignores Accept.
    const res = await request('GET', '/', { accept: 'text/html,application/xhtml+xml,*/*;q=0.8' });
    const apiHint = res.json?.error === 'Not found' ? ' (this looks like the backend itself - use API_ONLY=1 for API-only runs)' : '';
    assert.equal(res.status, 200, `landing page should be 200${apiHint}. ${describeResponse(res)}`);
    assert.match(res.headers.get('content-type') || '', /text\/html/, 'landing page must be served as text/html');
    assert.match(res.text, /Bug Squash/i, 'landing page should mention "Bug Squash"');
  });

  it('unknown /api/* routes return a JSON 404', async () => {
    const res = await request('GET', `/api/does-not-exist-${RUN_ID}`);
    assert.equal(res.status, 404, describeResponse(res));
    assert.equal(res.json?.error, 'Not found', 'unknown API routes should answer {"error":"Not found"}');
  });

  // ---- Sign up / log in ------------------------------------------------------

  it('POST /api/auth/signup rejects invalid input with 400', async () => {
    const res = await request('POST', '/api/auth/signup', {
      body: { username: 'x', password: 'short' },
    });
    assert.equal(res.status, 400, `too-short username/password must be rejected. ${describeResponse(res)}`);
    assert.equal(typeof res.json?.error, 'string', 'errors must be {"error": "<message>"}');
  });

  it('POST /api/auth/signup creates the user and sets the auth cookie', async () => {
    const res = await request('POST', '/api/auth/signup', {
      body: { username: USERNAME, password: PASSWORD },
    });
    assert.equal(res.status, 201, `signup should return 201. ${describeResponse(res)}`);
    assert.equal(res.json?.user?.username, USERNAME, 'response should echo the new username');
    assert.ok(Number.isInteger(res.json.user.id), 'user.id should be an integer');
    assert.equal(res.json.user.password_hash, undefined, 'the password hash must NEVER leave the server');

    const cookie = findAuthCookie(res);
    assert.ok(cookie, `signup must set the "${COOKIE_NAME}" cookie`);
    assertSecureCookieAttributes(cookie);

    userId = res.json.user.id;
    sessionCookie = toCookieHeader(cookie);
  });

  it('POST /api/auth/signup with the same name in another case returns 409', async () => {
    const res = await request('POST', '/api/auth/signup', {
      body: { username: USERNAME.toUpperCase(), password: PASSWORD },
    });
    assert.equal(res.status, 409, `usernames must be unique case-insensitively. ${describeResponse(res)}`);
    assert.equal(typeof res.json?.error, 'string');
  });

  it('POST /api/auth/login with a wrong password returns 401', async () => {
    const res = await request('POST', '/api/auth/login', {
      body: { username: USERNAME, password: `${PASSWORD}-wrong` },
    });
    assert.equal(res.status, 401, describeResponse(res));
    // Same message for "unknown user" and "wrong password": never tell an
    // attacker which usernames exist (user enumeration).
    assert.equal(res.json?.error, 'Invalid username or password');
    assert.equal(findAuthCookie(res), undefined, 'a failed login must not set a cookie');
  });

  it('POST /api/auth/login with correct credentials returns 200 and a fresh cookie', async () => {
    const res = await request('POST', '/api/auth/login', {
      body: { username: USERNAME, password: PASSWORD },
    });
    assert.equal(res.status, 200, `login should succeed. ${describeResponse(res)}`);
    assert.equal(res.json?.user?.id, userId, 'login should return the same user id as signup');
    assert.equal(res.json.user.username, USERNAME);

    const cookie = findAuthCookie(res);
    assert.ok(cookie, `login must set the "${COOKIE_NAME}" cookie`);
    assertSecureCookieAttributes(cookie);
    sessionCookie = toCookieHeader(cookie);
  });

  it('GET /api/auth/me returns the user when the cookie is sent', async () => {
    assert.ok(sessionCookie, 'precondition: an earlier test must have logged in');
    const res = await request('GET', '/api/auth/me', { cookie: sessionCookie });
    assert.equal(res.status, 200, describeResponse(res));
    assert.equal(res.json?.user?.id, userId, '/me should identify the logged-in user');
    assert.equal(res.json.user.username, USERNAME);
  });

  it('GET /api/auth/me without a cookie returns 401', async () => {
    const res = await request('GET', '/api/auth/me');
    assert.equal(res.status, 401, describeResponse(res));
  });

  it('GET /api/auth/me with a forged token returns 401', async () => {
    const res = await request('GET', '/api/auth/me', { cookie: `${COOKIE_NAME}=not.a.real-jwt` });
    assert.equal(res.status, 401, `tampered tokens must be rejected. ${describeResponse(res)}`);
  });

  // ---- Scores ----------------------------------------------------------------

  it('POST /api/scores without a cookie returns 401', async () => {
    const res = await request('POST', '/api/scores', { body: { score: 5 } });
    assert.equal(res.status, 401, describeResponse(res));
  });

  it(`POST /api/scores accepts the maximum legal score (${MAX_SCORE})`, async () => {
    const res = await request('POST', '/api/scores', { cookie: sessionCookie, body: { score: MAX_SCORE } });
    assert.equal(res.status, 201, `boundary value ${MAX_SCORE} must be accepted. ${describeResponse(res)}`);
    assert.equal(res.json?.score?.score, MAX_SCORE);
    assert.ok(Number.isInteger(res.json.score.id), 'score.id should be an integer');
    assert.ok(!Number.isNaN(Date.parse(res.json.score.createdAt)), 'score.createdAt should be a date string');
  });

  it('POST /api/scores saves a normal score with 201', async () => {
    const res = await request('POST', '/api/scores', { cookie: sessionCookie, body: { score: 17 } });
    assert.equal(res.status, 201, describeResponse(res));
    assert.equal(res.json?.score?.score, 17);
  });

  for (const cheat of [MAX_SCORE + 1, 9999]) {
    it(`POST /api/scores rejects impossible score ${cheat} with 422 (anti-cheat)`, async () => {
      const res = await request('POST', '/api/scores', { cookie: sessionCookie, body: { score: cheat } });
      assert.equal(res.status, 422, `scores above ${MAX_SCORE} must be refused. ${describeResponse(res)}`);
      assert.equal(typeof res.json?.error, 'string', 'anti-cheat response should explain itself');
    });
  }

  for (const [label, payload] of [
    ['-1', JSON.stringify({ score: -1 })],
    ['"abc"', JSON.stringify({ score: 'abc' })],
    ['3.5', JSON.stringify({ score: 3.5 })],
    ['a missing score', JSON.stringify({})],
  ]) {
    it(`POST /api/scores rejects ${label} with 400`, async () => {
      const res = await request('POST', '/api/scores', { cookie: sessionCookie, rawBody: payload });
      assert.equal(res.status, 400, `score must be a non-negative integer. ${describeResponse(res)}`);
      assert.equal(typeof res.json?.error, 'string');
    });
  }

  it('GET /api/scores/me reflects best score, games played and recent games', async () => {
    const res = await request('GET', '/api/scores/me', { cookie: sessionCookie });
    assert.equal(res.status, 200, describeResponse(res));
    assert.equal(res.json.best, MAX_SCORE, 'best should be the highest saved score');
    assert.equal(res.json.gamesPlayed, 2, 'only the 2 valid scores count - rejected ones must not be stored');
    assert.ok(Array.isArray(res.json.recent), 'recent should be an array');
    assert.deepEqual(
      res.json.recent.map((g) => g.score),
      [17, MAX_SCORE],
      'recent games must be ordered newest first',
    );
  });

  it('GET /api/scores/me without a cookie returns 401', async () => {
    const res = await request('GET', '/api/scores/me');
    assert.equal(res.status, 401, describeResponse(res));
  });

  it('GET /api/scores/leaderboard is public, sorted, and includes our player', async (t) => {
    const res = await request('GET', '/api/scores/leaderboard'); // no cookie on purpose
    assert.equal(res.status, 200, describeResponse(res));
    const board = res.json?.leaderboard;
    assert.ok(Array.isArray(board), 'leaderboard should be an array');
    assert.ok(board.length <= 10, `leaderboard is a top 10, got ${board.length} rows`);

    // Ranks: tied players may share a rank (SQL RANK(): 1, 1, 3) or not
    // (ROW_NUMBER(): 1, 2, 3) - both are fine. What must hold: the board is
    // sorted by best score, starts at rank 1, and a lower score never gets a
    // better rank.
    board.forEach((row, i) => {
      assert.equal(typeof row.username, 'string', `row ${i}: username should be a string`);
      assert.ok(Number.isInteger(row.best), `row ${i}: best should be an integer`);
      assert.ok(
        Number.isInteger(row.rank) && row.rank >= 1 && row.rank <= i + 1,
        `row ${i}: rank ${row.rank} should be an integer between 1 and ${i + 1}`,
      );
      if (i === 0) {
        assert.equal(row.rank, 1, 'the top row must have rank 1');
        return;
      }
      const prev = board[i - 1];
      assert.ok(prev.best >= row.best, 'leaderboard must be sorted by best score, descending');
      if (prev.best > row.best) {
        assert.ok(row.rank > prev.rank, `row ${i}: a lower score must have a higher rank number than row ${i - 1}`);
      } else {
        assert.ok(row.rank >= prev.rank, `row ${i}: ranks must never decrease down the board`);
      }
    });

    const me = board.find((row) => row.username === USERNAME);
    // Edge case: on a busy shared database, 10 other players may already sit at
    // the maximum score. Then we cannot make the board - that is not a bug.
    const boardFullOfMaxScores = board.length === 10 && board.every((row) => row.best >= MAX_SCORE);
    if (!me && boardFullOfMaxScores) {
      t.diagnostic('leaderboard already holds 10 players at the max score; inclusion check skipped');
      return;
    }
    assert.ok(me, `"${USERNAME}" (best ${MAX_SCORE}) should appear in the top 10`);
    assert.equal(me.best, MAX_SCORE);
  });

  // ---- Log out -----------------------------------------------------------------

  it('POST /api/auth/logout returns 204 and clears the cookie', async () => {
    const res = await request('POST', '/api/auth/logout', { cookie: sessionCookie });
    assert.equal(res.status, 204, describeResponse(res));

    const cookie = findAuthCookie(res);
    assert.ok(cookie, `logout must send a Set-Cookie for "${COOKIE_NAME}" to clear it`);
    const expires = cookie.attributes.expires ? Date.parse(cookie.attributes.expires) : NaN;
    const maxAge = cookie.attributes['max-age'] !== undefined ? Number(cookie.attributes['max-age']) : NaN;
    const cleared = cookie.value === '' || maxAge <= 0 || expires <= Date.now();
    assert.ok(cleared, `logout cookie should be empty or already expired, got: ${JSON.stringify(cookie)}`);
    // Note: a JWT is STATELESS - the server keeps no session list, so the old
    // token stays valid until it expires. Logout works by making the BROWSER
    // forget the cookie. (Real revocation needs a denylist or short-lived tokens.)
  });
});
