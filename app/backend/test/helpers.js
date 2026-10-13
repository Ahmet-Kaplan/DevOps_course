'use strict';

/**
 * Shared test helpers (not a *.test.js file, so the runner does not execute it).
 *
 * The fake database implements the same methods as src/db.js but keeps data
 * in arrays. Because createApp() receives its db as a parameter, the tests
 * exercise the REAL Express app — routing, validation, cookies, JWTs, rate
 * limiting — with zero infrastructure. The real SQL is covered by the
 * integration tests (tests/integration) that CI runs against Postgres.
 */

const http = require('node:http');

const { createApp } = require('../src/app');
const { loadConfig } = require('../src/config');

const silentLogger = { info() {}, warn() {}, error() {} };

function createFakeDb() {
  const state = { healthy: true, users: [], scores: [], nextUserId: 1, nextScoreId: 1 };
  const findUser = (id) => state.users.find((u) => u.id === id);

  return {
    state,
    async migrate() {},
    async close() {},
    async ping() {
      if (!state.healthy) throw new Error('connect ECONNREFUSED (fake)');
    },
    async createUser(username, passwordHash) {
      if (state.users.some((u) => u.username.toLowerCase() === username.toLowerCase())) return null;
      const user = { id: state.nextUserId++, username, passwordHash };
      state.users.push(user);
      return { id: user.id, username: user.username };
    },
    async findUserByUsername(username) {
      const user = state.users.find((u) => u.username.toLowerCase() === username.toLowerCase());
      return user ? { ...user } : null;
    },
    async findUserById(id) {
      const user = findUser(id);
      return user ? { id: user.id, username: user.username } : null;
    },
    async insertScore(userId, score) {
      if (!findUser(userId)) return null;
      const row = { id: state.nextScoreId++, userId, score, createdAt: new Date() };
      state.scores.push(row);
      return { id: row.id, score: row.score, createdAt: row.createdAt };
    },
    async getUserStats(userId) {
      const mine = state.scores.filter((s) => s.userId === userId);
      return {
        best: mine.reduce((max, s) => Math.max(max, s.score), 0),
        gamesPlayed: mine.length,
        recent: mine
          .slice()
          .sort((a, b) => b.id - a.id)
          .slice(0, 10)
          .map((s) => ({ id: s.id, score: s.score, createdAt: s.createdAt })),
      };
    },
    async getLeaderboard(limit = 10) {
      const bestByUser = new Map();
      for (const s of state.scores) {
        bestByUser.set(s.userId, Math.max(bestByUser.get(s.userId) ?? 0, s.score));
      }
      const rows = [...bestByUser]
        .map(([userId, best]) => ({ username: findUser(userId).username, best }))
        .sort((a, b) => b.best - a.best || a.username.localeCompare(b.username));
      // Same semantics as SQL RANK(): ties share a rank, the next rank skips.
      return rows.slice(0, limit).map((row) => ({
        rank: rows.findIndex((r) => r.best === row.best) + 1,
        ...row,
      }));
    },
  };
}

function testConfig(overrides = {}) {
  return loadConfig({ NODE_ENV: 'test', JWT_SECRET: 'unit-test-secret', APP_VERSION: 'test-1.2.3', ...overrides });
}

/** Start the app on a random free port (port 0) and return a tiny API client. */
async function startTestServer({ db = createFakeDb(), config = testConfig() } = {}) {
  const app = createApp({ db, config, logger: silentLogger });
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  /**
   * request('POST', '/api/auth/login', { body, cookie, headers, rawBody })
   * -> { status, body, headers, cookie } where `cookie` is the bugsquash_token
   * Set-Cookie header (or undefined).
   */
  async function request(method, path, { body, rawBody, cookie, headers = {} } = {}) {
    const init = { method, headers: { ...headers } };
    if (body !== undefined) {
      init.body = JSON.stringify(body);
      init.headers['content-type'] = 'application/json';
    } else if (rawBody !== undefined) {
      init.body = rawBody;
      init.headers['content-type'] = 'application/json';
    }
    if (cookie) init.headers.cookie = cookie;

    const res = await fetch(baseUrl + path, init);
    const text = await res.text();
    return {
      status: res.status,
      headers: res.headers,
      body: text ? JSON.parse(text) : null,
      cookie: res.headers.getSetCookie().find((c) => c.startsWith('bugsquash_token=')),
    };
  }

  async function close() {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }

  return { app, db, config, baseUrl, request, close };
}

/** "bugsquash_token=abc; Max-Age=...; Path=/" -> "bugsquash_token=abc" (for a Cookie header). */
const cookiePair = (setCookie) => setCookie.split(';')[0];

/** Sign up a user and return the Cookie header value to act as them. */
async function signupAndGetCookie(request, username, password = 'correct-horse-battery') {
  const res = await request('POST', '/api/auth/signup', { body: { username, password } });
  if (res.status !== 201) throw new Error(`signup failed: ${res.status} ${JSON.stringify(res.body)}`);
  return cookiePair(res.cookie);
}

module.exports = { createFakeDb, testConfig, startTestServer, cookiePair, signupAndGetCookie, silentLogger };
